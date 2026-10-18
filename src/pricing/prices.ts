import type { Queryable } from '../db/pool.js';
import { missingScopes, FEATURE_SCOPES } from '../shopify/scopes.js';
import { exchangeRateUnset } from '../util/money.js';
import type { CurrentPrice, PriceRule, PriceRuleRow, TargetPrice } from './compute.js';
import { computeTargetPrice, differsFromTarget, marginOf, rowToPriceRule } from './compute.js';

/**
 * WHAT EACH STORE CHARGES AND SHOULD CHARGE
 *
 * Loads the inputs of computeTargetPrice (base prices, costs, each store's rule, exchange rate and
 * currency, fixed prices) and what each store charges now (variants.price, as last read from
 * Shopify), and turns them into one "cell" per store and item. The price list, the item page, the
 * preview before an update and the update task itself all go through here, so they agree.
 */

export interface PricingStore {
  id: number;
  name: string;
  status: string;
  /** The store's currency; the base currency until we have read the store (currencyKnown). */
  currencyCode: string;
  currencyKnown: boolean;
  /** Units of the store's currency per 1 unit of the base currency. */
  exchangeRate: number;
  /** In another currency, with a rate nobody set: base prices can't be converted yet. */
  exchangeRateUnset: boolean;
  /** null = no rule saved yet (Store Sync doesn't manage this store's prices). */
  rule: PriceRule | null;
  ruleUpdatedAt: Date | null;
  /** Permission to write prices (write_products), as far as we know. */
  pricingMissingScopes: string[];
}

export interface PricingItem {
  id: number;
  sku: string;
  title: string;
  basePrice: number | null;
  baseCompareAtPrice: number | null;
  cost: number | null;
}

/** An item's (linked, live) variant in one store: at most one per store and item. */
export interface StoreVariant {
  storeId: number;
  itemId: number;
  variantId: string;
  productId: string;
  /** What the store charges, as last read; null = not read yet. */
  price: number | null;
  compareAtPrice: number | null;
}

export interface PriceOverride {
  storeId: number;
  itemId: number;
  price: number;
  compareAtPrice: number | null;
  note: string | null;
  /** Set while a sale owns this fixed price (it is put back when the sale ends). */
  scheduleId: number | null;
  scheduleName: string | null;
  updatedAt: Date;
}

/** One store's price for one item. */
export interface PriceCell {
  storeId: number;
  /** The store sells the item (a variant is linked to it). */
  sold: boolean;
  current: CurrentPrice | null;
  target: TargetPrice;
  /** Where the target comes from: a sale, a fixed price, the rule; null = no target. */
  source: 'sale' | 'override' | 'rule' | null;
  override: Omit<PriceOverride, 'storeId' | 'itemId' | 'updatedAt'> | null;
  /** Sold, and the store's price is not the target: an update would change it. */
  differs: boolean;
  /** Of the price the store will have (the target, else today's price); null without a cost. */
  margin: number | null;
}

/** The rule columns are NULL when the store has no rule (has_rule false). */
type StoreRow = PriceRuleRow & {
  id: number;
  name: string;
  status: string;
  currency_code: string | null;
  exchange_rate: number;
  exchange_rate_set_at: Date | null;
  granted_scopes: string[] | null;
  has_rule: boolean;
  rule_updated_at: Date | null;
};

export async function loadPricingStores(
  db: Queryable,
  baseCurrency: string,
  storeIds?: number[],
): Promise<PricingStore[]> {
  const { rows } = await db.query<StoreRow>(
    `SELECT s.id, s.name, s.status, s.currency_code, s.exchange_rate, s.exchange_rate_set_at,
            s.granted_scopes, r.store_id IS NOT NULL AS has_rule, r.enabled, r.multiplier, r.add_amount,
            r.round_mode, r.round_step, r.round_ending, r.round_direction, r.compare_at_mode,
            r.compare_at_markup, r.updated_at AS rule_updated_at
       FROM stores s LEFT JOIN price_rules r ON r.store_id = s.id
      ${storeIds ? 'WHERE s.id = ANY($1::bigint[])' : ''}
      ORDER BY s.id`,
    storeIds ? [storeIds] : [],
  );
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    currencyCode: s.currency_code ?? baseCurrency,
    currencyKnown: s.currency_code !== null,
    exchangeRate: s.exchange_rate,
    exchangeRateUnset: exchangeRateUnset(
      {
        currencyCode: s.currency_code,
        exchangeRate: s.exchange_rate,
        exchangeRateSetAt: s.exchange_rate_set_at,
      },
      baseCurrency,
    ),
    rule: s.has_rule ? rowToPriceRule(s) : null,
    ruleUpdatedAt: s.rule_updated_at,
    pricingMissingScopes: missingScopes(s.granted_scopes, FEATURE_SCOPES.pricing),
  }));
}

export async function loadPricingItems(
  db: Queryable,
  itemIds: number[],
): Promise<Map<number, PricingItem>> {
  const { rows } = await db.query<{
    id: number;
    sku: string;
    title: string;
    base_price: number | null;
    base_compare_at_price: number | null;
    cost: number | null;
  }>(
    `SELECT id, sku, title, base_price, base_compare_at_price, cost FROM items
      WHERE id = ANY($1::bigint[])`,
    [itemIds],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        sku: r.sku,
        title: r.title,
        basePrice: r.base_price,
        baseCompareAtPrice: r.base_compare_at_price,
        cost: r.cost,
      },
    ]),
  );
}

/** Live variants linked to the items (bundles are never linked), optionally in some stores. */
export async function loadStoreVariants(
  db: Queryable,
  itemIds: number[] | null,
  storeIds?: number[],
): Promise<StoreVariant[]> {
  const params: unknown[] = [];
  const where = ['v.item_id IS NOT NULL', 'v.deleted_at IS NULL', 'NOT v.is_bundle'];
  if (itemIds) {
    params.push(itemIds);
    where.push(`v.item_id = ANY($${params.length}::bigint[])`);
  }
  if (storeIds) {
    params.push(storeIds);
    where.push(`v.store_id = ANY($${params.length}::bigint[])`);
  }
  const { rows } = await db.query<{
    store_id: number;
    item_id: number;
    shopify_variant_id: string;
    shopify_product_id: string;
    price: number | null;
    compare_at_price: number | null;
  }>(
    `SELECT v.store_id, v.item_id, v.shopify_variant_id, v.shopify_product_id, v.price,
            v.compare_at_price
       FROM variants v WHERE ${where.join(' AND ')}`,
    params,
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    itemId: r.item_id,
    variantId: r.shopify_variant_id,
    productId: r.shopify_product_id,
    price: r.price,
    compareAtPrice: r.compare_at_price,
  }));
}

export async function loadOverrides(
  db: Queryable,
  itemIds: number[] | null,
  storeIds?: number[],
): Promise<PriceOverride[]> {
  const params: unknown[] = [];
  const where = ['TRUE'];
  if (itemIds) {
    params.push(itemIds);
    where.push(`o.item_id = ANY($${params.length}::bigint[])`);
  }
  if (storeIds) {
    params.push(storeIds);
    where.push(`o.store_id = ANY($${params.length}::bigint[])`);
  }
  const { rows } = await db.query<{
    store_id: number;
    item_id: number;
    price: number;
    compare_at_price: number | null;
    note: string | null;
    schedule_id: number | null;
    schedule_name: string | null;
    updated_at: Date;
  }>(
    `SELECT o.store_id, o.item_id, o.price, o.compare_at_price, o.note, o.schedule_id,
            ps.name AS schedule_name, o.updated_at
       FROM price_overrides o LEFT JOIN price_schedules ps ON ps.id = o.schedule_id
      WHERE ${where.join(' AND ')}`,
    params,
  );
  return rows.map((r) => ({
    storeId: r.store_id,
    itemId: r.item_id,
    price: r.price,
    compareAtPrice: r.compare_at_price,
    note: r.note,
    scheduleId: r.schedule_id,
    scheduleName: r.schedule_name,
    updatedAt: r.updated_at,
  }));
}

/** One store's price for one item, from what was loaded above. */
export function priceCell(
  item: PricingItem,
  store: PricingStore,
  variant: StoreVariant | undefined,
  override: PriceOverride | undefined,
): PriceCell {
  const target = computeTargetPrice({
    basePrice: item.basePrice,
    baseCompareAtPrice: item.baseCompareAtPrice,
    exchangeRate: store.exchangeRate,
    rule: store.rule,
    currencyCode: store.currencyCode,
    override: override ? { price: override.price, compareAtPrice: override.compareAtPrice } : null,
  });
  const current =
    variant && variant.price !== null
      ? { price: variant.price, compareAtPrice: variant.compareAtPrice }
      : null;
  const source =
    target.status !== 'ok'
      ? null
      : target.source === 'override'
        ? override?.scheduleId
          ? 'sale'
          : 'override'
        : 'rule';
  const shown = target.status === 'ok' ? target.price : (current?.price ?? null);
  return {
    storeId: store.id,
    sold: variant !== undefined,
    current,
    target,
    source,
    override: override
      ? {
          price: override.price,
          compareAtPrice: override.compareAtPrice,
          note: override.note,
          scheduleId: override.scheduleId,
          scheduleName: override.scheduleName,
        }
      : null,
    differs: variant !== undefined && differsFromTarget(current, target, store.currencyCode),
    margin: marginOf(shown, item.cost, store.exchangeRate),
  };
}

/** Index helpers: variants and overrides by `${storeId}:${itemId}`. */
export const cellKey = (storeId: number, itemId: number) => `${storeId}:${itemId}`;

export function byCell<T extends { storeId: number; itemId: number }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((r) => [cellKey(r.storeId, r.itemId), r]));
}

/** Every store's cell for each item, in store order. */
export async function loadPriceRows(
  db: Queryable,
  stores: PricingStore[],
  itemIds: number[],
): Promise<{ item: PricingItem; cells: PriceCell[] }[]> {
  const storeIds = stores.map((s) => s.id);
  const [items, variants, overrides] = await Promise.all([
    loadPricingItems(db, itemIds),
    loadStoreVariants(db, itemIds, storeIds),
    loadOverrides(db, itemIds, storeIds),
  ]);
  const variantAt = byCell(variants);
  const overrideAt = byCell(overrides);
  return itemIds.flatMap((itemId) => {
    const item = items.get(itemId);
    if (!item) return [];
    return [
      {
        item,
        cells: stores.map((store) =>
          priceCell(
            item,
            store,
            variantAt.get(cellKey(store.id, itemId)),
            overrideAt.get(cellKey(store.id, itemId)),
          ),
        ),
      },
    ];
  });
}

export type PriceFilter = 'all' | 'changes' | 'missing_base' | 'overrides';

/** Items computed per round when a filter needs every item's targets ("changes"). */
const COMPUTE_CHUNK = 2000;

/**
 * Ids of the items matching a search and filter, in SKU order. "changes" (a store that sells the
 * item doesn't charge its target) can't be written in SQL: every matching item's prices are
 * computed. With `storeId`, the filters look at that store only.
 */
export async function matchingItemIds(
  db: Queryable,
  stores: PricingStore[],
  q: { search?: string; filter: PriceFilter; storeId?: number },
): Promise<number[]> {
  const params: unknown[] = [];
  const where: string[] = ['TRUE'];
  if (q.search) {
    params.push(`%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(i.sku ILIKE $${params.length} OR i.title ILIKE $${params.length})`);
  }
  if (q.filter === 'missing_base') where.push('i.base_price IS NULL');
  if (q.filter === 'overrides') {
    if (q.storeId !== undefined) params.push(q.storeId);
    where.push(
      `EXISTS (SELECT 1 FROM price_overrides o WHERE o.item_id = i.id
               ${q.storeId !== undefined ? `AND o.store_id = $${params.length}` : ''})`,
    );
  }
  if (q.filter === 'changes') {
    // Only items some store sells can differ.
    where.push(
      `EXISTS (SELECT 1 FROM variants v WHERE v.item_id = i.id AND v.deleted_at IS NULL
                AND NOT v.is_bundle AND v.price IS NOT NULL)`,
    );
  }
  const { rows } = await db.query<{ id: number }>(
    `SELECT i.id FROM items i WHERE ${where.join(' AND ')} ORDER BY i.sku`,
    params,
  );
  const ids = rows.map((r) => r.id);
  if (q.filter !== 'changes') return ids;
  const scope = q.storeId === undefined ? stores : stores.filter((s) => s.id === q.storeId);
  const changing = new Set<number>();
  for (let i = 0; i < ids.length; i += COMPUTE_CHUNK) {
    const chunk = ids.slice(i, i + COMPUTE_CHUNK);
    for (const row of await loadPriceRows(db, scope, chunk)) {
      if (row.cells.some((c) => c.differs)) changing.add(row.item.id);
    }
  }
  return ids.filter((id) => changing.has(id));
}
