import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { bulkValue } from '../../pricing/bulk.js';
import type { PriceRule } from '../../pricing/compute.js';
import { DEFAULT_PRICE_RULE, computeTargetPrice } from '../../pricing/compute.js';
import { PricingError } from '../../pricing/errors.js';
import type { PriceCell, PricingItem, PricingStore } from '../../pricing/prices.js';
import {
  byCell,
  cellKey,
  loadOverrides,
  loadPriceRows,
  loadPricingItems,
  loadPricingStores,
  loadStoreVariants,
  matchingItemIds,
  priceCell,
} from '../../pricing/prices.js';
import {
  RUN_CREATE_LOCK,
  busyStores,
  createPriceRun,
  loadRuns,
  storeUnavailableMessage,
} from '../../pricing/runs.js';
import type { ScheduleInput } from '../../pricing/schedules.js';
import {
  cancelSchedule,
  createSchedule,
  loadSchedules,
  updateSchedule,
} from '../../pricing/schedules.js';
import { getSettings } from '../../settings.js';
import { currencyDecimals, roundMoney } from '../../util/money.js';
import { badRequest, conflict, notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';

/** An amount of money: at most 4 decimals are kept (numeric(18,4)). */
const Money = z.number().min(0).max(1_000_000_000_000);
const Id = z.number().int().positive();
/** "1,2,3" in a query string. */
const IdList = z
  .string()
  .trim()
  .regex(/^\d+(,\d+)*$/, 'Use a comma-separated list of ids')
  .transform((v) => [...new Set(v.split(',').map(Number))]);

const FILTERS = ['all', 'changes', 'missing_base', 'overrides'] as const;

const ListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  filter: z.enum(FILTERS).default('all'),
  storeId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const ItemPricesBody = z.object({
  basePrice: Money.nullable().optional(),
  baseCompareAtPrice: Money.nullable().optional(),
  cost: Money.nullable().optional(),
});

const BulkRoundingBody = z
  .object({
    mode: z.enum(['ending', 'multiple']),
    step: z.number().min(0.0001).max(1_000_000_000),
    ending: z.number().min(0).max(1_000_000_000).default(0),
    direction: z.enum(['up', 'nearest', 'down']).default('nearest'),
  })
  .superRefine((r, ctx) => {
    if (r.mode === 'ending' && r.ending >= r.step) {
      ctx.addIssue({
        code: 'custom',
        path: ['ending'],
        message: 'The ending must be smaller than the step',
      });
    }
  });

const BulkBody = z
  .object({
    itemIds: z.array(Id).min(1).max(20_000).optional(),
    filter: z
      .object({
        search: z.string().trim().max(200).optional(),
        filter: z.enum(FILTERS).default('all'),
        storeId: Id.optional(),
      })
      .optional(),
    op: z.enum(['set', 'percent', 'add', 'round']),
    field: z.enum(['basePrice', 'baseCompareAtPrice', 'cost']),
    value: z.number().min(-1_000_000_000_000).max(1_000_000_000_000).nullable().optional(),
    rounding: BulkRoundingBody.nullable().optional(),
  })
  .superRefine((b, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (!b.itemIds === !b.filter) issue('itemIds', 'Send either itemIds or filter');
    if (b.op === 'set' && b.value === undefined) issue('value', 'Enter the new value');
    if (b.op === 'set' && typeof b.value === 'number' && b.value < 0)
      issue('value', 'A price or cost can’t be negative');
    if ((b.op === 'percent' || b.op === 'add') && typeof b.value !== 'number')
      issue('value', 'Enter the change');
    if (b.op === 'percent' && typeof b.value === 'number' && b.value <= -100)
      issue('value', 'A decrease must be less than 100%');
    if (b.op === 'round' && !b.rounding) issue('rounding', 'Choose how to round');
  });

const BaseFromStoreBody = z.object({ storeId: Id, onlyMissing: z.boolean().default(true) });

const RuleBody = z
  .object({
    enabled: z.boolean(),
    multiplier: z.number().min(0.000001).max(1000),
    addAmount: z.number().min(-1_000_000_000).max(1_000_000_000),
    roundMode: z.enum(['none', 'ending', 'multiple']),
    roundStep: z.number().min(0.0001).max(1_000_000_000),
    roundEnding: z.number().min(0).max(1_000_000_000),
    roundDirection: z.enum(['up', 'nearest', 'down']),
    compareAtMode: z.enum(['none', 'keep', 'from_base', 'markup']),
    compareAtMarkup: z.number().min(1).max(100),
  })
  .superRefine((r, ctx) => {
    if (r.roundMode === 'ending' && r.roundEnding >= r.roundStep) {
      ctx.addIssue({
        code: 'custom',
        path: ['roundEnding'],
        message:
          'The ending must be smaller than the step (for prices ending in .90 with a step of 1, use 0.90)',
      });
    }
  });

const ExamplesQuery = z.object({
  prices: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?(,\d+(\.\d+)?)*$/, 'Use a comma-separated list of prices')
    .transform((v) => v.split(',').map(Number).slice(0, 20))
    .optional(),
});

const OverrideBody = z.object({
  price: Money,
  compareAtPrice: Money.nullable().default(null),
  note: z.string().trim().max(500).nullable().optional(),
});

const PreviewQuery = z.object({ storeIds: IdList.optional(), itemIds: IdList.optional() });

const ApplyBody = z.object({
  storeIds: z.array(Id).min(1).max(100).optional(),
  itemIds: z.array(Id).min(1).max(20_000).optional(),
});

const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

const DateTime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const Name = z.string().trim().min(1).max(100);
const Percent = z
  .number()
  .min(1)
  .max(99)
  .transform((v) => Math.round(v * 100) / 100);
const Change = z.object({
  itemId: Id,
  basePrice: Money,
  baseCompareAtPrice: Money.nullable().default(null),
});

const SaleBody = z.object({
  kind: z.literal('sale'),
  name: Name,
  startsAt: DateTime,
  endsAt: DateTime,
  storeIds: z.array(Id).min(1).max(100).nullable().default(null),
  itemIds: z.array(Id).min(1).max(5000),
  percentOff: Percent,
  showCompareAt: z.boolean().default(true),
});
const BaseChangeBody = z.object({
  kind: z.literal('base_change'),
  name: Name,
  startsAt: DateTime,
  changes: z.array(Change).min(1).max(5000),
});
const ScheduleBody = z.discriminatedUnion('kind', [SaleBody, BaseChangeBody]);
/** Any field of either kind; merged into the schedule as it is, then checked as a whole. */
const SchedulePatch = z.object({
  name: Name.optional(),
  startsAt: DateTime.optional(),
  endsAt: DateTime.optional(),
  storeIds: z.array(Id).min(1).max(100).nullable().optional(),
  itemIds: z.array(Id).min(1).max(5000).optional(),
  percentOff: Percent.optional(),
  showCompareAt: z.boolean().optional(),
  changes: z.array(Change).min(1).max(5000).optional(),
});

function storeView(s: PricingStore) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    currencyCode: s.currencyCode,
    currencyKnown: s.currencyKnown,
    exchangeRate: s.exchangeRate,
    ruleEnabled: s.rule?.enabled ?? false,
    /** Store Sync may write this store's prices (write_products, as far as we know). */
    canUpdate: s.pricingMissingScopes.length === 0,
    missingScopes: s.pricingMissingScopes,
  };
}

function itemView(item: PricingItem, cells: PriceCell[]) {
  return {
    itemId: item.id,
    sku: item.sku,
    title: item.title,
    basePrice: item.basePrice,
    baseCompareAtPrice: item.baseCompareAtPrice,
    cost: item.cost,
    stores: cells,
  };
}

async function loadItemView(db: Queryable, stores: PricingStore[], itemId: number) {
  const [row] = await loadPriceRows(db, stores, [itemId]);
  if (!row) throw notFound('Item');
  return itemView(row.item, row.cells);
}

async function storesFor(db: Queryable, storeIds?: number[]) {
  const settings = await getSettings(db);
  return {
    baseCurrency: settings.baseCurrency,
    stores: await loadPricingStores(db, settings.baseCurrency, storeIds),
  };
}

/** The rule as the API shows it (the column defaults when the store has none yet). */
function ruleView(store: PricingStore) {
  return {
    storeId: store.id,
    storeName: store.name,
    status: store.status,
    currencyCode: store.currencyCode,
    currencyKnown: store.currencyKnown,
    exchangeRate: store.exchangeRate,
    canUpdate: store.pricingMissingScopes.length === 0,
    missingScopes: store.pricingMissingScopes,
    saved: store.rule !== null,
    updatedAt: store.ruleUpdatedAt,
    rule: store.rule ?? DEFAULT_PRICE_RULE,
  };
}

const COMPARE_AT_ABOVE =
  'The compare-at price must be higher than the price (it’s shown crossed out). Leave it empty for none.';

/** Prices: /api/prices/... */
export async function registerPriceRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  // ---- the price list ----------------------------------------------------------------------

  app.get('/api/prices', async (request) => {
    const q = ListQuery.parse(request.query);
    const { baseCurrency, stores } = await storesFor(db);
    if (q.storeId !== undefined && !stores.some((s) => s.id === q.storeId)) {
      throw notFound('Store');
    }
    const shown = q.storeId === undefined ? stores : stores.filter((s) => s.id === q.storeId);
    const ids = await matchingItemIds(db, stores, q);
    const page = ids.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const [rows, runs, active] = await Promise.all([
      loadPriceRows(db, shown, page),
      loadRuns(db, { limit: 1 }),
      db.query<{ id: number }>(
        `SELECT id FROM price_runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`,
      ),
    ]);
    const last = runs[0];
    return {
      total: ids.length,
      page: q.page,
      pageSize: q.pageSize,
      baseCurrency,
      stores: shown.map(storeView),
      items: rows.map((r) => itemView(r.item, r.cells)),
      lastRun: last
        ? {
            id: last.id,
            status: last.status,
            createdAt: last.createdAt,
            finishedAt: last.finishedAt,
          }
        : null,
      activeRunId: active.rows[0]?.id ?? null,
    };
  });

  // ---- one item -----------------------------------------------------------------------------

  app.get('/api/prices/items/:itemId', async (request) => {
    const itemId = parseId((request.params as { itemId: string }).itemId, 'item id');
    const { baseCurrency, stores } = await storesFor(db);
    const item = await loadItemView(db, stores, itemId);
    const schedules = await db.query<{
      id: number;
      name: string;
      kind: string;
      status: string;
      starts_at: Date;
      ends_at: Date | null;
      percent_off: number | null;
      store_ids: number[] | null;
    }>(
      `SELECT id, name, kind, status, starts_at, ends_at, percent_off, store_ids
         FROM price_schedules
        WHERE status IN ('scheduled', 'active') AND $1 = ANY(item_ids)
        ORDER BY starts_at`,
      [itemId],
    );
    return {
      baseCurrency,
      stores: stores.map(storeView),
      item,
      schedules: schedules.rows.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        status: s.status,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        percentOff: s.percent_off,
        storeIds: s.store_ids,
      })),
    };
  });

  app.patch('/api/prices/items/:itemId', async (request) => {
    const itemId = parseId((request.params as { itemId: string }).itemId, 'item id');
    const body = ItemPricesBody.parse(request.body);
    await withTransaction(db, async (client) => {
      const { rows } = await client.query<{
        base_price: number | null;
        base_compare_at_price: number | null;
      }>('SELECT base_price, base_compare_at_price FROM items WHERE id = $1 FOR UPDATE', [itemId]);
      if (!rows[0]) throw notFound('Item');
      const price = body.basePrice !== undefined ? body.basePrice : rows[0].base_price;
      const compareAt =
        body.baseCompareAtPrice !== undefined
          ? body.baseCompareAtPrice
          : rows[0].base_compare_at_price;
      const touched = body.basePrice !== undefined || body.baseCompareAtPrice !== undefined;
      if (touched && compareAt !== null && (price === null || compareAt <= price)) {
        throw badRequest(COMPARE_AT_ABOVE);
      }
      await client.query(
        `UPDATE items
            SET base_price = CASE WHEN $2::boolean THEN $3::numeric ELSE base_price END,
                base_compare_at_price =
                  CASE WHEN $4::boolean THEN $5::numeric ELSE base_compare_at_price END,
                cost = CASE WHEN $6::boolean THEN $7::numeric ELSE cost END,
                cost_updated_at = CASE WHEN $6::boolean THEN now() ELSE cost_updated_at END,
                updated_at = now()
          WHERE id = $1`,
        [
          itemId,
          body.basePrice !== undefined,
          body.basePrice ?? null,
          body.baseCompareAtPrice !== undefined,
          body.baseCompareAtPrice ?? null,
          body.cost !== undefined,
          body.cost ?? null,
        ],
      );
    });
    const { stores } = await storesFor(db);
    return loadItemView(db, stores, itemId);
  });

  app.post('/api/prices/items/bulk', async (request) => {
    const body = BulkBody.parse(request.body);
    const { baseCurrency, stores } = await storesFor(db);
    const itemIds = body.itemIds ?? (await matchingItemIds(db, stores, body.filter!));
    const column = {
      basePrice: 'base_price',
      baseCompareAtPrice: 'base_compare_at_price',
      cost: 'cost',
    }[body.field];
    return withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: number; sku: string; value: number | null }>(
        `SELECT id, sku, ${column} AS value FROM items WHERE id = ANY($1::bigint[])
          ORDER BY id FOR UPDATE`,
        [itemIds],
      );
      const changes: { id: number; value: number | null }[] = [];
      const negative: string[] = [];
      let skipped = 0;
      for (const row of rows) {
        const next = bulkValue(
          row.value,
          { op: body.op, value: body.value ?? null, rounding: body.rounding ?? null },
          baseCurrency,
        );
        if (next === undefined) skipped++;
        else if (next !== null && next < 0) negative.push(row.sku);
        else if (next !== row.value) changes.push({ id: row.id, value: next });
      }
      if (negative.length > 0) {
        const more = negative.length > 5 ? ` and ${negative.length - 5} more` : '';
        throw badRequest(
          `This would make the ${body.field === 'cost' ? 'cost' : 'price'} negative for ` +
            `${negative.slice(0, 5).join(', ')}${more}. Nothing was changed.`,
        );
      }
      if (changes.length > 0) {
        await client.query(
          `UPDATE items i SET ${column} = t.value, updated_at = now()
                  ${body.field === 'cost' ? ', cost_updated_at = now()' : ''}
             FROM unnest($1::bigint[], $2::numeric[]) AS t(id, value)
            WHERE i.id = t.id`,
          [changes.map((c) => c.id), changes.map((c) => c.value)],
        );
      }
      return {
        updated: changes.length,
        skipped,
        unchanged: rows.length - changes.length - skipped,
      };
    });
  });

  app.post('/api/prices/base-from-store', async (request) => {
    const body = BaseFromStoreBody.parse(request.body);
    const { baseCurrency, stores } = await storesFor(db, [body.storeId]);
    const store = stores[0];
    if (!store) throw notFound('Store');
    if (!store.currencyKnown) {
      throw conflict(
        `We don’t know “${store.name}”’s currency yet. Click “Test connection” on its page first.`,
      );
    }
    const decimals = currencyDecimals(baseCurrency);
    const toBase = (amount: number) => roundMoney(amount / store.exchangeRate, decimals);
    return withTransaction(db, async (client) => {
      const { rows } = await client.query<{
        item_id: number;
        price: number | null;
        compare_at_price: number | null;
      }>(
        `SELECT v.item_id, v.price, v.compare_at_price
           FROM variants v JOIN items i ON i.id = v.item_id
          WHERE v.store_id = $1 AND v.deleted_at IS NULL AND NOT v.is_bundle
            AND (NOT $2::boolean OR i.base_price IS NULL)
          ORDER BY v.item_id FOR UPDATE OF i`,
        [store.id, body.onlyMissing],
      );
      const known = rows.filter((r) => r.price !== null);
      if (known.length > 0) {
        await client.query(
          `UPDATE items i SET base_price = t.price, base_compare_at_price = t.compare_at,
                  updated_at = now()
             FROM unnest($1::bigint[], $2::numeric[], $3::numeric[]) AS t(id, price, compare_at)
            WHERE i.id = t.id`,
          [
            known.map((r) => r.item_id),
            known.map((r) => toBase(r.price!)),
            known.map((r) =>
              r.compare_at_price !== null && r.compare_at_price > r.price!
                ? toBase(r.compare_at_price)
                : null,
            ),
          ],
        );
      }
      return { updated: known.length, skipped: rows.length - known.length };
    });
  });

  // ---- rules --------------------------------------------------------------------------------

  /** A few items with different base prices (cheap, middle, dear), for the rules' examples. */
  const samples = async () => {
    const { rows } = await db.query<{
      id: number;
      sku: string;
      title: string;
      base_price: number;
      base_compare_at_price: number | null;
    }>(
      `SELECT DISTINCT ON (base_price) id, sku, title, base_price, base_compare_at_price
         FROM items WHERE base_price IS NOT NULL ORDER BY base_price, sku LIMIT 50`,
    );
    if (rows.length === 0) return [];
    const picked = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])]
      .filter((i) => i >= 0)
      .map((i) => rows[i]!);
    return picked.map((r) => ({
      itemId: r.id,
      sku: r.sku,
      title: r.title,
      basePrice: r.base_price,
      baseCompareAtPrice: r.base_compare_at_price,
    }));
  };

  app.get('/api/prices/rules', async () => {
    const { baseCurrency, stores } = await storesFor(db);
    return { baseCurrency, samples: await samples(), rules: stores.map(ruleView) };
  });

  app.get('/api/prices/rules/:storeId', async (request) => {
    const storeId = parseId((request.params as { storeId: string }).storeId, 'store id');
    const { baseCurrency, stores } = await storesFor(db, [storeId]);
    if (!stores[0]) throw notFound('Store');
    return { baseCurrency, samples: await samples(), ...ruleView(stores[0]) };
  });

  app.put('/api/prices/rules/:storeId', async (request) => {
    const storeId = parseId((request.params as { storeId: string }).storeId, 'store id');
    const body = RuleBody.parse(request.body);
    // The table wants the ending below the step whatever the mode: unused, it is simply 0.
    const ending =
      body.roundMode === 'ending' || body.roundEnding < body.roundStep ? body.roundEnding : 0;
    const { rowCount } = await db.query(
      `INSERT INTO price_rules (store_id, enabled, multiplier, add_amount, round_mode, round_step,
                                round_ending, round_direction, compare_at_mode, compare_at_markup)
       SELECT id, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM stores WHERE id = $1
       ON CONFLICT (store_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, multiplier = EXCLUDED.multiplier,
             add_amount = EXCLUDED.add_amount, round_mode = EXCLUDED.round_mode,
             round_step = EXCLUDED.round_step, round_ending = EXCLUDED.round_ending,
             round_direction = EXCLUDED.round_direction, compare_at_mode = EXCLUDED.compare_at_mode,
             compare_at_markup = EXCLUDED.compare_at_markup, updated_at = now()`,
      [
        storeId,
        body.enabled,
        body.multiplier,
        body.addAmount,
        body.roundMode,
        body.roundStep,
        ending,
        body.roundDirection,
        body.compareAtMode,
        body.compareAtMarkup,
      ],
    );
    if (!rowCount) throw notFound('Store');
    const { baseCurrency, stores } = await storesFor(db, [storeId]);
    return { baseCurrency, samples: await samples(), ...ruleView(stores[0]!) };
  });

  app.get('/api/prices/rules/:storeId/examples', async (request) => {
    const storeId = parseId((request.params as { storeId: string }).storeId, 'store id');
    const q = ExamplesQuery.parse(request.query);
    const { baseCurrency, stores } = await storesFor(db, [storeId]);
    const store = stores[0];
    if (!store) throw notFound('Store');
    // What the rule gives, even while it is off (the merchant is setting it up).
    const rule: PriceRule = { ...(store.rule ?? DEFAULT_PRICE_RULE), enabled: true };
    const bases = q.prices ?? (await samples()).map((s) => s.basePrice);
    return {
      baseCurrency,
      currencyCode: store.currencyCode,
      examples: (bases.length ? bases : [10, 25, 99.99]).map((basePrice) => {
        const target = computeTargetPrice({
          basePrice,
          baseCompareAtPrice: null,
          exchangeRate: store.exchangeRate,
          rule,
          currencyCode: store.currencyCode,
          override: null,
        });
        return { basePrice, price: target.status === 'ok' ? target.price : null };
      }),
    };
  });

  // ---- fixed prices (overrides) -------------------------------------------------------------

  app.put('/api/prices/overrides/:storeId/:itemId', async (request) => {
    const params = request.params as { storeId: string; itemId: string };
    const storeId = parseId(params.storeId, 'store id');
    const itemId = parseId(params.itemId, 'item id');
    const body = OverrideBody.parse(request.body);
    if (body.compareAtPrice !== null && body.compareAtPrice <= body.price) {
      throw badRequest(COMPARE_AT_ABOVE);
    }
    // The merchant's own price: a sale that owned this item's price here lets go of it (and
    // won't put anything back over it when it ends).
    const { rowCount } = await db.query(
      `INSERT INTO price_overrides (store_id, item_id, price, compare_at_price, note)
       SELECT s.id, i.id, $3, $4, $5 FROM stores s, items i WHERE s.id = $1 AND i.id = $2
       ON CONFLICT (store_id, item_id) DO UPDATE
         SET price = EXCLUDED.price, compare_at_price = EXCLUDED.compare_at_price,
             note = EXCLUDED.note, schedule_id = NULL, updated_at = now()`,
      [storeId, itemId, body.price, body.compareAtPrice, body.note ?? null],
    );
    if (!rowCount) throw notFound('Store or item');
    const { stores } = await storesFor(db);
    return loadItemView(db, stores, itemId);
  });

  app.delete('/api/prices/overrides/:storeId/:itemId', async (request) => {
    const params = request.params as { storeId: string; itemId: string };
    const storeId = parseId(params.storeId, 'store id');
    const itemId = parseId(params.itemId, 'item id');
    const { rowCount } = await db.query(
      'DELETE FROM price_overrides WHERE store_id = $1 AND item_id = $2',
      [storeId, itemId],
    );
    if (!rowCount) throw notFound('Fixed price');
    const { stores } = await storesFor(db);
    return loadItemView(db, stores, itemId);
  });

  // ---- updating the stores ------------------------------------------------------------------

  app.get('/api/prices/apply/preview', async (request) => {
    const q = PreviewQuery.parse(request.query);
    const { baseCurrency, stores } = await storesFor(db, q.storeIds);
    const variants = await loadStoreVariants(
      db,
      q.itemIds ?? null,
      stores.map((s) => s.id),
    );
    const itemIds = [...new Set(variants.map((v) => v.itemId))];
    const [items, overrides, busy] = await Promise.all([
      loadPricingItems(db, itemIds),
      loadOverrides(db, q.itemIds ?? null),
      busyStores(db, null),
    ]);
    const overrideAt = byCell(overrides);
    return {
      baseCurrency,
      stores: stores.map((store) => {
        const counts = {
          checked: 0,
          changes: 0,
          increases: 0,
          decreases: 0,
          missingBase: 0,
          unknown: 0,
        };
        const drops: {
          itemId: number;
          sku: string;
          title: string;
          from: number;
          to: number;
          change: number;
        }[] = [];
        for (const v of variants) {
          const item = v.storeId === store.id ? items.get(v.itemId) : undefined;
          if (!item) continue;
          const cell = priceCell(item, store, v, overrideAt.get(cellKey(store.id, v.itemId)));
          if (cell.target.status !== 'ok') {
            if (cell.target.reason === 'no_base_price') counts.missingBase++;
            continue;
          }
          counts.checked++;
          if (!cell.current) {
            counts.unknown++;
            continue;
          }
          if (!cell.differs) continue;
          counts.changes++;
          const from = cell.current.price;
          const to = cell.target.price;
          if (to > from) counts.increases++;
          if (to < from) {
            counts.decreases++;
            const change = from > 0 ? (to - from) / from : 0;
            // A big drop is worth a second look before it goes live.
            if (change <= -0.2) {
              drops.push({ itemId: item.id, sku: item.sku, title: item.title, from, to, change });
            }
          }
        }
        const overrideCount = overrides.filter((o) => o.storeId === store.id).length;
        const managed = (store.rule?.enabled ?? false) || overrideCount > 0;
        const isBusy = busy.some((b) => b.id === store.id);
        const missing = store.pricingMissingScopes;
        const reason = !managed
          ? 'Store Sync doesn’t manage prices in this store: its price rule is off and it has no fixed prices.'
          : (storeUnavailableMessage(store.name, store.status) ??
            (missing.length
              ? `Store Sync isn’t allowed to update prices in “${store.name}” (${missing.join(', ')}). ` +
                'Add the permission in the app’s settings, then click “Test connection” on the store’s page.'
              : !store.currencyKnown
                ? `We don’t know “${store.name}”’s currency yet. Click “Test connection” on its page.`
                : isBusy
                  ? `Prices are already being updated in “${store.name}”. Wait until that finishes.`
                  : null));
        drops.sort((a, b) => a.change - b.change);
        return {
          storeId: store.id,
          storeName: store.name,
          currencyCode: store.currencyCode,
          status: store.status,
          ruleEnabled: store.rule?.enabled ?? false,
          overrides: overrideCount,
          canUpdate: reason === null,
          busy: isBusy,
          reason,
          ...counts,
          bigDrops: drops.slice(0, 10),
          bigDropCount: drops.length,
        };
      }),
    };
  });

  app.post('/api/prices/apply', async (request, reply) => {
    const body = ApplyBody.parse(request.body ?? {});
    const run = await withTransaction(db, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [RUN_CREATE_LOCK]);
      const busy = await busyStores(client, body.storeIds ?? null);
      if (busy.length > 0) {
        throw conflict(
          `Prices are already being updated in ${busy.map((s) => `“${s.name}”`).join(', ')}. ` +
            'Wait until that finishes, then try again.',
        );
      }
      const created = await createPriceRun(client, {
        reason: { kind: 'manual' },
        itemIds: body.itemIds ?? null,
        storeIds: body.storeIds ?? null,
      });
      if (!created) {
        throw conflict(
          'Store Sync doesn’t manage prices in these stores yet. Turn on a store’s price rule on ' +
            'the Rules tab, or give a product a fixed price there.',
        );
      }
      if (!created.stores.some((s) => s.status === 'queued')) {
        // Nothing can be updated: say why instead of keeping a run that did nothing.
        throw new PricingError(409, created.stores.map((s) => s.error).join(' '));
      }
      return created;
    });
    deps.onWork?.();
    return reply.code(202).send(run);
  });

  app.get('/api/prices/runs', async (request) => {
    const q = RunsQuery.parse(request.query);
    return loadRuns(db, { limit: q.limit });
  });

  app.get('/api/prices/runs/:id', async (request) => {
    const runId = parseId((request.params as { id: string }).id);
    const [run] = await loadRuns(db, { runId });
    if (!run) throw notFound('Price update');
    return run;
  });

  // ---- sales and price changes --------------------------------------------------------------

  app.get('/api/prices/schedules', async () => loadSchedules(db));

  app.get('/api/prices/schedules/:id', async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const [schedule] = await loadSchedules(db, { id });
    if (!schedule) throw notFound('Schedule');
    return schedule;
  });

  app.post('/api/prices/schedules', async (request, reply) => {
    const input: ScheduleInput = ScheduleBody.parse(request.body);
    const id = await createSchedule(db, input);
    const [schedule] = await loadSchedules(db, { id });
    return reply.code(201).send(schedule);
  });

  app.patch('/api/prices/schedules/:id', async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const patch = SchedulePatch.parse(request.body);
    const [current] = await loadSchedules(db, { id });
    if (!current) throw notFound('Schedule');
    const startsAt = patch.startsAt ?? current.startsAt;
    const input: ScheduleInput =
      current.kind === 'sale'
        ? {
            kind: 'sale',
            name: patch.name ?? current.name,
            startsAt,
            endsAt: patch.endsAt ?? current.endsAt!,
            storeIds: patch.storeIds !== undefined ? patch.storeIds : current.storeIds,
            itemIds: patch.itemIds ?? current.itemIds,
            percentOff: patch.percentOff ?? current.percentOff!,
            showCompareAt: patch.showCompareAt ?? current.showCompareAt,
          }
        : {
            kind: 'base_change',
            name: patch.name ?? current.name,
            startsAt,
            changes:
              patch.changes ??
              current.changes.map((c) => ({
                itemId: c.itemId,
                basePrice: c.basePrice,
                baseCompareAtPrice: c.baseCompareAtPrice,
              })),
          };
    await updateSchedule(db, id, input);
    const [schedule] = await loadSchedules(db, { id });
    return schedule;
  });

  app.post('/api/prices/schedules/:id/cancel', async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const run = await cancelSchedule(db, id);
    if (run) deps.onWork?.();
    const [schedule] = await loadSchedules(db, { id });
    return { schedule, runId: run?.runId ?? null };
  });
}
