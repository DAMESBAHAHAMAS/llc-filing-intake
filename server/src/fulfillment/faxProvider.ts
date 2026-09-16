/**
 * Fax transmission adapter. Mirrors this codebase's existing pattern for
 * an outbound integration (interface + injectable real implementation +
 * a result object with ok/error) — see checkout/stripeCheckoutClient.ts,
 * zoho/client.ts, registeredAgent/emailSender.ts. `FaxProvider` is the
 * seam: fulfillmentWorker.ts depends only on this interface, never on
 * Telnyx specifically, so a future provider swap (or a second, different
 * destination type) is a new implementation of this interface, not a
 * rewrite of the fulfillment engine.
 *
 * telnyxFaxProvider below is the real, working implementation — chosen
 * per this task's own instruction (2026-09-01 decision, DECISIONS.md).
 * Uses plain `fetch` against Telnyx's public v2 REST API — no SDK
 * dependency added (GOVERNANCE.md rule 5).
 */

export interface SendFaxInput {
  /** E.164 destination number. Always sourced from configuration by the
   *  caller (fulfillmentWorker.ts) — this module never reads env vars
   *  for the destination itself, only for its own provider credentials. */
  toNumber: string;
  /** A URL Telnyx will fetch the PDF from. Must be reachable from the
   *  public internet — see routes/faxMedia.ts, the only thing that ever
   *  produces one of these. */
  mediaUrl: string;
}

export interface SendFaxResult {
  ok: boolean;
  /** The provider's own id for this transmission (Telnyx fax id) —
   *  required to poll status later. Present whenever ok is true. */
  providerTransmissionId?: string;
  error?: string;
}

export type FaxDeliveryState = "in_progress" | "delivered" | "failed" | "unknown";

export interface FaxStatusResult {
  ok: boolean;
  /** Normalized, provider-agnostic state — what fulfillmentWorker.ts
   *  actually branches on. */
  state?: FaxDeliveryState;
  /** The provider's own raw status string, kept verbatim for forensics
   *  and for diagnosing a status this adapter doesn't yet recognize. */
  providerStatus?: string;
  failureReason?: string;
  error?: string;
}

export interface FaxProvider {
  sendFax(input: SendFaxInput): Promise<SendFaxResult>;
  getFaxStatus(providerTransmissionId: string): Promise<FaxStatusResult>;
}

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * Telnyx's Fax resource status field is not a small closed enum in their
 * own docs — known values in the wild include queued/media.processed/
 * sending/delivered/failed, and Telnyx has added intermediate values
 * before without a major version bump. Rather than hardcode an
 * exhaustive (and inevitably incomplete) allow-list, this recognizes the
 * two terminal states by substring match and treats everything else as
 * still in progress — a status this adapter has never seen before fails
 * safe as "in_progress" (never silently "delivered"), and the caller's
 * own attempt-count/backoff ceiling is what eventually surfaces an
 * unrecognized stuck status for operator review, rather than this
 * function ever guessing.
 */
function normalizeTelnyxStatus(rawStatus: string | undefined): FaxDeliveryState {
  const status = (rawStatus ?? "").toLowerCase();
  if (status.includes("delivered")) return "delivered";
  if (status.includes("fail")) return "failed";
  if (!status) return "unknown";
  return "in_progress";
}

/**
 * Real implementation. Fails clearly (never throws past its own
 * boundary — every path returns a result object) when Telnyx credentials
 * are missing, exactly like realZohoClient/realEmailSender's own
 * "clearly not configured" paths, so a missing env var surfaces as a
 * normal recorded transmission failure (fulfillment_transmissions.status
 * = 'failed', failure_reason set) rather than an unhandled exception
 * crashing the worker tick.
 */
export const telnyxFaxProvider: FaxProvider = {
  async sendFax({ toNumber, mediaUrl }): Promise<SendFaxResult> {
    const apiKey = process.env.TELNYX_API_KEY;
    const connectionId = process.env.TELNYX_FAX_CONNECTION_ID;
    const fromNumber = process.env.TELNYX_FAX_FROM_NUMBER;

    if (!apiKey || !connectionId || !fromNumber) {
      return {
        ok: false,
        error:
          "Telnyx not configured (TELNYX_API_KEY / TELNYX_FAX_CONNECTION_ID / TELNYX_FAX_FROM_NUMBER) — fax not sent",
      };
    }

    try {
      const res = await fetch(`${TELNYX_API_BASE}/faxes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          connection_id: connectionId,
          media_url: mediaUrl,
          to: toNumber,
          from: fromNumber,
        }),
      });

      const body = (await res.json().catch(() => null)) as { data?: { id?: string }; errors?: unknown } | null;

      if (!res.ok) {
        return { ok: false, error: `Telnyx send-fax failed (${res.status}): ${JSON.stringify(body ?? {})}` };
      }

      const providerTransmissionId = body?.data?.id;
      if (!providerTransmissionId) {
        return { ok: false, error: `Telnyx accepted the request but returned no fax id: ${JSON.stringify(body ?? {})}` };
      }

      return { ok: true, providerTransmissionId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async getFaxStatus(providerTransmissionId): Promise<FaxStatusResult> {
    const apiKey = process.env.TELNYX_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "Telnyx not configured (TELNYX_API_KEY) — cannot check fax status" };
    }

    try {
      const res = await fetch(`${TELNYX_API_BASE}/faxes/${encodeURIComponent(providerTransmissionId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const body = (await res.json().catch(() => null)) as { data?: { status?: string } } | null;

      if (!res.ok) {
        return { ok: false, error: `Telnyx get-fax-status failed (${res.status}): ${JSON.stringify(body ?? {})}` };
      }

      const providerStatus = body?.data?.status;
      const state = normalizeTelnyxStatus(providerStatus);
      return {
        ok: true,
        state,
        providerStatus,
        failureReason: state === "failed" ? `Telnyx reported status "${providerStatus}"` : undefined,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
