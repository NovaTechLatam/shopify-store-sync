import pg from 'pg';
import type { Logger } from 'pino';
import { LOCKS } from '../db/locks.js';
import type { Db, DbClient, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { setAlert } from '../alerts/alerts.js';
import { getSettings } from '../settings.js';
import type { ShopifyVariant } from '../shopify/types.js';
import type { ShopifyRegistry } from '../sync/engine.js';
import { enqueuePoolLevels } from '../sync/queue.js';
import { normalizeSku } from './sku.js';

/**
 * CATALOG & SKU MATCHING
 *
 * `variants` mirrors every variant of every store. Variants are linked to items by SKU: within a
 * store a SKU must identify exactly one variant, which is linked to the item with that SKU
 * (created on first sight). A SKU used by several variants of one store is ambiguous, so none of
 * them is synced until the merchant fixes it in Shopify. Links set in the dashboard ('manual')
 * are never changed by matching.
 *
 * Anything that changes which stores sell an item (links, tracked/bundle flags, deletions,
 * location mapping) enqueues the item's pool levels; the engine reads everything live, so extra
 * triggers are harmless.
 *
 * Concurrency: every catalog writer holds one transaction-level advisory lock. Shopify is always
 * read before the transaction starts, so the lock is held only for quick set-based SQL, and two
 * stores that share SKUs can't interleave their link updates.
 *
 * Staleness: a variant row remembers when we last learned something about it (`seen_at`, or
 * `deleted_at` for a deletion). An upsert from an older Shopify read never overwrites newer
 * knowledge, so a slow full catalog read can't resurrect a variant deleted (by webhook) meanwhile.
 */

export interface CatalogDeps {
  db: Db;
  shopify: ShopifyRegistry;
  logger: Logger;
}

export interface CatalogSyncSummary {
  /** Active locations seen. */
  locations: number;
  /** Variants seen. */
  variants: number;
  /** Variants new to us. */
  added: number;
  /** Variants marked deleted. */
  removed: number;
  /** Variants (in any store) whose automatic link changed to an item. */
  linked: number;
  /** Variants (in any store) whose automatic link changed to none. */
  unlinked: number;
  /** SKUs duplicated within this store (not synced). */
  conflicts: number;
}

/** A dashboard request that can't be applied; `code` lets the API pick the HTTP status. */
export class CatalogError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'not_found' | 'conflict',
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

const CATALOG_LOCK_ID = LOCKS.catalog;
/** Variants per upsert statement: bounds statement size for very large catalogs. */
const UPSERT_CHUNK = 5_000;

/** SKUs whose matching may have changed, and items whose members changed without a relink. */
interface Touched {
  skus: (string | null)[];
  itemIds: (number | null)[];
}

interface RelinkResult {
  affectedItemIds: number[];
  linked: number;
  unlinked: number;
}

/** Full re-read of a store: locations, then all variants; then relink; update stores.catalog_synced_at. */
export async function syncStoreCatalog(
  deps: CatalogDeps,
  storeId: number,
): Promise<CatalogSyncSummary> {
  assertId(storeId, 'store id');
  const startedMs = Date.now();
  const locations = await syncStoreLocations(deps, storeId);
  const seenAt = await dbClock(deps.db);
  const listed = uniqueVariants(await (await deps.shopify.forStore(storeId)).listVariants());

  const summary = await withCatalogLock(deps.db, async (client) => {
    // Lock the store row before any sync_queue row (same order as webhook intake: no deadlock).
    const store = await client.query<{ was_pending: boolean }>(
      `UPDATE stores s SET catalog_synced_at = now(), catalog_pending = false
         FROM (SELECT catalog_pending FROM stores WHERE id = $1) prev
        WHERE s.id = $1
       RETURNING prev.catalog_pending AS was_pending`,
      [storeId],
    );
    const saved = await upsertVariants(client, storeId, listed, seenAt);
    // Anything our read didn't see (and nobody learned about since it started) is gone.
    const removed = await client.query<{ sku: string | null; item_id: number | null }>(
      `UPDATE variants SET deleted_at = now(), updated_at = now()
        WHERE store_id = $1 AND deleted_at IS NULL AND seen_at < $2
        RETURNING sku, item_id`,
      [storeId, seenAt],
    );
    const links = await settle(client, {
      skus: [...saved.touched.skus, ...removed.rows.map((r) => r.sku)],
      itemIds: [...saved.touched.itemIds, ...removed.rows.map((r) => r.item_id)],
    });
    const conflicts = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT sku FROM variants
          WHERE store_id = $1 AND sku IS NOT NULL AND deleted_at IS NULL AND NOT is_bundle
          GROUP BY sku HAVING count(*) > 1) duplicated`,
      [storeId],
    );
    // A store that was waiting for this read starts syncing now, with an up-to-date catalog.
    if (store.rows[0]?.was_pending) {
      const { rows } = await client.query<{ id: number }>(
        `SELECT DISTINCT pl.id FROM variants v
           JOIN store_locations sl ON sl.store_id = v.store_id AND sl.warehouse_id IS NOT NULL
           JOIN pool_levels pl ON pl.item_id = v.item_id AND pl.warehouse_id = sl.warehouse_id
          WHERE v.store_id = $1 AND v.item_id IS NOT NULL AND v.deleted_at IS NULL`,
        [storeId],
      );
      await enqueuePoolLevels(
        client,
        rows.map((r) => r.id),
        'store_catalog_ready',
      );
    }
    return {
      locations,
      variants: listed.length,
      added: saved.added,
      removed: removed.rowCount ?? 0,
      linked: links.linked,
      unlinked: links.unlinked,
      conflicts: conflicts.rows[0]!.n,
    };
  });
  deps.logger.info({ storeId, ...summary, ms: Date.now() - startedMs }, 'catalog synced');
  return summary;
}

/** Upserts store_locations from listLocations(); auto-maps (see rules); returns active count. */
export async function syncStoreLocations(deps: CatalogDeps, storeId: number): Promise<number> {
  assertId(storeId, 'store id');
  const admin = await deps.shopify.forStore(storeId);
  const listed = [...new Map((await admin.listLocations()).map((l) => [l.id, l])).values()];
  const ids = listed.map((l) => l.id);

  return withCatalogLock(deps.db, async (client) => {
    const before = await storeLocations(client, storeId);
    await client.query(
      `INSERT INTO store_locations (store_id, shopify_location_id, name, is_active)
       SELECT $1::bigint, t.id, t.name, t.is_active
         FROM unnest($2::text[], $3::text[], $4::boolean[]) AS t(id, name, is_active)
       ON CONFLICT (store_id, shopify_location_id) DO UPDATE
         SET name = EXCLUDED.name, is_active = EXCLUDED.is_active`,
      [storeId, ids, listed.map((l) => l.name), listed.map((l) => l.isActive)],
    );
    await client.query(
      `UPDATE store_locations SET is_active = false
        WHERE store_id = $1 AND is_active AND shopify_location_id <> ALL($2::text[])`,
      [storeId, ids],
    );
    let after = await storeLocations(client, storeId);

    const active = after.filter((l) => l.is_active);
    if (active.length === 1 && after.every((l) => l.warehouse_id === null)) {
      const { rowCount } = await client.query(
        `UPDATE store_locations SET warehouse_id = (SELECT min(id) FROM warehouses)
          WHERE id = $1 AND EXISTS (SELECT 1 FROM warehouses)`,
        [active[0]!.id],
      );
      if (rowCount) after = await storeLocations(client, storeId);
    }

    // The store joins or leaves the pool of every warehouse whose synced location changed.
    const was = syncedWarehouses(before);
    const now = syncedWarehouses(after);
    const changed = [...was, ...now].filter((w) => was.has(w) !== now.has(w));
    if (changed.length) {
      const { rows } = await client.query<{ id: number }>(
        `SELECT DISTINCT pl.id FROM pool_levels pl
           JOIN variants v ON v.item_id = pl.item_id
          WHERE v.store_id = $1 AND v.deleted_at IS NULL AND pl.warehouse_id = ANY($2::bigint[])`,
        [storeId, changed],
      );
      await enqueuePoolLevels(
        client,
        rows.map((r) => r.id),
        'catalog',
      );
    }

    const { rows } = await client.query<{ name: string }>('SELECT name FROM stores WHERE id = $1', [
      storeId,
    ]);
    await setAlert(client, {
      open: now.size === 0,
      kind: 'store_unmapped',
      dedupeKey: `store_unmapped:${storeId}`,
      storeId,
      message: `Choose which location of ${rows[0]?.name ?? `store ${storeId}`} holds the shared stock.`,
    });
    return listed.filter((l) => l.isActive).length;
  });
}

/** Webhook-driven: re-read the variants of one inventory item and relink the affected SKUs. */
export async function refreshInventoryItem(
  deps: CatalogDeps,
  storeId: number,
  inventoryItemId: string,
): Promise<void> {
  assertId(storeId, 'store id');
  assertGid(inventoryItemId, 'InventoryItem');
  const seenAt = await dbClock(deps.db);
  const admin = await deps.shopify.forStore(storeId);
  const listed = uniqueVariants(await admin.listVariantsByInventoryItem(inventoryItemId));
  if (listed.length === 0) {
    await removeInventoryItem(deps.db, storeId, inventoryItemId);
    return;
  }
  await withCatalogLock(deps.db, async (client) => {
    // Other variant rows claiming this inventory item are marked deleted by the upsert.
    const saved = await upsertVariants(client, storeId, listed, seenAt);
    await settle(client, saved.touched);
  });
  deps.logger.debug({ storeId, inventoryItemId }, 'inventory item refreshed');
}

/** Webhook-driven: an inventory item was deleted in Shopify. DB-only. */
export async function removeInventoryItem(
  db: Db,
  storeId: number,
  inventoryItemId: string,
): Promise<void> {
  assertId(storeId, 'store id');
  assertGid(inventoryItemId, 'InventoryItem');
  await withCatalogLock(db, async (client) => {
    const { rows } = await client.query<{ sku: string | null; item_id: number | null }>(
      `UPDATE variants SET deleted_at = now(), updated_at = now()
        WHERE store_id = $1 AND inventory_item_id = $2 AND deleted_at IS NULL
        RETURNING sku, item_id`,
      [storeId, inventoryItemId],
    );
    await settle(client, { skus: rows.map((r) => r.sku), itemIds: rows.map((r) => r.item_id) });
  });
}

/** Webhook-driven: a product was deleted in Shopify. DB-only. */
export async function removeProduct(db: Db, storeId: number, productId: string): Promise<void> {
  assertId(storeId, 'store id');
  assertGid(productId, 'Product');
  await withCatalogLock(db, async (client) => {
    const { rows } = await client.query<{ sku: string | null; item_id: number | null }>(
      `UPDATE variants SET deleted_at = now(), updated_at = now()
        WHERE store_id = $1 AND shopify_product_id = $2 AND deleted_at IS NULL
        RETURNING sku, item_id`,
      [storeId, productId],
    );
    await settle(client, { skus: rows.map((r) => r.sku), itemIds: rows.map((r) => r.item_id) });
  });
}

/**
 * Recomputes automatic SKU links (only for the given normalized SKUs, or all when omitted), creates
 * missing items and pool levels, auto-initialises new pool levels when the settings say so, and
 * enqueues every pool level whose membership changed. Returns affected item ids.
 *
 * Given a pool it runs in its own transaction; given a client, the caller's transaction holds
 * the catalog lock until it commits.
 */
export async function relink(
  db: Queryable,
  opts: { skus?: string[] } = {},
): Promise<{ affectedItemIds: number[] }> {
  if (db instanceof pg.Pool) return withCatalogLock(db, (client) => relink(client, opts));
  await lockCatalog(db);
  const { affectedItemIds } = await relinkSkus(db, opts.skus);
  return { affectedItemIds };
}

/** Dashboard: link a variant to an item manually (itemId null = "never sync this variant"). */
export async function setManualLink(
  db: Db,
  variantId: number,
  itemId: number | null,
): Promise<void> {
  assertId(variantId, 'variant id');
  if (itemId !== null) assertId(itemId, 'item id');
  await withCatalogLock(db, async (client) => {
    const variant = await liveVariant(client, variantId);
    if (itemId !== null) {
      const { rows } = await client.query<{ sku: string }>('SELECT sku FROM items WHERE id = $1', [
        itemId,
      ]);
      const item = rows[0];
      if (!item) throw new CatalogError(`Item ${itemId} not found`, 'not_found');
      const taken = await client.query<{ store_name: string; title: string }>(
        `SELECT s.name AS store_name, concat_ws(' - ', v.product_title, v.variant_title) AS title
           FROM variants v JOIN stores s ON s.id = v.store_id
          WHERE v.store_id = $1 AND v.item_id = $2 AND v.deleted_at IS NULL AND v.id <> $3
          LIMIT 1`,
        [variant.store_id, itemId, variantId],
      );
      const other = taken.rows[0];
      if (other) {
        throw new CatalogError(
          `${other.store_name} already syncs "${other.title}" as ${item.sku}. ` +
            'Unlink that variant first.',
          'conflict',
        );
      }
      await ensurePoolLevels(client, [itemId]);
    }
    await client.query(
      `UPDATE variants SET item_id = $2, link_source = 'manual', updated_at = now() WHERE id = $1`,
      [variantId, itemId],
    );
    // Freeing the old item's slot in this store can let an automatic variant take it.
    await relinkSkus(client, [variant.item_sku]);
    await enqueueItems(client, [variant.item_id, itemId]);
  });
}

/** Dashboard: go back to automatic SKU matching for this variant. */
export async function resetToAutoLink(db: Db, variantId: number): Promise<void> {
  assertId(variantId, 'variant id');
  await withCatalogLock(db, async (client) => {
    const variant = await findVariant(client, variantId);
    await client.query(
      `UPDATE variants SET link_source = 'auto', updated_at = now() WHERE id = $1`,
      [variantId],
    );
    await relinkSkus(client, [variant.sku, variant.item_sku]);
  });
}

/** Creates (or returns) the item for a SKU, plus its pool levels for every warehouse. */
export async function ensureItem(db: Queryable, sku: string, title?: string): Promise<number> {
  const normalized = normalizeSku(sku);
  if (!normalized) throw new CatalogError('A SKU is required', 'invalid');
  const inserted = await db.query<{ id: number }>(
    'INSERT INTO items (sku, title) VALUES ($1, $2) ON CONFLICT (sku) DO NOTHING RETURNING id',
    [normalized, title?.trim() ?? ''],
  );
  const id =
    inserted.rows[0]?.id ??
    (await db.query<{ id: number }>('SELECT id FROM items WHERE sku = $1', [normalized])).rows[0]!
      .id;
  await ensurePoolLevels(db, [id]);
  return id;
}

export interface EnsuredItem {
  itemId: number;
  /** Created by this call: no store sells it yet, and its stock hasn't started (quantity NULL). */
  created: boolean;
}

/**
 * Creates the items of SKUs that don't exist yet, with their pool levels, for features that make
 * products or order stock before any store sells them (catalog, purchase orders). Holds the
 * catalog lock for the caller's transaction, so catalog matching can't create the same items at
 * the same time (it would auto-initialise them from the stores' numbers).
 *
 * Items created here are not initialised: the caller decides how they start (an `initialize`
 * adjustment with strategy 'value', for instance). Existing items are returned unchanged. SKUs
 * are normalised; the map is keyed by the normalised SKU. A SKU that normalises to nothing is a
 * CatalogError ('invalid').
 */
export async function ensureItemsLocked(
  client: DbClient,
  skus: { sku: string; title: string }[],
): Promise<Map<string, EnsuredItem>> {
  const titles = new Map<string, string>();
  for (const { sku, title } of skus) {
    const normalized = normalizeSku(sku);
    if (!normalized) throw new CatalogError('A SKU is required', 'invalid');
    if (!titles.has(normalized)) titles.set(normalized, title.trim());
  }
  const result = new Map<string, EnsuredItem>();
  if (titles.size === 0) return result;
  await lockCatalog(client);
  const wanted = [...titles.keys()];
  const inserted = await client.query<{ id: number; sku: string }>(
    `INSERT INTO items (sku, title)
     SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (sku) DO NOTHING
     RETURNING id, sku`,
    [wanted, [...titles.values()]],
  );
  const created = new Set(inserted.rows.map((r) => r.sku));
  const { rows } = await client.query<{ id: number; sku: string }>(
    'SELECT id, sku FROM items WHERE sku = ANY($1::text[])',
    [wanted],
  );
  for (const row of rows) result.set(row.sku, { itemId: row.id, created: created.has(row.sku) });
  await ensurePoolLevels(
    client,
    rows.map((r) => r.id),
  );
  // Matching links a store's variant as soon as the SKU's item exists. Relinking the new SKUs
  // keeps that true if some store already has a variant with one of them (usually a no-op).
  if (created.size) await relinkSkus(client, [...created]);
  return result;
}

/** The note of a start at 0 (the activity log says "Started syncing at 0 (new product)"). */
const NEW_PRODUCT_START_NOTE = 'new product';

/**
 * Starts a product no store sells yet at 0: an `initialize` (strategy 'value', 0) for pool levels
 * that haven't started and have no start pending. The engine applies it when a store first sells
 * the item, so a new product goes on sale with exactly what was received for it.
 *
 * - A catalog product first published to a store (`itemIds` and `storeId`, before the write): the
 *   levels of the warehouses that store stocks (its active mapped locations) that no store sells
 *   the item in yet. A warehouse no store uses yet waits for the merchant's start, like for any
 *   other product, instead of replacing the stock of the first location mapped to it months later.
 * - A delivery for a product no store sells (`poolLevelIds`): those levels, if the item has no
 *   live variant in any store.
 *
 * An item a store already sells there is left to the usual start (onboarding, "Start syncing"),
 * so the store's real number is never replaced with 0. The caller holds the catalog lock
 * (lockCatalog), so a store linking the item at this moment can't slip in between. Returns the
 * adjustments created. A start a publish no longer needs is taken back by dropNewProductStarts.
 */
export async function startUnsoldAtZero(
  client: Queryable,
  levels: { itemIds: number[]; storeId: number } | { poolLevelIds: number[] },
): Promise<number[]> {
  const byItem = 'itemIds' in levels;
  const ids = byItem ? levels.itemIds : levels.poolLevelIds;
  if (ids.length === 0) return [];
  const { rows } = await client.query<{ id: number }>(
    byItem
      ? `INSERT INTO pool_adjustments (pool_level_id, kind, strategy, value, note)
         SELECT pl.id, 'initialize', 'value', 0, $2 FROM pool_levels pl
          WHERE pl.item_id = ANY($1::bigint[]) AND pl.quantity IS NULL
            AND pl.warehouse_id IN (SELECT warehouse_id FROM store_locations
                                     WHERE store_id = $3 AND is_active AND warehouse_id IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM pool_adjustments a
                             WHERE a.pool_level_id = pl.id AND a.kind = 'initialize'
                               AND a.applied_at IS NULL)
            AND NOT EXISTS (${LEVEL_SOLD})
          ORDER BY pl.id
         RETURNING id`
      : `INSERT INTO pool_adjustments (pool_level_id, kind, strategy, value, note)
         SELECT pl.id, 'initialize', 'value', 0, $2 FROM pool_levels pl
          WHERE pl.id = ANY($1::bigint[]) AND pl.quantity IS NULL
            AND NOT EXISTS (SELECT 1 FROM pool_adjustments a
                             WHERE a.pool_level_id = pl.id AND a.kind = 'initialize'
                               AND a.applied_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM variants v
                             WHERE v.item_id = pl.item_id AND v.deleted_at IS NULL)
          ORDER BY pl.id
         RETURNING id`,
    byItem ? [ids, NEW_PRODUCT_START_NOTE, levels.storeId] : [ids, NEW_PRODUCT_START_NOTE],
  );
  return rows.map((r) => r.id);
}

/** SQL: a live variant of level `pl`'s item in a store that stocks `pl`'s warehouse. */
const LEVEL_SOLD = `SELECT 1 FROM variants v
                     JOIN store_locations sl ON sl.store_id = v.store_id AND sl.is_active
                                            AND sl.warehouse_id = pl.warehouse_id
                    WHERE v.item_id = pl.item_id AND v.deleted_at IS NULL`;

/**
 * Takes back starts at 0 nothing needs any more, for `itemIds`: after a publish that failed for
 * good, a brand switched off before its publish ran, or a catalog product deleted. Left there, a
 * start would replace the stock of a SKU the merchant later creates by hand in a store (7 on the
 * shelf) with 0. A start stays while a store sells the item in its warehouse, while any brand of
 * the item's catalog product is waiting to publish or publishing (it may be counting on it), and
 * while a delivery is waiting to be added to it (purchasing's own start). Each caller records its
 * brand's outcome first, so the last one to finish sees every other brand's. Takes the catalog
 * lock (pass a client in a transaction).
 */
export async function dropNewProductStarts(client: Queryable, itemIds: number[]): Promise<number> {
  if (itemIds.length === 0) return 0;
  await lockCatalog(client);
  const { rowCount } = await client.query(
    `DELETE FROM pool_adjustments a USING pool_levels pl
      WHERE a.pool_level_id = pl.id AND pl.item_id = ANY($1::bigint[])
        AND a.kind = 'initialize' AND a.applied_at IS NULL AND a.note = $2
        AND NOT EXISTS (${LEVEL_SOLD})
        AND NOT EXISTS (SELECT 1 FROM pool_adjustments x
                         WHERE x.pool_level_id = pl.id AND x.kind = 'adjust' AND x.applied_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM master_variants mv
                          JOIN master_product_stores mps ON mps.master_product_id = mv.master_product_id
                         WHERE mv.item_id = pl.item_id AND mps.publish_state IN ('queued', 'publishing'))`,
    [itemIds, NEW_PRODUCT_START_NOTE],
  );
  return rowCount ?? 0;
}

// ---- variants ---------------------------------------------------------------------------------

/**
 * Upserts variants read from Shopify at `seenAt`. Rows we learned something newer about are left
 * alone. A deleted variant that reappears starts unlinked: an automatic link is recomputed by the
 * relink that follows, and a manual one becomes "never sync" (its item may have been given to
 * another variant meanwhile) until the merchant links it again.
 */
async function upsertVariants(
  client: DbClient,
  storeId: number,
  variants: ShopifyVariant[],
  seenAt: Date,
): Promise<{ added: number; touched: Touched }> {
  const touched: Touched = { skus: [], itemIds: [] };
  let added = 0;
  for (let i = 0; i < variants.length; i += UPSERT_CHUNK) {
    const chunk = variants.slice(i, i + UPSERT_CHUNK);
    const variantIds = chunk.map((v) => v.variantId);
    const inventoryItemIds = chunk.map((v) => v.inventoryItemId);

    // An inventory item belongs to one variant; a row still claiming it for another variant is
    // gone (and would block the upsert on the variants_store_inventory_item index).
    const displaced = await client.query<{ sku: string | null; item_id: number | null }>(
      `UPDATE variants v SET deleted_at = now(), updated_at = now()
         FROM unnest($2::text[], $3::text[]) AS t(variant_id, inventory_item_id)
        WHERE v.store_id = $1 AND v.deleted_at IS NULL
          AND v.inventory_item_id = t.inventory_item_id AND v.shopify_variant_id <> t.variant_id
        RETURNING v.sku, v.item_id`,
      [storeId, variantIds, inventoryItemIds],
    );
    for (const r of displaced.rows) {
      touched.skus.push(r.sku);
      touched.itemIds.push(r.item_id);
    }

    // `prior` reads the rows as they were before this statement (same snapshot as the upsert).
    const { rows } = await client.query<{
      inserted: boolean;
      sku: string | null;
      old_sku: string | null;
      member_changed_item_id: number | null;
    }>(
      `WITH input AS (
         SELECT * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                              $7::text[], $8::text[], $9::boolean[], $10::boolean[],
                              $12::numeric[], $13::numeric[])
           AS t(variant_id, product_id, inventory_item_id, sku, barcode, product_title,
                variant_title, tracked, is_bundle, price, compare_at_price)
       ),
       prior AS (
         SELECT v.id, v.sku, v.item_id, v.tracked, v.is_bundle, v.inventory_item_id, v.deleted_at
           FROM variants v JOIN input i ON i.variant_id = v.shopify_variant_id
          WHERE v.store_id = $1
       ),
       saved AS (
         INSERT INTO variants AS v
           (store_id, shopify_variant_id, shopify_product_id, inventory_item_id, sku, barcode,
            product_title, variant_title, tracked, is_bundle, price, compare_at_price, seen_at)
         SELECT $1::bigint, i.variant_id, i.product_id, i.inventory_item_id, i.sku, i.barcode,
                i.product_title, i.variant_title, i.tracked, i.is_bundle, i.price,
                i.compare_at_price, $11::timestamptz
           FROM input i
         ON CONFLICT (store_id, shopify_variant_id) DO UPDATE
           SET shopify_product_id = EXCLUDED.shopify_product_id,
               inventory_item_id = EXCLUDED.inventory_item_id,
               sku = EXCLUDED.sku,
               barcode = EXCLUDED.barcode,
               product_title = EXCLUDED.product_title,
               variant_title = EXCLUDED.variant_title,
               tracked = EXCLUDED.tracked,
               is_bundle = EXCLUDED.is_bundle,
               price = EXCLUDED.price,
               compare_at_price = EXCLUDED.compare_at_price,
               item_id = CASE WHEN v.deleted_at IS NULL THEN v.item_id END,
               seen_at = EXCLUDED.seen_at,
               deleted_at = NULL,
               updated_at = now()
           WHERE GREATEST(v.seen_at, v.deleted_at) <= EXCLUDED.seen_at
         RETURNING v.id, v.sku, v.tracked, v.is_bundle, v.inventory_item_id
       )
       SELECT p.id IS NULL AS inserted, s.sku, p.sku AS old_sku,
              CASE WHEN p.deleted_at IS NULL
                         AND (p.tracked <> s.tracked OR p.is_bundle <> s.is_bundle
                              OR p.inventory_item_id <> s.inventory_item_id)
                   THEN p.item_id END AS member_changed_item_id
         FROM saved s LEFT JOIN prior p ON p.id = s.id`,
      [
        storeId,
        variantIds,
        chunk.map((v) => v.productId),
        inventoryItemIds,
        chunk.map((v) => normalizeSku(v.sku)),
        chunk.map((v) => v.barcode),
        chunk.map((v) => v.productTitle),
        chunk.map((v) => v.variantTitle),
        chunk.map((v) => v.tracked),
        chunk.map((v) => v.isBundle),
        seenAt,
        // What the store charges now (its currency); prices don't affect stock syncing.
        chunk.map((v) => v.price),
        chunk.map((v) => v.compareAtPrice),
      ],
    );
    for (const r of rows) {
      if (r.inserted) added++;
      touched.skus.push(r.sku, r.old_sku);
      touched.itemIds.push(r.member_changed_item_id);
    }
  }
  return { added, touched };
}

/** Shopify never repeats a variant or inventory item, but one bad row must not wedge every sync. */
function uniqueVariants(variants: ShopifyVariant[]): ShopifyVariant[] {
  const byVariant = new Map(variants.map((v) => [v.variantId, v]));
  return [...new Map([...byVariant.values()].map((v) => [v.inventoryItemId, v])).values()];
}

async function findVariant(client: Queryable, variantId: number) {
  const { rows } = await client.query<{
    store_id: number;
    sku: string | null;
    item_id: number | null;
    item_sku: string | null;
    deleted: boolean;
  }>(
    `SELECT v.store_id, v.sku, v.item_id, i.sku AS item_sku, v.deleted_at IS NOT NULL AS deleted
       FROM variants v LEFT JOIN items i ON i.id = v.item_id
      WHERE v.id = $1`,
    [variantId],
  );
  const variant = rows[0];
  if (!variant) throw new CatalogError(`Variant ${variantId} not found`, 'not_found');
  return variant;
}

async function liveVariant(client: Queryable, variantId: number) {
  const variant = await findVariant(client, variantId);
  if (variant.deleted)
    throw new CatalogError(`Variant ${variantId} no longer exists in Shopify`, 'not_found');
  return variant;
}

// ---- matching ---------------------------------------------------------------------------------

/** Relinks the touched SKUs, and enqueues items whose members changed without a link change. */
async function settle(client: DbClient, touched: Touched): Promise<RelinkResult> {
  const result = await relinkSkus(client, touched.skus);
  const affected = new Set(result.affectedItemIds);
  await enqueueItems(
    client,
    touched.itemIds.filter((id) => id !== null && !affected.has(id)),
  );
  return result;
}

/** The relink algorithm (see `relink`). Caller holds the catalog lock. */
async function relinkSkus(
  client: Queryable,
  skus: (string | null)[] | undefined,
): Promise<RelinkResult> {
  const seed = skus === undefined ? await allLinkableSkus(client) : distinctSkus(skus);
  if (seed.length === 0) return { affectedItemIds: [], linked: 0, unlinked: 0 };
  const scope = await expandScope(client, seed);
  const created = await createMissingItems(client, scope);
  const changes = await planLinks(client, scope);

  // Unlink first, so the one-linked-variant-per-store-and-item index never sees two at once.
  const unlinks = changes.filter((c) => c.current_item_id !== null);
  if (unlinks.length) {
    await client.query(
      'UPDATE variants SET item_id = NULL, updated_at = now() WHERE id = ANY($1::bigint[])',
      [unlinks.map((c) => c.id)],
    );
  }
  const links = changes.filter((c) => c.item_id !== null);
  if (links.length) {
    await client.query(
      `UPDATE variants v SET item_id = t.item_id, updated_at = now()
         FROM unnest($1::bigint[], $2::bigint[]) AS t(id, item_id)
        WHERE v.id = t.id`,
      [links.map((c) => c.id), links.map((c) => c.item_id)],
    );
  }

  const affected = new Set(created);
  for (const c of changes) {
    if (c.current_item_id !== null) affected.add(c.current_item_id);
    if (c.item_id !== null) affected.add(c.item_id);
  }
  const affectedItemIds = [...affected];
  await ensurePoolLevels(client, affectedItemIds);
  await autoInitialize(client, created);
  await enqueueItems(client, affectedItemIds);
  return { affectedItemIds, linked: links.length, unlinked: changes.length - links.length };
}

async function allLinkableSkus(client: Queryable): Promise<string[]> {
  const { rows } = await client.query<{ sku: string }>(
    `SELECT sku FROM variants WHERE sku IS NOT NULL
     UNION
     SELECT i.sku FROM items i WHERE EXISTS (SELECT 1 FROM variants v WHERE v.item_id = i.id)`,
  );
  return rows.map((r) => r.sku);
}

function distinctSkus(skus: (string | null)[]): string[] {
  const out = new Set<string>();
  for (const raw of skus) {
    const sku = normalizeSku(raw);
    if (sku) out.add(sku);
  }
  return [...out];
}

/**
 * Closes the scope over existing links: a variant whose SKU is in scope may be linked to an item
 * with another SKU (its SKU changed, or a manual link), and that item's other variants must be
 * re-evaluated too, and so on. Only links between different SKUs matter, and there are few.
 */
async function expandScope(client: Queryable, seed: string[]): Promise<string[]> {
  const { rows } = await client.query<{ sku: string }>(
    `WITH RECURSIVE
       cross_links AS (
         SELECT v.sku AS a, i.sku AS b FROM variants v JOIN items i ON i.id = v.item_id
          WHERE v.deleted_at IS NULL AND v.sku <> i.sku
       ),
       edges AS (SELECT a, b FROM cross_links UNION ALL SELECT b, a FROM cross_links),
       scope(sku) AS (
         SELECT unnest($1::text[])
         UNION
         SELECT e.b FROM scope s JOIN edges e ON e.a = s.sku
       )
     SELECT sku FROM scope`,
    [seed],
  );
  return rows.map((r) => r.sku);
}

/** Creates the item of every SKU in scope that some store can link (exactly one candidate). */
async function createMissingItems(client: Queryable, scope: string[]): Promise<number[]> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO items (sku, title)
     SELECT DISTINCT ON (v.sku) v.sku,
            v.product_title || CASE WHEN v.variant_title IN ('', 'Default Title') THEN ''
                                    ELSE ' - ' || v.variant_title END
       FROM variants v
      WHERE v.sku = ANY($1::text[]) AND v.link_source = 'auto'
        AND v.deleted_at IS NULL AND NOT v.is_bundle
        AND NOT EXISTS (SELECT 1 FROM items i WHERE i.sku = v.sku)
        AND NOT EXISTS (
          SELECT 1 FROM variants d
           WHERE d.store_id = v.store_id AND d.sku = v.sku AND d.id <> v.id
             AND d.deleted_at IS NULL AND NOT d.is_bundle)
      ORDER BY v.sku, v.id
     ON CONFLICT (sku) DO NOTHING
     RETURNING id`,
    [scope],
  );
  return rows.map((r) => r.id);
}

/**
 * Automatic variants in scope whose link should change. A variant is linked to its SKU's item
 * when it is live, not a bundle, the only live non-bundle variant with that SKU in its store, and
 * no manual link in its store already holds that item. Otherwise it is unlinked.
 */
async function planLinks(client: Queryable, scope: string[]) {
  const { rows } = await client.query<{
    id: number;
    current_item_id: number | null;
    item_id: number | null;
  }>(
    `WITH scope_items AS (
       SELECT id, sku FROM items WHERE sku = ANY($1::text[])
     ),
     sku_counts AS (
       SELECT store_id, sku, count(*) AS n FROM variants
        WHERE sku = ANY($1::text[]) AND deleted_at IS NULL AND NOT is_bundle
        GROUP BY store_id, sku
     ),
     manual_slots AS (
       SELECT DISTINCT store_id, item_id FROM variants
        WHERE link_source = 'manual' AND deleted_at IS NULL
          AND item_id IN (SELECT id FROM scope_items)
     ),
     plan AS (
       SELECT v.id, v.item_id AS current_item_id,
              CASE WHEN v.deleted_at IS NULL AND NOT v.is_bundle AND c.n = 1
                        AND NOT EXISTS (SELECT 1 FROM manual_slots m
                                         WHERE m.store_id = v.store_id AND m.item_id = si.id)
                   THEN si.id END AS item_id
         FROM variants v
         LEFT JOIN scope_items si ON si.sku = v.sku
         LEFT JOIN sku_counts c ON c.store_id = v.store_id AND c.sku = v.sku
        WHERE v.link_source = 'auto'
          AND (v.sku = ANY($1::text[]) OR v.item_id IN (SELECT id FROM scope_items))
     )
     SELECT id, current_item_id, item_id FROM plan
      WHERE current_item_id IS DISTINCT FROM item_id`,
    [scope],
  );
  return rows;
}

// ---- items and pool levels --------------------------------------------------------------------

async function ensurePoolLevels(db: Queryable, itemIds: number[]): Promise<void> {
  if (itemIds.length === 0) return;
  await db.query(
    `INSERT INTO pool_levels (item_id, warehouse_id)
     SELECT i.id, w.id FROM unnest($1::bigint[]) AS i(id) CROSS JOIN warehouses w
     ON CONFLICT (item_id, warehouse_id) DO NOTHING`,
    [itemIds],
  );
}

/**
 * After onboarding, items that appear later (a SKU seen for the first time) start syncing on
 * their own, if the merchant wants that. Items that already existed but were never started (left
 * out at onboarding, created by hand) are left for the merchant to start from the onboarding
 * screen, where the starting numbers are previewed. Items with sync disabled are left alone.
 */
async function autoInitialize(client: Queryable, itemIds: number[]): Promise<void> {
  if (itemIds.length === 0) return;
  const settings = await getSettings(client);
  if (!settings.onboardingCompleted || !settings.autoInitializeNewItems) return;
  await client.query(
    `INSERT INTO pool_adjustments (pool_level_id, kind, strategy)
     SELECT pl.id, 'initialize', $2 FROM pool_levels pl JOIN items i ON i.id = pl.item_id
      WHERE pl.item_id = ANY($1::bigint[]) AND pl.quantity IS NULL AND i.sync_enabled
        AND NOT EXISTS (SELECT 1 FROM pool_adjustments a
                         WHERE a.pool_level_id = pl.id AND a.kind = 'initialize'
                           AND a.applied_at IS NULL)`,
    [itemIds, settings.autoInitializeStrategy],
  );
}

async function enqueueItems(db: Queryable, itemIds: (number | null)[]): Promise<void> {
  const ids = itemIds.filter((id): id is number => id !== null);
  if (ids.length === 0) return;
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM pool_levels WHERE item_id = ANY($1::bigint[])',
    [ids],
  );
  await enqueuePoolLevels(
    db,
    rows.map((r) => r.id),
    'catalog',
  );
}

// ---- locations --------------------------------------------------------------------------------

interface LocationRow {
  id: number;
  is_active: boolean;
  warehouse_id: number | null;
}

async function storeLocations(client: Queryable, storeId: number): Promise<LocationRow[]> {
  const { rows } = await client.query<LocationRow>(
    'SELECT id, is_active, warehouse_id FROM store_locations WHERE store_id = $1',
    [storeId],
  );
  return rows;
}

/** Warehouses this store takes part in: mapped from an active location. */
function syncedWarehouses(locations: LocationRow[]): Set<number> {
  return new Set(
    locations.filter((l) => l.is_active && l.warehouse_id !== null).map((l) => l.warehouse_id!),
  );
}

// ---- helpers ----------------------------------------------------------------------------------

/** Runs `fn` in a transaction that holds the catalog lock (see "Concurrency" at the top). */
export async function withCatalogLock<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  return withTransaction(db, async (client) => {
    await lockCatalog(client);
    return fn(client);
  });
}

/**
 * Takes the catalog lock until the caller's transaction ends. Taking it again in the same
 * transaction is fine. Outside a transaction it would be released at once: pass a client.
 */
export async function lockCatalog(db: Queryable): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock($1)', [CATALOG_LOCK_ID]);
}

/** The database clock, which `seen_at` / `deleted_at` are compared against. */
async function dbClock(db: Queryable): Promise<Date> {
  const { rows } = await db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  return rows[0]!.now;
}

function assertId(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new CatalogError(`Invalid ${name}: ${String(value)}`, 'invalid');
}

function assertGid(value: string, type: string): void {
  if (typeof value !== 'string' || !value.startsWith(`gid://shopify/${type}/`))
    throw new CatalogError(`Invalid ${type} id: ${String(value)}`, 'invalid');
}
