import type { Queryable } from '../db/pool.js';
import { featureStatus, FeatureUnavailableError } from '../shopify/scopes.js';
import type { ShopifyProduct } from '../shopify/types.js';
import type { StoreContext } from './model.js';

/**
 * WHERE A PRODUCT GOES IN A STORE
 *
 * A SKU must be in a store only once: two variants with the same SKU in one store means neither
 * syncs its stock. So before creating a product (or adding a variant to one), we look for the
 * SKUs in the store's catalog as we last read it (`variants`). A product that holds exactly our
 * SKUs (and nothing else) is the same product: it is used ("adopted") instead of creating a
 * duplicate. Anything else is a conflict the merchant must sort out.
 */

/** Why nothing can be published to this store right now (empty = fine). */
export function storeProblems(store: StoreContext): string[] {
  const problems: string[] = [];
  if (store.status === 'paused') {
    problems.push(`${store.name} is paused. Resume it on its page, then publish again.`);
  } else if (store.status === 'error') {
    problems.push(`${store.name} needs attention: we can’t reach it. Check it on its page first.`);
  } else if (store.status === 'disconnected') {
    problems.push(`${store.name} is disconnected. Reconnect it on its page first.`);
  }
  const catalog = featureStatus(store.grantedScopes).catalog;
  if (!catalog.available) {
    problems.push(
      new FeatureUnavailableError(store.name, 'catalog', catalog.missingScopes).message,
    );
  }
  if (!store.currencyCode) {
    problems.push(
      `We don’t know ${store.name}’s currency yet. Click “Test connection” on its page first.`,
    );
  }
  if (store.locationIds.length === 0) {
    problems.push(
      `Choose which location of ${store.name} holds the shared stock (on its page) first.`,
    );
  }
  return problems;
}

/** A product of the store that has some of our SKUs (from the last catalog read). */
export interface StoreProductMatch {
  productId: string;
  title: string;
  /** Our SKUs (normalised) it has. */
  skus: string[];
  /** Its other variants (other SKUs, no SKU, bundles). */
  others: number;
}

/** Products of the store that hold any of `skus` (normalised), except `exceptProductId`. */
export async function storeProductsWithSkus(
  db: Queryable,
  storeId: number,
  skus: string[],
  exceptProductId: string | null = null,
): Promise<StoreProductMatch[]> {
  if (skus.length === 0) return [];
  const { rows } = await db.query<{
    shopify_product_id: string;
    title: string;
    skus: string[];
    others: number;
  }>(
    `SELECT v.shopify_product_id, min(v.product_title) AS title,
            array_agg(DISTINCT v.sku) FILTER (WHERE v.sku = ANY($2::text[]) AND NOT v.is_bundle)
              AS skus,
            count(*) FILTER (WHERE v.sku IS NULL OR v.is_bundle OR NOT (v.sku = ANY($2::text[])))::int
              AS others
       FROM variants v
      WHERE v.store_id = $1 AND v.deleted_at IS NULL
        AND v.shopify_product_id IS DISTINCT FROM $3::text
        AND v.shopify_product_id IN (
          SELECT shopify_product_id FROM variants
           WHERE store_id = $1 AND deleted_at IS NULL AND NOT is_bundle AND sku = ANY($2::text[]))
      GROUP BY v.shopify_product_id
      ORDER BY min(v.product_title), v.shopify_product_id`,
    [storeId, skus, exceptProductId],
  );
  return rows.map((r) => ({
    productId: r.shopify_product_id,
    title: r.title,
    skus: r.skus ?? [],
    others: r.others,
  }));
}

export type ExistingProduct =
  | { kind: 'none' }
  | { kind: 'adopt'; productId: string; title: string }
  | { kind: 'conflict'; message: string };

/**
 * For a store the product isn't linked to yet: is it there already? One product holding only our
 * SKUs → adopt it. Our SKUs in a product with other variants, or spread over several products,
 * or in a product another catalog product is linked to → a conflict, never a second copy.
 */
export async function findExistingProduct(
  db: Queryable,
  store: Pick<StoreContext, 'id' | 'name'>,
  masterProductId: number,
  skus: string[],
): Promise<ExistingProduct> {
  const matches = await storeProductsWithSkus(db, store.id, skus);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1 && matches[0]!.others === 0) {
    const match = matches[0]!;
    const { rows } = await db.query<{ title: string }>(
      `SELECT mp.title FROM master_product_stores mps
         JOIN master_products mp ON mp.id = mps.master_product_id
        WHERE mps.store_id = $1 AND mps.shopify_product_id = $2 AND mps.master_product_id <> $3`,
      [store.id, match.productId, masterProductId],
    );
    if (rows[0]) {
      return {
        kind: 'conflict',
        message:
          `“${match.title}” in ${store.name} has these SKUs but belongs to “${rows[0].title}” ` +
          'in the catalog. Move the variants to one catalog product first.',
      };
    }
    return { kind: 'adopt', productId: match.productId, title: match.title };
  }
  return { kind: 'conflict', message: conflictMessage(store.name, matches) };
}

/** A sentence naming where our SKUs already are in the store, and what to do. */
export function conflictMessage(storeName: string, matches: StoreProductMatch[]): string {
  const where = matches
    .map((m) => `${m.skus.join(', ')} in “${m.title}”${m.others ? ' (with other variants)' : ''}`)
    .join('; ');
  return (
    `${storeName} already has ${where}. A SKU can only be in a store once, or its stock stops ` +
    'syncing: import that product into the catalog instead, or change the SKUs in Shopify.'
  );
}

/**
 * Adopting a product deletes its variants that aren't ours: only adopt when every variant has
 * one of our SKUs (checked again on what Shopify has now, our copy may be behind).
 */
export function adoptionProblem(
  storeName: string,
  live: ShopifyProduct,
  skus: Set<string>,
  normalize: (sku: string | null) => string | null,
): string | null {
  const foreign = live.variants.filter((v) => {
    const sku = normalize(v.sku);
    return !sku || !skus.has(sku);
  });
  if (foreign.length === 0) return null;
  return (
    `“${live.title}” in ${storeName} has our SKUs and other variants too ` +
    `(${foreign.map((v) => v.sku || v.title).join(', ')}). Import it into the catalog instead, ` +
    'or remove those variants in Shopify.'
  );
}

/**
 * A stand-in for the store's product built from our last catalog read, when Shopify can't be
 * asked (previews): variants and prices, but no images or options.
 */
export async function productFromCatalog(
  db: Queryable,
  storeId: number,
  productId: string,
): Promise<ShopifyProduct | null> {
  const { rows } = await db.query<{
    shopify_variant_id: string;
    sku: string | null;
    product_title: string;
    variant_title: string;
    inventory_item_id: string;
    price: number | null;
    compare_at_price: number | null;
  }>(
    `SELECT shopify_variant_id, sku, product_title, variant_title, inventory_item_id, price,
            compare_at_price
       FROM variants WHERE store_id = $1 AND shopify_product_id = $2 AND deleted_at IS NULL
      ORDER BY id`,
    [storeId, productId],
  );
  if (rows.length === 0) return null;
  return {
    id: productId,
    title: rows[0]!.product_title,
    handle: '',
    descriptionHtml: '',
    vendor: '',
    productType: '',
    tags: [],
    status: 'ACTIVE',
    seo: { title: null, description: null },
    options: [],
    media: [],
    variants: rows.map((r, i) => ({
      id: r.shopify_variant_id,
      sku: r.sku,
      title: r.variant_title,
      position: i + 1,
      barcode: null,
      price: r.price ?? 0,
      compareAtPrice: r.compare_at_price,
      taxable: true,
      inventoryPolicy: 'DENY',
      selectedOptions: [],
      mediaId: null,
      inventoryItemId: r.inventory_item_id,
      tracked: true,
      requiresShipping: true,
      weight: null,
      unitCost: null,
    })),
  };
}
