import { getResend, type EmailSendResult } from "../registeredAgent/emailSender.js";

export interface OrderEmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Passed to Resend, so a retry after a lost response does not send twice. */
  idempotencyKey: string;
}

export interface OrderEmailSender {
  send(message: OrderEmailMessage): Promise<EmailSendResult>;
}

/** Same contract as registeredAgent/emailSender.ts: fails clearly, never
 *  throws. The Terms tell customers to reply to their order email to
 *  cancel, so replies must reach a person: ORDER_EMAIL_REPLY_TO, or the
 *  From address when that is a monitored mailbox. */
export const realOrderEmailSender: OrderEmailSender = {
  async send({ to, subject, text, html, idempotencyKey }) {
    const from = process.env.RESEND_FROM_EMAIL;
    if (!process.env.RESEND_API_KEY || !from) {
      return { ok: false, error: "Resend not configured (RESEND_API_KEY / RESEND_FROM_EMAIL unset) — customer order email not sent" };
    }
    const replyTo = process.env.ORDER_EMAIL_REPLY_TO;

    try {
      const { data, error } = await getResend().emails.send(
        { from, to: [to], subject, text, html, ...(replyTo ? { replyTo } : {}) },
        { idempotencyKey }
      );
      if (error) {
        return { ok: false, error: `Resend send failed: ${error.message}` };
      }
      return { ok: true, providerMessageId: data?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
