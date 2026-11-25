/**
 * Zoho CRM client for the sync worker. Mirrors llc-worker.js's
 * getZohoAccessToken/handleLead pattern deliberately — see DECISIONS.md
 * ("migration direction: Express becomes the single owner of all Zoho
 * CRM writes... structure the Zoho client so the Worker's handleLead/
 * handleContact logic can be lifted into Express later without a
 * rewrite"). This service has its own, separate Zoho OAuth client
 * credentials (DECISIONS.md) — not yet set in this environment as of
 * Gate 1; the real client below fails gracefully (a normal queued-job
 * failure, not a crash) until they are.
 */

export interface ZohoSyncResult {
  ok: boolean;
  leadId?: string;
  dealId?: string;
  /** Present when the failure was an HTTP response (e.g. 401) rather
   *  than a network-level error (timeout, DNS, etc.) — lets the worker
   *  tell "bad/expired token" apart from "Zoho unreachable." */
  httpStatus?: number;
  error?: string;
  /**
   * Set on a failure that will NEVER succeed on retry — e.g. Deal
   * ownership verification failed (updateDealStage below), or the Deal
   * id simply doesn't exist. Distinguishes "Zoho is down/rate-limited,
   * try again later" (the default, backoff-and-retry assumption every
   * other failure here makes) from "this job is permanently wrong, stop
   * retrying it" — sync/worker.ts's recordOutcome sends a `permanent`
   * failure straight to dead_letter instead of burning the normal
   * 1m/5m/15m/1h/6h/24h backoff schedule against something that can
   * never resolve itself.
   */
  permanent?: boolean;
}

export interface ZohoClient {
  syncSession(payloadSnapshot: Record<string, unknown>): Promise<ZohoSyncResult>;
  /**
   * Gate 2: order-scoped jobs (sync_type='order_deal' or 'abandoned_cart'
   * in crm_sync_queue). `kind` distinguishes the two — a paid order
   * creates exactly one Deal; an abandoned/failed checkout only ever
   * touches the Lead, never a Deal (frozen CRM sequencing rule).
   */
  syncOrderEvent(payload: OrderSyncPayload): Promise<ZohoSyncResult>;
  /**
   * sync_type='deal_stage_update' — the OTHER Deal lifecycle this
   * codebase now supports, alongside syncOrderEvent's "create the Deal
   * at payment time": the Cloudflare Worker (llc-worker.js) creates the
   * Deal at intake and hands its id back to the customer's session
   * (filing_sessions.crm_deal_id); once payment is confirmed,
   * routes/webhooksStripe.ts enqueues this job to update that EXISTING
   * Deal's stage rather than create a second one. Only reachable when a
   * crm_deal_id was already known at payment time — see that file's own
   * comment for what happens when it isn't (falls back to the existing
   * paid_deal creation path, unchanged).
   */
  updateDealStage(payload: DealStageUpdatePayload): Promise<ZohoSyncResult>;
}

export interface DealStageUpdatePayload {
  crm_deal_id: string;
  /** Omitted for a field-only update (T144 D12: the registered agent status), which leaves Stage alone. */
  target_stage?: string;
  /**
   * filing_sessions.email at the moment payment was confirmed
   * (routes/webhooksStripe.ts) — the ownership check updateDealStage
   * runs before ever touching the Deal: a client-supplied crm_deal_id
   * (see routes/session.ts's own comment on that trust boundary) is
   * otherwise just a string nothing has verified belongs to this
   * customer. Required, not optional — a job with no expected_email to
   * check against is a bug in the enqueueing code, not something this
   * client should paper over by skipping the check.
   */
  expected_email: string;
  /** Extra Deal fields written in the same update (e.g. Payment_Status,
   *  Proof_of_Filing_Date). */
  extra_fields?: Record<string, unknown>;
  /**
   * true only when crm_deal_id is a Deal this data spine created itself
   * (a synced order_deal job for the same order — checked by the webhook
   * before setting this). The ownership lookup exists to stop a
   * client-supplied Deal id from being edited; it is not needed, and would
   * wrongly fail, for our own Deals, which have no linked Contact.
   */
  server_created?: boolean;
}

export interface OrderSyncPayload {
  /** paid_deal: money collected at checkout. held_deal: card hold placed,
   *  money collected later on proof of filing. */
  kind: "paid_deal" | "held_deal" | "abandoned_cart";
  order: {
    order_id: string;
    filing_session_id: string;
    product: string;
    crm_intent: string;
    total_cents: number;
    /** The order's line-item snapshot from checkout (Offer Master prices). */
    line_items?: OrderLineItem[] | null;
    failure_reason?: string | null;
    stripe_payment_intent_id?: string | null;
  };
  filing_session: {
    email?: string | null;
    full_name?: string | null;
    phone?: string | null;
    entity_name_primary?: string | null;
    crm_lead_id?: string | null;
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
  };
}

/** One line of an order's checkout snapshot (routes/checkout.ts). */
export interface OrderLineItem {
  offer_code?: string;
  unit_amount_cents?: number;
  quantity?: number;
}

/** An order as far as its Deal fields are concerned. */
export interface OrderForDeal {
  product: string;
  total_cents: number | null | undefined;
  /** Checkout's line-item snapshot. Missing only in sync jobs queued
   *  before line items were added to the payload (24 Nov 2026). */
  line_items?: OrderLineItem[] | null;
}

/**
 * The order's checkout total in cents, or null when it cannot be trusted:
 * missing, not a positive whole number, or different from the sum of its
 * line items.
 */
function checkedTotalCents(order: OrderForDeal): number | null {
  const total = order.total_cents;
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return null;
  if (order.line_items === undefined || order.line_items === null) return total;
  if (!Array.isArray(order.line_items) || order.line_items.length === 0) return null;
  const sum = order.line_items.reduce(
    (acc, li) => acc + (Number.isInteger(li.unit_amount_cents) ? (li.unit_amount_cents as number) : NaN) * (li.quantity ?? 1),
    0
  );
  return sum === total ? total : null;
}

/**
 * Deal_Name, Amount and Package for a Deal, taken from the orders that
 * checkout created for it: total_cents and the line-item snapshot, both
 * resolved from the Offer Master (offers table) in routes/checkout.ts.
 * There is no price list here and no default price.
 *
 * Pass every paid or held order on the Deal, oldest first: a follow-up
 * order on the same filing (the EIN upsell) adds to the amount instead of
 * replacing it, and Package stays the first order's package.
 *
 * If any order's total cannot be trusted (see checkedTotalCents), no
 * amount is written and the Deal is flagged Manual_Review_Required. A
 * first order with no CRM Package value is flagged too.
 */
export function orderDealFields(
  entityName: string | null | undefined,
  orderOrOrders: OrderForDeal | OrderForDeal[]
): Record<string, unknown> {
  const orders = Array.isArray(orderOrOrders) ? orderOrOrders : [orderOrOrders];
  const name = (entityName ?? "").trim() || "Unnamed LLC";
  const dealName = (label: string) => `${name} — ${label}`.slice(0, 120);
  const labels = orders.map((o) => packageLabel(o.product));
  const pkg = labels[0];
  const totals = orders.map(checkedTotalCents);

  if (orders.length === 0 || totals.some((t) => t === null)) {
    return {
      Deal_Name: dealName("price not found, needs review"),
      Manual_Review_Required: true,
      ...(pkg ? { Package: pkg } : {}),
    };
  }
  const amount = (totals as number[]).reduce((a, b) => a + b, 0) / 100;
  const what = [...new Set(orders.map((o, i) => labels[i] ?? o.product))].join(" + ");
  return {
    Deal_Name: dealName(`${what} ($${amount.toFixed(2)})`),
    Amount: amount,
    ...(pkg ? { Package: pkg } : { Manual_Review_Required: true }),
  };
}

/** CRM Package picklist value for an Offer Master offer_code. */
export function packageLabel(offerCode: string): string | undefined {
  if (offerCode === "FASTTRACK") return "FastTrack";
  if (offerCode === "PREMIUM") return "Premium";
  if (offerCode.startsWith("DIY")) return "DIY";
  if (offerCode === "EIN_FILING_EXPRESS") return "EIN Express";
  if (offerCode === "EIN_FILING") return "EIN Filing";
  if (offerCode.startsWith("REGISTERED_AGENT")) return "Registered Agent 3-Year";
  if (offerCode.startsWith("CREDENTIALS_KIT") || offerCode.startsWith("CCK")) return "Credentials Kit";
  return undefined;
}

/** Test orders are recognised by the address they were placed with. */
export function isTestEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").toLowerCase();
  return e.includes("+test") || e.includes("test@") || e.includes("launch-test") || e.endsWith(".invalid");
}

/**
 * The Deal record written when an order's payment is secured. Stage values
 * are ones present in the live Deal Stage picklist (checked 30 Sep 2026):
 * a hold opens the Deal at "SERVICE REQUESTED"; money collected at
 * checkout opens it at "Closed Won". Both are overridable by env.
 */
export function buildDealRecord(payload: OrderSyncPayload): Record<string, unknown> {
  const email = payload.filing_session.email ?? "";
  const held = payload.kind === "held_deal";
  const stage = held
    ? process.env.ZOHO_DEAL_STAGE_ON_HOLD || "SERVICE REQUESTED"
    : process.env.ZOHO_DEAL_STAGE_ON_PAYMENT || "Closed Won";
  const record: Record<string, unknown> = {
    ...orderDealFields(payload.filing_session.entity_name_primary || email, payload.order),
    Stage: stage,
    Lead_Source: "LLC Filing Intake",
    filing_session_id: payload.order.filing_session_id,
    Payment_Status: held ? "Hold Placed" : "Payment Collected",
    Stripe_Payment_Intent: payload.order.stripe_payment_intent_id ?? undefined,
    UTM_Source: payload.filing_session.utm_source ?? undefined,
    UTM_Medium: payload.filing_session.utm_medium ?? undefined,
    UTM_Campaign: payload.filing_session.utm_campaign ?? undefined,
    Test_Record: isTestEmail(email),
  };
  for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
  return record;
}

/**
 * Access tokens are cached until a minute before Zoho says they expire. Zoho
 * limits how often a refresh token may mint access tokens (about 10 per 10
 * minutes), and every Zoho caller here (CRM sync, scorecard, EIN portal jobs)
 * shares this one refresh token, so minting per request would lock them all out.
 *  - Concurrent callers share one in-flight refresh.
 *  - The cache is keyed by the credentials, so changing them never reuses a token.
 *  - A 401 drops the cached token only if it is the token that failed, and forced
 *    refreshes are limited to one per FORCED_REFRESH_COOLDOWN_MS, so a burst of 401s
 *    (e.g. a missing OAuth scope on one endpoint) cannot burn the refresh allowance.
 *  - A failed refresh is remembered for TOKEN_FAILURE_COOLDOWN_MS, so callers do not
 *    hammer Zoho during a rate-limit lockout.
 */
const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_EARLY_EXPIRY_MS = 60_000;
/** Zoho access tokens last 3600 s; never cache longer (some replies give ms, not s). */
const TOKEN_MAX_LIFETIME_S = 3600;
/** Used when Zoho's reply carries no expires_in. */
const TOKEN_DEFAULT_LIFETIME_S = 3000;
const FORCED_REFRESH_COOLDOWN_MS = 2 * 60_000;
const TOKEN_FAILURE_COOLDOWN_MS = 60_000;

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;
let tokenInFlight: { key: string; promise: Promise<string> } | null = null;
let tokenFailure: { key: string; error: Error; until: number } | null = null;
let lastForcedRefreshAt = Number.NEGATIVE_INFINITY;

/**
 * Called after Zoho answers 401 with `token`: drops the cached token if it is still
 * that one, at most once per FORCED_REFRESH_COOLDOWN_MS.
 */
export function invalidateZohoAccessToken(token: string, now: number = Date.now()): void {
  if (!tokenCache || tokenCache.token !== token) return;
  if (now - lastForcedRefreshAt < FORCED_REFRESH_COOLDOWN_MS) return;
  lastForcedRefreshAt = now;
  tokenCache = null;
}

/** Test helper: forget every cached token, failure and cooldown. */
export function resetZohoTokenCache(): void {
  tokenCache = null;
  tokenInFlight = null;
  tokenFailure = null;
  lastForcedRefreshAt = Number.NEGATIVE_INFINITY;
}

export async function getZohoAccessToken(now: () => number = Date.now): Promise<string> {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Zoho credentials not configured (ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN)");
  }

  const key = `${clientId}\u0000${refreshToken}`;
  if (tokenCache && tokenCache.key === key && now() < tokenCache.expiresAt) return tokenCache.token;
  if (tokenInFlight && tokenInFlight.key === key) return tokenInFlight.promise;
  if (tokenFailure && tokenFailure.key === key && now() < tokenFailure.until) throw tokenFailure.error;

  const promise = (async () => {
    const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });

    const data = (await res.json()) as { access_token?: string; expires_in?: unknown };
    if (!data.access_token) {
      throw new Error("Zoho token refresh failed: " + JSON.stringify(data));
    }
    const lifetimeS = Math.min(
      typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : TOKEN_DEFAULT_LIFETIME_S,
      TOKEN_MAX_LIFETIME_S,
    );
    tokenCache = { key, token: data.access_token, expiresAt: now() + lifetimeS * 1000 - TOKEN_EARLY_EXPIRY_MS };
    tokenFailure = null;
    return data.access_token;
  })().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    tokenFailure = { key, error, until: now() + TOKEN_FAILURE_COOLDOWN_MS };
    throw error;
  });
  tokenInFlight = { key, promise };
  try {
    return await promise;
  } finally {
    if (tokenInFlight?.promise === promise) tokenInFlight = null;
  }
}

/**
 * Real implementation. sync_type is always "session_sync" today (see
 * routes/session.ts) — Lead upsert ONLY.
 *
 * GATE 2 P0 SECURITY FIX (2026-09-09, see DECISIONS.md): this used to
 * also create a Deal whenever payload_snapshot.payment_status was "paid"
 * or "completed" — but that field came straight from
 * filing_sessions.payment_status, which (until the companion fix in
 * routes/session.ts, same commit) was directly client-writable. A client
 * could set payment_status: "paid" on POST /api/session/stage and this
 * code would create a real Zoho Deal with no actual payment ever having
 * happened — exactly what the frozen CRM sequencing rule exists to
 * prevent ("Deal only after a verified Stripe webhook, never at
 * intake"). Deal creation is now EXCLUSIVELY syncOrderEvent's job below,
 * triggered only by the verified webhook's order_deal queue job.
 */
export const realZohoClient: ZohoClient = {
  async syncSession(snapshot): Promise<ZohoSyncResult> {
    let token: string;
    try {
      token = await getZohoAccessToken();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const email = snapshot.email as string | undefined;
    if (!email) {
      // Should not happen — routes/session.ts only enqueues once an
      // email exists — but fail safely rather than send Zoho a bad payload.
      return { ok: false, error: "no email in payload_snapshot" };
    }

    try {
      const leadRes = await fetch("https://www.zohoapis.com/crm/v2/Leads/upsert", {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              First_Name: (snapshot.full_name as string | undefined)?.split(" ")[0] || "",
              Last_Name:
                (snapshot.full_name as string | undefined)?.split(" ").slice(1).join(" ") ||
                email.split("@")[0],
              Email: email,
              Phone: snapshot.phone ?? undefined,
              Company: snapshot.entity_name_primary ?? undefined,
              // A real value in the live Lead Source picklist (checked 30 Sep 2026).
              Lead_Source: "LLC Filing Intake",
              filing_session_id: (snapshot.filing_session_id as string | undefined) ?? undefined,
              UTM_Source: (snapshot.utm_source as string | undefined) ?? undefined,
              UTM_Medium: (snapshot.utm_medium as string | undefined) ?? undefined,
              UTM_Campaign: (snapshot.utm_campaign as string | undefined) ?? undefined,
              Test_Record: isTestEmail(email),
            },
          ],
          duplicate_check_fields: ["Email"],
        }),
      });

      if (leadRes.status === 401) {
        invalidateZohoAccessToken(token);
        return { ok: false, httpStatus: 401, error: "Zoho returned 401" };
      }
      if (!leadRes.ok) {
        return { ok: false, httpStatus: leadRes.status, error: `Zoho Leads upsert failed: ${leadRes.status}` };
      }

      const leadData = (await leadRes.json()) as {
        data?: Array<{ details?: { id?: string }; code?: string }>;
      };
      const leadId = leadData.data?.[0]?.details?.id;
      return { ok: true, leadId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /**
   * Gate 2 order-scoped sync. "paid_deal" creates exactly one Deal
   * (idempotency is the webhook's stripe_webhook_events.id check plus
   * this job existing at all — see routes/webhooksStripe.ts — not a
   * second dedup here) linked to the existing Lead by email when one is
   * known. "abandoned_cart" never creates or touches a Deal — it only
   * updates the existing Lead so sales can see the drop-off, per the
   * frozen rule that a failed payment fires an abandoned-cart signal,
   * never a Deal.
   */
  async syncOrderEvent(payload: OrderSyncPayload): Promise<ZohoSyncResult> {
    let token: string;
    try {
      token = await getZohoAccessToken();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const email = payload.filing_session.email;
    if (!email) {
      return { ok: false, error: "no email on filing_session for order sync" };
    }

    try {
      if (payload.kind === "abandoned_cart") {
        const leadRes = await fetch("https://www.zohoapis.com/crm/v2/Leads/upsert", {
          method: "POST",
          headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            data: [
              {
                Email: email,
                Lead_Status: "Abandoned Checkout",
                Description: `Checkout abandoned/failed for order ${payload.order.order_id}: ${payload.order.failure_reason ?? "unknown reason"}`,
                filing_session_id: payload.order.filing_session_id,
              },
            ],
            duplicate_check_fields: ["Email"],
          }),
        });
        if (leadRes.status === 401) {
          invalidateZohoAccessToken(token);
          return { ok: false, httpStatus: 401, error: "Zoho returned 401" };
        }
        if (!leadRes.ok) return { ok: false, httpStatus: leadRes.status, error: `Zoho Lead upsert (abandoned cart) failed: ${leadRes.status}` };
        const leadData = (await leadRes.json()) as { data?: Array<{ details?: { id?: string } }> };
        return { ok: true, leadId: leadData.data?.[0]?.details?.id };
      }

      // kind === "paid_deal" | "held_deal"
      const dealRes = await fetch("https://www.zohoapis.com/crm/v2/Deals", {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [buildDealRecord(payload)] }),
      });
      if (dealRes.status === 401) {
        invalidateZohoAccessToken(token);
        return { ok: false, httpStatus: 401, error: "Zoho returned 401 on Deal creation" };
      }
      if (!dealRes.ok) return { ok: false, httpStatus: dealRes.status, error: `Zoho Deal create failed: ${dealRes.status}` };
      const dealData = (await dealRes.json()) as { data?: Array<{ details?: { id?: string } }> };
      const dealId = dealData.data?.[0]?.details?.id;
      return { ok: true, dealId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /**
   * Updates an EXISTING Deal by id (PUT, not POST) — the opposite
   * concern from syncOrderEvent's "never create a duplicate Deal": this
   * path only ever runs when orders.crm_deal_id is already known
   * (routes/webhooksStripe.ts only enqueues this job when it is), so
   * there is no Lead-upsert or Deal-create step here at all.
   *
   * Ownership verification (routes/session.ts's own comment on the
   * crm_deal_id trust boundary: it's client-suppliable, set-once, but
   * NEVER verified at capture time): before writing anything, this
   * fetches the Deal, follows its Contact_Name lookup to that Contact's
   * Email, and requires it to match payload.expected_email
   * (case-insensitive). A client that supplied someone else's real
   * crm_deal_id fails here — unless it also controls an email address
   * matching that Deal's actual linked Contact, which is the same bar as
   * actually owning the record. A mismatch, a missing Contact link, or a
   * Deal that doesn't exist at all are all `permanent` failures (see
   * ZohoSyncResult) — never retried, dead-lettered immediately with the
   * reason preserved in crm_sync_queue.last_error (a durable, queryable
   * record — GATE 2 acceptance: durable artifacts over transient logs).
   */
  async updateDealStage(payload: DealStageUpdatePayload): Promise<ZohoSyncResult> {
    let token: string;
    try {
      token = await getZohoAccessToken();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      if (payload.server_created) {
        return await putDealUpdate(token, payload);
      }
      const dealRes = await fetch(
        `https://www.zohoapis.com/crm/v2/Deals/${encodeURIComponent(payload.crm_deal_id)}?fields=Contact_Name,Deal_Name`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
      );
      if (dealRes.status === 401) {
        invalidateZohoAccessToken(token);
        return { ok: false, httpStatus: 401, error: `Zoho returned 401 on Deal ownership lookup: ${await zohoErrorDetail(dealRes)}` };
      }
      if (dealRes.status === 404) {
        return { ok: false, httpStatus: 404, permanent: true, error: `Deal ${payload.crm_deal_id} does not exist — ownership cannot be verified` };
      }
      if (!dealRes.ok) {
        const body = await dealRes.text().catch(() => "");
        return { ok: false, httpStatus: dealRes.status, error: `Zoho Deal ownership lookup failed (${dealRes.status}): ${body}` };
      }

      const dealData = (await dealRes.json()) as { data?: Array<{ Contact_Name?: { id?: string } | null }> };
      const contactId = dealData.data?.[0]?.Contact_Name?.id;
      if (!contactId) {
        return {
          ok: false,
          permanent: true,
          error: `Deal ${payload.crm_deal_id} has no linked Contact — cannot verify it belongs to this filing session`,
        };
      }

      const contactRes = await fetch(`https://www.zohoapis.com/crm/v2/Contacts/${encodeURIComponent(contactId)}?fields=Email`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      if (contactRes.status === 401) {
        invalidateZohoAccessToken(token);
        return { ok: false, httpStatus: 401, error: `Zoho returned 401 on Contact ownership lookup: ${await zohoErrorDetail(contactRes)}` };
      }
      if (!contactRes.ok) {
        const body = await contactRes.text().catch(() => "");
        return { ok: false, httpStatus: contactRes.status, error: `Zoho Contact ownership lookup failed (${contactRes.status}): ${body}` };
      }

      const contactData = (await contactRes.json()) as { data?: Array<{ Email?: string | null }> };
      const contactEmail = (contactData.data?.[0]?.Email ?? "").trim().toLowerCase();
      const expectedEmail = payload.expected_email.trim().toLowerCase();

      if (!contactEmail || contactEmail !== expectedEmail) {
        return {
          ok: false,
          permanent: true,
          error: `Deal ${payload.crm_deal_id} ownership verification failed: linked Contact email does not match this filing session's email`,
        };
      }

      return await putDealUpdate(token, payload);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * Zoho's own error code for a failed call, e.g. OAUTH_SCOPE_MISMATCH or
 * INVALID_TOKEN, so a 401 says why it happened. Zoho error bodies carry a
 * code and a message, never the token; capped at 300 characters.
 */
async function zohoErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (j && (j.code || j.message)) return `${String(j.code ?? "")} ${String(j.message ?? "")}`.trim().slice(0, 300);
  } catch { /* not JSON */ }
  return text.slice(0, 300) || "(no body)";
}

async function putDealUpdate(token: string, payload: DealStageUpdatePayload): Promise<ZohoSyncResult> {
  const updateRes = await fetch(`https://www.zohoapis.com/crm/v2/Deals/${encodeURIComponent(payload.crm_deal_id)}`, {
    method: "PUT",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [{ ...(payload.target_stage ? { Stage: payload.target_stage } : {}), ...(payload.extra_fields ?? {}) }],
    }),
  });

  if (updateRes.status === 401) {
    invalidateZohoAccessToken(token);
    return { ok: false, httpStatus: 401, error: `Zoho returned 401 on Deal stage update: ${await zohoErrorDetail(updateRes)}` };
  }
  if (!updateRes.ok) {
    const body = await updateRes.text().catch(() => "");
    return { ok: false, httpStatus: updateRes.status, error: `Zoho Deal stage update failed (${updateRes.status}): ${body}` };
  }
  return { ok: true, dealId: payload.crm_deal_id };
}
