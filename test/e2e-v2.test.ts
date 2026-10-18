import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRICING_JOBS } from '../src/pricing/jobs.js';
import { enqueuePoolLevels } from '../src/sync/queue.js';
import { enqueueTask } from '../src/tasks/queue.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import type { TaskDeps } from '../src/tasks/types.js';
import { harnessApp, type ApiCall } from './helpers/app.js';
import { Harness, silentLogger, type TestStore } from './helpers/harness.js';

/**
 * Version 2 end to end, through the dashboard API and the real tasks, with two fake stores:
 * Northwind (USD, no price rule, no safety buffer) and Harbor (COP at 4,000 to the dollar, a price
 * rule of ×1.1 ending in 900, a safety buffer of 2). One product goes the whole way: written in the
 * catalog, priced, published, bought from a supplier, sold, reported, reordered, and put on sale.
 *
 * The steps run in order and build on each other (like a merchant's week).
 */

let h: Harness;
let app: FastifyInstance;
let api: ApiCall;
let northwind: TestStore;
let harbor: TestStore;
let deps: TaskDeps;

/** Item ids by SKU, filled in step (a). */
const item: Record<'TEE-S' | 'TEE-M', number> = { 'TEE-S': 0, 'TEE-M': 0 };
let productId = 0;
let supplierId = 0;
let firstOrder = 0;

beforeAll(async () => {
  h = await Harness.create(2, { buffers: [0, 2] });
  [northwind, harbor] = h.stores as [TestStore, TestStore];
  ({ app, api } = await harnessApp(h));
  deps = { db: h.db, shopify: h.registry, logger: silentLogger, publicUrl: 'https://sync.test' };
  harbor.shop.currencyCode = 'COP';
  for (const s of h.stores)
    s.shop.scopes.push('write_products', 'write_publications', 'read_orders');
  await h.db.query(
    `UPDATE stores SET currency_code = CASE WHEN id = $1 THEN 'USD' ELSE 'COP' END,
            exchange_rate = CASE WHEN id = $1 THEN 1 ELSE 4000 END`,
    [northwind.id],
  );
});

afterAll(async () => {
  await app.close();
  await h.close();
});

/** Runs every queued task (retries included) and the stock sync until nothing is left. */
async function settle() {
  for (let i = 0; i < 30; i++) {
    await h.db.query('UPDATE tasks SET run_after = now() WHERE lease_token IS NULL');
    const n = await runTasksOnce(h.db, deps, silentLogger, 20);
    await h.drain();
    if (n === 0) return;
  }
  throw new Error('tasks did not settle');
}

const ok = async (method: Parameters<ApiCall>[0], url: string, body?: unknown) => {
  const res = await api(method, url, body);
  expect(res.status, `${method} ${url}: ${res.text}`).toBeLessThan(300);
  return res.body;
};

/** A store's variant of a SKU (Shopify's side). */
const variantOf = (s: TestStore, sku: string) => s.shop.variants.find((v) => v.sku === sku)!;
const shows = (s: TestStore, sku: string) =>
  s.shop.level(variantOf(s, sku).inventoryItemId, s.locationId);
const shared = async (sku: keyof typeof item) =>
  (
    await h.db.query<{ quantity: number | null }>(
      'SELECT quantity FROM pool_levels WHERE item_id = $1',
      [item[sku]],
    )
  ).rows[0]!.quantity;
const cost = async (sku: keyof typeof item) =>
  (await h.db.query<{ cost: number | null }>('SELECT cost FROM items WHERE id = $1', [item[sku]]))
    .rows[0]!.cost;

/** A sale in Shopify: the order, and the stock it takes (with the live update it sends). */
async function sell(s: TestStore, lines: { sku: keyof typeof item; quantity: number }[]) {
  s.shop.addOrder({
    lines: lines.map((l) => ({ variantId: variantOf(s, l.sku).variantId, quantity: l.quantity })),
  });
  for (const l of lines) {
    s.shop.placeOrder(variantOf(s, l.sku).inventoryItemId, s.locationId, l.quantity);
  }
  const { rows } = await h.db.query<{ id: number }>(
    'SELECT id FROM pool_levels WHERE item_id = ANY($1::bigint[])',
    [lines.map((l) => item[l.sku])],
  );
  await enqueuePoolLevels(
    h.db,
    rows.map((r) => r.id),
    'webhook',
  );
}

/** Receives quantities on a purchase order, by SKU. */
async function receive(orderId: number, quantities: Partial<Record<keyof typeof item, number>>) {
  const order = await ok('GET', `/api/purchasing/orders/${orderId}`);
  return ok('POST', `/api/purchasing/orders/${orderId}/receive`, {
    requestId: randomUUID(),
    lines: order.lines
      .filter((l: any) => quantities[l.sku as keyof typeof item])
      .map((l: any) => ({ lineId: l.id, quantity: quantities[l.sku as keyof typeof item] })),
  });
}

async function openReorderAlerts() {
  const { rows } = await h.db.query<{ item_id: number; message: string }>(
    `SELECT item_id, message FROM alerts WHERE kind = 'reorder' AND resolved_at IS NULL ORDER BY id`,
  );
  return rows;
}

describe('version 2 end to end', () => {
  it('(a) a catalog product with a price rule is published to both stores and syncs at 0', async () => {
    await ok('PUT', `/api/prices/rules/${harbor.id}`, {
      enabled: true,
      multiplier: 1.1,
      addAmount: 0,
      roundMode: 'ending',
      roundStep: 1000,
      roundEnding: 900,
      roundDirection: 'up',
      compareAtMode: 'none',
      compareAtMarkup: 1,
    });
    const created = await ok('POST', '/api/catalog/products', {
      title: 'Linen tee',
      status: 'ACTIVE',
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { sku: 'TEE-S', optionValues: ['S'], basePrice: 20 },
        { sku: 'TEE-M', optionValues: ['M'], basePrice: 24 },
      ],
    });
    productId = created.id;
    for (const v of created.variants) item[v.sku as keyof typeof item] = v.itemId;
    // Not in any store yet: not published, not waiting to start.
    const before = await ok('GET', `/api/items/${item['TEE-S']}`);
    expect(before).toMatchObject({ notPublished: true, catalogProduct: { id: productId } });

    await ok('POST', `/api/catalog/products/${productId}/publish`, {
      storeIds: [northwind.id, harbor.id],
    });
    await settle();

    const product = await ok('GET', `/api/catalog/products/${productId}`);
    expect(product.stores.map((s: any) => s.state)).toEqual(['published', 'published']);
    // Northwind has no rule: the base price (×1). Harbor: 20 × 4,000 × 1.1 = 88,000 → 88,900.
    expect(['TEE-S', 'TEE-M'].map((sku) => variantOf(northwind, sku).price)).toEqual([20, 24]);
    expect(['TEE-S', 'TEE-M'].map((sku) => variantOf(harbor, sku).price)).toEqual([
      88_900, 105_900,
    ]);
    // Linked to the catalog's items, and syncing at 0 everywhere.
    const { rows: linked } = await h.db.query<{ store_id: number; sku: string; item_id: number }>(
      `SELECT store_id, sku, item_id FROM variants WHERE deleted_at IS NULL ORDER BY store_id, sku`,
    );
    expect(linked).toEqual([
      { store_id: northwind.id, sku: 'TEE-M', item_id: item['TEE-M'] },
      { store_id: northwind.id, sku: 'TEE-S', item_id: item['TEE-S'] },
      { store_id: harbor.id, sku: 'TEE-M', item_id: item['TEE-M'] },
      { store_id: harbor.id, sku: 'TEE-S', item_id: item['TEE-S'] },
    ]);
    expect([await shared('TEE-S'), await shared('TEE-M')]).toEqual([0, 0]);
    for (const s of h.stores) expect([shows(s, 'TEE-S'), shows(s, 'TEE-M')]).toEqual([0, 0]);
    const after = await ok('GET', `/api/items/${item['TEE-S']}`);
    expect(after.notPublished).toBe(false);
  });

  it('(b) a purchase order received in part raises the shared stock in both stores, and the cost', async () => {
    supplierId = (await ok('POST', '/api/purchasing/suppliers', { name: 'Acme', leadTimeDays: 7 }))
      .id;
    // Acme sells both sizes (and becomes their preferred supplier): its prices fill the order.
    for (const [sku, unitCost] of [
      ['TEE-S', 8],
      ['TEE-M', 9],
    ] as const) {
      await ok('PUT', `/api/purchasing/suppliers/${supplierId}/items/${item[sku]}`, { unitCost });
    }
    const order = await ok('POST', '/api/purchasing/orders', {
      supplierId,
      lines: [
        { itemId: item['TEE-S'], quantityOrdered: 30 },
        { itemId: item['TEE-M'], quantityOrdered: 20 },
      ],
    });
    firstOrder = order.id;
    expect(order.lines.map((l: any) => l.unitCost)).toEqual([8, 9]);
    await ok('POST', `/api/purchasing/orders/${firstOrder}/order`);
    const received = await receive(firstOrder, { 'TEE-S': 20, 'TEE-M': 10 });
    expect(received.order.status).toBe('partial');
    expect(received.waiting).toEqual([]);
    await settle();

    expect([await shared('TEE-S'), await shared('TEE-M')]).toEqual([20, 10]);
    // Harbor keeps its safety buffer of 2 back.
    expect([shows(northwind, 'TEE-S'), shows(harbor, 'TEE-S')]).toEqual([20, 18]);
    expect([shows(northwind, 'TEE-M'), shows(harbor, 'TEE-M')]).toEqual([10, 8]);
    expect([await cost('TEE-S'), await cost('TEE-M')]).toEqual([8, 9]);
    // "Copy costs to Shopify" is off: Shopify's costs are left alone.
    for (const s of h.stores) {
      expect(s.shop.calls.some((c) => c.op === 'updateInventoryItemCost')).toBe(false);
    }
  });

  it('(c) orders from both stores show in the reports, in the base currency, with margins', async () => {
    await sell(northwind, [{ sku: 'TEE-S', quantity: 3 }]);
    await sell(harbor, [
      { sku: 'TEE-S', quantity: 2 },
      { sku: 'TEE-M', quantity: 1 },
    ]);
    for (const s of h.stores) await enqueueTask(h.db, 'sync_orders', { storeId: s.id });
    await settle();
    // The sales came off the shared stock too.
    expect([await shared('TEE-S'), await shared('TEE-M')]).toEqual([15, 9]);

    const summary = await ok('GET', '/api/reports/summary');
    expect(summary.byStore).toMatchObject([
      { storeId: northwind.id, orders: 1, units: 3, revenue: 60, revenueBase: 60, cost: 24 },
      // 2 × 88,900 + 105,900 COP = 283,700 COP = 70.925 USD; cost 2 × 8 + 9.
      { storeId: harbor.id, orders: 1, units: 3, revenue: 283_700, revenueBase: 70.925, cost: 25 },
    ]);
    expect(summary.totals).toMatchObject({ orders: 2, units: 6, revenue: 130.925, cost: 49 });
    // (130.925 − 49) ÷ 130.925
    expect(summary.totals.margin).toBeCloseTo(0.6257, 4);
    expect(summary.byStore[0].margin).toBeCloseTo(0.6, 4);
  });

  it('(d) the reorder check suggests an order at that pace, and receiving the order resolves it', async () => {
    await enqueueTask(h.db, 'reorder_check', {});
    await settle();
    // TEE-S: 5 sold today (5 a day); 15 here + 10 on order last 5 days, less than 7 + 7.
    // Suggested: 5 × (7 lead + 30 cover) − 25 = 160. TEE-M (19 days) is fine.
    const reorder = await ok('GET', '/api/purchasing/reorder');
    expect(
      reorder.rows.map((r: any) => [r.sku, r.velocity, r.available, r.onOrder, r.suggested]),
    ).toEqual([['TEE-S', 5, 15, 10, 160]]);
    expect(await openReorderAlerts()).toEqual([
      {
        item_id: item['TEE-S'],
        message:
          'TEE-S will run out in about 3 days at the current pace (5 a day). 10 units are ' +
          'already on order. Lead time is 7 days. Suggested order: 160 units from Acme.',
      },
    ]);

    // Products → "Needs attention" is about syncing: a reorder alert doesn't put it there.
    expect((await ok('GET', '/api/items?filter=issues')).total).toBe(0);

    // One click: a draft order with the suggestion. A draft isn't on order yet.
    const drafts = await ok('POST', '/api/purchasing/reorder/draft-orders', {
      lines: [{ itemId: item['TEE-S'], quantity: 160 }],
    });
    expect(drafts.orderIds).toHaveLength(1);
    await enqueueTask(h.db, 'reorder_check', {});
    await settle();
    expect(await openReorderAlerts()).toHaveLength(1);

    // It arrives (received straight from the draft), and so does the rest of the first order.
    await receive(drafts.orderIds[0], { 'TEE-S': 160 });
    await receive(firstOrder, { 'TEE-S': 10, 'TEE-M': 10 });
    await settle();
    expect(await openReorderAlerts()).toEqual([]);
    expect([await shared('TEE-S'), await shared('TEE-M')]).toEqual([185, 19]);
    expect([shows(northwind, 'TEE-S'), shows(harbor, 'TEE-S')]).toEqual([185, 183]);
    const first = await ok('GET', `/api/purchasing/orders/${firstOrder}`);
    expect(first.status).toBe('received');
  });

  it('(e) a scheduled sale in one store lowers its prices, then puts them back', async () => {
    const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
    const sale = await ok('POST', '/api/prices/schedules', {
      kind: 'sale',
      name: 'Weekend sale',
      startsAt: minutes(5),
      endsAt: minutes(65),
      storeIds: [northwind.id],
      itemIds: [item['TEE-S'], item['TEE-M']],
      percentOff: 25,
      showCompareAt: true,
    });
    const tick = () => PRICING_JOBS[0]!.run({ db: h.db, logger: silentLogger, now: Date.now() });
    // Not due yet: the scheduler's tick changes nothing.
    await tick();
    await settle();
    expect(variantOf(northwind, 'TEE-S').price).toBe(20);

    // The start comes (the schedule's clock is the database's: move the sale instead).
    await h.db.query(
      `UPDATE price_schedules SET starts_at = now() - interval '1 minute' WHERE id = $1`,
      [sale.id],
    );
    await tick();
    await settle();
    const prices = (s: TestStore) =>
      ['TEE-S', 'TEE-M'].map((sku) => [variantOf(s, sku).price, variantOf(s, sku).compareAtPrice]);
    expect(prices(northwind)).toEqual([
      [15, 20],
      [18, 24],
    ]);
    // Harbor isn't in the sale.
    expect(prices(harbor)).toEqual([
      [88_900, null],
      [105_900, null],
    ]);

    // And it ends.
    await h.db.query(
      `UPDATE price_schedules SET starts_at = now() - interval '2 hours',
              ends_at = now() - interval '1 second' WHERE id = $1`,
      [sale.id],
    );
    await tick();
    await settle();
    expect(prices(northwind)).toEqual([
      [20, null],
      [24, null],
    ]);
    expect((await ok('GET', `/api/prices/schedules/${sale.id}`)).status).toBe('ended');
  });
});
