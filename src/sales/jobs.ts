import type { FeatureHousekeepingStep, FeatureJob, FeatureJobContext } from '../scheduler-types.js';
import { enqueueTask } from '../tasks/queue.js';
import { fillMissingCosts, mapUnmatchedLines } from './ingest.js';

/** Orders changed since the last look are read this often (webhooks cover the time between). */
export const ORDER_SYNC_INTERVAL_MS = 15 * 60_000;

/**
 * Stores that may read orders: read_orders (or write_orders) granted, or never checked (then
 * Shopify's answer decides, as for every feature).
 */
const MAY_READ_ORDERS = `(s.granted_scopes IS NULL OR s.granted_scopes && ARRAY['read_orders', 'write_orders'])`;

/**
 * Queues each active store's sales work when it is due. The "due" state lives in the stores
 * table (orders_checked_at, the backfill status), and tasks are de-duplicated, so restarts and
 * several instances don't add runs.
 *
 * - sync_orders, every 15 minutes, once the history import has finished (or failed: the sync then
 *   reads the whole window page by page).
 * - sales_backfill for stores that haven't imported their history: new ones, after a "start
 *   again", and after a missing permission once the store's permissions were checked again.
 *   Also for a running import whose next check got lost (e.g. skipped while the store was paused).
 */
export async function queueSalesWork({ db, logger, onWork, now }: FeatureJobContext) {
  const due = new Date(now - ORDER_SYNC_INTERVAL_MS);
  const sync = await db.query<{ id: number }>(
    `SELECT s.id FROM stores s
      WHERE s.status = 'active' AND ${MAY_READ_ORDERS}
        AND s.sales_backfill_status IN ('done', 'failed') AND s.orders_synced_at IS NOT NULL
        AND (s.orders_checked_at IS NULL OR s.orders_checked_at <= $1)
        AND NOT EXISTS (SELECT 1 FROM tasks t
                         WHERE t.kind = 'sync_orders' AND t.payload->>'storeId' = s.id::text)
      ORDER BY s.id`,
    [due],
  );
  const backfill = await db.query<{ id: number }>(
    `SELECT s.id FROM stores s
      WHERE s.status = 'active' AND ${MAY_READ_ORDERS}
        AND ((s.sales_backfill_status = 'none'
              AND (s.sales_backfill_error IS NULL
                   OR s.scopes_checked_at > s.sales_backfill_finished_at))
             OR s.sales_backfill_status = 'running')
        AND NOT EXISTS (SELECT 1 FROM tasks t
                         WHERE t.kind = 'sales_backfill' AND t.payload->>'storeId' = s.id::text)
      ORDER BY s.id`,
  );
  for (const { id } of sync.rows) await enqueueTask(db, 'sync_orders', { storeId: id });
  for (const { id } of backfill.rows) await enqueueTask(db, 'sales_backfill', { storeId: id });
  if (sync.rows.length || backfill.rows.length) {
    logger.debug(
      { sync: sync.rows.map((r) => r.id), backfill: backfill.rows.map((r) => r.id) },
      'sales work queued',
    );
    onWork?.();
  }
}

export const SALES_JOBS: FeatureJob[] = [
  { name: 'sales_orders', everyMs: 60_000, run: queueSalesWork },
];

export const SALES_HOUSEKEEPING: FeatureHousekeepingStep[] = [
  [
    'map sales lines',
    async ({ db, logger }) => {
      const mapped = await mapUnmatchedLines(db);
      if (mapped) logger.info({ mapped }, 'sales lines mapped to products');
    },
  ],
  [
    'fill sales costs',
    async ({ db, logger }) => {
      const filled = await fillMissingCosts(db);
      if (filled) logger.info({ filled }, 'sales lines given their product cost');
    },
  ],
];
