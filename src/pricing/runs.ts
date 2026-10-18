import type { Queryable } from '../db/pool.js';
import { setAlert } from '../alerts/alerts.js';
import { getSettings } from '../settings.js';
import { ShopifyApiError } from '../shopify/client.js';
import { FeatureUnavailableError, requireFeature } from '../shopify/scopes.js';
import type { ShopifyAdmin, ShopifyVariant, VariantPriceInput } from '../shopify/types.js';
import { enqueueTask } from '../tasks/queue.js';
import type { TaskDeps } from '../tasks/types.js';
import { currencyDecimals, roundMoney, toMoneyString } from '../util/money.js';
import type { CurrentPrice, TargetPrice } from './compute.js';
import { differsFromTarget } from './compute.js';
import {
  byCell,
  cellKey,
  loadOverrides,
  loadPricingItems,
  loadPricingStores,
  loadStoreVariants,
  priceCell,
} from './prices.js';
import type { StoreVariant } from './prices.js';

/**
 * PRICE RUNS: "update the prices in the stores"
 *
 * A run (price_runs) covers some items (or all) in some stores, one price_run_stores row and one
 * `apply_prices` task per store. The task re-reads what the store charges now, computes each
 * item's target price (prices.ts) and writes the ones that differ, as absolute values (a retry
 * writes the same prices again, never "10% more twice"). Prices are only written where Store Sync
 * has a price for the item: the store's rule is on, or the item has a fixed price there, or a
 * sale that just ended puts back what the store charged before (restore entries). A store whose
 * rule is off is never touched otherwise.
 */

/** Advisory lock class (with the store id) held while one store's prices are written. */
const APPLY_LOCK_CLASS = 727_004;
/** Transaction lock taken while runs are created, so two can't both find a store free. */
export const RUN_CREATE_LOCK = 727_005;
/** A store whose prices can't be written for this long (Shopify unreachable) fails the run. */
const GIVE_UP_AFTER_MS = 60 * 60_000;
/** Up to this many products are read one by one; more and the whole store is read at once. */
const PRODUCT_READS = 25;
/** Errors kept per store and run. */
const MAX_ERRORS = 50;

/** A price to put back when a sale ends where Store Sync has no price of its own. */
export interface RestoreEntry {
  itemId: number;
  /** What the store charged before the sale (its currency). */
  price: number;
  compareAtPrice: number | null;
  /** What the sale charged: only a store still charging it gets the old price back. */
  salePrice: number;
}

export type RunReason =
  { kind: 'manual' } | { kind: 'sale_start' | 'sale_end' | 'base_change'; scheduleId: number };

export function reasonText(reason: RunReason): string {
  switch (reason.kind) {
    case 'manual':
      return 'manual';
    case 'sale_start':
      return `schedule:${reason.scheduleId}:start`;
    case 'sale_end':
      return `schedule:${reason.scheduleId}:end`;
    case 'base_change':
      return `schedule:${reason.scheduleId}`;
  }
}

export function parseReason(text: string): RunReason {
  const match = /^schedule:(\d+)(?::(start|end))?$/.exec(text);
  if (!match) return { kind: 'manual' };
  const scheduleId = Number(match[1]);
  if (match[2] === 'start') return { kind: 'sale_start', scheduleId };
  if (match[2] === 'end') return { kind: 'sale_end', scheduleId };
  return { kind: 'base_change', scheduleId };
}

export interface RunStorePlan {
  storeId: number;
  storeName: string;
  status: 'queued' | 'failed';
  error: string | null;
}

export interface CreatedRun {
  runId: number;
  stores: RunStorePlan[];
  /** Stores left out: Store Sync doesn't manage prices there (no rule on, no fixed price). */
  skipped: { storeId: number; storeName: string; reason: string }[];
}

/** Why Store Sync can't write to a store in this state now, or null if it can. */
export function storeUnavailableMessage(name: string, status: string): string | null {
  switch (status) {
    case 'active':
      return null;
    case 'paused':
      return `“${name}” is paused. Resume it on its page, then update prices again.`;
    case 'disconnected':
      return `“${name}” is disconnected. Connect it again, then update prices again.`;
    default:
      return `We can’t connect to “${name}” right now. Fix the connection on its page, then update prices again.`;
  }
}

const currencyUnknownMessage = (name: string) =>
  `We don’t know “${name}”’s currency yet. Click “Test connection” on its page, then update prices again.`;

/**
 * Creates a run for the stores (all if null) that Store Sync manages prices in, with every
 * restore entry given, and queues one task per store that can be updated now. Stores that can't
 * (paused, no permission) are recorded as failed with the reason, so the history says why. Call it
 * inside the transaction that made the change being applied; returns null when no store is
 * concerned. The caller wakes the task runner after committing.
 */
export async function createPriceRun(
  client: Queryable,
  opts: {
    reason: RunReason;
    itemIds: number[] | null;
    storeIds: number[] | null;
    restore?: Map<number, RestoreEntry[]>;
  },
): Promise<CreatedRun | null> {
  const { rows: stores } = await client.query<{
    id: number;
    name: string;
    status: string;
    currency_code: string | null;
    granted_scopes: string[] | null;
    rule_enabled: boolean;
    has_overrides: boolean;
  }>(
    `SELECT s.id, s.name, s.status, s.currency_code, s.granted_scopes,
            COALESCE(r.enabled, false) AS rule_enabled,
            EXISTS (SELECT 1 FROM price_overrides o
                     WHERE o.store_id = s.id
                       AND ($1::bigint[] IS NULL OR o.item_id = ANY($1::bigint[]))) AS has_overrides
       FROM stores s LEFT JOIN price_rules r ON r.store_id = s.id
      WHERE $2::bigint[] IS NULL OR s.id = ANY($2::bigint[])
      ORDER BY s.id`,
    [opts.itemIds, opts.storeIds],
  );
  const plans: (RunStorePlan & { restore: RestoreEntry[] })[] = [];
  const skipped: CreatedRun['skipped'] = [];
  for (const s of stores) {
    // Prices an earlier run couldn't put back (the store was paused when a sale ended...) are
    // put back by this one; this run's own entries are newer and win.
    const carried = await carryRestores(client, s.id, opts.itemIds);
    const restore = mergeRestores(carried, opts.restore?.get(s.id) ?? []);
    if (!s.rule_enabled && !s.has_overrides && restore.length === 0) {
      skipped.push({
        storeId: s.id,
        storeName: s.name,
        reason: `Store Sync doesn’t manage prices in “${s.name}”: its price rule is off and it has no fixed prices.`,
      });
      continue;
    }
    let error = storeUnavailableMessage(s.name, s.status);
    if (!error) {
      try {
        await requireFeature(client, s.id, 'pricing');
      } catch (err) {
        if (!(err instanceof FeatureUnavailableError)) throw err;
        error = err.message;
      }
    }
    if (!error && !s.currency_code) error = currencyUnknownMessage(s.name);
    plans.push({
      storeId: s.id,
      storeName: s.name,
      status: error ? 'failed' : 'queued',
      error,
      restore,
    });
  }
  if (plans.length === 0) return null;

  const allFailed = plans.every((p) => p.status === 'failed');
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO price_runs (reason, item_ids, status, finished_at)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'failed' THEN now() END) RETURNING id`,
    [reasonText(opts.reason), opts.itemIds, allFailed ? 'failed' : 'queued'],
  );
  const runId = rows[0]!.id;
  for (const p of plans) {
    await client.query(
      `INSERT INTO price_run_stores (run_id, store_id, status, error, restore_prices, finished_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $3 = 'failed' THEN now() END)`,
      [runId, p.storeId, p.status, p.error, JSON.stringify(p.restore)],
    );
    if (p.status === 'queued') {
      await enqueueTask(
        client,
        'apply_prices',
        { runId, storeId: p.storeId },
        { dedupeKey: `apply_prices:${runId}:${p.storeId}` },
      );
    } else if (opts.reason.kind !== 'manual') {
      await raiseScheduledFailure(client, opts.reason, p.storeId, p.error!);
    }
  }
  return {
    runId,
    stores: plans.map(({ restore: _restore, ...p }) => p),
    skipped,
  };
}

/**
 * Takes the restore entries (for the items in scope) off the store's failed runs, so the next run
 * puts those prices back instead of them being lost with the failed run. Rows are locked: two runs
 * created at once can't both take the same entries.
 */
async function carryRestores(
  client: Queryable,
  storeId: number,
  itemIds: number[] | null,
): Promise<RestoreEntry[]> {
  const { rows } = await client.query<{ run_id: number; restore_prices: RestoreEntry[] }>(
    `SELECT run_id, restore_prices FROM price_run_stores
      WHERE store_id = $1 AND status = 'failed' AND restore_prices <> '[]'::jsonb
      ORDER BY run_id FOR UPDATE`,
    [storeId],
  );
  const inScope = itemIds ? new Set(itemIds) : null;
  const carried = new Map<number, RestoreEntry>();
  for (const row of rows) {
    const taken = row.restore_prices.filter((r) => !inScope || inScope.has(r.itemId));
    if (taken.length === 0) continue;
    for (const r of taken) carried.set(r.itemId, r); // the newest run's entry wins
    await client.query(
      'UPDATE price_run_stores SET restore_prices = $3 WHERE run_id = $1 AND store_id = $2',
      [row.run_id, storeId, JSON.stringify(row.restore_prices.filter((r) => !taken.includes(r)))],
    );
  }
  return [...carried.values()];
}

/** Restore entries by item, `newer` winning over `older`. */
function mergeRestores(older: RestoreEntry[], newer: RestoreEntry[]): RestoreEntry[] {
  const byItem = new Map(older.map((r) => [r.itemId, r]));
  for (const r of newer) byItem.set(r.itemId, r);
  return [...byItem.values()];
}

/**
 * Restore entries not put back yet, by store: those of runs still to run or running, of failed
 * runs (the next run takes them), and of runs that finished at or after `finishedSince` (a sale
 * starting reads the stores' prices, then looks here: a price read before a restore was written is
 * still the old sale's price).
 */
export async function pendingRestores(
  db: Queryable,
  storeIds: number[],
  finishedSince: Date | null = null,
): Promise<Map<number, RestoreEntry[]>> {
  const { rows } = await db.query<{ store_id: number; restore_prices: RestoreEntry[] }>(
    `SELECT store_id, restore_prices FROM price_run_stores
      WHERE store_id = ANY($1::bigint[]) AND restore_prices <> '[]'::jsonb
        AND (status IN ('queued', 'running', 'failed') OR finished_at >= $2)
      ORDER BY run_id`,
    [storeIds, finishedSince],
  );
  const out = new Map<number, RestoreEntry[]>();
  for (const row of rows) {
    out.set(row.store_id, mergeRestores(out.get(row.store_id) ?? [], row.restore_prices));
  }
  return out;
}

/** Stores (of `storeIds`) that already have a price update queued or running. */
export async function busyStores(
  db: Queryable,
  storeIds: number[] | null,
): Promise<{ id: number; name: string }[]> {
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT DISTINCT s.id, s.name FROM price_run_stores prs JOIN stores s ON s.id = prs.store_id
      WHERE prs.status IN ('queued', 'running')
        AND ($1::bigint[] IS NULL OR prs.store_id = ANY($1::bigint[]))
      ORDER BY s.id`,
    [storeIds],
  );
  return rows;
}

// ---- the apply_prices task ----------------------------------------------------------------------

interface RunStoreJob {
  runId: number;
  storeId: number;
  storeName: string;
  storeStatus: string;
  currencyCode: string | null;
  status: string;
  startedAt: Date | null;
  reason: RunReason;
  itemIds: number[] | null;
  restore: RestoreEntry[];
}

async function loadJob(db: Queryable, runId: number, storeId: number): Promise<RunStoreJob | null> {
  const { rows } = await db.query<{
    status: string;
    started_at: Date | null;
    restore_prices: RestoreEntry[];
    reason: string;
    item_ids: number[] | null;
    name: string;
    store_status: string;
    currency_code: string | null;
  }>(
    `SELECT prs.status, prs.started_at, prs.restore_prices, r.reason, r.item_ids, s.name,
            s.status AS store_status, s.currency_code
       FROM price_run_stores prs
       JOIN price_runs r ON r.id = prs.run_id
       JOIN stores s ON s.id = prs.store_id
      WHERE prs.run_id = $1 AND prs.store_id = $2`,
    [runId, storeId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    runId,
    storeId,
    storeName: row.name,
    storeStatus: row.store_status,
    currencyCode: row.currency_code,
    status: row.status,
    startedAt: row.started_at,
    reason: parseReason(row.reason),
    itemIds: row.item_ids,
    restore: row.restore_prices,
  };
}

/** Thrown when another task holds the store's lock: the task is retried a little later. */
class StoreBusyError extends Error {
  constructor() {
    super('another price update for this store is still running');
    this.name = 'StoreBusyError';
  }
}

/** The apply_prices task: writes one run's prices to one store. Safe to run again. */
export async function applyPrices(
  deps: TaskDeps,
  payload: { runId: number; storeId: number },
): Promise<void> {
  const { db } = deps;
  const job = await loadJob(db, payload.runId, payload.storeId);
  if (!job || job.status === 'done' || job.status === 'failed') return;
  const unavailable =
    storeUnavailableMessage(job.storeName, job.storeStatus) ??
    (job.currencyCode ? null : currencyUnknownMessage(job.storeName));
  if (unavailable) return finishJob(db, job, { error: unavailable });
  try {
    await requireFeature(db, job.storeId, 'pricing');
  } catch (err) {
    if (err instanceof FeatureUnavailableError) return finishJob(db, job, { error: err.message });
    throw err;
  }

  // One store's prices are written by one task at a time: a run that computed its targets must
  // not be overtaken by a later run (a sale ending right after it started), or the older prices
  // would be written last. A session lock dies with its connection if this process does.
  const lock = await db.connect();
  let broken = false;
  try {
    const { rows } = await lock.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2::integer) AS ok',
      [APPLY_LOCK_CLASS, job.storeId],
    );
    if (!rows[0]!.ok) throw new StoreBusyError();
    try {
      const fresh = await loadJob(db, job.runId, job.storeId);
      if (!fresh || fresh.status === 'done' || fresh.status === 'failed') return;
      await runJob(deps, fresh);
    } finally {
      await lock
        .query('SELECT pg_advisory_unlock($1, $2::integer)', [APPLY_LOCK_CLASS, job.storeId])
        .catch(() => {
          broken = true;
        });
    }
  } finally {
    // A connection we couldn't unlock is closed instead of going back to the pool locked.
    lock.release(broken);
  }
}

async function runJob(deps: TaskDeps, job: RunStoreJob): Promise<void> {
  const { db, logger } = deps;
  const { rows } = await db.query<{ started_at: Date }>(
    `UPDATE price_run_stores SET status = 'running', started_at = COALESCE(started_at, now())
      WHERE run_id = $1 AND store_id = $2 RETURNING started_at`,
    [job.runId, job.storeId],
  );
  await db.query(`UPDATE price_runs SET status = 'running' WHERE id = $1 AND status = 'queued'`, [
    job.runId,
  ]);
  const startedAt = rows[0]!.started_at;
  try {
    const counts = await writePrices(deps, job);
    logger.info({ runId: job.runId, storeId: job.storeId, ...counts }, 'prices applied');
    await finishJob(db, job, { error: null });
  } catch (err) {
    const trying = Date.now() - startedAt.getTime() < GIVE_UP_AFTER_MS;
    if (!(err instanceof ShopifyApiError)) {
      // Anything else (a database hiccup, credentials that can't be read) is retried for as long
      // as a network error, then the store's part fails: left running, it would block every
      // later update of the store ("already being updated").
      if (trying) throw err;
      logger.error({ err, runId: job.runId, storeId: job.storeId }, 'price update failed');
      const message = err instanceof Error ? err.message : String(err);
      await finishJob(db, job, {
        error: `Something went wrong while updating “${job.storeName}” (${message}). Update prices again later.`,
      });
      return;
    }
    if (err.kind === 'transient' && trying) {
      // Shown while the task waits to try again.
      await db.query('UPDATE price_run_stores SET error = $3 WHERE run_id = $1 AND store_id = $2', [
        job.runId,
        job.storeId,
        `Trying again: ${err.message}`,
      ]);
      throw err;
    }
    logger.warn({ err, runId: job.runId, storeId: job.storeId }, 'price update failed');
    await finishJob(db, job, { error: shopifyFailure(job.storeName, err) });
  }
}

function shopifyFailure(storeName: string, err: ShopifyApiError): string {
  switch (err.kind) {
    case 'auth':
      return (
        `“${storeName}” didn’t let Store Sync update its prices (${err.message}). Check that the ` +
        'app may update products (write_products), then click “Test connection” on the store’s page.'
      );
    case 'store_unavailable':
      return `Shopify says “${storeName}” isn’t available (${err.message}).`;
    case 'transient':
      return `We couldn’t reach “${storeName}” for an hour (${err.message}). Update prices again later.`;
    default:
      return `Shopify didn’t accept the update (${err.message}).`;
  }
}

interface WriteCounts {
  checked: number;
  changed: number;
  updated: number;
  failed: number;
  skipped: number;
}

/** Re-reads the store's prices, then writes the ones that differ from their target. */
async function writePrices(deps: TaskDeps, job: RunStoreJob): Promise<WriteCounts> {
  const { db } = deps;
  const settings = await getSettings(db);
  const restoreByItem = new Map(job.restore.map((r) => [r.itemId, r]));

  // 1. What's in scope: the items Store Sync has a price for in this store.
  const before = (await loadPricingStores(db, settings.baseCurrency, [job.storeId]))[0];
  if (!before) return { checked: 0, changed: 0, updated: 0, failed: 0, skipped: 0 };
  const allVariants = await loadStoreVariants(db, job.itemIds, [job.storeId]);
  const overridden = new Set(
    (await loadOverrides(db, job.itemIds, [job.storeId])).map((o) => o.itemId),
  );
  const ruleOn = before.rule?.enabled ?? false;
  const scope = allVariants.filter(
    (v) => ruleOn || overridden.has(v.itemId) || restoreByItem.has(v.itemId),
  );

  // 2. What the store charges now (Shopify first, outside any transaction), saved for the list.
  const admin = await deps.shopify.forStore(job.storeId);
  const live = await readCurrentPrices(admin, scope, job.itemIds !== null);
  await saveCurrentPrices(db, job.storeId, live);

  // 3. Targets from what the database says now (after the read).
  const store = (await loadPricingStores(db, settings.baseCurrency, [job.storeId]))[0]!;
  const itemIds = [...new Set(scope.map((v) => v.itemId))];
  const [items, overrides] = await Promise.all([
    loadPricingItems(db, itemIds),
    loadOverrides(db, itemIds, [job.storeId]),
  ]);
  const overrideAt = byCell(overrides);
  const writes: { variant: StoreVariant; sku: string; input: VariantPriceInput }[] = [];
  let checked = 0;
  let skipped = 0;
  for (const variant of scope) {
    const item = items.get(variant.itemId);
    const current = live.get(variant.variantId);
    if (!item || !current) continue; // deleted meanwhile (the catalog sync tidies up)
    const cell = priceCell(item, store, variant, overrideAt.get(cellKey(store.id, variant.itemId)));
    let target: TargetPrice = cell.target;
    if (target.status !== 'ok') {
      const restore = restoreByItem.get(variant.itemId);
      if (restore) {
        // The store charged this before a sale. Put it back only if the sale price is still
        // there: anything else was changed in Shopify meanwhile, and that change stays.
        checked++;
        const decimals = currencyDecimals(store.currencyCode);
        if (roundMoney(current.price, decimals) !== roundMoney(restore.salePrice, decimals)) {
          skipped++;
          continue;
        }
        target = {
          status: 'ok',
          source: 'override',
          price: roundMoney(restore.price, decimals),
          compareAtPrice: restoreCompareAt(restore, decimals),
        };
      } else {
        if (target.reason === 'no_base_price') {
          checked++;
          skipped++;
        }
        continue;
      }
    } else {
      checked++;
    }
    if (!differsFromTarget(current, target, store.currencyCode)) continue;
    writes.push({
      variant,
      sku: item.sku,
      input: {
        id: variant.variantId,
        price: toMoneyString(target.price, store.currencyCode),
        // Left out: the store's compare-at price stays as it is.
        ...(target.compareAtPrice === 'keep'
          ? {}
          : {
              compareAtPrice:
                target.compareAtPrice === null
                  ? null
                  : toMoneyString(target.compareAtPrice, store.currencyCode),
            }),
      },
    });
  }

  // 4. Write, product by product (Shopify's bulk update takes one product's variants).
  await db.query(
    `UPDATE price_run_stores SET variants_checked = $3, variants_skipped = $4,
            variants_failed = 0, errors = '[]'
      WHERE run_id = $1 AND store_id = $2`,
    [job.runId, job.storeId, checked, skipped],
  );
  const byProduct = new Map<string, typeof writes>();
  for (const w of writes) {
    const group = byProduct.get(w.variant.productId) ?? [];
    group.push(w);
    byProduct.set(w.variant.productId, group);
  }
  const errors: { sku: string; message: string }[] = [];
  let updated = 0;
  let failed = 0;
  for (const [productId, group] of byProduct) {
    const result = await admin.updateVariantPrices(
      productId,
      group.map((w) => w.input),
    );
    const refused = new Map<string, string>();
    for (const f of result.failed) {
      if (f.variantId === null) {
        // The whole product was refused (deleted meanwhile...).
        for (const w of group) refused.set(w.input.id, f.message);
      } else {
        refused.set(f.variantId, f.message);
      }
    }
    const done = group.filter((w) => !refused.has(w.input.id));
    for (const w of group) {
      const message = refused.get(w.input.id);
      if (message !== undefined && errors.length < MAX_ERRORS) errors.push({ sku: w.sku, message });
    }
    await saveWrittenPrices(db, job.storeId, done);
    updated += done.length;
    failed += group.length - done.length;
    await db.query(
      `UPDATE price_run_stores
          SET variants_updated = variants_updated + $3, variants_failed = $4, errors = $5
        WHERE run_id = $1 AND store_id = $2`,
      [job.runId, job.storeId, done.length, failed, JSON.stringify(errors)],
    );
  }
  return { checked, changed: writes.length, updated, failed, skipped };
}

function restoreCompareAt(restore: RestoreEntry, decimals: number): number | null {
  if (restore.compareAtPrice === null) return null;
  const compareAt = roundMoney(restore.compareAtPrice, decimals);
  return compareAt > 0 ? compareAt : null;
}

/**
 * The store's current prices of the variants in scope, by variant id. A few products are read one
 * by one; otherwise the whole store (one paged read). Variants missing from the answer were
 * deleted in Shopify and are left out.
 */
export async function readCurrentPrices(
  admin: ShopifyAdmin,
  scope: StoreVariant[],
  scoped: boolean,
): Promise<Map<string, CurrentPrice>> {
  const products = [...new Set(scope.map((v) => v.productId))];
  let listed: ShopifyVariant[] = [];
  if (products.length === 0) listed = [];
  else if (scoped && products.length <= PRODUCT_READS) {
    for (const productId of products)
      listed.push(...((await admin.listProductVariants(productId)) ?? []));
  } else {
    listed = await admin.listVariants();
  }
  const prices = new Map<string, CurrentPrice>();
  for (const v of listed) {
    if (v.price !== null)
      prices.set(v.variantId, { price: v.price, compareAtPrice: v.compareAtPrice });
  }
  return prices;
}

/** Saves prices just read (so the price list shows them). Only prices: never stock membership. */
export async function saveCurrentPrices(
  db: Queryable,
  storeId: number,
  prices: Map<string, CurrentPrice>,
): Promise<void> {
  if (prices.size === 0) return;
  const ids = [...prices.keys()];
  await db.query(
    `UPDATE variants v SET price = t.price, compare_at_price = t.compare_at_price
       FROM unnest($2::text[], $3::numeric[], $4::numeric[]) AS t(id, price, compare_at_price)
      WHERE v.store_id = $1 AND v.shopify_variant_id = t.id`,
    [
      storeId,
      ids,
      ids.map((id) => prices.get(id)!.price),
      ids.map((id) => prices.get(id)!.compareAtPrice),
    ],
  );
}

async function saveWrittenPrices(
  db: Queryable,
  storeId: number,
  written: { input: VariantPriceInput }[],
): Promise<void> {
  if (written.length === 0) return;
  // compareAtPrice undefined (kept) leaves the column as it is.
  await db.query(
    `UPDATE variants v
        SET price = t.price,
            compare_at_price = CASE WHEN t.keep THEN v.compare_at_price ELSE t.compare_at_price END
       FROM unnest($2::text[], $3::numeric[], $4::numeric[], $5::boolean[])
            AS t(id, price, compare_at_price, keep)
      WHERE v.store_id = $1 AND v.shopify_variant_id = t.id`,
    [
      storeId,
      written.map((w) => w.input.id),
      written.map((w) => Number(w.input.price)),
      written.map((w) => (w.input.compareAtPrice ? Number(w.input.compareAtPrice) : null)),
      written.map((w) => w.input.compareAtPrice === undefined),
    ],
  );
}

/** Ends a store's part of a run (done when `error` is null) and the run once every store ended. */
async function finishJob(
  db: Queryable,
  job: RunStoreJob,
  outcome: { error: string | null },
): Promise<void> {
  await db.query(
    `UPDATE price_run_stores SET status = $3, error = $4, finished_at = now()
      WHERE run_id = $1 AND store_id = $2 AND status IN ('queued', 'running')`,
    [job.runId, job.storeId, outcome.error ? 'failed' : 'done', outcome.error],
  );
  await finishRun(db, job.runId);
  if (outcome.error) await raiseScheduledFailure(db, job.reason, job.storeId, outcome.error);
  else {
    // Prices reached the store: an earlier scheduled update that couldn't is caught up.
    await setAlert(db, {
      open: false,
      kind: 'price_update_failed',
      dedupeKey: `price_update_failed:${job.storeId}`,
      message: '',
    });
  }
}

/** A run is over when none of its stores is queued or running; failed if any store failed. */
export async function finishRun(db: Queryable, runId: number): Promise<void> {
  await db.query(
    `UPDATE price_runs r
        SET status = CASE WHEN EXISTS (SELECT 1 FROM price_run_stores
                                        WHERE run_id = r.id AND status = 'failed')
                          THEN 'failed' ELSE 'done' END,
            finished_at = now()
      WHERE r.id = $1 AND r.status IN ('queued', 'running')
        AND NOT EXISTS (SELECT 1 FROM price_run_stores
                         WHERE run_id = r.id AND status IN ('queued', 'running'))`,
    [runId],
  );
}

/**
 * Nobody watches a scheduled price change happen: when one can't reach a store, say so. Resolved
 * by the next scheduled update that works in that store.
 */
async function raiseScheduledFailure(
  db: Queryable,
  reason: RunReason,
  storeId: number,
  error: string,
): Promise<void> {
  if (reason.kind === 'manual') return;
  const { rows } = await db.query<{ name: string }>(
    'SELECT name FROM price_schedules WHERE id = $1',
    [reason.scheduleId],
  );
  const what =
    reason.kind === 'sale_start'
      ? `the start of the sale “${rows[0]?.name ?? 'removed'}”`
      : reason.kind === 'sale_end'
        ? `the end of the sale “${rows[0]?.name ?? 'removed'}”`
        : `the price change “${rows[0]?.name ?? 'removed'}”`;
  await setAlert(db, {
    open: true,
    kind: 'price_update_failed',
    dedupeKey: `price_update_failed:${storeId}`,
    storeId,
    message: `Prices weren’t updated for ${what}: ${error} Then use “Update prices in stores…” on the Prices page.`,
    details: { scheduleId: reason.scheduleId },
    renotify: true,
  });
}

// ---- history --------------------------------------------------------------------------------

export interface RunView {
  id: number;
  reason: RunReason['kind'];
  schedule: { id: number; name: string; kind: string } | null;
  /** null = every item. */
  itemCount: number | null;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  stores: {
    storeId: number;
    storeName: string;
    status: string;
    checked: number;
    updated: number;
    failed: number;
    skipped: number;
    error: string | null;
    errors: { sku: string; message: string }[];
    startedAt: Date | null;
    finishedAt: Date | null;
  }[];
}

export async function loadRuns(
  db: Queryable,
  opts: { runId?: number; limit?: number },
): Promise<RunView[]> {
  const { rows } = await db.query<{
    id: number;
    reason: string;
    item_ids: number[] | null;
    status: string;
    created_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, reason, item_ids, status, created_at, finished_at FROM price_runs
      ${opts.runId === undefined ? '' : 'WHERE id = $2'}
      ORDER BY id DESC LIMIT $1`,
    opts.runId === undefined ? [opts.limit ?? 20] : [1, opts.runId],
  );
  if (rows.length === 0) return [];
  const runIds = rows.map((r) => r.id);
  const reasons = rows.map((r) => parseReason(r.reason));
  const scheduleIds = reasons.flatMap((r) => (r.kind === 'manual' ? [] : [r.scheduleId]));
  const [stores, schedules] = await Promise.all([
    db.query<{
      run_id: number;
      store_id: number;
      name: string;
      status: string;
      variants_checked: number;
      variants_updated: number;
      variants_failed: number;
      variants_skipped: number;
      error: string | null;
      errors: { sku: string; message: string }[];
      started_at: Date | null;
      finished_at: Date | null;
    }>(
      `SELECT prs.*, s.name FROM price_run_stores prs JOIN stores s ON s.id = prs.store_id
        WHERE prs.run_id = ANY($1::bigint[]) ORDER BY s.id`,
      [runIds],
    ),
    db.query<{ id: number; name: string; kind: string }>(
      'SELECT id, name, kind FROM price_schedules WHERE id = ANY($1::bigint[])',
      [scheduleIds],
    ),
  ]);
  return rows.map((r, i) => {
    const reason = reasons[i]!;
    const schedule =
      reason.kind === 'manual' ? undefined : schedules.rows.find((s) => s.id === reason.scheduleId);
    return {
      id: r.id,
      reason: reason.kind,
      schedule: schedule ? { id: schedule.id, name: schedule.name, kind: schedule.kind } : null,
      itemCount: r.item_ids?.length ?? null,
      status: r.status,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      stores: stores.rows
        .filter((s) => s.run_id === r.id)
        .map((s) => ({
          storeId: s.store_id,
          storeName: s.name,
          status: s.status,
          checked: s.variants_checked,
          updated: s.variants_updated,
          failed: s.variants_failed,
          skipped: s.variants_skipped,
          error: s.error,
          errors: s.errors,
          startedAt: s.started_at,
          finishedAt: s.finished_at,
        })),
    };
  });
}
