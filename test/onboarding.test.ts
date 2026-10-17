import { afterEach, describe, expect, it } from 'vitest';
import { getSettings } from '../src/settings.js';
import type { InitStrategy, OnboardingOptions, PreviewRow } from '../src/sync/onboarding.js';
import { applyOnboarding, previewOnboarding } from '../src/sync/onboarding.js';
import { ShopifyApiError } from '../src/shopify/client.js';
import { Harness, silentLogger, type TestItem } from './helpers/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function preview(opts: OnboardingOptions) {
  return previewOnboarding({ db: h.db, shopify: h.registry, logger: silentLogger }, opts);
}

/**
 * Three brands; brand1 holds back 2 units (safety buffer).
 *   TEE   sold everywhere:                    10 / 7 / 4
 *   CAP   not sold by brand2:                  3 / 5 / -
 *   MUG   brand1 doesn't stock it (yet):       6 / ∅ / 8
 */
async function setup(): Promise<{ tee: TestItem; cap: TestItem; mug: TestItem }> {
  h = await Harness.create(3, { buffers: [0, 2, 0] });
  const [a, b] = h.stores;
  const tee = await h.addItem('TEE', [10, 7, 4]);
  const cap = await h.addItem('CAP', [3, 5], [a!, b!]);
  const mug = await h.addItem('MUG', [6, null, 8]);
  return { tee, cap, mug };
}

function row(rows: PreviewRow[], item: TestItem): PreviewRow {
  return rows.find((r) => r.poolLevelId === item.poolLevelId)!;
}

describe('onboarding preview', () => {
  it('proposes each strategy, with buffers, missing items and unstocked stores', async () => {
    const { tee, cap, mug } = await setup();
    const [a, b, c] = h.stores.map((s) => s.id) as [number, number, number];
    const proposed = async (strategy: InitStrategy, sourceStoreId?: number) => {
      const { rows } = await preview({ strategy, sourceStoreId });
      return [tee, cap, mug].map((item) => row(rows, item).proposed);
    };
    expect(await proposed('store', a)).toEqual([10, 3, 6]);
    expect(await proposed('store', c)).toEqual([4, null, 8]); // brand2 doesn't sell CAP
    expect(await proposed('store', b)).toEqual([7, 5, 0]); // brand1 will stock MUG at 0
    expect(await proposed('min')).toEqual([4, 3, 0]);
    expect(await proposed('max')).toEqual([10, 5, 8]);
    expect(await proposed('sum')).toEqual([21, 8, 14]);

    const { rows, summary } = await preview({ strategy: 'store', sourceStoreId: a });
    expect(rows.map((r) => r.sku)).toEqual(['CAP', 'MUG', 'TEE']);
    expect(row(rows, tee)).toMatchObject({
      itemId: tee.itemId,
      title: 'TEE',
      warehouseId: h.warehouseId,
      stores: [
        { storeId: a, storeName: 'brand0', live: 10 },
        { storeId: b, storeName: 'brand1', live: 7 },
        { storeId: c, storeName: 'brand2', live: 4 },
      ],
      changes: [
        { storeId: b, from: 7, to: 8 },
        { storeId: c, from: 4, to: 10 },
      ],
    });
    expect(row(rows, cap).changes).toEqual([{ storeId: b, from: 5, to: 1 }]);
    expect(row(rows, mug).changes).toEqual([
      { storeId: b, from: null, to: 4 },
      { storeId: c, from: 8, to: 6 },
    ]);
    expect(summary).toEqual({
      items: 3,
      itemsChanging: 3,
      storesWrites: 5,
      unitsAdded: 1 + 6 + 4,
      unitsRemoved: 4 + 2,
      zeroedInSomeStore: 0,
      skipped: 0,
    });

    const min = await preview({ strategy: 'min' });
    expect(row(min.rows, mug).changes).toEqual([
      { storeId: a, from: 6, to: 0 },
      { storeId: b, from: null, to: 0 },
      { storeId: c, from: 8, to: 0 },
    ]);
    expect(min.summary.zeroedInSomeStore).toBe(1);
    const fromC = await preview({ strategy: 'store', sourceStoreId: c });
    expect(fromC.summary.skipped).toBe(1);
    expect(row(fromC.rows, cap).changes).toEqual([]);
  });

  it('only covers uninitialised, enabled items that some active store syncs', async () => {
    const { tee, cap, mug } = await setup();
    await h.initialize(tee, 'min');
    await h.drain();
    await h.db.query('UPDATE items SET sync_enabled = false WHERE id = $1', [cap.itemId]);
    const orphan = await h.addItem('ORPHAN', [1], [h.stores[0]!]);
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [h.stores[0]!.id]);

    const { rows } = await preview({ strategy: 'max' });
    expect(rows.map((r) => r.sku)).toEqual(['MUG']);
    expect(row(rows, mug).stores.map((s) => s.storeId)).toEqual([h.stores[1]!.id, h.stores[2]!.id]);
    expect(rows.find((r) => r.poolLevelId === orphan.poolLevelId)).toBeUndefined();

    const limited = await preview({ strategy: 'max', poolLevelIds: [tee.poolLevelId] });
    expect(limited.rows).toEqual([]);
  });

  it('refuses to preview from numbers it could not read', async () => {
    await setup();
    h.stores[2]!.shop.readAvailable = async () => {
      throw new ShopifyApiError('Shopify returned HTTP 503', 'transient', 503);
    };
    await expect(preview({ strategy: 'max' })).rejects.toThrow(
      'Could not read the current stock of brand2: Shopify returned HTTP 503',
    );
  });

  it('validates the request', async () => {
    await setup();
    await expect(preview({ strategy: 'store' })).rejects.toThrow(/Choose the store/);
    await expect(preview({ strategy: 'store', sourceStoreId: 999 })).rejects.toMatchObject({
      statusCode: 400,
      message: 'The chosen source store does not exist',
    });
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [h.stores[0]!.id]);
    await expect(
      applyOnboarding(h.db, { strategy: 'store', sourceStoreId: h.stores[0]!.id }),
    ).rejects.toThrow(/brand0 is paused/);
    await expect(preview({ strategy: 'median' as InitStrategy })).rejects.toThrow();
  });
});

describe('onboarding apply', () => {
  it('starts syncing with exactly the numbers the preview showed', async () => {
    const { tee, cap, mug } = await setup();
    const source = h.stores[0]!.id;
    const { rows } = await preview({ strategy: 'store', sourceStoreId: source });

    expect(await applyOnboarding(h.db, { strategy: 'store', sourceStoreId: source })).toEqual({
      queued: 3,
    });
    expect((await getSettings(h.db)).onboardingCompleted).toBe(true);
    await h.drain();

    for (const item of [tee, cap, mug]) {
      const r = row(rows, item);
      expect(await h.shared(item)).toBe(r.proposed);
      for (const s of r.stores) {
        const store = h.stores.find((t) => t.id === s.storeId)!;
        const change = r.changes.find((c) => c.storeId === s.storeId);
        expect(h.level(store, item)).toBe(change ? change.to : s.live);
      }
    }
    expect(h.levels(tee)).toEqual([10, 8, 10]);
    expect(h.levels(mug)).toEqual([6, 4, 6]);

    // Everything is initialised: a second run has nothing left to do.
    expect(await applyOnboarding(h.db, { strategy: 'max' })).toEqual({ queued: 0 });
  });

  it('skips levels already waiting to start and items the source store does not sell', async () => {
    const { tee, cap, mug } = await setup();
    await h.initialize(tee, 'max'); // queued earlier, not yet applied by the engine
    const brand2 = h.stores[2]!.id;
    expect(await applyOnboarding(h.db, { strategy: 'store', sourceStoreId: brand2 })).toEqual({
      queued: 1,
    });
    const { rows } = await h.db.query(
      `SELECT pool_level_id, strategy, source_store_id FROM pool_adjustments ORDER BY id`,
    );
    expect(rows).toEqual([
      { pool_level_id: tee.poolLevelId, strategy: 'max', source_store_id: null },
      { pool_level_id: mug.poolLevelId, strategy: 'store', source_store_id: brand2 },
    ]);
    await h.drain();
    expect(await h.shared(tee)).toBe(10);
    expect(await h.shared(mug)).toBe(8);
    expect(await h.shared(cap)).toBeNull(); // left for another strategy

    expect(
      await applyOnboarding(h.db, { strategy: 'min', poolLevelIds: [cap.poolLevelId] }),
    ).toEqual({ queued: 1 });
    await h.drain();
    expect(await h.shared(cap)).toBe(3);
  });
});
