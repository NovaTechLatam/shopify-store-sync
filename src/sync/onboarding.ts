import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { updateSettings } from '../settings.js';
import type { ShopifyRegistry } from './engine.js';
import { displayQuantity } from './engine.js';
import { enqueuePoolLevels } from './queue.js';

/**
 * The merchant's first sync. Until a pool level is initialised the engine never writes to Shopify;
 * initialising picks the shared starting quantity from the stores' current numbers. The preview
 * is a dry run of exactly what the engine will do, so the merchant sees every overwrite first.
 */

export type InitStrategy = 'store' | 'min' | 'max' | 'sum';

export interface PreviewRow {
  poolLevelId: number;
  itemId: number;
  sku: string;
  title: string;
  warehouseId: number;
  /** `live` null = the item is not stocked at the store's synced location. */
  stores: { storeId: number; storeName: string; live: number | null }[];
  /** null = can't initialise (the source store doesn't sell this item); it is skipped. */
  proposed: number | null;
  /** Stores whose number will change when syncing starts. */
  changes: { storeId: number; from: number | null; to: number }[];
}

export interface PreviewResult {
  rows: PreviewRow[];
  summary: {
    items: number;
    itemsChanging: number;
    storesWrites: number;
    unitsAdded: number;
    unitsRemoved: number;
    zeroedInSomeStore: number;
    skipped: number;
  };
}

export interface OnboardingOptions {
  strategy: InitStrategy;
  /** Required for strategy 'store': the store whose numbers are copied. */
  sourceStoreId?: number;
  /** Limit to these pool levels (default: every uninitialised one). */
  poolLevelIds?: number[];
}

/** A request the merchant can correct; `statusCode` makes the HTTP layer answer 400 with it. */
export class OnboardingInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingInputError';
  }
}

/** A store couldn't be read for the preview; `statusCode` makes the HTTP layer answer 502. */
export class OnboardingStoreError extends Error {
  readonly statusCode = 502;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OnboardingStoreError';
  }
}

const OptionsSchema = z
  .object({
    strategy: z.enum(['store', 'min', 'max', 'sum']),
    sourceStoreId: z.number().int().positive().optional(),
    poolLevelIds: z.array(z.number().int().positive()).optional(),
  })
  .refine((o) => o.strategy !== 'store' || o.sourceStoreId !== undefined, {
    message: 'Choose the store whose numbers should be copied',
    path: ['sourceStoreId'],
  });

/** Uninitialised levels of enabled items that aren't already waiting for an initialisation. */
const IN_SCOPE = `
  pl.quantity IS NULL AND i.sync_enabled
  AND ($1::bigint[] IS NULL OR pl.id = ANY($1::bigint[]))
  AND NOT EXISTS (SELECT 1 FROM pool_adjustments a
                   WHERE a.pool_level_id = pl.id AND a.kind = 'initialize' AND a.applied_at IS NULL)`;

interface MemberRow {
  pool_level_id: number;
  item_id: number;
  sku: string;
  title: string;
  warehouse_id: number;
  store_id: number;
  store_name: string;
  safety_buffer: number;
  inventory_item_id: string;
  location_id: string;
}

export async function previewOnboarding(
  deps: { db: Db; shopify: ShopifyRegistry; logger: Logger },
  options: OnboardingOptions,
): Promise<PreviewResult> {
  const opts = await validate(deps.db, options);
  // Same members as the engine: active store, tracked non-bundle variant, active mapped location.
  const { rows: members } = await deps.db.query<MemberRow>(
    `SELECT pl.id AS pool_level_id, pl.item_id, i.sku, i.title, pl.warehouse_id,
            s.id AS store_id, s.name AS store_name, s.safety_buffer, v.inventory_item_id,
            sl.shopify_location_id AS location_id
       FROM pool_levels pl
       JOIN items i ON i.id = pl.item_id
       JOIN variants v ON v.item_id = pl.item_id AND v.deleted_at IS NULL AND v.tracked AND NOT v.is_bundle
       JOIN stores s ON s.id = v.store_id AND s.status = 'active'
       JOIN store_locations sl ON sl.store_id = s.id AND sl.warehouse_id = pl.warehouse_id AND sl.is_active
      WHERE ${IN_SCOPE}
      ORDER BY i.sku, pl.warehouse_id, s.id`,
    [opts.poolLevelIds ?? null],
  );
  const live = await readLive(deps.shopify, members);

  const rows: PreviewRow[] = [];
  for (const m of members) {
    let row = rows.at(-1);
    if (row?.poolLevelId !== m.pool_level_id) {
      row = {
        poolLevelId: m.pool_level_id,
        itemId: m.item_id,
        sku: m.sku,
        title: m.title,
        warehouseId: m.warehouse_id,
        stores: [],
        proposed: null,
        changes: [],
      };
      rows.push(row);
    }
    row.stores.push({
      storeId: m.store_id,
      storeName: m.store_name,
      live: live.get(liveKey(m.store_id, m.location_id, m.inventory_item_id)) ?? null,
    });
  }
  const buffers = new Map(members.map((m) => [m.store_id, m.safety_buffer]));
  for (const row of rows) {
    row.proposed = proposedQuantity(opts, row.stores);
    if (row.proposed === null) continue;
    for (const s of row.stores) {
      const to = displayQuantity(row.proposed, buffers.get(s.storeId)!);
      // Mirrors the engine's writes; a store below zero that should show 0 is left alone.
      if (s.live === to || (to === 0 && s.live !== null && s.live < 0)) continue;
      row.changes.push({ storeId: s.storeId, from: s.live, to });
    }
  }
  return { rows, summary: summarize(rows) };
}

/**
 * Queues the initialisation of every level in scope (the engine applies it on its next reconcile,
 * reading the stores' numbers at that moment) and marks onboarding as done. With strategy 'store',
 * levels the source store doesn't sell are left uninitialised, as the preview shows.
 */
export async function applyOnboarding(
  db: Db,
  options: OnboardingOptions,
): Promise<{ queued: number }> {
  const opts = await validate(db, options);
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ pool_level_id: number }>(
      `INSERT INTO pool_adjustments (pool_level_id, kind, strategy, source_store_id)
       SELECT pl.id, 'initialize', $2, $3
         FROM pool_levels pl JOIN items i ON i.id = pl.item_id
        WHERE ${IN_SCOPE}
          AND EXISTS (SELECT 1 FROM variants v
                        JOIN stores s ON s.id = v.store_id AND s.status = 'active'
                        JOIN store_locations sl ON sl.store_id = s.id
                                               AND sl.warehouse_id = pl.warehouse_id AND sl.is_active
                       WHERE v.item_id = pl.item_id AND v.deleted_at IS NULL AND v.tracked
                         AND NOT v.is_bundle AND ($3::bigint IS NULL OR s.id = $3::bigint))
       RETURNING pool_level_id`,
      [opts.poolLevelIds ?? null, opts.strategy, opts.sourceStoreId ?? null],
    );
    const ids = rows.map((r) => r.pool_level_id);
    await enqueuePoolLevels(client, ids, 'onboarding');
    await updateSettings(client, { onboardingCompleted: true });
    return { queued: ids.length };
  });
}

async function validate(db: Queryable, options: OnboardingOptions): Promise<OnboardingOptions> {
  const opts = OptionsSchema.parse(options);
  if (opts.strategy !== 'store') return { ...opts, sourceStoreId: undefined };
  const { rows } = await db.query<{ name: string; status: string }>(
    'SELECT name, status FROM stores WHERE id = $1',
    [opts.sourceStoreId],
  );
  const store = rows[0];
  if (!store) throw new OnboardingInputError('The chosen source store does not exist');
  if (store.status !== 'active') {
    throw new OnboardingInputError(
      `${store.name} is ${store.status}, so its numbers can't be copied. Choose an active store.`,
    );
  }
  return opts;
}

/** One batched read per (store, location). Fails as a whole: a partial preview would mislead. */
async function readLive(
  shopify: ShopifyRegistry,
  members: MemberRow[],
): Promise<Map<string, number | null>> {
  const groups = new Map<
    string,
    { storeId: number; storeName: string; locationId: string; ids: string[] }
  >();
  for (const m of members) {
    const key = `${m.store_id}|${m.location_id}`;
    let group = groups.get(key);
    if (!group) {
      group = { storeId: m.store_id, storeName: m.store_name, locationId: m.location_id, ids: [] };
      groups.set(key, group);
    }
    group.ids.push(m.inventory_item_id);
  }
  const live = new Map<string, number | null>();
  await Promise.all(
    [...groups.values()].map(async (g) => {
      let values: Map<string, number | null>;
      try {
        const admin = await shopify.forStore(g.storeId);
        values = await admin.readAvailable(g.locationId, g.ids);
      } catch (err) {
        throw new OnboardingStoreError(
          `Could not read the current stock of ${g.storeName}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      for (const id of g.ids)
        live.set(liveKey(g.storeId, g.locationId, id), values.get(id) ?? null);
    }),
  );
  return live;
}

/**
 * The starting quantity the engine will choose. A store that doesn't stock the item at its synced
 * location yet is stocked there at 0 when syncing starts, so it counts as 0.
 */
function proposedQuantity(opts: OnboardingOptions, stores: PreviewRow['stores']): number | null {
  const values = stores.map((s) => s.live ?? 0);
  switch (opts.strategy) {
    case 'store': {
      const source = stores.find((s) => s.storeId === opts.sourceStoreId);
      return source ? (source.live ?? 0) : null;
    }
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
  }
}

function summarize(rows: PreviewRow[]): PreviewResult['summary'] {
  const items = new Set<number>();
  const changing = new Set<number>();
  const zeroed = new Set<number>();
  const skipped = new Set<number>();
  let storesWrites = 0;
  let unitsAdded = 0;
  let unitsRemoved = 0;
  for (const row of rows) {
    items.add(row.itemId);
    if (row.proposed === null) skipped.add(row.itemId);
    if (row.changes.length) changing.add(row.itemId);
    for (const c of row.changes) {
      storesWrites++;
      const delta = c.to - (c.from ?? 0);
      if (delta > 0) unitsAdded += delta;
      else unitsRemoved -= delta;
      if (c.to === 0 && (c.from ?? 0) > 0) zeroed.add(row.itemId);
    }
  }
  return {
    items: items.size,
    itemsChanging: changing.size,
    storesWrites,
    unitsAdded,
    unitsRemoved,
    zeroedInSomeStore: zeroed.size,
    skipped: skipped.size,
  };
}

function liveKey(storeId: number, locationId: string, inventoryItemId: string): string {
  return `${storeId}|${locationId}|${inventoryItemId}`;
}
