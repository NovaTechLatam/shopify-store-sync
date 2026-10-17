import type { Logger } from 'pino';
import { setAlert } from '../alerts/alerts.js';
import type { Db } from '../db/pool.js';
import { enqueueTask } from '../tasks/queue.js';
import type { ShopifyRegistry } from './engine.js';
import { displayQuantity } from './engine.js';
import { enqueuePoolLevels } from './queue.js';

export interface DriftResult {
  /** Synced inventory levels compared with the store. */
  checked: number;
  /** Pool levels queued for a reconcile. */
  drifted: number;
  /** Changes made in the store that no webhook told us about. */
  missingWebhooks: number;
}

/** Missed changes in one scan from which we tell the merchant that webhooks look broken. */
const WEBHOOK_GAP_THRESHOLD = 3;

interface SyncedLevel {
  pool_level_id: number;
  inventory_item_id: string;
  location_id: string;
  quantity: number;
  safety_buffer: number;
  baseline: number | null;
  baseline_updated_at: Date | null;
  queued: boolean;
}

/**
 * Compares every synced inventory level of a store with what we expect it to be and queues a
 * reconcile for each one that differs. Catches changes whose webhook never arrived and writes that
 * failed for good. The engine does the actual correcting, so a false positive costs one reconcile.
 *
 * Our snapshot of the database and the store's live values can't be taken at the same instant
 * while the engine keeps working, so the database is read again after the store: a difference is
 * only counted as a missed webhook if the baseline predates the store read and no reconcile is
 * queued or running for it.
 */
export async function driftScan(
  deps: { db: Db; shopify: ShopifyRegistry; logger: Logger },
  storeId: number,
): Promise<DriftResult> {
  const { db, logger } = deps;
  const store = (
    await db.query<{ name: string; status: string }>(
      'SELECT name, status FROM stores WHERE id = $1',
      [storeId],
    )
  ).rows[0];
  if (!store || store.status !== 'active') return { checked: 0, drifted: 0, missingWebhooks: 0 };

  const { rows: before } = await db.query<{ read_started_at: Date }>(
    'SELECT clock_timestamp() AS read_started_at',
  );
  const readStartedAt = before[0]!.read_started_at;
  const levels = await loadSyncedLevels(db, storeId);
  const live = await readLive(deps.shopify, storeId, levels);
  const fresh = await loadSyncedLevels(
    db,
    storeId,
    levels.map((l) => l.pool_level_id),
  );

  const drifted: number[] = [];
  let checked = 0;
  let missingWebhooks = 0;
  for (const level of fresh) {
    const value = live.get(levelKey(level));
    if (value === undefined) continue; // variant or location mapping changed during the scan
    checked++;
    const shows = displayQuantity(level.quantity, level.safety_buffer);
    if (level.baseline !== null && value === level.baseline && showsExpected(value, shows))
      continue;
    drifted.push(level.pool_level_id);
    const missed =
      level.baseline !== null &&
      value !== level.baseline &&
      !level.queued &&
      level.baseline_updated_at !== null &&
      level.baseline_updated_at < readStartedAt;
    if (missed) missingWebhooks++;
  }

  await enqueuePoolLevels(db, drifted, 'drift');
  await db.query(
    'UPDATE stores SET last_drift_scan_at = now(), last_drift_count = $2 WHERE id = $1',
    [storeId, drifted.length],
  );
  if (missingWebhooks > 0) {
    await db.query(
      `INSERT INTO inventory_events (store_id, kind, message, details) VALUES ($1, 'drift_detected', $2, $3)`,
      [
        storeId,
        `${missingWebhooks} stock change${missingWebhooks === 1 ? '' : 's'} in ${store.name} ` +
          `arrived without a notification from Shopify; ${missingWebhooks === 1 ? 'it is' : 'they are'} being synced now.`,
        JSON.stringify({ checked, drifted: drifted.length, missingWebhooks }),
      ],
    );
  }
  if (missingWebhooks >= WEBHOOK_GAP_THRESHOLD) {
    await setAlert(db, {
      open: true,
      kind: 'webhook_gap',
      dedupeKey: `webhook_gap:${storeId}`,
      storeId,
      message:
        `Shopify did not notify us about ${missingWebhooks} stock changes in ${store.name}. They were ` +
        `caught by the regular stock check and synced, but other stores may have shown the old numbers ` +
        `for a few minutes. Webhook subscriptions are being re-checked.`,
      details: { missingWebhooks, checked },
    });
    await enqueueTask(db, 'ensure_webhooks', { storeId });
  } else if (missingWebhooks === 0) {
    await setAlert(db, {
      open: false,
      kind: 'webhook_gap',
      dedupeKey: `webhook_gap:${storeId}`,
      message: '',
    });
  }

  const result = { checked, drifted: drifted.length, missingWebhooks };
  if (drifted.length) logger.info({ storeId, ...result }, 'drift scan found differences');
  return result;
}

/**
 * The inventory levels of a store the engine keeps in sync: initialised pool levels of enabled
 * items, tracked non-bundle variants, active mapped locations, and no write in flight (the engine
 * settles those itself).
 */
async function loadSyncedLevels(
  db: Db,
  storeId: number,
  poolLevelIds?: number[],
): Promise<SyncedLevel[]> {
  const { rows } = await db.query<SyncedLevel>(
    `SELECT pl.id AS pool_level_id, v.inventory_item_id, sl.shopify_location_id AS location_id,
            pl.quantity, s.safety_buffer,
            CASE WHEN lvl.inventory_item_id = v.inventory_item_id
                  AND lvl.location_id = sl.shopify_location_id THEN lvl.baseline END AS baseline,
            lvl.updated_at AS baseline_updated_at,
            EXISTS (SELECT 1 FROM sync_queue q WHERE q.pool_level_id = pl.id) AS queued
       FROM stores s
       JOIN variants v ON v.store_id = s.id AND v.item_id IS NOT NULL AND v.deleted_at IS NULL
                      AND v.tracked AND NOT v.is_bundle
       JOIN items i ON i.id = v.item_id AND i.sync_enabled
       JOIN store_locations sl ON sl.store_id = s.id AND sl.is_active AND sl.warehouse_id IS NOT NULL
       JOIN pool_levels pl ON pl.item_id = v.item_id AND pl.warehouse_id = sl.warehouse_id
                          AND pl.quantity IS NOT NULL
       LEFT JOIN store_levels lvl ON lvl.pool_level_id = pl.id AND lvl.store_id = s.id
      WHERE s.id = $1 AND s.status = 'active'
        AND ($2::bigint[] IS NULL OR pl.id = ANY($2::bigint[]))
        AND NOT EXISTS (SELECT 1 FROM pending_writes pw
                         WHERE pw.pool_level_id = pl.id AND pw.store_id = s.id)
      ORDER BY pl.id`,
    [storeId, poolLevelIds ?? null],
  );
  return rows;
}

/** Live "available" per level, one batched read per location. Not stocked = null. */
async function readLive(
  shopify: ShopifyRegistry,
  storeId: number,
  levels: SyncedLevel[],
): Promise<Map<string, number | null>> {
  const byLocation = new Map<string, string[]>();
  for (const l of levels) {
    const ids = byLocation.get(l.location_id) ?? [];
    ids.push(l.inventory_item_id);
    byLocation.set(l.location_id, ids);
  }
  const live = new Map<string, number | null>();
  if (byLocation.size === 0) return live;
  const admin = await shopify.forStore(storeId);
  for (const [locationId, ids] of byLocation) {
    const values = await admin.readAvailable(locationId, ids);
    for (const id of ids) live.set(`${id}|${locationId}`, values.get(id) ?? null);
  }
  return live;
}

/** Mirrors the engine: a store below zero when it should show 0 is left alone, not rewritten. */
function showsExpected(value: number | null, shows: number): boolean {
  return value === shows || (shows === 0 && value !== null && value < 0);
}

function levelKey(level: SyncedLevel): string {
  return `${level.inventory_item_id}|${level.location_id}`;
}
