import { afterEach, describe, expect, it } from 'vitest';
import { resumeSync } from '../src/settings.js';
import { Harness } from './helpers/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('sync engine', () => {
  it('initialises from a source store and copies its quantity everywhere', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('TEE-BLK-M', [10, 7, 0]);
    await h.initialize(item, 'store', { sourceStoreId: h.stores[0]!.id });
    await h.drain();
    expect(await h.shared(item)).toBe(10);
    expect(h.levels(item)).toEqual([10, 10, 10]);
    expect(await h.pendingWrites()).toBe(0);
  });

  it('does nothing for items that are not initialised', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [3, 9]);
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBeNull();
    expect(h.levels(item)).toEqual([3, 9]);
  });

  it('propagates a sale in one store to all others', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('SKU', [10, 10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[1]!, item, -2);
    await h.drain();
    expect(await h.shared(item)).toBe(8);
    expect(h.levels(item)).toEqual([8, 8, 8]);
  });

  it('propagates restocks (increases) too', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [4, 4]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[0]!, item, +6);
    await h.drain();
    expect(h.levels(item)).toEqual([10, 10]);
  });

  it('ignores the echo of its own writes (no loops, no double counting)', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('SKU', [10, 10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[0]!, item, -1);
    await h.drain();
    // Shopify sends inventory_levels/update for every write we made; replay them all, twice.
    for (let i = 0; i < 4; i++) await h.enqueue(item, 'webhook-echo');
    await h.drain();
    await h.enqueue(item, 'webhook-echo');
    await h.drain();
    expect(await h.shared(item)).toBe(9);
    expect(h.levels(item)).toEqual([9, 9, 9]);
  });

  it('counts simultaneous sales in different stores exactly once each', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('SKU', [10, 10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[0]!, item, -1, { webhook: false });
    await h.externalChange(h.stores[1]!, item, -2, { webhook: false });
    await h.externalChange(h.stores[2]!, item, -3);
    await h.drain();
    expect(await h.shared(item)).toBe(4);
    expect(h.levels(item)).toEqual([4, 4, 4]);
  });

  it('never overwrites a sale that happens between our read and our write', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    const [a, b] = h.stores as [(typeof h.stores)[0] & object, (typeof h.stores)[0] & object];
    let raced = false;
    b.shop.beforeSet = () => {
      if (raced) return;
      raced = true;
      b.shop.externalAdjust(item.inventoryItemIds.get(b.id)!, b.locationId, -1); // sale lands first
    };
    await h.externalChange(a, item, -3);
    await h.drain();
    expect(await h.shared(item)).toBe(6);
    expect(h.levels(item)).toEqual([6, 6]);
  });

  it('recovers when a write times out after Shopify applied it (no double count)', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    h.stores[1]!.shop.failNext('setAvailable', 'throw_after');
    await h.externalChange(h.stores[0]!, item, -4);
    await h.drain({ releaseBackoff: false });
    expect(await h.pendingWrites()).toBe(1);
    // A sale after the lost response must still be counted once the write is resolved.
    await h.externalChange(h.stores[1]!, item, -1, { webhook: false });
    await h.drain();
    expect(await h.pendingWrites()).toBe(0);
    expect(await h.shared(item)).toBe(5);
    expect(h.levels(item)).toEqual([5, 5]);
  });

  it('recovers when a write fails before reaching Shopify', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    h.stores[1]!.shop.failNext('setAvailable', 'throw_before');
    await h.externalChange(h.stores[0]!, item, -4);
    await h.drain();
    expect(await h.shared(item)).toBe(6);
    expect(h.levels(item)).toEqual([6, 6]);
  });

  it('applies safety buffers to the displayed quantity without corrupting the shared count', async () => {
    h = await Harness.create(2, { buffers: [0, 2] });
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'store', { sourceStoreId: h.stores[0]!.id });
    await h.drain();
    expect(h.levels(item)).toEqual([10, 8]);
    await h.externalChange(h.stores[1]!, item, -1); // sale in the buffered store
    await h.drain();
    expect(await h.shared(item)).toBe(9);
    expect(h.levels(item)).toEqual([9, 7]);
    await h.externalChange(h.stores[0]!, item, -8);
    await h.drain();
    expect(await h.shared(item)).toBe(1);
    expect(h.levels(item)).toEqual([1, 0]);
  });

  it('records oversells and shows zero everywhere', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [1, 1]);
    await h.initialize(item, 'min');
    await h.drain();
    // Both stores sell the last unit before either webhook is processed.
    await h.externalChange(h.stores[0]!, item, -1, { webhook: false });
    await h.externalChange(h.stores[1]!, item, -1);
    await h.drain();
    expect(await h.shared(item)).toBe(-1);
    expect(h.levels(item)).toEqual([0, 0]);
    const { rows } = await h.db.query(`SELECT kind FROM alerts WHERE resolved_at IS NULL`);
    expect(rows.map((r) => r.kind)).toContain('oversold');
    // Restocking 5 units in any store brings the pool to 4.
    await h.externalChange(h.stores[1]!, item, +5);
    await h.drain();
    expect(await h.shared(item)).toBe(4);
    expect(h.levels(item)).toEqual([4, 4]);
  });

  it('catches changes whose webhook never arrived on the next reconcile', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[0]!, item, -2, { webhook: false });
    await h.enqueue(item, 'scheduled-scan');
    await h.drain();
    expect(h.levels(item)).toEqual([8, 8]);
  });

  it('applies manual set and adjust requests', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value) VALUES ($1, 'set', 40)`,
      [item.poolLevelId],
    );
    await h.enqueue(item);
    await h.drain();
    expect(h.levels(item)).toEqual([40, 40]);
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value) VALUES ($1, 'adjust', -5)`,
      [item.poolLevelId],
    );
    await h.enqueue(item);
    await h.drain();
    expect(h.levels(item)).toEqual([35, 35]);
  });

  it('logs the event kind and details a feature gives an adjustment', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    const details = { purchaseOrderId: 7, number: 'PO-0007', supplierName: 'Acme', receiptId: 3 };
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value, note, event_kind, details)
       VALUES ($1, 'adjust', 120, 'Received 120 on PO-0007 from Acme', 'po_received', $2)`,
      [item.poolLevelId, JSON.stringify(details)],
    );
    // A plain adjustment right after it keeps the default kind.
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value) VALUES ($1, 'adjust', -2)`,
      [item.poolLevelId],
    );
    await h.enqueue(item);
    await h.drain();
    expect(h.levels(item)).toEqual([128, 128]);
    const { rows } = await h.db.query(
      `SELECT kind, delta, quantity_before, quantity_after, message, details FROM inventory_events
        WHERE item_id = $1 AND kind IN ('po_received', 'manual_adjust') ORDER BY id`,
      [item.itemId],
    );
    expect(rows).toEqual([
      {
        kind: 'po_received',
        delta: 120,
        quantity_before: 10,
        quantity_after: 130,
        message: 'Received 120 on PO-0007 from Acme',
        details,
      },
      {
        kind: 'manual_adjust',
        delta: -2,
        quantity_before: 130,
        quantity_after: 128,
        message: 'Adjusted by -2',
        details: null,
      },
    ]);
  });

  it('keeps syncing the other stores when one store is down, and catches up later', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('SKU', [10, 10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    const down = h.stores[2]!;
    down.shop.failNext('readAvailable', 'throw_before');
    await h.externalChange(h.stores[0]!, item, -3);
    await h.drain({ releaseBackoff: false });
    expect(h.levels(item)).toEqual([7, 7, 10]);
    await h.drain();
    expect(h.levels(item)).toEqual([7, 7, 7]);
  });

  it('a store that joins later is overwritten with the shared quantity', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    const late = await h.addStore('late');
    const variant = late.shop.addVariant('SKU');
    late.shop.stock(variant.inventoryItemId, late.locationId, 3);
    await h.db.query(
      `INSERT INTO variants (store_id, item_id, shopify_product_id, shopify_variant_id, inventory_item_id, sku)
       VALUES ($1, $2, $3, $4, $5, 'SKU')`,
      [late.id, item.itemId, variant.productId, variant.variantId, variant.inventoryItemId],
    );
    item.inventoryItemIds.set(late.id, variant.inventoryItemId);
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBe(10);
    expect(h.levels(item)).toEqual([10, 10, 10]);
  });

  it('trips the circuit breaker when many items are wiped out at once, without losing anything', async () => {
    h = await Harness.create(2);
    await h.db.query(`INSERT INTO settings (key, value) VALUES ('mass_zero_limit', '2')`);
    const items = [];
    for (let i = 0; i < 4; i++) items.push(await h.addItem(`SKU-${i}`, [5, 5]));
    for (const item of items) await h.initialize(item, 'min');
    await h.drain();
    // A bad CSV import in store 0 zeroes every item.
    for (const item of items) await h.externalChange(h.stores[0]!, item, -5);
    await h.drain({ concurrency: 1 });
    const { rows } = await h.db.query(`SELECT value FROM settings WHERE key = 'sync_paused'`);
    expect(rows[0]?.value).toBe(true);
    // Only the first two wipe-outs propagated; the rest are held.
    const store1 = items.map((item) => h.level(h.stores[1]!, item));
    expect(store1.filter((q) => q === 0)).toHaveLength(2);
    expect(store1.filter((q) => q === 5)).toHaveLength(2);
    // The merchant fixes the import in store 0 for the held items, then resumes.
    const held = items.filter((item) => h.level(h.stores[1]!, item) === 5);
    for (const item of held) await h.externalChange(h.stores[0]!, item, +5, { webhook: false });
    await resumeSync(h.db);
    await h.drain();
    for (const item of held) {
      expect(await h.shared(item)).toBe(5);
      expect(h.levels(item)).toEqual([5, 5]);
    }
  });

  it('settles a write left pending for over 24 hours by looking at the store', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    h.stores[1]!.shop.failNext('setAvailable', 'throw_after');
    await h.externalChange(h.stores[0]!, item, -4);
    await h.drain({ releaseBackoff: false });
    expect(await h.pendingWrites()).toBe(1);
    await h.db.query(`UPDATE pending_writes SET created_at = now() - interval '25 hours'`);
    h.stores[1]!.shop.expireIdempotencyKeys();
    await h.drain();
    expect(await h.pendingWrites()).toBe(0);
    expect(await h.shared(item)).toBe(6);
    expect(h.levels(item)).toEqual([6, 6]);
    const { rows } = await h.db.query(
      `SELECT count(*)::int AS n FROM inventory_events WHERE kind = 'write_recovered'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('ignores untracked variants and bundles', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('SKU', [10, 10, 10]);
    await h.db.query(`UPDATE variants SET tracked = false WHERE store_id = $1`, [h.stores[2]!.id]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[2]!, item, -7);
    await h.externalChange(h.stores[0]!, item, -1);
    await h.drain();
    expect(await h.shared(item)).toBe(9);
    expect(h.levels(item)).toEqual([9, 9, 3]);
  });

  it('does not touch paused stores and counts their changes when they resume', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [h.stores[1]!.id]);
    await h.externalChange(h.stores[0]!, item, -2);
    await h.externalChange(h.stores[1]!, item, -1);
    await h.drain();
    expect(h.levels(item)).toEqual([8, 9]);
    await h.db.query(`UPDATE stores SET status = 'active' WHERE id = $1`, [h.stores[1]!.id]);
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBe(7);
    expect(h.levels(item)).toEqual([7, 7]);
  });

  it('flags a store whose credentials stop working and keeps syncing the rest', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('SKU', [10, 10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    const broken = h.stores[2]!;
    const { ShopifyApiError } = await import('../src/shopify/client.js');
    broken.shop.readAvailable = async () => {
      throw new ShopifyApiError('Shopify rejected the credentials (HTTP 401).', 'auth', 401);
    };
    await h.externalChange(h.stores[0]!, item, -3);
    await h.drain();
    expect(h.levels(item)).toEqual([7, 7, 10]);
    const { rows } = await h.db.query(`SELECT status, last_error FROM stores WHERE id = $1`, [
      broken.id,
    ]);
    expect(rows[0].status).toBe('error');
  });

  it('keeps separate shared quantities per warehouse', async () => {
    h = await Harness.create(2);
    const { rows } = await h.db.query<{ id: number }>(
      `INSERT INTO warehouses (name) VALUES ('Second') RETURNING id`,
    );
    const second = rows[0]!.id;
    const locs = h.stores.map((s) => s.shop.addLocation('Second'));
    for (const [i, s] of h.stores.entries()) {
      await h.db.query(
        `INSERT INTO store_locations (store_id, shopify_location_id, name, warehouse_id) VALUES ($1, $2, 'Second', $3)`,
        [s.id, locs[i], second],
      );
    }
    const item = await h.addItem('SKU', [10, 10]);
    for (const [i, s] of h.stores.entries())
      s.shop.stock(item.inventoryItemIds.get(s.id)!, locs[i]!, 3);
    const pl2 = await h.db.query<{ id: number }>(
      `INSERT INTO pool_levels (item_id, warehouse_id) VALUES ($1, $2) RETURNING id`,
      [item.itemId, second],
    );
    const item2 = { ...item, poolLevelId: pl2.rows[0]!.id };
    await h.initialize(item, 'min');
    await h.initialize(item2, 'min');
    await h.drain();
    h.stores[0]!.shop.externalAdjust(item.inventoryItemIds.get(h.stores[0]!.id)!, locs[0]!, -1);
    await h.enqueue(item2);
    await h.drain();
    expect(await h.shared(item)).toBe(10);
    expect(await h.shared(item2)).toBe(2);
    expect(h.stores[1]!.shop.level(item.inventoryItemIds.get(h.stores[1]!.id)!, locs[1]!)).toBe(2);
  });

  it('never raises a store that is below zero (continue selling) up to zero', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [1, 1]);
    await h.initialize(item, 'min');
    await h.drain();
    const writesBefore = h.stores[1]!.shop.calls.filter((c) => c.op === 'setAvailable').length;
    await h.externalChange(h.stores[1]!, item, -3); // store 1 keeps selling: 1 -> -2
    await h.drain();
    expect(await h.shared(item)).toBe(-2);
    expect(h.levels(item)).toEqual([0, -2]);
    const writesAfter = h.stores[1]!.shop.calls.filter((c) => c.op === 'setAvailable').length;
    expect(writesAfter).toBe(writesBefore);
    // A restock of 5 in store 0 leaves 3 to sell everywhere.
    await h.externalChange(h.stores[0]!, item, +5);
    await h.drain();
    expect(await h.shared(item)).toBe(3);
    expect(h.levels(item)).toEqual([3, 3]);
  });

  it('warns when the same restock is entered in several stores', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('SKU', [10, 10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[0]!, item, +12);
    await h.drain();
    await h.externalChange(h.stores[1]!, item, +12);
    await h.drain();
    expect(await h.shared(item)).toBe(34); // applied, but flagged
    const { rows } = await h.db.query(
      `SELECT message FROM alerts WHERE kind = 'possible_double_count' AND resolved_at IS NULL`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('brand0 and brand1');
  });

  it('settles a pending write older than 24h conservatively when the store matches neither value', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    h.stores[1]!.shop.failNext('setAvailable', 'throw_before'); // never reached Shopify
    await h.externalChange(h.stores[0]!, item, +4); // 10 -> 14, write 10 -> 14 to store 1 lost
    await h.drain({ releaseBackoff: false });
    await h.db.query(`UPDATE pending_writes SET created_at = now() - interval '25 hours'`);
    await h.externalChange(h.stores[1]!, item, -1, { webhook: false }); // store 1: 10 -> 9
    await h.drain();
    // Store 1 shows 9: neither 10 nor 14. Assuming the +4 landed (baseline 14) counts a -5 change,
    // which leaves less stock than assuming it didn't (-1). We take the lower one.
    expect(await h.shared(item)).toBe(9);
    expect(h.levels(item)).toEqual([9, 9]);
  });

  it('applies a stock count net of every store’s open orders', async () => {
    h = await Harness.create(3);
    const item = await h.addItem('SKU', [20, 20, 20]);
    await h.initialize(item, 'min');
    await h.drain();
    const [a, b] = h.stores as [(typeof h.stores)[0], (typeof h.stores)[0]];
    a.shop.placeOrder(item.inventoryItemIds.get(a.id)!, a.locationId, 2);
    b.shop.placeOrder(item.inventoryItemIds.get(b.id)!, b.locationId, 1);
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBe(17);
    // The merchant counts 25 units on the shelf (3 of them are packed for open orders).
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value) VALUES ($1, 'count', 25)`,
      [item.poolLevelId],
    );
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBe(22);
    expect(h.levels(item)).toEqual([22, 22, 22]);
    // Fulfilling an order doesn't change what can be sold.
    a.shop.fulfillOrder(item.inventoryItemIds.get(a.id)!, a.locationId, 2);
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBe(22);
  });

  it('waits to apply a stock count until every store can be read', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value) VALUES ($1, 'count', 7)`,
      [item.poolLevelId],
    );
    h.stores[1]!.shop.failNext('readAvailable', 'throw_before');
    await h.enqueue(item);
    await h.drain({ releaseBackoff: false });
    expect(await h.shared(item)).toBe(10);
    await h.drain();
    expect(await h.shared(item)).toBe(7);
    expect(h.levels(item)).toEqual([7, 7]);
  });
});
