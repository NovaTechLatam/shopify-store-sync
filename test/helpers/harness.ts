import pino from 'pino';
import { createDb, type Db } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { SyncEngine, type ShopifyRegistry } from '../../src/sync/engine.js';
import { enqueuePoolLevels } from '../../src/sync/queue.js';
import { drainQueue, isSyncPaused } from '../../src/sync/worker.js';
import type { ShopifyAdmin } from '../../src/shopify/types.js';
import { FakeShop } from '../fakes/fake-shopify.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/storesync_test';

export const silentLogger = pino({ level: 'silent' });

/** Drops and recreates the public schema, then applies all migrations. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}

export class FakeRegistry implements ShopifyRegistry {
  readonly shops = new Map<number, FakeShop>();
  async forStore(storeId: number): Promise<ShopifyAdmin> {
    const shop = this.shops.get(storeId);
    if (!shop) throw new Error(`no fake shop for store ${storeId}`);
    return shop;
  }
}

export interface TestStore {
  id: number;
  shop: FakeShop;
  locationId: string;
}

export interface TestItem {
  itemId: number;
  poolLevelId: number;
  sku: string;
  /** inventory item id per store id */
  inventoryItemIds: Map<number, string>;
}

/** A database plus N fake stores, each with one location mapped to the main warehouse. */
export class Harness {
  readonly registry = new FakeRegistry();
  readonly stores: TestStore[] = [];
  engine!: SyncEngine;
  warehouseId = 1;

  constructor(readonly db: Db) {}

  static async create(storeCount: number, opts: { buffers?: number[] } = {}): Promise<Harness> {
    const db = createDb(TEST_DATABASE_URL, 10);
    await resetDatabase(db);
    const h = new Harness(db);
    h.engine = new SyncEngine({ db, shopify: h.registry, logger: silentLogger });
    const { rows } = await db.query<{ id: number }>('SELECT id FROM warehouses LIMIT 1');
    h.warehouseId = rows[0]!.id;
    for (let i = 0; i < storeCount; i++) await h.addStore(`brand${i}`, opts.buffers?.[i] ?? 0);
    return h;
  }

  async addStore(name: string, buffer = 0): Promise<TestStore> {
    const domain = `${name}.myshopify.com`;
    const shop = new FakeShop(domain, name);
    const locationId = shop.addLocation('Main');
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO stores (name, shop_domain, auth_mode, access_token_enc, safety_buffer)
       VALUES ($1, $2, 'access_token', 'unused', $3) RETURNING id`,
      [name, domain, buffer],
    );
    const id = rows[0]!.id;
    await this.db.query(
      `INSERT INTO store_locations (store_id, shopify_location_id, name, warehouse_id) VALUES ($1, $2, 'Main', $3)`,
      [id, locationId, this.warehouseId],
    );
    this.registry.shops.set(id, shop);
    const store = { id, shop, locationId };
    this.stores.push(store);
    return store;
  }

  /**
   * Creates an item sold by every store (or `inStores`), stocked with the given per-store
   * quantities, linked and with a pool level. Not initialised.
   */
  async addItem(
    sku: string,
    quantities: (number | null)[],
    inStores?: TestStore[],
  ): Promise<TestItem> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO items (sku, title) VALUES ($1, $1) RETURNING id`,
      [sku],
    );
    const itemId = rows[0]!.id;
    const inventoryItemIds = new Map<number, string>();
    const stores = inStores ?? this.stores;
    for (const [i, store] of stores.entries()) {
      const variant = store.shop.addVariant(sku);
      const qty = quantities[i];
      if (qty !== null && qty !== undefined)
        store.shop.stock(variant.inventoryItemId, store.locationId, qty);
      await this.db.query(
        `INSERT INTO variants (store_id, item_id, shopify_product_id, shopify_variant_id, inventory_item_id, sku)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [store.id, itemId, variant.productId, variant.variantId, variant.inventoryItemId, sku],
      );
      inventoryItemIds.set(store.id, variant.inventoryItemId);
    }
    const pl = await this.db.query<{ id: number }>(
      `INSERT INTO pool_levels (item_id, warehouse_id) VALUES ($1, $2) RETURNING id`,
      [itemId, this.warehouseId],
    );
    return { itemId, poolLevelId: pl.rows[0]!.id, sku, inventoryItemIds };
  }

  async initialize(
    item: TestItem,
    strategy: 'store' | 'min' | 'max' | 'sum' | 'value',
    opts: { sourceStoreId?: number; value?: number } = {},
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, strategy, source_store_id, value)
       VALUES ($1, 'initialize', $2, $3, $4)`,
      [item.poolLevelId, strategy, opts.sourceStoreId ?? null, opts.value ?? null],
    );
    await this.enqueue(item, 'initialize');
  }

  async enqueue(item: TestItem, reason = 'test'): Promise<void> {
    await enqueuePoolLevels(this.db, [item.poolLevelId], reason);
  }

  /** Simulates a sale/edit in a store and the webhook that follows it. */
  async externalChange(
    store: TestStore,
    item: TestItem,
    delta: number,
    opts: { webhook?: boolean } = {},
  ) {
    const value = store.shop.externalAdjust(
      item.inventoryItemIds.get(store.id)!,
      store.locationId,
      delta,
    );
    if (opts.webhook ?? true) await this.enqueue(item, 'webhook');
    return value;
  }

  /** Runs the worker until nothing is ready; also releases backoff delays so retries happen now. */
  async drain(
    opts: { releaseBackoff?: boolean; maxRounds?: number; concurrency?: number } = {},
  ): Promise<void> {
    for (let i = 0; i < (opts.maxRounds ?? 50); i++) {
      if (await isSyncPaused(this.db)) return;
      const n = await drainQueue(this.db, this.engine, silentLogger, {
        concurrency: opts.concurrency ?? 4,
      });
      if (!(opts.releaseBackoff ?? true)) return;
      const { rowCount } = await this.db.query(
        `UPDATE sync_queue SET run_after = now() WHERE run_after > now() AND lease_token IS NULL`,
      );
      if (n === 0 && rowCount === 0) return;
    }
    throw new Error('queue did not drain');
  }

  level(store: TestStore, item: TestItem): number | undefined {
    return store.shop.level(item.inventoryItemIds.get(store.id)!, store.locationId);
  }

  levels(item: TestItem): (number | undefined)[] {
    return this.stores.map((s) => this.level(s, item));
  }

  async shared(item: TestItem): Promise<number | null> {
    const { rows } = await this.db.query<{ quantity: number | null }>(
      'SELECT quantity FROM pool_levels WHERE id = $1',
      [item.poolLevelId],
    );
    return rows[0]!.quantity;
  }

  async pendingWrites(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pending_writes',
    );
    return rows[0]!.n;
  }

  async close(): Promise<void> {
    await this.db.end();
  }
}
