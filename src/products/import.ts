import type { Logger } from 'pino';
import { ensureItemsLocked, lockCatalog, refreshInventoryItem } from '../catalog/catalog.js';
import { normalizeSku } from '../catalog/sku.js';
import type { Db, DbClient, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { ShopifyApiError } from '../shopify/client.js';
import type { ShopifyProduct } from '../shopify/types.js';
import type { ShopifyRegistry } from '../sync/engine.js';
import { roundMoney } from '../util/money.js';
import type { DesiredContent } from './desired.js';
import { contentFromShopify, contentHash, optionsOf, uniqueTags } from './desired.js';
import {
  CatalogConflictError,
  CatalogInputError,
  CatalogNotFoundError,
  CatalogShopifyError,
} from './errors.js';
import type { MasterOption, MasterStatus, StoreContext } from './model.js';
import { loadStoreContexts } from './model.js';

/**
 * IMPORT: makes a master product from a product one store already sells, and links the same
 * product in the other stores (found by SKU), keeping each store's own texts and images as that
 * brand's version. Nothing is written to Shopify. A linked store whose product matches what we
 * would send shows as published; one that differs (other variants, barcodes...) as changed, and
 * the publish preview says what.
 */

export interface ImportDeps {
  db: Db;
  shopify: ShopifyRegistry;
  logger: Logger;
}

/** A product of a store's catalog (as we last read it), for the import picker. */
export interface ImportCandidate {
  productId: string;
  title: string;
  variants: number;
  skus: string[];
  /** Already in the catalog (linked, or one of its SKUs is in a catalog product). */
  inCatalog: { id: number; title: string } | null;
}

export async function searchStoreProducts(
  db: Queryable,
  storeId: number,
  search: string | undefined,
  limit = 30,
): Promise<ImportCandidate[]> {
  const pattern = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const { rows } = await db.query<{
    shopify_product_id: string;
    title: string;
    variants: number;
    skus: string[] | null;
    in_catalog: { id: number; title: string } | null;
  }>(
    `SELECT v.shopify_product_id, min(v.product_title) AS title, count(*)::int AS variants,
            array_agg(v.sku ORDER BY v.id) FILTER (WHERE v.sku IS NOT NULL) AS skus,
            (SELECT json_build_object('id', mp.id, 'title', mp.title)
               FROM master_products mp
              WHERE mp.id IN (
                      SELECT mps.master_product_id FROM master_product_stores mps
                       WHERE mps.store_id = $1 AND mps.shopify_product_id = v.shopify_product_id
                      UNION
                      SELECT mv.master_product_id FROM master_variants mv
                        JOIN variants x ON x.item_id = mv.item_id
                       WHERE x.store_id = $1 AND x.shopify_product_id = v.shopify_product_id
                         AND x.deleted_at IS NULL)
              ORDER BY mp.id LIMIT 1) AS in_catalog
       FROM variants v
      WHERE v.store_id = $1 AND v.deleted_at IS NULL AND NOT v.is_bundle
        AND ($2::text IS NULL OR v.shopify_product_id IN (
              SELECT shopify_product_id FROM variants
               WHERE store_id = $1 AND deleted_at IS NULL
                 AND (product_title ILIKE $2 OR sku ILIKE $2 OR barcode ILIKE $2)))
      GROUP BY v.shopify_product_id
      ORDER BY min(v.product_title), v.shopify_product_id
      LIMIT $3`,
    [storeId, pattern, limit],
  );
  return rows.map((r) => ({
    productId: r.shopify_product_id,
    title: r.title,
    variants: r.variants,
    skus: r.skus ?? [],
    inCatalog: r.in_catalog,
  }));
}

/** A variant the master gets, with the store it came from (prices and cost are read from it). */
interface ImportedVariant {
  sku: string;
  normalizedSku: string;
  optionValues: string[];
  barcode: string | null;
  weight: { unit: string; value: number } | null;
  requiresShipping: boolean;
  taxable: boolean;
  price: number;
  compareAtPrice: number | null;
  unitCost: number | null;
  /** The store it came from: its exchange rate converts the prices. */
  exchangeRate: number;
}

/** Another store's product found by SKU, to link. */
interface LinkedStore {
  store: StoreContext;
  product: ShopifyProduct;
}

export async function importProduct(
  deps: ImportDeps,
  storeId: number,
  productId: string,
): Promise<{ id: number; warnings: string[] }> {
  const { db } = deps;
  const stores = await loadStoreContexts(db, []);
  const source = stores.find((s) => s.id === storeId);
  if (!source) throw new CatalogNotFoundError('This store doesn’t exist.');
  const product = await readProduct(deps, source, productId);
  if (!product) throw new CatalogNotFoundError(`This product isn’t in ${source.name} any more.`);

  // Every variant needs its own SKU: that's how the brands' products are matched.
  const noSku = product.variants.filter((v) => !normalizeSku(v.sku));
  if (noSku.length) {
    throw new CatalogInputError(
      `Some variants of “${product.title}” have no SKU (${noSku.map((v) => v.title).join(', ')}). ` +
        'Give every variant a SKU in Shopify, then import it.',
    );
  }
  const bySku = new Map<string, string>();
  for (const v of product.variants) {
    const sku = normalizeSku(v.sku)!;
    if (bySku.has(sku)) {
      throw new CatalogInputError(
        `Two variants of “${product.title}” have the SKU ${v.sku}. Give each its own SKU in ` +
          'Shopify, then import it.',
      );
    }
    bySku.set(sku, v.title);
  }
  await assertNotLinked(db, source, product);
  await knowVariants(deps, source.id, product);

  const options = optionsOf(product);
  const variants: ImportedVariant[] = product.variants.map((v) =>
    importedVariant(v, options, source.exchangeRate),
  );
  const warnings: string[] = [];
  if (product.status === 'UNLISTED') {
    warnings.push(
      `“${product.title}” is unlisted in ${source.name}; the catalog has it as active.`,
    );
  }

  // The other brands: the store's product holding these SKUs, if it's exactly one.
  const linked: LinkedStore[] = [];
  for (const store of stores) {
    if (store.id === source.id) continue;
    const found = await linkCandidate(deps, store, [...bySku.keys()], warnings);
    if (!found) continue;
    // Its variants the master doesn't have yet join it, when they fit its options.
    for (const v of found.variants) {
      const sku = normalizeSku(v.sku);
      if (!sku || variants.some((x) => x.normalizedSku === sku)) continue;
      const values = fitOptions(v.selectedOptions, options);
      const combo = values?.join(' / ');
      if (!values || variants.some((x) => x.optionValues.join(' / ') === combo)) {
        warnings.push(
          `${store.name}’s “${found.title}” also has ${v.sku || v.title}, which doesn’t fit ` +
            `the options of the product: publishing to ${store.name} would delete it.`,
        );
        continue;
      }
      values.forEach((value, i) => {
        if (!options[i]!.values.includes(value)) options[i]!.values.push(value);
      });
      variants.push(importedVariant(v, options, store.exchangeRate));
    }
    linked.push({ store, product: found });
  }

  const writeImport = async (client: DbClient): Promise<number> => {
    await lockCatalog(client);
    await assertNotLinked(client, source, product);
    const items = await ensureItemsLocked(
      client,
      variants.map((v) => ({
        sku: v.sku,
        title: v.optionValues.length
          ? `${product.title} · ${v.optionValues.join(' / ')}`
          : product.title,
      })),
    );
    // A SKU of another catalog product: refuse for the product imported, skip one from a brand.
    const { rows: owned } = await client.query<{ item_id: number; sku: string; title: string }>(
      `SELECT mv.item_id, mv.sku, mp.title FROM master_variants mv
         JOIN master_products mp ON mp.id = mv.master_product_id
        WHERE mv.item_id = ANY($1::bigint[])`,
      [[...items.values()].map((i) => i.itemId)],
    );
    const ownedItems = new Map(owned.map((o) => [o.item_id, o]));
    const itemOf = (v: ImportedVariant) => items.get(v.normalizedSku)!.itemId;
    for (const v of variants.slice(0, product.variants.length)) {
      const other = ownedItems.get(itemOf(v));
      if (other) {
        throw new CatalogConflictError(
          `SKU ${v.sku} is already in “${other.title}” in the catalog. A SKU can only be in one ` +
            'catalog product.',
        );
      }
    }
    const kept = variants.filter((v, i) => {
      if (i < product.variants.length || !ownedItems.has(itemOf(v))) return true;
      warnings.push(`${v.sku} is already in “${ownedItems.get(itemOf(v))!.title}”: not added.`);
      return false;
    });

    const master = {
      title: product.title,
      descriptionHtml: product.descriptionHtml,
      vendor: product.vendor,
      productType: product.productType,
      tags: uniqueTags(product.tags),
      seoTitle: product.seo.title,
      seoDescription: product.seo.description,
      status: (product.status === 'UNLISTED' ? 'ACTIVE' : product.status) as MasterStatus,
    };
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO master_products (title, description_html, vendor, product_type, tags,
                                    seo_title, seo_description, status, options, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $8 = 'ARCHIVED' THEN now() END)
       RETURNING id`,
      [
        master.title,
        master.descriptionHtml,
        master.vendor,
        master.productType,
        master.tags,
        master.seoTitle,
        master.seoDescription,
        master.status,
        JSON.stringify(options),
      ],
    );
    const masterId = rows[0]!.id;
    await client.query(
      `INSERT INTO master_variants (master_product_id, item_id, sku, option_values, barcode, weight,
                                    weight_unit, requires_shipping, taxable, position)
       SELECT $1, r.item_id, r.sku,
              ARRAY(SELECT e FROM jsonb_array_elements_text(r.option_values) WITH ORDINALITY AS x(e, n)
                     ORDER BY n),
              r.barcode, r.weight, r.weight_unit, r.requires_shipping, r.taxable, r.position
         FROM jsonb_to_recordset($2::jsonb) AS r(item_id bigint, sku text, option_values jsonb,
                barcode text, weight numeric, weight_unit text, requires_shipping boolean,
                taxable boolean, position integer)`,
      [
        masterId,
        JSON.stringify(
          kept.map((v, position) => ({
            item_id: itemOf(v),
            sku: v.sku,
            option_values: v.optionValues,
            barcode: v.barcode,
            weight: v.weight?.value ?? null,
            weight_unit: v.weight?.unit ?? 'GRAMS',
            requires_shipping: v.requiresShipping,
            taxable: v.taxable,
            position,
          })),
        ),
      ],
    );
    // Base prices and costs the items don't have yet, converted back to the base currency.
    await client.query(
      `UPDATE items i
          SET base_price = COALESCE(i.base_price, t.base),
              base_compare_at_price = CASE WHEN i.base_price IS NULL AND i.base_compare_at_price IS NULL
                                           THEN t.compare ELSE i.base_compare_at_price END,
              cost = COALESCE(i.cost, t.cost),
              cost_updated_at = CASE WHEN i.cost IS NULL AND t.cost IS NOT NULL THEN now()
                                     ELSE i.cost_updated_at END,
              updated_at = now()
         FROM unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::numeric[])
              AS t(id, base, compare, cost)
        WHERE i.id = t.id`,
      [
        kept.map(itemOf),
        kept.map((v) => toBase(v.price, v.exchangeRate)),
        kept.map((v) =>
          v.compareAtPrice !== null && v.compareAtPrice > v.price
            ? toBase(v.compareAtPrice, v.exchangeRate)
            : null,
        ),
        kept.map((v) => (v.unitCost === null ? null : toBase(v.unitCost, v.exchangeRate))),
      ],
    );

    // Each linked brand: its texts where they differ from the master, its images as its own.
    const linkedAll = [{ store: source, product }, ...linked];
    for (const { store, product: p } of linkedAll) {
      const overlay = overlayOf(master, p);
      await client.query(
        `INSERT INTO master_product_stores
           (master_product_id, store_id, enabled, title, description_html, vendor, product_type,
            seo_title, seo_description, extra_tags, status, shopify_product_id)
         VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          masterId,
          store.id,
          overlay.title,
          overlay.descriptionHtml,
          overlay.vendor,
          overlay.productType,
          overlay.seoTitle,
          overlay.seoDescription,
          overlay.extraTags,
          overlay.status,
          p.id,
        ],
      );
      const images = await insertImages(client, masterId, store.id, p);
      // What the store has now, as we'd describe it: equal to what we'd send = published.
      const snapshot: DesiredContent = contentFromShopify(p, {
        images,
        handleManaged: false,
        onlineStore: true,
      });
      await client.query(
        `UPDATE master_product_stores
            SET publish_state = 'published', published_hash = $3, published_snapshot = $4,
                published_at = now()
          WHERE master_product_id = $1 AND store_id = $2`,
        [masterId, store.id, contentHash(snapshot), JSON.stringify(snapshot)],
      );
    }
    // Brands that don't sell it: off until the merchant turns them on.
    await client.query(
      `INSERT INTO master_product_stores (master_product_id, store_id, enabled)
       SELECT $1, s.id, false FROM stores s
       ON CONFLICT (master_product_id, store_id) DO NOTHING`,
      [masterId],
    );
    return masterId;
  };

  const id = await withTransaction(db, async (client) => {
    try {
      return await writeImport(client);
    } catch (err) {
      // Someone imported or linked one of these products at the same moment.
      if ((err as { code?: string }).code === '23505') {
        throw new CatalogConflictError(
          'One of these products was just added to the catalog by someone else. Reload and check.',
        );
      }
      throw err;
    }
  });
  deps.logger.info({ masterProductId: id, storeId, linked: linked.length }, 'product imported');
  return { id, warnings };
}

async function readProduct(
  deps: ImportDeps,
  store: StoreContext,
  productId: string,
): Promise<ShopifyProduct | null> {
  try {
    return await (await deps.shopify.forStore(store.id)).getProduct(productId);
  } catch (err) {
    if (err instanceof ShopifyApiError) {
      throw new CatalogShopifyError(
        `We couldn’t read the product from ${store.name}: ${err.message}`,
      );
    }
    throw err;
  }
}

async function assertNotLinked(db: Queryable, store: StoreContext, product: ShopifyProduct) {
  const { rows } = await db.query<{ title: string }>(
    `SELECT mp.title FROM master_product_stores mps
       JOIN master_products mp ON mp.id = mps.master_product_id
      WHERE mps.store_id = $1 AND mps.shopify_product_id = $2`,
    [store.id, product.id],
  );
  if (rows[0]) {
    throw new CatalogConflictError(
      `“${product.title}” from ${store.name} is already in the catalog as “${rows[0].title}”.`,
    );
  }
}

/**
 * The variants must be in our copy of the store's catalog (so their items exist, created by
 * matching and started the usual way): read the ones we haven't seen yet.
 */
async function knowVariants(deps: ImportDeps, storeId: number, product: ShopifyProduct) {
  const { rows } = await deps.db.query<{ shopify_variant_id: string }>(
    `SELECT shopify_variant_id FROM variants
      WHERE store_id = $1 AND shopify_variant_id = ANY($2::text[]) AND deleted_at IS NULL`,
    [storeId, product.variants.map((v) => v.id)],
  );
  const known = new Set(rows.map((r) => r.shopify_variant_id));
  for (const v of product.variants) {
    if (!known.has(v.id)) await refreshInventoryItem(deps, storeId, v.inventoryItemId);
  }
}

/**
 * The one product of `store` that has these SKUs, read from Shopify; null (with a warning when
 * it's worth one) when there is none, several, or it can't be read.
 */
async function linkCandidate(
  deps: ImportDeps,
  store: StoreContext,
  skus: string[],
  warnings: string[],
): Promise<ShopifyProduct | null> {
  const { rows } = await deps.db.query<{ shopify_product_id: string; title: string }>(
    `SELECT shopify_product_id, min(product_title) AS title FROM variants
      WHERE store_id = $1 AND deleted_at IS NULL AND NOT is_bundle AND sku = ANY($2::text[])
      GROUP BY shopify_product_id ORDER BY min(product_title)`,
    [store.id, skus],
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    warnings.push(
      `In ${store.name} these SKUs are in several products (${rows.map((r) => `“${r.title}”`).join(', ')}), ` +
        `so none was linked. Put them in one product in ${store.name}, or publish to replace them.`,
    );
    return null;
  }
  const { rows: taken } = await deps.db.query<{ title: string }>(
    `SELECT mp.title FROM master_product_stores mps
       JOIN master_products mp ON mp.id = mps.master_product_id
      WHERE mps.store_id = $1 AND mps.shopify_product_id = $2`,
    [store.id, rows[0]!.shopify_product_id],
  );
  if (taken[0]) {
    warnings.push(
      `${store.name}’s “${rows[0]!.title}” is already linked to “${taken[0].title}” in the ` +
        'catalog, so it wasn’t linked again.',
    );
    return null;
  }
  if (store.status === 'disconnected') {
    warnings.push(`${store.name} is disconnected, so its “${rows[0]!.title}” wasn’t linked.`);
    return null;
  }
  try {
    const found = await (
      await deps.shopify.forStore(store.id)
    ).getProduct(rows[0]!.shopify_product_id);
    if (!found) return null;
    return found;
  } catch (err) {
    deps.logger.warn({ err, storeId: store.id }, 'import: linked product not readable');
    warnings.push(
      `We couldn’t read “${rows[0]!.title}” from ${store.name} (${(err as Error).message}), so it ` +
        'wasn’t linked.',
    );
    return null;
  }
}

/** The variant's values in the master's option order; null when its options don't match. */
function fitOptions(
  selected: { name: string; value: string }[],
  options: MasterOption[],
): string[] | null {
  const own = selected.filter((s) => !(s.name === 'Title' && s.value === 'Default Title'));
  if (own.length !== options.length || options.length === 0) return null;
  const values: string[] = [];
  for (const option of options) {
    const match = own.find((s) => s.name === option.name);
    if (!match) return null;
    values.push(match.value);
  }
  return values;
}

function importedVariant(
  v: ShopifyProduct['variants'][number],
  options: MasterOption[],
  exchangeRate: number,
): ImportedVariant {
  return {
    sku: v.sku!.trim(),
    normalizedSku: normalizeSku(v.sku)!,
    optionValues: options.map((o) => v.selectedOptions.find((s) => s.name === o.name)?.value ?? ''),
    barcode: v.barcode || null,
    weight: v.weight ? { unit: v.weight.unit, value: roundMoney(v.weight.value, 3) } : null,
    requiresShipping: v.requiresShipping,
    taxable: v.taxable,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    unitCost: v.unitCost,
    exchangeRate,
  };
}

/** Store amount → base currency, with numeric(18,4)'s precision. */
function toBase(amount: number, exchangeRate: number): number {
  return roundMoney(amount / exchangeRate, 4);
}

/** A brand's fields where they differ from the master's (null = same). */
function overlayOf(
  master: {
    title: string;
    descriptionHtml: string;
    vendor: string;
    productType: string;
    tags: string[];
    seoTitle: string | null;
    seoDescription: string | null;
    status: MasterStatus;
  },
  p: ShopifyProduct,
) {
  const differs = <T>(own: T, base: T): T | null => (own === base ? null : own);
  const masterTags = new Set(master.tags.map((t) => t.toLowerCase()));
  const status = p.status === 'UNLISTED' ? 'ACTIVE' : p.status;
  return {
    title: differs(p.title, master.title),
    descriptionHtml: differs(p.descriptionHtml, master.descriptionHtml),
    vendor: differs(p.vendor, master.vendor),
    productType: differs(p.productType, master.productType),
    seoTitle: differs(p.seo.title, master.seoTitle),
    seoDescription: differs(p.seo.description, master.seoDescription),
    extraTags: uniqueTags(p.tags).filter((t) => !masterTags.has(t.toLowerCase())),
    status: differs<MasterStatus>(status, master.status),
  };
}

/**
 * The product's images as the brand's own, linked to their Shopify media. An image shown by
 * every variant with one option value (all the "Red" ones) is tied to that value. Returns
 * Shopify media id → our image.
 */
async function insertImages(
  client: DbClient,
  masterId: number,
  storeId: number,
  p: ShopifyProduct,
): Promise<Map<string, { mediaId: number; optionValue: string | null }>> {
  const out = new Map<string, { mediaId: number; optionValue: string | null }>();
  const options = optionsOf(p);
  for (const [position, m] of p.media.entries()) {
    if (!m.url) continue; // still processing in Shopify: nothing to show or copy
    const optionValue = optionValueOf(p, options, m.id);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO master_media (master_product_id, store_id, position, alt, source_url, option_value)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [masterId, storeId, position, m.alt, m.url, optionValue],
    );
    const mediaId = rows[0]!.id;
    await client.query(
      `INSERT INTO master_media_links (master_media_id, store_id, shopify_media_id)
       VALUES ($1, $2, $3)`,
      [mediaId, storeId, m.id],
    );
    out.set(m.id, { mediaId, optionValue });
  }
  return out;
}

/** The option value whose variants (all of them, and only them) show this image. */
function optionValueOf(p: ShopifyProduct, options: MasterOption[], mediaId: string): string | null {
  const showing = p.variants.filter((v) => v.mediaId === mediaId);
  if (showing.length === 0) return null;
  for (const option of options) {
    const value = showing[0]!.selectedOptions.find((s) => s.name === option.name)?.value;
    if (value === undefined) continue;
    const withValue = p.variants.filter((v) =>
      v.selectedOptions.some((s) => s.name === option.name && s.value === value),
    );
    // Exactly the variants with this value show it: publishing gives them the same image.
    if (withValue.length === showing.length && withValue.every((v) => v.mediaId === mediaId)) {
      return value;
    }
  }
  return null;
}
