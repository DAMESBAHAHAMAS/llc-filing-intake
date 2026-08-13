/**
 * Backoff schedule for crm_sync_queue, per spec: 1m, 5m, 15m, 1h, 6h,
 * 24h, dead-letter at 6.
 *
 * Interpretation (documented since the spec allows more than one
 * reading): BACKOFF_MS[i] is the wait scheduled after attempt (i+1)
 * fails, before attempt (i+2) is eligible. attempts is 1-indexed (the
 * count of attempts made so far, including the one that just failed).
 * Once attempts reaches max_attempts (6), the job is dead-lettered
 * instead of scheduling another wait — so with the default
 * max_attempts=6, the 6th entry (24h) is defined for schedule
 * completeness/documentation but isn't reachable unless max_attempts is
 * raised above 6 in a future phase.
 */
export const BACKOFF_MS = [
  60_000, // 1m  — after attempt 1 fails
  5 * 60_000, // 5m  — after attempt 2 fails
  15 * 60_000, // 15m — after attempt 3 fails
  60 * 60_000, // 1h  — after attempt 4 fails
  6 * 60 * 60_000, // 6h  — after attempt 5 fails
  24 * 60 * 60_000, // 24h — after attempt 6 fails (unreachable at max_attempts=6, see above)
];

export function isDeadLetter(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

/** Wait duration (ms) before the next attempt, given the attempt count
 *  that was just reached (1-indexed). Clamps to the last schedule entry
 *  if attempts exceeds the table (shouldn't happen once dead-lettering
 *  kicks in, but avoids an out-of-bounds undefined either way). */
export function backoffForAttempt(attempts: number): number {
  const index = Math.min(attempts - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[Math.max(index, 0)];
}
