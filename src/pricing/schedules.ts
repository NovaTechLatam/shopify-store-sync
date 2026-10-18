import { lockItemRows, LOCKS } from '../db/locks.js';
import type { Db, DbClient, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { setAlert } from '../alerts/alerts.js';
import { getSettings } from '../settings.js';
import type { TaskDeps } from '../tasks/types.js';
import { currencyDecimals, roundMoney } from '../util/money.js';
import type { CurrentPrice } from './compute.js';
import { computeTargetPrice, salePrice } from './compute.js';
import { PricingError } from './errors.js';
import {
  byCell,
  cellKey,
  loadOverrides,
  loadPricingItems,
  loadPricingStores,
  loadStoreVariants,
} from './prices.js';
import type { CreatedRun, RestoreEntry } from './runs.js';
import { createPriceRun, pendingRestores, readCurrentPrices, saveCurrentPrices } from './runs.js';

/**
 * SCHEDULED PRICES: sales and base price changes (price_schedules)
 *
 * A sale lowers prices by a percentage in some stores between two times. When it starts, each
 * product it covers gets a fixed price (price_overrides) owned by the sale, and what was there
 * before is saved in `previous`; when it ends, every fixed price the sale still owns is put back
 * (or removed), and fixed prices the merchant changed meanwhile are left alone. A base change sets
 * new base prices at a time (permanent). Both then update the stores' prices with a run.
 *
 * The scheduler job only finds due schedules and queues a `price_schedule` task for each; the
 * task locks the schedule row (FOR UPDATE SKIP LOCKED) and re-checks it is still due, so with
 * several instances each start and end happens once.
 */

/** Serialises creating and editing schedules (the overlap check). */
const SCHEDULE_LOCK = LOCKS.priceSchedules;

export interface SaleInput {
  kind: 'sale';
  name: string;
  startsAt: Date;
  endsAt: Date;
  /** null = every store. */
  storeIds: number[] | null;
  itemIds: number[];
  percentOff: number;
  showCompareAt: boolean;
}

export interface BaseChangeInput {
  kind: 'base_change';
  name: string;
  startsAt: Date;
  changes: { itemId: number; basePrice: number; baseCompareAtPrice: number | null }[];
}

export type ScheduleInput = SaleInput | BaseChangeInput;

/** What a sale replaced in one store for one item (price_schedules.previous). */
export interface SalePrevious {
  storeId: number;
  itemId: number;
  /** The fixed price that was there before the sale, put back when it ends. */
  override: { price: number; compareAtPrice: number | null; note: string | null } | null;
  /** Where the regular price came from: the fixed price, the rule, or the store itself. */
  source: 'override' | 'rule' | 'store';
  regular: number;
  /**
   * The compare-at price that went with the regular price. Both are put back where Store Sync has
   * no price of its own for the item when the sale ends (its rule was turned off meanwhile, or it
   * never had one: source 'store').
   */
  regularCompareAt: number | null;
  salePrice: number;
}

/** A base change's previous: the base prices it replaced. */
export interface BasePrevious {
  itemId: number;
  basePrice: number | null;
  baseCompareAtPrice: number | null;
}

interface ScheduleRow {
  id: number;
  name: string;
  kind: 'sale' | 'base_change';
  starts_at: Date;
  ends_at: Date | null;
  status: 'scheduled' | 'active' | 'ended' | 'cancelled' | 'failed';
  store_ids: number[] | null;
  item_ids: number[];
  percent_off: number | null;
  show_compare_at: boolean;
  changes: BaseChangeInput['changes'];
  previous: (SalePrevious | BasePrevious)[] | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
}

/** A schedule that can't be carried out (nothing left to change): it is marked failed. */
class ScheduleFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleFailure';
  }
}

// ---- creating and editing -------------------------------------------------------------------

/** Checks the input against the database; throws PricingError with what to fix. */
async function validate(client: Queryable, input: ScheduleInput, id: number | null): Promise<void> {
  const itemIds = input.kind === 'sale' ? input.itemIds : input.changes.map((c) => c.itemId);
  if (new Set(itemIds).size !== itemIds.length) {
    throw new PricingError(400, 'Each product can be in the list only once.');
  }
  const { rows: items } = await client.query<{ id: number }>(
    'SELECT id FROM items WHERE id = ANY($1::bigint[])',
    [itemIds],
  );
  if (items.length !== itemIds.length) {
    throw new PricingError(400, 'Some of the products don’t exist any more. Choose them again.');
  }
  if (input.kind === 'base_change') {
    const bad = input.changes.find(
      (c) => c.baseCompareAtPrice !== null && c.baseCompareAtPrice <= c.basePrice,
    );
    if (bad) {
      throw new PricingError(
        400,
        'A compare-at price must be higher than the price (it’s shown crossed out). Leave it empty for none.',
      );
    }
    return;
  }
  if (input.endsAt <= input.startsAt) {
    throw new PricingError(400, 'The sale must end after it starts.');
  }
  if (input.endsAt.getTime() <= Date.now()) {
    throw new PricingError(400, 'The end of the sale is in the past. Choose a later end.');
  }
  if (input.storeIds) {
    const { rows: stores } = await client.query<{ id: number }>(
      'SELECT id FROM stores WHERE id = ANY($1::bigint[])',
      [input.storeIds],
    );
    if (stores.length !== new Set(input.storeIds).size) {
      throw new PricingError(400, 'Some of the stores don’t exist any more. Choose them again.');
    }
  }
  // Two sales on the same product in the same store at the same time: which price would win, and
  // what would each put back when it ends? Refused.
  const { rows: other } = await client.query<{ name: string; starts_at: Date; ends_at: Date }>(
    `SELECT name, starts_at, ends_at FROM price_schedules
      WHERE kind = 'sale' AND status IN ('scheduled', 'active') AND id <> $1
        AND starts_at < $3 AND ends_at > $2
        AND (store_ids IS NULL OR $4::bigint[] IS NULL OR store_ids && $4::bigint[])
        AND item_ids && $5::bigint[]
      ORDER BY starts_at LIMIT 1`,
    [id ?? 0, input.startsAt, input.endsAt, input.storeIds, input.itemIds],
  );
  if (other[0]) {
    throw new PricingError(
      409,
      `This sale overlaps “${other[0].name}”, which puts some of the same products on sale in the ` +
        'same stores at the same time. Change the dates, the products or the stores.',
    );
  }
}

export async function createSchedule(db: Db, input: ScheduleInput): Promise<number> {
  return withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEDULE_LOCK]);
    await validate(client, input, null);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO price_schedules (name, kind, starts_at, ends_at, store_ids, item_ids,
                                    percent_off, show_compare_at, changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      inputColumns(input),
    );
    return rows[0]!.id;
  });
}

/** Replaces a schedule that hasn't started yet. */
export async function updateSchedule(db: Db, id: number, input: ScheduleInput): Promise<void> {
  await withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEDULE_LOCK]);
    const current = await lockSchedule(client, id);
    if (current.status !== 'scheduled') {
      throw new PricingError(409, 'This has already started or ended, so it can’t be changed.');
    }
    if (current.kind !== input.kind) throw new PricingError(400, 'The kind can’t be changed.');
    await validate(client, input, id);
    await client.query(
      `UPDATE price_schedules
          SET name = $2, kind = $3, starts_at = $4, ends_at = $5, store_ids = $6, item_ids = $7,
              percent_off = $8, show_compare_at = $9, changes = $10, error = NULL
        WHERE id = $1`,
      [id, ...inputColumns(input)],
    );
  });
}

function inputColumns(input: ScheduleInput): unknown[] {
  return input.kind === 'sale'
    ? [
        input.name,
        'sale',
        input.startsAt,
        input.endsAt,
        input.storeIds,
        input.itemIds,
        input.percentOff,
        input.showCompareAt,
        '[]',
      ]
    : [
        input.name,
        'base_change',
        input.startsAt,
        null,
        null,
        input.changes.map((c) => c.itemId),
        null,
        true,
        JSON.stringify(input.changes),
      ];
}

async function lockSchedule(client: DbClient, id: number): Promise<ScheduleRow> {
  const { rows } = await client.query<ScheduleRow>(
    'SELECT * FROM price_schedules WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw new PricingError(404, 'Schedule not found');
  return rows[0];
}

/**
 * Cancels a schedule that hasn't started; ends a running sale now (putting the prices back).
 * Returns the run that updates the stores, if any (wake the task runner).
 */
export async function cancelSchedule(db: Db, id: number): Promise<CreatedRun | null> {
  return withTransaction(db, async (client) => {
    // Waits for a start that is being made right now, then sees the sale as running.
    const s = await lockSchedule(client, id);
    if (s.status === 'scheduled') {
      await client.query(
        `UPDATE price_schedules SET status = 'cancelled', ended_at = now() WHERE id = $1`,
        [id],
      );
      await resolveFailure(client, id);
      return null;
    }
    if (s.status === 'active') return endSale(client, s);
    throw new PricingError(
      409,
      s.kind === 'sale'
        ? 'This sale isn’t scheduled or running any more.'
        : 'This price change isn’t scheduled any more.',
    );
  });
}

// ---- carrying them out ----------------------------------------------------------------------

/** Schedules whose start or end is due: the job queues a task for each. */
export async function dueScheduleIds(client: Queryable): Promise<number[]> {
  const { rows } = await client.query<{ id: number }>(
    `SELECT id FROM price_schedules
      WHERE (status = 'scheduled' AND starts_at <= now())
         OR (status = 'active' AND ends_at <= now())
      ORDER BY id LIMIT 100
      FOR UPDATE SKIP LOCKED`,
  );
  return rows.map((r) => r.id);
}

/** The price_schedule task: starts or ends the schedule if that is (still) due. */
export async function runSchedule(deps: TaskDeps, scheduleId: number): Promise<void> {
  const { db, logger } = deps;
  const { rows } = await db.query<ScheduleRow>('SELECT * FROM price_schedules WHERE id = $1', [
    scheduleId,
  ]);
  const s = rows[0];
  if (!s || (s.status !== 'scheduled' && s.status !== 'active')) return;
  // Stores whose regular price is their own (Store Sync has none for the item) are read first,
  // so the sale takes its percentage off what they charge right now.
  const readAt = new Date();
  const starting = s.status === 'scheduled' && s.kind === 'sale' && s.ends_at! > readAt;
  const live = starting ? await readSalePrices(deps, s) : new Map<string, CurrentPrice>();
  try {
    const run = await withTransaction(db, async (client) => {
      const due = s.status === 'scheduled' ? 'starts_at' : 'ends_at';
      const { rows: locked } = await client.query<ScheduleRow & { over: boolean }>(
        `SELECT *, ends_at <= now() AS over FROM price_schedules
          WHERE id = $1 AND status = $2 AND ${due} <= now()
           FOR UPDATE SKIP LOCKED`,
        [scheduleId, s.status],
      );
      const row = locked[0];
      if (!row) return null; // not due yet, done by another instance, or cancelled
      if (row.status === 'active') return endSale(client, row);
      if (row.kind === 'sale') {
        // Store Sync wasn't running from before the start to after the end: starting it now
        // would put sale prices up for a minute, after the sale.
        if (row.over) {
          throw new ScheduleFailure(
            'it ended before Store Sync could start it (Store Sync wasn’t running then), so no price changed.',
          );
        }
        return startSale(client, row, live, readAt);
      }
      return applyBaseChange(client, row);
    });
    logger.info({ scheduleId, runId: run?.runId ?? null }, 'price schedule carried out');
  } catch (err) {
    if (!(err instanceof ScheduleFailure)) throw err;
    logger.warn({ scheduleId, err }, 'price schedule failed');
    await db.query(
      `UPDATE price_schedules SET status = 'failed', error = $2
        WHERE id = $1 AND status IN ('scheduled', 'active')`,
      [scheduleId, err.message],
    );
    await setAlert(db, {
      open: true,
      kind: 'price_schedule_failed',
      dedupeKey: `price_schedule_failed:${scheduleId}`,
      message: `${s.kind === 'sale' ? 'The sale' : 'The price change'} “${s.name}” didn’t start: ${err.message}`,
      details: { scheduleId },
      renotify: true,
    });
  }
}

async function resolveFailure(db: Queryable, scheduleId: number): Promise<void> {
  await setAlert(db, {
    open: false,
    kind: 'price_schedule_failed',
    dedupeKey: `price_schedule_failed:${scheduleId}`,
    message: '',
  });
}

/**
 * What the sale's stores charge now for the items Store Sync has no price for there (rule off or
 * no base price, no fixed price). Best effort: a store that can't be read keeps the prices from
 * the last catalog read.
 */
async function readSalePrices(deps: TaskDeps, s: ScheduleRow): Promise<Map<string, CurrentPrice>> {
  const { db, logger } = deps;
  const settings = await getSettings(db);
  const stores = await loadPricingStores(db, settings.baseCurrency, s.store_ids ?? undefined);
  const [items, variants, overrides] = await Promise.all([
    loadPricingItems(db, s.item_ids),
    loadStoreVariants(db, s.item_ids),
    loadOverrides(db, s.item_ids),
  ]);
  const overrideAt = byCell(overrides);
  const prices = new Map<string, CurrentPrice>();
  for (const store of stores) {
    if (store.status !== 'active') continue;
    const needed = variants.filter((v) => {
      const item = items.get(v.itemId);
      if (v.storeId !== store.id || !item) return false;
      const o = overrideAt.get(cellKey(store.id, v.itemId));
      return (
        computeTargetPrice({
          basePrice: item.basePrice,
          baseCompareAtPrice: item.baseCompareAtPrice,
          exchangeRate: store.exchangeRate,
          rule: store.rule,
          currencyCode: store.currencyCode,
          override: o ? { price: o.price, compareAtPrice: o.compareAtPrice } : null,
        }).status !== 'ok'
      );
    });
    if (needed.length === 0) continue;
    try {
      const admin = await deps.shopify.forStore(store.id);
      const live = await readCurrentPrices(admin, needed, true);
      await saveCurrentPrices(db, store.id, live);
      for (const v of needed) {
        const price = live.get(v.variantId);
        if (price) prices.set(cellKey(store.id, v.itemId), price);
      }
    } catch (err) {
      logger.warn({ err, storeId: store.id, scheduleId: s.id }, 'could not read prices for a sale');
    }
  }
  return prices;
}

async function startSale(
  client: DbClient,
  s: ScheduleRow,
  live: Map<string, CurrentPrice>,
  readAt: Date,
): Promise<CreatedRun | null> {
  const settings = await getSettings(client);
  const stores = await loadPricingStores(client, settings.baseCurrency, s.store_ids ?? undefined);
  const items = await loadPricingItems(client, s.item_ids);
  const storeIds = stores.map((x) => x.id);
  const itemIds = [...items.keys()];
  const variantAt = byCell(await loadStoreVariants(client, itemIds, storeIds));
  // Lock the fixed prices the sale replaces: an edit made at this moment is either before (and is
  // the regular price) or after (and takes the item out of the sale).
  await client.query(
    `SELECT 1 FROM price_overrides
      WHERE store_id = ANY($1::bigint[]) AND item_id = ANY($2::bigint[])
      ORDER BY store_id, item_id FOR UPDATE`,
    [storeIds, itemIds],
  );
  const overrideAt = byCell(await loadOverrides(client, itemIds, storeIds));
  // Back-to-back sales (one ends when the next starts) are carried out in any order. A sale still
  // holding a price here hasn't ended yet: this one takes over what that sale replaced. One that
  // ended may not have put its prices back in the stores yet: what it will put back is the
  // regular price, not the old sale price a store still charges.
  const replacedBy = await otherSalesPrevious(client, s.id, [...overrideAt.values()]);
  const restoring = await pendingRestores(client, storeIds, readAt);
  const percentOff = s.percent_off!;
  const previous: SalePrevious[] = [];
  for (const store of stores) {
    if (!store.currencyKnown) continue;
    const decimals = currencyDecimals(store.currencyCode);
    const restoreOf = new Map((restoring.get(store.id) ?? []).map((r) => [r.itemId, r]));
    for (const item of items.values()) {
      const key = cellKey(store.id, item.id);
      const variant = variantAt.get(key);
      if (!variant) continue; // not sold there
      const owned = overrideAt.get(key);
      const inherited = owned?.scheduleId ? replacedBy.get(key) : undefined;
      const o = inherited ? (inherited.override ?? undefined) : owned;
      const target = computeTargetPrice({
        basePrice: item.basePrice,
        baseCompareAtPrice: item.baseCompareAtPrice,
        exchangeRate: store.exchangeRate,
        rule: store.rule,
        currencyCode: store.currencyCode,
        override: o ? { price: o.price, compareAtPrice: o.compareAtPrice } : null,
      });
      const current =
        live.get(key) ??
        (variant.price !== null
          ? { price: variant.price, compareAtPrice: variant.compareAtPrice }
          : null);
      let regular: number;
      let regularCompareAt: number | null;
      let source: SalePrevious['source'];
      if (target.status === 'ok') {
        regular = target.price;
        regularCompareAt =
          target.compareAtPrice === 'keep'
            ? (current?.compareAtPrice ?? null)
            : target.compareAtPrice;
        source = target.source;
      } else if (inherited) {
        regular = inherited.regular;
        regularCompareAt = inherited.regularCompareAt ?? null;
        source = 'store';
      } else {
        if (!current) continue; // no price known at all
        const restore = restoreOf.get(item.id);
        if (
          restore &&
          roundMoney(current.price, decimals) === roundMoney(restore.salePrice, decimals)
        ) {
          regular = roundMoney(restore.price, decimals);
          regularCompareAt = restore.compareAtPrice;
        } else {
          regular = roundMoney(current.price, decimals);
          regularCompareAt = current.compareAtPrice;
        }
        source = 'store';
      }
      const price = salePrice(regular, percentOff, store.rule, store.currencyCode);
      if (price === null) continue;
      await client.query(
        `INSERT INTO price_overrides (store_id, item_id, price, compare_at_price, schedule_id, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (store_id, item_id) DO UPDATE
           SET price = EXCLUDED.price, compare_at_price = EXCLUDED.compare_at_price,
               schedule_id = EXCLUDED.schedule_id, note = EXCLUDED.note, updated_at = now()`,
        [
          store.id,
          item.id,
          price,
          s.show_compare_at ? regular : null,
          s.id,
          `Sale: ${s.name}`.slice(0, 500),
        ],
      );
      previous.push({
        storeId: store.id,
        itemId: item.id,
        override: o ? { price: o.price, compareAtPrice: o.compareAtPrice, note: o.note } : null,
        source,
        regular,
        regularCompareAt,
        salePrice: price,
      });
    }
  }
  if (previous.length === 0) {
    throw new ScheduleFailure(
      'none of its products is sold in its stores with a known price, so nothing went on sale.',
    );
  }
  await client.query(
    `UPDATE price_schedules SET status = 'active', started_at = now(), previous = $2, error = NULL
      WHERE id = $1`,
    [s.id, JSON.stringify(previous)],
  );
  await resolveFailure(client, s.id);
  return createPriceRun(client, {
    reason: { kind: 'sale_start', scheduleId: s.id },
    itemIds: s.item_ids,
    storeIds: [...new Set(previous.map((p) => p.storeId))],
  });
}

/**
 * What other sales replaced where they still hold the price (by cell). Read without locking those
 * sales: their end locks its fixed prices after its own row, and this sale holds them already.
 */
async function otherSalesPrevious(
  client: Queryable,
  scheduleId: number,
  overrides: { scheduleId: number | null }[],
): Promise<Map<string, SalePrevious>> {
  const ids = [
    ...new Set(
      overrides.flatMap((o) => (o.scheduleId && o.scheduleId !== scheduleId ? [o.scheduleId] : [])),
    ),
  ];
  const out = new Map<string, SalePrevious>();
  if (ids.length === 0) return out;
  const { rows } = await client.query<{ previous: SalePrevious[] | null }>(
    `SELECT previous FROM price_schedules WHERE id = ANY($1::bigint[]) AND kind = 'sale'`,
    [ids],
  );
  for (const row of rows) {
    for (const p of row.previous ?? []) out.set(cellKey(p.storeId, p.itemId), p);
  }
  return out;
}

/** Puts back what the sale replaced, where the sale's price is still the one in place. */
async function endSale(client: DbClient, s: ScheduleRow): Promise<CreatedRun | null> {
  const previous = (s.previous ?? []) as SalePrevious[];
  const { rows: owned } = await client.query<{ store_id: number; item_id: number }>(
    // In the same order as a starting sale locks them: back-to-back sales don't deadlock.
    `SELECT store_id, item_id FROM price_overrides WHERE schedule_id = $1
      ORDER BY store_id, item_id FOR UPDATE`,
    [s.id],
  );
  const stillOwned = new Set(owned.map((o) => cellKey(o.store_id, o.item_id)));
  const restore = new Map<number, RestoreEntry[]>();
  for (const p of previous) {
    const key = cellKey(p.storeId, p.itemId);
    // The merchant set or removed this fixed price during the sale: theirs stays.
    if (!stillOwned.has(key)) continue;
    stillOwned.delete(key);
    if (p.override) {
      await client.query(
        `UPDATE price_overrides SET price = $3, compare_at_price = $4, note = $5,
                schedule_id = NULL, updated_at = now()
          WHERE store_id = $1 AND item_id = $2`,
        [p.storeId, p.itemId, p.override.price, p.override.compareAtPrice, p.override.note],
      );
    } else {
      await client.query('DELETE FROM price_overrides WHERE store_id = $1 AND item_id = $2', [
        p.storeId,
        p.itemId,
      ]);
    }
    // Used only where Store Sync has no price of its own for the item when the run writes: the
    // store sets its own prices (source 'store'), or its rule was turned off during the sale.
    const list = restore.get(p.storeId) ?? [];
    list.push({
      itemId: p.itemId,
      price: p.regular,
      compareAtPrice: p.regularCompareAt ?? null,
      salePrice: p.salePrice,
    });
    restore.set(p.storeId, list);
  }
  // Anything else still marked as the sale's (shouldn't exist) stops being its.
  if (stillOwned.size > 0) {
    await client.query('DELETE FROM price_overrides WHERE schedule_id = $1', [s.id]);
  }
  await client.query(
    `UPDATE price_schedules SET status = 'ended', ended_at = now() WHERE id = $1`,
    [s.id],
  );
  return createPriceRun(client, {
    reason: { kind: 'sale_end', scheduleId: s.id },
    itemIds: s.item_ids,
    storeIds: [...new Set(previous.map((p) => p.storeId))],
    restore,
  });
}

async function applyBaseChange(client: DbClient, s: ScheduleRow): Promise<CreatedRun | null> {
  await lockItemRows(
    client,
    s.changes.map((c) => c.itemId),
  );
  const { rows } = await client.query<{
    id: number;
    base_price: number | null;
    base_compare_at_price: number | null;
  }>(
    `SELECT id, base_price, base_compare_at_price FROM items
      WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [s.changes.map((c) => c.itemId)],
  );
  if (rows.length === 0) {
    throw new ScheduleFailure('none of its products exists any more.');
  }
  const changes = s.changes.filter((c) => rows.some((r) => r.id === c.itemId));
  await client.query(
    `UPDATE items i SET base_price = t.base_price, base_compare_at_price = t.compare_at,
            updated_at = now()
       FROM unnest($1::bigint[], $2::numeric[], $3::numeric[]) AS t(id, base_price, compare_at)
      WHERE i.id = t.id`,
    [
      changes.map((c) => c.itemId),
      changes.map((c) => c.basePrice),
      changes.map((c) => c.baseCompareAtPrice),
    ],
  );
  const previous: BasePrevious[] = rows.map((r) => ({
    itemId: r.id,
    basePrice: r.base_price,
    baseCompareAtPrice: r.base_compare_at_price,
  }));
  await client.query(
    `UPDATE price_schedules
        SET status = 'ended', started_at = now(), ended_at = now(), previous = $2, error = NULL
      WHERE id = $1`,
    [s.id, JSON.stringify(previous)],
  );
  await resolveFailure(client, s.id);
  return createPriceRun(client, {
    reason: { kind: 'base_change', scheduleId: s.id },
    itemIds: changes.map((c) => c.itemId),
    storeIds: null,
  });
}

// ---- reading ----------------------------------------------------------------------------------

export interface ScheduleView {
  id: number;
  name: string;
  kind: 'sale' | 'base_change';
  status: ScheduleRow['status'];
  startsAt: Date;
  endsAt: Date | null;
  storeIds: number[] | null;
  stores: { id: number; name: string }[];
  itemIds: number[];
  items: { itemId: number; sku: string; title: string }[];
  percentOff: number | null;
  showCompareAt: boolean;
  changes: {
    itemId: number;
    sku: string | null;
    title: string | null;
    basePrice: number;
    baseCompareAtPrice: number | null;
    /** The base price now (before the change starts; after, the one it set unless edited). */
    currentBasePrice: number | null;
    /** What the change replaced, once made. */
    previousBasePrice: number | null;
  }[];
  /** Prices the sale changed (one per store and product), once started. */
  pricesChanged: number | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The newest update of the stores' prices it made. */
  lastRun: { id: number; status: string } | null;
}

export async function loadSchedules(
  db: Queryable,
  opts: { id?: number } = {},
): Promise<ScheduleView[]> {
  const { rows } = await db.query<ScheduleRow>(
    `SELECT * FROM price_schedules ${opts.id === undefined ? '' : 'WHERE id = $1'}
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
               CASE WHEN status IN ('active', 'scheduled') THEN starts_at END ASC,
               COALESCE(ended_at, starts_at) DESC, id DESC
      LIMIT 200`,
    opts.id === undefined ? [] : [opts.id],
  );
  if (rows.length === 0) return [];
  const itemIds = [...new Set(rows.flatMap((r) => r.item_ids))];
  const [items, stores, runs] = await Promise.all([
    db.query<{ id: number; sku: string; title: string; base_price: number | null }>(
      'SELECT id, sku, title, base_price FROM items WHERE id = ANY($1::bigint[])',
      [itemIds],
    ),
    db.query<{ id: number; name: string }>('SELECT id, name FROM stores ORDER BY id'),
    db.query<{ id: number; reason: string; status: string }>(
      `SELECT DISTINCT ON (reason) id, reason, status FROM price_runs
        WHERE reason LIKE 'schedule:%' AND reason ~ ('^schedule:(' || $1 || ')(:|$)')
        ORDER BY reason, id DESC`,
      [rows.map((r) => r.id).join('|')],
    ),
  ]);
  const itemById = new Map(items.rows.map((i) => [i.id, i]));
  return rows.map((r) => {
    const previous = r.previous ?? [];
    const runsOf = runs.rows
      .filter((run) => new RegExp(`^schedule:${r.id}(:|$)`).test(run.reason))
      .sort((a, b) => b.id - a.id);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      status: r.status,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      storeIds: r.store_ids,
      stores: stores.rows.filter((s) => r.store_ids === null || r.store_ids.includes(s.id)),
      itemIds: r.item_ids,
      items: r.item_ids.flatMap((id) => {
        const item = itemById.get(id);
        return item ? [{ itemId: id, sku: item.sku, title: item.title }] : [];
      }),
      percentOff: r.percent_off,
      showCompareAt: r.show_compare_at,
      changes: r.changes.map((c) => {
        const item = itemById.get(c.itemId);
        const before = (previous as BasePrevious[]).find((p) => p.itemId === c.itemId);
        return {
          itemId: c.itemId,
          sku: item?.sku ?? null,
          title: item?.title ?? null,
          basePrice: c.basePrice,
          baseCompareAtPrice: c.baseCompareAtPrice,
          currentBasePrice: item?.base_price ?? null,
          previousBasePrice: before?.basePrice ?? null,
        };
      }),
      pricesChanged: r.kind === 'sale' && r.previous ? previous.length : null,
      error: r.error,
      createdAt: r.created_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      lastRun: runsOf[0] ? { id: runsOf[0].id, status: runsOf[0].status } : null,
    };
  });
}
