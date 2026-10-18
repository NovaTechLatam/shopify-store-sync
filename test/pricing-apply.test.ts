import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_CLASSES } from '../src/db/locks.js';
import { withTransaction } from '../src/db/pool.js';
import type { RestoreEntry } from '../src/pricing/runs.js';
import { applyPrices, createPriceRun } from '../src/pricing/runs.js';
import { ShopifyApiError } from '../src/shopify/client.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import type { TaskDeps } from '../src/tasks/types.js';
import { Harness, silentLogger } from './helpers/harness.js';
import type { TestItem, TestStore } from './helpers/harness.js';

/**
 * The apply_prices task against fake stores: what it writes, what it leaves alone, and how it
 * behaves when Shopify fails or refuses.
 */

const ALL_SCOPES = ['read_products', 'write_products', 'read_inventory', 'write_inventory'];

let h: Harness;
let usd: TestStore;
let cop: TestStore;

const deps = (): TaskDeps => ({
  db: h.db,
  shopify: h.registry,
  logger: silentLogger,
  publicUrl: 'https://sync.example.com',
});

beforeEach(async () => {
  h = await Harness.create(2);
  [usd, cop] = h.stores as [TestStore, TestStore];
  cop.shop.currencyCode = 'COP';
  for (const s of h.stores) s.shop.scopes = [...ALL_SCOPES, 'read_locations'];
  await h.db.query(
    `UPDATE stores SET currency_code = CASE WHEN id = $1 THEN 'USD' ELSE 'COP' END,
            exchange_rate = CASE WHEN id = $1 THEN 1 ELSE 4100 END, granted_scopes = $2`,
    [usd.id, ALL_SCOPES],
  );
});

afterEach(async () => {
  await h.close();
});

/** An item sold in both stores at these prices (in Shopify; the database knows `dbPrices`). */
async function pricedItem(
  sku: string,
  basePrice: number | null,
  prices: [number, number],
  opts: {
    dbPrices?: [number | null, number | null];
    compareAt?: [number | null, number | null];
  } = {},
): Promise<TestItem> {
  const item = await h.addItem(sku, [5, 5]);
  await h.db.query('UPDATE items SET base_price = $2 WHERE id = $1', [item.itemId, basePrice]);
  for (const [i, store] of h.stores.entries()) {
    const variant = shopVariant(store, item);
    variant.price = prices[i]!;
    variant.compareAtPrice = opts.compareAt?.[i] ?? null;
    const known = opts.dbPrices ? opts.dbPrices[i] : prices[i];
    await h.db.query('UPDATE variants SET price = $3 WHERE store_id = $1 AND item_id = $2', [
      store.id,
      item.itemId,
      known,
    ]);
  }
  return item;
}

function shopVariant(store: TestStore, item: TestItem) {
  const inventoryItemId = item.inventoryItemIds.get(store.id)!;
  return store.shop.variants.find((v) => v.inventoryItemId === inventoryItemId)!;
}

async function setRule(storeId: number, rule: Record<string, unknown>) {
  const columns = Object.keys(rule);
  await h.db.query(
    `INSERT INTO price_rules (store_id, ${columns.join(', ')})
     VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (store_id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    [storeId, ...Object.values(rule)],
  );
}

const ENDING_99 = {
  enabled: true,
  round_mode: 'ending',
  round_step: 1,
  round_ending: 0.99,
  round_direction: 'up',
};

async function newRun(
  opts: {
    itemIds?: number[] | null;
    storeIds?: number[] | null;
    restore?: Map<number, RestoreEntry[]>;
    scheduleId?: number;
  } = {},
) {
  return withTransaction(h.db, (client) =>
    createPriceRun(client, {
      reason: opts.scheduleId
        ? { kind: 'sale_end', scheduleId: opts.scheduleId }
        : { kind: 'manual' },
      itemIds: opts.itemIds ?? null,
      storeIds: opts.storeIds ?? null,
      restore: opts.restore,
    }),
  );
}

/** Runs tasks until none is left (failed ones are retried at once). */
async function settle(maxRounds = 10) {
  for (let i = 0; i < maxRounds; i++) {
    await h.db.query('UPDATE tasks SET run_after = now() WHERE run_after > now()');
    if ((await runTasksOnce(h.db, deps(), silentLogger, 10)) === 0) return;
  }
}

async function runStores(runId: number) {
  const { rows } = await h.db.query<{
    store_id: number;
    status: string;
    variants_checked: number;
    variants_updated: number;
    variants_failed: number;
    variants_skipped: number;
    error: string | null;
    errors: { sku: string; message: string }[];
  }>('SELECT * FROM price_run_stores WHERE run_id = $1 ORDER BY store_id', [runId]);
  return rows;
}

async function runStatus(runId: number) {
  const { rows } = await h.db.query<{ status: string; finished_at: Date | null }>(
    'SELECT status, finished_at FROM price_runs WHERE id = $1',
    [runId],
  );
  return rows[0]!;
}

const priceCalls = (store: TestStore) =>
  store.shop.calls.filter((c) => c.op === 'updateVariantPrices');

describe('apply_prices', () => {
  it('writes the rule’s prices and never touches a store whose rule is off', async () => {
    await setRule(usd.id, ENDING_99);
    await setRule(cop.id, { enabled: false });
    const tee = await pricedItem('TEE', 10, [9.5, 30000]);
    const cap = await pricedItem('CAP', 20, [20.99, 50000]);

    const run = await newRun();
    expect(run!.stores.map((s) => s.storeId)).toEqual([usd.id]);
    expect(run!.skipped.map((s) => s.storeId)).toEqual([cop.id]);
    await settle();

    expect(shopVariant(usd, tee).price).toBe(10.99);
    expect(shopVariant(usd, cap).price).toBe(20.99); // already right: not written
    expect(shopVariant(cop, tee).price).toBe(30000);
    expect(priceCalls(cop)).toHaveLength(0);
    expect(priceCalls(usd)).toHaveLength(1);
    expect(priceCalls(usd)[0]!.args).toEqual({
      productId: shopVariant(usd, tee).productId,
      variants: [{ id: shopVariant(usd, tee).variantId, price: '10.99', compareAtPrice: null }],
    });
    const [row] = await runStores(run!.runId);
    expect(row).toMatchObject({
      status: 'done',
      variants_checked: 2,
      variants_updated: 1,
      variants_failed: 0,
      error: null,
    });
    expect(await runStatus(run!.runId)).toMatchObject({ status: 'done' });
    // The price list sees the new price without waiting for a catalog read.
    const { rows } = await h.db.query<{ price: number }>(
      'SELECT price FROM variants WHERE store_id = $1 AND item_id = $2',
      [usd.id, tee.itemId],
    );
    expect(rows[0]!.price).toBe(10.99);
  });

  it('writes fixed prices even where the rule is off, and nothing else there', async () => {
    await setRule(cop.id, { enabled: false });
    const tee = await pricedItem('TEE', 10, [10, 30000]);
    const cap = await pricedItem('CAP', 20, [20, 50000]);
    await h.db.query(
      `INSERT INTO price_overrides (store_id, item_id, price, compare_at_price)
       VALUES ($1, $2, 39900, 45900)`,
      [cop.id, tee.itemId],
    );
    const run = await newRun();
    // USD has no rule and no fixed price: not part of the run.
    expect(run!.stores.map((s) => s.storeId)).toEqual([cop.id]);
    await settle();
    expect(shopVariant(cop, tee)).toMatchObject({ price: 39900, compareAtPrice: 45900 });
    expect(shopVariant(cop, cap).price).toBe(50000);
    expect(priceCalls(usd)).toHaveLength(0);
  });

  it('re-reads the store’s prices before deciding what to write', async () => {
    await setRule(usd.id, ENDING_99);
    // The database thinks the store already charges 10.99; Shopify says 9.00 (changed there).
    const stale = await pricedItem('STALE', 10, [9, 1], { dbPrices: [10.99, null] });
    // The other way round: the store was already updated, the database doesn't know yet.
    const fresh = await pricedItem('FRESH', 20, [20.99, 1], { dbPrices: [15, null] });
    const run = await newRun({ storeIds: [usd.id] });
    await settle();

    expect(shopVariant(usd, stale).price).toBe(10.99);
    expect(priceCalls(usd)).toHaveLength(1);
    expect(JSON.stringify(priceCalls(usd)[0]!.args)).not.toContain(
      shopVariant(usd, fresh).variantId,
    );
    const { rows } = await h.db.query<{ item_id: number; price: number }>(
      'SELECT item_id, price FROM variants WHERE store_id = $1 ORDER BY item_id',
      [usd.id],
    );
    expect(rows.map((r) => r.price)).toEqual([10.99, 20.99]);
    expect((await runStores(run!.runId))[0]).toMatchObject({
      variants_checked: 2,
      variants_updated: 1,
    });
  });

  it('reads only the products in scope when the run covers a few items', async () => {
    await setRule(usd.id, ENDING_99);
    const tee = await pricedItem('TEE', 10, [9, 1]);
    await pricedItem('CAP', 20, [9, 1]);
    const listAll = vi.spyOn(usd.shop, 'listVariants');
    const listOne = vi.spyOn(usd.shop, 'listProductVariants');
    await newRun({ itemIds: [tee.itemId], storeIds: [usd.id] });
    await settle();
    expect(listAll).not.toHaveBeenCalled();
    expect(listOne).toHaveBeenCalledTimes(1);
    expect(priceCalls(usd)).toHaveLength(1);
  });

  it('sends compare-at prices, and leaves them out when the rule keeps the store’s', async () => {
    await setRule(usd.id, { ...ENDING_99, compare_at_mode: 'markup', compare_at_markup: 1.5 });
    const tee = await pricedItem('TEE', 10, [9, 1]);
    await newRun({ storeIds: [usd.id] });
    await settle();
    expect(shopVariant(usd, tee)).toMatchObject({ price: 10.99, compareAtPrice: 16.99 });

    await setRule(usd.id, { compare_at_mode: 'keep' });
    await h.db.query('UPDATE items SET base_price = 12 WHERE id = $1', [tee.itemId]);
    await newRun({ storeIds: [usd.id] });
    await settle();
    expect(shopVariant(usd, tee)).toMatchObject({ price: 12.99, compareAtPrice: 16.99 });
    const last = priceCalls(usd).at(-1)!.args as { variants: Record<string, unknown>[] };
    expect(last.variants[0]).not.toHaveProperty('compareAtPrice');
  });

  it('counts items without a base price as skipped and leaves their price alone', async () => {
    await setRule(usd.id, ENDING_99);
    const none = await pricedItem('NOBASE', null, [7, 1]);
    const run = await newRun({ storeIds: [usd.id] });
    await settle();
    expect(shopVariant(usd, none).price).toBe(7);
    expect((await runStores(run!.runId))[0]).toMatchObject({
      status: 'done',
      variants_checked: 1,
      variants_skipped: 1,
      variants_updated: 0,
    });
  });

  it('records the SKUs Shopify refuses and finishes the store', async () => {
    await setRule(usd.id, ENDING_99);
    const tee = await pricedItem('TEE', 10, [9, 1]);
    const cap = await pricedItem('CAP', 20, [9, 1]);
    const original = usd.shop.updateVariantPrices.bind(usd.shop);
    usd.shop.updateVariantPrices = async (productId, variants) => {
      if (productId === shopVariant(usd, cap).productId) {
        return { failed: [{ variantId: variants[0]!.id, message: 'Price is too high' }] };
      }
      return original(productId, variants);
    };
    const run = await newRun({ storeIds: [usd.id] });
    await settle();
    expect(shopVariant(usd, tee).price).toBe(10.99);
    expect((await runStores(run!.runId))[0]).toMatchObject({
      status: 'done',
      variants_updated: 1,
      variants_failed: 1,
      errors: [{ sku: 'CAP', message: 'Price is too high' }],
    });
    expect(await runStatus(run!.runId)).toMatchObject({ status: 'done' });
  });

  it('fails the store at once, without calling Shopify, when the app may not write prices', async () => {
    await setRule(usd.id, ENDING_99);
    await setRule(cop.id, { enabled: true });
    await pricedItem('TEE', 10, [9, 1]);
    await h.db.query(`UPDATE stores SET granted_scopes = $2 WHERE id = $1`, [
      cop.id,
      ['read_products', 'read_inventory', 'write_inventory'],
    ]);
    const run = await newRun();
    expect(run!.stores.find((s) => s.storeId === cop.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('write_products'),
    });
    await settle();
    expect(priceCalls(cop)).toHaveLength(0);
    const rows = await runStores(run!.runId);
    expect(rows.map((r) => r.status)).toEqual(['done', 'failed']);
    expect(await runStatus(run!.runId)).toMatchObject({ status: 'failed' });
  });

  it('stops on an access error from Shopify without marking the store as broken', async () => {
    await setRule(usd.id, ENDING_99);
    await pricedItem('TEE', 10, [9, 1]);
    usd.shop.scopes = ['read_products', 'read_inventory', 'write_inventory', 'read_locations'];
    const run = await newRun({ storeIds: [usd.id] });
    await settle();
    const [row] = await runStores(run!.runId);
    expect(row!.status).toBe('failed');
    expect(row!.error).toContain('didn’t let Store Sync update its prices');
    const { rows } = await h.db.query<{ status: string }>(
      'SELECT status FROM stores WHERE id = $1',
      [usd.id],
    );
    expect(rows[0]!.status).toBe('active');
    const tasks = await h.db.query('SELECT 1 FROM tasks');
    expect(tasks.rowCount).toBe(0); // not retried forever
  });

  it('retries after a network error, and a write that went through is not repeated', async () => {
    await setRule(usd.id, ENDING_99);
    const tee = await pricedItem('TEE', 10, [9, 1]);
    // The write reaches Shopify but the answer is lost.
    usd.shop.failNext('updateVariantPrices', 'throw_after');
    const run = await newRun({ storeIds: [usd.id] });
    await runTasksOnce(h.db, deps(), silentLogger);
    const [waiting] = await runStores(run!.runId);
    expect(waiting).toMatchObject({ status: 'running' });
    expect(waiting!.error).toMatch(/^Trying again/);
    expect(shopVariant(usd, tee).price).toBe(10.99);

    await settle();
    // The retry read 10.99 back: nothing left to write.
    expect(priceCalls(usd)).toHaveLength(1);
    expect((await runStores(run!.runId))[0]).toMatchObject({ status: 'done', error: null });
    expect(await runStatus(run!.runId)).toMatchObject({ status: 'done' });
  });

  it('gives up on a store Shopify can’t be reached for after an hour', async () => {
    await setRule(usd.id, ENDING_99);
    await pricedItem('TEE', 10, [9, 1]);
    const run = await newRun({ storeIds: [usd.id] });
    usd.shop.listVariants = async () => {
      throw new ShopifyApiError('fake network error', 'transient');
    };
    await runTasksOnce(h.db, deps(), silentLogger);
    expect((await runStores(run!.runId))[0]!.status).toBe('running');
    await h.db.query(
      `UPDATE price_run_stores SET started_at = now() - interval '61 minutes' WHERE run_id = $1`,
      [run!.runId],
    );
    await settle();
    const [row] = await runStores(run!.runId);
    expect(row!.status).toBe('failed');
    expect(row!.error).toContain('for an hour');
  });

  it('gives up after an hour on any other error, so the store isn’t left “being updated”', async () => {
    await setRule(usd.id, ENDING_99);
    await pricedItem('TEE', 10, [9, 1]);
    const run = await newRun({ storeIds: [usd.id] });
    usd.shop.listVariants = async () => {
      throw new Error('could not decrypt the access token');
    };
    await runTasksOnce(h.db, deps(), silentLogger);
    expect((await runStores(run!.runId))[0]!.status).toBe('running');
    await h.db.query(
      `UPDATE price_run_stores SET started_at = now() - interval '61 minutes' WHERE run_id = $1`,
      [run!.runId],
    );
    await settle();
    const [row] = await runStores(run!.runId);
    expect(row!.status).toBe('failed');
    expect(row!.error).toContain('could not decrypt the access token');
    expect(await runStatus(run!.runId)).toMatchObject({ status: 'failed' });
  });

  it('ends a paused store’s part as failed instead of leaving it queued', async () => {
    await setRule(usd.id, ENDING_99);
    await pricedItem('TEE', 10, [9, 1]);
    const run = await newRun({ storeIds: [usd.id] });
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [usd.id]);
    await settle();
    const [row] = await runStores(run!.runId);
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.error).toContain('is paused');
    expect(priceCalls(usd)).toHaveLength(0);
  });

  it('writes one store at a time: a second run waits for the first', async () => {
    await setRule(usd.id, ENDING_99);
    const tee = await pricedItem('TEE', 10, [9, 1]);
    const run = await newRun({ storeIds: [usd.id] });
    // Another worker is writing this store's prices.
    const other = await h.db.connect();
    await other.query('SELECT pg_advisory_lock($1, $2::integer)', [
      LOCK_CLASSES.priceApply,
      usd.id,
    ]);
    try {
      await runTasksOnce(h.db, deps(), silentLogger);
      expect((await runStores(run!.runId))[0]!.status).toBe('queued');
      expect(shopVariant(usd, tee).price).toBe(9);
      const { rows } = await h.db.query<{ last_error: string }>('SELECT last_error FROM tasks');
      expect(rows[0]!.last_error).toContain('still running');
    } finally {
      await other.query('SELECT pg_advisory_unlock($1, $2::integer)', [
        LOCK_CLASSES.priceApply,
        usd.id,
      ]);
      other.release();
    }
    await settle();
    expect(shopVariant(usd, tee).price).toBe(10.99);
  });

  it('finishes the run when its last store finishes', async () => {
    await setRule(usd.id, ENDING_99);
    await setRule(cop.id, { ...ENDING_99, round_step: 1000, round_ending: 900 });
    const tee = await pricedItem('TEE', 10, [9, 1]);
    const run = await newRun();
    await applyPrices(deps(), { runId: run!.runId, storeId: usd.id });
    expect(await runStatus(run!.runId)).toMatchObject({ status: 'running', finished_at: null });
    await applyPrices(deps(), { runId: run!.runId, storeId: cop.id });
    expect(await runStatus(run!.runId)).toMatchObject({ status: 'done' });
    expect(shopVariant(cop, tee).price).toBe(41900);
    // Running a finished store's task again does nothing.
    await applyPrices(deps(), { runId: run!.runId, storeId: cop.id });
    expect(priceCalls(cop)).toHaveLength(1);
  });

  it('puts back a store’s own price after a sale, unless it was changed in Shopify meanwhile', async () => {
    const kept = await pricedItem('KEPT', null, [15, 1]);
    const changed = await pricedItem('CHANGED', null, [13, 1]);
    const restore = new Map([
      [
        usd.id,
        [
          { itemId: kept.itemId, price: 20, compareAtPrice: 25, salePrice: 15 },
          { itemId: changed.itemId, price: 20, compareAtPrice: null, salePrice: 15 },
        ],
      ],
    ]);
    const run = await newRun({ storeIds: [usd.id], restore });
    expect(run!.stores).toMatchObject([{ storeId: usd.id, status: 'queued' }]);
    await settle();
    expect(shopVariant(usd, kept)).toMatchObject({ price: 20, compareAtPrice: 25 });
    expect(shopVariant(usd, changed).price).toBe(13);
    expect((await runStores(run!.runId))[0]).toMatchObject({
      variants_checked: 2,
      variants_updated: 1,
      variants_skipped: 1,
    });
  });

  it('alerts when a scheduled update can’t reach a store, and clears it once one does', async () => {
    await setRule(usd.id, ENDING_99);
    await pricedItem('TEE', 10, [9, 1]);
    const { rows } = await h.db.query<{ id: number }>(
      `INSERT INTO price_schedules (name, kind, starts_at, ends_at, percent_off, item_ids)
       VALUES ('Summer', 'sale', now() - interval '2 days', now() - interval '1 day', 10, '{}')
       RETURNING id`,
    );
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [usd.id]);
    await newRun({ storeIds: [usd.id], scheduleId: rows[0]!.id });
    const alerts = await h.db.query<{ kind: string; message: string; resolved_at: Date | null }>(
      'SELECT kind, message, resolved_at FROM alerts',
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0]!.kind).toBe('price_update_failed');
    expect(alerts.rows[0]!.message).toContain('the end of the sale “Summer”');
    expect(alerts.rows[0]!.message).toContain('is paused');

    await h.db.query(`UPDATE stores SET status = 'active' WHERE id = $1`, [usd.id]);
    await newRun({ storeIds: [usd.id] });
    await settle();
    const after = await h.db.query<{ resolved_at: Date | null }>('SELECT resolved_at FROM alerts');
    expect(after.rows[0]!.resolved_at).not.toBeNull();
  });
});
