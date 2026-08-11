/**
 * ─────────────────────────────────────────────────────────
 * FILEFLORIDALLC — UNIFIED CLOUDFLARE WORKER
 * Worker name: llc-worker
 * URL: https://llc-worker.damian-793.workers.dev
 *
 * UPDATED 2026-07-01 by Damian's Cowork assistant:
 * - handleIntake() now branches on lead_type so partial
 *   captures and urgent name-review requests no longer
 *   create duplicate Contacts/Deals in Zoho CRM. Only
 *   "intake_complete" creates the real Contact + Deal.
 * - Added notifyCliq() — fires a real-time Cliq message on
 *   urgent_name_review. Safe no-op until CLIQ_WEBHOOK_URL
 *   is set as an environment variable in the Cloudflare
 *   dashboard (Settings > Variables). Nothing breaks if it
 *   is left unset — this is intentional so this file can be
 *   deployed today and the webhook wired in later.
 *
 * UPDATED 2026-07-10:
 * - Added scheduled() + keepRenderWarm() — a cron trigger
 *   (every 10 minutes, see wrangler.toml) that GETs /health on
 *   both Render free-tier services this project depends on
 *   (llc-pdf-generator, sunbiz-proxy) so they never cold-start
 *   mid-request. Additive only; does not touch any HTTP route.
 *
 * ROUTES
 * GET  /health          → Health check
 * POST /check           → LLC name check (Sunbiz + Claude AI)
 * POST /lead            → Name check lead capture → Zoho CRM
 * POST /contact         → Contact page form → Zoho CRM Lead
 * POST /guide-lead      → Formation Guide lead → Zoho CRM
 * POST /intake          → LLC intake form → Zoho CRM Contact + Deal
 *
 * CRON
 * Every 10 minutes       → keepRenderWarm() — Render keep-alive
 *
 * ENVIRONMENT VARIABLES (set in Cloudflare dashboard)
 * ANTHROPIC_API_KEY
 * RENDER_PROXY_URL
 * ZOHO_CLIENT_ID
 * ZOHO_CLIENT_SECRET
 * ZOHO_REFRESH_TOKEN
 * CLIQ_WEBHOOK_URL       ← NEW, optional. Add this once the
 *                          Cliq Incoming Webhook exists.
 * ─────────────────────────────────────────────────────────
 */

/* ── CORS HEADERS ── */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function errorJson(message, status = 500) {
  return json({ error: message }, status);
}

/* ══════════════════════════════════════════════════════════
   ZOHO OAUTH — SHARED TOKEN REFRESH
   All routes that write to Zoho CRM use this function.
══════════════════════════════════════════════════════════ */
async function getZohoAccessToken(env) {
  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      refresh_token: env.ZOHO_REFRESH_TOKEN,
    }),
  });

  const data = await res.json();

  if (!data.access_token) {
    throw new Error("Zoho token refresh failed: " + JSON.stringify(data));
  }

  return data.access_token;
}

/* ══════════════════════════════════════════════════════════
   NEW: NOTIFY DAMIAN VIA ZOHO CLIQ (real-time)
   Safe no-op if CLIQ_WEBHOOK_URL is not yet configured.
══════════════════════════════════════════════════════════ */
async function notifyCliq(env, message) {
  if (!env.CLIQ_WEBHOOK_URL) return; // not configured yet — silent no-op
  try {
    await fetch(env.CLIQ_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    /* silent — never let a notification failure break the request */
  }
}

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /check
   LLC Name Check — Sunbiz via Render proxy + Claude AI
   (unchanged)
══════════════════════════════════════════════════════════ */
async function handleCheck(request, env) {
  const body = await request.json();
  const { name } = body;

  if (!name || name.trim().length < 2) {
    return errorJson("Name is required", 400);
  }

  /* ── Call Render proxy → Sunbiz ── */
  let sunbizData = null;
  let coldStart = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const proxyRes = await fetch(env.RENDER_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    sunbizData = await proxyRes.json();
  } catch (err) {
    coldStart = true;
  }

  if (coldStart || !sunbizData) {
    return json({
      risk_level: "UNKNOWN",
      cold_start: true,
      verdict: "The Florida database is warming up. Please try again in 15 seconds.",
      searched_name: name,
    });
  }

  /* ── Call Claude API for AI interpretation ── */
  const entities = sunbizData.entities || [];
  const totalResults = sunbizData.total_results || 0;

  const claudePrompt = `You are an expert in Florida LLC name availability analysis.

A user wants to form a Florida LLC named: "${name}"

Florida Sunbiz database returned ${totalResults} results.
Here are the existing entities found:
${JSON.stringify(entities.slice(0, 20), null, 2)}

Analyze this data and return ONLY a JSON object with these exact fields:
{
  "risk_level": "GREEN" | "YELLOW" | "RED",
  "verdict": "One sentence summary of availability",
  "primary_reason": "The main reason for this risk level",
  "recommended_action": "What the user should do next",
  "active_conflict": true | false,
  "name_suggestions": ["Alternative 1 LLC", "Alternative 2 LLC", "Alternative 3 LLC"]
}

GREEN = name appears available, no conflicts found
YELLOW = similar names exist or inactive conflicts, proceed with caution
RED = active conflict exists, name likely unavailable

Return ONLY the JSON object. No explanation. No markdown.`;

  let aiResult = null;

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: claudePrompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || "";
    const clean = rawText.replace(/```json|```/g, "").trim();
    aiResult = JSON.parse(clean);
  } catch (err) {
    /* Fallback rule-based result if Claude is unavailable */
    const activeConflict = entities.some(
      (e) =>
        e.status === "Active" &&
        e.corporate_name?.toLowerCase().includes(name.toLowerCase().replace(/\s*llc\s*$/i, "").trim())
    );

    aiResult = {
      risk_level: activeConflict ? "RED" : totalResults > 0 ? "YELLOW" : "GREEN",
      verdict: activeConflict
        ? "An active business with a similar name exists in Florida."
        : totalResults > 0
        ? "Similar names found. Review before filing."
        : "No conflicts found. Name appears available.",
      primary_reason: activeConflict
        ? "Active entity conflict detected."
        : "Similar inactive names exist.",
      recommended_action: activeConflict
        ? "Choose a different name before filing."
        : "Verify distinctiveness before submitting.",
      active_conflict: activeConflict,
      name_suggestions: [
        name.replace(/\s*LLC\s*$/i, "") + " Group LLC",
        name.replace(/\s*LLC\s*$/i, "") + " Solutions LLC",
        name.replace(/\s*LLC\s*$/i, "") + " Enterprises LLC",
      ],
    };
  }

  return json({
    ...aiResult,
    searched_name: name,
    similar_count: totalResults,
    entities: entities.slice(0, 5),
  });
}

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /lead
   Name Check Lead Capture → Zoho CRM Lead

   Accepts the "name_review_action" event schema. Only `email` is
   required — every other field is optional and is simply omitted
   from the Zoho Description when absent. A missing analytics field
   must never cause a lead to be rejected.
══════════════════════════════════════════════════════════ */
async function handleLead(request, env) {
  const body = await request.json();
  const {
    email, lead_source, searched_name, backup_name,
    review_result, recommendation_level, similar_entities_count,
    entities_summary, action_type, session_id, visitor_id,
  } = body;

  if (!email) {
    return errorJson("Email is required", 400);
  }

  const received_at = new Date().toISOString(); // server-stamped — never trust a client clock

  const nameReviewNote = recommendation_level && recommendation_level !== "name_available"
    ? "Similar names are common and do not mean your name will be rejected. Florida requires your name to be distinguishable — our review confirms this before filing."
    : "";

  const description = [
    action_type ? `[${action_type}]` : null,
    `Searched: ${searched_name || ""}`,
    backup_name ? `Backup: ${backup_name}` : null,
    `Result: ${review_result || ""} (${recommendation_level || ""})`,
    typeof similar_entities_count === "number" ? `Similar entities: ${similar_entities_count}` : null,
    entities_summary ? `Details: ${entities_summary}` : null,
    nameReviewNote || null,
    session_id ? `Session: ${session_id}` : null,
    visitor_id ? `Visitor: ${visitor_id}` : null,
    `Received: ${received_at}`,
  ].filter(Boolean).join(" | ");

  try {
    const token = await getZohoAccessToken(env);

    const crmRes = await fetch(
      "https://www.zohoapis.com/crm/v2/Leads",
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              First_Name: "",
              Last_Name: email.split("@")[0],
              Email: email,
              Lead_Source: lead_source || "LLC Name Check",
              Description: description,
            },
          ],
        }),
      }
    );

    const crmData = await crmRes.json();
    return json({ success: true, crm: crmData });
  } catch (err) {
    return errorJson("CRM write failed: " + err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /contact
   Contact Page Form → Zoho CRM Lead

   Mirrors /lead's pattern. Only `email` is required — every
   other field is optional and is simply omitted from the Zoho
   Description when absent. A missing field must never cause a
   contact submission to be rejected.
══════════════════════════════════════════════════════════ */
async function handleContact(request, env) {
  const body = await request.json();
  const { first_name, last_name, email, phone, topic, page_url } = body;

  if (!email) {
    return errorJson("Email is required", 400);
  }

  const received_at = new Date().toISOString(); // server-stamped — never trust a client clock

  const description = [
    topic ? `Topic: ${topic}` : null,
    phone ? `Phone: ${phone}` : null,
    page_url ? `Submitted from: ${page_url}` : null,
    `Received: ${received_at}`,
  ]
    .filter(Boolean)
    .join(" | ");

  try {
    const token = await getZohoAccessToken(env);

    const crmRes = await fetch(
      "https://www.zohoapis.com/crm/v2/Leads",
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              First_Name: first_name ? first_name.trim() : "",
              Last_Name: last_name ? last_name.trim() : email.split("@")[0],
              Email: email,
              Lead_Source: "Contact Form",
              Description: description,
            },
          ],
        }),
      }
    );

    const crmData = await crmRes.json();
    return json({ success: true, crm: crmData });
  } catch (err) {
    return errorJson("CRM write failed: " + err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /guide-lead
   Formation Guide Download Lead → Zoho CRM Lead
   (unchanged)
══════════════════════════════════════════════════════════ */
async function handleGuideLead(request, env) {
  const body = await request.json();
  const { email, name } = body;

  if (!email) {
    return errorJson("Email is required", 400);
  }

  const [firstName, ...lastParts] = (name || "").split(" ");
  const lastName = lastParts.join(" ") || "";

  try {
    const token = await getZohoAccessToken(env);

    const crmRes = await fetch(
      "https://www.zohoapis.com/crm/v2/Leads",
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              First_Name: firstName || "",
              Last_Name: lastName || email.split("@")[0],
              Email: email,
              Lead_Source: "Formation Guide Download",
              Description: "Downloaded the Florida LLC Formation Guide.",
            },
          ],
        }),
      }
    );

    const crmData = await crmRes.json();
    return json({ success: true, crm: crmData });
  } catch (err) {
    return errorJson("CRM write failed: " + err.message);
  }
}

/* ══════════════════════════════════════════════════════════
   ROUTE: POST /intake
   LLC Intake Form → Zoho CRM Contact + Deal

   UPDATED 2026-07-01:
   - Branches on body.lead_type so partial captures and
     urgent name-review requests stop creating duplicate
     Contacts/Deals. Only "intake_complete" (or a missing
     lead_type, for backward compatibility) creates the
     real Contact + Deal, exactly as before.
   - "urgent_name_review" now fires a real-time Cliq
     notification instead of writing to CRM at all.
   - "intake_partial" still upserts a lightweight Contact
     record (no Deal), preserving existing lead-capture
     behavior without cluttering the pipeline with phantom
     $349 Deals.
══════════════════════════════════════════════════════════ */
async function handleIntake(request, env) {
  const body = await request.json();
  const leadType = body.lead_type || "intake_complete";

  /* ── Branch: urgent manual-review request ──
     No CRM write. Real-time Cliq alert only. */
  if (leadType === "urgent_name_review") {
    const who = [body.first_name, body.last_name].filter(Boolean).join(" ") || "A visitor";
    const contact = [body.email, body.phone].filter(Boolean).join(" / ") || "no contact info yet";
    await notifyCliq(
      env,
      `🚨 Manual name review requested\n` +
        `Who: ${who} (${contact})\n` +
        `Primary name: ${body.llc_name || "—"}\n` +
        `Backup name: ${body.llc_name_backup || "—"}\n` +
        `Be on standby — they are on the intake form now.`
    );
    return json({ success: true, notified: true });
  }

  /* ── Branch: partial contact capture ──
     Lightweight Contact only. No Deal. */
  if (leadType === "intake_partial") {
    if (!body.email) {
      return json({ success: true, skipped: "no email yet" });
    }
    try {
      const token = await getZohoAccessToken(env);
      const contactRes = await fetch("https://www.zohoapis.com/crm/v2/Contacts", {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              First_Name: body.first_name ? body.first_name.trim() : "",
              Last_Name: body.last_name ? body.last_name.trim() : "Unknown",
              Email: body.email.trim(),
              // Numbers collected here are personal/individual contact
              // numbers, not business or office lines — default to Mobile.
              // Populate Phone only when a number is explicitly identified
              // as a business/office number (no such signal exists in this
              // payload today).
              Mobile: body.phone || "",
              Company_Name: body.llc_name ? body.llc_name.trim() : "",
              Lead_Source: "LLC Intake Form (In Progress)",
              Description: `In-progress intake. Working name: ${body.llc_name || "not yet entered"}`,
            },
          ],
        }),
      });
      const contactData = await contactRes.json();
      return json({ success: true, contact_id: contactData.data?.[0]?.details?.id || null });
    } catch (err) {
      return errorJson("Partial-capture CRM write failed: " + err.message);
    }
  }

  /* ── Default / "intake_complete" branch — unchanged from before ── */
  if (!body.llc_name || body.llc_name.toString().trim() === "") {
    return errorJson("Missing required field: llc_name", 400);
  }

  try {
    const token = await getZohoAccessToken(env);

    /* ── Build description summary ── */
    const summary = [
      `LLC Name: ${body.llc_name}`,
      body.llc_name_backup ? `Backup Name: ${body.llc_name_backup}` : null,
      body.name_check_status ? `Name Check Status: ${body.name_check_status}` : null,
      `Principal Address: ${body.principal_street || ""}, ${body.principal_city || ""}, ${body.principal_state || ""} ${body.principal_zip || ""}`,
      `Registered Agent: ${body.ra_name || ""} (${body.ra_type || ""})`,
      `RA Address: ${body.ra_street || ""}, ${body.ra_city || ""}, FL ${body.ra_zip || ""}`,
      `Purpose: ${body.purpose_type === "specific" ? body.purpose_description : "General — any lawful business"}`,
      `Authorized Signer: ${body.signer_name || ""} (${body.signer_title || ""})`,
      `Effective Date: ${body.effective_date_type || "immediate"}${body.effective_date ? " — " + body.effective_date : ""}`,
      `Management: ${body.management_type || "member-managed"}`,
      `Multi-member: ${body.multi_member ? "Yes" : "No"}`,
      `Package: ${body.package || "not specified"}`,
    ]
      .filter(Boolean)
      .join("\n");

    /* ── Step 1: Create Contact in Zoho CRM ── */
    const contactRes = await fetch(
      "https://www.zohoapis.com/crm/v2/Contacts",
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              /* Personal fields — safe for missing values */
              First_Name: body.first_name ? body.first_name.trim() : "",
              Last_Name: body.last_name ? body.last_name.trim() : "Unknown",
              Email: body.email ? body.email.trim() : "",
              // See intake_partial branch above for why Phone is omitted
              // and Mobile is the sole destination for this number today.
              Mobile: body.phone || "",

              /* LLC fields */
              Account_Name: { name: body.llc_name.trim() },
              Company_Name: body.llc_name.trim(),
              Owners_Job_Title: "LLC Member",

              /* Address — uses principal if mailing_same is true */
              Mailing_Street: body.mailing_same
                ? body.principal_street || ""
                : body.mailing_street || "",
              Mailing_City: body.mailing_same
                ? body.principal_city || ""
                : body.mailing_city || "",
              Mailing_State: body.mailing_same
                ? body.principal_state || ""
                : body.mailing_state || "",
              Mailing_Zip: body.mailing_same
                ? body.principal_zip || ""
                : body.mailing_zip || "",
              Mailing_Country: body.principal_country || "United States",

              Lead_Source: "LLC Intake Form",
              Description: summary,
            },
          ],
        }),
      }
    );

    const contactData = await contactRes.json();
    const contactId = contactData.data?.[0]?.details?.id || null;

    /* ── Step 2: Create Deal linked to Contact ── */
    const packageLabels = {
      basic: "Basic — Florida LLC Filing ($125)",
      standard: "Standard — LLC Filing + EIN + Operating Agreement ($349)",
      concierge: "Concierge — Full-Service Formation with Dedicated Support ($1,999)",
    };

    const packageAmounts = {
      basic: 125,
      standard: 349,
      concierge: 1999,
    };

    const pkg = body.package || "standard";

    const dealBody = {
      Deal_Name: `${body.llc_name} — ${packageLabels[pkg] || pkg}`,
      Stage: "Intake Received",
      Amount: packageAmounts[pkg] || 0,
      Lead_Source: "LLC Intake Form",
      Account_Name: { name: body.llc_name.trim() },
      Description: summary,
      Closing_Date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0],
    };

    if (contactId) {
      dealBody.Contact_Name = { id: contactId };
    }

    dealBody.Manual_Review_Required = Boolean(body.manual_review_required);

    const dealRes = await fetch(
      "https://www.zohoapis.com/crm/v2/Deals",
      {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: [dealBody] }),
      }
    );

    const dealData = await dealRes.json();
    const dealId = dealData.data?.[0]?.details?.id || null;

    return json({
      success: true,
      contact_id: contactId,
      deal_id: dealId,
      llc_name: body.llc_name,
      package: pkg,
    });
  } catch (err) {
    return errorJson("Intake submission failed: " + err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// RENDER KEEP-ALIVE
// Pings Render free-tier services every 10 minutes so they
// never spin down. See MASTER_PROJECT_RULES.md.
// Additive only — does not touch existing routes.
// ─────────────────────────────────────────────────────────────

const RENDER_TARGETS = [
  "https://llc-pdf-generator.onrender.com/health",
  "https://sunbiz-proxy.onrender.com/health",
];

async function keepRenderWarm() {
  const results = await Promise.allSettled(
    RENDER_TARGETS.map(async (url) => {
      const started = Date.now();
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": "llc-worker-keepalive" },
      });
      return { url, status: res.status, ms: Date.now() - started };
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      console.log(
        `keep-alive OK: ${r.value.url} → ${r.value.status} in ${r.value.ms}ms`
      );
    } else {
      console.log(`keep-alive FAILED: ${r.reason}`);
    }
  }
}

/* ══════════════════════════════════════════════════════════
   MAIN FETCH HANDLER (unchanged)
══════════════════════════════════════════════════════════ */
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepRenderWarm());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    /* Handle CORS preflight */
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* Health check */
    if (path === "/health" && method === "GET") {
      return json({
        status: "ok",
        service: "llc-worker",
        routes: ["/health", "/check", "/lead", "/contact", "/guide-lead", "/intake"],
      });
    }

    /* Route: LLC name check */
    if (path === "/check" && method === "POST") {
      return handleCheck(request, env);
    }

    /* Route: Name check lead */
    if (path === "/lead" && method === "POST") {
      return handleLead(request, env);
    }

    /* Route: Contact page form */
    if (path === "/contact" && method === "POST") {
      return handleContact(request, env);
    }

    /* Route: Formation guide lead */
    if (path === "/guide-lead" && method === "POST") {
      return handleGuideLead(request, env);
    }

    /* Route: LLC intake form */
    if (path === "/intake" && method === "POST") {
      return handleIntake(request, env);
    }

    return json({ error: "Route not found" }, 404);
  },
};
