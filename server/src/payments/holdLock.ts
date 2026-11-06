import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { hasDiyPackage } from "../offers/diyPackage.js";

/**
 * Two money steps on one order must not overlap: a capture and a replacement,
 * or a cancel and a submission, each read the order and then talk to Stripe.
 * A database lock can't span those calls, so the order carries a short claim.
 * It lapses by itself if the process dies mid-step.
 */
export async function claimOrder(pool: Pick<Pool, "query">, orderId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE orders SET hold_op_until = now() + interval '3 minutes'
      WHERE order_id = $1 AND (hold_op_until IS NULL OR hold_op_until < now())`,
    [orderId]
  );
  return (rowCount ?? 0) > 0;
}

export async function releaseOrder(pool: Pick<Pool, "query">, orderId: string): Promise<void> {
  await pool.query(`UPDATE orders SET hold_op_until = NULL WHERE order_id = $1`, [orderId]);
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
      if (!(await claimOrder(pool, orderId))) {
        res.status(409).json({ error: "another step is running on this order; try again in a moment", code: "order_busy" });
        return;
      }
      // Released before the response leaves, so the next step can't be refused
      // by the one that just finished. "close" covers a dropped connection.
      const end = res.end.bind(res) as (...args: unknown[]) => Response;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await releaseOrder(pool, orderId).catch(() => undefined);
      };
      res.end = ((...args: unknown[]) => {
        void release().finally(() => end(...args));
        return res;
      }) as typeof res.end;
      res.once("close", () => void release());
      next();
    } catch (err) {
      next(err);
    }
  };
}
