import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import type { ShopifyAdmin } from '../src/shopify/types.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import { SecretBox } from '../src/util/crypto.js';
import { Harness, silentLogger } from './helpers/harness.js';
import type { TestItem, TestStore } from './helpers/harness.js';

/** /api/prices through the real server (buildServer + inject), against fake stores. */

const AUTH = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;
const ALL_SCOPES = ['read_products', 'write_products', 'read_inventory', 'write_inventory'];

let h: Harness;
let app: FastifyInstance;
let usd: TestStore;
let cop: TestStore;

beforeEach(async () => {
  h = await Harness.create(2);
  [usd, cop] = h.stores as [TestStore, TestStore];
  cop.shop.currencyCode = 'COP';
  for (const s of h.stores) s.shop.scopes = [...ALL_SCOPES, 'read_locations'];
  await h.db.query(
    `UPDATE stores SET name = CASE WHEN id = $1 THEN 'Northwind' ELSE 'Harbor' END,
            currency_code = CASE WHEN id = $1 THEN 'USD' ELSE 'COP' END,
            exchange_rate = CASE WHEN id = $1 THEN 1 ELSE 4100 END, granted_scopes = $2`,
    [usd.id, ALL_SCOPES],
  );
  app = await buildServer({
    db: h.db,
    secrets: new SecretBox(Buffer.alloc(32, 7).toString('base64')),
    shopify: { forStore: (id) => h.registry.forStore(id), invalidate: () => undefined },
    createAdmin: () => ({}) as ShopifyAdmin,
    logger: silentLogger,
    publicUrl: 'https://sync.example.com',
    adminUsername: 'admin',
    adminPassword: 'correct-horse-battery',
  });
});

afterEach(async () => {
  await app.close();
  await h.close();
});

const api = async (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) => {
  const res = await app.inject({
    method,
    url,
    payload: payload as object,
    headers: { authorization: AUTH, 'x-requested-with': 'store-sync' },
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined };
};

function shopVariant(store: TestStore, item: TestItem) {
  const inventoryItemId = item.inventoryItemIds.get(store.id)!;
  return store.shop.variants.find((v) => v.inventoryItemId === inventoryItemId)!;
}

async function item(
  sku: string,
  prices: { base?: number | null; cost?: number | null; usd?: number | null; cop?: number | null },
) {
  const it = await h.addItem(sku, [5, 5]);
  await h.db.query(`UPDATE items SET title = $2, base_price = $3, cost = $4 WHERE id = $1`, [
    it.itemId,
    `${sku} title`,
    prices.base ?? null,
    prices.cost ?? null,
  ]);
  for (const [store, price] of [
    [usd, prices.usd ?? null],
    [cop, prices.cop ?? null],
  ] as const) {
    shopVariant(store, it).price = price;
    await h.db.query('UPDATE variants SET price = $3 WHERE store_id = $1 AND item_id = $2', [
      store.id,
      it.itemId,
      price,
    ]);
  }
  return it;
}

const RULE = {
  enabled: true,
  multiplier: 1,
  addAmount: 0,
  roundMode: 'ending',
  roundStep: 1,
  roundEnding: 0.99,
  roundDirection: 'up',
  compareAtMode: 'from_base',
  compareAtMarkup: 1,
};

async function settle() {
  const deps = { db: h.db, shopify: h.registry, logger: silentLogger, publicUrl: 'x' };
  for (let i = 0; i < 10; i++) {
    if ((await runTasksOnce(h.db, deps, silentLogger, 10)) === 0) return;
  }
}

describe('price list', () => {
  it('lists each item with every store’s price now, its target and margin', async () => {
    await api('PUT', `/api/prices/rules/${usd.id}`, RULE);
    await item('TEE', { base: 10, cost: 4, usd: 9.5, cop: 41000 });
    await item('CAP', { base: null, usd: 15, cop: null });
    const res = await api('GET', '/api/prices');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 2,
      page: 1,
      baseCurrency: 'USD',
      stores: [
        { id: usd.id, name: 'Northwind', currencyCode: 'USD', ruleEnabled: true, canUpdate: true },
        { id: cop.id, name: 'Harbor', currencyCode: 'COP', exchangeRate: 4100, ruleEnabled: false },
      ],
      lastRun: null,
      activeRunId: null,
    });
    const [cap, tee] = res.body.items;
    expect(tee).toMatchObject({ sku: 'TEE', basePrice: 10, cost: 4 });
    expect(tee.stores[0]).toMatchObject({
      storeId: usd.id,
      sold: true,
      current: { price: 9.5, compareAtPrice: null },
      target: { status: 'ok', source: 'rule', price: 10.99 },
      source: 'rule',
      differs: true,
    });
    expect(tee.stores[0].margin).toBeCloseTo((10.99 - 4) / 10.99);
    expect(tee.stores[1]).toMatchObject({
      target: { status: 'none', reason: 'rule_disabled' },
      source: null,
      differs: false,
    });
    // Margin on what the store charges when there is no target: 41,000 vs 4 × 4,100.
    expect(tee.stores[1].margin).toBeCloseTo(0.6);
    expect(cap.stores[0]).toMatchObject({ target: { status: 'none', reason: 'no_base_price' } });
  });

  it('filters: prices that will change, missing base prices, fixed prices; search and pages', async () => {
    await api('PUT', `/api/prices/rules/${usd.id}`, RULE);
    const tee = await item('TEE', { base: 10, usd: 9.5 });
    await item('CAP', { base: 20, usd: 20.99 });
    const sock = await item('SOCK', { base: null, usd: 5 });
    await api('PUT', `/api/prices/overrides/${cop.id}/${sock.itemId}`, { price: 30000 });
    const skus = async (query: string) =>
      (await api('GET', `/api/prices${query}`)).body.items.map((i: any) => i.sku);
    expect(await skus('?filter=changes')).toEqual(['TEE']);
    expect(await skus('?filter=missing_base')).toEqual(['SOCK']);
    expect(await skus('?filter=overrides')).toEqual(['SOCK']);
    expect(await skus(`?filter=overrides&storeId=${usd.id}`)).toEqual([]);
    expect(await skus('?search=ca')).toEqual(['CAP']);
    const page = await api('GET', '/api/prices?pageSize=2&page=2');
    expect(page.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page.body.items.map((i: any) => i.sku)).toEqual(['TEE']);
    const one = await api('GET', `/api/prices?storeId=${cop.id}`);
    expect(one.body.stores.map((s: any) => s.id)).toEqual([cop.id]);
    expect(one.body.items[0].stores).toHaveLength(1);
    expect((await api('GET', '/api/prices?storeId=999')).status).toBe(404);
    expect((await api('GET', '/api/prices?filter=nope')).status).toBe(400);
    expect(tee.itemId).toBeGreaterThan(0);
  });

  it('shows one item with its running and scheduled sales', async () => {
    const tee = await item('TEE', { base: 10, usd: 10 });
    await api('POST', '/api/prices/schedules', {
      kind: 'sale',
      name: 'Weekend',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      itemIds: [tee.itemId],
      percentOff: 15,
    });
    const res = await api('GET', `/api/prices/items/${tee.itemId}`);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ sku: 'TEE', basePrice: 10 });
    expect(res.body.schedules).toEqual([
      expect.objectContaining({ name: 'Weekend', status: 'scheduled', percentOff: 15 }),
    ]);
    expect((await api('GET', '/api/prices/items/99999')).status).toBe(404);
  });
});

describe('editing base prices and costs', () => {
  it('sets and clears one item’s base price, compare-at price and cost', async () => {
    const tee = await item('TEE', { base: 10 });
    const res = await api('PATCH', `/api/prices/items/${tee.itemId}`, {
      basePrice: 12.5,
      baseCompareAtPrice: 15,
      cost: 4.2,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ basePrice: 12.5, baseCompareAtPrice: 15, cost: 4.2 });
    const { rows } = await h.db.query<{ cost_updated_at: Date | null }>(
      'SELECT cost_updated_at FROM items WHERE id = $1',
      [tee.itemId],
    );
    expect(rows[0]!.cost_updated_at).not.toBeNull();
    const cleared = await api('PATCH', `/api/prices/items/${tee.itemId}`, {
      baseCompareAtPrice: null,
      cost: null,
    });
    expect(cleared.body).toMatchObject({ basePrice: 12.5, baseCompareAtPrice: null, cost: null });
  });

  it('refuses a compare-at price not above the base price, negative amounts, unknown items', async () => {
    const tee = await item('TEE', { base: 10 });
    const low = await api('PATCH', `/api/prices/items/${tee.itemId}`, { baseCompareAtPrice: 9 });
    expect(low.status).toBe(400);
    expect(low.body.error).toContain('must be higher than the price');
    expect((await api('PATCH', `/api/prices/items/${tee.itemId}`, { basePrice: -1 })).status).toBe(
      400,
    );
    expect((await api('PATCH', '/api/prices/items/99999', { basePrice: 1 })).status).toBe(404);
  });

  it('refuses ids too big to be ids with a 400, not a database error', async () => {
    const huge = 1e20;
    const checks = [
      await api('POST', '/api/prices/apply', { itemIds: [huge] }),
      await api('POST', '/api/prices/items/bulk', {
        itemIds: [huge],
        op: 'set',
        field: 'cost',
        value: 1,
      }),
      await api('POST', '/api/prices/base-from-store', { storeId: huge }),
      await api('GET', '/api/prices/apply/preview?itemIds=100000000000000000000'),
      await api('GET', '/api/prices?storeId=100000000000000000000'),
    ];
    expect(checks.map((c) => c.status)).toEqual([400, 400, 400, 400, 400]);
  });

  it('refuses a bulk change whose result is too big to store, changing nothing', async () => {
    // 90 billion + 1,000,000% doesn't fit in the column (numeric(18,4)).
    const tee = await item('TEE', { base: 90_000_000_000 });
    const res = await api('POST', '/api/prices/items/bulk', {
      itemIds: [tee.itemId],
      op: 'percent',
      field: 'basePrice',
      value: 1_000_000,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('TEE');
    const { rows } = await h.db.query<{ base_price: number }>(
      'SELECT base_price FROM items WHERE id = $1',
      [tee.itemId],
    );
    expect(rows[0]!.base_price).toBe(90_000_000_000);
  });

  it('changes many items at once by a percentage, with rounding', async () => {
    const tee = await item('TEE', { base: 10 });
    const cap = await item('CAP', { base: 19.99 });
    const sock = await item('SOCK', { base: null });
    const res = await api('POST', '/api/prices/items/bulk', {
      itemIds: [tee.itemId, cap.itemId, sock.itemId],
      op: 'percent',
      field: 'basePrice',
      value: 10,
      rounding: { mode: 'ending', step: 1, ending: 0.99, direction: 'up' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, skipped: 1, unchanged: 0 });
    const list = await api('GET', '/api/prices');
    expect(list.body.items.map((i: any) => [i.sku, i.basePrice])).toEqual([
      ['CAP', 21.99],
      ['SOCK', null],
      ['TEE', 11.99],
    ]);
  });

  it('changes every item matching a filter, and sets costs', async () => {
    await item('TEE', { base: 10 });
    await item('CAP', { base: null });
    const res = await api('POST', '/api/prices/items/bulk', {
      filter: { filter: 'missing_base' },
      op: 'set',
      field: 'basePrice',
      value: 8,
    });
    expect(res.body).toMatchObject({ updated: 1 });
    const costs = await api('POST', '/api/prices/items/bulk', {
      filter: { search: 'tee' },
      op: 'set',
      field: 'cost',
      value: 3.5,
    });
    expect(costs.body).toMatchObject({ updated: 1 });
    const list = await api('GET', '/api/prices');
    expect(list.body.items.map((i: any) => [i.sku, i.basePrice, i.cost])).toEqual([
      ['CAP', 8, null],
      ['TEE', 10, 3.5],
    ]);
  });

  it('refuses a bulk change that would make a price negative, changing nothing', async () => {
    const tee = await item('TEE', { base: 10 });
    const cap = await item('CAP', { base: 2 });
    const res = await api('POST', '/api/prices/items/bulk', {
      itemIds: [tee.itemId, cap.itemId],
      op: 'add',
      field: 'basePrice',
      value: -5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This would make the price negative for CAP. Nothing was changed.');
    const list = await api('GET', '/api/prices');
    expect(list.body.items.map((i: any) => i.basePrice)).toEqual([2, 10]);
    const noRounding = await api('POST', '/api/prices/items/bulk', {
      itemIds: [tee.itemId],
      op: 'round',
      field: 'basePrice',
    });
    expect(noRounding.status).toBe(400);
    const both = await api('POST', '/api/prices/items/bulk', {
      itemIds: [tee.itemId],
      filter: { filter: 'all' },
      op: 'set',
      field: 'basePrice',
      value: 1,
    });
    expect(both.status).toBe(400);
  });

  it('copies a store’s prices into base prices with its exchange rate', async () => {
    const tee = await item('TEE', { base: null, usd: 1, cop: 41000 });
    await h.db.query(
      'UPDATE variants SET compare_at_price = 49200 WHERE store_id = $1 AND item_id = $2',
      [cop.id, tee.itemId],
    );
    await item('CAP', { base: 5, cop: 82000 });
    await item('SOCK', { base: null, cop: null });
    const res = await api('POST', '/api/prices/base-from-store', { storeId: cop.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1, skipped: 1 });
    let list = await api('GET', '/api/prices');
    expect(list.body.items.map((i: any) => [i.sku, i.basePrice, i.baseCompareAtPrice])).toEqual([
      ['CAP', 5, null],
      ['SOCK', null, null],
      ['TEE', 10, 12],
    ]);
    await api('POST', '/api/prices/base-from-store', { storeId: cop.id, onlyMissing: false });
    list = await api('GET', '/api/prices');
    expect(list.body.items[0].basePrice).toBe(20);
    expect((await api('POST', '/api/prices/base-from-store', { storeId: 999 })).status).toBe(404);
  });
});

describe('rules', () => {
  it('saves a store’s rule and lists every store’s, with defaults for the others', async () => {
    await item('TEE', { base: 10 });
    const saved = await api('PUT', `/api/prices/rules/${cop.id}`, {
      ...RULE,
      multiplier: 1.3,
      roundStep: 1000,
      roundEnding: 900,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      storeId: cop.id,
      saved: true,
      currencyCode: 'COP',
      rule: { enabled: true, multiplier: 1.3, roundStep: 1000, roundEnding: 900 },
      samples: [{ sku: 'TEE', basePrice: 10 }],
    });
    const all = await api('GET', '/api/prices/rules');
    expect(all.body.rules.map((r: any) => [r.storeId, r.saved, r.rule.enabled])).toEqual([
      [usd.id, false, false],
      [cop.id, true, true],
    ]);
    const examples = await api('GET', `/api/prices/rules/${cop.id}/examples?prices=10,0.05`);
    // 10 × 4,100 × 1.3 = 53,300 → 53,900; 0.05 × 4,100 × 1.3 = 266.5 → 900.
    expect(examples.body.examples).toEqual([
      { basePrice: 10, price: 53900 },
      { basePrice: 0.05, price: 900 },
    ]);
  });

  it('refuses an ending that isn’t below the step, and unknown stores', async () => {
    const res = await api('PUT', `/api/prices/rules/${cop.id}`, {
      ...RULE,
      roundStep: 1,
      roundEnding: 1.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('The ending must be smaller than the step');
    // Not using endings: whatever was typed there is ignored.
    const multiple = await api('PUT', `/api/prices/rules/${cop.id}`, {
      ...RULE,
      roundMode: 'multiple',
      roundStep: 1,
      roundEnding: 1.5,
    });
    expect(multiple.status).toBe(200);
    expect(multiple.body.rule.roundEnding).toBe(0);
    expect((await api('PUT', '/api/prices/rules/999', RULE)).status).toBe(404);
    expect((await api('GET', '/api/prices/rules/999')).status).toBe(404);
  });
});

describe('fixed prices', () => {
  it('sets, replaces and removes a fixed price; it takes an item out of a running sale', async () => {
    const tee = await item('TEE', { base: 10, usd: 10, cop: 41000 });
    const set = await api('PUT', `/api/prices/overrides/${cop.id}/${tee.itemId}`, {
      price: 39900,
      compareAtPrice: 45900,
      note: 'Launch',
    });
    expect(set.status).toBe(200);
    expect(set.body.stores[1]).toMatchObject({
      source: 'override',
      target: { status: 'ok', price: 39900, compareAtPrice: 45900 },
      override: { note: 'Launch', scheduleId: null },
    });
    await h.db.query(
      `INSERT INTO price_schedules (name, kind, starts_at, ends_at, percent_off, item_ids, status)
       VALUES ('Flash', 'sale', now(), now() + interval '1 day', 10, $1, 'active')`,
      [[tee.itemId]],
    );
    await h.db.query(
      'UPDATE price_overrides SET schedule_id = (SELECT max(id) FROM price_schedules)',
    );
    const onSale = await api('GET', `/api/prices/items/${tee.itemId}`);
    expect(onSale.body.item.stores[1]).toMatchObject({
      source: 'sale',
      override: { scheduleName: 'Flash' },
    });
    const mine = await api('PUT', `/api/prices/overrides/${cop.id}/${tee.itemId}`, {
      price: 35000,
    });
    expect(mine.body.stores[1]).toMatchObject({
      source: 'override',
      override: { scheduleId: null, price: 35000 },
    });
    const removed = await api('DELETE', `/api/prices/overrides/${cop.id}/${tee.itemId}`);
    expect(removed.body.stores[1].override).toBeNull();
    expect((await api('DELETE', `/api/prices/overrides/${cop.id}/${tee.itemId}`)).status).toBe(404);
  });

  it('refuses a compare-at price not above the price, and unknown stores or items', async () => {
    const tee = await item('TEE', { base: 10 });
    const res = await api('PUT', `/api/prices/overrides/${cop.id}/${tee.itemId}`, {
      price: 100,
      compareAtPrice: 100,
    });
    expect(res.status).toBe(400);
    expect((await api('PUT', `/api/prices/overrides/999/${tee.itemId}`, { price: 1 })).status).toBe(
      404,
    );
    expect((await api('PUT', `/api/prices/overrides/${cop.id}/999`, { price: 1 })).status).toBe(
      404,
    );
  });
});

describe('updating the stores', () => {
  it('previews how many prices change per store, big drops, and what can’t be updated', async () => {
    await api('PUT', `/api/prices/rules/${usd.id}`, RULE);
    await item('TEE', { base: 10, usd: 9.5 });
    await item('CAP', { base: 10, usd: 25 });
    await item('SOCK', { base: null, usd: 5 });
    const res = await api('GET', '/api/prices/apply/preview');
    expect(res.status).toBe(200);
    const [n, c] = res.body.stores;
    expect(n).toMatchObject({
      storeName: 'Northwind',
      canUpdate: true,
      reason: null,
      checked: 2,
      changes: 2,
      increases: 1,
      decreases: 1,
      missingBase: 1,
      bigDropCount: 1,
      bigDrops: [{ sku: 'CAP', from: 25, to: 10.99 }],
    });
    expect(c).toMatchObject({ storeName: 'Harbor', canUpdate: false });
    expect(c.reason).toContain('doesn’t manage prices');
  });

  it('starts a run, writes the prices, and records it in the history', async () => {
    await api('PUT', `/api/prices/rules/${usd.id}`, RULE);
    const tee = await item('TEE', { base: 10, usd: 9.5 });
    const res = await api('POST', '/api/prices/apply', { storeIds: [usd.id] });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      runId: expect.any(Number),
      stores: [{ storeId: usd.id, status: 'queued', error: null }],
    });
    const busy = await api('POST', '/api/prices/apply', { storeIds: [usd.id] });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toContain('already being updated in “Northwind”');
    expect((await api('GET', '/api/prices')).body.activeRunId).toBe(res.body.runId);

    await settle();
    expect(shopVariant(usd, tee).price).toBe(10.99);
    const run = await api('GET', `/api/prices/runs/${res.body.runId}`);
    expect(run.body).toMatchObject({
      reason: 'manual',
      status: 'done',
      itemCount: null,
      stores: [{ storeName: 'Northwind', status: 'done', checked: 1, updated: 1, failed: 0 }],
    });
    const runs = await api('GET', '/api/prices/runs?limit=5');
    expect(runs.body).toHaveLength(1);
    expect((await api('GET', '/api/prices')).body).toMatchObject({
      lastRun: { id: res.body.runId, status: 'done' },
      activeRunId: null,
    });
    expect((await api('GET', '/api/prices/runs/999')).status).toBe(404);
  });

  it('refuses when no chosen store has prices to manage, or none may be updated', async () => {
    await item('TEE', { base: 10, usd: 9.5 });
    const none = await api('POST', '/api/prices/apply', {});
    expect(none.status).toBe(409);
    expect(none.body.error).toContain('doesn’t manage prices in these stores');

    await api('PUT', `/api/prices/rules/${usd.id}`, RULE);
    await h.db.query('UPDATE stores SET granted_scopes = $2 WHERE id = $1', [
      usd.id,
      ['read_products', 'write_inventory'],
    ]);
    const denied = await api('POST', '/api/prices/apply', { storeIds: [usd.id] });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toContain('write_products');
    const runs = await h.db.query('SELECT 1 FROM price_runs');
    expect(runs.rowCount).toBe(0);
  });

  it('lets a store with sale prices still to put back be updated, though its rule is off', async () => {
    const tee = await item('TEE', { base: 10, usd: 10, cop: 32000 });
    // A sale's end couldn't reach Harbor (paused then): its price is still the sale price.
    const { rows } = await h.db.query<{ id: number }>(
      `INSERT INTO price_runs (reason, status, finished_at) VALUES ('manual', 'failed', now())
       RETURNING id`,
    );
    await h.db.query(
      `INSERT INTO price_run_stores (run_id, store_id, status, error, restore_prices, finished_at)
       VALUES ($1, $2, 'failed', 'paused', $3, now())`,
      [
        rows[0]!.id,
        cop.id,
        JSON.stringify([
          { itemId: tee.itemId, price: 40000, compareAtPrice: null, salePrice: 32000 },
        ]),
      ],
    );
    const preview = await api('GET', '/api/prices/apply/preview');
    const harbor = preview.body.stores.find((s: { storeId: number }) => s.storeId === cop.id);
    expect(harbor).toMatchObject({ canUpdate: true, reason: null, restores: 1 });
    const res = await api('POST', '/api/prices/apply', { storeIds: [cop.id] });
    expect(res.status).toBe(202);
    await settle();
    expect(shopVariant(cop, tee).price).toBe(40000);
  });

  it('updates the stores it can and reports the others', async () => {
    await api('PUT', `/api/prices/rules/${usd.id}`, RULE);
    await api('PUT', `/api/prices/rules/${cop.id}`, RULE);
    await item('TEE', { base: 10, usd: 9.5, cop: 1 });
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [cop.id]);
    const res = await api('POST', '/api/prices/apply', {});
    expect(res.status).toBe(202);
    expect(res.body.stores).toEqual([
      { storeId: usd.id, storeName: 'Northwind', status: 'queued', error: null },
      {
        storeId: cop.id,
        storeName: 'Harbor',
        status: 'failed',
        error: '“Harbor” is paused. Resume it on its page, then update prices again.',
      },
    ]);
  });
});

describe('schedules', () => {
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
  const inTwoHours = () => new Date(Date.now() + 7_200_000).toISOString();

  it('creates, lists, edits and cancels a sale', async () => {
    const tee = await item('TEE', { base: 10, usd: 10 });
    const created = await api('POST', '/api/prices/schedules', {
      kind: 'sale',
      name: 'Weekend',
      startsAt: inAnHour(),
      endsAt: inTwoHours(),
      storeIds: [usd.id],
      itemIds: [tee.itemId],
      percentOff: 15.555,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'sale',
      status: 'scheduled',
      percentOff: 15.56,
      showCompareAt: true,
      stores: [{ id: usd.id, name: 'Northwind' }],
      items: [{ sku: 'TEE' }],
    });
    const id = created.body.id;
    const edited = await api('PATCH', `/api/prices/schedules/${id}`, {
      name: 'Long weekend',
      storeIds: null,
    });
    expect(edited.body).toMatchObject({ name: 'Long weekend', storeIds: null, percentOff: 15.56 });
    expect(edited.body.stores).toHaveLength(2);
    expect((await api('GET', '/api/prices/schedules')).body).toHaveLength(1);
    const cancelled = await api('POST', `/api/prices/schedules/${id}/cancel`);
    expect(cancelled.body).toMatchObject({ schedule: { status: 'cancelled' }, runId: null });
    expect((await api('PATCH', `/api/prices/schedules/${id}`, { name: 'x' })).status).toBe(409);
    expect((await api('GET', '/api/prices/schedules/999')).status).toBe(404);
  });

  it('validates sales: dates, percentage, products, overlaps', async () => {
    const tee = await item('TEE', { base: 10, usd: 10 });
    const base = {
      kind: 'sale',
      name: 'Weekend',
      startsAt: inAnHour(),
      endsAt: inTwoHours(),
      itemIds: [tee.itemId],
      percentOff: 20,
    };
    const check = async (body: object, status: number, message?: string) => {
      const res = await api('POST', '/api/prices/schedules', body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      if (message) expect(res.body.error).toContain(message);
    };
    await check({ ...base, endsAt: base.startsAt }, 400, 'The sale must end after it starts.');
    await check({ ...base, percentOff: 0 }, 400);
    await check({ ...base, percentOff: 100 }, 400);
    await check({ ...base, itemIds: [] }, 400);
    await check({ ...base, startsAt: 'tomorrow' }, 400);
    await check({ ...base, name: ' ' }, 400);
    await check(base, 201);
    await check({ ...base, name: 'Again' }, 409, 'overlaps “Weekend”');
  });

  it('creates a base price change', async () => {
    const tee = await item('TEE', { base: 10, usd: 10 });
    const res = await api('POST', '/api/prices/schedules', {
      kind: 'base_change',
      name: 'January prices',
      startsAt: inAnHour(),
      changes: [{ itemId: tee.itemId, basePrice: 12 }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'base_change',
      endsAt: null,
      changes: [{ sku: 'TEE', basePrice: 12, baseCompareAtPrice: null, currentBasePrice: 10 }],
    });
  });
});
