import { afterEach, describe, expect, it } from 'vitest';
import { resumeSync, updateSettings } from '../src/settings.js';
import { SyncEngine } from '../src/sync/engine.js';
import { claimPoolLevels } from '../src/sync/queue.js';
import { LEASE_MS, SyncWorker, processClaim } from '../src/sync/worker.js';
import { Harness, silentLogger, type TestItem } from './helpers/harness.js';
import { sleep, waitFor } from './helpers/wait.js';

let h: Harness;
const workers: SyncWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  await h?.close();
});

/** Records which pool levels are being reconciled, by any engine it wraps. */
class ReconcileTracker {
  private readonly active = new Map<number, number>();
  private inflight = 0;
  maxInflight = 0;
  maxPerLevel = 0;
  readonly finished: number[] = [];
  readonly runsByEngine = new Map<SyncEngine, number>();

  wrap(engine: SyncEngine, delayMs: (poolLevelId: number) => number = () => 0): void {
    const reconcile = engine.reconcile.bind(engine);
    engine.reconcile = async (claim) => {
      const n = (this.active.get(claim.poolLevelId) ?? 0) + 1;
      this.active.set(claim.poolLevelId, n);
      this.maxPerLevel = Math.max(this.maxPerLevel, n);
      this.maxInflight = Math.max(this.maxInflight, ++this.inflight);
      this.runsByEngine.set(engine, (this.runsByEngine.get(engine) ?? 0) + 1);
      try {
        await sleep(delayMs(claim.poolLevelId));
        return await reconcile(claim);
      } finally {
        this.active.set(claim.poolLevelId, this.active.get(claim.poolLevelId)! - 1);
        this.inflight--;
        this.finished.push(claim.poolLevelId);
      }
    };
  }
}

function startWorker(engine: SyncEngine, concurrency: number, idleMs = 10): SyncWorker {
  const worker = new SyncWorker({ db: h.db, engine, logger: silentLogger, concurrency, idleMs });
  workers.push(worker);
  worker.start();
  return worker;
}

async function queueLength(): Promise<number> {
  const { rows } = await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM sync_queue');
  return rows[0]!.n;
}

async function queued(item: TestItem): Promise<boolean> {
  const { rowCount } = await h.db.query('SELECT 1 FROM sync_queue WHERE pool_level_id = $1', [
    item.poolLevelId,
  ]);
  return rowCount === 1;
}

describe('SyncWorker', () => {
  it('keeps every slot busy: a slow reconcile does not hold back the others', async () => {
    h = await Harness.create(2);
    const slow = await h.addItem('SLOW', [5, 5]);
    const fast: TestItem[] = [];
    for (let i = 0; i < 6; i++) fast.push(await h.addItem(`FAST-${i}`, [5, 5]));
    await h.enqueue(slow); // claimed first (oldest run_after)
    for (const item of fast) await h.enqueue(item);
    const tracker = new ReconcileTracker();
    tracker.wrap(h.engine, (id) => (id === slow.poolLevelId ? 600 : 30));

    startWorker(h.engine, 2);
    await waitFor(async () => (await queueLength()) === 0, 5_000, 'queue to drain');

    expect(tracker.maxInflight).toBe(2);
    // With batch-at-a-time claiming, the second batch would have waited for the slow one.
    expect(tracker.finished).toHaveLength(7);
    expect(tracker.finished.at(-1)).toBe(slow.poolLevelId);
  });

  it('claims nothing while sync is paused and picks up again on resume', async () => {
    h = await Harness.create(2);
    const first = await h.addItem('FIRST', [10, 10]);
    const second = await h.addItem('SECOND', [10, 10]);
    await h.initialize(first, 'min');
    await h.initialize(second, 'min');
    await h.drain();
    startWorker(h.engine, 2);

    await updateSettings(h.db, { syncPaused: true });
    await sleep(1_100); // the worker re-reads the pause flag at most once per second
    await h.externalChange(h.stores[0]!, first, -3);
    await sleep(300);
    expect(await queued(first)).toBe(true);
    expect(h.levels(first)).toEqual([7, 10]);

    await resumeSync(h.db);
    await waitFor(async () => !(await queued(first)), 3_000, 'reconcile after resume');
    expect(h.levels(first)).toEqual([7, 7]);
    expect(await h.shared(first)).toBe(7);
  });

  it('wakes up on nudge() instead of waiting for the next poll', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    const worker = startWorker(h.engine, 2, 60_000);
    await sleep(200); // first poll found nothing; the worker now sleeps for a minute

    await h.externalChange(h.stores[1]!, item, -4);
    await sleep(300);
    expect(await queued(item)).toBe(true);

    worker.nudge();
    await waitFor(async () => !(await queued(item)), 2_000, 'reconcile after nudge');
    expect(h.levels(item)).toEqual([6, 6]);
  });

  it('never lets two workers reconcile the same pool level at once', async () => {
    h = await Harness.create(3);
    const items: TestItem[] = [];
    for (let i = 0; i < 5; i++) items.push(await h.addItem(`SKU-${i}`, [20, 20, 20]));
    for (const item of items) await h.initialize(item, 'min');
    await h.drain();

    // Slow Shopify reads widen the window in which an overlap could happen.
    for (const store of h.stores) {
      const read = store.shop.readAvailable.bind(store.shop);
      store.shop.readAvailable = async (locationId, ids) => {
        await sleep(5);
        return read(locationId, ids);
      };
    }
    const engine2 = new SyncEngine({ db: h.db, shopify: h.registry, logger: silentLogger });
    const tracker = new ReconcileTracker();
    tracker.wrap(h.engine, () => 10);
    tracker.wrap(engine2, () => 10);
    startWorker(h.engine, 3);
    startWorker(engine2, 3);

    // A storm of sales (each followed by its webhook) while both workers run.
    const sold = new Map<TestItem, number>();
    for (let i = 0; i < 40; i++) {
      const item = items[i % items.length]!;
      await h.externalChange(h.stores[i % h.stores.length]!, item, -1);
      sold.set(item, (sold.get(item) ?? 0) + 1);
      await sleep(8);
    }
    await waitFor(
      async () => (await queueLength()) === 0 && (await h.pendingWrites()) === 0,
      15_000,
      'both workers to finish',
    );

    expect(tracker.maxPerLevel).toBe(1);
    expect(tracker.runsByEngine.get(h.engine)).toBeGreaterThan(0);
    expect(tracker.runsByEngine.get(engine2)).toBeGreaterThan(0);
    for (const item of items) {
      const expected = 20 - (sold.get(item) ?? 0);
      expect(await h.shared(item)).toBe(expected);
      expect(h.levels(item)).toEqual([expected, expected, expected]);
    }
  });
});

describe('lease fencing', () => {
  it('a worker whose lease was taken over writes nothing, and the new owner finishes the job', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[0]!, item, -3);
    const [claim] = await claimPoolLevels(h.db, 1, LEASE_MS);

    // The lease is stolen while the stalled worker is reading the stores.
    const shop = h.stores[1]!.shop;
    const read = shop.readAvailable.bind(shop);
    shop.readAvailable = async (locationId, ids) => {
      await h.db.query('UPDATE sync_queue SET lease_token = gen_random_uuid()');
      shop.readAvailable = read;
      return read(locationId, ids);
    };
    expect(await processClaim(h.db, h.engine, claim!, silentLogger)).toBe('lease_lost');

    expect(await h.shared(item)).toBe(10);
    expect(await h.pendingWrites()).toBe(0);
    expect(shop.calls.filter((c) => c.op === 'setAvailable')).toHaveLength(0);
    expect(h.levels(item)).toEqual([7, 10]);
    const { rows } = await h.db.query<{ lease_token: string }>(
      'SELECT lease_token FROM sync_queue',
    );
    expect(rows[0]!.lease_token).not.toBe(claim!.leaseToken); // left to its new owner

    await h.db.query('UPDATE sync_queue SET lease_token = NULL, leased_until = NULL');
    await h.drain();
    expect(await h.shared(item)).toBe(7);
    expect(h.levels(item)).toEqual([7, 7]);
  });

  it('a write sent just before the lease was lost is settled by replay, never counted twice', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    await h.externalChange(h.stores[0]!, item, -3);
    const [claim] = await claimPoolLevels(h.db, 1, LEASE_MS);

    const shop = h.stores[1]!.shop;
    const set = shop.setAvailable.bind(shop);
    shop.setAvailable = async (input) => {
      await h.db.query('UPDATE sync_queue SET lease_token = gen_random_uuid()');
      shop.setAvailable = set;
      return set(input);
    };
    expect(await processClaim(h.db, h.engine, claim!, silentLogger)).toBe('lease_lost');

    // The write landed but its outcome could not be recorded: the write-ahead row remains.
    expect(h.levels(item)).toEqual([7, 7]);
    expect(await h.shared(item)).toBe(7);
    expect(await h.pendingWrites()).toBe(1);

    await h.db.query('UPDATE sync_queue SET lease_token = NULL, leased_until = NULL');
    await h.drain();
    expect(await h.pendingWrites()).toBe(0);
    expect(await h.shared(item)).toBe(7);
    await h.externalChange(h.stores[1]!, item, -1);
    await h.drain();
    expect(await h.shared(item)).toBe(6);
    expect(h.levels(item)).toEqual([6, 6]);
  });
});

describe('processClaim', () => {
  it('falls back to backoff when a store keeps changing under every write', async () => {
    h = await Harness.create(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    const store = h.stores[1]!;
    // Another unit lands in the store right before each of our writes, so every write is stale.
    store.shop.beforeSet = () => {
      store.shop.externalAdjust(item.inventoryItemIds.get(store.id)!, store.locationId, +1);
    };
    await h.externalChange(h.stores[0]!, item, -1);

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 7; attempt++) {
      const [claim] = await claimPoolLevels(h.db, 1, LEASE_MS);
      expect(claim?.attempts).toBe(attempt);
      const outcome = await processClaim(h.db, h.engine, claim!, silentLogger);
      expect(outcome).toMatchObject({ status: 'retry' });
      const { rows } = await h.db.query<{ secs: number }>(
        'SELECT EXTRACT(EPOCH FROM run_after - now())::float AS secs FROM sync_queue',
      );
      delays.push(Math.max(0, Math.round(rows[0]!.secs)));
      await h.db.query('UPDATE sync_queue SET run_after = now()');
    }
    expect(delays).toEqual([0, 0, 0, 0, 0, 5, 10]);
  });
});
