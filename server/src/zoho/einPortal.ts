import { getZohoAccessToken } from "./client.js";

/**
 * ST17: the Zoho CRM calls for EIN onboarding through the Zoho CRM Portal.
 *
 * This server never handles the passport: the customer uploads it in the portal,
 * straight into the Image Upload field Passport_Photo_Page on their Deal (Zoho
 * documents Image Upload, not File Upload or Attachments, as usable by portal
 * users). Here we only invite the customer's Contact to the portal, read the Deal
 * fields the sweep needs, tick "EIN Docs Received" (with a timestamp), and clear
 * the passport image when the retention period ends.
 *
 * Untested against live Zoho (no portal exists yet): the invite endpoint and the
 * image delete shape ({ id, _delete: null } via v8 Update Records) follow Zoho's
 * docs; every call here uses API v8. clearImageField re-reads the Deal afterwards,
 * so a delete Zoho ignored is reported as a failure, never as done. The invite
 * needs OAuth scope ZohoCRM.settings.clientportal.CREATE.
 */

export type ZohoCallResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { value: T }))
  | { ok: false; error: string; permanent?: boolean };

export interface DealSnapshot {
  stage: string | null;
  paymentStatus: string | null;
  docsReceived: boolean;
  /** Entries of the passport Image Upload field; empty when no image. */
  passportFiles: Array<Record<string, unknown>>;
  /** yyyy-mm-dd, or null. */
  einIssuedDate: string | null;
}

export interface EinPortalClient {
  /**
   * Invites the Deal's Contact to the portal, after checking that Contact's email
   * is the customer's. A Deal with no Contact, or a different email, is permanent
   * (a person must fix the Deal); it is never invited.
   */
  inviteDealContact(dealId: string, expectedEmail: string, userTypeId: string): Promise<ZohoCallResult<{ contactId: string }>>;
  readDeal(dealId: string, fields: { docsReceived: string; passport: string; einIssuedDate: string }): Promise<ZohoCallResult<DealSnapshot>>;
  markDocsReceived(dealId: string, fields: { docsReceived: string; docsReceivedAt: string }, at: Date): Promise<ZohoCallResult>;
  /** Deletes every image in the passport Image Upload field, then re-reads it to confirm it is empty. */
  clearImageField(dealId: string, field: string, images: Array<Record<string, unknown>>): Promise<ZohoCallResult>;
}

const V8 = "https://www.zohoapis.com/crm/v8";

async function detail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { code?: unknown; message?: unknown; data?: Array<{ code?: unknown; message?: unknown }> };
    const rec = j.data?.[0] ?? j;
    if (rec && (rec.code || rec.message)) return `${res.status} ${String(rec.code ?? "")} ${String(rec.message ?? "")}`.trim().slice(0, 300);
  } catch { /* not JSON */ }
  return `${res.status} ${text.slice(0, 200)}`;
}

/** Zoho answers 200/201 with a per-record status; a record-level error must not pass as success. */
function recordOk(json: unknown): { ok: true } | { ok: false; error: string } {
  const rec = (json as { data?: Array<{ status?: unknown; code?: unknown; message?: unknown }> })?.data?.[0];
  if (!rec || rec.status !== "success") {
    return { ok: false, error: `${String(rec?.code ?? "no record status")} ${String(rec?.message ?? "")}`.trim().slice(0, 300) };
  }
  return { ok: true };
}

/** Every Zoho call gives up after 20 seconds, well inside the invite job's one-hour claim. */
const TIMEOUT_MS = 20_000;
function timeout(): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(TIMEOUT_MS) };
}

async function auth(): Promise<Record<string, string>> {
  return { Authorization: `Zoho-oauthtoken ${await getZohoAccessToken()}` };
}

/**
 * Reads portal_invite's answer. Zoho's v8 sample is a top-level
 * { status: "success", code: "SUCCESS", details: { record_id } }; a data[0] wrapper
 * is accepted too, and so is a 2xx with no record status at all. A Contact who is already a portal user is treated as invited, so
 * repeat customers are not retried and blocked. Returns "invited", or the error text.
 */
export function inviteOutcome(httpStatus: number, body: string): "invited" | string {
  let rec: { status?: unknown; code?: unknown; message?: unknown } = {};
  try {
    const j = JSON.parse(body) as { status?: unknown; code?: unknown; message?: unknown; data?: Array<typeof rec> };
    rec = Array.isArray(j.data) && j.data[0] ? j.data[0] : j;
  } catch { /* not JSON */ }
  const text = `${String(rec.code ?? "")} ${String(rec.message ?? "")}`.trim() || body.slice(0, 200);
  if (/already\s+(?:a\s+portal\s+user|invited|exists?|a\s+member)|ALREADY_/i.test(text)) return "invited";
  // A 2xx without a record-level error counts as sent: retrying an unfamiliar success
  // shape would email the customer again and again.
  if (httpStatus >= 200 && httpStatus < 300 && (rec.status === "success" || rec.status === undefined)) return "invited";
  return text || "no response body";
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

async function getDeal(dealId: string, fields: string[]): Promise<{ ok: true; deal: Record<string, unknown> } | { ok: false; error: string; permanent?: boolean }> {
  const res = await fetch(`${V8}/Deals/${encodeURIComponent(dealId)}?fields=${fields.map(encodeURIComponent).join(",")}`, {
    headers: await auth(),
    ...timeout(),
  });
  if (res.status === 204 || res.status === 404) return { ok: false, permanent: true, error: `Deal ${dealId} not found` };
  if (!res.ok) return { ok: false, error: `Zoho Deal read failed: ${await detail(res)}` };
  const deal = ((await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> }).data?.[0];
  return deal ? { ok: true, deal } : { ok: false, permanent: true, error: `Deal ${dealId} not found` };
}

function fileEntries(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : [];
}

export const realEinPortalClient: EinPortalClient = {
  async inviteDealContact(dealId, expectedEmail, userTypeId) {
    try {
      const deal = await getDeal(dealId, ["Contact_Name"]);
      if (!deal.ok) return deal;
      const contactId = (deal.deal.Contact_Name as { id?: unknown } | null | undefined)?.id;
      if (typeof contactId !== "string" || !contactId) {
        return { ok: false, permanent: true, error: `Deal ${dealId} has no linked Contact to invite` };
      }
      const contactRes = await fetch(`${V8}/Contacts/${encodeURIComponent(contactId)}?fields=Email`, { headers: await auth(), ...timeout() });
      if (!contactRes.ok) return { ok: false, error: `Zoho Contact read failed: ${await detail(contactRes)}` };
      const email = (((await contactRes.json().catch(() => ({}))) as { data?: Array<{ Email?: unknown }> }).data?.[0]?.Email ?? "");
      if (typeof email !== "string" || !email.trim() || email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()) {
        return { ok: false, permanent: true, error: `Deal ${dealId}: the linked Contact's email is not the customer's email` };
      }
      const qs = new URLSearchParams({ user_type_id: userTypeId, type: "invite", language: "en_US" });
      const res = await fetch(`${V8}/Contacts/${encodeURIComponent(contactId)}/actions/portal_invite?${qs}`, {
        method: "POST",
        headers: await auth(),
        ...timeout(),
      });
      const text = await res.text().catch(() => "");
      const outcome = inviteOutcome(res.status, text);
      if (outcome === "invited") return { ok: true, value: { contactId } };
      return { ok: false, error: `Zoho portal invite failed: ${res.status} ${outcome.slice(0, 300)}` };
    } catch (err) {
      return fail(err);
    }
  },

  async readDeal(dealId, fields) {
    try {
      const wanted = ["Stage", "Payment_Status", fields.docsReceived, fields.passport, fields.einIssuedDate].filter(Boolean);
      const deal = await getDeal(dealId, wanted);
      if (!deal.ok) return deal;
      const d = deal.deal;
      const issued = fields.einIssuedDate ? d[fields.einIssuedDate] : null;
      return {
        ok: true,
        value: {
          stage: typeof d.Stage === "string" ? d.Stage : null,
          paymentStatus: typeof d.Payment_Status === "string" ? d.Payment_Status : null,
          docsReceived: fields.docsReceived ? d[fields.docsReceived] === true : false,
          passportFiles: fileEntries(d[fields.passport]),
          einIssuedDate: typeof issued === "string" && /^\d{4}-\d{2}-\d{2}/.test(issued) ? issued.slice(0, 10) : null,
        },
      };
    } catch (err) {
      return fail(err);
    }
  },

  async markDocsReceived(dealId, fields, at) {
    try {
      const record: Record<string, unknown> = { [fields.docsReceived]: true };
      // Zoho DateTime format: ISO 8601 with offset, no milliseconds.
      if (fields.docsReceivedAt) record[fields.docsReceivedAt] = at.toISOString().replace(/\.\d{3}Z$/, "+00:00");
      const res = await fetch(`${V8}/Deals/${encodeURIComponent(dealId)}`, {
        method: "PUT",
        headers: { ...(await auth()), "Content-Type": "application/json" },
        ...timeout(),
        body: JSON.stringify({ data: [record] }),
      });
      if (!res.ok) return { ok: false, error: `Zoho Deal update failed: ${await detail(res)}` };
      const result = recordOk(await res.json().catch(() => ({})));
      return result.ok ? { ok: true } : { ok: false, error: `Zoho Deal update failed: ${result.error}` };
    } catch (err) {
      return fail(err);
    }
  },

  async clearImageField(dealId, field, images) {
    try {
      const deletes = images
        .map((img) => img.id)
        .filter((id): id is string => typeof id === "string" && id !== "")
        .map((id) => ({ id, _delete: null }));
      if (deletes.length !== images.length) return { ok: false, error: `Deal ${dealId}: passport image entries without ids` };
      const res = await fetch(`${V8}/Deals/${encodeURIComponent(dealId)}`, {
        method: "PUT",
        headers: { ...(await auth()), "Content-Type": "application/json" },
        ...timeout(),
        body: JSON.stringify({ data: [{ [field]: deletes }] }),
      });
      if (!res.ok) return { ok: false, error: `Zoho passport clear failed: ${await detail(res)}` };
      const result = recordOk(await res.json().catch(() => ({})));
      if (!result.ok) return { ok: false, error: `Zoho passport clear failed: ${result.error}` };
      // Never report a purge that did not happen: read the field back.
      const after = await getDeal(dealId, [field]);
      if (!after.ok) return after;
      if (fileEntries(after.deal[field]).length > 0) return { ok: false, error: `Deal ${dealId}: passport field still has an image after the clear` };
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  },
};
