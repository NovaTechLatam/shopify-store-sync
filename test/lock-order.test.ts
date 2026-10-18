import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOrder, loadOrder, markOrdered, receiveOrder } from '../src/purchasing/orders.js';
import { createSupplier } from '../src/purchasing/suppliers.js';
import { getSettings } from '../src/settings.js';
import { harnessApp, type ApiCall } from './helpers/app.js';
import { Harness, type TestItem } from './helpers/harness.js';

/**
 * Transactions that change several items lock them in id order (src/db/locks.ts). These tests
 * slow every item update down (a trigger that sleeps), so two transactions on the same items
 * overlap for certain: if one of them updated its items in another order without locking them
 * first, each would hold a row the other wants and Postgres would abort one ("deadlock detected").
 */

let h: Harness;
let app: FastifyInstance;
let api: ApiCall;

beforeEach(async () => {
  h = await Harness.create(2);
  ({ app, api } = await harnessApp(h));
  await h.db.query(`
    CREATE FUNCTION slow_item_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$;
    CREATE TRIGGER slow_item_update BEFORE UPDATE ON items
      FOR EACH ROW EXECUTE FUNCTION slow_item_update();`);
});

afterEach(async () => {
  await app.close();
  await h.close();
});

async function startedItem(sku: string): Promise<TestItem> {
  const item = await h.addItem(sku, [10, 10]);
  await h.initialize(item, 'min');
  await h.drain();
  return item;
}

describe('lock order on items', () => {
  it('lets a delivery and a bulk price edit of the same items, in opposite orders, both finish', async () => {
    const a = await startedItem('LOCK-A');
    const b = await startedItem('LOCK-B');
    await h.db.query('UPDATE items SET base_price = 10, cost = 4');
    const settings = await getSettings(h.db);
    const supplierId = await createSupplier(h.db, { name: 'Acme', currencyCode: 'USD' });
    // The order lists B first: the delivery updates B's cost, then A's.
    const orderId = await createOrder(
      h.db,
      {
        supplierId,
        lines: [
          { itemId: b.itemId, quantityOrdered: 50, unitCost: 6 },
          { itemId: a.itemId, quantityOrdered: 50, unitCost: 6 },
        ],
      },
      settings,
    );
    await markOrdered(h.db, orderId);
    const lines = (await loadOrder(h.db, orderId, settings)).lines;

    for (let round = 0; round < 2; round++) {
      const receive = receiveOrder(
        h.db,
        orderId,
        { requestId: randomUUID(), lines: lines.map((l) => ({ lineId: l.id, quantity: 5 })) },
        settings,
      );
      // The bulk edit starts while the delivery is updating its first item (or just before).
      await new Promise((r) => setTimeout(r, round === 0 ? 50 : 0));
      const bulk = api('POST', '/api/prices/items/bulk', {
        itemIds: [a.itemId, b.itemId],
        op: 'percent',
        field: 'basePrice',
        value: 10,
      });
      const [received, edited] = await Promise.allSettled([receive, bulk]);
      expect(received.status).toBe('fulfilled');
      expect(edited.status === 'fulfilled' && edited.value.status).toBe(200);
    }

    const { rows } = await h.db.query<{ sku: string; base_price: number; cost: number }>(
      'SELECT sku, base_price, cost FROM items ORDER BY sku',
    );
    expect(rows.map((r) => [r.sku, r.base_price])).toEqual([
      ['LOCK-A', 12.1],
      ['LOCK-B', 12.1],
    ]);
    // Both deliveries counted: 10 at 4, then 5 at 6 (4.6667), then 5 more at 6.
    expect(rows.map((r) => r.cost)).toEqual([5, 5]);
    await h.drain();
    expect(await h.shared(a)).toBe(20);
    expect(await h.shared(b)).toBe(20);
  });

  it('lets a catalog save and a bulk price edit of the same items both finish', async () => {
    const created = await api('POST', '/api/catalog/products', {
      title: 'Lock tee',
      options: [{ name: 'Size', values: ['S', 'M'] }],
      variants: [
        { sku: 'LOCK-S', optionValues: ['S'], basePrice: 10 },
        { sku: 'LOCK-M', optionValues: ['M'], basePrice: 10 },
      ],
    });
    expect(created.status).toBe(201);
    const ids: number[] = created.body.variants.map((v: any) => v.itemId);
    // S's row moves behind M's in the table, so a plain scan meets M first too.
    await h.db.query('UPDATE items SET title = title WHERE id = $1', [ids[0]]);
    // The editor sends M before S: its update takes the items in the other order.
    const save = api('PATCH', `/api/catalog/products/${created.body.id}`, {
      variants: [...created.body.variants].reverse().map((v: any) => ({
        id: v.id,
        sku: v.sku,
        optionValues: v.optionValues,
        cost: 3,
      })),
    });
    await new Promise((r) => setTimeout(r, 50));
    const bulk = api('POST', '/api/prices/items/bulk', {
      itemIds: ids,
      op: 'add',
      field: 'basePrice',
      value: 1,
    });
    const [saved, edited] = await Promise.all([save, bulk]);
    expect([saved.status, edited.status]).toEqual([200, 200]);
    const { rows } = await h.db.query<{ base_price: number; cost: number }>(
      'SELECT base_price, cost FROM items ORDER BY id',
    );
    expect(rows).toEqual([
      { base_price: 11, cost: 3 },
      { base_price: 11, cost: 3 },
    ]);
  });
});
