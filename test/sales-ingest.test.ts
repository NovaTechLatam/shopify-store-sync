import { afterEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db/pool.js';
import {
  fillMissingCosts,
  ingestOrders,
  mapUnmatchedLines,
  removeOrder,
  upsertOrder,
} from '../src/sales/ingest.js';
import type { ShopifyOrder } from '../src/shopify/types.js';
import type { OrderInput } from './fakes/fake-shopify.js';
import { Harness, type TestStore } from './helpers/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function variantOf(store: TestStore, sku: string) {
  const v = store.shop.variants.find((x) => x.sku === sku);
  if (!v) throw new Error(`no variant ${sku}`);
  return v;
}

interface LineRow {
  shopify_line_id: string;
  item_id: number | null;
  sku: string | null;
  quantity: number;
  current_quantity: number;
  gross: number;
  discounts: number;
  net: number;
  unit_cost: number | null;
  is_gift_card: boolean;
}

async function lines(orderGid: string): Promise<LineRow[]> {
  const { rows } = await h.db.query<LineRow>(
    `SELECT l.shopify_line_id, l.item_id, l.sku, l.quantity, l.current_quantity, l.gross,
            l.discounts, l.net, l.unit_cost, l.is_gift_card
       FROM sales_lines l JOIN sales_orders o ON o.id = l.order_id
      WHERE o.shopify_order_id = $1 ORDER BY l.id`,
    [orderGid],
  );
  return rows;
}

async function order(orderGid: string) {
  const { rows } = await h.db.query<{
    name: string;
    shopify_updated_at: Date;
    cancelled_at: Date | null;
    test: boolean;
    deleted_at: Date | null;
  }>(
    `SELECT name, shopify_updated_at, cancelled_at, test, deleted_at FROM sales_orders
      WHERE shopify_order_id = $1`,
    [orderGid],
  );
  return rows[0];
}

const save = (storeId: number, o: ShopifyOrder) =>
  withTransaction(h.db, (client) => upsertOrder(client, storeId, o));

describe('order ingestion', () => {
  it('maps lines by the store’s variant first, then by SKU, and keeps unknown SKUs unmatched', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    const tee = await h.addItem('TEE-1', [5]);
    const mug = await h.addItem('MUG-1', [5]);
    await h.db.query(`UPDATE items SET cost = 4.5 WHERE id = $1`, [tee.itemId]);
    // A variant whose SKU no longer matches its link (renamed in Shopify): the link wins.
    const renamed = variantOf(store, 'MUG-1');
    const o = store.shop.addOrder({
      lines: [
        { variantId: variantOf(store, 'TEE-1').variantId, quantity: 2, unitPrice: 20 },
        { variantId: renamed.variantId, sku: 'OLD-MUG', quantity: 1, unitPrice: 9 },
        // Variant deleted since: the SKU still finds the item (case and spaces don't matter).
        { variantId: null, sku: ' tee-1 ', quantity: 1, unitPrice: 20 },
        { variantId: null, sku: 'NOT-A-PRODUCT', quantity: 1, unitPrice: 3 },
      ],
    });
    expect(await save(store.id, o)).toBe('inserted');
    const saved = await lines(o.id);
    expect(saved.map((l) => [l.item_id, l.sku])).toEqual([
      [tee.itemId, 'TEE-1'],
      [mug.itemId, 'OLD-MUG'],
      [tee.itemId, 'TEE-1'],
      [null, 'NOT-A-PRODUCT'],
    ]);
    expect(saved[0]).toMatchObject({ quantity: 2, current_quantity: 2, gross: 40, unit_cost: 4.5 });
    expect(saved[1]!.unit_cost).toBeNull();
    // The same version again: an update, nothing changes.
    expect(await save(store.id, o)).toBe('updated');
    expect(await lines(o.id)).toEqual(saved);
  });

  it('never lets an older copy of an order overwrite a newer one', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    await h.addItem('TEE-1', [5]);
    const variantId = variantOf(store, 'TEE-1').variantId;
    const v1 = store.shop.addOrder({ lines: [{ variantId, quantity: 3, unitPrice: 10 }] });
    const v2 = store.shop.updateOrder(v1.id, {
      lines: [{ id: v1.lines[0]!.id, variantId, quantity: 3, currentQuantity: 1, unitPrice: 10 }],
    });
    expect(Date.parse(v2.updatedAt)).toBeGreaterThan(Date.parse(v1.updatedAt));

    expect(await save(store.id, v2)).toBe('inserted');
    expect(await save(store.id, v1)).toBe('stale');
    expect((await lines(v1.id))[0]).toMatchObject({ current_quantity: 1, net: 10 });
    expect((await order(v1.id))!.shopify_updated_at.toISOString()).toBe(v2.updatedAt);
  });

  it('applies refunds and edits: removed lines are deleted, the others updated in place', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    await h.addItem('TEE-1', [5]);
    await h.addItem('CAP-1', [5]);
    const tee = variantOf(store, 'TEE-1').variantId;
    const cap = variantOf(store, 'CAP-1').variantId;
    const placed = store.shop.addOrder({
      lines: [
        { variantId: tee, quantity: 2, unitPrice: 20, discounts: 4 },
        { variantId: cap, quantity: 1, unitPrice: 15 },
      ],
    });
    await save(store.id, placed);
    const [teeLine, capLine] = placed.lines as [ShopifyOrder['lines'][0], ShopifyOrder['lines'][0]];
    expect((await lines(placed.id)).map((l) => l.net)).toEqual([36, 15]);

    // The cap is removed by an order edit, one tee is refunded, and a new line is added.
    const edited = store.shop.updateOrder(placed.id, {
      lines: [
        {
          id: teeLine.id,
          variantId: tee,
          quantity: 2,
          currentQuantity: 1,
          unitPrice: 20,
          discounts: 4,
          net: 18,
        },
        { variantId: cap, quantity: 2, unitPrice: 15 },
      ],
    });
    expect(await save(store.id, edited)).toBe('updated');
    const after = await lines(placed.id);
    expect(after.map((l) => l.shopify_line_id)).not.toContain(capLine.id);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({
      shopify_line_id: teeLine.id,
      quantity: 2,
      current_quantity: 1,
      discounts: 4,
      net: 18,
    });
    expect(after[1]).toMatchObject({ quantity: 2, current_quantity: 2, net: 30 });

    // Cancelled: every line drops to 0 and the order says so.
    const cancelled = store.shop.updateOrder(placed.id, {
      cancelledAt: new Date().toISOString(),
      lines: edited.lines.map((l) => ({ ...l, currentQuantity: 0, net: 0 })),
    });
    await save(store.id, cancelled);
    expect((await order(placed.id))!.cancelled_at).not.toBeNull();
    expect((await lines(placed.id)).map((l) => l.current_quantity)).toEqual([0, 0]);
  });

  it('keeps each line’s cost snapshot, and fills it in once a product without a cost gets one', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    const tee = await h.addItem('TEE-1', [5]);
    const cap = await h.addItem('CAP-1', [5]);
    await h.db.query('UPDATE items SET cost = 5 WHERE id = $1', [tee.itemId]);
    const teeV = variantOf(store, 'TEE-1').variantId;
    const capV = variantOf(store, 'CAP-1').variantId;
    const placed = store.shop.addOrder({
      lines: [
        { variantId: teeV, quantity: 1, unitPrice: 20 },
        { variantId: capV, quantity: 1, unitPrice: 15 },
      ],
    });
    await save(store.id, placed);

    // The cost changes (a new delivery), then the order is refunded: the snapshot stays.
    await h.db.query('UPDATE items SET cost = 7 WHERE id = $1', [tee.itemId]);
    await h.db.query('UPDATE items SET cost = 3 WHERE id = $1', [cap.itemId]);
    const refunded = store.shop.updateOrder(placed.id, {
      lines: placed.lines.map((l) => ({ ...l, currentQuantity: 0, net: 0 })),
    });
    await save(store.id, refunded);
    // The cap had no cost when first seen: it takes the cost it has now.
    expect((await lines(placed.id)).map((l) => l.unit_cost)).toEqual([5, 3]);

    // A line saved before its product had a cost is filled in by housekeeping.
    const later = store.shop.addOrder({ lines: [{ variantId: capV, quantity: 1, unitPrice: 15 }] });
    await h.db.query('UPDATE items SET cost = NULL WHERE id = $1', [cap.itemId]);
    await save(store.id, later);
    expect((await lines(later.id))[0]!.unit_cost).toBeNull();
    expect(await fillMissingCosts(h.db)).toBe(0);
    await h.db.query('UPDATE items SET cost = 3.25 WHERE id = $1', [cap.itemId]);
    expect(await fillMissingCosts(h.db)).toBe(1);
    expect((await lines(later.id))[0]!.unit_cost).toBe(3.25);
    // The earlier snapshots are not touched.
    expect((await lines(placed.id)).map((l) => l.unit_cost)).toEqual([5, 3]);
  });

  it('stores test orders and gift cards (reports leave them out)', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    const o = store.shop.addOrder({
      test: true,
      lines: [{ sku: null, isGiftCard: true, quantity: 1, unitPrice: 50 }],
    });
    await save(store.id, o);
    expect((await order(o.id))!.test).toBe(true);
    expect((await lines(o.id))[0]).toMatchObject({ is_gift_card: true, item_id: null, sku: null });
  });

  it('keeps a deleted order deleted, whatever arrives after the deletion', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    const o = store.shop.addOrder({ lines: [{ sku: 'X', quantity: 1, unitPrice: 5 }] });
    await save(store.id, o);
    await removeOrder(h.db, store.id, o.id);
    expect(await lines(o.id)).toEqual([]);
    expect((await order(o.id))!.deleted_at).not.toBeNull();
    // A refresh read before the deletion, saved after it.
    const newer = store.shop.updateOrder(o.id, { name: '#late' });
    expect(await save(store.id, newer)).toBe('deleted');
    expect(await lines(o.id)).toEqual([]);

    // The deletion delivered before the creation.
    const other = store.shop.addOrder({ lines: [{ sku: 'X', quantity: 1, unitPrice: 5 }] });
    await removeOrder(h.db, store.id, other.id);
    await removeOrder(h.db, store.id, other.id); // delivered twice
    expect(await save(store.id, other)).toBe('deleted');
    expect(await lines(other.id)).toEqual([]);

    // A store removed meanwhile: nothing to do, no error.
    await expect(removeOrder(h.db, 999_999, other.id)).resolves.toBeUndefined();
  });

  it('ends with the newest copy when copies of one order are saved at the same time', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    await h.addItem('TEE-1', [5]);
    const variantId = variantOf(store, 'TEE-1').variantId;
    const versions: ShopifyOrder[] = [
      store.shop.addOrder({ lines: [{ variantId, quantity: 5, unitPrice: 10 }] }),
    ];
    for (let left = 4; left >= 0; left--) {
      const prev = versions[versions.length - 1]!;
      versions.push(
        store.shop.updateOrder(prev.id, {
          lines: [
            { id: prev.lines[0]!.id, variantId, quantity: 5, currentQuantity: left, unitPrice: 10 },
          ],
        }),
      );
    }
    // Every version written concurrently, several times, newest first and last.
    const shuffled = [...versions].reverse().concat(versions, [...versions].reverse());
    await Promise.all(shuffled.map((v) => ingestOrders(h.db, store.id, [v])));
    const saved = await lines(versions[0]!.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.current_quantity).toBe(0);
    const { rows } = await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM sales_orders');
    expect(rows[0]!.n).toBe(1);
  });

  it('saves orders in batches and counts what it did', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    const orders = Array.from({ length: 230 }, () =>
      store.shop.addOrder({ lines: [{ sku: 'A', quantity: 1, unitPrice: 1 }] }),
    );
    expect(await ingestOrders(h.db, store.id, orders)).toEqual({
      inserted: 230,
      updated: 0,
      skipped: 0,
    });
    const stale = orders.slice(0, 3).map((o) => ({ ...o, updatedAt: '2020-01-01T00:00:00Z' }));
    expect(await ingestOrders(h.db, store.id, [...stale, orders[5]!])).toEqual({
      inserted: 0,
      updated: 1,
      skipped: 3,
    });
  });

  it('maps lines to products created or matched after the sale (housekeeping)', async () => {
    h = await Harness.create(1);
    const [store] = h.stores as [TestStore];
    const unknownVariant = store.shop.addVariant('LATER-1');
    const unlinked = store.shop.addVariant('MANUAL-1');
    const o = store.shop.addOrder({
      lines: [
        { variantId: unknownVariant.variantId, quantity: 1, unitPrice: 5 },
        { variantId: unlinked.variantId, quantity: 1, unitPrice: 5 },
        { sku: 'NEVER', quantity: 1, unitPrice: 5 },
      ] satisfies OrderInput['lines'],
    });
    await save(store.id, o);
    expect(await mapUnmatchedLines(h.db)).toBe(0);

    // The product appears (SKU matching), and the merchant says "never sync" for the other.
    const later = await h.addItem('LATER-1', [null], []);
    await h.db.query('UPDATE items SET cost = 2 WHERE id = $1', [later.itemId]);
    const manual = await h.addItem('MANUAL-1', [null], []);
    await h.db.query(
      `INSERT INTO variants (store_id, item_id, shopify_product_id, shopify_variant_id,
                             inventory_item_id, sku, link_source)
       VALUES ($1, NULL, $2, $3, $4, 'MANUAL-1', 'manual')`,
      [store.id, unlinked.productId, unlinked.variantId, unlinked.inventoryItemId],
    );
    expect(await mapUnmatchedLines(h.db)).toBe(1);
    const saved = await lines(o.id);
    expect(saved.map((l) => [l.item_id, l.unit_cost])).toEqual([
      [later.itemId, 2],
      [null, null],
      [null, null],
    ]);
    expect(manual.itemId).toBeGreaterThan(0);
    expect(await mapUnmatchedLines(h.db)).toBe(0);
  });
});
