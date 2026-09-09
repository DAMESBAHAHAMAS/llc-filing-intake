import type { Pool } from "pg";

/**
 * Count-based EIN same-day capacity governor (frozen rule: Damian
 * personally calls the IRS international-applicant line per same-day
 * case, hard cap ~20-25/day — build this as a count of today's already-
 * paid orders, NOT a fixed clock cutoff hour). "Today" is evaluated in
 * America/New_York since that's the timezone of the phone call being
 * capacity-limited, regardless of where a customer or this server is.
 */
const DEFAULT_DAILY_CAPACITY = 20;

export function getDailyCapacity(): number {
  const raw = process.env.EIN_EXPRESS_DAILY_CAPACITY;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_DAILY_CAPACITY;
}

export interface EinExpressAvailability {
  capacity: number;
  usedToday: number;
  remaining: number;
  available: boolean;
}

export async function getEinExpressAvailability(pool: Pool): Promise<EinExpressAvailability> {
  const capacity = getDailyCapacity();
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM orders
     WHERE payment_status = 'paid'
       AND paid_at IS NOT NULL
       AND (paid_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date
       AND line_items @> '[{"offer_code":"EIN_FILING_EXPRESS"}]'::jsonb`
  );
  const usedToday = Number(rows[0]?.count ?? 0);
  const remaining = Math.max(capacity - usedToday, 0);
  return { capacity, usedToday, remaining, available: remaining > 0 };
}
