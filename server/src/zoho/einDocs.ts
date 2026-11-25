import { getZohoAccessToken } from "./client.js";

/**
 * ST17: puts the passport photo page on the customer's Zoho Deal and marks the
 * Deal "EIN Docs Received". The image goes straight from this request to Zoho
 * and is never written to disk or the database here.
 */
export interface EinDocsClient {
  attachToDeal(dealId: string, file: { filename: string; contentType: string; bytes: Buffer }): Promise<{ ok: true; attachmentId: string | null } | { ok: false; error: string }>;
  /** Sets the configured field to "Yes" (create it as a Yes/No picklist, not a checkbox),
   *  or adds a Deal note when no field is configured. */
  markDocsReceived(dealId: string, field: string, note: string): Promise<{ ok: true; via: "field" | "note" } | { ok: false; error: string }>;
}

const API = "https://www.zohoapis.com/crm/v2";

async function detail(res: Response): Promise<string> {
  return `${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`;
}

/** Zoho answers 200/201 with a per-record status; a record-level error must not pass as success. */
function recordResult(json: unknown): { ok: true; id: string | null } | { ok: false; error: string } {
  const rec = (json as { data?: Array<{ status?: unknown; code?: unknown; message?: unknown; details?: { id?: unknown } }> })?.data?.[0];
  if (!rec || rec.status !== "success") {
    return { ok: false, error: `${String(rec?.code ?? "no record status")} ${String(rec?.message ?? "")}`.trim().slice(0, 300) };
  }
  return { ok: true, id: typeof rec.details?.id === "string" ? rec.details.id : null };
}

export const realEinDocsClient: EinDocsClient = {
  async attachToDeal(dealId, file) {
    try {
      const token = await getZohoAccessToken();
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename);
      const res = await fetch(`${API}/Deals/${encodeURIComponent(dealId)}/Attachments`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        body: form,
      });
      if (!res.ok) return { ok: false, error: `Zoho attachment upload failed: ${await detail(res)}` };
      const result = recordResult(await res.json().catch(() => ({})));
      if (!result.ok) return { ok: false, error: `Zoho attachment upload failed: ${result.error}` };
      return { ok: true, attachmentId: result.id };
    } catch (err) {
      return { ok: false, error: `Zoho attachment upload failed: ${(err as Error).message}` };
    }
  },

  async markDocsReceived(dealId, field, note) {
    try {
      const token = await getZohoAccessToken();
      const headers = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" };
      if (field) {
        const res = await fetch(`${API}/Deals/${encodeURIComponent(dealId)}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ data: [{ [field]: "Yes" }] }),
        });
        if (!res.ok) return { ok: false, error: `Zoho Deal field update failed: ${await detail(res)}` };
        const result = recordResult(await res.json().catch(() => ({})));
        if (!result.ok) return { ok: false, error: `Zoho Deal field update failed: ${result.error}` };
        return { ok: true, via: "field" };
      }
      const res = await fetch(`${API}/Notes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ data: [{ Parent_Id: dealId, se_module: "Deals", Note_Title: "EIN Docs Received", Note_Content: note }] }),
      });
      if (!res.ok) return { ok: false, error: `Zoho Deal note failed: ${await detail(res)}` };
      const result = recordResult(await res.json().catch(() => ({})));
      if (!result.ok) return { ok: false, error: `Zoho Deal note failed: ${result.error}` };
      return { ok: true, via: "note" };
    } catch (err) {
      return { ok: false, error: `Zoho Deal update failed: ${(err as Error).message}` };
    }
  },
};
