import { setAlert } from '../alerts/alerts.js';
import type { Db } from '../db/pool.js';
import { getSettings } from '../settings.js';
import { ShopifyApiError } from '../shopify/client.js';
import { parseOrdersBulkJsonl } from '../shopify/graphql-admin.js';
import { FeatureUnavailableError, requireFeature } from '../shopify/scopes.js';
import type { BulkOperationInfo } from '../shopify/types.js';
import { enqueueTask } from '../tasks/queue.js';
import type { TaskDeps } from '../tasks/types.js';
import { historyWindow, readLines } from './history.js';
import { ingestOrders, removeOrder } from './ingest.js';

/**
 * Reading orders from Shopify: one order on a webhook (refreshOrder), every order changed since
 * the last look (syncOrders, every 15 minutes), and the first import of a store's history
 * (runSalesBackfill, a Shopify bulk export).
 *
 * Without the read_orders permission none of them call Shopify: the problem is recorded on the
 * store's sales columns (shown on the Reports page) and the task ends. It never marks the store
 * itself as broken: stock syncing doesn't need orders.
 */

/** Re-reads from a little before the last order seen: Shopify's search index lags a few seconds. */
export const SYNC_OVERLAP_MS = 10 * 60_000;
/** One sync run stops after about this long and queues the rest, so it never hogs a worker. */
export const SYNC_BUDGET_MS = 4 * 60_000;
/** How long to wait between checks of a running history export. */
export const BACKFILL_POLL_MS = 45_000;
/** Advisory lock space (pg_advisory_lock(int, int)) for one store's history import. */
const BACKFILL_LOCK = 727_005;

/** Webhook-driven: re-reads one order and saves it as Shopify has it now. */
export async function refreshOrder(deps: TaskDeps, storeId: number, orderId: string) {
  if (!(await salesAllowed(deps, storeId))) return;
  const admin = await deps.shopify.forStore(storeId);
  let order;
  try {
    order = await admin.getOrder(orderId);
  } catch (err) {
    if (isAuthError(err)) {
      deps.logger.warn({ storeId, orderId, err }, 'order refresh refused by shopify');
      return;
    }
    // Shopify may answer an order outside the 60 days it lets us read with an error rather than
    // null. Retrying wouldn't change that; the 15-minute sync reads whatever it can see.
    if (err instanceof ShopifyApiError && err.kind === 'invalid') {
      deps.logger.info({ storeId, orderId, err }, 'order not readable; left as it is');
      return;
    }
    throw err;
  }
  if (!order) {
    // Not readable: older than Shopify's 60-day window, or deleted (orders/delete removes it).
    deps.logger.info({ storeId, orderId }, 'order not readable; left as it is');
    return;
  }
  const counts = await ingestOrders(deps.db, storeId, [order]);
  deps.logger.debug({ storeId, orderId, ...counts }, 'order refreshed');
}

/** Webhook-driven: the order was deleted in Shopify. */
export async function deleteOrder(deps: TaskDeps, storeId: number, orderId: string) {
  await removeOrder(deps.db, storeId, orderId);
  deps.logger.debug({ storeId, orderId }, 'order removed');
}

/**
 * Reads every order updated since the newest one we have (minus a small overlap), oldest update
 * first, and moves `orders_synced_at` forward after each page, so an interrupted run resumes
 * where it stopped. After `budgetMs` it queues itself again and ends. Without a starting point
 * (no history import yet) it reads from the start of the history window.
 */
export async function syncOrders(
  deps: TaskDeps,
  storeId: number,
  { budgetMs = SYNC_BUDGET_MS }: { budgetMs?: number } = {},
): Promise<void> {
  const { db, logger } = deps;
  const started = Date.now();
  try {
    await requireFeature(db, storeId, 'sales');
  } catch (err) {
    if (!(err instanceof FeatureUnavailableError)) throw err;
    await recordSyncProblem(db, storeId, err.message);
    logger.info({ storeId }, 'order sync skipped: no permission to read orders');
    return;
  }
  const store = await loadSalesState(db, storeId);
  if (!store) return;
  const from = store.orders_synced_at ?? store.sales_history_from ?? (await defaultStart(db));
  // A run that ran out of time goes on where it stopped; otherwise from the newest order.
  const resumed = store.orders_sync_since !== null && store.orders_sync_cursor !== null;
  const since = resumed
    ? store.orders_sync_since!.toISOString()
    : new Date(from.getTime() - SYNC_OVERLAP_MS).toISOString();
  const admin = await deps.shopify.forStore(storeId);

  let cursor: string | null = resumed ? store.orders_sync_cursor : null;
  let pages = 0;
  const totals = { inserted: 0, updated: 0, skipped: 0 };
  for (;;) {
    let page;
    try {
      page = await admin.listOrdersUpdatedSince(since, cursor);
    } catch (err) {
      if (!isAuthError(err)) {
        // A cursor Shopify no longer takes would fail every retry: start over from the newest
        // order next time.
        if (cursor !== null && pages === 0 && resumed) await saveSyncPlace(db, storeId, null, null);
        throw err;
      }
      await recordSyncProblem(db, storeId, refusalMessage(err, store.name));
      logger.warn({ storeId, err }, 'order sync refused by shopify');
      return;
    }
    pages++;
    const counts = await ingestOrders(db, storeId, page.orders);
    totals.inserted += counts.inserted;
    totals.updated += counts.updated;
    totals.skipped += counts.skipped;
    const newest = page.orders.reduce<string | null>(
      (max, o) => (max === null || Date.parse(o.updatedAt) > Date.parse(max) ? o.updatedAt : max),
      null,
    );
    // Pages come oldest update first: everything up to the newest of this page is saved.
    if (newest) {
      await db.query(
        `UPDATE stores SET orders_synced_at = GREATEST(COALESCE(orders_synced_at, $2), $2)
          WHERE id = $1`,
        [storeId, newest],
      );
    }
    cursor = page.nextCursor;
    if (!cursor) break;
    if (Date.now() - started >= budgetMs) {
      // The rest is read by the next run, from this page on.
      await saveSyncPlace(db, storeId, since, cursor);
      await enqueueTask(db, 'sync_orders', { storeId });
      logger.info({ storeId, pages, ...totals }, 'order sync paused; continues in a moment');
      return;
    }
  }
  await db.query(
    `UPDATE stores SET orders_checked_at = now(), orders_sync_error = NULL,
                       orders_synced_at = COALESCE(orders_synced_at, $2),
                       orders_sync_since = NULL, orders_sync_cursor = NULL
      WHERE id = $1`,
    [storeId, from],
  );
  // After a failed history import, the first pass that started at the history's start has now
  // read every order the import would have: the history is complete, so the store stops saying
  // its sales may be incomplete (and the alert goes).
  const { rowCount: caughtUp } = await db.query(
    `UPDATE stores SET sales_backfill_status = 'done', sales_backfill_error = NULL,
                       sales_backfill_finished_at = now()
      WHERE id = $1 AND sales_backfill_status = 'failed'
        AND sales_history_from IS NOT NULL AND $2::timestamptz <= sales_history_from`,
    [storeId, since],
  );
  if (caughtUp) {
    await setAlert(db, {
      open: false,
      kind: 'sales_import_failed',
      dedupeKey: `sales_import_failed:${storeId}`,
      message: '',
    });
    logger.info({ storeId }, 'order history read page by page');
  }
  logger.debug({ storeId, pages, ...totals }, 'orders synced');
}

/**
 * One step of a store's history import (stores.sales_backfill_status):
 *
 *   none     start a bulk export of the orders updated in the history window → running
 *   running  ask Shopify how it's going: still running → check again in BACKFILL_POLL_MS;
 *            completed → download, save every order → done (the 15-minute sync takes over from
 *            the export's start); failed or expired → failed, and the 15-minute sync reads the
 *            window page by page instead
 *   done, failed  nothing to do (e.g. the finish webhook of another export of ours)
 *
 * Runs from the bulk_operations/finish webhook, from the scheduler, and from its own delayed
 * checks. Only one runs per store at a time (an advisory lock); the others return at once.
 */
export async function runSalesBackfill(
  deps: TaskDeps,
  storeId: number,
  { poll = false }: { poll?: boolean } = {},
): Promise<void> {
  const client = await deps.db.connect();
  let broken = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2::int) AS locked',
      [BACKFILL_LOCK, storeId],
    );
    if (!rows[0]!.locked) {
      deps.logger.debug({ storeId }, 'history import already being checked elsewhere');
      return;
    }
    try {
      await backfillStep(deps, storeId, poll);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1, $2::int)', [BACKFILL_LOCK, storeId])
        .catch(() => {
          // Closing the connection releases the lock.
          broken = true;
        });
    }
  } finally {
    client.release(broken);
  }
}

async function backfillStep(deps: TaskDeps, storeId: number, poll: boolean): Promise<void> {
  const { db, logger } = deps;
  const store = await loadSalesState(db, storeId);
  if (!store) return;
  const status = store.sales_backfill_status;
  if (status === 'done' || status === 'failed') return;
  try {
    await requireFeature(db, storeId, 'sales');
  } catch (err) {
    if (!(err instanceof FeatureUnavailableError)) throw err;
    await recordPermissionProblem(db, storeId, err.message);
    logger.info({ storeId }, 'history import waits for permission to read orders');
    return;
  }
  const admin = await deps.shopify.forStore(storeId);

  if (status === 'none') {
    const settings = await getSettings(db);
    const window = historyWindow(new Date(), settings.salesHistoryDays, store.granted_scopes);
    let operationId: string;
    try {
      ({ operationId } = await admin.startOrdersBulkExport(window.from.toISOString()));
    } catch (err) {
      if (!isAuthError(err)) throw err; // another export still running: retried with backoff
      await recordPermissionProblem(db, storeId, refusalMessage(err, store.name));
      logger.warn({ storeId, err }, 'history import refused by shopify');
      return;
    }
    const { rowCount } = await db.query(
      `UPDATE stores
          SET sales_backfill_status = 'running', sales_backfill_operation_id = $2,
              sales_backfill_started_at = now(), sales_backfill_finished_at = NULL,
              sales_backfill_error = NULL, sales_backfill_objects = 0,
              sales_history_from = $3, sales_history_capped = $4
        WHERE id = $1 AND sales_backfill_status = 'none'`,
      [storeId, operationId, window.from, window.capped],
    );
    if (rowCount) await schedulePoll(db, storeId, poll);
    logger.info(
      { storeId, operationId, days: window.days, capped: window.capped },
      'history import started',
    );
    return;
  }

  // running
  let op: BulkOperationInfo | null;
  try {
    op = await admin.getBulkOperation(store.sales_backfill_operation_id!);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    await recordPermissionProblem(db, storeId, refusalMessage(err, store.name));
    logger.warn({ storeId, err }, 'history import refused by shopify');
    return;
  }
  if (!op) {
    await failBackfill(deps, storeId, store.name, 'Shopify no longer has the export');
    return;
  }
  switch (op.status) {
    case 'CREATED':
    case 'RUNNING':
    case 'CANCELING':
      await db.query('UPDATE stores SET sales_backfill_objects = $2 WHERE id = $1', [
        storeId,
        op.objectCount,
      ]);
      await schedulePoll(db, storeId, poll);
      return;
    case 'COMPLETED':
      await importExport(deps, storeId, store.name, op);
      return;
    case 'FAILED':
    case 'CANCELED':
    case 'EXPIRED': {
      const reason =
        op.status === 'FAILED'
          ? `the export failed (${op.errorCode ?? 'no reason given'})`
          : op.status === 'EXPIRED'
            ? 'the export took too long and expired'
            : 'the export was cancelled';
      await failBackfill(deps, storeId, store.name, reason);
      return;
    }
  }
}

/** Downloads a completed export and saves its orders; a 0-object export has no file. */
async function importExport(
  deps: TaskDeps,
  storeId: number,
  storeName: string,
  op: BulkOperationInfo,
): Promise<void> {
  const { db, logger } = deps;
  let counts = { inserted: 0, updated: 0, skipped: 0 };
  let orders = 0;
  if (op.url) {
    const fetchFn = deps.fetchFn ?? fetch;
    const res = await fetchFn(op.url);
    if (!res.ok || !res.body) {
      // 4xx: the link expired (7 days) or was refused, and asking again won't change that.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        await failBackfill(
          deps,
          storeId,
          storeName,
          `the export file couldn’t be downloaded (HTTP ${res.status})`,
        );
        return;
      }
      throw new Error(`Downloading the order export failed (HTTP ${res.status})`);
    }
    const parsed = await parseOrdersBulkJsonl(readLines(res.body));
    orders = parsed.length;
    counts = await ingestOrders(db, storeId, parsed);
  }
  // Orders changed while the export ran are read by the 15-minute sync, from the export's start.
  const syncFrom = new Date(Date.parse(op.createdAt) - SYNC_OVERLAP_MS);
  await db.query(
    `UPDATE stores
        SET sales_backfill_status = 'done', sales_backfill_finished_at = now(),
            sales_backfill_error = NULL, sales_backfill_objects = $2, orders_synced_at = $3,
            orders_checked_at = NULL, orders_sync_since = NULL, orders_sync_cursor = NULL
      WHERE id = $1 AND sales_backfill_status = 'running'`,
    [storeId, op.objectCount, syncFrom],
  );
  await setAlert(db, {
    open: false,
    kind: 'sales_import_failed',
    dedupeKey: `sales_import_failed:${storeId}`,
    message: '',
  });
  await enqueueTask(db, 'sync_orders', { storeId });
  logger.info({ storeId, orders, ...counts }, 'history import finished');
}

/**
 * The export didn't work: say so, and let the 15-minute sync read the whole window page by page
 * instead (slower, but it gets there).
 */
async function failBackfill(
  deps: TaskDeps,
  storeId: number,
  storeName: string,
  reason: string,
): Promise<void> {
  const error = `${capitalize(reason)}.`;
  await deps.db.query(
    `UPDATE stores
        SET sales_backfill_status = 'failed', sales_backfill_finished_at = now(),
            sales_backfill_error = $2,
            orders_synced_at = COALESCE(sales_history_from, orders_synced_at),
            orders_sync_since = NULL, orders_sync_cursor = NULL
      WHERE id = $1 AND sales_backfill_status = 'running'`,
    [storeId, error],
  );
  await setAlert(deps.db, {
    open: true,
    kind: 'sales_import_failed',
    dedupeKey: `sales_import_failed:${storeId}`,
    storeId,
    message:
      `${storeName}: the order history couldn’t be imported from Shopify: ${reason}. ` +
      'Reports read the orders page by page instead, which takes longer. You can try again from Reports.',
  });
  await enqueueTask(deps.db, 'sync_orders', { storeId });
  deps.logger.warn({ storeId, reason }, 'history import failed; reading orders page by page');
}

/**
 * A task can't push its own next run later (asking for its key again while it runs makes it run
 * again at once), so the checks alternate between the plain key and the `poll` one.
 */
async function schedulePoll(db: Db, storeId: number, runningAsPoll: boolean): Promise<void> {
  await enqueueTask(db, 'sales_backfill', runningAsPoll ? { storeId } : { storeId, poll: true }, {
    delayMs: BACKFILL_POLL_MS,
  });
}

/**
 * The import can't run without the permission: it goes back to waiting (status none) with the
 * reason. The scheduler starts it again once the store's permissions were checked since.
 */
async function recordPermissionProblem(db: Db, storeId: number, message: string) {
  await db.query(
    `UPDATE stores
        SET sales_backfill_status = 'none', sales_backfill_operation_id = NULL,
            sales_backfill_error = $2, sales_backfill_finished_at = now()
      WHERE id = $1 AND sales_backfill_status IN ('none', 'running')`,
    [storeId, message],
  );
}

async function saveSyncPlace(
  db: Db,
  storeId: number,
  since: string | null,
  cursor: string | null,
): Promise<void> {
  await db.query(
    'UPDATE stores SET orders_sync_since = $2, orders_sync_cursor = $3 WHERE id = $1',
    [storeId, since, cursor],
  );
}

async function recordSyncProblem(db: Db, storeId: number, message: string) {
  // Checked anyway: the schedule then waits its 15 minutes instead of asking again at once.
  await db.query(
    'UPDATE stores SET orders_sync_error = $2, orders_checked_at = now() WHERE id = $1',
    [storeId, message],
  );
}

async function salesAllowed(deps: TaskDeps, storeId: number): Promise<boolean> {
  try {
    await requireFeature(deps.db, storeId, 'sales');
    return true;
  } catch (err) {
    if (!(err instanceof FeatureUnavailableError)) throw err;
    deps.logger.debug({ storeId }, 'no permission to read orders; skipped');
    return false;
  }
}

interface SalesStateRow {
  name: string;
  granted_scopes: string[] | null;
  orders_synced_at: Date | null;
  orders_sync_since: Date | null;
  orders_sync_cursor: string | null;
  sales_history_from: Date | null;
  sales_backfill_status: 'none' | 'running' | 'done' | 'failed';
  sales_backfill_operation_id: string | null;
}

async function loadSalesState(db: Db, storeId: number): Promise<SalesStateRow | undefined> {
  const { rows } = await db.query<SalesStateRow>(
    `SELECT name, granted_scopes, orders_synced_at, orders_sync_since, orders_sync_cursor,
            sales_history_from, sales_backfill_status, sales_backfill_operation_id
       FROM stores WHERE id = $1`,
    [storeId],
  );
  return rows[0];
}

/** Without any history: Shopify's 60 days (what read_orders alone can see). */
async function defaultStart(db: Db): Promise<Date> {
  const settings = await getSettings(db);
  return historyWindow(new Date(), settings.salesHistoryDays, null).from;
}

function isAuthError(err: unknown): boolean {
  return err instanceof ShopifyApiError && err.kind === 'auth';
}

/**
 * What to tell the merchant about an auth error. Shopify's ACCESS_DENIED means the app lacks the
 * permission; an HTTP 401/403 means it refused the credentials themselves (the store's page then
 * shows the problem too), and asking for read_orders would send the merchant the wrong way.
 */
function refusalMessage(err: unknown, storeName: string): string {
  if (err instanceof ShopifyApiError && (err.status === 401 || err.status === 403)) {
    return `Shopify didn’t accept Store Sync’s access to “${storeName}”. Check the store’s connection on its page.`;
  }
  return new FeatureUnavailableError(storeName, 'sales', ['read_orders']).message;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
