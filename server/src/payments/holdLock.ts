import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { hasDiyPackage } from "../offers/diyPackage.js";

/**
 * Two money steps on one order must not overlap: a capture and a replacement,
 * or a cancel and a submission, each read the order and then talk to Stripe.
 * A database lock can't span those calls, so the order carries a short claim.
 * It lapses by itself if the process dies mid-step.
 *
 * Returns the claim's token, or null if another step holds the order.
 */
export async function claimOrder(pool: Pick<Pool, "query">, orderId: string): Promise<string | null> {
  const token = randomUUID();
  const { rowCount } = await pool.query(
    `UPDATE orders SET hold_op_until = now() + interval '3 minutes', hold_op_token = $2
      WHERE order_id = $1 AND (hold_op_until IS NULL OR hold_op_until < now())`,
    [orderId, token]
  );
  return (rowCount ?? 0) > 0 ? token : null;
}

/** Clears only the caller's claim: a step that outlived it must not free the next step's. */
export async function releaseOrder(pool: Pick<Pool, "query">, orderId: string, token: string): Promise<void> {
  await pool.query(`UPDATE orders SET hold_op_until = NULL, hold_op_token = NULL WHERE order_id = $1 AND hold_op_token = $2`, [orderId, token]);
}

/** Route guard: for a $139 order, one operator step at a time. */
export function oneStepAtATime(pool: Pick<Pool, "query">, authorized: (req: Request) => boolean) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!authorized(req)) {
      res.status(401).json({ error: "operator key required" });
      return;
    }
    const orderId = String(req.params.orderId);
    try {
      const { rows } = await pool.query<{ line_items: Array<{ offer_code?: string }> | null }>(`SELECT line_items FROM orders WHERE order_id = $1`, [orderId]);
      if (!hasDiyPackage(rows[0]?.line_items ?? [])) {
        next();
        return;
      }
      const token = await claimOrder(pool, orderId);
      if (!token) {
        res.status(409).json({ error: "another step is running on this order; try again in a moment", code: "order_busy" });
        return;
      }
      // Released when the handler answers, before the response leaves, so the
      // next step can't be refused by this one. Not on a dropped connection:
      // the handler keeps running, and may be mid-capture.
      const end = res.end.bind(res) as (...args: unknown[]) => Response;
      let released = false;
      res.end = ((...args: unknown[]) => {
        if (released) return end(...args);
        released = true;
        void releaseOrder(pool, orderId, token)
          .catch(() => undefined)
          .finally(() => end(...args));
        return res;
      }) as typeof res.end;
      next();
    } catch (err) {
      next(err);
    }
  };
}
