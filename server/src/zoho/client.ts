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
}

export interface ZohoClient {
  syncSession(payloadSnapshot: Record<string, unknown>): Promise<ZohoSyncResult>;
}

async function getZohoAccessToken(): Promise<string> {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Zoho credentials not configured (ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN)");
  }

  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Zoho token refresh failed: " + JSON.stringify(data));
  }
  return data.access_token;
}

/**
 * Real implementation. sync_type is always "session_sync" today (see
 * routes/session.ts) — this decides Lead vs. Deal from the snapshot
 * itself rather than requiring the caller to pick a sync_type.
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

    const isPaid = snapshot.payment_status === "paid" || snapshot.payment_status === "completed";

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
              Lead_Source: "Data Spine — session_sync",
              filing_session_id: (snapshot.filing_session_id as string | undefined) ?? undefined,
            },
          ],
          duplicate_check_fields: ["Email"],
        }),
      });

      if (leadRes.status === 401) {
        return { ok: false, httpStatus: 401, error: "Zoho returned 401" };
      }
      if (!leadRes.ok) {
        return { ok: false, httpStatus: leadRes.status, error: `Zoho Leads upsert failed: ${leadRes.status}` };
      }

      const leadData = (await leadRes.json()) as {
        data?: Array<{ details?: { id?: string }; code?: string }>;
      };
      const leadId = leadData.data?.[0]?.details?.id;

      if (!isPaid || !leadId) {
        return { ok: true, leadId };
      }

      // Paid — convert to a Deal. (Gate 1: create a Deal linked to the
      // lead's info; a real "convert" API call is a later refinement.)
      const dealRes = await fetch("https://www.zohoapis.com/crm/v2/Deals", {
        method: "POST",
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [
            {
              Deal_Name: `${snapshot.entity_name_primary || email} — LLC Filing`,
              Stage: "Payment Received",
              Amount: typeof snapshot.order_total_cents === "number" ? snapshot.order_total_cents / 100 : 0,
              Lead_Source: "Data Spine — session_sync",
            },
          ],
        }),
      });

      if (dealRes.status === 401) {
        return { ok: false, httpStatus: 401, error: "Zoho returned 401 on Deal creation", leadId };
      }
      if (!dealRes.ok) {
        return { ok: false, httpStatus: dealRes.status, error: `Zoho Deal create failed: ${dealRes.status}`, leadId };
      }

      const dealData = (await dealRes.json()) as {
        data?: Array<{ details?: { id?: string } }>;
      };
      const dealId = dealData.data?.[0]?.details?.id;

      return { ok: true, leadId, dealId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
