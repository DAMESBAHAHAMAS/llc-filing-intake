import { getZohoAccessToken, isTestEmail } from "../zoho/client.js";

export interface ScorecardLeadInput {
  email: string;
  firstName: string;
  country: string;
  leadIntent: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
}

export interface ScorecardCrmResult {
  ok: boolean;
  leadId?: string;
  error?: string;
}

export interface ScorecardCrm {
  upsertLead(input: ScorecardLeadInput): Promise<ScorecardCrmResult>;
}

export const SCORECARD_TAG = "scorecard-download";

/**
 * Writes the Lead (Lead_Source = Scorecard, Lead_Magnet = Readiness Scorecard,
 * Country_of_Residence, Lead_Intent, UTM fields, Test_Record) and adds the
 * scorecard-download tag. Succeeds only when Zoho confirms the row.
 */
export const realScorecardCrm: ScorecardCrm = {
  async upsertLead(input) {
    let token: string;
    try {
      token = await getZohoAccessToken();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const headers = { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" };
    const record: Record<string, unknown> = {
      First_Name: input.firstName,
      Last_Name: input.email.split("@")[0],
      Email: input.email,
      Lead_Source: "Scorecard",
      Lead_Magnet: "Readiness Scorecard",
      Country_of_Residence: input.country,
      Lead_Intent: input.leadIntent,
      UTM_Source: input.utmSource || undefined,
      UTM_Medium: input.utmMedium || undefined,
      UTM_Campaign: input.utmCampaign || undefined,
      UTM_Content: input.utmContent || undefined,
      Test_Record: isTestEmail(input.email),
      // Sent with the Lead itself. The separate add_tags call returned 401 with the
      // current token, so the tag never landed (found in the 10 Oct live test).
      Tag: [{ name: SCORECARD_TAG }],
    };
    for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];

    try {
      const res = await fetch("https://www.zohoapis.com/crm/v2/Leads/upsert", {
        method: "POST",
        headers,
        body: JSON.stringify({ data: [record], duplicate_check_fields: ["Email"] }),
      });
      if (!res.ok) return { ok: false, error: `Zoho Leads upsert failed: ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ status?: string; code?: string; details?: { id?: string } }> };
      const row = body.data?.[0];
      const leadId = row?.details?.id;
      if (row?.status !== "success" || !leadId) return { ok: false, error: `Zoho rejected the Lead: ${row?.code ?? "unknown"}` };

      return { ok: true, leadId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
