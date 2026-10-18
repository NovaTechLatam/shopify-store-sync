import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PURCHASING_JOBS } from '../src/purchasing/jobs.js';
import { createOrder, markOrdered, receiveOrder, loadOrder } from '../src/purchasing/orders.js';
import { loadReorderRows, runReorderCheck } from '../src/purchasing/reorder.js';
import { createSupplier, putSupplierItem } from '../src/purchasing/suppliers.js';
import { Scheduler } from '../src/scheduler.js';
import { getSettings, updateSettings } from '../src/settings.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import type { TaskDeps } from '../src/tasks/types.js';
import { Harness, silentLogger, type TestItem } from './helpers/harness.js';

let h: Harness;
let deps: TaskDeps;

beforeEach(async () => {
  h = await Harness.create(2);
  deps = { db: h.db, shopify: h.registry, logger: silentLogger, publicUrl: 'https://x.test' };
});

afterEach(async () => {
  await h.close();
});

const DAY = 86_400_000;
let orderCounter = 0;

/** One order in `storeId` with one line of the item, `daysAgo` days ago. */
async function sale(
  storeId: number,
  itemId: number | null,
  quantity: number,
  daysAgo: number,
  opts: { test?: boolean; cancelled?: boolean; giftCard?: boolean; current?: number } = {},
) {
  const at = new Date(Date.now() - daysAgo * DAY);
  const n = ++orderCounter;
  const { rows } = await h.db.query<{ id: number }>(
    `INSERT INTO sales_orders (store_id, shopify_order_id, name, processed_at, shopify_updated_at,
                               cancelled_at, test, currency_code)
     VALUES ($1, $2, $3, $4, $4, $5, $6, 'USD') RETURNING id`,
    [
      storeId,
      `gid://shopify/Order/${n}`,
      `#${1000 + n}`,
      at,
      opts.cancelled ? at : null,
      opts.test ?? false,
    ],
  );
  await h.db.query(
    `INSERT INTO sales_lines (order_id, store_id, shopify_line_id, item_id, quantity, current_quantity,
                              is_gift_card, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      rows[0]!.id,
      storeId,
      `gid://shopify/LineItem/${n}`,
      itemId,
      quantity,
      opts.current ?? quantity,
      opts.giftCard ?? false,
      at,
    ],
  );
}

async function startedItem(sku: string, start: number, createdDaysAgo = 400): Promise<TestItem> {
  const item = await h.addItem(sku, [start, start]);
  await h.initialize(item, 'min');
  await h.drain();
  await h.db.query(
    `UPDATE items SET created_at = now() - make_interval(days => $2) WHERE id = $1`,
    [item.itemId, createdDaysAgo],
  );
  return item;
}

async function openAlerts() {
  const { rows } = await h.db.query<{ dedupe_key: string; item_id: number; message: string }>(
    `SELECT dedupe_key, item_id, message FROM alerts WHERE kind = 'reorder' AND resolved_at IS NULL
      ORDER BY item_id`,
  );
  return rows;
}

describe('reorder figures', () => {
  it('measures the pace over the lookback window, without test, cancelled or gift card orders', async () => {
    const item = await startedItem('TEE-1', 30);
    const [a, b] = h.stores;
    await sale(a!.id, item.itemId, 40, 60); // before the 30-day window: not counted
    for (let d = 1; d <= 29; d += 2) await sale(a!.id, item.itemId, 3, d); // 15 × 3 = 45
    await sale(b!.id, item.itemId, 45, 10); // another store counts too: 90 in 30 days
    await sale(b!.id, item.itemId, 50, 3, { test: true });
    await sale(b!.id, item.itemId, 50, 3, { cancelled: true });
    await sale(b!.id, item.itemId, 50, 3, { giftCard: true });
    await sale(b!.id, item.itemId, 5, 3, { current: 0 }); // fully refunded
    const [row] = await loadReorderRows(h.db, await getSettings(h.db));
    expect(row!.unitsSold).toBe(90);
    expect(row!.windowDays).toBeCloseTo(30, 3);
    expect(row!.velocity).toBeCloseTo(3, 3);
    expect(row!.available).toBe(30);
    expect(row!.daysLeft).toBeCloseTo(10, 2);
    expect(row!.needsReorder).toBe(true);
    // 3 × (14 + 30) − 30, lead time from the default setting
    expect(row!.leadTimeSource).toBe('default');
    expect(row!.suggested).toBe(102);
  });

  it('doesn’t dilute a new product over the whole window, nor over days before any order', async () => {
    const fresh = await startedItem('NEW-1', 100, 5);
    const old = await startedItem('OLD-1', 100);
    const store = h.stores[0]!;
    for (let d = 0; d < 5; d++) await sale(store.id, fresh.itemId, 4, d + 0.5); // 20 in 5 days
    // The first order we have at all is 10 days old: the old product's window is 10 days.
    await sale(store.id, old.itemId, 20, 10);
    const rows = await loadReorderRows(h.db, await getSettings(h.db));
    const byId = new Map(rows.map((r) => [r.itemId, r]));
    expect(byId.get(fresh.itemId)!.windowDays).toBeCloseTo(5, 2);
    expect(byId.get(fresh.itemId)!.velocity).toBeCloseTo(4, 2);
    expect(byId.get(old.itemId)!.windowDays).toBeCloseTo(10, 2);
    expect(byId.get(old.itemId)!.velocity).toBeCloseTo(2, 2);
  });

  it('counts stock on order, supplier lead time, item overrides and pack sizes', async () => {
    const item = await startedItem('TEE-1', 30);
    await sale(h.stores[0]!.id, null, 1, 40); // orders go back further than the window
    for (let d = 1; d <= 30; d++) await sale(h.stores[0]!.id, item.itemId, 3, d - 0.5);
    const settings = await getSettings(h.db);
    const supplierId = await createSupplier(h.db, {
      name: 'Acme',
      currencyCode: 'USD',
      leadTimeDays: 20,
    });
    await putSupplierItem(h.db, supplierId, item.itemId, { minOrderQty: 50, packSize: 25 });
    let [row] = await loadReorderRows(h.db, settings);
    expect(row!.leadTimeDays).toBe(20);
    expect(row!.leadTimeSource).toBe('supplier');
    expect(row!.supplier).toEqual({ id: supplierId, name: 'Acme', currencyCode: 'USD' });
    // 3 × (20 + 30) − 30 = 120, at least 50, in packs of 25: 125.
    expect(row!.suggested).toBe(125);
    expect(row!.velocity).toBeCloseTo(3, 3);

    // 40 on order (an ordered PO) plus a draft that doesn't count yet.
    const ordered = await createOrder(
      h.db,
      { supplierId, lines: [{ itemId: item.itemId, quantityOrdered: 40 }] },
      settings,
    );
    await markOrdered(h.db, ordered);
    await createOrder(
      h.db,
      { supplierId, lines: [{ itemId: item.itemId, quantityOrdered: 99 }] },
      settings,
    );
    [row] = await loadReorderRows(h.db, settings);
    expect(row!.onOrder).toBe(40);
    expect(row!.suggested).toBe(100); // 150 − 70 = 80 → packs of 25

    await h.db.query('UPDATE items SET lead_time_days = 2, reorder_cover_days = 10 WHERE id = $1', [
      item.itemId,
    ]);
    [row] = await loadReorderRows(h.db, settings);
    expect(row!.leadTimeSource).toBe('item');
    // (30 + 40) / 3 = 23 days > 2 + 7: nothing needed.
    expect(row!.needsReorder).toBe(false);
    expect(row!.suggested).toBe(0);
  });

  it('never suggests a reorder for products that are switched off or not started', async () => {
    const off = await startedItem('OFF-1', 0);
    const notStarted = await h.addItem('NS-1', [0, 0]);
    await h.db.query('UPDATE items SET reorder_enabled = false WHERE id = $1', [off.itemId]);
    for (const item of [off, notStarted]) await sale(h.stores[0]!.id, item.itemId, 30, 2);
    const rows = await loadReorderRows(h.db, await getSettings(h.db));
    expect(rows.map((r) => [r.sku, r.velocity > 0, r.needsReorder, r.suggested])).toEqual([
      ['NS-1', true, false, 0],
      ['OFF-1', true, false, 0],
    ]);
    expect(rows.find((r) => r.sku === 'NS-1')!.stockKnown).toBe(false);
  });
});

describe('reorder_check', () => {
  it('opens and resolves reorder alerts idempotently', async () => {
    const low = await startedItem('LOW-1', 10);
    const fine = await startedItem('FINE-1', 500);
    for (const item of [low, fine]) await sale(h.stores[0]!.id, item.itemId, 60, 5);
    const supplierId = await createSupplier(h.db, {
      name: 'Acme',
      currencyCode: 'USD',
      leadTimeDays: 14,
    });
    await putSupplierItem(h.db, supplierId, low.itemId, { unitCost: 2 });

    expect(await runReorderCheck(h.db)).toEqual({ open: 1, resolved: 0 });
    expect(await runReorderCheck(h.db)).toEqual({ open: 1, resolved: 0 });
    const alerts = await openAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dedupe_key).toBe(`reorder:${low.itemId}`);
    expect(alerts[0]!.message).toMatch(
      /^LOW-1 will run out in less than a day at the current pace \(12 a day\)\. Lead time is 14 days\. Suggested order: \d+ units from Acme\.$/,
    );

    // A delivery fixes it: the next check resolves the alert.
    const settings = await getSettings(h.db);
    const orderId = await createOrder(
      h.db,
      { supplierId, lines: [{ itemId: low.itemId, quantityOrdered: 400 }] },
      settings,
    );
    const po = await loadOrder(h.db, orderId, settings);
    await receiveOrder(
      h.db,
      orderId,
      { requestId: randomUUID(), lines: [{ lineId: po.lines[0]!.id, quantity: 400 }] },
      settings,
    );
    await h.drain();
    expect(await runReorderCheck(h.db)).toEqual({ open: 0, resolved: 1 });
    expect(await openAlerts()).toHaveLength(0);
  });

  it('counts a delivery the stock sync hasn’t applied yet, so it never raises a false alert', async () => {
    // 2 a day; 20 on the shelf + 50 on order: 35 days, fine (the line is 14 + 7 days).
    const item = await startedItem('DELIV-1', 20);
    await sale(h.stores[0]!.id, null, 1, 40);
    await sale(h.stores[0]!.id, item.itemId, 60, 10);
    const settings = await getSettings(h.db);
    const supplierId = await createSupplier(h.db, { name: 'Acme', currencyCode: 'USD' });
    const orderId = await createOrder(
      h.db,
      { supplierId, lines: [{ itemId: item.itemId, quantityOrdered: 50 }] },
      settings,
    );
    await markOrdered(h.db, orderId);
    expect(await runReorderCheck(h.db)).toEqual({ open: 0, resolved: 0 });
    // The delivery arrives; the check queued with it runs before the sync engine applies it.
    const po = await loadOrder(h.db, orderId, settings);
    await receiveOrder(
      h.db,
      orderId,
      { requestId: randomUUID(), lines: [{ lineId: po.lines[0]!.id, quantity: 50 }] },
      settings,
    );
    // Not on order any more, not in the shared stock yet: it counts as on the shelf (else 20
    // units = 10 days would open an alert, and notify, until the next check).
    expect(await h.shared(item)).toBe(20);
    let [row] = await loadReorderRows(h.db, settings);
    expect([row!.available, row!.onOrder, row!.needsReorder]).toEqual([70, 0, false]);
    expect(await runReorderCheck(h.db)).toEqual({ open: 0, resolved: 0 });
    await h.drain();
    [row] = await loadReorderRows(h.db, settings);
    expect([row!.available, row!.onOrder]).toEqual([70, 0]);
  });

  it('keeps an alert open until the stock clearly covers the lead time again', async () => {
    // 60 sold in the last 30 days: 2 a day. Lead 14 + safety 7 = 21 days = 42 units; the alert
    // closes above 21 + 2.1 days = 46.2 units.
    const item = await startedItem('EDGE-1', 40);
    await sale(h.stores[0]!.id, null, 1, 40); // the store's sales history starts before the window
    await sale(h.stores[0]!.id, item.itemId, 60, 10);
    const add = async (units: number) => {
      await h.db.query(
        `INSERT INTO pool_adjustments (pool_level_id, kind, value) VALUES ($1, 'adjust', $2)`,
        [item.poolLevelId, units],
      );
      await h.enqueue(item);
      await h.drain();
    };
    expect(await runReorderCheck(h.db)).toEqual({ open: 1, resolved: 0 });
    await add(4); // 44 units = 22 days: past the line, within the margin
    expect(await runReorderCheck(h.db)).toEqual({ open: 1, resolved: 0 });
    let [row] = await loadReorderRows(h.db, await getSettings(h.db));
    expect([row!.needsReorder, row!.suggested > 0]).toEqual([true, true]);
    await add(3); // 47 units = 23.5 days: clear
    expect(await runReorderCheck(h.db)).toEqual({ open: 0, resolved: 1 });
    [row] = await loadReorderRows(h.db, await getSettings(h.db));
    expect(row!.needsReorder).toBe(false);
    // Dropping back within the margin doesn't reopen it: only below the line again.
    await add(-2); // 45 units
    expect(await runReorderCheck(h.db)).toEqual({ open: 0, resolved: 0 });
    await add(-4); // 41 units
    expect(await runReorderCheck(h.db)).toEqual({ open: 1, resolved: 0 });
  });

  it('resolves every reorder alert when the alerts are switched off', async () => {
    const low = await startedItem('LOW-1', 0);
    await sale(h.stores[0]!.id, low.itemId, 10, 1);
    await runReorderCheck(h.db);
    expect(await openAlerts()).toHaveLength(1);
    await updateSettings(h.db, { reorderAlertsEnabled: false });
    expect(await runReorderCheck(h.db)).toEqual({ open: 0, resolved: 1 });
    expect(await openAlerts()).toHaveLength(0);
  });

  it('runs as a task, enqueued every hour by the scheduler (once, however many ask)', async () => {
    const low = await startedItem('LOW-1', 0);
    const job = PURCHASING_JOBS[0]!;
    // No sales recorded yet: nothing to check.
    await job.run({ db: h.db, logger: silentLogger, now: Date.now() });
    const { rows: none } = await h.db.query(`SELECT 1 FROM tasks WHERE kind = 'reorder_check'`);
    expect(none).toHaveLength(0);
    await sale(h.stores[0]!.id, low.itemId, 10, 1);
    const scheduler = new Scheduler({
      db: h.db,
      logger: silentLogger,
      driftIntervalMs: 3_600_000,
      catalogIntervalMs: 3_600_000,
      featureJobs: PURCHASING_JOBS,
    });
    await scheduler.tick(Date.now());
    await PURCHASING_JOBS[0]!.run({ db: h.db, logger: silentLogger, now: Date.now() });
    const { rows } = await h.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE kind = 'reorder_check'`,
    );
    expect(rows[0]!.n).toBe(1);
    await runTasksOnce(h.db, deps, silentLogger, 50);
    expect(await openAlerts()).toHaveLength(1);
  });
});

describe('push_item_costs', () => {
  it('writes each item’s cost in the store’s currency to the linked inventory item', async () => {
    const a = await startedItem('A-1', 0);
    const b = await startedItem('B-1', 0);
    const unsold = await h.addItem('U-1', [], []);
    const store = h.stores[1]!;
    await h.db.query(
      `UPDATE stores SET currency_code = 'COP', exchange_rate = 4100 WHERE id = $1`,
      [store.id],
    );
    await h.db.query('UPDATE items SET cost = 2.5 WHERE id = ANY($1::bigint[])', [
      [a.itemId, unsold.itemId],
    ]);
    // b has no cost: skipped; unsold isn't in the store: skipped.
    const { pushItemCosts } = await import('../src/purchasing/costs.js');
    const result = await pushItemCosts(deps, store.id, [a.itemId, b.itemId, unsold.itemId]);
    expect(result).toEqual({ updated: 1, failed: 0, skipped: 2 });
    expect(store.shop.calls.filter((c) => c.op === 'updateInventoryItemCost')).toEqual([
      {
        op: 'updateInventoryItemCost',
        args: { inventoryItemId: a.inventoryItemIds.get(store.id), cost: '10250.00' },
      },
    ]);
  });

  it('retries after a network error, then succeeds (absolute values: no double effect)', async () => {
    const a = await startedItem('A-1', 0);
    await h.db.query('UPDATE items SET cost = 3 WHERE id = $1', [a.itemId]);
    const store = h.stores[0]!;
    store.shop.failNext('updateInventoryItemCost', 'throw_before');
    await h.db.query(
      `INSERT INTO tasks (kind, dedupe_key, payload) VALUES ('push_item_costs', 'push_item_costs:x', $1)`,
      [JSON.stringify({ storeId: store.id, itemIds: [a.itemId] })],
    );
    await runTasksOnce(h.db, deps, silentLogger, 10);
    const { rows } = await h.db.query<{ attempts: number; last_error: string }>(
      `SELECT attempts, last_error FROM tasks WHERE kind = 'push_item_costs'`,
    );
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.last_error).toContain('fake network error');
    await h.db.query(`UPDATE tasks SET run_after = now()`);
    await runTasksOnce(h.db, deps, silentLogger, 10);
    const { rows: left } = await h.db.query(`SELECT 1 FROM tasks WHERE kind = 'push_item_costs'`);
    expect(left).toHaveLength(0);
    const costCalls = store.shop.calls.filter((c) => c.op === 'updateInventoryItemCost');
    expect(costCalls.at(-1)!.args).toEqual({
      inventoryItemId: a.inventoryItemIds.get(store.id),
      cost: '3.00',
    });
  });

  it('stops with an alert when the store doesn’t allow it, and clears it once it works', async () => {
    const a = await startedItem('A-1', 0);
    await h.db.query('UPDATE items SET cost = 3 WHERE id = $1', [a.itemId]);
    const store = h.stores[0]!;
    store.shop.scopes = ['read_products', 'read_inventory', 'read_locations'];
    await h.db.query(
      `INSERT INTO tasks (kind, dedupe_key, payload) VALUES ('push_item_costs', 'push_item_costs:x', $1)`,
      [JSON.stringify({ storeId: store.id, itemIds: [a.itemId] })],
    );
    await runTasksOnce(h.db, deps, silentLogger, 10);
    // Done (not retried forever), with an alert for the merchant; the store isn't marked broken.
    const { rows: tasks } = await h.db.query(`SELECT 1 FROM tasks WHERE kind = 'push_item_costs'`);
    expect(tasks).toHaveLength(0);
    const { rows: alerts } = await h.db.query<{ kind: string; store_id: number; message: string }>(
      `SELECT kind, store_id, message FROM alerts WHERE resolved_at IS NULL AND kind <> 'low_stock'`,
    );
    expect(alerts).toEqual([
      {
        kind: 'cost_push_failed',
        store_id: store.id,
        message: expect.stringContaining('costs couldn’t be copied to Shopify'),
      },
    ]);
    const { rows: stores } = await h.db.query<{ status: string }>(
      'SELECT status FROM stores WHERE id = $1',
      [store.id],
    );
    expect(stores[0]!.status).toBe('active');

    store.shop.scopes = ['read_products', 'read_inventory', 'write_inventory', 'read_locations'];
    const { pushItemCosts } = await import('../src/purchasing/costs.js');
    await pushItemCosts(deps, store.id, [a.itemId]);
    const { rows: open } = await h.db.query(
      `SELECT 1 FROM alerts WHERE resolved_at IS NULL AND kind = 'cost_push_failed'`,
    );
    expect(open).toHaveLength(0);
  });

  it('skips paused stores, and goes on after a cost Shopify refuses', async () => {
    const a = await startedItem('A-1', 0);
    const b = await startedItem('B-1', 0);
    await h.db.query('UPDATE items SET cost = 3 WHERE id = ANY($1::bigint[])', [
      [a.itemId, b.itemId],
    ]);
    const [first, second] = h.stores;
    // Shopify doesn't know A's inventory item any more (deleted meanwhile).
    first!.shop.variants.splice(
      first!.shop.variants.findIndex(
        (v) => v.inventoryItemId === a.inventoryItemIds.get(first!.id),
      ),
      1,
    );
    const { pushItemCosts } = await import('../src/purchasing/costs.js');
    expect(await pushItemCosts(deps, first!.id, [a.itemId, b.itemId])).toEqual({
      updated: 1,
      failed: 1,
      skipped: 0,
    });

    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [second!.id]);
    await h.db.query(
      `INSERT INTO tasks (kind, dedupe_key, payload) VALUES ('push_item_costs', 'push_item_costs:y', $1)`,
      [JSON.stringify({ storeId: second!.id, itemIds: [a.itemId] })],
    );
    await runTasksOnce(h.db, deps, silentLogger, 10);
    expect(second!.shop.calls.filter((c) => c.op === 'updateInventoryItemCost')).toHaveLength(0);
  });
});
