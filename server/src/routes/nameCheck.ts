import { Router } from "express";
import { pool } from "../db/pool.js";
import { describeError } from "../db/describeError.js";
import { findRestrictedWordHits } from "../nameCheck/restrictedWords.js";

export const nameCheckRouter = Router();

interface SunbizEntity {
  corporate_name?: string;
  status?: string;
}
interface SunbizProxyResponse {
  entities?: SunbizEntity[];
  total_results?: number;
}

function stripLlcSuffix(name: string): string {
  return name.toLowerCase().replace(/\s*(llc|l\.l\.c\.)\s*$/i, "").trim();
}

/**
 * POST /api/name-check
 *
 * Frozen rule: hard pre-payment gate via the REAL sunbiz-proxy service —
 * not a client-side keyword-match placeholder. One authoritative
 * verdict, no bypass. Hard rejection only on an actual active-entity
 * conflict; a restricted-word hit (bank/trust/attorney/university/
 * insurance/etc.) is always a warning alongside the verdict, never a
 * rejection by itself.
 *
 * KNOWN LIMITATION, logged in DECISIONS.md: this environment's outbound
 * network policy blocks ad-hoc HTTPS to arbitrary hosts (confirmed via a
 * direct curl attempt to sunbiz-proxy.onrender.com, which the egress
 * proxy rejected — org policy, not a code bug), so the exact
 * request/response contract of the already-deployed sunbiz-proxy service
 * could not be empirically re-verified from inside this session. This
 * mirrors the contract llc-worker.js already uses successfully in
 * production (POST { name } -> { entities: [{corporate_name, status}],
 * total_results }) rather than guessing a new one. SUNBIZ_PROXY_URL must
 * be set to the exact, full endpoint URL (including path) — confirm it
 * matches llc-worker.js's RENDER_PROXY_URL value before deploying.
 */
nameCheckRouter.post("/api/name-check", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const filingSessionId = typeof body.filing_session_id === "string" ? body.filing_session_id.trim() : null;

  if (!name || name.length < 2) {
    res.status(400).json({ error: "name is required (min 2 characters)" });
    return;
  }

  const proxyUrl = process.env.SUNBIZ_PROXY_URL;
  if (!proxyUrl) {
    res.status(500).json({ error: "server misconfigured: SUNBIZ_PROXY_URL not set" });
    return;
  }

  let proxyData: SunbizProxyResponse;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const proxyRes = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!proxyRes.ok) {
      res.status(502).json({ error: `sunbiz-proxy returned ${proxyRes.status}` });
      return;
    }
    proxyData = (await proxyRes.json()) as SunbizProxyResponse;
  } catch (err) {
    res.status(502).json({ error: "sunbiz-proxy unreachable", detail: describeError(err) });
    return;
  }

  const entities = proxyData.entities ?? [];
  const totalResults = proxyData.total_results ?? 0;
  const strippedTarget = stripLlcSuffix(name);

  const activeConflict = entities.some(
    (e) => e.status === "Active" && e.corporate_name && stripLlcSuffix(e.corporate_name) === strippedTarget
  );

  const restrictedWordHits = findRestrictedWordHits(name);

  const result = {
    searched_name: name,
    distinguishable: !activeConflict,
    verdict: activeConflict ? ("rejected" as const) : ("approved" as const),
    reason: activeConflict
      ? "An active Florida entity with this name (or a name differing only by entity suffix) already exists."
      : totalResults > 0
        ? "No exact active conflict found; similar names exist — review before filing."
        : "No conflicts found.",
    similar_count: totalResults,
    similar_entities: entities.slice(0, 5),
    restricted_word_hits: restrictedWordHits,
    restricted_word_warning:
      restrictedWordHits.length > 0
        ? `Name contains restricted word(s): ${restrictedWordHits.join(", ")}. This is a warning, not a rejection — additional state approval/licensing may be required.`
        : null,
  };

  if (filingSessionId) {
    try {
      await pool.query(`UPDATE filing_sessions SET name_check_results = $2 WHERE filing_session_id = $1`, [
        filingSessionId,
        JSON.stringify(result),
      ]);
    } catch (err) {
      // Persisting the verdict is best-effort here — the verdict itself
      // is still returned to the caller either way; log for visibility.
      console.error("[name-check] failed to persist name_check_results", describeError(err));
    }
  }

  res.status(200).json(result);
});
