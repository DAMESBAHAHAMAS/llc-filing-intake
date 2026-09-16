/**
 * Mirrors zoho/client.ts's shape deliberately (interface + result object
 * with ok/error, a real implementation gated on env config, injectable
 * for tests) — this project's existing pattern for "an outbound
 * integration this service doesn't own the credentials for yet."
 *
 * No transactional email provider exists anywhere in this codebase or
 * llc-worker.js today (audited before writing this — see
 * GATE2-REGISTERED-AGENT-ACCEPTANCE-STATUS.md §1). realEmailSender below
 * is honest about that: it fails clearly rather than pretending to send.
 * Provisioning a real provider (Resend/SES/Postmark/etc.) and its
 * credentials is an infrastructure decision outside this task's scope —
 * dropping one in means implementing the `send` call in the block marked
 * below, nothing else in this module needs to change.
 */

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
}

export interface EmailSender {
  sendRegisteredAgentAcceptanceEmail(input: RegisteredAgentAcceptanceEmailInput): Promise<EmailSendResult>;
}

/** Dedicated transactional template, §10 of the locked schema. Deliberately
 *  does NOT include the filing session, addresses beyond the registered
 *  agent's own, member/manager names, or any other customer PII — only
 *  what a registered agent needs to decide whether to accept. */
export function buildRegisteredAgentAcceptanceEmail(input: RegisteredAgentAcceptanceEmailInput): {
  subject: string;
  text: string;
} {
  const expiresLabel = input.expiresAt.toISOString().slice(0, 10);
  return {
    subject: `Action required: Registered Agent designation for ${input.llcName}`,
    text: [
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
    ].join("\n"),
  };
}

export const realEmailSender: EmailSender = {
  async sendRegisteredAgentAcceptanceEmail(input) {
    const provider = process.env.EMAIL_PROVIDER_API_KEY;
    if (!provider) {
      return {
        ok: false,
        error: "No email provider configured (EMAIL_PROVIDER_API_KEY unset) — registered-agent acceptance email not sent",
      };
    }
    // Real provider call goes here (Resend/SES/Postmark/etc.), using
    // buildRegisteredAgentAcceptanceEmail(input) for subject/text. Left
    // unimplemented deliberately — no provider or credentials exist yet
    // (see module comment); every path above this point (token minting,
    // status transitions, the acceptance page, idempotency, auditing) is
    // real and works today regardless of which provider eventually goes
    // here.
    return { ok: false, error: "realEmailSender has no provider implementation yet" };
  },
};
