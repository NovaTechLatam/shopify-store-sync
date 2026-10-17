import { afterEach, describe, expect, it } from 'vitest';
import { relink, setManualLink, syncStoreCatalog } from '../src/catalog/catalog.js';
import { resumeSync } from '../src/settings.js';
import { applyOnboarding, previewOnboarding } from '../src/sync/onboarding.js';
import { claimPoolLevels, enqueuePoolLevels, retryClaim } from '../src/sync/queue.js';
import { LEASE_MS } from '../src/sync/worker.js';
import { Harness, silentLogger, type TestItem, type TestStore } from './helpers/harness.js';

/**
 * Scenarios found by the adversarial review. Each one lost or invented stock (or got stuck)
 * before its fix.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const variantRow = async (store: TestStore, item: TestItem) =>
  (
    await h.db.query<{ id: number }>(
      'SELECT id FROM variants WHERE store_id = $1 AND inventory_item_id = $2',
      [store.id, item.inventoryItemIds.get(store.id)],
    )
  ).rows[0]!.id;

describe('membership changes', () => {
  it('a variant linked to the wrong item and back joins fresh instead of counting the other item’s stock', async () => {
    h = await Harness.create(2);
    const [a, b] = h.stores as [TestStore, TestStore];
    const m = await h.addItem('TEE-M', [10, 10]);
    const l = await h.addItem('TEE-L', [50], [a]);
    await h.initialize(m, 'min');
    await h.initialize(l, 'min');
    await h.drain();

    // B's TEE-M variant is linked to TEE-L by mistake: TEE-L's sync overwrites it with 50.
    const bVariant = await variantRow(b, m);
    await setManualLink(h.db, bVariant, l.itemId);
    await h.drain();
    expect(h.level(b, m)).toBe(50);

    // The mistake is fixed: the variant joins TEE-M again and simply takes TEE-M's number.
    await setManualLink(h.db, bVariant, m.itemId);
    await h.drain();
    expect(await h.shared(m)).toBe(10);
    expect([h.level(a, m), h.level(b, m)]).toEqual([10, 10]);
  });

  it('unmapping a location and mapping it back does not count what changed meanwhile', async () => {
    h = await Harness.create(2);
    const [a, b] = h.stores as [TestStore, TestStore];
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.db.query('UPDATE store_locations SET warehouse_id = NULL WHERE store_id = $1', [a.id]);
    a.shop.externalAdjust(item.inventoryItemIds.get(a.id)!, a.locationId, +100); // unsynced edit
    await h.db.query('UPDATE store_locations SET warehouse_id = $2 WHERE store_id = $1', [
      a.id,
      h.warehouseId,
    ]);
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBe(10);
    expect([h.level(a, item), h.level(b, item)]).toEqual([10, 10]);
  });

  it('a relink that races with a reconcile is noticed before anything is saved', async () => {
    h = await Harness.create(2);
    const [, b] = h.stores as [TestStore, TestStore];
    const x = await h.addItem('X', [10, 10]);
    const y = await h.addItem('Y', [50], [h.stores[0]!]);
    await h.initialize(x, 'min');
    await h.initialize(y, 'min');
    await h.drain();
    const bVariant = await variantRow(b, x);
    let raced = false;
    // While X is being reconciled, B's variant is relinked to Y and Y overwrites it with 50.
    b.shop.afterRead = () => {
      if (raced) return;
      raced = true;
      void setManualLink(h.db, bVariant, y.itemId);
    };
    await h.externalChange(h.stores[0]!, x, -1);
    await new Promise((r) => setTimeout(r, 50));
    await h.drain();
    expect(await h.shared(x)).toBe(9);
    expect(await h.shared(y)).toBe(50);
  });

  it('a store that comes back waits for its catalog before syncing with old links', async () => {
    h = await Harness.create(2);
    const [, b] = h.stores as [TestStore, TestStore];
    const tee = await h.addItem('TEE', [10, 10]);
    await h.initialize(tee, 'min');
    await h.drain();
    // B is paused; meanwhile its TEE variant becomes HAT with 25 units.
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [b.id]);
    const v = b.shop.variants.find((x) => x.inventoryItemId === tee.inventoryItemIds.get(b.id))!;
    v.sku = 'HAT';
    b.shop.externalAdjust(v.inventoryItemId, b.locationId, +15);
    // Resuming (what the API does): back to active with its catalog marked stale.
    await h.db.query(`UPDATE stores SET status = 'active', catalog_pending = true WHERE id = $1`, [
      b.id,
    ]);
    await h.enqueue(tee);
    await h.drain();
    expect(await h.shared(tee)).toBe(10);
    await syncStoreCatalog({ db: h.db, shopify: h.registry, logger: silentLogger }, b.id);
    await h.drain();
    expect(await h.shared(tee)).toBe(10);
  });
});

describe('initialisation', () => {
  it('waits for a store that errors during onboarding instead of leaving its stock out', async () => {
    h = await Harness.create(3);
    const b = h.stores[1]!;
    const item = await h.addItem('TEE', [10, 7, 4]);
    await applyOnboarding(h.db, { strategy: 'sum' });
    await h.db.query(`UPDATE stores SET status = 'error' WHERE id = $1`, [b.id]);
    await h.drain({ maxRounds: 3, releaseBackoff: false });
    expect(await h.shared(item)).toBeNull();
    await h.db.query(`UPDATE stores SET status = 'active' WHERE id = $1`, [b.id]);
    await h.drain();
    expect(await h.shared(item)).toBe(21);
  });

  it('waits for the source store to come back instead of failing for good', async () => {
    h = await Harness.create(2);
    const [a] = h.stores as [TestStore];
    const item = await h.addItem('TEE', [10, 7]);
    await applyOnboarding(h.db, { strategy: 'store', sourceStoreId: a.id });
    await h.db.query(`UPDATE stores SET status = 'error' WHERE id = $1`, [a.id]);
    await h.drain({ maxRounds: 3, releaseBackoff: false });
    await h.db.query(`UPDATE stores SET status = 'active' WHERE id = $1`, [a.id]);
    await h.drain();
    expect(await h.shared(item)).toBe(10);
  });

  it('never stocks an item at a location before it starts syncing', async () => {
    h = await Harness.create(2);
    const [, b] = h.stores as [TestStore, TestStore];
    const item = await h.addItem('TEE', [5, null]);
    b.shop.stockInactive(item.inventoryItemIds.get(b.id)!, b.locationId, 40);
    await h.enqueue(item);
    await h.drain();
    expect(b.shop.calls.filter((c) => c.op === 'activateInventory')).toHaveLength(0);
    expect(h.level(b, item)).toBeUndefined();
  });

  it('starts from the number the preview showed when a store is stocked at the location first', async () => {
    h = await Harness.create(2);
    const [, b] = h.stores as [TestStore, TestStore];
    const item = await h.addItem('TEE', [5, null]);
    b.shop.stockInactive(item.inventoryItemIds.get(b.id)!, b.locationId, 12);
    const preview = await previewOnboarding(
      { db: h.db, shopify: h.registry, logger: silentLogger },
      { strategy: 'max' },
    );
    expect(preview.rows[0]!.proposed).toBe(5);
    await applyOnboarding(h.db, { strategy: 'max' });
    await h.drain();
    expect(await h.shared(item)).toBe(5);
    expect(h.levels(item)).toEqual([5, 5]);
  });

  it('lists stores the preview can’t include, and doesn’t auto-start items left out', async () => {
    h = await Harness.create(3);
    const [a, , c] = h.stores as [TestStore, TestStore, TestStore];
    const pilot = await h.addItem('PILOT', [4, 4, 4]);
    const other = await h.addItem('OTHER', [2, 9, 1]);
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [c.id]);
    const preview = await previewOnboarding(
      { db: h.db, shopify: h.registry, logger: silentLogger },
      { strategy: 'min', poolLevelIds: [pilot.poolLevelId] },
    );
    expect(preview.excludedStores).toEqual([
      { storeId: c.id, storeName: 'brand2', reason: 'paused' },
    ]);
    await applyOnboarding(h.db, { strategy: 'min', poolLevelIds: [pilot.poolLevelId] });
    await h.drain();
    // Later catalog changes touching OTHER don't start it behind the merchant's back.
    await relink(h.db, { skus: ['OTHER'] });
    await syncStoreCatalog({ db: h.db, shopify: h.registry, logger: silentLogger }, a.id);
    await h.drain();
    expect(await h.shared(other)).toBeNull();
  });
});

describe('stock counts', () => {
  it('subtracts open orders of paused stores too, and units set aside as damaged', async () => {
    h = await Harness.create(3);
    const [a, b, c] = h.stores as [TestStore, TestStore, TestStore];
    const item = await h.addItem('SKU', [10, 10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    c.shop.placeOrder(item.inventoryItemIds.get(c.id)!, c.locationId, 4);
    a.shop.markUnavailable(item.inventoryItemIds.get(a.id)!, a.locationId, 1);
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBe(5);
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [c.id]);
    // 10 on the shelf: 4 packed for C's order, 1 damaged.
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value) VALUES ($1, 'count', 10)`,
      [item.poolLevelId],
    );
    await h.enqueue(item);
    await h.drain();
    expect(await h.shared(item)).toBe(5);
    expect([h.level(a, item), h.level(b, item)]).toEqual([5, 5]);
  });

  it('keeps later adjustments behind a waiting count, and cancels a count that waited too long', async () => {
    h = await Harness.create(2);
    const [, b] = h.stores as [TestStore, TestStore];
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.db.query(`UPDATE stores SET status = 'error' WHERE id = $1`, [b.id]);
    await h.db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value) VALUES ($1, 'count', 30), ($1, 'adjust', 5)`,
      [item.poolLevelId],
    );
    await h.enqueue(item);
    await h.drain({ maxRounds: 2, releaseBackoff: false });
    expect(await h.shared(item)).toBe(10); // the +5 waits behind the count
    await h.db.query(`UPDATE pool_adjustments SET created_at = now() - interval '11 minutes'`);
    await h.drain();
    expect(await h.shared(item)).toBe(15); // count cancelled, +5 applied
    const { rows } = await h.db.query(
      `SELECT 1 FROM alerts WHERE kind = 'stock_count_cancelled' AND resolved_at IS NULL`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('queue and breaker', () => {
  it('a webhook that arrives during a failing reconcile runs right away, not after the backoff', async () => {
    h = await Harness.create(1);
    const item = await h.addItem('SKU', [1]);
    await enqueuePoolLevels(h.db, [item.poolLevelId], 'test');
    const [claim] = await claimPoolLevels(h.db, 1, LEASE_MS);
    await enqueuePoolLevels(h.db, [item.poolLevelId], 'webhook'); // arrives meanwhile
    await retryClaim(h.db, claim!, 10 * 60_000, 'store down');
    const { rows } = await h.db.query(
      `SELECT run_after <= now() AS ready FROM sync_queue WHERE pool_level_id = $1`,
      [item.poolLevelId],
    );
    expect(rows[0].ready).toBe(true);
  });

  it('after the merchant resumes, the circuit breaker lets through the changes it was holding', async () => {
    h = await Harness.create(2);
    await h.db.query(`INSERT INTO settings (key, value) VALUES ('mass_zero_limit', '2')`);
    const items: TestItem[] = [];
    for (let i = 0; i < 6; i++) items.push(await h.addItem(`SKU-${i}`, [5, 5]));
    for (const item of items) await h.initialize(item, 'min');
    await h.drain();
    for (const item of items) await h.externalChange(h.stores[0]!, item, -5);
    await h.drain({ concurrency: 1 });
    await resumeSync(h.db); // "the changes were real"
    await h.drain({ concurrency: 1 });
    const { rows } = await h.db.query(`SELECT value FROM settings WHERE key = 'sync_paused'`);
    expect(rows[0].value).toBe(false);
    for (const item of items) expect(h.levels(item)).toEqual([0, 0]);
  });
});

describe('stuck writes and alerts', () => {
  it('settles a write Shopify keeps reporting "in progress" by looking at the store', async () => {
    h = await Harness.create(2);
    const [a, b] = h.stores as [TestStore, TestStore];
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    b.shop.failNext('setAvailable', 'throw_after'); // applied, answer lost
    await h.externalChange(a, item, -4);
    await h.drain({ releaseBackoff: false });
    const original = b.shop.setAvailable.bind(b.shop);
    b.shop.setAvailable = async (input) =>
      input.idempotencyKey === (await pendingKey()) ? { status: 'in_progress' } : original(input);
    const pendingKey = async () =>
      (await h.db.query<{ k: string }>('SELECT idempotency_key AS k FROM pending_writes')).rows[0]
        ?.k;
    await h.db.query('UPDATE pending_writes SET attempts = 6');
    await h.drain();
    expect(await h.pendingWrites()).toBe(0);
    expect(await h.shared(item)).toBe(6);
    expect(h.levels(item)).toEqual([6, 6]);
  });

  it('re-notifies a second double-count incident on the same item', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    for (const store of h.stores) {
      await h.externalChange(store, item, +5);
      await h.drain();
    }
    await h.db.query(`UPDATE alerts SET notified_at = now() WHERE kind = 'possible_double_count'`);
    await h.db.query(`UPDATE inventory_events SET created_at = now() - interval '1 hour'`);
    for (const store of h.stores) {
      await h.externalChange(store, item, +3);
      await h.drain();
    }
    const { rows } = await h.db.query(
      `SELECT message, notified_at FROM alerts WHERE kind = 'possible_double_count' AND resolved_at IS NULL`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].notified_at).toBeNull();
    expect(rows[0].message).toContain('3 units');
  });

  it('a store that was the onboarding source can be deleted', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [5, 3]);
    await h.initialize(item, 'store', { sourceStoreId: h.stores[0]!.id });
    await h.drain();
    await h.db.query('DELETE FROM stores WHERE id = $1', [h.stores[0]!.id]);
    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM stores');
    expect(rows[0].n).toBe(1);
  });
});
