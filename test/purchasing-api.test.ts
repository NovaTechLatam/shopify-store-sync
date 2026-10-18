import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { SecretBox } from '../src/util/crypto.js';
import { Harness, silentLogger, type TestItem } from './helpers/harness.js';

const AUTH = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;

let h: Harness;
let app: FastifyInstance;
let woken = 0;

beforeEach(async () => {
  h = await Harness.create(2);
  woken = 0;
  app = await buildServer({
    db: h.db,
    secrets: new SecretBox(Buffer.alloc(32, 7).toString('base64')),
    shopify: Object.assign(h.registry, { invalidate: () => {} }),
    createAdmin: () => {
      throw new Error('not used');
    },
    logger: silentLogger,
    publicUrl: 'https://sync.example.com',
    adminUsername: 'admin',
    adminPassword: 'correct-horse-battery',
    onWork: () => woken++,
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
  const json = res.headers['content-type']?.toString().startsWith('application/json');
  return {
    status: res.statusCode,
    body: res.body && json ? (JSON.parse(res.body) as any) : undefined,
    text: res.body,
    headers: res.headers,
  };
};

async function startedItem(sku: string, start: number): Promise<TestItem> {
  const item = await h.addItem(sku, [start, start]);
  await h.initialize(item, 'min');
  await h.drain();
  return item;
}

async function newSupplier(body: Record<string, unknown> = {}) {
  const res = await api('POST', '/api/purchasing/suppliers', { name: 'Acme', ...body });
  expect(res.status).toBe(201);
  return res.body as { id: number };
}

async function reorderTasks(): Promise<number> {
  const { rows } = await h.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE kind = 'reorder_check'`,
  );
  return rows[0]!.n;
}

describe('suppliers API', () => {
  it('creates, lists, edits and validates suppliers', async () => {
    const created = await api('POST', '/api/purchasing/suppliers', {
      name: 'Acme Textiles',
      contactName: 'Ana',
      email: 'orders@acme.test',
      leadTimeDays: 21,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Acme Textiles',
      currencyCode: 'USD', // the base currency
      leadTimeDays: 21,
      exchangeRate: 1,
      itemCount: 0,
      openOrders: 0,
      items: [],
    });

    expect((await api('POST', '/api/purchasing/suppliers', { name: 'acme textiles' })).status).toBe(
      409,
    );
    expect(
      (await api('POST', '/api/purchasing/suppliers', { name: 'B', email: 'not an email' })).status,
    ).toBe(400);
    expect(
      (await api('POST', '/api/purchasing/suppliers', { name: 'B', currencyCode: 'usd' })).status,
    ).toBe(400);
    expect(
      (await api('POST', '/api/purchasing/suppliers', { name: 'B', leadTimeDays: -1 })).status,
    ).toBe(400);
    expect((await api('POST', '/api/purchasing/suppliers', { name: ' ' })).status).toBe(400);

    const patched = await api('PATCH', `/api/purchasing/suppliers/${created.body.id}`, {
      contactName: '',
      email: null,
      leadTimeDays: 10,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ contactName: null, email: null, leadTimeDays: 10 });
    expect(await reorderTasks()).toBe(1); // the lead time changed

    const list = await api('GET', '/api/purchasing/suppliers');
    expect(list.body.map((s: { name: string }) => s.name)).toEqual(['Acme Textiles']);
    expect((await api('GET', '/api/purchasing/suppliers/999')).status).toBe(404);
    expect((await api('PATCH', '/api/purchasing/suppliers/999', { notes: 'x' })).status).toBe(404);
  });

  it('keeps what a supplier sells, and the preferred supplier of each product', async () => {
    const item = await startedItem('TEE-1', 0);
    const acme = await newSupplier();
    const other = await newSupplier({ name: 'Other', currencyCode: 'EUR' });
    const put = await api('PUT', `/api/purchasing/suppliers/${acme.id}/items/${item.itemId}`, {
      supplierSku: 'AC-TEE',
      unitCost: 2.4,
      minOrderQty: 24,
      packSize: 12,
    });
    expect(put.status).toBe(200);
    // The product had no preferred supplier: it gets this one.
    expect(put.body).toMatchObject({ sku: 'TEE-1', supplierSku: 'AC-TEE', preferred: true });
    expect(
      (
        await api('PUT', `/api/purchasing/suppliers/${other.id}/items/${item.itemId}`, {
          unitCost: 2,
        })
      ).body.preferred,
    ).toBe(false);
    // A partial update keeps the rest.
    const partial = await api('PUT', `/api/purchasing/suppliers/${acme.id}/items/${item.itemId}`, {
      unitCost: 2.5,
    });
    expect(partial.body).toMatchObject({ unitCost: 2.5, minOrderQty: 24, packSize: 12 });
    expect(
      (
        await api('PUT', `/api/purchasing/suppliers/${acme.id}/items/${item.itemId}`, {
          packSize: 0,
        })
      ).status,
    ).toBe(400);
    expect((await api('PUT', `/api/purchasing/suppliers/${acme.id}/items/999`, {})).status).toBe(
      404,
    );
    const one = await api('GET', `/api/purchasing/suppliers/${acme.id}/items/${item.itemId}`);
    expect(one.body).toMatchObject({ itemId: item.itemId, unitCost: 2.5, preferred: true });
    expect((await api('GET', `/api/purchasing/suppliers/${acme.id}/items/999`)).status).toBe(404);

    let info = await api('GET', `/api/purchasing/items/${item.itemId}`);
    expect(info.body.supplier).toEqual({ id: acme.id, name: 'Acme' });
    expect(info.body.suppliers.map((s: { name: string }) => s.name)).toEqual(['Acme', 'Other']);

    const switched = await api('PATCH', `/api/purchasing/items/${item.itemId}`, {
      supplierId: other.id,
      leadTimeDays: 5,
      reorderCoverDays: 20,
      reorderEnabled: false,
    });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({
      supplier: { id: other.id, name: 'Other' },
      leadTimeDays: 5,
      reorderCoverDays: 20,
      reorderEnabled: false,
    });
    expect(switched.body.reorder).toMatchObject({ leadTimeDays: 5, leadTimeSource: 'item' });
    expect(
      (await api('PATCH', `/api/purchasing/items/${item.itemId}`, { reorderCoverDays: 0 })).status,
    ).toBe(400);
    expect((await api('PATCH', '/api/purchasing/items/999', { leadTimeDays: 1 })).status).toBe(404);

    expect(
      (await api('DELETE', `/api/purchasing/suppliers/${other.id}/items/${item.itemId}`)).status,
    ).toBe(204);
    info = await api('GET', `/api/purchasing/items/${item.itemId}`);
    expect(info.body.supplier).toBeNull(); // it was the preferred one
    expect(
      (await api('DELETE', `/api/purchasing/suppliers/${other.id}/items/${item.itemId}`)).status,
    ).toBe(404);
  });

  it('changes the currency of a supplier with prices only when asked to', async () => {
    const tee = await startedItem('TEE-1', 0);
    const cap = await startedItem('CAP-1', 0);
    const acme = await newSupplier({ currencyCode: 'EUR' });
    // No prices yet: nothing to reinterpret.
    const free = await api('PATCH', `/api/purchasing/suppliers/${acme.id}`, {
      currencyCode: 'USD',
    });
    expect(free.status).toBe(200);
    for (const item of [tee, cap]) {
      await api('PUT', `/api/purchasing/suppliers/${acme.id}/items/${item.itemId}`, {
        unitCost: 2.5,
      });
    }
    const refused = await api('PATCH', `/api/purchasing/suppliers/${acme.id}`, {
      currencyCode: 'GBP',
      notes: 'New contract',
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error:
        '“Acme” has prices for 2 products in USD. They stay the same numbers, now in GBP (12.50 USD becomes 12.50 GBP). Confirm the change, or update the prices first.',
      currencyChange: { pricedItems: 2 },
    });
    // Nothing was saved.
    const before = await api('GET', `/api/purchasing/suppliers/${acme.id}`);
    expect(before.body).toMatchObject({ currencyCode: 'USD', notes: null, pricedItemCount: 2 });
    // The same currency, or other fields, need no confirmation.
    expect(
      (await api('PATCH', `/api/purchasing/suppliers/${acme.id}`, { currencyCode: 'USD' })).status,
    ).toBe(200);
    const confirmed = await api('PATCH', `/api/purchasing/suppliers/${acme.id}`, {
      currencyCode: 'GBP',
      notes: 'New contract',
      confirmCurrencyChange: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ currencyCode: 'GBP', notes: 'New contract' });
    // The prices kept their numbers.
    expect(confirmed.body.items.map((i: any) => i.unitCost)).toEqual([2.5, 2.5]);
  });

  it('archives suppliers without open orders, and deletes only those that never had one', async () => {
    const item = await startedItem('TEE-1', 0);
    const acme = await newSupplier();
    await api('PUT', `/api/purchasing/suppliers/${acme.id}/items/${item.itemId}`, {});
    const po = await api('POST', '/api/purchasing/orders', {
      supplierId: acme.id,
      lines: [{ itemId: item.itemId, quantityOrdered: 1 }],
    });
    const archive = await api('POST', `/api/purchasing/suppliers/${acme.id}/archive`);
    expect(archive.status).toBe(409);
    expect(archive.body.error).toContain('1 open order');
    await api('POST', `/api/purchasing/orders/${po.body.id}/cancel`);

    expect((await api('DELETE', `/api/purchasing/suppliers/${acme.id}`)).status).toBe(409);
    const archived = await api('POST', `/api/purchasing/suppliers/${acme.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).not.toBeNull();
    expect((await api('GET', '/api/purchasing/suppliers')).body).toEqual([]);
    expect((await api('GET', '/api/purchasing/suppliers?archived=true')).body).toHaveLength(1);
    expect((await api('GET', `/api/purchasing/items/${item.itemId}`)).body.supplier).toBeNull();
    // An archived supplier gets no new orders.
    expect(
      (await api('POST', '/api/purchasing/orders', { supplierId: acme.id, lines: [] })).status,
    ).toBe(409);
    // Its name is free again, until it is restored.
    const again = await newSupplier();
    expect((await api('POST', `/api/purchasing/suppliers/${acme.id}/restore`)).status).toBe(409);
    expect((await api('DELETE', `/api/purchasing/suppliers/${again.id}`)).status).toBe(204);
    expect((await api('POST', `/api/purchasing/suppliers/${acme.id}/restore`)).status).toBe(200);
  });
});

describe('purchase orders API', () => {
  it('creates, lists, edits, orders, receives, undoes and closes an order', async () => {
    const a = await startedItem('TEE-1', 10);
    const b = await startedItem('CAP-1', 0);
    const acme = await newSupplier();

    const created = await api('POST', '/api/purchasing/orders', {
      supplierId: acme.id,
      expectedOn: '2026-11-30',
      notes: 'Spring restock',
      lines: [
        { itemId: a.itemId, quantityOrdered: 20, unitCost: 4 },
        { itemId: b.itemId, quantityOrdered: 5, unitCost: 2.5 },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      number: 'PO-0001',
      status: 'draft',
      currencyCode: 'USD',
      expectedOn: '2026-11-30',
      supplier: { id: acme.id, name: 'Acme' },
      warehouse: { id: h.warehouseId },
      totals: { lines: 2, quantityOrdered: 25, total: 92.5, totalBase: 92.5 },
    });
    const id = created.body.id as number;

    expect(
      (
        await api('POST', '/api/purchasing/orders', {
          supplierId: acme.id,
          lines: [{ itemId: a.itemId, quantityOrdered: 0 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api('POST', '/api/purchasing/orders', {
          supplierId: acme.id,
          expectedOn: '2026-02-30',
        })
      ).status,
    ).toBe(400);
    expect((await api('POST', '/api/purchasing/orders', { supplierId: 999 })).status).toBe(400);

    const second = await api('POST', '/api/purchasing/orders', { supplierId: acme.id });
    expect(second.body.number).toBe('PO-0002');

    let list = await api('GET', '/api/purchasing/orders');
    expect(list.body).toMatchObject({ total: 2, counts: { draft: 2, open: 2, all: 2 } });
    list = await api('GET', '/api/purchasing/orders?search=cap');
    expect(list.body.orders.map((o: { number: string }) => o.number)).toEqual(['PO-0001']);
    list = await api('GET', '/api/purchasing/orders?status=received');
    expect(list.body.total).toBe(0);
    expect((await api('GET', '/api/purchasing/orders?status=nope')).status).toBe(400);
    expect((await api('DELETE', `/api/purchasing/orders/${second.body.id}`)).status).toBe(204);

    const edited = await api('PATCH', `/api/purchasing/orders/${id}`, {
      lines: [
        { id: created.body.lines[0].id, itemId: a.itemId, quantityOrdered: 30, unitCost: 4 },
        { itemId: b.itemId, quantityOrdered: 5, unitCost: 2.5 },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.totals.quantityOrdered).toBe(35);

    const ordered = await api('POST', `/api/purchasing/orders/${id}/order`);
    expect(ordered.body.status).toBe('ordered');
    const [lineA, lineB] = ordered.body.lines as { id: number }[];

    expect(
      (
        await api('POST', `/api/purchasing/orders/${id}/receive`, {
          requestId: 'not-a-uuid',
          lines: [{ lineId: lineA!.id, quantity: 1 }],
        })
      ).status,
    ).toBe(400);
    const over = await api('POST', `/api/purchasing/orders/${id}/receive`, {
      requestId: randomUUID(),
      lines: [{ lineId: lineB!.id, quantity: 9 }],
    });
    expect(over.status).toBe(409);
    expect(over.body.overReceipt).toEqual([
      { lineId: lineB!.id, sku: 'CAP-1', remaining: 5, quantity: 9 },
    ]);

    const requestId = randomUUID();
    const body = { requestId, note: 'Box 1 of 2', lines: [{ lineId: lineA!.id, quantity: 12 }] };
    woken = 0;
    const received = await api('POST', `/api/purchasing/orders/${id}/receive`, body);
    expect(received.status).toBe(201);
    expect(woken).toBeGreaterThan(0);
    expect(received.body).toMatchObject({
      duplicate: false,
      waiting: [],
      receipt: { note: 'Box 1 of 2', units: 12, reversedAt: null },
      order: { status: 'partial' },
    });
    const retried = await api('POST', `/api/purchasing/orders/${id}/receive`, body);
    expect(retried.status).toBe(200);
    expect(retried.body.duplicate).toBe(true);
    expect(retried.body.receipt.id).toBe(received.body.receipt.id);
    expect(retried.body.order.lines[0].quantityReceived).toBe(12);

    await h.drain();
    expect(h.levels(a)).toEqual([22, 22]);

    const undone = await api(
      'POST',
      `/api/purchasing/orders/${id}/receipts/${received.body.receipt.id}/reverse`,
    );
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ status: 'ordered', alreadyReversed: false });
    const twice = await api(
      'POST',
      `/api/purchasing/orders/${id}/receipts/${received.body.receipt.id}/reverse`,
    );
    expect(twice.body.alreadyReversed).toBe(true);
    await h.drain();
    expect(h.levels(a)).toEqual([10, 10]);

    await api('POST', `/api/purchasing/orders/${id}/receive`, {
      requestId: randomUUID(),
      lines: [{ lineId: lineB!.id, quantity: 5 }],
    });
    const closed = await api('POST', `/api/purchasing/orders/${id}/close`);
    expect(closed.body).toMatchObject({ status: 'closed', allowed: { receive: false } });
    expect((await api('POST', `/api/purchasing/orders/${id}/cancel`)).status).toBe(409);
    expect((await api('DELETE', `/api/purchasing/orders/${id}`)).status).toBe(409);
    expect((await api('PATCH', `/api/purchasing/orders/${id}`, { notes: 'Done' })).body.notes).toBe(
      'Done',
    );
    expect((await api('GET', '/api/purchasing/orders/999')).status).toBe(404);
    expect(await reorderTasks()).toBe(1);
  });

  it('says which products only get their units once they start syncing', async () => {
    const { rows } = await h.db.query<{ id: number }>(
      `INSERT INTO items (sku, title) VALUES ('NEW-1', 'New') RETURNING id`,
    );
    await h.db.query('INSERT INTO pool_levels (item_id, warehouse_id) VALUES ($1, $2)', [
      rows[0]!.id,
      h.warehouseId,
    ]);
    const acme = await newSupplier();
    const po = await api('POST', '/api/purchasing/orders', {
      supplierId: acme.id,
      lines: [{ itemId: rows[0]!.id, quantityOrdered: 4 }],
    });
    const received = await api('POST', `/api/purchasing/orders/${po.body.id}/receive`, {
      requestId: randomUUID(),
      lines: [{ lineId: po.body.lines[0].id, quantity: 3 }],
    });
    expect(received.status).toBe(201);
    expect(received.body.waiting).toEqual([
      { itemId: rows[0]!.id, sku: 'NEW-1', reason: 'not_started' },
    ]);
    expect(received.body.order.lines[0].syncing).toBe(false);
    expect(received.body.syncPaused).toBe(false);

    // With syncing paused for every product, the stores only get the units on resume: say so.
    await api('POST', '/api/settings/pause', {});
    const paused = await api('POST', `/api/purchasing/orders/${po.body.id}/receive`, {
      requestId: randomUUID(),
      lines: [{ lineId: po.body.lines[0].id, quantity: 1 }],
    });
    expect(paused.status).toBe(201);
    expect(paused.body.syncPaused).toBe(true);
    const undone = await api(
      'POST',
      `/api/purchasing/orders/${po.body.id}/receipts/${paused.body.receipt.id}/reverse`,
    );
    expect(undone.body).toMatchObject({ alreadyReversed: false, syncPaused: true });
  });

  it('downloads an order as a CSV that is safe to open in a spreadsheet', async () => {
    const item = await startedItem('TEE-1', 0);
    await h.db.query(`UPDATE items SET title = '=HYPERLINK("x"), "tee"' WHERE id = $1`, [
      item.itemId,
    ]);
    const acme = await newSupplier({ name: 'Acme, Inc.' });
    const po = await api('POST', '/api/purchasing/orders', {
      supplierId: acme.id,
      lines: [{ itemId: item.itemId, quantityOrdered: 3, unitCost: 1.005 }],
    });
    const res = await api('GET', `/api/purchasing/orders/${po.body.id}.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="PO-0001.csv"');
    expect(res.text.split('\r\n')).toEqual([
      'Order,Supplier,Status,Currency,SKU,Supplier SKU,Product,Ordered,Received,Remaining,Unit cost,Line total',
      `PO-0001,"Acme, Inc.",draft,USD,TEE-1,,"'=HYPERLINK(""x""), ""tee""",3,0,3,1.01,3.02`,
      '',
    ]);
    expect((await api('GET', '/api/purchasing/orders/abc.csv')).status).toBe(400);
  });
});

describe('reorder API', () => {
  async function sell(itemId: number, units: number) {
    const { rows } = await h.db.query<{ id: number }>(
      `INSERT INTO sales_orders (store_id, shopify_order_id, processed_at, shopify_updated_at, currency_code)
       VALUES ($1, $2, now() - interval '10 days', now(), 'USD') RETURNING id`,
      [h.stores[0]!.id, `gid://shopify/Order/${itemId}`],
    );
    await h.db.query(
      `INSERT INTO sales_lines (order_id, store_id, shopify_line_id, item_id, quantity, current_quantity, processed_at)
       VALUES ($1, $2, $3, $4, $5, $5, now() - interval '1 day')`,
      [rows[0]!.id, h.stores[0]!.id, `gid://shopify/LineItem/${itemId}`, itemId, units],
    );
  }

  it('lists suggestions and turns them into draft orders per supplier', async () => {
    const tee = await startedItem('TEE-1', 5);
    const cap = await startedItem('CAP-1', 2);
    const sock = await startedItem('SOCK-1', 500);
    for (const item of [tee, cap]) await sell(item.itemId, 30);
    await sell(sock.itemId, 3);
    const acme = await newSupplier();
    await api('PUT', `/api/purchasing/suppliers/${acme.id}/items/${tee.itemId}`, { unitCost: 3 });

    const needed = await api('GET', '/api/purchasing/reorder');
    expect(needed.status).toBe(200);
    expect(needed.body).toMatchObject({
      total: 2,
      counts: { needed: 2, all: 3 },
      sales: { recorded: true },
      settings: { lookbackDays: 30, safetyDays: 7, coverDays: 30, defaultLeadTimeDays: 14 },
    });
    // Soonest out of stock first.
    expect(needed.body.rows.map((r: { sku: string }) => r.sku)).toEqual(['CAP-1', 'TEE-1']);
    expect(needed.body.rows[1]).toMatchObject({ supplier: { name: 'Acme' }, supplierUnitCost: 3 });

    const all = await api('GET', '/api/purchasing/reorder?filter=all&search=sock');
    expect(all.body.rows.map((r: { sku: string }) => r.sku)).toEqual(['SOCK-1']);
    const none = await api('GET', '/api/purchasing/reorder?supplierId=none');
    expect(none.body.rows.map((r: { sku: string }) => r.sku)).toEqual(['CAP-1']);
    expect((await api('GET', '/api/purchasing/reorder?supplierId=abc')).status).toBe(400);

    const refused = await api('POST', '/api/purchasing/reorder/draft-orders', {
      lines: [
        { itemId: tee.itemId, quantity: 40 },
        { itemId: cap.itemId, quantity: 10 },
      ],
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: 'Choose a supplier for CAP-1 first, or leave it out.',
      itemsWithoutSupplier: [cap.itemId],
    });
    const drafts = await api('POST', '/api/purchasing/reorder/draft-orders', {
      lines: [{ itemId: tee.itemId, quantity: 40 }],
    });
    expect(drafts.status).toBe(201);
    expect(drafts.body.orderIds).toHaveLength(1);
    const po = await api('GET', `/api/purchasing/orders/${drafts.body.orderIds[0]}`);
    expect(po.body).toMatchObject({
      status: 'draft',
      lines: [{ sku: 'TEE-1', quantityOrdered: 40, unitCost: 3 }],
    });
    expect((await api('POST', '/api/purchasing/reorder/draft-orders', { lines: [] })).status).toBe(
      400,
    );

    // A supplier in a currency without a known rate: the rate is asked for, then used.
    const euro = await api('POST', '/api/purchasing/suppliers', {
      name: 'Euro Caps',
      currencyCode: 'EUR',
    });
    await api('PUT', `/api/purchasing/suppliers/${euro.body.id}/items/${cap.itemId}`, {
      unitCost: 2,
    });
    const capLines = { lines: [{ itemId: cap.itemId, quantity: 10 }] };
    const ask = await api('POST', '/api/purchasing/reorder/draft-orders', capLines);
    expect(ask.status).toBe(400);
    expect(ask.body).toMatchObject({ exchangeRatesNeeded: ['EUR'], baseCurrency: 'USD' });
    const badRate = await api('POST', '/api/purchasing/reorder/draft-orders', {
      ...capLines,
      exchangeRates: { EUR: 0 },
    });
    expect(badRate.status).toBe(400);
    const eur = await api('POST', '/api/purchasing/reorder/draft-orders', {
      ...capLines,
      exchangeRates: { EUR: 0.92 },
    });
    expect(eur.status).toBe(201);
    const eurOrder = await api('GET', `/api/purchasing/orders/${eur.body.orderIds[0]}`);
    expect(eurOrder.body).toMatchObject({ currencyCode: 'EUR', exchangeRate: 0.92 });
  });

  it('finds products for the order editor, the supplier’s first', async () => {
    const tee = await startedItem('TEE-1', 5);
    await startedItem('TEE-2', 5);
    const acme = await newSupplier();
    await api('PUT', `/api/purchasing/suppliers/${acme.id}/items/${tee.itemId}`, {
      supplierSku: 'ZZ-9',
      unitCost: 3,
    });
    const res = await api('GET', `/api/purchasing/item-search?search=tee&supplierId=${acme.id}`);
    expect(res.body.map((r: { sku: string }) => r.sku)).toEqual(['TEE-1', 'TEE-2']);
    expect(res.body[0]).toMatchObject({ supplierSku: 'ZZ-9', supplierUnitCost: 3, available: 5 });
    const bySupplierSku = await api('GET', '/api/purchasing/item-search?search=zz-9');
    expect(bySupplierSku.body).toEqual([]); // supplier SKUs need the supplier
    const withSupplier = await api(
      'GET',
      `/api/purchasing/item-search?search=zz-9&supplierId=${acme.id}`,
    );
    expect(withSupplier.body.map((r: { sku: string }) => r.sku)).toEqual(['TEE-1']);
  });
});
