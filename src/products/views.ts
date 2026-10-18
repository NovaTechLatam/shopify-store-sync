import type { Queryable } from '../db/pool.js';
import { featureStatus } from '../shopify/scopes.js';
import { currencyDecimals, roundMoney } from '../util/money.js';
import { contentHash, desiredContent, priceToSend, variantPricing } from './desired.js';
import type { MasterMedia, MasterProduct, MasterProductStore, StoreContext } from './model.js';
import { productAdminUrl } from './model.js';
import { storeProblems } from './targets.js';

/**
 * How the catalog API shows products: the list rows, the editor's full view, and each brand's
 * publish state. "changed" is computed, never stored: a published brand whose content hash
 * differs from the one last published, or whose store charges other prices than the ones a
 * publish would send.
 */

export type StoreState = 'never' | 'queued' | 'publishing' | 'published' | 'failed' | 'changed';

/** What the stores charge now for their linked variants: `${storeId}:${itemId}` → prices. */
export type CurrentPrices = Map<string, { price: number | null; compareAtPrice: number | null }>;

export async function loadCurrentPrices(db: Queryable, itemIds: number[]): Promise<CurrentPrices> {
  if (itemIds.length === 0) return new Map();
  const { rows } = await db.query<{
    store_id: number;
    item_id: number;
    price: number | null;
    compare_at_price: number | null;
  }>(
    `SELECT store_id, item_id, price, compare_at_price FROM variants
      WHERE item_id = ANY($1::bigint[]) AND deleted_at IS NULL`,
    [itemIds],
  );
  return new Map(
    rows.map((r) => [
      `${r.store_id}:${r.item_id}`,
      { price: r.price, compareAtPrice: r.compare_at_price },
    ]),
  );
}

/** Whether a publish would change a price this store charges now (for variants it has). */
export function pricesDiffer(
  product: MasterProduct,
  store: StoreContext,
  current: CurrentPrices,
): boolean {
  if (!store.currencyCode) return false;
  const decimals = currencyDecimals(store.currencyCode);
  const same = (a: number | null, b: number | null) =>
    (a === null ? null : roundMoney(a, decimals)) === (b === null ? null : roundMoney(b, decimals));
  return product.variants.some((v) => {
    const now = current.get(`${store.id}:${v.itemId}`);
    if (!now || now.price === null) return false;
    const send = priceToSend(variantPricing(v, store, store.currencyCode!), true);
    if (!send) return false;
    if (!same(now.price, send.price)) return true;
    return send.compareAtPrice !== undefined && !same(now.compareAtPrice, send.compareAtPrice);
  });
}

export function storeState(
  product: MasterProduct,
  store: StoreContext,
  ps: MasterProductStore | undefined,
  current: CurrentPrices,
): { state: StoreState; changedReason: 'content' | 'prices' | null } {
  if (!ps) return { state: 'never', changedReason: null };
  if (ps.publishState !== 'published') return { state: ps.publishState, changedReason: null };
  if (contentHash(desiredContent(product, store.id)) !== ps.publishedHash) {
    return { state: 'changed', changedReason: 'content' };
  }
  if (pricesDiffer(product, store, current)) return { state: 'changed', changedReason: 'prices' };
  return { state: 'published', changedReason: null };
}

/** Where the dashboard loads an image from: our copy of an upload, or the original URL. */
export function mediaUrl(m: Pick<MasterMedia, 'fileId' | 'sourceUrl'>): string | null {
  return m.fileId !== null ? `/api/catalog/media/${m.fileId}` : m.sourceUrl;
}

/** The product's main image: the first shared one, else the first of any brand. */
function mainImage(product: MasterProduct): MasterMedia | undefined {
  const sorted = [...product.media].sort((a, b) => a.position - b.position || a.id - b.id);
  return sorted.find((m) => m.storeId === null) ?? sorted[0];
}

export function listRow(product: MasterProduct, stores: StoreContext[], current: CurrentPrices) {
  const image = mainImage(product);
  return {
    id: product.id,
    title: product.title,
    status: product.status,
    variants: product.variants.length,
    skus: product.variants.map((v) => v.sku),
    image: image ? { url: mediaUrl(image), alt: image.alt } : null,
    updatedAt: product.updatedAt,
    stores: stores.map((store) => {
      const ps = product.stores.get(store.id);
      const { state, changedReason } = storeState(product, store, ps, current);
      return {
        storeId: store.id,
        storeName: store.name,
        enabled: ps?.enabled ?? false,
        state,
        changedReason,
        lastError: ps?.lastError ?? null,
      };
    }),
  };
}

export interface ItemStock {
  /** Σ of the started pool levels; null when none has started. */
  stock: number | null;
  started: boolean;
  /** Not started, and waiting to start at 0 when a store first sells it (made by the catalog). */
  startsAtZero: boolean;
}

export async function loadItemStock(
  db: Queryable,
  itemIds: number[],
): Promise<Map<number, ItemStock>> {
  if (itemIds.length === 0) return new Map();
  const { rows } = await db.query<{
    item_id: number;
    stock: number | null;
    started: boolean;
    starts_at_zero: boolean;
  }>(
    `SELECT pl.item_id, sum(pl.quantity)::int AS stock, bool_or(pl.quantity IS NOT NULL) AS started,
            bool_or(EXISTS (SELECT 1 FROM pool_adjustments a
                             WHERE a.pool_level_id = pl.id AND a.kind = 'initialize'
                               AND a.strategy = 'value' AND a.value = 0 AND a.applied_at IS NULL))
              AS starts_at_zero
       FROM pool_levels pl WHERE pl.item_id = ANY($1::bigint[]) GROUP BY pl.item_id`,
    [itemIds],
  );
  return new Map(
    rows.map((r) => [
      r.item_id,
      { stock: r.stock, started: r.started, startsAtZero: r.starts_at_zero },
    ]),
  );
}

/** Everything the editor shows, for every store (a store without a row isn't enabled). */
export function editorView(
  product: MasterProduct,
  stores: StoreContext[],
  current: CurrentPrices,
  stock: Map<number, ItemStock>,
  baseCurrency: string,
) {
  return {
    id: product.id,
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    handle: product.handle,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    status: product.status,
    options: product.options,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    /** Send back as `version` when saving: refused if someone saved in between. */
    version: product.version,
    baseCurrency,
    variants: product.variants.map((v) => ({
      id: v.id,
      itemId: v.itemId,
      sku: v.sku,
      optionValues: v.optionValues,
      barcode: v.barcode,
      weight: v.weight,
      weightUnit: v.weightUnit,
      requiresShipping: v.requiresShipping,
      taxable: v.taxable,
      position: v.position,
      basePrice: v.basePrice,
      baseCompareAtPrice: v.baseCompareAtPrice,
      cost: v.cost,
      stock: stock.get(v.itemId)?.stock ?? null,
      stockStarted: stock.get(v.itemId)?.started ?? false,
      stockStartsAtZero: stock.get(v.itemId)?.startsAtZero ?? false,
    })),
    media: product.media.map((m) => ({
      id: m.id,
      storeId: m.storeId,
      position: m.position,
      alt: m.alt,
      optionValue: m.optionValue,
      fileId: m.fileId,
      sourceUrl: m.sourceUrl,
      url: mediaUrl(m),
      width: m.width,
      height: m.height,
    })),
    stores: stores.map((store) => {
      const ps = product.stores.get(store.id);
      const content = desiredContent(product, store.id);
      const { state, changedReason } = storeState(product, store, ps, current);
      const currencyCode = store.currencyCode ?? baseCurrency;
      const features = featureStatus(store.grantedScopes);
      return {
        storeId: store.id,
        storeName: store.name,
        storeStatus: store.status,
        currencyCode: store.currencyCode,
        exchangeRate: store.exchangeRate,
        enabled: ps?.enabled ?? false,
        publishToOnlineStore: ps?.publishToOnlineStore ?? true,
        overlay: {
          title: ps?.title ?? null,
          descriptionHtml: ps?.descriptionHtml ?? null,
          vendor: ps?.vendor ?? null,
          productType: ps?.productType ?? null,
          handle: ps?.handle ?? null,
          seoTitle: ps?.seoTitle ?? null,
          seoDescription: ps?.seoDescription ?? null,
          extraTags: ps?.extraTags ?? [],
          status: ps?.status ?? null,
        },
        effective: {
          title: content.title,
          descriptionHtml: content.descriptionHtml,
          vendor: content.vendor,
          productType: content.productType,
          handle: content.handle,
          seoTitle: content.seo.title,
          seoDescription: content.seo.description,
          tags: content.tags,
          status: content.status,
        },
        shopifyProductId: ps?.shopifyProductId ?? null,
        adminUrl: productAdminUrl(store.shopDomain, ps?.shopifyProductId ?? null),
        state,
        changedReason,
        publishedAt: ps?.publishedAt ?? null,
        lastError: ps?.lastError ?? null,
        warnings: ps?.warnings ?? [],
        features: { catalog: features.catalog, publishing: features.publishing },
        problems: storeProblems(store),
        prices: product.variants.map((v) => {
          const pricing = variantPricing(v, store, currencyCode);
          const now = current.get(`${store.id}:${v.itemId}`);
          return {
            variantId: v.id,
            sku: v.sku,
            target: pricing.target,
            fallback: pricing.fallback,
            current: now && now.price !== null ? now : null,
          };
        }),
      };
    }),
  };
}

export type EditorView = ReturnType<typeof editorView>;
