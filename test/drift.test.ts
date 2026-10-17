import { afterEach, describe, expect, it } from 'vitest';
import { driftScan } from '../src/sync/drift.js';
import { Harness, silentLogger, type TestItem, type TestStore } from './helpers/harness.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function scan(store: TestStore) {
  return driftScan({ db: h.db, shopify: h.registry, logger: silentLogger }, store.id);
}

async function queuedLevels(): Promise<number[]> {
  const { rows } = await h.db.query<{ id: number }>(
    'SELECT pool_level_id AS id FROM sync_queue ORDER BY pool_level_id',
  );
  return rows.map((r) => r.id);
}

async function openAlerts(): Promise<string[]> {
  const { rows } = await h.db.query<{ dedupe_key: string }>(
    'SELECT dedupe_key FROM alerts WHERE resolved_at IS NULL ORDER BY id',
  );
  return rows.map((r) => r.dedupe_key);
}

/** N items sold by every store, initialised at `quantity` and in sync. */
async function syncedItems(n: number, quantity = 10): Promise<TestItem[]> {
  const items: TestItem[] = [];
  for (let i = 0; i < n; i++) {
    const item = await h.addItem(
      `SKU-${i}`,
      h.stores.map(() => quantity),
    );
    await h.initialize(item, 'min');
    items.push(item);
  }
  await h.drain();
  return items;
}

describe('drift scan', () => {
  it('finds a change whose webhook never arrived and queues only that pool level', async () => {
    h = await Harness.create(3);
    const items = await syncedItems(3);
    const store = h.stores[0]!;
    await h.externalChange(store, items[1]!, -2, { webhook: false });
    const readsBefore = store.shop.calls.filter((c) => c.op === 'readAvailable').length;

    expect(await scan(store)).toEqual({ checked: 3, drifted: 1, missingWebhooks: 1 });
    expect(store.shop.calls.filter((c) => c.op === 'readAvailable').length - readsBefore).toBe(1);
    expect(await queuedLevels()).toEqual([items[1]!.poolLevelId]);
    const { rows: stores } = await h.db.query(
      'SELECT last_drift_scan_at, last_drift_count FROM stores WHERE id = $1',
      [store.id],
    );
    expect(stores[0].last_drift_scan_at).toBeInstanceOf(Date);
    expect(stores[0].last_drift_count).toBe(1);
    const { rows: events } = await h.db.query(
      `SELECT store_id, message FROM inventory_events WHERE kind = 'drift_detected'`,
    );
    expect(events).toEqual([{ store_id: store.id, message: expect.stringContaining('brand0') }]);
    expect(await openAlerts()).toEqual([]); // one missed change is not a pattern yet

    await h.drain();
    expect(h.levels(items[1]!)).toEqual([8, 8, 8]);
    expect(await scan(store)).toEqual({ checked: 3, drifted: 0, missingWebhooks: 0 });
  });

  it('raises webhook_gap after several missed changes and resolves it after a clean scan', async () => {
    h = await Harness.create(2);
    const items = await syncedItems(4);
    const store = h.stores[1]!;
    for (const item of items.slice(0, 3))
      await h.externalChange(store, item, -1, { webhook: false });

    expect(await scan(store)).toEqual({ checked: 4, drifted: 3, missingWebhooks: 3 });
    expect(await openAlerts()).toEqual([`webhook_gap:${store.id}`]);
    const { rows: tasks } = await h.db.query('SELECT kind, payload FROM tasks');
    expect(tasks).toEqual([{ kind: 'ensure_webhooks', payload: { storeId: store.id } }]);

    await h.drain();
    expect(await scan(store)).toEqual({ checked: 4, drifted: 0, missingWebhooks: 0 });
    expect(await openAlerts()).toEqual([]);
  });

  it('queues levels a store shows wrongly without blaming webhooks', async () => {
    h = await Harness.create(2);
    const items = await syncedItems(2);
    const store = h.stores[1]!;
    // The merchant raised the safety buffer: the store should now show fewer units.
    await h.db.query('UPDATE stores SET safety_buffer = 3 WHERE id = $1', [store.id]);
    // And a baseline the engine never recorded (e.g. the store just joined).
    await h.db.query('DELETE FROM store_levels WHERE pool_level_id = $1 AND store_id = $2', [
      items[0]!.poolLevelId,
      h.stores[0]!.id,
    ]);

    expect(await scan(store)).toEqual({ checked: 2, drifted: 2, missingWebhooks: 0 });
    expect(await scan(h.stores[0]!)).toEqual({ checked: 2, drifted: 1, missingWebhooks: 0 });
    const { rowCount } = await h.db.query(
      `SELECT 1 FROM inventory_events WHERE kind = 'drift_detected'`,
    );
    expect(rowCount).toBe(0);

    await h.drain();
    for (const item of items) expect(h.levels(item)).toEqual([10, 7]);
  });

  it('skips everything the engine does not sync', async () => {
    h = await Harness.create(2);
    const [synced, disabled, untracked, pending] = await syncedItems(4);
    const notStarted = await h.addItem('NOT-STARTED', [5, 5]);
    const store = h.stores[0]!;
    for (const item of [synced!, disabled!, untracked!, pending!, notStarted])
      await h.externalChange(store, item, -1, { webhook: false });
    await h.db.query('UPDATE items SET sync_enabled = false WHERE id = $1', [disabled!.itemId]);
    await h.db.query('UPDATE variants SET tracked = false WHERE item_id = $1 AND store_id = $2', [
      untracked!.itemId,
      store.id,
    ]);
    await h.db.query(
      `INSERT INTO pending_writes (pool_level_id, store_id, inventory_item_id, location_id, idempotency_key, change_from, target)
       VALUES ($1, $2, $3, $4, gen_random_uuid(), 10, 9)`,
      [pending!.poolLevelId, store.id, pending!.inventoryItemIds.get(store.id), store.locationId],
    );

    expect(await scan(store)).toEqual({ checked: 1, drifted: 1, missingWebhooks: 1 });
    expect(await queuedLevels()).toEqual([synced!.poolLevelId]);

    // Inactive synced location, or a store that is not active: nothing to compare.
    await h.db.query('UPDATE store_locations SET is_active = false WHERE store_id = $1', [
      store.id,
    ]);
    expect(await scan(store)).toEqual({ checked: 0, drifted: 0, missingWebhooks: 0 });
    const other = h.stores[1]!;
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [other.id]);
    expect(await scan(other)).toEqual({ checked: 0, drifted: 0, missingWebhooks: 0 });
    const { rows } = await h.db.query('SELECT last_drift_scan_at FROM stores WHERE id = $1', [
      other.id,
    ]);
    expect(rows[0].last_drift_scan_at).toBeNull();
  });

  it('does not count a change the engine made while the scan was reading as a missed webhook', async () => {
    h = await Harness.create(2);
    const [item] = await syncedItems(1);
    const [scanned, other] = h.stores as [TestStore, TestStore];
    const read = scanned.shop.readAvailable.bind(scanned.shop);
    scanned.shop.readAvailable = async (locationId, ids) => {
      const values = await read(locationId, ids);
      scanned.shop.readAvailable = read;
      // Right after our read, a sale in the other store is synced to the scanned store.
      await h.externalChange(other, item!, -1);
      await h.drain();
      return values;
    };

    const result = await scan(scanned);
    expect(result.missingWebhooks).toBe(0);
    expect(await openAlerts()).toEqual([]);
    await h.drain();
    expect(h.levels(item!)).toEqual([9, 9]);
    expect(await h.shared(item!)).toBe(9);
  });

  it('leaves a store below zero alone when it should show zero', async () => {
    h = await Harness.create(2);
    const [item] = await syncedItems(1, 1);
    // Both stores sell the last unit; store 0 allows overselling and ends at -1.
    await h.externalChange(h.stores[0]!, item!, -2, { webhook: false });
    await h.externalChange(h.stores[1]!, item!, -1);
    await h.drain();
    expect(h.levels(item!)).toEqual([-1, 0]);
    expect(await scan(h.stores[0]!)).toEqual({ checked: 1, drifted: 0, missingWebhooks: 0 });
  });
});
