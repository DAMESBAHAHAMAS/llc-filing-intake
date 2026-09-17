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
  target_stage: string;
}

export interface OrderSyncPayload {
  kind: "paid_deal" | "abandoned_cart";
  order: {
    order_id: string;
    filing_session_id: string;
    product: string;
    crm_intent: string;
    total_cents: number;
    failure_reason?: string | null;
  };
  filing_session: {
    email?: string | null;
    full_name?: string | null;
    phone?: string | null;
    entity_name_primary?: string | null;
    crm_lead_id?: string | null;
  };
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
        if (leadRes.status === 401) return { ok: false, httpStatus: 401, error: "Zoho returned 401" };
        if (!leadRes.ok) return { ok: false, httpStatus: leadRes.status, error: `Zoho Lead upsert (abandoned cart) failed: ${leadRes.status}` };
        const leadData = (await leadRes.json()) as { data?: Array<{ details?: { id?: string } }> };
        return { ok: true, leadId: leadData.data?.[0]?.details?.id };
      }

      // kind === "paid_deal"
      const dealRes = await fetch("https://www.zohoapis.com/crm/v2/Deals", {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [
            {
              Deal_Name: `${payload.filing_session.entity_name_primary || email} — ${payload.order.product}`,
              Stage: "Payment Received",
              Amount: payload.order.total_cents / 100,
              Lead_Source: "Data Spine — order_deal",
              filing_session_id: payload.order.filing_session_id,
            },
          ],
        }),
      });
      if (dealRes.status === 401) return { ok: false, httpStatus: 401, error: "Zoho returned 401 on Deal creation" };
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
   */
  async updateDealStage(payload: DealStageUpdatePayload): Promise<ZohoSyncResult> {
    let token: string;
    try {
      token = await getZohoAccessToken();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const res = await fetch(`https://www.zohoapis.com/crm/v2/Deals/${encodeURIComponent(payload.crm_deal_id)}`, {
        method: "PUT",
        headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: [{ Stage: payload.target_stage }] }),
      });

      if (res.status === 401) {
        return { ok: false, httpStatus: 401, error: "Zoho returned 401 on Deal stage update" };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, httpStatus: res.status, error: `Zoho Deal stage update failed (${res.status}): ${body}` };
      }
      return { ok: true, dealId: payload.crm_deal_id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
