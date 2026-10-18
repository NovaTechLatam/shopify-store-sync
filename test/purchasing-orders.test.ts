import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelOrder,
  closeOrder,
  createDraftOrders,
  createOrder,
  deleteOrder,
  loadOrder,
  markOrdered,
  receiveOrder,
  reverseReceipt,
  suggestedExchangeRate,
  updateOrder,
  waitingItems,
} from '../src/purchasing/orders.js';
import { createSupplier, putSupplierItem } from '../src/purchasing/suppliers.js';
import { getSettings, updateSettings, type Settings } from '../src/settings.js';
import { enqueuePoolLevels } from '../src/sync/queue.js';
import { Harness, type TestItem } from './helpers/harness.js';

let h: Harness;
let settings: Settings;

beforeEach(async () => {
  h = await Harness.create(2);
  settings = await getSettings(h.db);
});

afterEach(async () => {
  await h.close();
});

async function supplier(name = 'Acme', currencyCode = 'USD') {
  return createSupplier(h.db, { name, currencyCode, leadTimeDays: 10 });
}

/** A started item, sold by both stores, with `start` units shared. */
async function startedItem(sku: string, start: number): Promise<TestItem> {
  const item = await h.addItem(sku, [start, start]);
  await h.initialize(item, 'min');
  await h.drain();
  return item;
}

async function order(
  supplierId: number,
  lines: { itemId: number; quantityOrdered: number; unitCost?: number }[],
  extra: { currencyCode?: string; exchangeRate?: number } = {},
) {
  return createOrder(h.db, { supplierId, lines, ...extra }, settings);
}

const receive = (
  orderId: number,
  lines: { lineId: number; quantity: number }[],
  opts: { requestId?: string; allowOver?: boolean } = {},
) =>
  receiveOrder(
    h.db,
    orderId,
    { requestId: opts.requestId ?? randomUUID(), lines, allowOver: opts.allowOver },
    settings,
  );

async function lineIds(orderId: number): Promise<number[]> {
  return (await loadOrder(h.db, orderId, settings)).lines.map((l) => l.id);
}

async function itemCost(itemId: number): Promise<number | null> {
  const { rows } = await h.db.query<{ cost: number | null }>(
    'SELECT cost FROM items WHERE id = $1',
    [itemId],
  );
  return rows[0]!.cost;
}

describe('receiving a purchase order', () => {
  it('adds the units to the shared stock, every store, and logs a "po_received" event', async () => {
    const item = await startedItem('TEE-1', 10);
    const supplierId = await supplier();
    const orderId = await order(supplierId, [
      { itemId: item.itemId, quantityOrdered: 50, unitCost: 4 },
    ]);
    await markOrdered(h.db, orderId);
    const [lineId] = await lineIds(orderId);

    const result = await receive(orderId, [{ lineId: lineId!, quantity: 20 }]);
    expect(result.duplicate).toBe(false);
    let po = await loadOrder(h.db, orderId, settings);
    expect(po.status).toBe('partial');
    expect(po.lines[0]).toMatchObject({ quantityReceived: 20, remaining: 30 });
    expect(po.receipts).toHaveLength(1);
    expect(po.receipts[0]!.units).toBe(20);

    await h.drain();
    expect(await h.shared(item)).toBe(30);
    expect(h.levels(item)).toEqual([30, 30]);

    const { rows: events } = await h.db.query<{
      kind: string;
      delta: number;
      message: string;
      details: Record<string, unknown>;
    }>(`SELECT kind, delta, message, details FROM inventory_events WHERE kind = 'po_received'`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      delta: 20,
      message: `Received 20 on ${po.number} from Acme`,
      details: { purchaseOrderId: orderId, number: po.number, supplierName: 'Acme' },
    });
    expect(events[0]!.details.receiptId).toBe(result.receiptId);

    await receive(orderId, [{ lineId: lineId!, quantity: 30 }]);
    po = await loadOrder(h.db, orderId, settings);
    expect(po.status).toBe('received');
    expect(po.totals.receivedFraction).toBe(1);
    await h.drain();
    expect(h.levels(item)).toEqual([60, 60]);
  });

  it('books a retried request once (same request id), also when both arrive at once', async () => {
    const item = await startedItem('TEE-1', 0);
    const orderId = await order(await supplier(), [{ itemId: item.itemId, quantityOrdered: 10 }]);
    const [lineId] = await lineIds(orderId);
    const requestId = randomUUID();

    const first = await receive(orderId, [{ lineId: lineId!, quantity: 4 }], { requestId });
    const again = await receive(orderId, [{ lineId: lineId!, quantity: 4 }], { requestId });
    expect(again).toMatchObject({ duplicate: true, receiptId: first.receiptId });

    const both = randomUUID();
    const results = await Promise.all([
      receive(orderId, [{ lineId: lineId!, quantity: 3 }], { requestId: both }),
      receive(orderId, [{ lineId: lineId!, quantity: 3 }], { requestId: both }),
    ]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(results[0]!.receiptId).toBe(results[1]!.receiptId);

    const po = await loadOrder(h.db, orderId, settings);
    expect(po.lines[0]!.quantityReceived).toBe(7);
    expect(po.receipts).toHaveLength(2);
    await h.drain();
    expect(await h.shared(item)).toBe(7);
  });

  it('refuses a request id that was used on another order', async () => {
    const item = await startedItem('TEE-1', 0);
    const supplierId = await supplier();
    const a = await order(supplierId, [{ itemId: item.itemId, quantityOrdered: 10 }]);
    const b = await order(supplierId, [{ itemId: item.itemId, quantityOrdered: 10 }]);
    const requestId = randomUUID();
    await receive(a, [{ lineId: (await lineIds(a))[0]!, quantity: 1 }], { requestId });
    await expect(
      receive(b, [{ lineId: (await lineIds(b))[0]!, quantity: 1 }], { requestId }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses more than ordered unless allowed, also for two deliveries at the same time', async () => {
    const item = await startedItem('TEE-1', 0);
    const orderId = await order(await supplier(), [{ itemId: item.itemId, quantityOrdered: 10 }]);
    const [lineId] = await lineIds(orderId);
    await receive(orderId, [{ lineId: lineId!, quantity: 6 }]);

    await expect(receive(orderId, [{ lineId: lineId!, quantity: 5 }])).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Only 4 of TEE-1 remain'),
      details: { overReceipt: [{ lineId, sku: 'TEE-1', remaining: 4, quantity: 5 }] },
    });

    // Two deliveries of the remaining 4 at once: the order's lock lets only one through.
    const outcomes = await Promise.allSettled([
      receive(orderId, [{ lineId: lineId!, quantity: 4 }]),
      receive(orderId, [{ lineId: lineId!, quantity: 4 }]),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    let po = await loadOrder(h.db, orderId, settings);
    expect(po.lines[0]!.quantityReceived).toBe(10);
    expect(po.status).toBe('received');

    // A received order takes nothing more, even when allowed.
    await expect(
      receive(orderId, [{ lineId: lineId!, quantity: 1 }], { allowOver: true }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const other = await order(await supplier('Other'), [
      { itemId: item.itemId, quantityOrdered: 2 },
    ]);
    await receive(other, [{ lineId: (await lineIds(other))[0]!, quantity: 5 }], {
      allowOver: true,
    });
    po = await loadOrder(h.db, other, settings);
    expect(po.lines[0]).toMatchObject({ quantityReceived: 5, remaining: 0 });
    expect(po.status).toBe('received');
    expect(po.totals.receivedFraction).toBe(1);
    await h.drain();
    expect(await h.shared(item)).toBe(15);
  });

  it('starts a brand-new product at 0 plus the delivery once a store sells it', async () => {
    const { rows } = await h.db.query<{ id: number }>(
      `INSERT INTO items (sku, title) VALUES ('NEW-1', 'New product') RETURNING id`,
    );
    const itemId = rows[0]!.id;
    const { rows: levels } = await h.db.query<{ id: number }>(
      `INSERT INTO pool_levels (item_id, warehouse_id) VALUES ($1, $2) RETURNING id`,
      [itemId, h.warehouseId],
    );
    const poolLevelId = levels[0]!.id;
    const orderId = await order(await supplier(), [{ itemId, quantityOrdered: 24, unitCost: 3 }]);
    const result = await receive(orderId, [{ lineId: (await lineIds(orderId))[0]!, quantity: 24 }]);
    expect(await waitingItems(h.db, result.receiptId)).toEqual([
      { itemId, sku: 'NEW-1', reason: 'not_started' },
    ]);
    const { rows: adjustments } = await h.db.query<{
      kind: string;
      strategy: string;
      value: number;
    }>('SELECT kind, strategy, value FROM pool_adjustments WHERE pool_level_id = $1 ORDER BY id', [
      poolLevelId,
    ]);
    expect(adjustments).toEqual([
      { kind: 'initialize', strategy: 'value', value: 0 },
      { kind: 'adjust', strategy: null, value: 24 },
    ]);

    // A second delivery doesn't add a second start.
    const again = await order(await supplier('Other'), [{ itemId, quantityOrdered: 6 }]);
    await receive(again, [{ lineId: (await lineIds(again))[0]!, quantity: 6 }]);
    const { rows: inits } = await h.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pool_adjustments WHERE pool_level_id = $1 AND kind = 'initialize'`,
      [poolLevelId],
    );
    expect(inits[0]!.n).toBe(1);

    await h.drain();
    const item: TestItem = { itemId, poolLevelId, sku: 'NEW-1', inventoryItemIds: new Map() };
    expect(await h.shared(item)).toBeNull(); // no store sells it yet

    // The product is published in a store (with 0 in stock) and linked.
    const store = h.stores[0]!;
    const variant = store.shop.addVariant('NEW-1');
    store.shop.stock(variant.inventoryItemId, store.locationId, 0);
    await h.db.query(
      `INSERT INTO variants (store_id, item_id, shopify_product_id, shopify_variant_id, inventory_item_id, sku)
       VALUES ($1, $2, $3, $4, $5, 'NEW-1')`,
      [store.id, itemId, variant.productId, variant.variantId, variant.inventoryItemId],
    );
    await enqueuePoolLevels(h.db, [poolLevelId], 'linked');
    await h.drain();
    expect(await h.shared(item)).toBe(30);
    expect(store.shop.level(variant.inventoryItemId, store.locationId)).toBe(30);
  });

  it('leaves an item that a store sells but that was never started for the merchant to start', async () => {
    const item = await h.addItem('OLD-1', [7, 9]); // sold, not started
    const orderId = await order(await supplier(), [{ itemId: item.itemId, quantityOrdered: 10 }]);
    const result = await receive(orderId, [{ lineId: (await lineIds(orderId))[0]!, quantity: 10 }]);
    expect(await waitingItems(h.db, result.receiptId)).toEqual([
      { itemId: item.itemId, sku: 'OLD-1', reason: 'not_started' },
    ]);
    const { rows } = await h.db.query<{ kind: string }>(
      'SELECT kind FROM pool_adjustments WHERE pool_level_id = $1 ORDER BY id',
      [item.poolLevelId],
    );
    expect(rows.map((r) => r.kind)).toEqual(['adjust']); // no start of our own
    await h.drain();
    expect(await h.shared(item)).toBeNull();
    expect(h.levels(item)).toEqual([7, 9]); // stores untouched

    // Started from the onboarding page (max of the stores): the delivery comes on top.
    await h.initialize(item, 'max');
    await h.drain();
    expect(await h.shared(item)).toBe(19);
    expect(h.levels(item)).toEqual([19, 19]);
  });

  it('says when a paused item gets its units later', async () => {
    const item = await startedItem('TEE-1', 5);
    await h.db.query('UPDATE items SET sync_enabled = false WHERE id = $1', [item.itemId]);
    const orderId = await order(await supplier(), [{ itemId: item.itemId, quantityOrdered: 3 }]);
    const result = await receive(orderId, [{ lineId: (await lineIds(orderId))[0]!, quantity: 3 }]);
    expect(await waitingItems(h.db, result.receiptId)).toEqual([
      { itemId: item.itemId, sku: 'TEE-1', reason: 'paused' },
    ]);
  });

  it('doesn’t deadlock when deliveries with the same products arrive at once', async () => {
    const a = await startedItem('A-1', 0);
    const b = await startedItem('B-1', 0);
    const supplierId = await supplier();
    const orders: number[] = [];
    for (let i = 0; i < 6; i++) {
      // Half list A first, half B first.
      const lines = [
        { itemId: a.itemId, quantityOrdered: 5 },
        { itemId: b.itemId, quantityOrdered: 5 },
      ];
      orders.push(await order(supplierId, i % 2 ? lines.reverse() : lines));
    }
    await Promise.all(
      orders.map(async (orderId) => {
        const po = await loadOrder(h.db, orderId, settings);
        await receive(
          orderId,
          po.lines.map((l) => ({ lineId: l.id, quantity: 5 })),
        );
      }),
    );
    await h.drain();
    expect(await h.shared(a)).toBe(30);
    expect(await h.shared(b)).toBe(30);
  });

  it('receives into the order’s warehouse', async () => {
    const { rows } = await h.db.query<{ id: number }>(
      `INSERT INTO warehouses (name) VALUES ('Second') RETURNING id`,
    );
    const second = rows[0]!.id;
    const item = await startedItem('TEE-1', 5);
    const orderId = await createOrder(
      h.db,
      {
        supplierId: await supplier(),
        warehouseId: second,
        lines: [{ itemId: item.itemId, quantityOrdered: 3 }],
      },
      settings,
    );
    await receive(orderId, [{ lineId: (await lineIds(orderId))[0]!, quantity: 3 }]);
    const { rows: adj } = await h.db.query<{ warehouse_id: number; value: number }>(
      `SELECT pl.warehouse_id, pa.value FROM pool_adjustments pa JOIN pool_levels pl ON pl.id = pa.pool_level_id
        WHERE pa.event_kind = 'po_received'`,
    );
    expect(adj).toEqual([{ warehouse_id: second, value: 3 }]);
  });
});

describe('costs', () => {
  it('averages the cost with the stock on hand, in the base currency', async () => {
    const item = await startedItem('TEE-1', 10);
    await h.db.query('UPDATE items SET cost = 5 WHERE id = $1', [item.itemId]);
    // An order in COP at 4,000 per USD: 28,000 COP = 7 USD.
    const orderId = await order(
      await supplier('Bogotá Knits', 'COP'),
      [{ itemId: item.itemId, quantityOrdered: 30, unitCost: 28_000 }],
      { exchangeRate: 4000 },
    );
    await receive(orderId, [{ lineId: (await lineIds(orderId))[0]!, quantity: 30 }]);
    expect(await itemCost(item.itemId)).toBe(6.5); // (10 × 5 + 30 × 7) / 40
    const { rows } = await h.db.query<{ cost_updated_at: Date | null }>(
      'SELECT cost_updated_at FROM items WHERE id = $1',
      [item.itemId],
    );
    expect(rows[0]!.cost_updated_at).not.toBeNull();
  });

  it('counts deliveries that haven’t reached the stock yet in the average', async () => {
    // A new product no store sells yet: its deliveries wait (pending) until it is published.
    const { rows } = await h.db.query<{ id: number }>(
      `INSERT INTO items (sku, title) VALUES ('NEW-1', 'New product') RETURNING id`,
    );
    const itemId = rows[0]!.id;
    await h.db.query('INSERT INTO pool_levels (item_id, warehouse_id) VALUES ($1, $2)', [
      itemId,
      h.warehouseId,
    ]);
    const supplierId = await supplier();
    for (const unitCost of [10, 20]) {
      const orderId = await order(supplierId, [{ itemId, quantityOrdered: 100, unitCost }]);
      await receive(orderId, [{ lineId: (await lineIds(orderId))[0]!, quantity: 100 }]);
    }
    expect(await itemCost(itemId)).toBe(15); // (100 × 10 + 100 × 20) / 200

    // A started item whose last delivery the engine hasn't applied yet (e.g. syncing paused).
    const item = await startedItem('TEE-1', 10);
    await h.db.query('UPDATE items SET cost = 5, sync_enabled = false WHERE id = $1', [
      item.itemId,
    ]);
    for (const unitCost of [8, 11]) {
      const orderId = await order(supplierId, [
        { itemId: item.itemId, quantityOrdered: 10, unitCost },
      ]);
      await receive(orderId, [{ lineId: (await lineIds(orderId))[0]!, quantity: 10 }]);
    }
    // 10 × 5 + 10 × 8 = 130 over 20 → 6.5; then (20 × 6.5 + 10 × 11) / 30 = 8.
    expect(await itemCost(item.itemId)).toBe(8);
  });

  it('takes the last price with the "last" method, and ignores lines without a price', async () => {
    settings = await updateSettings(h.db, { costMethod: 'last' });
    const item = await startedItem('TEE-1', 10);
    await h.db.query('UPDATE items SET cost = 5 WHERE id = $1', [item.itemId]);
    const supplierId = await supplier();
    const priced = await order(supplierId, [
      { itemId: item.itemId, quantityOrdered: 2, unitCost: 9 },
    ]);
    await receive(priced, [{ lineId: (await lineIds(priced))[0]!, quantity: 1 }]);
    expect(await itemCost(item.itemId)).toBe(9);
    const free = await order(supplierId, [
      { itemId: item.itemId, quantityOrdered: 2, unitCost: 0 },
    ]);
    await receive(free, [{ lineId: (await lineIds(free))[0]!, quantity: 2 }]);
    expect(await itemCost(item.itemId)).toBe(9);
  });

  it('queues the cost for every active store when costs are copied to Shopify', async () => {
    settings = await updateSettings(h.db, { pushCostsToShopify: true });
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [h.stores[1]!.id]);
    const item = await startedItem('TEE-1', 0);
    const orderId = await order(await supplier(), [
      { itemId: item.itemId, quantityOrdered: 2, unitCost: 3 },
    ]);
    const { receiptId } = await receive(orderId, [
      { lineId: (await lineIds(orderId))[0]!, quantity: 2 },
    ]);
    const { rows } = await h.db.query<{ dedupe_key: string; payload: unknown }>(
      `SELECT dedupe_key, payload FROM tasks WHERE kind = 'push_item_costs'`,
    );
    expect(rows).toEqual([
      {
        dedupe_key: `push_item_costs:${h.stores[0]!.id}:${receiptId}`,
        payload: { storeId: h.stores[0]!.id, itemIds: [item.itemId] },
      },
    ]);
  });
});

describe('undoing a delivery', () => {
  it('takes the units out again, puts the order back and does it only once', async () => {
    const item = await startedItem('TEE-1', 10);
    await h.db.query('UPDATE items SET cost = 5 WHERE id = $1', [item.itemId]);
    const orderId = await order(await supplier(), [
      { itemId: item.itemId, quantityOrdered: 8, unitCost: 7 },
    ]);
    const [lineId] = await lineIds(orderId);
    const { receiptId } = await receive(orderId, [{ lineId: lineId!, quantity: 8 }]);
    await h.drain();
    expect(await h.shared(item)).toBe(18);
    const costAfter = await itemCost(item.itemId);

    expect(await reverseReceipt(h.db, orderId, receiptId)).toEqual({ alreadyReversed: false });
    const po = await loadOrder(h.db, orderId, settings);
    expect(po.status).toBe('ordered');
    expect(po.lines[0]!.quantityReceived).toBe(0);
    expect(po.receipts[0]!.reversedAt).not.toBeNull();
    expect(await itemCost(item.itemId)).toBe(costAfter); // not recalculated

    await h.drain();
    expect(await h.shared(item)).toBe(10);
    expect(h.levels(item)).toEqual([10, 10]);
    const { rows } = await h.db.query<{ delta: number; details: { receiptId: number } }>(
      `SELECT delta, details FROM inventory_events WHERE kind = 'po_receipt_reversed'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(-8);
    expect(rows[0]!.details.receiptId).toBe(receiptId);

    expect(await reverseReceipt(h.db, orderId, receiptId)).toEqual({ alreadyReversed: true });
    await h.drain();
    expect(await h.shared(item)).toBe(10);
    // Nothing received any more: it can be cancelled now.
    await cancelOrder(h.db, orderId);
    expect((await loadOrder(h.db, orderId, settings)).status).toBe('cancelled');
  });

  it('keeps a closed order closed and goes back to partial when other deliveries remain', async () => {
    const item = await startedItem('TEE-1', 0);
    const orderId = await order(await supplier(), [{ itemId: item.itemId, quantityOrdered: 10 }]);
    const [lineId] = await lineIds(orderId);
    const first = await receive(orderId, [{ lineId: lineId!, quantity: 4 }]);
    const second = await receive(orderId, [{ lineId: lineId!, quantity: 6 }]);
    expect((await loadOrder(h.db, orderId, settings)).status).toBe('received');
    await reverseReceipt(h.db, orderId, second.receiptId);
    expect((await loadOrder(h.db, orderId, settings)).status).toBe('partial');
    await closeOrder(h.db, orderId);
    await reverseReceipt(h.db, orderId, first.receiptId);
    const po = await loadOrder(h.db, orderId, settings);
    expect(po.status).toBe('closed');
    expect(po.lines[0]!.quantityReceived).toBe(0);
    await expect(reverseReceipt(h.db, orderId, 999_999)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('order status', () => {
  it('only moves along the allowed paths', async () => {
    const item = await startedItem('TEE-1', 0);
    const supplierId = await supplier();
    const empty = await order(supplierId, []);
    await expect(markOrdered(h.db, empty)).rejects.toMatchObject({ statusCode: 400 });
    await expect(closeOrder(h.db, empty)).rejects.toMatchObject({ statusCode: 409 });
    await deleteOrder(h.db, empty);
    await expect(loadOrder(h.db, empty, settings)).rejects.toMatchObject({ statusCode: 404 });

    const orderId = await order(supplierId, [{ itemId: item.itemId, quantityOrdered: 5 }]);
    let po = await loadOrder(h.db, orderId, settings);
    expect(po.allowed).toEqual({
      edit: 'full',
      order: true,
      receive: true,
      close: false,
      cancel: true,
      delete: true,
    });
    await markOrdered(h.db, orderId);
    await markOrdered(h.db, orderId); // a second click changes nothing
    po = await loadOrder(h.db, orderId, settings);
    expect(po.status).toBe('ordered');
    expect(po.orderedAt).not.toBeNull();
    expect(po.allowed).toMatchObject({ edit: 'open', close: true, cancel: true, delete: false });
    await expect(deleteOrder(h.db, orderId)).rejects.toMatchObject({ statusCode: 409 });

    await receive(orderId, [{ lineId: po.lines[0]!.id, quantity: 2 }]);
    await expect(cancelOrder(h.db, orderId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Close it instead'),
    });
    await closeOrder(h.db, orderId);
    await closeOrder(h.db, orderId);
    po = await loadOrder(h.db, orderId, settings);
    expect(po.status).toBe('closed');
    expect(po.allowed).toEqual({
      edit: 'notes',
      order: false,
      receive: false,
      close: false,
      cancel: false,
      delete: false,
    });
    await expect(
      receive(orderId, [{ lineId: po.lines[0]!.id, quantity: 1 }]),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('is closed') });
    await expect(
      updateOrder(h.db, orderId, { expectedOn: '2026-12-01' }, settings),
    ).rejects.toMatchObject({ statusCode: 409 });
    await updateOrder(h.db, orderId, { notes: 'Rest never came' }, settings);
    expect((await loadOrder(h.db, orderId, settings)).notes).toBe('Rest never came');
  });

  it('marks a draft as ordered when it is received straight away', async () => {
    const item = await startedItem('TEE-1', 0);
    const orderId = await order(await supplier(), [{ itemId: item.itemId, quantityOrdered: 5 }]);
    await receive(orderId, [{ lineId: (await lineIds(orderId))[0]!, quantity: 5 }]);
    const po = await loadOrder(h.db, orderId, settings);
    expect(po.status).toBe('received');
    expect(po.orderedAt).not.toBeNull();
  });
});

describe('editing an order', () => {
  it('fills unit costs from the supplier, else the item cost × rate', async () => {
    const a = await startedItem('A-1', 0);
    const b = await startedItem('B-1', 0);
    const c = await startedItem('C-1', 0);
    await h.db.query('UPDATE items SET cost = 2.5 WHERE id = $1', [b.itemId]);
    const supplierId = await supplier('Bogotá Knits', 'COP');
    await putSupplierItem(h.db, supplierId, a.itemId, { unitCost: 9000 });
    const orderId = await order(
      supplierId,
      [
        { itemId: a.itemId, quantityOrdered: 1 },
        { itemId: b.itemId, quantityOrdered: 1 },
        { itemId: c.itemId, quantityOrdered: 1 },
      ],
      { exchangeRate: 4000 },
    );
    const po = await loadOrder(h.db, orderId, settings);
    expect(po.currencyCode).toBe('COP');
    expect(po.lines.map((l) => l.unitCost)).toEqual([9000, 10_000, 0]);
    expect(po.totals.total).toBe(19_000);
    expect(po.totals.totalBase).toBe(4.75);
  });

  it('needs an exchange rate for another currency, and suggests the last one used', async () => {
    const supplierId = await supplier('Euro Supplies', 'EUR');
    await expect(order(supplierId, [])).rejects.toMatchObject({
      statusCode: 400,
      message: 'Enter the exchange rate: how many EUR make 1 USD.',
    });
    expect(await suggestedExchangeRate(h.db, 'EUR', 'USD')).toBeNull();
    const first = await order(supplierId, [], { exchangeRate: 0.92 });
    expect((await loadOrder(h.db, first, settings)).exchangeRate).toBe(0.92);
    expect(await suggestedExchangeRate(h.db, 'EUR', 'USD')).toBe(0.92);
    // A store selling in COP gives its rate until an order in COP exists.
    await h.db.query(
      `UPDATE stores SET currency_code = 'COP', exchange_rate = 4100 WHERE id = $1`,
      [h.stores[0]!.id],
    );
    expect(await suggestedExchangeRate(h.db, 'COP', 'USD')).toBe(4100);
    expect(await suggestedExchangeRate(h.db, 'USD', 'USD')).toBe(1);
    // The base currency is always 1.
    const usd = await order(await supplier(), [], { exchangeRate: 3 });
    expect((await loadOrder(h.db, usd, settings)).exchangeRate).toBe(1);
    // A draft switched to another currency needs that currency's rate.
    await expect(updateOrder(h.db, usd, { currencyCode: 'EUR' }, settings)).rejects.toMatchObject({
      statusCode: 400,
    });
    await updateOrder(h.db, usd, { currencyCode: 'EUR', exchangeRate: 0.9 }, settings);
    expect((await loadOrder(h.db, usd, settings)).exchangeRate).toBe(0.9);
    await updateOrder(h.db, usd, { notes: 'x', currencyCode: 'EUR' }, settings);
    expect((await loadOrder(h.db, usd, settings)).exchangeRate).toBe(0.9);
  });

  it('keeps received units on an open order: never below them, never removed', async () => {
    const a = await startedItem('A-1', 0);
    const b = await startedItem('B-1', 0);
    const supplierId = await supplier();
    const orderId = await order(supplierId, [
      { itemId: a.itemId, quantityOrdered: 10, unitCost: 1 },
      { itemId: b.itemId, quantityOrdered: 5, unitCost: 2 },
    ]);
    const [lineA] = await lineIds(orderId);
    await receive(orderId, [{ lineId: lineA!, quantity: 6 }]);

    await expect(
      updateOrder(
        h.db,
        orderId,
        { lines: [{ id: lineA, itemId: a.itemId, quantityOrdered: 5 }] },
        settings,
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('at least 6') });
    await expect(
      updateOrder(h.db, orderId, { lines: [{ itemId: b.itemId, quantityOrdered: 5 }] }, settings),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('can’t be removed'),
    });
    await expect(
      updateOrder(h.db, orderId, { supplierId: await supplier('Other') }, settings),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      updateOrder(
        h.db,
        orderId,
        {
          lines: [
            { itemId: a.itemId, quantityOrdered: 10 },
            { itemId: a.itemId, quantityOrdered: 1 },
          ],
        },
        settings,
      ),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('twice') });

    // Line B dropped (nothing received), A cut to what arrived: the order is complete.
    await updateOrder(
      h.db,
      orderId,
      {
        expectedOn: '2026-11-30',
        lines: [{ id: lineA, itemId: a.itemId, quantityOrdered: 6, unitCost: 1.5 }],
      },
      settings,
    );
    const po = await loadOrder(h.db, orderId, settings);
    expect(po.status).toBe('received');
    expect(po.expectedOn).toBe('2026-11-30');
    expect(po.lines).toHaveLength(1);
    expect(po.lines[0]).toMatchObject({ id: lineA, unitCost: 1.5 });
  });

  it('keeps a line whose delivery was undone, so the order’s history stays complete', async () => {
    const a = await startedItem('A-1', 0);
    const c = await startedItem('C-1', 0);
    const orderId = await order(await supplier(), [
      { itemId: a.itemId, quantityOrdered: 10 },
      { itemId: c.itemId, quantityOrdered: 3 },
    ]);
    const [lineA, lineC] = await lineIds(orderId);
    expect((await loadOrder(h.db, orderId, settings)).lines[1]!.hasDeliveries).toBe(false);
    const wrong = await receive(orderId, [{ lineId: lineC!, quantity: 3 }]);
    await reverseReceipt(h.db, orderId, wrong.receiptId);
    expect((await loadOrder(h.db, orderId, settings)).lines[1]).toMatchObject({
      quantityReceived: 0,
      hasDeliveries: true,
    });
    await expect(
      updateOrder(
        h.db,
        orderId,
        { lines: [{ id: lineA, itemId: a.itemId, quantityOrdered: 10 }] },
        settings,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('C-1 can’t be removed'),
    });
    const po = await loadOrder(h.db, orderId, settings);
    expect(po.lines).toHaveLength(2);
    expect(po.receipts).toHaveLength(1);
    expect(po.receipts[0]!.lines).toMatchObject([{ sku: 'C-1', quantity: 3 }]);
    // Its quantity can still go down.
    await updateOrder(
      h.db,
      orderId,
      {
        lines: [
          { id: lineA, itemId: a.itemId, quantityOrdered: 10 },
          { id: lineC, itemId: c.itemId, quantityOrdered: 1 },
        ],
      },
      settings,
    );
    expect((await loadOrder(h.db, orderId, settings)).lines[1]!.quantityOrdered).toBe(1);
  });
});

describe('draft orders from reorder suggestions', () => {
  it('makes one draft per supplier, and refuses items without one', async () => {
    const a = await startedItem('A-1', 0);
    const b = await startedItem('B-1', 0);
    const c = await startedItem('C-1', 0);
    const acme = await supplier();
    const knits = await supplier('Bogotá Knits', 'COP');
    await putSupplierItem(h.db, acme, a.itemId, { unitCost: 2 });
    await putSupplierItem(h.db, knits, b.itemId, { unitCost: 9000 });
    await expect(
      createDraftOrders(
        h.db,
        [
          { itemId: a.itemId, quantity: 10 },
          { itemId: c.itemId, quantity: 4 },
        ],
        settings,
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Choose a supplier for C-1 first, or leave it out.',
      details: { itemsWithoutSupplier: [c.itemId] },
    });
    const { rows: before } = await h.db.query('SELECT 1 FROM purchase_orders');
    expect(before).toHaveLength(0);

    // No rate known for COP yet: it is asked for, never made up (1 COP = 1 USD would turn
    // 9,000 COP into a $9,000 cost), and nothing is created half way.
    const both = [
      { itemId: a.itemId, quantity: 10 },
      { itemId: b.itemId, quantity: 4 },
    ];
    await expect(createDraftOrders(h.db, both, settings)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Enter the exchange rate for the COP order: how many COP make 1 USD.',
      details: { exchangeRatesNeeded: ['COP'], baseCurrency: 'USD' },
    });
    expect((await h.db.query('SELECT 1 FROM purchase_orders')).rows).toHaveLength(0);

    const result = await createDraftOrders(h.db, both, settings, { COP: 4000 });
    expect(result.orderIds).toHaveLength(2);
    const orders = await Promise.all(result.orderIds.map((id) => loadOrder(h.db, id, settings)));
    expect(orders.map((o) => [o.supplier.name, o.status, o.currencyCode, o.exchangeRate])).toEqual([
      ['Acme', 'draft', 'USD', 1],
      ['Bogotá Knits', 'draft', 'COP', 4000],
    ]);
    // Next time the rate entered is suggested, so it isn't asked again.
    const again = await createDraftOrders(h.db, [{ itemId: b.itemId, quantity: 2 }], settings);
    expect((await loadOrder(h.db, again.orderIds[0]!, settings)).exchangeRate).toBe(4000);
    expect(orders[0]!.lines.map((l) => [l.sku, l.quantityOrdered, l.unitCost])).toEqual([
      ['A-1', 10, 2],
    ]);
    expect(orders[1]!.lines.map((l) => [l.sku, l.quantityOrdered, l.unitCost])).toEqual([
      ['B-1', 4, 9000],
    ]);
  });
});
