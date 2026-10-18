import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toCsv } from '../../sales/csv.js';
import { PRODUCT_SORTS, sortRows } from '../../sales/metrics.js';
import { isDate } from '../../sales/period.js';
import {
  loadCoverage,
  loadItemReport,
  loadProductRows,
  loadSummary,
  reportContext,
  type ProductRow,
  type ReportContext,
} from '../../sales/reports.js';
import { requireFeature } from '../../shopify/scopes.js';
import { enqueueTask } from '../../tasks/queue.js';
import { currencyDecimals, roundMoney } from '../../util/money.js';
import { conflict, notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';

/** Query values the dashboard leaves empty ('') count as not given. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const DateParam = z.string().refine(isDate, 'Use a date like 2026-10-17');

const PeriodQuery = z.object({
  from: optional(DateParam),
  to: optional(DateParam),
  storeIds: optional(
    z
      .string()
      .regex(/^\d{1,15}(,\d{1,15})*$/, 'Use store ids separated by commas')
      .transform((v) => v.split(',').map(Number)),
  ),
});

const ProductsQuery = PeriodQuery.extend({
  search: optional(z.string().trim().max(200)),
  sort: z.enum(PRODUCT_SORTS).default('revenue'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Reports: /api/reports/... (sales of every store, from the orders Store Sync reads). */
export async function registerReportRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get('/api/reports/summary', async (request) => {
    const ctx = await reportContext(db, PeriodQuery.parse(request.query));
    const [summary, coverage] = await Promise.all([
      loadSummary(db, ctx),
      loadCoverage(db, ctx.stores, ctx.timezone),
    ]);
    return { ...summary, coverage: { stores: coverage } };
  });

  app.get('/api/reports/products', async (request) => {
    const q = ProductsQuery.parse(request.query);
    const ctx = await reportContext(db, q);
    const rows = sortRows(filterRows(await loadProductRows(db, ctx), q.search), q.sort, q.dir);
    const start = (q.page - 1) * q.pageSize;
    return {
      baseCurrency: ctx.baseCurrency,
      timezone: ctx.timezone,
      from: ctx.from,
      to: ctx.to,
      lookbackDays: ctx.settings.reorderLookbackDays,
      stores: ctx.stores.map((s) => ({
        storeId: s.id,
        name: s.name,
        currencyCode: s.currencyCode,
      })),
      total: rows.length,
      page: q.page,
      pageSize: q.pageSize,
      products: rows.slice(start, start + q.pageSize),
    };
  });

  app.get('/api/reports/products.csv', async (request, reply) => {
    const q = ProductsQuery.parse(request.query);
    const ctx = await reportContext(db, q);
    const rows = sortRows(filterRows(await loadProductRows(db, ctx), q.search), q.sort, q.dir);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="sales-by-product-${ctx.from}-to-${ctx.to}.csv"`,
      )
      .header('Cache-Control', 'no-store')
      .send(productsCsv(ctx, rows));
  });

  app.get('/api/reports/items/:itemId', async (request) => {
    const itemId = parseId((request.params as { itemId: string }).itemId, 'product id');
    const ctx = await reportContext(db, PeriodQuery.parse(request.query));
    const report = await loadItemReport(db, ctx, itemId);
    if (!report) throw notFound('Product');
    const coverage = await loadCoverage(db, ctx.stores, ctx.timezone);
    return {
      ...report,
      // How many stores' sales are read at all (none: the page explains how to turn it on).
      readingStores: coverage.filter((c) => c.permission !== 'missing').length,
    };
  });

  app.get('/api/reports/status', async () => {
    const ctx = await reportContext(db, {});
    return {
      baseCurrency: ctx.baseCurrency,
      timezone: ctx.timezone,
      salesHistoryDays: ctx.settings.salesHistoryDays,
      stores: await loadCoverage(db, ctx.allStores, ctx.timezone),
    };
  });

  // Imports the store's order history again (e.g. after read_all_orders was granted, or after a
  // failed import). Orders already saved stay; the import updates them.
  app.post('/api/reports/stores/:id/resync', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const { rows } = await db.query<{ name: string }>('SELECT name FROM stores WHERE id = $1', [
      id,
    ]);
    const store = rows[0];
    if (!store) throw notFound('Store');
    await requireFeature(db, id, 'sales');
    const { rowCount } = await db.query(
      `UPDATE stores
          SET sales_backfill_status = 'none', sales_backfill_operation_id = NULL,
              sales_backfill_error = NULL, sales_backfill_finished_at = NULL,
              sales_backfill_objects = NULL
        WHERE id = $1 AND sales_backfill_status <> 'running'`,
      [id],
    );
    if (!rowCount) {
      throw conflict(`The order history of “${store.name}” is being imported already.`);
    }
    await enqueueTask(db, 'sales_backfill', { storeId: id });
    deps.onWork?.();
    request.log.info({ storeId: id }, 'sales history import restarted');
    return reply.code(202).send({ queued: true });
  });
}

function filterRows(rows: ProductRow[], search: string | undefined): ProductRow[] {
  if (!search) return rows;
  const needle = search.toLowerCase();
  return rows.filter(
    (r) => r.sku?.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle),
  );
}

/** Every row of the products report, money in each currency's own decimals. */
function productsCsv(ctx: ReportContext, rows: ProductRow[]): string {
  const base = ctx.baseCurrency;
  const inCurrency = (value: number, code: string | null) =>
    roundMoney(value, currencyDecimals(code ?? base));
  const percent = (value: number | null) => (value === null ? null : Math.round(value * 1000) / 10);
  const header = [
    'SKU',
    'Product',
    ...ctx.stores.flatMap((s) => [
      `${s.name}: units`,
      `${s.name}: revenue (${s.currencyCode ?? base})`,
    ]),
    'Units',
    `Revenue (${base})`,
    `Cost (${base})`,
    'Margin (%)',
    'Shared stock',
    'Units a day',
    'Days of stock left',
    'Sell-through (%)',
  ];
  const body = rows.map((r) => {
    const byStore = new Map(r.byStore.map((s) => [s.storeId, s]));
    return [
      r.sku,
      r.itemId === null ? 'Not one of your products' : r.title,
      ...ctx.stores.flatMap((s) => {
        const sold = byStore.get(s.id);
        return [sold?.units ?? 0, inCurrency(sold?.revenue ?? 0, s.currencyCode)];
      }),
      r.units,
      inCurrency(r.revenue, base),
      inCurrency(r.cost, base),
      percent(r.margin),
      r.stock,
      r.velocity,
      r.daysLeft,
      percent(r.sellThrough),
    ];
  });
  return toCsv([header, ...body]);
}
