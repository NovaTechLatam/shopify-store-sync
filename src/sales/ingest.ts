import type { Db, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { normalizeSku } from '../catalog/sku.js';
import type { ShopifyOrder } from '../shopify/types.js';
import { roundMoney } from '../util/money.js';

/**
 * Order ingestion: every store's orders as Shopify has them now, without customer data. Orders
 * arrive from several places at once (webhook refreshes, the 15-minute sync, the history import)
 * and in any order, so every write is guarded by Shopify's `updatedAt`: an older copy never
 * overwrites a newer one.
 */

export type UpsertOutcome = 'inserted' | 'updated' | 'stale' | 'deleted';

/**
 * Saves one order and its lines. Must run inside a transaction (the order row stays locked until
 * it commits, so two copies of the same order are written one after the other).
 *
 * - Skipped when the stored copy is newer (`shopify_updated_at`), or the order was deleted.
 * - Lines no longer on the order are deleted; the others are updated in place.
 * - Each line is mapped to an item: the store's variant (as matched on the Matching page), else
 *   the SKU. A variant the merchant unlinked by hand ("never sync") is left unmapped.
 * - `unit_cost` is the item's cost when the line is first seen and is kept afterwards, so a later
 *   cost change doesn't rewrite past margins. A line seen while its item had no cost takes the
 *   item's cost once it has one (see fillMissingCosts).
 */
export async function upsertOrder(
  client: Queryable,
  storeId: number,
  order: ShopifyOrder,
): Promise<UpsertOutcome> {
  const { rows } = await client.query<{ id: number; inserted: boolean }>(
    `INSERT INTO sales_orders (store_id, shopify_order_id, name, processed_at, shopify_updated_at,
                               cancelled_at, test, currency_code, source_name, taxes_included)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (store_id, shopify_order_id) DO UPDATE
       SET name = EXCLUDED.name, processed_at = EXCLUDED.processed_at,
           shopify_updated_at = EXCLUDED.shopify_updated_at, cancelled_at = EXCLUDED.cancelled_at,
           test = EXCLUDED.test, currency_code = EXCLUDED.currency_code,
           source_name = EXCLUDED.source_name, taxes_included = EXCLUDED.taxes_included,
           ingested_at = now()
       -- Equal timestamps are the same version: writing it again is harmless (and maps lines
       -- with today's matching).
       WHERE sales_orders.deleted_at IS NULL
         AND sales_orders.shopify_updated_at <= EXCLUDED.shopify_updated_at
     RETURNING id, (xmax = 0) AS inserted`,
    [
      storeId,
      order.id,
      order.name,
      order.processedAt,
      order.updatedAt,
      order.cancelledAt,
      order.test,
      order.currencyCode,
      order.sourceName,
      order.taxesIncluded,
    ],
  );
  const saved = rows[0];
  if (!saved) {
    const { rows: existing } = await client.query<{ deleted: boolean }>(
      `SELECT deleted_at IS NOT NULL AS deleted FROM sales_orders
        WHERE store_id = $1 AND shopify_order_id = $2`,
      [storeId, order.id],
    );
    return existing[0]?.deleted ? 'deleted' : 'stale';
  }

  // Shopify may list a line twice across pages in theory; the last copy wins.
  const lines = [...new Map(order.lines.map((l) => [l.id, l])).values()];
  await client.query(
    `DELETE FROM sales_lines WHERE order_id = $1 AND NOT (shopify_line_id = ANY($2::text[]))`,
    [saved.id, lines.map((l) => l.id)],
  );
  if (lines.length) {
    await client.query(
      `INSERT INTO sales_lines (order_id, store_id, shopify_line_id, item_id, sku,
                                shopify_variant_id, quantity, current_quantity, gross, discounts,
                                net, unit_cost, is_gift_card, processed_at)
       SELECT $1, $2, x.line_id, m.item_id, x.sku, x.variant_id, x.quantity, x.current_quantity,
              x.gross, x.discounts, x.net, i.cost, x.is_gift_card, $3
         FROM unnest($4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::numeric[],
                     $10::numeric[], $11::numeric[], $12::boolean[])
                AS x(line_id, sku, variant_id, quantity, current_quantity, gross, discounts, net,
                     is_gift_card)
         LEFT JOIN variants v ON v.store_id = $2 AND v.shopify_variant_id = x.variant_id
         CROSS JOIN LATERAL (
           SELECT CASE WHEN v.item_id IS NOT NULL THEN v.item_id
                       WHEN v.link_source = 'manual' THEN NULL
                       ELSE (SELECT it.id FROM items it WHERE it.sku = x.sku) END AS item_id
         ) m
         LEFT JOIN items i ON i.id = m.item_id
       ON CONFLICT (order_id, shopify_line_id) DO UPDATE
         SET item_id = COALESCE(EXCLUDED.item_id, sales_lines.item_id),
             -- The snapshot stays, unless the line now belongs to another item.
             unit_cost = CASE
               WHEN EXCLUDED.item_id IS NOT NULL AND EXCLUDED.item_id IS DISTINCT FROM sales_lines.item_id
                 THEN EXCLUDED.unit_cost
               ELSE COALESCE(sales_lines.unit_cost, EXCLUDED.unit_cost) END,
             sku = EXCLUDED.sku, shopify_variant_id = EXCLUDED.shopify_variant_id,
             quantity = EXCLUDED.quantity, current_quantity = EXCLUDED.current_quantity,
             gross = EXCLUDED.gross, discounts = EXCLUDED.discounts, net = EXCLUDED.net,
             is_gift_card = EXCLUDED.is_gift_card, processed_at = EXCLUDED.processed_at`,
      [
        saved.id,
        storeId,
        order.processedAt,
        lines.map((l) => l.id),
        lines.map((l) => normalizeSku(l.sku)),
        lines.map((l) => l.variantId),
        lines.map((l) => l.quantity),
        lines.map((l) => l.currentQuantity),
        lines.map((l) => roundMoney(l.unitPrice * l.quantity, 4)),
        lines.map((l) => l.discounts),
        lines.map((l) => l.net),
        lines.map((l) => l.isGiftCard),
      ],
    );
  }
  return saved.inserted ? 'inserted' : 'updated';
}

export interface IngestCounts {
  inserted: number;
  updated: number;
  /** Older than what we have, or deleted in Shopify: left alone. */
  skipped: number;
}

/** Orders per transaction when many are saved at once (a history import, a sync page). */
const INGEST_BATCH = 100;

/**
 * Saves orders of one store, a batch per transaction. Within a batch the orders are written (and
 * their rows locked) in order of id: two batches sharing orders, like the history import and a
 * sync page (both sorted by updatedAt, but read at different moments), would otherwise each lock
 * one of them and wait for the other, and Postgres aborts one of them as a deadlock.
 */
export async function ingestOrders(
  db: Db,
  storeId: number,
  orders: ShopifyOrder[],
): Promise<IngestCounts> {
  const counts: IngestCounts = { inserted: 0, updated: 0, skipped: 0 };
  for (let i = 0; i < orders.length; i += INGEST_BATCH) {
    // A stable sort: copies of one order keep their order (the last one wins).
    const batch = orders
      .slice(i, i + INGEST_BATCH)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    await withTransaction(db, async (client) => {
      for (const order of batch) {
        const outcome = await upsertOrder(client, storeId, order);
        if (outcome === 'inserted') counts.inserted++;
        else if (outcome === 'updated') counts.updated++;
        else counts.skipped++;
      }
    });
  }
  return counts;
}

/**
 * An order was deleted in Shopify: its lines go, and its row stays as a marker (see
 * migrations/005_sales.sql). Also written for an order we never had, in case its creation is
 * delivered after its deletion. Writing the marker goes through the same unique key as
 * upsertOrder, so the two can't interleave.
 */
export async function removeOrder(db: Db, storeId: number, orderId: string): Promise<void> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO sales_orders (store_id, shopify_order_id, processed_at, shopify_updated_at,
                                 currency_code, deleted_at)
       SELECT $1, $2, now(), now(), '', now() WHERE EXISTS (SELECT 1 FROM stores WHERE id = $1)
       ON CONFLICT (store_id, shopify_order_id) DO UPDATE
         SET deleted_at = COALESCE(sales_orders.deleted_at, now())
       RETURNING id`,
      [storeId, orderId],
    );
    // No row: the store was removed meanwhile, and its orders with it.
    if (rows[0]) await client.query('DELETE FROM sales_lines WHERE order_id = $1', [rows[0].id]);
  });
}

/** Lines per housekeeping run, so a big backlog never becomes one long statement. */
const HOUSEKEEPING_BATCH = 5000;

/**
 * Maps lines that had no item when they were saved (the SKU wasn't matched yet, or the product
 * was created later) the same way upsertOrder does. Returns how many were mapped.
 */
export async function mapUnmatchedLines(
  db: Queryable,
  limit = HOUSEKEEPING_BATCH,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE sales_lines l SET item_id = m.item_id, unit_cost = COALESCE(l.unit_cost, m.cost)
       FROM (SELECT l2.id, mapped.item_id, i.cost
               FROM sales_lines l2
               LEFT JOIN variants v
                 ON v.store_id = l2.store_id AND v.shopify_variant_id = l2.shopify_variant_id
               CROSS JOIN LATERAL (
                 SELECT CASE WHEN v.item_id IS NOT NULL THEN v.item_id
                             WHEN v.link_source = 'manual' THEN NULL
                             ELSE (SELECT it.id FROM items it WHERE it.sku = l2.sku) END AS item_id
               ) mapped
               JOIN items i ON i.id = mapped.item_id
              WHERE l2.item_id IS NULL
              LIMIT $1) m
      WHERE l.id = m.id AND l.item_id IS NULL`,
    [limit],
  );
  return rowCount ?? 0;
}

/**
 * Gives lines without a cost snapshot their item's cost, once the item has one (sales imported
 * before costs were entered would otherwise never show a margin). Returns how many were filled.
 */
export async function fillMissingCosts(db: Queryable, limit = HOUSEKEEPING_BATCH): Promise<number> {
  // From the items that have a cost, down the index of lines without one: cheap when there is
  // nothing to do, even with many lines of products that never get a cost.
  const { rowCount } = await db.query(
    `UPDATE sales_lines l SET unit_cost = i.cost
       FROM items i
      WHERE l.id IN (SELECT x.id FROM items i2
                      CROSS JOIN LATERAL (SELECT l2.id FROM sales_lines l2
                                           WHERE l2.item_id = i2.id AND l2.unit_cost IS NULL
                                           LIMIT $1) x
                      WHERE i2.cost IS NOT NULL
                      LIMIT $1)
        AND i.id = l.item_id AND l.unit_cost IS NULL AND i.cost IS NOT NULL`,
    [limit],
  );
  return rowCount ?? 0;
}
