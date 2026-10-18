import type { Queryable } from '../db/pool.js';

/**
 * How fast products sell: units sold over the last `lookbackDays` (settings.reorderLookbackDays),
 * every store together. Reports ("Per day", "Days of stock left") and Purchasing (the Reorder tab,
 * reorder alerts) both read it from here, so a product page never shows two paces.
 *
 * The window starts no earlier than the first order we have (any store) and than the item's first
 * appearance (created in Store Sync, or its first recorded sale if that is earlier): a product
 * launched 5 days ago isn't diluted over 30 days, products that already sold before Store Sync
 * was installed keep their history, and only units sold inside the window are counted. Test
 * orders, cancelled orders and gift cards don't count; refunded units don't either.
 */
export interface Pace {
  /** Units sold in the window. */
  unitsSold: number;
  /** Length of the window in days (at least 1). */
  windowDays: number;
}

/** The pace of `itemIds` (every item when null). Items that don't exist are left out. */
export async function loadPace(
  db: Queryable,
  opts: { lookbackDays: number; now?: Date; itemIds?: number[] | null },
): Promise<Map<number, Pace>> {
  const now = opts.now ?? new Date();
  const { rows } = await db.query<{ item_id: number; units_sold: number; window_days: number }>(
    `WITH bounds AS (
       SELECT $2::timestamptz - make_interval(days => $1) AS lookback_start,
              -- Per store, so each lookup is one step down the (store_id, processed_at) index.
              (SELECT min(f.first_at) FROM stores s
                 CROSS JOIN LATERAL (SELECT min(processed_at) AS first_at FROM sales_orders
                                      WHERE store_id = s.id AND deleted_at IS NULL AND NOT test) f
              ) AS first_order
     )
     SELECT i.id AS item_id, s.units_sold,
            GREATEST(1, EXTRACT(EPOCH FROM ($2::timestamptz - w.start)) / 86400)::float8 AS window_days
       FROM items i
       CROSS JOIN bounds b
       CROSS JOIN LATERAL (
         SELECT min(processed_at) AS first_sold FROM sales_lines WHERE item_id = i.id) fs
       -- GREATEST/LEAST skip NULLs: no orders at all, or no sale of this item, just don't count.
       CROSS JOIN LATERAL (
         SELECT LEAST(GREATEST(b.lookback_start, b.first_order, LEAST(i.created_at, fs.first_sold)),
                      $2::timestamptz) AS start) w
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(sl.current_quantity), 0)::int AS units_sold
           FROM sales_lines sl
           JOIN sales_orders so ON so.id = sl.order_id
          WHERE sl.item_id = i.id AND sl.processed_at >= w.start AND sl.processed_at <= $2::timestamptz
            AND NOT so.test AND so.cancelled_at IS NULL AND NOT sl.is_gift_card) s
      WHERE $3::bigint[] IS NULL OR i.id = ANY($3::bigint[])`,
    [opts.lookbackDays, now, opts.itemIds ?? null],
  );
  return new Map(
    rows.map((r) => [r.item_id, { unitsSold: r.units_sold, windowDays: r.window_days }]),
  );
}
