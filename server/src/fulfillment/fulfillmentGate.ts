import type { Pool, PoolClient } from "pg";

/** Mirrors the CHECK constraint on orders.fulfillment_status (migration 0010). */
export type FulfillmentStatus = "not_ready" | "ready" | "in_progress" | "transmitted" | "failed" | "requires_review";

/**
 * Minimal, intentionally shallow fulfillment-readiness check — NOT a
 * substitute for the PDF composer's own validation
 * (pdf/composeArticlesOfOrganizationContext.ts), which remains the
 * authority on whether filing_data is complete enough to actually
 * generate Articles of Organization. This only needs to distinguish
 * "structurally absent" (the case Gate 2's own checkout gate — stage !==
 * 'complete' — should already prevent, but this is the payment-side
 * backstop for it) from "present enough to hand to the next stage." Full
 * field-level validation belongs to whatever consumes filing_data next
 * (PDF generation, and eventually Sunbiz transmission), not to this
 * payment-triggered gate.
 */
export function isFilingDataFulfillmentReady(filingData: unknown): boolean {
  if (!filingData || typeof filingData !== "object") return false;
  const llcName = (filingData as Record<string, unknown>).llc_name;
  return typeof llcName === "string" && llcName.trim().length > 0;
}

/**
 * Whether a third-party ("own") registered agent still needs to accept
 * before this order may be treated as filing-ready. agent_choice lives
 * in filing_data (pdf/types.ts); registered_agent_status is the separate
 * filing_sessions column the Gate 2 acceptance gate reads (§6 of the
 * locked schema, registeredAgent/acceptanceService.ts). "damian" never
 * blocks — that path is set to 'accepted' synchronously, with no email,
 * the moment it's selected.
 */
export function needsRegisteredAgentAcceptance(
  filingData: unknown,
  registeredAgentStatus: string | null
): boolean {
  const agentChoice = filingData && typeof filingData === "object" ? (filingData as Record<string, unknown>).agent_choice : undefined;
  return agentChoice === "own" && registeredAgentStatus !== "accepted";
}

export type FulfillmentDecisionReason =
  | "fulfillment_ready"
  | "fulfillment_blocked_missing_filing_data"
  | "fulfillment_blocked_awaiting_registered_agent";

export function decideFulfillmentStatus(
  filingData: unknown,
  registeredAgentStatus: string | null
): { status: FulfillmentStatus; reason: FulfillmentDecisionReason } {
  if (!isFilingDataFulfillmentReady(filingData)) {
    return { status: "requires_review", reason: "fulfillment_blocked_missing_filing_data" };
  }
  if (needsRegisteredAgentAcceptance(filingData, registeredAgentStatus)) {
    return { status: "not_ready", reason: "fulfillment_blocked_awaiting_registered_agent" };
  }
  return { status: "ready", reason: "fulfillment_ready" };
}

/**
 * The single place orders.fulfillment_status is ever written (migration
 * 0010's own comment: "written EXCLUSIVELY by webhook/stripeWebhookService.ts
 * ... never client-writable, never set independently of a verified
 * payment"). That invariant is about ownership, not file boundaries —
 * this module exists so the two legitimate server-side triggers (a
 * payment just confirmed; a registered agent just accepted, unblocking
 * an order that was already paid) share one write path instead of each
 * hand-rolling the UPDATE. Nothing else may call this. Accepts an
 * already-open transactional client when the caller has one (the
 * payment-confirmation path) or the pool otherwise (the acceptance path,
 * which commits its own registered_agent_status change first and only
 * then, separately, re-evaluates fulfillment).
 */
export async function markOrderFulfillmentReady(
  db: Pool | PoolClient,
  orderId: string,
  reason: "fulfillment_ready" | "registered_agent_accepted",
  filingSessionId: string,
  extraPayload: Record<string, unknown> = {}
): Promise<void> {
  await db.query(
    `UPDATE orders SET fulfillment_status = 'ready', fulfillment_ready_at = now() WHERE order_id = $1`,
    [orderId]
  );
  await db.query(`INSERT INTO filing_events (filing_session_id, event_type, payload) VALUES ($1, $2, $3)`, [
    filingSessionId,
    "fulfillment_ready",
    { order_id: orderId, reason, ...extraPayload },
  ]);
}
