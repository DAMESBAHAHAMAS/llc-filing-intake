import { Resend } from "resend";
import type { ScorecardEmailSender } from "./service.js";

let client: Resend | null = null;

/** Resend sender. From defaults to the address the spec names; the domain must be verified in Resend. */
export const realScorecardSender: ScorecardEmailSender = {
  async send({ to, subject, html, text, unsubscribeUrl, idempotencyKey }) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { ok: false, error: "RESEND_API_KEY is not set" };
    const from = process.env.SCORECARD_FROM_EMAIL || "Damian Knowles <damian@damianknowles.com>";
    try {
      client ??= new Resend(key);
      const { data, error } = await client.emails.send(
        {
          from,
          to: [to],
          subject,
          html,
          text,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        },
        idempotencyKey ? { idempotencyKey } : undefined
      );
      if (error) return { ok: false, error: `Resend send failed: ${error.message}` };
      return { ok: true, providerMessageId: data?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
