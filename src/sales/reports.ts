import type { Queryable } from '../db/pool.js';
import { getSettings, reportTimezone, type Settings } from '../settings.js';
import { missingScopes } from '../shopify/scopes.js';
import { roundMoney } from '../util/money.js';
import { paceDays, productFigures } from './metrics.js';
import { datesBetween, resolvePeriod } from './period.js';

/**
 * The report queries. Every figure follows the same rules:
 * - a sale counts on the day its order was processed, in the report's time zone;
 * - revenue is net: after discounts, refunds and removed items, before tax (Shopify's
 *   priceAfterAllDiscountsBeforeTaxes of each line); units are what's left after refunds;
 * - test orders, cancelled orders and gift cards are left out;
 * - amounts are converted to the base currency with each store's exchange rate as it is now
 *   (not the rate of the sale's day): change a rate and past reports change with it;
 * - margin only looks at lines that have a cost (each line keeps its product's cost from when we
 *   first saw it); revenue without a cost is reported apart.
 */

export interface ReportStore {
  id: number;
  name: string;
  status: string;
  currencyCode: string | null;
  exchangeRate: number;
  grantedScopes: string[] | null;
}

export interface ReportContext {
  settings: Settings;
  baseCurrency: string;
  timezone: string;
  from: string;
  to: string;
  /** The period as instants: from midnight of `from` to midnight after `to`, in `timezone`. */
  start: Date;
  end: Date;
  /** The stores the report is about (the filter), and every store. */
  stores: ReportStore[];
  allStores: ReportStore[];
}

export interface ReportQuery {
  from?: string;
  to?: string;
  /** undefined = every store. */
  storeIds?: number[];
}

/** Settings, time zone, period and stores of a report request. */
export async function reportContext(
  db: Queryable,
  query: ReportQuery,
  now: Date = new Date(),
): Promise<ReportContext> {
  const settings = await getSettings(db);
  const allStores = await loadReportStores(db);
  const timezone = await reportTimezone(db, settings);
  const { from, to } = resolvePeriod(query, timezone, now);
  const { rows } = await db.query<{ start: Date; end: Date }>(
    `SELECT ($1::date)::timestamp AT TIME ZONE $3 AS start,
            ($2::date + 1)::timestamp AT TIME ZONE $3 AS "end"`,
    [from, to, timezone],
  );
  const wanted = query.storeIds ? new Set(query.storeIds) : null;
  return {
    settings,
    baseCurrency: settings.baseCurrency,
    timezone,
    from,
    to,
    start: rows[0]!.start,
    end: rows[0]!.end,
    stores: wanted ? allStores.filter((s) => wanted.has(s.id)) : allStores,
    allStores,
  };
}

async function loadReportStores(db: Queryable): Promise<ReportStore[]> {
  const { rows } = await db.query<{
    id: number;
    name: string;
    status: string;
    currency_code: string | null;
    exchange_rate: number;
    granted_scopes: string[] | null;
  }>(
    'SELECT id, name, status, currency_code, exchange_rate, granted_scopes FROM stores ORDER BY id',
  );
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    currencyCode: s.currency_code,
    exchangeRate: s.exchange_rate,
    grantedScopes: s.granted_scopes,
  }));
}

/**
 * The lines a report counts (aliases: l = sales_lines, o = sales_orders): $1 start, $2 end, $3
 * store ids. A line's date and store are its order's: saying it for both lets Postgres read only
 * the period's orders through their index, instead of hashing every order.
 */
const COUNTED = `l.processed_at >= $1 AND l.processed_at < $2 AND l.store_id = ANY($3::bigint[])
  AND o.processed_at >= $1 AND o.processed_at < $2 AND o.store_id = ANY($3::bigint[])
  AND NOT l.is_gift_card AND NOT o.test AND o.cancelled_at IS NULL`;

const DAY_MS = 24 * 60 * 60_000;
const money = (n: number) => roundMoney(n, 4);
const fraction = (n: number | null) => (n === null ? null : Math.round(n * 10_000) / 10_000);
const marginOf = (revenueWithCost: number, cost: number) =>
  revenueWithCost > 0 ? fraction((revenueWithCost - cost) / revenueWithCost) : null;

// ---- summary --------------------------------------------------------------------------------

export async function loadSummary(db: Queryable, ctx: ReportContext) {
  const params = [ctx.start, ctx.end, ctx.stores.map((s) => s.id), ctx.timezone];
  const [lines, orders] = await Promise.all([
    db.query<{
      day: string;
      store_id: number;
      units: number;
      revenue: number;
      cost: number | null;
      revenue_with_cost: number | null;
    }>(
      `SELECT (l.processed_at AT TIME ZONE $4)::date AS day, l.store_id,
              sum(l.current_quantity)::int AS units, sum(l.net) AS revenue,
              sum(l.unit_cost * l.current_quantity) AS cost,
              sum(l.net) FILTER (WHERE l.unit_cost IS NOT NULL) AS revenue_with_cost
         FROM sales_lines l JOIN sales_orders o ON o.id = l.order_id
        WHERE ${COUNTED}
        GROUP BY 1, 2`,
      params,
    ),
    // Counted on their own (not as distinct orders of the lines above): far cheaper over a long
    // period. An order of only gift cards counts as an order, as in Shopify.
    db.query<{ day: string; store_id: number; orders: number }>(
      `SELECT (o.processed_at AT TIME ZONE $4)::date AS day, o.store_id, count(*)::int AS orders
         FROM sales_orders o
        WHERE o.processed_at >= $1 AND o.processed_at < $2 AND o.store_id = ANY($3::bigint[])
          AND NOT o.test AND o.cancelled_at IS NULL AND o.deleted_at IS NULL
        GROUP BY 1, 2`,
      params,
    ),
  ]);

  const byStore = new Map(
    ctx.stores.map((s) => [s.id, { orders: 0, units: 0, revenue: 0, cost: 0, revenueWithCost: 0 }]),
  );
  const daily = new Map(datesBetween(ctx.from, ctx.to).map((d) => [d, new Map<number, number>()]));
  const rate = new Map(ctx.stores.map((s) => [s.id, s.exchangeRate]));
  for (const r of orders.rows) byStore.get(r.store_id)!.orders += r.orders;
  for (const r of lines.rows) {
    const sums = byStore.get(r.store_id)!;
    sums.units += r.units;
    sums.revenue += r.revenue;
    sums.cost += r.cost ?? 0;
    sums.revenueWithCost += r.revenue_with_cost ?? 0;
    const day = daily.get(r.day);
    if (day) day.set(r.store_id, (day.get(r.store_id) ?? 0) + r.revenue / rate.get(r.store_id)!);
  }

  const stores = ctx.stores.map((s) => {
    const sums = byStore.get(s.id)!;
    const revenueBase = sums.revenue / s.exchangeRate;
    const withCostBase = sums.revenueWithCost / s.exchangeRate;
    return {
      storeId: s.id,
      name: s.name,
      currencyCode: s.currencyCode,
      exchangeRate: s.exchangeRate,
      orders: sums.orders,
      units: sums.units,
      revenue: money(sums.revenue),
      revenueBase: money(revenueBase),
      cost: money(sums.cost),
      margin: marginOf(withCostBase, sums.cost),
      revenueWithoutCost: money(revenueBase - withCostBase),
      withCostBase,
    };
  });
  const sum = (pick: (s: (typeof stores)[number]) => number) =>
    stores.reduce((total, s) => total + pick(s), 0);
  const revenue = sum((s) => s.revenue / s.exchangeRate);
  const withCost = sum((s) => s.withCostBase);
  const cost = sum((s) => s.cost);

  return {
    baseCurrency: ctx.baseCurrency,
    timezone: ctx.timezone,
    from: ctx.from,
    to: ctx.to,
    totals: {
      orders: sum((s) => s.orders),
      units: sum((s) => s.units),
      revenue: money(revenue),
      cost: money(cost),
      margin: marginOf(withCost, cost),
      revenueWithoutCost: money(revenue - withCost),
    },
    byStore: stores.map(({ withCostBase: _w, ...s }) => s),
    daily: [...daily].map(([date, perStore]) => ({
      date,
      revenue: money([...perStore.values()].reduce((a, b) => a + b, 0)),
      byStore: Object.fromEntries([...perStore].map(([id, v]) => [id, money(v)])),
    })),
  };
}

// ---- coverage -------------------------------------------------------------------------------

export type SalesPermission = 'granted' | 'missing' | 'unknown';

export interface StoreCoverage {
  storeId: number;
  name: string;
  /** The store's own status (active, paused, error, disconnected). */
  storeStatus: string;
  currencyCode: string | null;
  permission: SalesPermission;
  missingScopes: string[];
  /** read_all_orders granted: history isn't limited to Shopify's 60 days. */
  allOrders: boolean;
  backfill: {
    status: 'none' | 'running' | 'done' | 'failed';
    startedAt: Date | null;
    finishedAt: Date | null;
    /** Orders and lines Shopify has exported so far (running) or in all (done). */
    objects: number | null;
    error: string | null;
  };
  /** First day of the history asked for, in the report's time zone. */
  historyFrom: string | null;
  /** The setting asked for more than Shopify gives without read_all_orders. */
  historyCapped: boolean;
  /** First day with an order we have, in the report's time zone. */
  firstOrderOn: string | null;
  /** Last time we checked Shopify for changed orders. */
  lastSyncedAt: Date | null;
  syncError: string | null;
}

/** How complete each store's sales history is (permission, import, last sync). */
export async function loadCoverage(
  db: Queryable,
  stores: ReportStore[],
  timezone: string,
): Promise<StoreCoverage[]> {
  if (!stores.length) return [];
  const { rows } = await db.query<{
    id: number;
    sales_backfill_status: StoreCoverage['backfill']['status'];
    sales_backfill_started_at: Date | null;
    sales_backfill_finished_at: Date | null;
    sales_backfill_objects: number | null;
    sales_backfill_error: string | null;
    history_from: string | null;
    sales_history_capped: boolean;
    first_order_on: string | null;
    orders_checked_at: Date | null;
    orders_sync_error: string | null;
  }>(
    `SELECT s.id, s.sales_backfill_status, s.sales_backfill_started_at,
            s.sales_backfill_finished_at, s.sales_backfill_objects, s.sales_backfill_error,
            (s.sales_history_from AT TIME ZONE $2)::date AS history_from, s.sales_history_capped,
            (f.first_at AT TIME ZONE $2)::date AS first_order_on, s.orders_checked_at,
            s.orders_sync_error
       FROM stores s
       CROSS JOIN LATERAL (SELECT min(processed_at) AS first_at FROM sales_orders
                            WHERE store_id = s.id AND deleted_at IS NULL) f
      WHERE s.id = ANY($1::bigint[])`,
    [stores.map((s) => s.id), timezone],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return stores.map((s) => {
    const r = byId.get(s.id)!;
    const missing = missingScopes(s.grantedScopes, ['read_orders']);
    return {
      storeId: s.id,
      name: s.name,
      storeStatus: s.status,
      currencyCode: s.currencyCode,
      permission: s.grantedScopes === null ? 'unknown' : missing.length ? 'missing' : 'granted',
      missingScopes: missing,
      allOrders: s.grantedScopes?.includes('read_all_orders') ?? false,
      backfill: {
        status: r.sales_backfill_status,
        startedAt: r.sales_backfill_started_at,
        finishedAt: r.sales_backfill_finished_at,
        objects: r.sales_backfill_objects,
        error: r.sales_backfill_error,
      },
      historyFrom: r.history_from,
      historyCapped: r.sales_history_capped,
      firstOrderOn: r.first_order_on,
      lastSyncedAt: r.orders_checked_at ?? r.sales_backfill_finished_at,
      syncError: r.orders_sync_error,
    };
  });
}

// ---- products -------------------------------------------------------------------------------

export interface ProductRow {
  /** null: sales of a SKU that isn't one of our products (or has no SKU). */
  itemId: number | null;
  sku: string | null;
  title: string;
  units: number;
  /** Base currency. */
  revenue: number;
  cost: number;
  margin: number | null;
  /** Shared stock now (every warehouse); null when the product hasn't started syncing. */
  stock: number | null;
  /** Units a day over the pace window (settings.reorderLookbackDays), every store. */
  velocity: number;
  daysLeft: number | null;
  sellThrough: number | null;
  byStore: { storeId: number; units: number; revenue: number; revenueBase: number }[];
}

/**
 * One row per product sold in the period (in the chosen stores) or in stock now, plus one per
 * SKU sold that isn't a product. Unsorted.
 */
export async function loadProductRows(
  db: Queryable,
  ctx: ReportContext,
  now: Date = new Date(),
): Promise<ProductRow[]> {
  const { rows: sold } = await db.query<{
    item_id: number | null;
    other_sku: string | null;
    store_id: number;
    units: number;
    revenue: number;
    cost: number | null;
    revenue_with_cost: number | null;
  }>(
    `SELECT l.item_id, CASE WHEN l.item_id IS NULL THEN l.sku END AS other_sku, l.store_id,
            sum(l.current_quantity)::int AS units, sum(l.net) AS revenue,
            sum(l.unit_cost * l.current_quantity) AS cost,
            sum(l.net) FILTER (WHERE l.unit_cost IS NOT NULL) AS revenue_with_cost
       FROM sales_lines l JOIN sales_orders o ON o.id = l.order_id
      WHERE ${COUNTED}
      GROUP BY 1, 2, 3`,
    [ctx.start, ctx.end, ctx.stores.map((s) => s.id)],
  );
  const soldItemIds = [...new Set(sold.flatMap((r) => (r.item_id === null ? [] : [r.item_id])))];
  const lookback = ctx.settings.reorderLookbackDays;
  const [items, recent, first] = await Promise.all([
    db.query<{ id: number; sku: string; title: string; created_at: Date; stock: number | null }>(
      `SELECT i.id, i.sku, i.title, i.created_at, sum(pl.quantity)::int AS stock
         FROM items i LEFT JOIN pool_levels pl ON pl.item_id = i.id
        GROUP BY i.id
       HAVING i.id = ANY($1::bigint[]) OR sum(pl.quantity) > 0`,
      [soldItemIds],
    ),
    recentUnits(db, ctx, now),
    firstOrderAt(db),
  ]);

  const rate = new Map(ctx.allStores.map((s) => [s.id, s.exchangeRate]));
  interface Acc {
    itemId: number | null;
    sku: string | null;
    title: string;
    stock: number | null;
    createdAt: Date | null;
    units: number;
    revenue: number;
    cost: number;
    revenueWithCost: number;
    byStore: ProductRow['byStore'];
  }
  const acc = new Map<string, Acc>();
  for (const i of items.rows) {
    acc.set(`i${i.id}`, {
      itemId: i.id,
      sku: i.sku,
      title: i.title,
      stock: i.stock,
      createdAt: i.created_at,
      units: 0,
      revenue: 0,
      cost: 0,
      revenueWithCost: 0,
      byStore: [],
    });
  }
  for (const r of sold) {
    const key = r.item_id === null ? `s${r.other_sku ?? ''}` : `i${r.item_id}`;
    let row = acc.get(key);
    if (!row) {
      // A product deleted meanwhile has no item row: shown like a SKU that isn't a product.
      row = {
        itemId: null,
        sku: r.other_sku,
        title: '',
        stock: null,
        createdAt: null,
        units: 0,
        revenue: 0,
        cost: 0,
        revenueWithCost: 0,
        byStore: [],
      };
      acc.set(key, row);
    }
    const storeRate = rate.get(r.store_id) ?? 1;
    const revenueBase = r.revenue / storeRate;
    row.units += r.units;
    row.revenue += revenueBase;
    row.cost += r.cost ?? 0;
    row.revenueWithCost += (r.revenue_with_cost ?? 0) / storeRate;
    row.byStore.push({
      storeId: r.store_id,
      units: r.units,
      revenue: money(r.revenue),
      revenueBase: money(revenueBase),
    });
  }

  return [...acc.values()].map((a) => {
    const figures = productFigures({
      units: a.units,
      revenue: a.revenue,
      cost: a.cost,
      revenueWithCost: a.revenueWithCost,
      stock: a.stock,
      recentUnits: a.itemId === null ? 0 : (recent.get(a.itemId) ?? 0),
      paceDays: paceDays(now, lookback, a.createdAt, first),
    });
    return {
      itemId: a.itemId,
      sku: a.sku,
      title: a.title,
      units: a.units,
      revenue: money(a.revenue),
      cost: money(a.cost),
      margin: fraction(figures.margin),
      stock: a.stock,
      velocity: Math.round(figures.velocity * 100) / 100,
      daysLeft: figures.daysLeft === null ? null : Math.round(figures.daysLeft * 10) / 10,
      sellThrough: fraction(figures.sellThrough),
      byStore: a.byStore.sort((x, y) => x.storeId - y.storeId),
    };
  });
}

/** Units sold per item over the last `days`, every store (the pace). */
async function recentUnits(
  db: Queryable,
  ctx: ReportContext,
  now: Date,
  itemId?: number,
): Promise<Map<number, number>> {
  // Every store: the pace is the product's, whatever stores the report shows.
  const params: unknown[] = [
    new Date(now.getTime() - ctx.settings.reorderLookbackDays * DAY_MS),
    now,
    ctx.allStores.map((s) => s.id),
  ];
  const { rows } = await db.query<{ item_id: number; units: number }>(
    itemId === undefined
      ? `SELECT l.item_id, sum(l.current_quantity)::int AS units
           FROM sales_lines l JOIN sales_orders o ON o.id = l.order_id
          WHERE l.item_id IS NOT NULL AND ${COUNTED}
          GROUP BY l.item_id`
      : `SELECT l.item_id, sum(l.current_quantity)::int AS units
           FROM sales_lines l JOIN sales_orders o ON o.id = l.order_id
          WHERE l.item_id = $4 AND ${COUNTED}
          GROUP BY l.item_id`,
    itemId === undefined ? params : [...params, itemId],
  );
  return new Map(rows.map((r) => [r.item_id, r.units]));
}

/** The oldest order we have of any store (where the history starts). */
async function firstOrderAt(db: Queryable): Promise<Date | null> {
  // Per store, so each lookup is one step down the (store_id, processed_at) index.
  const { rows } = await db.query<{ first_at: Date | null }>(
    `SELECT min(f.first_at) AS first_at FROM stores s
       CROSS JOIN LATERAL (SELECT min(processed_at) AS first_at FROM sales_orders
                            WHERE store_id = s.id AND deleted_at IS NULL) f`,
  );
  return rows[0]?.first_at ?? null;
}

// ---- one product ------------------------------------------------------------------------------

/** One product's sales per store and per day (the product page), or null if it doesn't exist. */
export async function loadItemReport(
  db: Queryable,
  ctx: ReportContext,
  itemId: number,
  now: Date = new Date(),
) {
  const { rows: found } = await db.query<{
    sku: string;
    title: string;
    created_at: Date;
    stock: number | null;
  }>(
    `SELECT i.sku, i.title, i.created_at,
            (SELECT sum(quantity)::int FROM pool_levels WHERE item_id = i.id) AS stock
       FROM items i WHERE i.id = $1`,
    [itemId],
  );
  const item = found[0];
  if (!item) return null;
  const { rows } = await db.query<{
    day: string;
    store_id: number;
    orders: number;
    units: number;
    revenue: number;
  }>(
    `SELECT (l.processed_at AT TIME ZONE $5)::date AS day, l.store_id,
            count(DISTINCT l.order_id)::int AS orders, sum(l.current_quantity)::int AS units,
            sum(l.net) AS revenue
       FROM sales_lines l JOIN sales_orders o ON o.id = l.order_id
      WHERE l.item_id = $4 AND ${COUNTED}
      GROUP BY 1, 2`,
    [ctx.start, ctx.end, ctx.stores.map((s) => s.id), itemId, ctx.timezone],
  );
  const lookback = ctx.settings.reorderLookbackDays;
  const [recent, first] = await Promise.all([recentUnits(db, ctx, now, itemId), firstOrderAt(db)]);
  const figures = productFigures({
    units: 0,
    revenue: 0,
    cost: 0,
    revenueWithCost: 0,
    stock: item.stock,
    recentUnits: recent.get(itemId) ?? 0,
    paceDays: paceDays(now, lookback, item.created_at, first),
  });

  const perStore = new Map(ctx.stores.map((s) => [s.id, { orders: 0, units: 0, revenue: 0 }]));
  const daily = new Map(datesBetween(ctx.from, ctx.to).map((d) => [d, new Map<number, number>()]));
  for (const r of rows) {
    const sums = perStore.get(r.store_id)!;
    sums.orders += r.orders;
    sums.units += r.units;
    sums.revenue += r.revenue;
    daily.get(r.day)?.set(r.store_id, r.units);
  }
  const stores = ctx.stores.map((s) => {
    const sums = perStore.get(s.id)!;
    return {
      storeId: s.id,
      name: s.name,
      currencyCode: s.currencyCode,
      orders: sums.orders,
      units: sums.units,
      revenue: money(sums.revenue),
      revenueBase: money(sums.revenue / s.exchangeRate),
    };
  });
  return {
    itemId,
    sku: item.sku,
    title: item.title,
    baseCurrency: ctx.baseCurrency,
    timezone: ctx.timezone,
    from: ctx.from,
    to: ctx.to,
    lookbackDays: lookback,
    stores,
    totals: {
      orders: stores.reduce((n, s) => n + s.orders, 0),
      units: stores.reduce((n, s) => n + s.units, 0),
      revenue: money(stores.reduce((n, s) => n + s.revenueBase, 0)),
    },
    daily: [...daily].map(([date, units]) => ({ date, byStore: Object.fromEntries(units) })),
    stock: item.stock,
    velocity: Math.round(figures.velocity * 100) / 100,
    daysLeft: figures.daysLeft === null ? null : Math.round(figures.daysLeft * 10) / 10,
  };
}
