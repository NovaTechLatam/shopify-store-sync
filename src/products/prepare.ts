import type { Logger } from 'pino';
import { removeProduct } from '../catalog/catalog.js';
import { normalizeSku } from '../catalog/sku.js';
import type { Db } from '../db/pool.js';
import { ShopifyApiError } from '../shopify/client.js';
import type { ShopifyProduct } from '../shopify/types.js';
import type { ShopifyRegistry } from '../sync/engine.js';
import type { VariantPricing } from './desired.js';
import { desiredContent, variantPricing } from './desired.js';
import type { MasterProduct, StoreContext } from './model.js';
import type { PublishPlan } from './plan.js';
import { buildProductSetInput } from './plan.js';
import {
  adoptionProblem,
  conflictMessage,
  findExistingProduct,
  productFromCatalog,
  storeProblems,
  storeProductsWithSkus,
} from './targets.js';

/**
 * The steps before a publish, shared by the preview and the publish task so both decide the same
 * way: is the store ready, which of its products (if any) is ours, would a SKU end up in the
 * store twice, and what productSet would send and delete.
 */

export interface PrepareDeps {
  db: Db;
  shopify: ShopifyRegistry;
  logger: Logger;
}

export interface Prepared {
  /** Why it can't be published now (nothing else is set then). */
  blocked: string[];
  /** The store's product we update: the linked one, or an adopted one; null = create. */
  live: ShopifyProduct | null;
  /** `live` comes from our last catalog read, not Shopify (previews, when Shopify can't be asked). */
  liveFromCatalog: boolean;
  /** The store's product with exactly our SKUs, used instead of creating a copy. */
  adopted: { productId: string; title: string } | null;
  /** The linked product was deleted in Shopify: it is created again. */
  recreated: boolean;
  warnings: string[];
  pricing: Map<string, VariantPricing>;
  plan: PublishPlan | null;
}

/**
 * `mode` 'preview' never fails on Shopify: it falls back to our catalog and says so. 'publish'
 * lets Shopify errors through (the task decides: retry or record the failure).
 */
export async function prepare(
  deps: PrepareDeps,
  product: MasterProduct,
  store: StoreContext,
  mode: 'preview' | 'publish',
): Promise<Prepared> {
  const out: Prepared = {
    blocked: [],
    live: null,
    liveFromCatalog: false,
    adopted: null,
    recreated: false,
    warnings: [],
    pricing: new Map(),
    plan: null,
  };
  const ps = product.stores.get(store.id);
  out.blocked = storeProblems(store);
  if (out.blocked.length) return out;
  const currencyCode = store.currencyCode!;
  const skus = product.variants.map((v) => v.normalizedSku);

  const read = async (productId: string): Promise<ShopifyProduct | null> => {
    if (mode === 'publish') return (await deps.shopify.forStore(store.id)).getProduct(productId);
    try {
      return await (await deps.shopify.forStore(store.id)).getProduct(productId);
    } catch (err) {
      const reason = err instanceof ShopifyApiError ? err.message : 'no answer';
      deps.logger.warn({ err, storeId: store.id, productId }, 'catalog preview read failed');
      out.warnings.push(
        `We couldn’t read the product from ${store.name} just now (${reason}), so this is based ` +
          'on our last look at its catalog: images aren’t listed.',
      );
      out.liveFromCatalog = true;
      return productFromCatalog(deps.db, store.id, productId);
    }
  };

  // Products our copy of the store's catalog still has but Shopify doesn't (deleted, and the
  // notification not processed yet): forgotten, so they neither block nor get adopted.
  const gone: string[] = [];
  const forget = async (productId: string) => {
    gone.push(productId);
    if (mode === 'publish') await removeProduct(deps.db, store.id, productId);
  };

  if (ps?.shopifyProductId) {
    out.live = await read(ps.shopifyProductId);
    if (!out.live) {
      out.recreated = true;
      out.warnings.push(
        `The product was deleted in ${store.name} since it was last published: publishing ` +
          'creates it again.',
      );
      await forget(ps.shopifyProductId);
    }
  }
  if (!out.live) {
    const existing = await findExistingProduct(deps.db, store, product.id, skus, gone);
    if (existing.kind === 'conflict') {
      out.blocked.push(existing.message);
      return out;
    }
    if (existing.kind === 'adopt') {
      const live = await read(existing.productId);
      if (!live) await forget(existing.productId);
      if (live) {
        const problem = adoptionProblem(store.name, live, new Set(skus), normalizeSku);
        if (problem) {
          out.blocked.push(problem);
          return out;
        }
        out.live = live;
        out.adopted = { productId: existing.productId, title: existing.title };
      }
    }
  }

  // A SKU the store's product doesn't have yet must not be in another of its products.
  const have = new Set((out.live?.variants ?? []).map((v) => normalizeSku(v.sku)));
  const toAdd = skus.filter((sku) => !have.has(sku));
  const elsewhere = await storeProductsWithSkus(deps.db, store.id, toAdd, [
    ...gone,
    ...(out.live ? [out.live.id] : []),
  ]);
  if (elsewhere.length) {
    out.blocked.push(conflictMessage(store.name, elsewhere));
    return out;
  }

  for (const v of product.variants) {
    out.pricing.set(v.normalizedSku, variantPricing(v, store, currencyCode));
  }
  out.plan = buildProductSetInput({
    content: desiredContent(product, store.id),
    pricing: out.pricing,
    currencyCode,
    live: out.live,
    mediaLinks: out.live && !out.adopted ? (ps?.mediaLinks ?? new Map()) : new Map(),
    locationIds: store.locationIds,
    sources: new Map(),
  });
  if (out.plan.problems.length) out.blocked.push(...out.plan.problems);
  return out;
}
