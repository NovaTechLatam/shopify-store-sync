import { afterEach, describe, expect, it } from 'vitest';
import { updateSettings } from '../src/settings.js';
import { SALES_HOUSEKEEPING, queueSalesWork } from '../src/sales/jobs.js';
import { FEATURE_HOUSEKEEPING, FEATURE_JOBS } from '../src/scheduler.js';
import {
  BACKFILL_POLL_MS,
  SYNC_OVERLAP_MS,
  refreshOrder,
  runSalesBackfill,
  syncOrders,
} from '../src/sales/sync.js';
import { ShopifyApiError } from '../src/shopify/client.js';
import { TASK_HANDLERS } from '../src/tasks/handlers.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import type { TaskDeps } from '../src/tasks/types.js';
import { Harness, silentLogger, type TestStore } from './helpers/harness.js';

const DAY = 24 * 60 * 60_000;
let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
});

/** A harness whose stores may read orders (and are recorded as such). */
async function salesHarness(stores = 1): Promise<Harness> {
  h = await Harness.create(stores);
  for (const s of h.stores) s.shop.scopes.push('read_orders');
  await h.db.query(
    `UPDATE stores SET granted_scopes = ARRAY['read_products', 'read_inventory', 'write_inventory',
       'read_locations', 'read_orders'], scopes_checked_at = now()`,
  );
  return h;
}

/** Serves every fake shop's export files. */
const fetchAll: typeof fetch = async (input, init) => {
  for (const s of h.stores) {
    const res = await s.shop.bulkFetch(input, init);
    if (res.status !== 404) return res;
  }
  return new Response('not found', { status: 404 });
};

function deps(over: Partial<TaskDeps> = {}): TaskDeps {
  return {
    db: h.db,
    shopify: h.registry,
    logger: silentLogger,
    publicUrl: 'https://sync.example.com',
    fetchFn: fetchAll,
    ...over,
  };
}

async function storeRow(storeId: number) {
  const { rows } = await h.db.query<{
    status: string;
    orders_synced_at: Date | null;
    orders_checked_at: Date | null;
    orders_sync_error: string | null;
    sales_backfill_status: string;
    sales_backfill_operation_id: string | null;
    sales_backfill_error: string | null;
    sales_backfill_objects: number | null;
    sales_history_from: Date | null;
    sales_history_capped: boolean;
  }>('SELECT * FROM stores WHERE id = $1', [storeId]);
  return rows[0]!;
}

async function tasks() {
  const { rows } = await h.db.query<{
    kind: string;
    dedupe_key: string;
    payload: Record<string, unknown>;
    delay: number;
  }>(
    `SELECT kind, dedupe_key, payload,
            EXTRACT(EPOCH FROM run_after - now())::float * 1000 AS delay
       FROM tasks ORDER BY id`,
  );
  return rows;
}

async function orderCount(storeId?: number): Promise<number> {
  const { rows } = await h.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sales_orders
      WHERE deleted_at IS NULL AND ($1::bigint IS NULL OR store_id = $1)`,
    [storeId ?? null],
  );
  return rows[0]!.n;
}

async function openAlerts(kind: string) {
  const { rows } = await h.db.query<{ dedupe_key: string; message: string }>(
    'SELECT dedupe_key, message FROM alerts WHERE kind = $1 AND resolved_at IS NULL',
    [kind],
  );
  return rows;
}

const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

describe('refresh_order', () => {
  it('saves the order as Shopify has it now; an unreadable order is left as it is', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    const o = store.shop.addOrder({ lines: [{ sku: 'A', quantity: 2, unitPrice: 5 }] });
    await TASK_HANDLERS.refresh_order(deps(), { storeId: store.id, orderId: o.id });
    expect(await orderCount()).toBe(1);

    // Older than Shopify's 60 days (or gone): getOrder says null, our copy stays.
    store.shop.deleteOrder(o.id);
    await refreshOrder(deps(), store.id, o.id);
    expect(await orderCount()).toBe(1);
  });

  it('doesn’t call Shopify without permission, and never marks the store as broken', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    const o = store.shop.addOrder({ lines: [{ sku: 'A' }] });
    await h.db.query(`UPDATE stores SET granted_scopes = ARRAY['read_products']`);
    await refreshOrder(deps(), store.id, o.id);
    expect(store.shop.calls.filter((c) => c.op === 'getOrder')).toHaveLength(0);

    // The permission was removed in Shopify after we last checked: refused, not retried.
    await h.db.query(`UPDATE stores SET granted_scopes = NULL`);
    store.shop.scopes = store.shop.scopes.filter((s) => s !== 'read_orders');
    await expect(refreshOrder(deps(), store.id, o.id)).resolves.toBeUndefined();
    expect((await storeRow(store.id)).status).toBe('active');
    expect(await orderCount()).toBe(0);
  });

  it('leaves an order Shopify answers with an error (older than 60 days) as it is', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    const o = store.shop.addOrder({ lines: [{ sku: 'A' }] });
    store.shop.getOrder = async () => {
      throw new ShopifyApiError('Shopify GraphQL error: Order is not accessible', 'invalid');
    };
    await expect(refreshOrder(deps(), store.id, o.id)).resolves.toBeUndefined();
    expect(await orderCount()).toBe(0);
  });

  it('retries network errors (the task fails)', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    const o = store.shop.addOrder({ lines: [{ sku: 'A' }] });
    store.shop.failNext('getOrder', 'throw_before');
    await expect(refreshOrder(deps(), store.id, o.id)).rejects.toThrow(ShopifyApiError);
    await refreshOrder(deps(), store.id, o.id);
    expect(await orderCount()).toBe(1);
  });

  it('skips paused stores; deletions are recorded even then', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    const o = store.shop.addOrder({ lines: [{ sku: 'A' }] });
    await TASK_HANDLERS.refresh_order(deps(), { storeId: store.id, orderId: o.id });
    await h.db.query(`UPDATE stores SET status = 'paused'`);
    const other = store.shop.addOrder({ lines: [{ sku: 'A' }] });
    await TASK_HANDLERS.refresh_order(deps(), { storeId: store.id, orderId: other.id });
    expect(await orderCount()).toBe(1);
    await TASK_HANDLERS.remove_order(deps(), { storeId: store.id, orderId: o.id });
    expect(await orderCount()).toBe(0);
  });
});

describe('sync_orders', () => {
  it('reads every order changed since the newest one we have, page by page', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.orderPageSize = 2;
    const old = store.shop.addOrder({ updatedAt: daysAgo(3), lines: [{ sku: 'A' }] });
    const start = new Date(Date.now() - DAY);
    await h.db.query(`UPDATE stores SET sales_backfill_status = 'done', orders_synced_at = $1`, [
      start,
    ]);
    const recent = Array.from({ length: 5 }, () => store.shop.addOrder({ lines: [{ sku: 'A' }] }));

    await syncOrders(deps(), store.id);
    expect(await orderCount()).toBe(5); // not the one updated 3 days ago
    const calls = store.shop.calls.filter((c) => c.op === 'listOrdersUpdatedSince');
    expect(calls).toHaveLength(3);
    expect((calls[0]!.args as { since: string }).since).toBe(
      new Date(start.getTime() - SYNC_OVERLAP_MS).toISOString(),
    );
    const row = await storeRow(store.id);
    expect(row.orders_synced_at!.toISOString()).toBe(recent[4]!.updatedAt);
    expect(row.orders_checked_at).not.toBeNull();
    expect(row.orders_sync_error).toBeNull();

    // A refund on an old order changes its updatedAt: the next sync picks it up.
    store.shop.updateOrder(old.id, { name: '#refunded' });
    await syncOrders(deps(), store.id);
    expect(await orderCount()).toBe(6);
  });

  it('stops after its time budget, keeps its progress and queues the rest', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.orderPageSize = 2;
    await h.db.query(
      `UPDATE stores SET sales_backfill_status = 'done', orders_synced_at = now() - interval '1 day'`,
    );
    const placed = Array.from({ length: 5 }, () => store.shop.addOrder({ lines: [{ sku: 'A' }] }));
    await syncOrders(deps(), store.id, { budgetMs: 0 });
    expect(await orderCount()).toBe(2);
    expect((await storeRow(store.id)).orders_synced_at!.toISOString()).toBe(placed[1]!.updatedAt);
    expect((await storeRow(store.id)).orders_checked_at).toBeNull();
    expect((await tasks()).map((t) => t.dedupe_key)).toEqual([`sync_orders:storeId=${store.id}`]);

    // The queued run (whole budget) reads the rest.
    await runTasksOnce(h.db, deps(), silentLogger);
    expect(await orderCount()).toBe(5);
    expect((await storeRow(store.id)).orders_checked_at).not.toBeNull();
  });

  it('goes on where it stopped, even through many orders changed at the same moment', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.orderPageSize = 2;
    await h.db.query(
      `UPDATE stores SET sales_backfill_status = 'done', orders_synced_at = now() - interval '1 day'`,
    );
    // A bulk edit in Shopify: every order gets the same updatedAt.
    const at = new Date().toISOString();
    for (let i = 0; i < 7; i++) store.shop.addOrder({ updatedAt: at, lines: [{ sku: 'A' }] });
    for (let run = 0; run < 10; run++) {
      await syncOrders(deps(), store.id, { budgetMs: 0 });
      if ((await storeRow(store.id)).orders_checked_at) break;
    }
    expect(await orderCount()).toBe(7);
    const calls = store.shop.calls.filter((c) => c.op === 'listOrdersUpdatedSince');
    // One page per run, each from the cursor the run before stopped at.
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).every((c) => (c.args as { after: string | null }).after !== null)).toBe(
      true,
    );
    const { rows } = await h.db.query(
      'SELECT orders_sync_since, orders_sync_cursor FROM stores WHERE id = $1',
      [store.id],
    );
    expect(rows[0]).toEqual({ orders_sync_since: null, orders_sync_cursor: null });
  });

  it('starts over when Shopify no longer takes the cursor it stopped at', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    await h.db.query(
      `UPDATE stores SET sales_backfill_status = 'done', orders_synced_at = now() - interval '1 day',
                         orders_sync_since = now() - interval '2 days', orders_sync_cursor = 'stale'`,
    );
    store.shop.addOrder({ lines: [{ sku: 'A' }] });
    store.shop.failNext('listOrdersUpdatedSince', 'throw_before');
    await expect(syncOrders(deps(), store.id)).rejects.toThrow(ShopifyApiError);
    await syncOrders(deps(), store.id);
    expect(await orderCount()).toBe(1);
    const last = store.shop.calls.filter((c) => c.op === 'listOrdersUpdatedSince').at(-1)!;
    expect((last.args as { after: string | null }).after).toBeNull();
  });

  it('records a missing permission on the store’s sales columns and stops', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    await h.db.query(`UPDATE stores SET sales_backfill_status = 'done', orders_synced_at = now()`);
    store.shop.scopes = store.shop.scopes.filter((s) => s !== 'read_orders');
    await expect(syncOrders(deps(), store.id)).resolves.toBeUndefined();
    const row = await storeRow(store.id);
    expect(row.orders_sync_error).toMatch(/hasn’t given Store Sync permission to read its orders/);
    expect(row.orders_checked_at).not.toBeNull();
    expect(row.status).toBe('active');

    // Given back: the next run works and clears the problem.
    store.shop.scopes.push('read_orders');
    await syncOrders(deps(), store.id);
    expect((await storeRow(store.id)).orders_sync_error).toBeNull();
  });
});

describe('sales_backfill (history import)', () => {
  it('asks for 60 days without read_all_orders, and for the whole setting with it', async () => {
    await salesHarness(2);
    const [a, b] = h.stores as [TestStore, TestStore];
    await updateSettings(h.db, { salesHistoryDays: 90 });
    await h.db.query(
      `UPDATE stores SET granted_scopes = array_append(granted_scopes, 'read_all_orders')
        WHERE id = $1`,
      [b.id],
    );
    await runSalesBackfill(deps(), a.id);
    await runSalesBackfill(deps(), b.id);

    const since = (store: TestStore) =>
      Date.parse(
        (store.shop.calls.find((c) => c.op === 'startOrdersBulkExport')!.args as { since: string })
          .since,
      );
    expect(Math.round((Date.now() - since(a)) / DAY)).toBe(60);
    expect(Math.round((Date.now() - since(b)) / DAY)).toBe(90);
    const rowA = await storeRow(a.id);
    expect(rowA).toMatchObject({ sales_backfill_status: 'running', sales_history_capped: true });
    expect(rowA.sales_history_from!.getTime()).toBe(since(a));
    expect((await storeRow(b.id)).sales_history_capped).toBe(false);
  });

  it('checks a running export every 45 seconds, alternating its two task keys', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.bulkStartStatus = 'RUNNING';
    store.shop.addOrder({ lines: [{ sku: 'A' }] });

    await runSalesBackfill(deps(), store.id);
    let queued = await tasks();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: 'sales_backfill',
      payload: { storeId: store.id, poll: true },
    });
    expect(queued[0]!.delay).toBeGreaterThan(BACKFILL_POLL_MS - 5_000);
    expect(queued[0]!.delay).toBeLessThanOrEqual(BACKFILL_POLL_MS);

    // The delayed check (run by the task runner, as it would be): still running.
    await h.db.query('UPDATE tasks SET run_after = now()');
    await runTasksOnce(h.db, deps(), silentLogger);
    queued = await tasks();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ payload: { storeId: store.id } });
    expect(queued[0]!.delay).toBeGreaterThan(BACKFILL_POLL_MS - 5_000);
    expect((await storeRow(store.id)).sales_backfill_status).toBe('running');
    expect(await orderCount()).toBe(0);

    // Shopify finishes; the finish webhook's task runs before the delayed check.
    const op = (await storeRow(store.id)).sales_backfill_operation_id!;
    store.shop.finishBulkOperation(op);
    await TASK_HANDLERS.sales_backfill(deps(), { storeId: store.id });
    expect((await storeRow(store.id)).sales_backfill_status).toBe('done');
    expect(await orderCount()).toBe(1);
    // The leftover delayed check finds nothing to do.
    await h.db.query('UPDATE tasks SET run_after = now()');
    await runTasksOnce(h.db, deps(), silentLogger);
    expect(store.shop.calls.filter((c) => c.op === 'startOrdersBulkExport')).toHaveLength(1);
  });

  it('imports a completed export (lines before their order), then hands over to the sync', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    await h.addItem('TEE-1', [5]);
    const variantId = store.shop.variants.find((v) => v.sku === 'TEE-1')!.variantId;
    for (let i = 0; i < 3; i++) {
      store.shop.addOrder({
        lines: [
          { variantId, quantity: 2, unitPrice: 10 },
          { sku: 'OTHER', quantity: 1, unitPrice: 4 },
        ],
      });
    }
    await setOpenImportAlert(store.id);
    await runSalesBackfill(deps(), store.id);
    await runSalesBackfill(deps(), store.id, { poll: true });

    expect(await orderCount()).toBe(3);
    const { rows } = await h.db.query<{ n: number; units: number }>(
      'SELECT count(*)::int AS n, sum(current_quantity)::int AS units FROM sales_lines',
    );
    expect(rows[0]).toEqual({ n: 6, units: 9 });
    const row = await storeRow(store.id);
    expect(row.sales_backfill_status).toBe('done');
    expect(row.sales_backfill_objects).toBe(9);
    const op = store.shop.bulkOperations.get(row.sales_backfill_operation_id!)!;
    expect(row.orders_synced_at!.getTime()).toBe(Date.parse(op.createdAt) - SYNC_OVERLAP_MS);
    expect((await tasks()).map((t) => t.kind)).toContain('sync_orders');
    expect(await openAlerts('sales_import_failed')).toEqual([]);

    // From here on the scheduler keeps it up to date.
    await h.db.query('DELETE FROM tasks');
    await queueSalesWork({ db: h.db, logger: silentLogger, now: Date.now() });
    expect((await tasks()).map((t) => t.kind)).toEqual(['sync_orders']);
  });

  it('finishes a store without orders (Shopify gives no file)', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    await runSalesBackfill(deps(), store.id);
    await runSalesBackfill(deps(), store.id, { poll: true });
    const row = await storeRow(store.id);
    expect(row.sales_backfill_status).toBe('done');
    expect(row.sales_backfill_objects).toBe(0);
    expect(row.orders_synced_at).not.toBeNull();
  });

  it('falls back to reading the window page by page when the export fails', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.bulkStartStatus = 'RUNNING';
    store.shop.addOrder({ updatedAt: daysAgo(20), lines: [{ sku: 'A' }] });
    await runSalesBackfill(deps(), store.id);
    const row = await storeRow(store.id);
    store.shop.finishBulkOperation(
      row.sales_backfill_operation_id!,
      'FAILED',
      'INTERNAL_SERVER_ERROR',
    );
    await runSalesBackfill(deps(), store.id, { poll: true });

    const failed = await storeRow(store.id);
    expect(failed.sales_backfill_status).toBe('failed');
    expect(failed.sales_backfill_error).toBe('The export failed (INTERNAL_SERVER_ERROR).');
    expect(failed.orders_synced_at!.getTime()).toBe(row.sales_history_from!.getTime());
    const alerts = await openAlerts('sales_import_failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toMatch(/^brand0: the order history couldn’t be imported/);

    // The queued sync reads the whole window instead; the import itself doesn't start again.
    await runTasksOnce(h.db, deps(), silentLogger);
    expect(await orderCount()).toBe(1);
    // Once that pass has read everything since the history's start, the history is complete:
    // the store no longer says its sales may be incomplete, and the alert goes.
    const caughtUp = await storeRow(store.id);
    expect(caughtUp.sales_backfill_status).toBe('done');
    expect(caughtUp.sales_backfill_error).toBeNull();
    expect(await openAlerts('sales_import_failed')).toEqual([]);
    await h.db.query('DELETE FROM tasks'); // the first check's leftover (it would do nothing)
    await queueSalesWork({ db: h.db, logger: silentLogger, now: Date.now() + 16 * 60_000 });
    expect((await tasks()).map((t) => t.kind)).toEqual(['sync_orders']);
  });

  it('keeps a failed import failed until a pass from the history’s start has finished', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.orderPageSize = 2;
    store.shop.bulkStartStatus = 'RUNNING';
    for (let i = 0; i < 5; i++)
      store.shop.addOrder({ updatedAt: daysAgo(20 - i), lines: [{ sku: 'A' }] });
    await runSalesBackfill(deps(), store.id);
    const op = (await storeRow(store.id)).sales_backfill_operation_id!;
    store.shop.finishBulkOperation(op, 'EXPIRED');
    await runSalesBackfill(deps(), store.id, { poll: true });

    // The first run of the fallback runs out of time: not complete yet.
    await syncOrders(deps(), store.id, { budgetMs: 0 });
    expect((await storeRow(store.id)).sales_backfill_status).toBe('failed');
    expect(await openAlerts('sales_import_failed')).toHaveLength(1);
    // A sync that started later than the history's start (a 15-minute one) proves nothing.
    await h.db.query(
      `UPDATE stores SET orders_sync_since = NULL, orders_sync_cursor = NULL,
                         orders_synced_at = now() - interval '1 hour' WHERE id = $1`,
      [store.id],
    );
    await syncOrders(deps(), store.id);
    expect((await storeRow(store.id)).sales_backfill_status).toBe('failed');
  });

  it('treats an export Shopify forgot, or an expired file, as failed', async () => {
    await salesHarness(2);
    const [a, b] = h.stores as [TestStore, TestStore];
    await runSalesBackfill(deps(), a.id);
    a.shop.bulkOperations.clear();
    await runSalesBackfill(deps(), a.id, { poll: true });
    expect((await storeRow(a.id)).sales_backfill_error).toBe('Shopify no longer has the export.');

    b.shop.addOrder({ lines: [{ sku: 'A' }] });
    await runSalesBackfill(deps(), b.id);
    const expired: typeof fetch = async () => new Response('Forbidden', { status: 403 });
    await runSalesBackfill(deps({ fetchFn: expired }), b.id, { poll: true });
    expect((await storeRow(b.id)).sales_backfill_error).toBe(
      'The export file couldn’t be downloaded (HTTP 403).',
    );
  });

  it('retries a failed download or a busy Shopify later, without losing its place', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.addOrder({ lines: [{ sku: 'A' }] });
    store.shop.bulkBusy = true;
    await expect(runSalesBackfill(deps(), store.id)).rejects.toThrow(/already running/);
    expect((await storeRow(store.id)).sales_backfill_status).toBe('none');
    store.shop.bulkBusy = false;
    await runSalesBackfill(deps(), store.id);

    const down: typeof fetch = async () => new Response('oops', { status: 503 });
    await expect(
      runSalesBackfill(deps({ fetchFn: down }), store.id, { poll: true }),
    ).rejects.toThrow(/HTTP 503/);
    store.shop.failNext('getBulkOperation', 'throw_before');
    await expect(runSalesBackfill(deps(), store.id, { poll: true })).rejects.toThrow(
      ShopifyApiError,
    );
    expect((await storeRow(store.id)).sales_backfill_status).toBe('running');
    await runSalesBackfill(deps(), store.id, { poll: true });
    expect((await storeRow(store.id)).sales_backfill_status).toBe('done');
    expect(await orderCount()).toBe(1);
  });

  it('runs one check per store at a time: the file is downloaded once', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    for (let i = 0; i < 20; i++) store.shop.addOrder({ lines: [{ sku: 'A' }, { sku: 'B' }] });
    await runSalesBackfill(deps(), store.id);
    let downloads = 0;
    const slow: typeof fetch = async (input, init) => {
      downloads++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return fetchAll(input, init);
    };
    await Promise.all([
      runSalesBackfill(deps({ fetchFn: slow }), store.id),
      runSalesBackfill(deps({ fetchFn: slow }), store.id, { poll: true }),
      runSalesBackfill(deps({ fetchFn: slow }), store.id, { poll: true }),
    ]);
    expect(downloads).toBe(1);
    expect(await orderCount()).toBe(20);
  });

  it('waits for the permission, and starts again once the store’s permissions were re-checked', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    // Removed in Shopify after we last looked: Shopify refuses the export.
    store.shop.scopes = store.shop.scopes.filter((s) => s !== 'read_orders');
    await runSalesBackfill(deps(), store.id);
    let row = await storeRow(store.id);
    expect(row.sales_backfill_status).toBe('none');
    expect(row.sales_backfill_error).toMatch(/permission to read its orders/);
    expect(row.status).toBe('active');

    // Not queued again until the permissions are read again (every 15 minutes, or "Test
    // connection"), so a refusal isn't retried every minute.
    await h.db.query('DELETE FROM tasks');
    await queueSalesWork({ db: h.db, logger: silentLogger, now: Date.now() });
    expect(await tasks()).toEqual([]);
    store.shop.scopes.push('read_orders');
    await h.db.query(`UPDATE stores SET scopes_checked_at = now() + interval '1 second'`);
    await queueSalesWork({ db: h.db, logger: silentLogger, now: Date.now() });
    expect((await tasks()).map((t) => t.kind)).toEqual(['sales_backfill']);
    await runTasksOnce(h.db, deps(), silentLogger);
    row = await storeRow(store.id);
    expect(row.sales_backfill_status).toBe('running');
    expect(row.sales_backfill_error).toBeNull();

    // Known to be missing: no call to Shopify at all.
    await h.db.query(`UPDATE stores SET granted_scopes = ARRAY['read_products']`);
    const calls = store.shop.calls.length;
    await runSalesBackfill(deps(), store.id, { poll: true });
    expect(store.shop.calls.length).toBe(calls);
    expect((await storeRow(store.id)).sales_backfill_status).toBe('none');
  });
});

describe('scheduled sales work', () => {
  it('queues the import for new stores and the sync every 15 minutes, once', async () => {
    await salesHarness(4);
    const [fresh, synced, paused, noPermission] = h.stores as [
      TestStore,
      TestStore,
      TestStore,
      TestStore,
    ];
    await h.db.query(
      `UPDATE stores SET sales_backfill_status = 'done', orders_synced_at = now(),
                         orders_checked_at = now() WHERE id = $1`,
      [synced.id],
    );
    await h.db.query(`UPDATE stores SET status = 'paused' WHERE id = $1`, [paused.id]);
    await h.db.query(`UPDATE stores SET granted_scopes = ARRAY['read_products'] WHERE id = $1`, [
      noPermission.id,
    ]);
    const now = Date.now();
    let woken = 0;
    const ctx = { db: h.db, logger: silentLogger, now, onWork: () => woken++ };
    await queueSalesWork(ctx);
    expect((await tasks()).map((t) => [t.kind, t.payload.storeId])).toEqual([
      ['sales_backfill', fresh.id],
    ]);
    expect(woken).toBe(1);
    await queueSalesWork(ctx);
    expect(await tasks()).toHaveLength(1);

    await queueSalesWork({ ...ctx, now: now + 16 * 60_000 });
    expect((await tasks()).map((t) => [t.kind, t.payload.storeId])).toEqual([
      ['sales_backfill', fresh.id],
      ['sync_orders', synced.id],
    ]);
  });

  it('waits until the store’s permissions have been read', async () => {
    await salesHarness();
    await h.db.query('UPDATE stores SET granted_scopes = NULL, scopes_checked_at = NULL');
    await queueSalesWork({ db: h.db, logger: silentLogger, now: Date.now() });
    expect(await tasks()).toEqual([]);
  });

  it('picks up a running import whose next check got lost', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.bulkStartStatus = 'RUNNING';
    await runSalesBackfill(deps(), store.id);
    await h.db.query('DELETE FROM tasks');
    await queueSalesWork({ db: h.db, logger: silentLogger, now: Date.now() });
    expect((await tasks()).map((t) => t.dedupe_key)).toEqual([
      `sales_backfill:storeId=${store.id}`,
    ]);
  });
});

describe('sales housekeeping', () => {
  it('is registered with the scheduler', () => {
    expect(FEATURE_JOBS.map((j) => j.name)).toContain('sales_orders');
    expect(FEATURE_HOUSEKEEPING.map(([name]) => name)).toEqual(
      expect.arrayContaining(['map sales lines', 'fill sales costs']),
    );
  });

  it('maps a sold SKU once it becomes a product, and gives it the product’s cost', async () => {
    await salesHarness();
    const [store] = h.stores as [TestStore];
    store.shop.addOrder({ lines: [{ sku: 'LATER-1', quantity: 2, unitPrice: 5 }] });
    await syncOrdersFromScratch(store);
    const ctx = { db: h.db, logger: silentLogger, now: Date.now() };
    const run = async () => {
      for (const [, step] of SALES_HOUSEKEEPING) await step(ctx);
    };
    await run();
    const line = async () =>
      (await h.db.query('SELECT item_id, unit_cost FROM sales_lines')).rows[0] as {
        item_id: number | null;
        unit_cost: number | null;
      };
    expect(await line()).toEqual({ item_id: null, unit_cost: null });
    const item = await h.addItem('LATER-1', [null], []);
    await h.db.query('UPDATE items SET cost = 1.5 WHERE id = $1', [item.itemId]);
    await run();
    expect(await line()).toEqual({ item_id: item.itemId, unit_cost: 1.5 });
  });
});

async function syncOrdersFromScratch(store: TestStore) {
  await h.db.query(
    `UPDATE stores SET sales_backfill_status = 'done', orders_synced_at = now() - interval '1 day'
      WHERE id = $1`,
    [store.id],
  );
  await syncOrders(deps(), store.id);
}

async function setOpenImportAlert(storeId: number) {
  await h.db.query(
    `INSERT INTO alerts (kind, dedupe_key, store_id, message)
     VALUES ('sales_import_failed', $1, $2, 'earlier failure')`,
    [`sales_import_failed:${storeId}`, storeId],
  );
}
