/**
 * Mirrors zoho/client.ts's shape deliberately (interface + result object
 * with ok/error, a real implementation gated on env config, injectable
 * for tests) — this project's existing pattern for "an outbound
 * integration this service doesn't own the credentials for yet."
 *
 * Provider: Resend, via its official SDK — a deliberate, explicit
 * exception to GOVERNANCE.md rule 5 ("no third-party dependency without
 * listing it and waiting for approval"), per direct instruction (see
 * DECISIONS.md, "Registered-agent acceptance email provider is Resend").
 * Every other outbound integration in this codebase (Zoho, Stripe's own
 * REST client, Telnyx elsewhere) uses plain `fetch` specifically to
 * avoid this kind of dependency — this module is the one deliberate
 * exception, not a new default.
 *
 * Closes the gap routes/registeredAgent.ts's own comment names: "this
 * does not send an email... standing up one would be a new integration
 * this session cannot verify end-to-end without credentials." Credentials
 * (RESEND_API_KEY / RESEND_FROM_EMAIL) are still required at runtime —
 * this module fails clearly, not silently, until they're set.
 */
import { Resend } from "resend";

export interface RegisteredAgentAcceptanceEmailInput {
  toEmail: string;
  toName: string;
  llcName: string;
  registeredAgentFloridaAddress: string;
  acceptanceUrl: string;
  expiresAt: Date;
}

export interface EmailSendResult {
  ok: boolean;
  error?: string;
  /** The provider's own id for this send, when available — useful for
   *  support/forensics ("did this specific email actually go out"). */
  providerMessageId?: string;
}

export interface EmailSender {
  sendRegisteredAgentAcceptanceEmail(input: RegisteredAgentAcceptanceEmailInput): Promise<EmailSendResult>;
}

/** Dedicated transactional template. Deliberately does NOT include the
 *  filing session, addresses beyond the registered agent's own,
 *  member/manager names, or any other customer PII — only what a
 *  registered agent needs to decide whether to accept. text and html
 *  render the identical content — html is not a separate message, just a
 *  styled rendering of the same subject/body for clients that render it,
 *  with text as the universal fallback. */
export function buildRegisteredAgentAcceptanceEmail(input: RegisteredAgentAcceptanceEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const expiresLabel = input.expiresAt.toISOString().slice(0, 10);
  const subject = `Action required: Registered Agent designation for ${input.llcName}`;
  const text = [
    `Hi ${input.toName},`,
    "",
    `You have been designated as the Registered Agent for ${input.llcName}, a Florida LLC.`,
    `Registered agent address on file: ${input.registeredAgentFloridaAddress}`,
    "",
    "As registered agent, you would be responsible for accepting legal and state correspondence on the company's behalf at this address.",
    "",
    "Please review and respond to this designation here:",
    input.acceptanceUrl,
    "",
    `This link expires on ${expiresLabel} and can only be used once.`,
    "If you were not expecting this designation, you may decline it using the same link.",
  ].join("\n");

  const html = `
    <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
      <h2>Registered Agent Designation Notice</h2>
      <p>Hi ${escapeHtml(input.toName)},</p>
      <p>You have been designated as the Registered Agent for <strong>${escapeHtml(input.llcName)}</strong>, a Florida LLC.</p>
      <p>Registered agent address on file: ${escapeHtml(input.registeredAgentFloridaAddress)}</p>
      <p>As registered agent, you would be responsible for accepting legal and state correspondence on the company's behalf at this address.</p>
      <p style="margin: 24px 0;">
        <a href="${input.acceptanceUrl}"
           style="background-color: #0066cc; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">
          Review &amp; Respond
        </a>
      </p>
      <p style="font-size: 12px; color: #666;">
        Or copy and paste this link into your browser:<br>
        <a href="${input.acceptanceUrl}">${input.acceptanceUrl}</a>
      </p>
      <p style="font-size: 12px; color: #666;">
        This link expires on ${expiresLabel} and can only be used once. If you were not expecting this designation, you may decline it using the same link.
      </p>
    </div>
  `;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let resendSingleton: Resend | null = null;
/** Lazy singleton, same rationale as stripe/restClient.ts's
 *  getSecretKey(): fails clearly when actually called without a key,
 *  rather than crashing the whole process at import time. */
function getResend(): Resend {
  if (resendSingleton) return resendSingleton;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set. See .env.example.");
  }
  resendSingleton = new Resend(apiKey);
  return resendSingleton;
}

export const realEmailSender: EmailSender = {
  async sendRegisteredAgentAcceptanceEmail(input) {
    const from = process.env.RESEND_FROM_EMAIL;
    if (!process.env.RESEND_API_KEY || !from) {
      return {
        ok: false,
        error:
          "Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL unset) — registered-agent acceptance email not sent",
      };
    }

    const { subject, text, html } = buildRegisteredAgentAcceptanceEmail(input);

    try {
      const { data, error } = await getResend().emails.send({
        from,
        to: [input.toEmail],
        subject,
        text,
        html,
      });

      if (error) {
        return { ok: false, error: `Resend send failed: ${error.message}` };
      }
      return { ok: true, providerMessageId: data?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
