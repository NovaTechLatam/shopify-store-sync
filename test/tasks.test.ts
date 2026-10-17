import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAlert } from '../src/alerts/alerts.js';
import * as catalog from '../src/catalog/catalog.js';
import type { Db } from '../src/db/pool.js';
import { Scheduler } from '../src/scheduler.js';
import type { FeatureJobContext } from '../src/scheduler-types.js';
import { updateSettings } from '../src/settings.js';
import { ShopifyApiError } from '../src/shopify/client.js';
import { checkConnection, checkStoreHealth } from '../src/sync/health.js';
import type { TaskDeps } from '../src/tasks/handlers.js';
import { TASK_HANDLERS, TASK_PAYLOAD_SCHEMAS } from '../src/tasks/handlers.js';
import type { TaskKind } from '../src/tasks/queue.js';
import { defaultDedupeKey, enqueueTask } from '../src/tasks/queue.js';
import { TaskRunner, runTasksOnce } from '../src/tasks/runner.js';
import { WEBHOOK_TOPICS } from '../src/webhooks/topics.js';
import { FakeShop } from './fakes/fake-shopify.js';
import { Harness, silentLogger } from './helpers/harness.js';
import { sleep, waitFor } from './helpers/wait.js';

// Spies that call through to the real catalog module, so tests can assert calls or inject failures.
vi.mock('../src/catalog/catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof catalog>();
  return {
    ...actual,
    syncStoreCatalog: vi.fn(actual.syncStoreCatalog),
    syncStoreLocations: vi.fn(actual.syncStoreLocations),
    refreshInventoryItem: vi.fn(actual.refreshInventoryItem),
    removeInventoryItem: vi.fn(actual.removeInventoryItem),
    removeProduct: vi.fn(actual.removeProduct),
  };
});

const PUBLIC_URL = 'https://sync.example.com';
const EMPTY_SUMMARY = {
  locations: 0,
  variants: 0,
  added: 0,
  removed: 0,
  linked: 0,
  unlinked: 0,
  conflicts: 0,
};

let h: Harness;
let open: Harness | undefined;
async function harness(stores: number): Promise<Harness> {
  open = await Harness.create(stores);
  return open;
}
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await open?.close();
  open = undefined;
});

function taskDeps(logger = silentLogger): TaskDeps {
  return { db: h.db, shopify: h.registry, logger, publicUrl: PUBLIC_URL };
}

function captureLogger() {
  const lines: { level: number; msg: string }[] = [];
  const logger = pino(
    { level: 'debug' },
    { write: (line: string) => lines.push(JSON.parse(line)) },
  );
  return { logger, lines };
}

async function tasks(): Promise<
  { kind: string; payload: Record<string, unknown>; attempts: number; generation: number }[]
> {
  const { rows } = await h.db.query(
    'SELECT kind, payload, attempts, generation, last_error FROM tasks ORDER BY id',
  );
  return rows;
}

async function secondsUntilRun(kind: string): Promise<number> {
  const { rows } = await h.db.query<{ secs: number }>(
    'SELECT EXTRACT(EPOCH FROM run_after - now())::float AS secs FROM tasks WHERE kind = $1',
    [kind],
  );
  return Math.round(rows[0]!.secs);
}

describe('task handlers', () => {
  it('dispatches catalog tasks to the catalog module', async () => {
    h = await harness(1);
    const store = h.stores[0]!;
    const variant = store.shop.addVariant('tee-1 ');
    await enqueueTask(h.db, 'catalog_sync', { storeId: store.id });
    expect(await runTasksOnce(h.db, taskDeps(), silentLogger)).toBe(1);
    expect(catalog.syncStoreCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ db: h.db, shopify: h.registry }),
      store.id,
    );
    const { rows } = await h.db.query('SELECT sku FROM variants WHERE shopify_variant_id = $1', [
      variant.variantId,
    ]);
    expect(rows[0].sku).toBe('TEE-1');

    const { storeId, inventoryItemId, productId } = { storeId: store.id, ...variant };
    await enqueueTask(h.db, 'sync_locations', { storeId });
    await enqueueTask(h.db, 'refresh_inventory_item', { storeId, inventoryItemId });
    await runTasksOnce(h.db, taskDeps(), silentLogger);
    await enqueueTask(h.db, 'remove_inventory_item', { storeId, inventoryItemId });
    await enqueueTask(h.db, 'remove_product', { storeId, productId });
    await runTasksOnce(h.db, taskDeps(), silentLogger);

    const deps = expect.objectContaining({ db: h.db });
    expect(catalog.syncStoreLocations).toHaveBeenCalledWith(deps, storeId);
    expect(catalog.refreshInventoryItem).toHaveBeenCalledWith(deps, storeId, inventoryItemId);
    expect(catalog.removeInventoryItem).toHaveBeenCalledWith(h.db, storeId, inventoryItemId);
    expect(catalog.removeProduct).toHaveBeenCalledWith(h.db, storeId, productId);
    expect(await tasks()).toEqual([]);
  });

  it('completes tasks of paused, disconnected and deleted stores without doing anything', async () => {
    h = await harness(2);
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [h.stores[0]!.id]);
    await h.db.query(`UPDATE stores SET status = 'disconnected' WHERE id = $1`, [h.stores[1]!.id]);
    for (const storeId of [h.stores[0]!.id, h.stores[1]!.id, 999])
      await enqueueTask(h.db, 'catalog_sync', { storeId });
    expect(await runTasksOnce(h.db, taskDeps(), silentLogger)).toBe(3);
    expect(catalog.syncStoreCatalog).not.toHaveBeenCalled();
    expect(await tasks()).toEqual([]);
  });

  it('registers webhooks, and warns when Shopify had removed some of them', async () => {
    h = await harness(1);
    const store = h.stores[0]!;
    await enqueueTask(h.db, 'ensure_webhooks', { storeId: store.id });
    await runTasksOnce(h.db, taskDeps(), silentLogger);
    // Plus the export-finished topic, which needs no permission (orders topics need read_orders).
    const topics = [...WEBHOOK_TOPICS, 'BULK_OPERATIONS_FINISH'];
    expect(store.shop.subscriptions.map((s) => s.topic).sort()).toEqual(topics.sort());
    expect(new Set(store.shop.subscriptions.map((s) => s.uri))).toEqual(
      new Set([`${PUBLIC_URL}/webhooks/shopify`]),
    );
    const registered = await h.db.query('SELECT webhooks_registered_at FROM stores');
    expect(registered.rows[0].webhooks_registered_at).toBeInstanceOf(Date);
    expect((await h.db.query('SELECT 1 FROM alerts')).rowCount).toBe(0); // first registration

    // Shopify deletes a subscription after repeated delivery failures.
    store.shop.subscriptions.splice(0, 1);
    await enqueueTask(h.db, 'ensure_webhooks', { storeId: store.id });
    await runTasksOnce(h.db, taskDeps(), silentLogger);
    expect(store.shop.subscriptions).toHaveLength(topics.length);
    const { rows } = await h.db.query(
      'SELECT kind, store_id, message FROM alerts WHERE resolved_at IS NULL',
    );
    expect(rows).toEqual([
      {
        kind: 'webhooks_recreated',
        store_id: store.id,
        message: expect.stringContaining('brand0'),
      },
    ]);
    // Changes may have been missed in the meantime: a drift scan is queued.
    expect(await tasks()).toMatchObject([{ kind: 'drift_scan', payload: { storeId: store.id } }]);
  });
});

describe('task runner', () => {
  it('retries a failing task with exponential backoff, and logs loudly after 10 attempts', async () => {
    h = await harness(1);
    const { logger, lines } = captureLogger();
    vi.mocked(catalog.syncStoreCatalog).mockRejectedValue(new Error('Shopify is down'));
    try {
      await enqueueTask(h.db, 'catalog_sync', { storeId: h.stores[0]!.id });
      await runTasksOnce(h.db, taskDeps(logger), logger);
      expect(await tasks()).toMatchObject([
        { attempts: 1, last_error: 'Shopify is down' } as object,
      ]);
      expect(await secondsUntilRun('catalog_sync')).toBe(5);
      expect(await runTasksOnce(h.db, taskDeps(logger), logger)).toBe(0); // still backing off

      await h.db.query('UPDATE tasks SET run_after = now()');
      await runTasksOnce(h.db, taskDeps(logger), logger);
      expect(await secondsUntilRun('catalog_sync')).toBe(10);
      expect(lines.filter((l) => l.msg === 'task failed; will retry')).toHaveLength(2);

      await h.db.query('UPDATE tasks SET run_after = now(), attempts = 9');
      await runTasksOnce(h.db, taskDeps(logger), logger);
      expect(await secondsUntilRun('catalog_sync')).toBe(600); // capped at 10 minutes
      expect(lines.at(-1)).toMatchObject({ level: 50, msg: 'task keeps failing' });
    } finally {
      vi.mocked(catalog.syncStoreCatalog).mockReset();
    }
  });

  it('runs a task once however often it is requested, and again if requested while running', async () => {
    h = await harness(1);
    const storeId = h.stores[0]!.id;
    for (let i = 0; i < 3; i++) await enqueueTask(h.db, 'catalog_sync', { storeId });
    expect(await tasks()).toHaveLength(1);

    vi.mocked(catalog.syncStoreCatalog).mockImplementationOnce(async () => {
      await enqueueTask(h.db, 'catalog_sync', { storeId }); // e.g. a webhook arrives meanwhile
      return EMPTY_SUMMARY;
    });
    await runTasksOnce(h.db, taskDeps(), silentLogger);
    expect(await tasks()).toMatchObject([{ kind: 'catalog_sync', attempts: 0 }]);
    await runTasksOnce(h.db, taskDeps(), silentLogger);
    expect(catalog.syncStoreCatalog).toHaveBeenCalledTimes(2);
    expect(await tasks()).toEqual([]);
  });

  it('drops tasks with a malformed payload and keeps tasks of unknown kinds for later', async () => {
    h = await harness(1);
    const { logger, lines } = captureLogger();
    await h.db.query(
      `INSERT INTO tasks (kind, dedupe_key, payload) VALUES
         ('catalog_sync', 'bad', '{"storeId": "1; DROP TABLE stores"}'),
         ('reindex_everything', 'future', '{}')`,
    );
    expect(await runTasksOnce(h.db, taskDeps(logger), logger)).toBe(2);
    expect(catalog.syncStoreCatalog).not.toHaveBeenCalled();
    expect(await tasks()).toMatchObject([
      { kind: 'reindex_everything', last_error: 'Unknown task kind reindex_everything' } as object,
    ]);
    expect(await secondsUntilRun('reindex_everything')).toBe(5);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, msg: 'dropping invalid task' }),
    );
  });

  it('claims tasks with a 10-minute lease', async () => {
    h = await harness(1);
    let leaseSecs = 0;
    vi.mocked(catalog.syncStoreCatalog).mockImplementationOnce(async () => {
      const { rows } = await h.db.query<{ secs: number }>(
        'SELECT EXTRACT(EPOCH FROM leased_until - now())::float AS secs FROM tasks',
      );
      leaseSecs = Math.round(rows[0]!.secs);
      return EMPTY_SUMMARY;
    });
    await enqueueTask(h.db, 'catalog_sync', { storeId: h.stores[0]!.id });
    await runTasksOnce(h.db, taskDeps(), silentLogger);
    expect(leaseSecs).toBe(600);
  });

  it('TaskRunner runs queued tasks as soon as it is nudged', async () => {
    h = await harness(1);
    const runner = new TaskRunner({
      db: h.db,
      deps: taskDeps(),
      logger: silentLogger,
      concurrency: 2,
      idleMs: 60_000,
    });
    runner.start();
    try {
      await sleep(200); // first poll found nothing; the runner now sleeps for a minute
      await enqueueTask(h.db, 'sync_locations', { storeId: h.stores[0]!.id });
      runner.nudge();
      await waitFor(async () => (await tasks()).length === 0, 2_000, 'task to run');
      expect(catalog.syncStoreLocations).toHaveBeenCalledTimes(1);
    } finally {
      await runner.stop();
    }
  });
});

describe('store health', () => {
  it('checkConnection reports missing scopes, counting write access as read access', async () => {
    const shop = new FakeShop('x.myshopify.com', 'Brand X');
    expect(await checkConnection(shop)).toEqual({
      ok: true,
      shopName: 'Brand X',
      missingScopes: [],
    });
    shop.scopes = ['write_products', 'write_inventory'];
    expect(await checkConnection(shop)).toEqual({
      ok: false,
      shopName: 'Brand X',
      missingScopes: ['read_locations'],
      error: 'The app is missing these permissions: read_locations',
    });
    shop.getShop = async () => {
      throw new ShopifyApiError('Shopify rejected the credentials (HTTP 401).', 'auth', 401);
    };
    expect(await checkConnection(shop)).toEqual({
      ok: false,
      missingScopes: [],
      error: 'Shopify rejected the credentials (HTTP 401).',
    });
  });

  it('re-activates a store in error once it works again, and catches up on what it missed', async () => {
    h = await harness(2);
    const item = await h.addItem('SKU', [10, 10]);
    await h.initialize(item, 'min');
    await h.drain();
    const broken = h.stores[1]!;
    await h.db.query(`UPDATE stores SET status = 'error', last_error = 'HTTP 401' WHERE id = $1`, [
      broken.id,
    ]);
    await setAlert(h.db, {
      open: true,
      kind: 'store_error',
      dedupeKey: `store_error:${broken.id}`,
      storeId: broken.id,
      message: 'brand1 is not syncing',
    });
    await h.externalChange(broken, item, -2); // a sale while the store was out of the loop
    await h.drain();
    expect(h.levels(item)).toEqual([10, 8]);

    const invalidate = vi.fn();
    Object.assign(h.registry, { invalidate });
    await enqueueTask(h.db, 'store_health', { storeId: broken.id });
    await runTasksOnce(h.db, taskDeps(), silentLogger);

    expect(invalidate).toHaveBeenCalledWith(broken.id);
    const store = await h.db.query('SELECT status, last_error FROM stores WHERE id = $1', [
      broken.id,
    ]);
    expect(store.rows[0]).toEqual({ status: 'active', last_error: null });
    const open = await h.db.query('SELECT 1 FROM alerts WHERE resolved_at IS NULL');
    expect(open.rowCount).toBe(0);
    expect((await tasks()).map((t) => [t.kind, t.payload.storeId])).toEqual([
      ['ensure_webhooks', broken.id],
      ['catalog_sync', broken.id],
    ]);
    // Nothing syncs with the store's old links: its catalog is re-read first.
    await h.drain();
    expect(h.levels(item)).toEqual([10, 8]);
    await runTasksOnce(h.db, taskDeps(), silentLogger);
    await h.drain();
    expect(await h.shared(item)).toBe(8);
    expect(h.levels(item)).toEqual([8, 8]);
  });

  it('keeps a store that still fails in error and alerts the merchant', async () => {
    h = await harness(1);
    const store = h.stores[0]!;
    await h.db.query(`UPDATE stores SET status = 'error', last_error = 'old' WHERE id = $1`, [
      store.id,
    ]);
    store.shop.getShop = async () => {
      throw new ShopifyApiError(
        'Shopify rejected the credentials (HTTP 401). Check the access token and API scopes.',
        'auth',
        401,
      );
    };
    const check = await checkStoreHealth(
      { db: h.db, shopify: h.registry, logger: silentLogger },
      store.id,
    );
    expect(check.ok).toBe(false);
    const { rows } = await h.db.query('SELECT status, last_error FROM stores');
    expect(rows[0].status).toBe('error');
    expect(rows[0].last_error).toMatch(/rejected the credentials/);
    const alerts = await h.db.query(
      `SELECT kind, store_id, message FROM alerts WHERE resolved_at IS NULL`,
    );
    expect(alerts.rows).toEqual([
      {
        kind: 'store_error',
        store_id: store.id,
        message: expect.stringMatching(/^brand0 is not syncing: Shopify rejected .* API scopes\. /),
      },
    ]);
    expect(await tasks()).toEqual([]);
  });

  it('only tests stores that are not in error', async () => {
    h = await harness(1);
    const check = await checkStoreHealth(
      { db: h.db, shopify: h.registry, logger: silentLogger },
      h.stores[0]!.id,
    );
    expect(check).toEqual({ ok: true, shopName: 'brand0', missingScopes: [] });
    expect(await tasks()).toEqual([]);
    expect((await h.db.query('SELECT 1 FROM sync_queue')).rowCount).toBe(0);
  });
});

describe('scheduler', () => {
  const MINUTE = 60_000;
  const intervals = { driftIntervalMs: 15 * MINUTE, catalogIntervalMs: 360 * MINUTE };

  it('queues periodic tasks for the stores that are due', async () => {
    h = await harness(4);
    const [fresh, recent, paused, failing] = h.stores.map((s) => s.id) as [
      number,
      number,
      number,
      number,
    ];
    await h.db.query(
      `UPDATE stores SET last_drift_scan_at = now(), catalog_synced_at = now(),
                         webhooks_registered_at = now() WHERE id = $1`,
      [recent],
    );
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [paused]);
    await h.db.query(`UPDATE stores SET status = 'error' WHERE id = $1`, [failing]);
    const onWork = vi.fn();
    const scheduler = new Scheduler({ db: h.db, logger: silentLogger, ...intervals, onWork });

    const now = Date.now();
    await scheduler.tick(now);
    const queued = async () => (await tasks()).map((t) => `${t.kind}:${t.payload.storeId}`).sort();
    expect(await queued()).toEqual(
      [
        `catalog_sync:${fresh}`,
        `drift_scan:${fresh}`,
        `ensure_webhooks:${fresh}`,
        `store_health:${failing}`,
      ].sort(),
    );
    expect(onWork).toHaveBeenCalled();

    // Nothing is due again right away.
    await scheduler.tick(now + 1_000);
    expect((await tasks()).every((t) => t.generation === 1)).toBe(true);

    // 16 minutes later the recently scanned store is due again; the fresh store's drift scan is
    // still queued and is left alone (re-queuing would cancel its backoff).
    await scheduler.tick(now + 16 * MINUTE);
    expect(await queued()).toContain(`drift_scan:${recent}`);
    expect(await queued()).not.toContain(`catalog_sync:${recent}`);
    const freshDrift = (await tasks()).find(
      (t) => t.kind === 'drift_scan' && t.payload.storeId === fresh,
    );
    expect(freshDrift?.generation).toBe(1);
  });

  it('housekeeping prunes old rows, resolves orphaned alerts and delivers alerts', async () => {
    h = await harness(1);
    const storeId = h.stores[0]!.id;
    const item = await h.addItem('SKU', [5]);
    await h.db.query(
      `INSERT INTO webhook_events (event_id, store_id, topic, received_at)
       VALUES ('old', $1, 't', now() - interval '8 days'), ('new', $1, 't', now())`,
      [storeId],
    );
    await h.db.query(
      `INSERT INTO inventory_events (kind, created_at)
       VALUES ('old', now() - interval '200 days'), ('new', now())`,
    );
    await h.db.query(
      `INSERT INTO circuit_breaker_hits (created_at) VALUES (now() - interval '2 days'), (now())`,
    );
    await setAlert(h.db, {
      open: true,
      kind: 'low_stock',
      dedupeKey: `low_stock:${item.poolLevelId}`,
      itemId: item.itemId,
      message: 'SKU is low on stock',
    });
    await setAlert(h.db, {
      open: true,
      kind: 'low_stock',
      dedupeKey: 'low_stock:987654', // its pool level (warehouse) was deleted
      itemId: item.itemId,
      message: 'gone',
    });
    await updateSettings(h.db, { alertSlackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const scheduler = new Scheduler({ db: h.db, logger: silentLogger, ...intervals, fetchFn });

    await scheduler.tick();

    const ids = async (sql: string) => (await h.db.query(sql)).rows.map((r) => Object.values(r)[0]);
    expect(await ids('SELECT event_id FROM webhook_events')).toEqual(['new']);
    expect(await ids('SELECT kind FROM inventory_events')).toEqual(['new']);
    expect(await ids('SELECT count(*)::int FROM circuit_breaker_hits')).toEqual([1]);
    expect(await ids('SELECT message FROM alerts WHERE resolved_at IS NULL')).toEqual([
      'SKU is low on stock',
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.text).toContain('SKU is low on stock');
    expect(body.text).not.toContain('gone');
  });

  it('logs failing jobs instead of throwing', async () => {
    const { logger, lines } = captureLogger();
    const db = {
      query: async () => {
        throw new Error('database is down');
      },
    } as unknown as Db;
    const scheduler = new Scheduler({ db, logger, ...intervals });
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(lines.filter((l) => l.level === 50).length).toBeGreaterThanOrEqual(4);
  });

  it('start() runs each job on its own timer, never overlapping itself, until stop()', async () => {
    const queries: string[] = [];
    let releaseDrift: (() => void) | undefined;
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('last_drift_scan_at') && !releaseDrift)
          await new Promise<void>((resolve) => (releaseDrift = resolve)); // first drift check hangs
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Db;
    const runs = (column: string) => queries.filter((q) => q.includes(column)).length;
    const scheduler = new Scheduler({ db, logger: silentLogger, ...intervals });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(5_000); // first runs are spread over 5 s
      expect(runs('catalog_synced_at')).toBe(1);
      expect(runs('webhook_events')).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(runs('catalog_synced_at')).toBeGreaterThanOrEqual(5);
      expect(runs('last_drift_scan_at')).toBe(1); // still running: not started again

      releaseDrift!();
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(runs('last_drift_scan_at')).toBeGreaterThanOrEqual(2);

      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
      const before = queries.length;
      await vi.advanceTimersByTimeAsync(60 * MINUTE);
      expect(queries.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs feature jobs on their own schedule, and their housekeeping before alerts go out', async () => {
    h = await harness(1);
    const { logger, lines } = captureLogger();
    const onWork = vi.fn();
    const contexts: FeatureJobContext[] = [];
    const job = vi.fn(async (ctx: FeatureJobContext) => {
      contexts.push(ctx);
    });
    const broken = vi.fn(async () => {
      throw new Error('feature job broke');
    });
    const step = vi.fn(async (ctx: FeatureJobContext) => {
      await setAlert(ctx.db, {
        open: true,
        kind: 'reorder',
        dedupeKey: 'reorder:1',
        message: 'SKU X will run out in about 9 days.',
      });
    });
    const brokenStep = vi.fn(async () => {
      throw new Error('feature step broke');
    });
    await updateSettings(h.db, { alertSlackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const scheduler = new Scheduler({
      db: h.db,
      logger,
      ...intervals,
      onWork,
      fetchFn,
      featureJobs: [
        { name: 'test_job', everyMs: 5 * MINUTE, run: job },
        { name: 'broken_job', everyMs: MINUTE, run: broken },
      ],
      featureHousekeeping: [
        ['broken step', brokenStep],
        ['test step', step],
      ],
    });

    const now = Date.now();
    await scheduler.tick(now);
    expect(job).toHaveBeenCalledTimes(1);
    expect(contexts[0]).toEqual({ db: h.db, logger, onWork, now });
    expect(step).toHaveBeenCalledWith({ db: h.db, logger, onWork, now });
    // The alert raised by the step was delivered in the same run.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchFn.mock.calls[0])).toContain('will run out');
    const errors = lines.filter((l) => l.level === 50) as unknown as Record<string, unknown>[];
    expect(errors.some((l) => l.job === 'broken_job' && l.msg === 'scheduled job failed')).toBe(
      true,
    );
    expect(
      errors.some((l) => l.step === 'broken step' && l.msg === 'housekeeping step failed'),
    ).toBe(true);

    await scheduler.tick(now + MINUTE);
    expect(job).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(2);
    await scheduler.tick(now + 5 * MINUTE);
    expect(job).toHaveBeenCalledTimes(2);
    expect(contexts[1]!.now).toBe(now + 5 * MINUTE);
  });
});

describe('feature task registry', () => {
  const examples: Record<string, { valid: object; invalid: object }> = {
    publish_product: {
      valid: { masterProductId: 1, storeId: 2 },
      invalid: { masterProductId: 0, storeId: 2 },
    },
    apply_prices: { valid: { runId: 3, storeId: 2 }, invalid: { runId: '3', storeId: 2 } },
    refresh_order: {
      valid: { storeId: 1, orderId: 'gid://shopify/Order/123456789012345678' },
      invalid: { storeId: 1, orderId: '123456789012345678' },
    },
    remove_order: {
      valid: { storeId: 1, orderId: 'gid://shopify/Order/1' },
      invalid: { storeId: 1 },
    },
    sync_orders: { valid: { storeId: 1 }, invalid: {} },
    sales_backfill: { valid: { storeId: 1 }, invalid: { storeId: -1 } },
    reorder_check: { valid: {}, invalid: [] },
    push_item_costs: {
      valid: { storeId: 1, itemIds: [1, 2] },
      invalid: { storeId: 1, itemIds: [0] },
    },
  };

  it('registers a payload schema and a handler for every feature task kind', () => {
    for (const [kind, { valid, invalid }] of Object.entries(examples)) {
      expect(typeof TASK_HANDLERS[kind as TaskKind], kind).toBe('function');
      const schema = TASK_PAYLOAD_SCHEMAS[kind as TaskKind];
      expect(schema.safeParse(valid).success, kind).toBe(true);
      expect(schema.safeParse(invalid).success, kind).toBe(false);
    }
    expect(Object.keys(TASK_HANDLERS).sort()).toEqual(Object.keys(TASK_PAYLOAD_SCHEMAS).sort());
  });

  it('needs an explicit de-duplication key for payloads with lists', async () => {
    expect(() => defaultDedupeKey('push_item_costs', { storeId: 1, itemIds: [1, 2] })).toThrow(
      /explicit dedupeKey/,
    );
    expect(defaultDedupeKey('reorder_check', {})).toBe('reorder_check');
    h = await harness(1);
    await expect(
      enqueueTask(h.db, 'push_item_costs', { storeId: 1, itemIds: [1] }),
    ).rejects.toThrow(/explicit dedupeKey/);
    await enqueueTask(
      h.db,
      'push_item_costs',
      { storeId: 1, itemIds: [1, 2] },
      { dedupeKey: 'push_item_costs:1:7' },
    );
    expect(await tasks()).toMatchObject([
      { kind: 'push_item_costs', payload: { storeId: 1, itemIds: [1, 2] } },
    ]);
  });
});
