import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogError,
  type CatalogDeps,
  ensureItemsLocked,
  refreshInventoryItem,
  relink,
  removeInventoryItem,
  removeProduct,
  resetToAutoLink,
  setManualLink,
  syncStoreCatalog,
  syncStoreLocations,
  withCatalogLock,
} from '../src/catalog/catalog.js';
import { createDb, type Db } from '../src/db/pool.js';
import { updateSettings } from '../src/settings.js';
import type { ShopifyVariant } from '../src/shopify/types.js';
import { SyncEngine } from '../src/sync/engine.js';
import { enqueuePoolLevels } from '../src/sync/queue.js';
import { drainQueue } from '../src/sync/worker.js';
import { FakeShop } from './fakes/fake-shopify.js';
import { FakeRegistry, TEST_DATABASE_URL, resetDatabase, silentLogger } from './helpers/harness.js';

interface Store {
  id: number;
  shop: FakeShop;
}

let db: Db;
let registry: FakeRegistry;
let deps: CatalogDeps;

beforeEach(async () => {
  db = createDb(TEST_DATABASE_URL, 10);
  await resetDatabase(db);
  registry = new FakeRegistry();
  deps = { db, shopify: registry, logger: silentLogger };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.end();
});

/** A store row and its fake shop with `locations` active locations, none mapped yet. */
async function addStore(name: string, locations = 1): Promise<Store> {
  const shop = new FakeShop(`${name}.myshopify.com`, name);
  for (let i = 1; i <= locations; i++) shop.addLocation(`${name} location ${i}`);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO stores (name, shop_domain, auth_mode, access_token_enc)
     VALUES ($1, $2, 'access_token', 'unused') RETURNING id`,
    [name, shop.domain],
  );
  const id = rows[0]!.id;
  registry.shops.set(id, shop);
  return { id, shop };
}

async function syncAll(...stores: Store[]): Promise<void> {
  for (const s of stores) await syncStoreCatalog(deps, s.id);
}

async function variantRow(variant: ShopifyVariant) {
  const { rows } = await db.query<{
    id: number;
    sku: string | null;
    link_source: string;
    deleted_at: Date | null;
    item_sku: string | null;
  }>(
    `SELECT v.id, v.sku, v.link_source, v.deleted_at, i.sku AS item_sku
       FROM variants v LEFT JOIN items i ON i.id = v.item_id
      WHERE v.shopify_variant_id = $1`,
    [variant.variantId],
  );
  if (!rows[0]) throw new Error(`variant ${variant.variantId} is not in the database`);
  return rows[0];
}

/** SKU of the item a Shopify variant is linked to; null = not synced. */
async function linkOf(variant: ShopifyVariant): Promise<string | null> {
  return (await variantRow(variant)).item_sku;
}

async function itemId(sku: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM items WHERE sku = $1', [sku]);
  return rows[0]!.id;
}

/** SKUs of the items with pool levels waiting in the sync queue; empties the queue. */
async function takeQueuedSkus(): Promise<string[]> {
  const { rows } = await db.query<{ sku: string }>(
    `DELETE FROM sync_queue q USING pool_levels pl, items i
      WHERE pl.id = q.pool_level_id AND i.id = pl.item_id
      RETURNING i.sku`,
  );
  return [...new Set(rows.map((r) => r.sku))].sort();
}

async function openAlerts() {
  const { rows } = await db.query<{ kind: string; dedupe_key: string; message: string }>(
    'SELECT kind, dedupe_key, message FROM alerts WHERE resolved_at IS NULL ORDER BY id',
  );
  return rows;
}

async function mappedLocations(storeId: number) {
  const { rows } = await db.query<{ shopify_location_id: string; warehouse_id: number }>(
    `SELECT shopify_location_id, warehouse_id FROM store_locations
      WHERE store_id = $1 AND warehouse_id IS NOT NULL`,
    [storeId],
  );
  return rows;
}

async function defaultWarehouseId(): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT min(id) AS id FROM warehouses');
  return rows[0]!.id;
}

describe('SKU matching', () => {
  it('links the same SKU across three stores into one item with its pool level', async () => {
    const stores = [await addStore('a'), await addStore('b'), await addStore('c')];
    const tees = stores.map((s) =>
      s.shop.addVariant('TEE-BLK-M', { productTitle: 'Tee', variantTitle: 'Black / M' }),
    );
    const mug = stores[0]!.shop.addVariant('MUG', { productTitle: 'Mug' });

    expect(await syncStoreCatalog(deps, stores[0]!.id)).toEqual({
      locations: 1,
      variants: 2,
      added: 2,
      removed: 0,
      linked: 2,
      unlinked: 0,
      conflicts: 0,
    });
    await syncAll(stores[1]!, stores[2]!);

    for (const v of tees) expect(await linkOf(v)).toBe('TEE-BLK-M');
    expect(await linkOf(mug)).toBe('MUG');
    const { rows: items } = await db.query(
      `SELECT i.sku, i.title, count(pl.id)::int AS levels
         FROM items i JOIN pool_levels pl ON pl.item_id = i.id
        GROUP BY i.id ORDER BY i.sku`,
    );
    expect(items).toEqual([
      { sku: 'MUG', title: 'Mug', levels: 1 },
      { sku: 'TEE-BLK-M', title: 'Tee - Black / M', levels: 1 },
    ]);
    expect(await takeQueuedSkus()).toEqual(['MUG', 'TEE-BLK-M']);

    // Nothing changed in Shopify: a re-sync changes nothing and wakes nothing.
    expect(await syncStoreCatalog(deps, stores[1]!.id)).toEqual({
      locations: 1,
      variants: 1,
      added: 0,
      removed: 0,
      linked: 0,
      unlinked: 0,
      conflicts: 0,
    });
    expect(await takeQueuedSkus()).toEqual([]);
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM stores WHERE catalog_synced_at IS NULL',
    );
    expect(rows[0].n).toBe(0);
  });

  it('matches SKUs regardless of case and surrounding whitespace', async () => {
    const [a, b, c] = [await addStore('a'), await addStore('b'), await addStore('c')];
    const variants = [
      a.shop.addVariant(' tee-blk-m '),
      b.shop.addVariant('TEE-BLK-M'),
      c.shop.addVariant('Tee-Blk-M\t'),
    ];
    await syncAll(a, b, c);
    for (const v of variants) {
      expect(await linkOf(v)).toBe('TEE-BLK-M');
      expect((await variantRow(v)).sku).toBe('TEE-BLK-M');
    }
    const { rows } = await db.query('SELECT sku FROM items');
    expect(rows).toEqual([{ sku: 'TEE-BLK-M' }]);
  });

  it('never syncs a SKU duplicated within a store, and keeps linking the other stores', async () => {
    const [a, b, c] = [await addStore('a'), await addStore('b'), await addStore('c')];
    const dupes = [a.shop.addVariant('DUP'), a.shop.addVariant('dup ')];
    const others = [b.shop.addVariant('DUP'), c.shop.addVariant('DUP')];

    expect(await syncStoreCatalog(deps, a.id)).toMatchObject({ linked: 0, conflicts: 1 });
    await syncAll(b, c);
    for (const v of dupes) expect(await linkOf(v)).toBeNull();
    for (const v of others) expect(await linkOf(v)).toBe('DUP');

    // The merchant deletes the extra variant in Shopify: the remaining one joins.
    a.shop.removeVariant(dupes[1]!.variantId);
    expect(await syncStoreCatalog(deps, a.id)).toMatchObject({
      removed: 1,
      linked: 1,
      conflicts: 0,
    });
    expect(await linkOf(dupes[0]!)).toBe('DUP');

    // A store that gains a duplicate stops syncing that SKU.
    await takeQueuedSkus();
    b.shop.addVariant('Dup');
    expect(await syncStoreCatalog(deps, b.id)).toMatchObject({ unlinked: 1, conflicts: 1 });
    expect(await linkOf(others[0]!)).toBeNull();
    expect(await takeQueuedSkus()).toEqual(['DUP']);
  });

  it('moves the link when a SKU changes and enqueues both items', async () => {
    const [a, b] = [await addStore('a'), await addStore('b')];
    const moving = a.shop.addVariant('OLD');
    b.shop.addVariant('OLD');
    b.shop.addVariant('NEW');
    await syncAll(a, b);
    await takeQueuedSkus();

    // inventory_items/update webhook
    moving.sku = 'NEW';
    await refreshInventoryItem(deps, a.id, moving.inventoryItemId);
    expect(await linkOf(moving)).toBe('NEW');
    expect(await takeQueuedSkus()).toEqual(['NEW', 'OLD']);

    // full catalog sync
    moving.sku = 'OLD';
    expect(await syncStoreCatalog(deps, a.id)).toMatchObject({ linked: 1, unlinked: 0 });
    expect(await linkOf(moving)).toBe('OLD');
    expect(await takeQueuedSkus()).toEqual(['NEW', 'OLD']);
  });

  it('relinking one SKU follows existing links to every other SKU involved', async () => {
    const a = await addStore('a');
    const renamed = a.shop.addVariant('X');
    await syncAll(a);
    // The variant's SKU changed to Q but only the new variant's SKU (X) gets relinked: the stale
    // link Q → X must move to Q, or it would block X in this store.
    renamed.sku = 'Q';
    await db.query(`UPDATE variants SET sku = 'Q' WHERE shopify_variant_id = $1`, [
      renamed.variantId,
    ]);
    const newcomer = a.shop.addVariant('X');
    await refreshInventoryItem(deps, a.id, newcomer.inventoryItemId);
    expect(await linkOf(renamed)).toBe('Q');
    expect(await linkOf(newcomer)).toBe('X');
  });

  it('swaps SKUs between two variants of a store without tripping the one-variant-per-item index', async () => {
    const [a, b] = [await addStore('a'), await addStore('b')];
    const x = a.shop.addVariant('X');
    const y = a.shop.addVariant('Y');
    b.shop.addVariant('X');
    b.shop.addVariant('Y');
    await syncAll(a, b);

    [x.sku, y.sku] = ['Y', 'X'];
    await syncStoreCatalog(deps, a.id);
    expect([await linkOf(x), await linkOf(y)]).toEqual(['Y', 'X']);

    // The same swap seen one webhook at a time passes through a (safe) duplicate state.
    [x.sku, y.sku] = ['X', 'Y'];
    await refreshInventoryItem(deps, a.id, x.inventoryItemId);
    expect([await linkOf(x), await linkOf(y)]).toEqual([null, null]);
    await refreshInventoryItem(deps, a.id, y.inventoryItemId);
    expect([await linkOf(x), await linkOf(y)]).toEqual(['X', 'Y']);
  });

  it('links untracked variants but never bundles or variants without a SKU', async () => {
    const [a, b] = [await addStore('a'), await addStore('b')];
    const untracked = a.shop.addVariant('U-1', { tracked: false });
    const bundle = a.shop.addVariant('B-1', { isBundle: true });
    const component = a.shop.addVariant('B-1'); // a bundle doesn't make its SKU a duplicate
    const blank = a.shop.addVariant('   ');
    const missing = a.shop.addVariant(null);
    b.shop.addVariant('U-1');
    b.shop.addVariant('B-1');
    await syncAll(a, b);

    expect(await linkOf(untracked)).toBe('U-1');
    expect(await linkOf(component)).toBe('B-1');
    expect(await linkOf(bundle)).toBeNull();
    expect(await linkOf(blank)).toBeNull();
    expect(await linkOf(missing)).toBeNull();
    expect((await variantRow(blank)).sku).toBeNull();

    // A variant that becomes a bundle stops syncing.
    untracked.isBundle = true;
    await refreshInventoryItem(deps, a.id, untracked.inventoryItemId);
    expect(await linkOf(untracked)).toBeNull();
  });

  it('enqueues the item when a linked variant stops or starts being tracked', async () => {
    const a = await addStore('a');
    const tee = a.shop.addVariant('TEE');
    await syncAll(a);
    await takeQueuedSkus();
    tee.tracked = false;
    await syncStoreCatalog(deps, a.id);
    expect(await linkOf(tee)).toBe('TEE');
    expect(await takeQueuedSkus()).toEqual(['TEE']);
  });
});

describe('removed variants', () => {
  it('unlinks and marks deleted the variants a full sync no longer sees', async () => {
    const [a, b] = [await addStore('a'), await addStore('b')];
    const gone = a.shop.addVariant('SKU-1');
    b.shop.addVariant('SKU-1');
    await syncAll(a, b);
    await takeQueuedSkus();

    a.shop.removeVariant(gone.variantId);
    expect(await syncStoreCatalog(deps, a.id)).toMatchObject({
      variants: 0,
      removed: 1,
      unlinked: 1,
    });
    const row = await variantRow(gone);
    expect(row.deleted_at).not.toBeNull();
    expect(row.item_sku).toBeNull();
    expect(await takeQueuedSkus()).toEqual(['SKU-1']);
  });

  it('applies deletion webhooks: product, inventory item, and an item Shopify no longer has', async () => {
    const [a, b] = [await addStore('a'), await addStore('b')];
    const byProduct = a.shop.addVariant('P-1');
    const byItem = a.shop.addVariant('P-2');
    const vanished = a.shop.addVariant('P-3');
    for (const sku of ['P-1', 'P-2', 'P-3']) b.shop.addVariant(sku);
    await syncAll(a, b);
    await takeQueuedSkus();

    await removeProduct(db, a.id, byProduct.productId);
    await removeInventoryItem(db, a.id, byItem.inventoryItemId);
    a.shop.removeVariant(vanished.variantId);
    await refreshInventoryItem(deps, a.id, vanished.inventoryItemId);

    for (const v of [byProduct, byItem, vanished]) {
      const row = await variantRow(v);
      expect(row.deleted_at).not.toBeNull();
      expect(row.item_sku).toBeNull();
    }
    expect(await takeQueuedSkus()).toEqual(['P-1', 'P-2', 'P-3']);
  });

  it('does not let a catalog read that started earlier undo webhooks processed meanwhile', async () => {
    const a = await addStore('a');
    const deleted = a.shop.addVariant('GONE');
    await syncAll(a);

    let created: ShopifyVariant | undefined;
    const listVariants = a.shop.listVariants.bind(a.shop);
    a.shop.listVariants = async () => {
      const listed = await listVariants();
      // While the (slow) read is in flight, a product is deleted and another one is created.
      a.shop.removeVariant(deleted.variantId);
      await removeProduct(db, a.id, deleted.productId);
      created = a.shop.addVariant('NEW');
      await refreshInventoryItem(deps, a.id, created.inventoryItemId);
      return listed;
    };
    await syncStoreCatalog(deps, a.id);

    expect((await variantRow(deleted)).deleted_at).not.toBeNull();
    expect((await variantRow(created!)).deleted_at).toBeNull();
    expect(await linkOf(created!)).toBe('NEW');
  });
});

describe('manual links', () => {
  it('keeps manual links through every relink, and can go back to automatic matching', async () => {
    const [a, b] = [await addStore('a'), await addStore('b')];
    const renamed = a.shop.addVariant('TEE-OLD');
    b.shop.addVariant('TEE');
    a.shop.addVariant('MUG');
    const neverSync = b.shop.addVariant('MUG');
    await syncAll(a, b);
    await takeQueuedSkus();

    await setManualLink(db, (await variantRow(renamed)).id, await itemId('TEE'));
    expect(await takeQueuedSkus()).toEqual(['TEE', 'TEE-OLD']);
    await setManualLink(db, (await variantRow(neverSync)).id, null);
    expect(await takeQueuedSkus()).toEqual(['MUG']);

    await syncAll(a, b);
    await relink(db);
    expect(await linkOf(renamed)).toBe('TEE');
    expect((await variantRow(renamed)).link_source).toBe('manual');
    expect(await linkOf(neverSync)).toBeNull();
    expect(await takeQueuedSkus()).toEqual([]);

    await resetToAutoLink(db, (await variantRow(renamed)).id);
    await resetToAutoLink(db, (await variantRow(neverSync)).id);
    expect(await linkOf(renamed)).toBe('TEE-OLD');
    expect(await linkOf(neverSync)).toBe('MUG');
    expect((await variantRow(renamed)).link_source).toBe('auto');
    expect(await takeQueuedSkus()).toEqual(['MUG', 'TEE', 'TEE-OLD']);
  });

  it('a manual link holds its item in the store: automatic variants with that SKU wait', async () => {
    const a = await addStore('a');
    const chosen = a.shop.addVariant('LEGACY-CODE');
    const sameSku = a.shop.addVariant('TEE');
    await syncAll(a);
    await setManualLink(db, (await variantRow(sameSku)).id, null);
    await setManualLink(db, (await variantRow(chosen)).id, await itemId('TEE'));
    await resetToAutoLink(db, (await variantRow(sameSku)).id);
    expect(await linkOf(sameSku)).toBeNull();
    expect(await linkOf(chosen)).toBe('TEE');

    // Releasing the manual link lets the automatic variant take the item.
    await setManualLink(db, (await variantRow(chosen)).id, null);
    expect(await linkOf(sameSku)).toBe('TEE');
  });

  it('refuses manual links that would give a store two variants of one item', async () => {
    const a = await addStore('a');
    const linked = a.shop.addVariant('X');
    const other = a.shop.addVariant('Y');
    await syncAll(a);
    const otherId = (await variantRow(other)).id;

    const conflict = setManualLink(db, otherId, await itemId('X'));
    await expect(conflict).rejects.toBeInstanceOf(CatalogError);
    await expect(conflict).rejects.toMatchObject({ code: 'conflict' });
    expect(await linkOf(other)).toBe('Y');
    await expect(setManualLink(db, otherId, 999_999)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setManualLink(db, 999_999, null)).rejects.toMatchObject({ code: 'not_found' });
    await expect(setManualLink(db, 0, null)).rejects.toMatchObject({ code: 'invalid' });

    a.shop.removeVariant(other.variantId);
    await syncStoreCatalog(deps, a.id);
    await expect(setManualLink(db, otherId, null)).rejects.toMatchObject({ code: 'not_found' });

    // Pinning the variant that already holds the item is fine.
    await setManualLink(db, (await variantRow(linked)).id, await itemId('X'));
    expect((await variantRow(linked)).link_source).toBe('manual');
  });
});

describe('auto-initialisation', () => {
  async function initializations() {
    const { rows } = await db.query<{ sku: string; strategy: string }>(
      `SELECT i.sku, a.strategy FROM pool_adjustments a
         JOIN pool_levels pl ON pl.id = a.pool_level_id JOIN items i ON i.id = pl.item_id
        WHERE a.kind = 'initialize' ORDER BY a.id`,
    );
    return rows;
  }

  it('starts syncing new items on its own only once onboarding is completed', async () => {
    const a = await addStore('a');
    a.shop.addVariant('EARLY');
    await syncAll(a);
    expect(await initializations()).toEqual([]);

    await updateSettings(db, { onboardingCompleted: true });
    a.shop.addVariant('LATE');
    await syncAll(a);
    expect(await initializations()).toEqual([{ sku: 'LATE', strategy: 'max' }]);

    await updateSettings(db, { autoInitializeStrategy: 'min' });
    a.shop.addVariant('LATER');
    await syncAll(a);
    expect(await initializations()).toEqual([
      { sku: 'LATE', strategy: 'max' },
      { sku: 'LATER', strategy: 'min' },
    ]);

    await updateSettings(db, { autoInitializeNewItems: false });
    a.shop.addVariant('BY-HAND');
    await syncAll(a);
    expect(await initializations()).toHaveLength(2);
  });
});

describe('items created by features', () => {
  it('creates missing items with pool levels under the catalog lock, without starting them', async () => {
    await updateSettings(db, { onboardingCompleted: true });
    const a = await addStore('a');
    const sold = a.shop.addVariant('OLD-1');
    await syncAll(a);
    const oldId = await itemId('OLD-1');
    await db.query('INSERT INTO warehouses (name) VALUES ($1)', ['Second warehouse']);

    const other = await db.connect();
    const items = await withCatalogLock(db, async (client) => {
      const result = await ensureItemsLocked(client, [
        { sku: ' new-1 ', title: ' New one ' },
        { sku: 'NEW-1', title: 'Duplicate, ignored' },
        { sku: 'old-1', title: 'Not renamed' },
      ]);
      // The lock is held until the transaction ends.
      const { rows } = await other.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(727002) AS locked',
      );
      expect(rows[0]!.locked).toBe(false);
      return result;
    });
    other.release();

    expect([...items.entries()].sort()).toEqual([
      ['NEW-1', { itemId: await itemId('NEW-1'), created: true }],
      ['OLD-1', { itemId: oldId, created: false }],
    ]);
    const { rows } = await db.query<{ sku: string; title: string; levels: number }>(
      `SELECT i.sku, i.title, count(pl.id)::int AS levels
         FROM items i JOIN pool_levels pl ON pl.item_id = i.id
        GROUP BY i.id ORDER BY i.sku`,
    );
    expect(rows).toEqual([
      { sku: 'NEW-1', title: 'New one', levels: 2 },
      { sku: 'OLD-1', title: expect.any(String), levels: 2 },
    ]);
    // Not initialised: the feature decides how the new item starts.
    const inits = await db.query(
      `SELECT 1 FROM pool_adjustments a JOIN pool_levels pl ON pl.id = a.pool_level_id
        WHERE pl.item_id = $1`,
      [items.get('NEW-1')!.itemId],
    );
    expect(inits.rowCount).toBe(0);

    // A store that starts selling the SKU later links to that item.
    const published = a.shop.addVariant('new-1');
    await syncAll(a);
    expect(await linkOf(published)).toBe('NEW-1');
    expect(await linkOf(sold)).toBe('OLD-1');
  });

  it('refuses an empty SKU and accepts an empty list', async () => {
    await withCatalogLock(db, async (client) => {
      expect((await ensureItemsLocked(client, [])).size).toBe(0);
      await expect(ensureItemsLocked(client, [{ sku: '  ', title: 'x' }])).rejects.toBeInstanceOf(
        CatalogError,
      );
    });
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM items');
    expect(rows[0]!.n).toBe(0);
  });
});

describe('locations', () => {
  it("maps a store's only active location to the default warehouse and never moves a mapping", async () => {
    const a = await addStore('a', 0);
    const main = a.shop.addLocation('Main');
    a.shop.addLocation('Closed', false);
    a.shop.addVariant('TEE');
    const warehouseId = await defaultWarehouseId();

    expect(await syncStoreCatalog(deps, a.id)).toMatchObject({ locations: 1 });
    expect(await mappedLocations(a.id)).toEqual([
      { shopify_location_id: main, warehouse_id: warehouseId },
    ]);
    expect(await openAlerts()).toEqual([]);
    await takeQueuedSkus();

    // The mapped location closes and another one opens: the store leaves the pool, the mapping
    // stays, and the merchant is asked what to do.
    a.shop.locations.find((l) => l.id === main)!.isActive = false;
    a.shop.addLocation('Pop-up');
    expect(await syncStoreLocations(deps, a.id)).toBe(1);
    expect(await mappedLocations(a.id)).toEqual([
      { shopify_location_id: main, warehouse_id: warehouseId },
    ]);
    expect(await openAlerts()).toEqual([
      {
        kind: 'store_unmapped',
        dedupe_key: `store_unmapped:${a.id}`,
        message: 'Choose which location of a holds the shared stock.',
      },
    ]);
    expect(await takeQueuedSkus()).toEqual(['TEE']);

    a.shop.locations.find((l) => l.id === main)!.isActive = true;
    await syncStoreLocations(deps, a.id);
    expect(await openAlerts()).toEqual([]);
    expect(await takeQueuedSkus()).toEqual(['TEE']);
  });

  it('leaves a store with several active locations unmapped and asks the merchant to choose', async () => {
    const a = await addStore('a', 2);
    a.shop.addVariant('TEE');
    expect(await syncStoreCatalog(deps, a.id)).toMatchObject({ locations: 2 });
    expect(await mappedLocations(a.id)).toEqual([]);
    expect((await openAlerts()).map((alert) => alert.kind)).toEqual(['store_unmapped']);

    // The merchant picks a location in the dashboard.
    await db.query(
      `UPDATE store_locations SET warehouse_id = $2 WHERE store_id = $1 AND shopify_location_id = $3`,
      [a.id, await defaultWarehouseId(), a.shop.locations[1]!.id],
    );
    await syncStoreLocations(deps, a.id);
    expect(await openAlerts()).toEqual([]);
  });

  it('marks locations Shopify no longer returns inactive', async () => {
    const a = await addStore('a', 2);
    await syncStoreLocations(deps, a.id);
    const closed = a.shop.locations.splice(0, 1)[0]!;
    expect(await syncStoreLocations(deps, a.id)).toBe(1);
    const { rows } = await db.query(
      'SELECT is_active FROM store_locations WHERE shopify_location_id = $1',
      [closed.id],
    );
    expect(rows).toEqual([{ is_active: false }]);
  });
});

describe('scale and concurrency', () => {
  it('syncs a 1,000-variant store with a bounded number of queries', async () => {
    const [a, b] = [await addStore('a'), await addStore('b')];
    for (let i = 0; i < 1000; i++) a.shop.addVariant(`SKU-${i}`, { productTitle: `Product ${i}` });
    for (let i = 0; i < 1000; i += 2) b.shop.addVariant(`sku-${i}`);
    const queries = vi.spyOn(pg.Client.prototype, 'query');

    const started = performance.now();
    expect(await syncStoreCatalog(deps, a.id)).toMatchObject({
      variants: 1000,
      added: 1000,
      linked: 1000,
    });
    const elapsedMs = performance.now() - started;
    // Set-based: the number of statements doesn't grow with the catalog.
    expect(queries.mock.calls.length).toBeLessThan(60);
    expect(elapsedMs).toBeLessThan(5_000);

    queries.mockClear();
    expect(await syncStoreCatalog(deps, b.id)).toMatchObject({ added: 500, linked: 500 });
    expect(queries.mock.calls.length).toBeLessThan(60);
    queries.mockRestore();

    const resync = performance.now();
    expect(await syncStoreCatalog(deps, a.id)).toMatchObject({ added: 0, linked: 0 });
    expect(performance.now() - resync).toBeLessThan(5_000);

    const { rows } = await db.query(
      `SELECT (SELECT count(*)::int FROM items) AS items,
              (SELECT count(*)::int FROM pool_levels) AS levels,
              (SELECT count(*)::int FROM variants WHERE item_id IS NOT NULL) AS linked`,
    );
    expect(rows[0]).toEqual({ items: 1000, levels: 1000, linked: 1500 });
  });

  it('runs catalog syncs of stores that share SKUs concurrently', async () => {
    const stores = [await addStore('a'), await addStore('b'), await addStore('c')];
    for (const s of stores) for (let i = 0; i < 50; i++) s.shop.addVariant(`SHARED-${i}`);
    const summaries = await Promise.all(stores.map((s) => syncStoreCatalog(deps, s.id)));
    expect(summaries.reduce((n, s) => n + s.linked, 0)).toBe(150);
    const { rows } = await db.query(
      `SELECT count(*)::int AS members FROM variants WHERE item_id IS NOT NULL GROUP BY item_id`,
    );
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.members === 3)).toBe(true);
  });
});

describe('end to end', () => {
  it('catalog sync → initialise → drain: every store shows the same quantity', async () => {
    const [a, b] = [await addStore('a'), await addStore('b')];
    const stocked: [Store, ShopifyVariant][] = [];
    for (const [store, tee, mug] of [
      [a, 7, 3],
      [b, 12, 1],
    ] as const) {
      const location = store.shop.locations[0]!.id;
      for (const [sku, qty] of [
        ['TEE', tee],
        ['MUG', mug],
      ] as const) {
        const v = store.shop.addVariant(sku);
        store.shop.stock(v.inventoryItemId, location, qty);
        stocked.push([store, v]);
      }
    }
    await syncAll(a, b);

    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO pool_adjustments (pool_level_id, kind, strategy)
       SELECT id, 'initialize', 'max' FROM pool_levels RETURNING pool_level_id AS id`,
    );
    await enqueuePoolLevels(
      db,
      rows.map((r) => r.id),
      'initialize',
    );
    const engine = new SyncEngine({ db, shopify: registry, logger: silentLogger });
    while ((await drainQueue(db, engine, silentLogger)) > 0);

    const level = ([store, v]: [Store, ShopifyVariant]) =>
      store.shop.level(v.inventoryItemId, store.shop.locations[0]!.id);
    expect(stocked.map(level)).toEqual([12, 3, 12, 3]);

    // A sale in one store now reaches the other.
    const [, tee] = stocked[0]!;
    a.shop.externalAdjust(tee.inventoryItemId, a.shop.locations[0]!.id, -2);
    await enqueuePoolLevels(
      db,
      rows.map((r) => r.id),
      'webhook',
    );
    while ((await drainQueue(db, engine, silentLogger)) > 0);
    expect(stocked.map(level)).toEqual([10, 3, 10, 3]);
  });
});
