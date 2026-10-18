import { normalizeSku } from '../catalog/sku.js';
import type { Queryable } from '../db/pool.js';
import type { PriceRule, PriceRuleRow } from '../pricing/compute.js';
import { rowToPriceRule } from '../pricing/compute.js';
import type { WeightUnit } from '../shopify/types.js';
import type { DesiredContent } from './desired.js';

/**
 * MASTER PRODUCTS (the catalog feature): a product written once in Store Sync and published to
 * every brand store, each brand with its own title, description, images, SEO and tags (its
 * "overlay": NULL fields use the master's value). Options, variants, SKUs, barcodes and weights
 * are shared. A master variant is one item (one SKU): its price comes from items.base_price
 * through each store's price rule, its cost from items.cost.
 *
 * This module loads them (batched, for lists) and the per-store context publishing needs.
 */

export type MasterStatus = 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
export type PublishState = 'never' | 'queued' | 'publishing' | 'published' | 'failed';

export interface MasterOption {
  name: string;
  values: string[];
}

export interface MasterVariant {
  id: number;
  itemId: number;
  /** As typed (Shopify keeps the case); `normalizedSku` is the items.sku form. */
  sku: string;
  normalizedSku: string;
  /** One per master option, in order. */
  optionValues: string[];
  barcode: string | null;
  weight: number | null;
  weightUnit: WeightUnit;
  requiresShipping: boolean;
  taxable: boolean;
  position: number;
  /** Base currency (items). */
  basePrice: number | null;
  baseCompareAtPrice: number | null;
  cost: number | null;
}

export interface MasterMedia {
  id: number;
  /** null = shared by every brand. */
  storeId: number | null;
  position: number;
  alt: string;
  fileId: number | null;
  sourceUrl: string | null;
  /** Variants with this option value show this image. */
  optionValue: string | null;
  filename: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}

export interface MasterProductStore {
  storeId: number;
  enabled: boolean;
  title: string | null;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  handle: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  extraTags: string[];
  status: MasterStatus | null;
  publishToOnlineStore: boolean;
  shopifyProductId: string | null;
  publishState: PublishState;
  publishedHash: string | null;
  publishedAt: Date | null;
  publishedSnapshot: DesiredContent | null;
  lastError: string | null;
  warnings: string[];
  /** Our image → its Shopify media in this store. */
  mediaLinks: Map<number, string>;
}

export interface MasterProduct {
  id: number;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  handle: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  status: MasterStatus;
  options: MasterOption[];
  createdAt: Date;
  updatedAt: Date;
  /** updated_at to the microsecond: an editor saving an older version is refused. */
  version: string;
  /** In position order. */
  variants: MasterVariant[];
  /** In position order (shared and per brand together). */
  media: MasterMedia[];
  /** Rows that exist; a store without one isn't enabled. */
  stores: Map<number, MasterProductStore>;
}

/** SQL for a product's version (master_products.updated_at in microseconds, as text). */
export const VERSION = `(extract(epoch FROM updated_at) * 1000000)::bigint::text`;

/** Loads master products with everything (in the order of `ids`; missing ones are left out). */
export async function loadMasterProducts(db: Queryable, ids: number[]): Promise<MasterProduct[]> {
  if (ids.length === 0) return [];
  const [products, variants, media, stores, links] = await Promise.all([
    db.query<{
      id: number;
      title: string;
      description_html: string;
      vendor: string;
      product_type: string;
      tags: string[];
      handle: string | null;
      seo_title: string | null;
      seo_description: string | null;
      status: MasterStatus;
      options: MasterOption[];
      created_at: Date;
      updated_at: Date;
      version: string;
    }>(
      `SELECT id, title, description_html, vendor, product_type, tags, handle, seo_title,
              seo_description, status, options, created_at, updated_at, ${VERSION} AS version
         FROM master_products WHERE id = ANY($1::bigint[])`,
      [ids],
    ),
    db.query<{
      id: number;
      master_product_id: number;
      item_id: number;
      sku: string;
      item_sku: string;
      option_values: string[];
      barcode: string | null;
      weight: number | null;
      weight_unit: WeightUnit;
      requires_shipping: boolean;
      taxable: boolean;
      position: number;
      base_price: number | null;
      base_compare_at_price: number | null;
      cost: number | null;
    }>(
      `SELECT mv.id, mv.master_product_id, mv.item_id, mv.sku, i.sku AS item_sku, mv.option_values,
              mv.barcode, mv.weight, mv.weight_unit, mv.requires_shipping, mv.taxable, mv.position,
              i.base_price, i.base_compare_at_price, i.cost
         FROM master_variants mv JOIN items i ON i.id = mv.item_id
        WHERE mv.master_product_id = ANY($1::bigint[])
        ORDER BY mv.position, mv.id`,
      [ids],
    ),
    db.query<{
      id: number;
      master_product_id: number;
      store_id: number | null;
      position: number;
      alt: string;
      file_id: number | null;
      source_url: string | null;
      option_value: string | null;
      filename: string | null;
      mime_type: string | null;
      width: number | null;
      height: number | null;
    }>(
      `SELECT m.id, m.master_product_id, m.store_id, m.position, m.alt, m.file_id, m.source_url,
              m.option_value, f.filename, f.mime_type, f.width, f.height
         FROM master_media m LEFT JOIN media_files f ON f.id = m.file_id
        WHERE m.master_product_id = ANY($1::bigint[])
        ORDER BY m.position, m.id`,
      [ids],
    ),
    db.query<{
      master_product_id: number;
      store_id: number;
      enabled: boolean;
      title: string | null;
      description_html: string | null;
      vendor: string | null;
      product_type: string | null;
      handle: string | null;
      seo_title: string | null;
      seo_description: string | null;
      extra_tags: string[];
      status: MasterStatus | null;
      publish_to_online_store: boolean;
      shopify_product_id: string | null;
      publish_state: PublishState;
      published_hash: string | null;
      published_at: Date | null;
      published_snapshot: DesiredContent | null;
      last_error: string | null;
      warnings: string[];
    }>(
      `SELECT master_product_id, store_id, enabled, title, description_html, vendor, product_type,
              handle, seo_title, seo_description, extra_tags, status, publish_to_online_store,
              shopify_product_id, publish_state, published_hash, published_at, published_snapshot,
              last_error, warnings
         FROM master_product_stores WHERE master_product_id = ANY($1::bigint[])`,
      [ids],
    ),
    db.query<{
      master_product_id: number;
      master_media_id: number;
      store_id: number;
      shopify_media_id: string;
    }>(
      `SELECT m.master_product_id, l.master_media_id, l.store_id, l.shopify_media_id
         FROM master_media_links l JOIN master_media m ON m.id = l.master_media_id
        WHERE m.master_product_id = ANY($1::bigint[])`,
      [ids],
    ),
  ]);

  const byId = new Map<number, MasterProduct>(
    products.rows.map((p) => [
      p.id,
      {
        id: p.id,
        title: p.title,
        descriptionHtml: p.description_html,
        vendor: p.vendor,
        productType: p.product_type,
        tags: p.tags,
        handle: p.handle,
        seoTitle: p.seo_title,
        seoDescription: p.seo_description,
        status: p.status,
        options: p.options,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        version: p.version,
        variants: [],
        media: [],
        stores: new Map(),
      },
    ]),
  );
  for (const v of variants.rows) {
    byId.get(v.master_product_id)?.variants.push({
      id: v.id,
      itemId: v.item_id,
      sku: v.sku,
      normalizedSku: normalizeSku(v.sku) ?? v.item_sku,
      optionValues: v.option_values,
      barcode: v.barcode,
      weight: v.weight,
      weightUnit: v.weight_unit,
      requiresShipping: v.requires_shipping,
      taxable: v.taxable,
      position: v.position,
      basePrice: v.base_price,
      baseCompareAtPrice: v.base_compare_at_price,
      cost: v.cost,
    });
  }
  for (const m of media.rows) {
    byId.get(m.master_product_id)?.media.push({
      id: m.id,
      storeId: m.store_id,
      position: m.position,
      alt: m.alt,
      fileId: m.file_id,
      sourceUrl: m.source_url,
      optionValue: m.option_value,
      filename: m.filename,
      mimeType: m.mime_type,
      width: m.width,
      height: m.height,
    });
  }
  for (const s of stores.rows) {
    byId.get(s.master_product_id)?.stores.set(s.store_id, {
      storeId: s.store_id,
      enabled: s.enabled,
      title: s.title,
      descriptionHtml: s.description_html,
      vendor: s.vendor,
      productType: s.product_type,
      handle: s.handle,
      seoTitle: s.seo_title,
      seoDescription: s.seo_description,
      extraTags: s.extra_tags,
      status: s.status,
      publishToOnlineStore: s.publish_to_online_store,
      shopifyProductId: s.shopify_product_id,
      publishState: s.publish_state,
      publishedHash: s.published_hash,
      publishedAt: s.published_at,
      publishedSnapshot: s.published_snapshot,
      lastError: s.last_error,
      warnings: s.warnings,
      mediaLinks: new Map(),
    });
  }
  for (const l of links.rows) {
    byId
      .get(l.master_product_id)
      ?.stores.get(l.store_id)
      ?.mediaLinks.set(l.master_media_id, l.shopify_media_id);
  }
  return ids.flatMap((id) => {
    const p = byId.get(id);
    return p ? [p] : [];
  });
}

export async function loadMasterProduct(db: Queryable, id: number): Promise<MasterProduct | null> {
  return (await loadMasterProducts(db, [id]))[0] ?? null;
}

/** What publishing to (or previewing for) a store needs to know about it. */
export interface StoreContext {
  id: number;
  name: string;
  status: 'active' | 'paused' | 'error' | 'disconnected';
  shopDomain: string;
  /** null until the store was read once. */
  currencyCode: string | null;
  exchangeRate: number;
  grantedScopes: string[] | null;
  onlineStorePublicationId: string | null;
  productIdDefinitionAt: Date | null;
  /** null = no rule row (like a disabled rule). */
  rule: PriceRule | null;
  /** Fixed prices by item id (store currency). */
  overrides: Map<number, { price: number; compareAtPrice: number | null }>;
  /** Active Shopify locations mapped to a warehouse (where stock is synced). */
  locationIds: string[];
}

/**
 * Every store (or the given ones), with its price rule, its fixed prices for `itemIds` and its
 * synced locations. Ordered by id.
 */
export async function loadStoreContexts(
  db: Queryable,
  itemIds: number[],
  storeIds?: number[],
): Promise<StoreContext[]> {
  const filter = storeIds ? 'WHERE s.id = ANY($1::bigint[])' : '';
  const params = storeIds ? [storeIds] : [];
  const [stores, overrides, locations] = await Promise.all([
    db.query<
      {
        id: number;
        name: string;
        status: StoreContext['status'];
        shop_domain: string;
        currency_code: string | null;
        exchange_rate: number;
        granted_scopes: string[] | null;
        online_store_publication_id: string | null;
        product_id_definition_at: Date | null;
        has_rule: boolean;
      } & PriceRuleRow
    >(
      `SELECT s.id, s.name, s.status, s.shop_domain, s.currency_code, s.exchange_rate,
              s.granted_scopes, s.online_store_publication_id, s.product_id_definition_at,
              r.store_id IS NOT NULL AS has_rule, r.enabled, r.multiplier, r.add_amount,
              r.round_mode, r.round_step, r.round_ending, r.round_direction, r.compare_at_mode,
              r.compare_at_markup
         FROM stores s LEFT JOIN price_rules r ON r.store_id = s.id
         ${filter}
        ORDER BY s.id`,
      params,
    ),
    itemIds.length
      ? db.query<{
          store_id: number;
          item_id: number;
          price: number;
          compare_at_price: number | null;
        }>(
          `SELECT store_id, item_id, price, compare_at_price FROM price_overrides
            WHERE item_id = ANY($1::bigint[])`,
          [itemIds],
        )
      : Promise.resolve({ rows: [] }),
    db.query<{ store_id: number; shopify_location_id: string }>(
      `SELECT store_id, shopify_location_id FROM store_locations
        WHERE is_active AND warehouse_id IS NOT NULL ORDER BY id`,
    ),
  ]);
  return stores.rows.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    shopDomain: s.shop_domain,
    currencyCode: s.currency_code,
    exchangeRate: Number(s.exchange_rate),
    grantedScopes: s.granted_scopes,
    onlineStorePublicationId: s.online_store_publication_id,
    productIdDefinitionAt: s.product_id_definition_at,
    rule: s.has_rule ? rowToPriceRule(s) : null,
    overrides: new Map(
      overrides.rows
        .filter((o) => o.store_id === s.id)
        .map((o) => [o.item_id, { price: o.price, compareAtPrice: o.compare_at_price }]),
    ),
    locationIds: locations.rows
      .filter((l) => l.store_id === s.id)
      .map((l) => l.shopify_location_id),
  }));
}

/** Shopify admin URL of a product: https://<shop>/admin/products/<number>. */
export function productAdminUrl(shopDomain: string, productId: string | null): string | null {
  const id = productId?.match(/\/(\d+)$/)?.[1];
  return id ? `https://${shopDomain}/admin/products/${id}` : null;
}
