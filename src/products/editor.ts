import { z } from 'zod';
import type { EnsuredItem } from '../catalog/catalog.js';
import { ensureItemsLocked, lockCatalog } from '../catalog/catalog.js';
import { normalizeSku } from '../catalog/sku.js';
import type { Db, DbClient, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { CatalogConflictError, CatalogInputError, CatalogNotFoundError } from './errors.js';
import type { MasterMedia, MasterOption, MasterProductStore, MasterVariant } from './model.js';
import { loadMasterProduct, VERSION } from './model.js';

/**
 * WRITING MASTER PRODUCTS (the editor): create, update, delete.
 *
 * A master variant is an item (one SKU). Items are created under the catalog lock
 * (ensureItemsLocked), so SKU matching can't create the same item at the same moment; an item
 * created here is sold by no store yet, so it gets an `initialize` adjustment with the value 0:
 * it starts syncing at 0 when the product is first published, and stock is added with a purchase
 * order or "Add units". Existing items keep their stock. A SKU belongs to one master product.
 *
 * Base prices and the cost entered in the editor are the items' own columns (the Prices page
 * edits the same ones). Only values that are sent are written: an editor that didn't touch a price
 * doesn't overwrite a change made on the Prices page meanwhile.
 */

/** Shopify takes at most 250 variants in one productSet. */
export const MAX_VARIANTS = 250;

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const Text = (max: number) => z.string().trim().max(max);
const Money = z.number().finite().min(0).max(1_000_000_000);
const Handle = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase letters, numbers and hyphens for the handle, like linen-shirt',
  );
const NullableHandle = z.preprocess(blankToNull, Handle.nullable());
const NullableText = (max: number) => z.preprocess(blankToNull, Text(max).nullable());
const Status = z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']);
const Tag = z.string().trim().min(1).max(255);

const OptionInput = z.object({
  name: Text(255).min(1),
  values: z.array(Text(255).min(1)).min(1).max(100),
});

const VariantInput = z.object({
  /** An existing master variant (else matched by SKU, else new). */
  id: z.number().int().positive().optional(),
  sku: Text(255).min(1),
  optionValues: z.array(Text(255).min(1)).max(3).default([]),
  barcode: NullableText(255).optional(),
  weight: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  weightUnit: z.enum(['GRAMS', 'KILOGRAMS', 'OUNCES', 'POUNDS']).optional(),
  requiresShipping: z.boolean().optional(),
  taxable: z.boolean().optional(),
  /** Base currency; null clears; leave out to keep the item's. */
  basePrice: Money.nullable().optional(),
  baseCompareAtPrice: Money.nullable().optional(),
  cost: Money.nullable().optional(),
});
type VariantIn = z.infer<typeof VariantInput>;

const StoreInput = z.object({
  storeId: z.number().int().positive(),
  enabled: z.boolean().optional(),
  // null / '' = the master's value.
  title: NullableText(255).optional(),
  descriptionHtml: z.preprocess(blankToNull, z.string().max(200_000).nullable()).optional(),
  vendor: NullableText(255).optional(),
  productType: NullableText(255).optional(),
  handle: NullableHandle.optional(),
  seoTitle: NullableText(255).optional(),
  seoDescription: NullableText(1000).optional(),
  extraTags: z.array(Tag).max(250).optional(),
  status: z.preprocess(blankToNull, Status.nullable()).optional(),
  publishToOnlineStore: z.boolean().optional(),
});
type StoreIn = z.infer<typeof StoreInput>;

const MediaInput = z.object({
  /** An image already in the product (its file or URL can't change). */
  id: z.number().int().positive().optional(),
  /** null = every brand. */
  storeId: z.number().int().positive().nullable().default(null),
  fileId: z.number().int().positive().optional(),
  sourceUrl: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https:\/\/[^\s]+$/i, 'Use an https:// image address')
    .optional(),
  alt: Text(512).default(''),
  optionValue: z.preprocess(blankToNull, Text(255).nullable()).default(null),
});
type MediaIn = z.infer<typeof MediaInput>;

export const CreateProductBody = z.object({
  title: Text(255).min(1),
  descriptionHtml: z.string().max(200_000).default(''),
  vendor: Text(255).default(''),
  productType: Text(255).default(''),
  tags: z.array(Tag).max(250).default([]),
  handle: NullableHandle.default(null),
  seoTitle: NullableText(255).default(null),
  seoDescription: NullableText(1000).default(null),
  status: Status.default('DRAFT'),
  options: z.array(OptionInput).max(3).default([]),
  variants: z.array(VariantInput).min(1).max(MAX_VARIANTS),
  /** Brands: a store left out is enabled (unless disconnected), with no overlay. */
  stores: z.array(StoreInput).default([]),
  media: z.array(MediaInput).max(250).default([]),
});

export const UpdateProductBody = z.object({
  /** The version the editor loaded (GET .version); refused if someone saved since. */
  version: z.string().max(40).optional(),
  title: Text(255).min(1).optional(),
  descriptionHtml: z.string().max(200_000).optional(),
  vendor: Text(255).optional(),
  productType: Text(255).optional(),
  tags: z.array(Tag).max(250).optional(),
  handle: NullableHandle.optional(),
  seoTitle: NullableText(255).optional(),
  seoDescription: NullableText(1000).optional(),
  status: Status.optional(),
  options: z.array(OptionInput).max(3).optional(),
  /** The full list: variants left out are removed from the product (their items stay). */
  variants: z.array(VariantInput).min(1).max(MAX_VARIANTS).optional(),
  /** Only the stores given change, and only the fields given. */
  stores: z.array(StoreInput).optional(),
  /** The full list: images left out are removed. */
  media: z.array(MediaInput).max(250).optional(),
});

export async function createProduct(db: Db, raw: unknown): Promise<number> {
  const body = CreateProductBody.parse(raw);
  checkShape(body.options, body.variants);
  return withTransaction(db, async (client) => {
    const stores = await storeStatuses(client);
    checkStores(body.stores, stores);
    checkMediaShape(body.media, body.options, stores, new Map());
    await checkFiles(client, body.media);
    const items = await ensureItemsLocked(
      client,
      body.variants.map((v) => ({ sku: v.sku, title: itemTitle(body.title, v.optionValues) })),
    );
    await checkSkuOwners(client, itemIdsOf(items), null);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO master_products (title, description_html, vendor, product_type, tags, handle,
                                    seo_title, seo_description, status, options, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               CASE WHEN $9 = 'ARCHIVED' THEN now() END)
       RETURNING id`,
      [
        body.title,
        body.descriptionHtml,
        body.vendor,
        body.productType,
        body.tags,
        body.handle,
        body.seoTitle,
        body.seoDescription,
        body.status,
        JSON.stringify(body.options),
      ],
    );
    const id = rows[0]!.id;
    await writeVariants(client, id, body.variants, items, []);
    await writeItemPrices(client, body.variants, items);
    await startNewItems(client, items);
    const rowsToWrite = [...stores.keys()].map(
      (storeId) =>
        body.stores.find((s) => s.storeId === storeId) ?? {
          storeId,
          enabled: stores.get(storeId) !== 'disconnected',
        },
    );
    for (const input of rowsToWrite) {
      await upsertStore(client, id, { ...input, enabled: input.enabled ?? true }, undefined);
    }
    await writeMedia(client, id, body.media, []);
    return id;
  });
}

export async function updateProduct(db: Db, productId: number, raw: unknown): Promise<void> {
  const body = UpdateProductBody.parse(raw);
  await withTransaction(db, async (client) => {
    // Items may be created: the catalog lock first, then the product (same order everywhere).
    if (body.variants) await lockCatalog(client);
    const { rows } = await client.query<{ version: string }>(
      `SELECT ${VERSION} AS version FROM master_products WHERE id = $1 FOR UPDATE`,
      [productId],
    );
    if (!rows[0]) throw new CatalogNotFoundError('This product isn’t in the catalog any more.');
    if (body.version !== undefined && body.version !== rows[0].version) {
      throw new CatalogConflictError(
        'Someone saved this product after you opened it. Reload the page to see their changes, ' +
          'then make yours again.',
      );
    }
    const product = (await loadMasterProduct(client, productId))!;
    const options = body.options ?? product.options;
    const variants: VariantIn[] = body.variants ?? product.variants.map(variantAsInput);
    if (body.options || body.variants) checkShape(options, variants);
    const stores = await storeStatuses(client);
    if (body.stores) checkStores(body.stores, stores);
    if (body.media) {
      checkMediaShape(body.media, options, stores, new Map(product.media.map((m) => [m.id, m])));
      await checkFiles(client, body.media);
    } else if (body.options) {
      checkMediaShape(product.media.map(mediaAsInput), options, stores, new Map());
    }

    await client.query(
      `UPDATE master_products
          SET title = COALESCE($2, title),
              description_html = COALESCE($3, description_html),
              vendor = COALESCE($4, vendor),
              product_type = COALESCE($5, product_type),
              tags = COALESCE($6, tags),
              handle = CASE WHEN $7::boolean THEN $8 ELSE handle END,
              seo_title = CASE WHEN $9::boolean THEN $10 ELSE seo_title END,
              seo_description = CASE WHEN $11::boolean THEN $12 ELSE seo_description END,
              status = COALESCE($13, status),
              archived_at = CASE WHEN COALESCE($13, status) <> 'ARCHIVED' THEN NULL
                                 WHEN status = 'ARCHIVED' THEN archived_at ELSE now() END,
              options = COALESCE($14::jsonb, options),
              updated_at = now()
        WHERE id = $1`,
      [
        productId,
        body.title ?? null,
        body.descriptionHtml ?? null,
        body.vendor ?? null,
        body.productType ?? null,
        body.tags ?? null,
        body.handle !== undefined,
        body.handle ?? null,
        body.seoTitle !== undefined,
        body.seoTitle ?? null,
        body.seoDescription !== undefined,
        body.seoDescription ?? null,
        body.status ?? null,
        body.options ? JSON.stringify(body.options) : null,
      ],
    );

    if (body.variants) {
      const title = body.title ?? product.title;
      const items = await ensureItemsLocked(
        client,
        body.variants.map((v) => ({ sku: v.sku, title: itemTitle(title, v.optionValues) })),
      );
      await checkSkuOwners(client, itemIdsOf(items), productId);
      // A published variant's SKU is how each store's variant is found: it can't change.
      const linked = [...product.stores.values()].some((s) => s.shopifyProductId !== null);
      for (const v of body.variants) {
        const was = v.id === undefined ? undefined : product.variants.find((x) => x.id === v.id);
        if (v.id !== undefined && !was) {
          throw new CatalogInputError(
            `Variant ${v.id} isn’t part of this product any more. Reload the page.`,
          );
        }
        if (linked && was && normalizeSku(v.sku) !== was.normalizedSku) {
          throw new CatalogInputError(
            `The SKU of ${was.sku} can’t change now that the product is in a store. Remove the ` +
              'variant and add a new one with the new SKU instead.',
          );
        }
      }
      await writeVariants(client, productId, body.variants, items, product.variants);
      await writeItemPrices(client, body.variants, items);
      await startNewItems(client, items);
      const kept = new Set(itemIdsOf(items));
      await dropUnusedItems(
        client,
        product.variants.map((v) => v.itemId).filter((id) => !kept.has(id)),
      );
    }
    for (const input of body.stores ?? []) {
      await upsertStore(client, productId, input, product.stores.get(input.storeId));
    }
    // A brand that doesn't sell it any more has no publishing problem left to fix.
    const dropped = (body.stores ?? []).filter((s) => s.enabled === false);
    if (dropped.length) {
      await client.query(
        `UPDATE alerts SET resolved_at = now()
          WHERE kind = 'catalog_publish_failed' AND resolved_at IS NULL
            AND dedupe_key = ANY($1::text[])`,
        [dropped.map((s) => `catalog_publish_failed:${productId}:${s.storeId}`)],
      );
    }
    if (body.media) await writeMedia(client, productId, body.media, product.media);
  });
}

export async function deleteProduct(db: Db, productId: number): Promise<void> {
  await withTransaction(db, async (client) => {
    const { rowCount } = await client.query('DELETE FROM master_products WHERE id = $1', [
      productId,
    ]);
    if (!rowCount) throw new CatalogNotFoundError('This product isn’t in the catalog any more.');
    // Its publishing problems are gone with it.
    await client.query(
      `UPDATE alerts SET resolved_at = now()
        WHERE kind = 'catalog_publish_failed' AND resolved_at IS NULL
          AND dedupe_key LIKE $1`,
      [`catalog_publish_failed:${productId}:%`],
    );
  });
}

// ---- validation -----------------------------------------------------------------------------

type OptionIn = z.infer<typeof OptionInput>;

/** Options, variants and SKUs fit together (the messages name what to fix). */
export function checkShape(options: OptionIn[] | MasterOption[], variants: VariantIn[]): void {
  const names = new Set<string>();
  for (const o of options) {
    const key = o.name.trim().toLowerCase();
    if (names.has(key)) {
      throw new CatalogInputError(`There are two options called “${o.name}”. Rename one.`);
    }
    names.add(key);
    const values = new Set<string>();
    for (const value of o.values) {
      if (values.has(value.toLowerCase())) {
        throw new CatalogInputError(`“${value}” is listed twice in ${o.name}.`);
      }
      values.add(value.toLowerCase());
    }
  }
  if (options.length === 0 && variants.length > 1) {
    throw new CatalogInputError(
      'A product without options has a single variant. Add an option, like Size, to sell several.',
    );
  }
  if (variants.length > MAX_VARIANTS) {
    throw new CatalogInputError(`A product can have at most ${MAX_VARIANTS} variants.`);
  }
  const combos = new Set<string>();
  const skus = new Map<string, string>();
  for (const v of variants) {
    const sku = normalizeSku(v.sku);
    if (!sku) throw new CatalogInputError('Every variant needs a SKU.');
    const other = skus.get(sku);
    if (other !== undefined) {
      throw new CatalogInputError(
        `SKU ${v.sku} is used by two variants. Each variant needs its own SKU.`,
      );
    }
    skus.set(sku, v.sku);
    if (v.optionValues.length !== options.length) {
      throw new CatalogInputError(`Variant ${v.sku} needs a value for each option.`);
    }
    v.optionValues.forEach((value, i) => {
      const option = options[i]!;
      if (!option.values.includes(value)) {
        throw new CatalogInputError(
          `Variant ${v.sku} uses “${value}”, which isn’t one of the ${option.name} values.`,
        );
      }
    });
    const combo = v.optionValues.join(' / ');
    if (combos.has(combo)) {
      throw new CatalogInputError(
        `Two variants are “${combo}”. Each combination of values can only be used once.`,
      );
    }
    combos.add(combo);
  }
}

async function storeStatuses(client: Queryable): Promise<Map<number, string>> {
  const { rows } = await client.query<{ id: number; status: string }>(
    'SELECT id, status FROM stores ORDER BY id',
  );
  return new Map(rows.map((r) => [r.id, r.status]));
}

function checkStores(inputs: StoreIn[], stores: Map<number, string>): void {
  const seen = new Set<number>();
  for (const s of inputs) {
    if (!stores.has(s.storeId)) throw new CatalogInputError(`Store ${s.storeId} doesn’t exist.`);
    if (seen.has(s.storeId)) throw new CatalogInputError(`Store ${s.storeId} is listed twice.`);
    seen.add(s.storeId);
  }
}

function checkMediaShape(
  media: MediaIn[],
  options: OptionIn[] | MasterOption[],
  stores: Map<number, string>,
  existing: Map<number, MasterMedia>,
): void {
  const values = new Set(options.flatMap((o) => o.values));
  const ids = new Set<number>();
  for (const m of media) {
    if (m.id !== undefined) {
      if (!existing.has(m.id) || ids.has(m.id)) {
        throw new CatalogInputError(
          'An image isn’t part of this product any more. Reload the page.',
        );
      }
      ids.add(m.id);
    } else if ((m.fileId === undefined) === (m.sourceUrl === undefined)) {
      throw new CatalogInputError('Each new image needs an uploaded file or an https:// address.');
    }
    if (m.storeId !== null && !stores.has(m.storeId)) {
      throw new CatalogInputError(`Store ${m.storeId} doesn’t exist.`);
    }
    if (m.optionValue !== null && !values.has(m.optionValue)) {
      throw new CatalogInputError(
        `An image is set to show for “${m.optionValue}”, which isn’t an option value of this ` +
          'product any more. Choose another value for it.',
      );
    }
  }
}

async function checkFiles(client: Queryable, media: MediaIn[]): Promise<void> {
  const fileIds = media.flatMap((m) => (m.id === undefined && m.fileId ? [m.fileId] : []));
  if (fileIds.length === 0) return;
  const { rows } = await client.query<{ id: number }>(
    // Held until the product is saved, so the clean-up of unused uploads can't take them.
    'SELECT id FROM media_files WHERE id = ANY($1::bigint[]) FOR KEY SHARE',
    [fileIds],
  );
  if (rows.length !== new Set(fileIds).size) {
    throw new CatalogInputError('An uploaded image is missing. Upload it again.');
  }
}

/** A SKU belongs to one master product. */
async function checkSkuOwners(
  client: Queryable,
  itemIds: number[],
  productId: number | null,
): Promise<void> {
  const { rows } = await client.query<{ sku: string; title: string }>(
    `SELECT mv.sku, mp.title FROM master_variants mv
       JOIN master_products mp ON mp.id = mv.master_product_id
      WHERE mv.item_id = ANY($1::bigint[]) AND mv.master_product_id IS DISTINCT FROM $2::bigint
      ORDER BY mv.sku LIMIT 1`,
    [itemIds, productId],
  );
  if (rows[0]) {
    throw new CatalogConflictError(
      `SKU ${rows[0].sku} is already in “${rows[0].title}” in the catalog. A SKU can only be in ` +
        'one catalog product.',
    );
  }
}

// ---- writing --------------------------------------------------------------------------------

function itemTitle(title: string, optionValues: string[]): string {
  return optionValues.length ? `${title} · ${optionValues.join(' / ')}` : title;
}

function itemIdsOf(items: Map<string, EnsuredItem>): number[] {
  return [...items.values()].map((i) => i.itemId);
}

function variantAsInput(v: MasterVariant): VariantIn {
  return {
    id: v.id,
    sku: v.sku,
    optionValues: v.optionValues,
    barcode: v.barcode,
    weight: v.weight,
    weightUnit: v.weightUnit,
    requiresShipping: v.requiresShipping,
    taxable: v.taxable,
  };
}

function mediaAsInput(m: MasterMedia): MediaIn {
  return {
    id: m.id,
    storeId: m.storeId,
    alt: m.alt,
    optionValue: m.optionValue,
    ...(m.fileId !== null ? { fileId: m.fileId } : { sourceUrl: m.sourceUrl ?? '' }),
  };
}

/**
 * Replaces the product's variants with `inputs` (matched to the existing ones by id, else by
 * SKU, keeping their ids and anything not sent). Deleted and re-inserted in one go: updating in
 * place could trip the unique (product, option values) and (item) indexes halfway through a swap.
 */
async function writeVariants(
  client: DbClient,
  productId: number,
  inputs: VariantIn[],
  items: Map<string, EnsuredItem>,
  existing: MasterVariant[],
): Promise<void> {
  const rows = inputs.map((v, position) => {
    const sku = normalizeSku(v.sku)!;
    const was =
      (v.id !== undefined ? existing.find((x) => x.id === v.id) : undefined) ??
      existing.find((x) => x.normalizedSku === sku);
    return {
      id: was?.id ?? null,
      item_id: items.get(sku)!.itemId,
      sku: v.sku,
      option_values: v.optionValues,
      barcode: v.barcode !== undefined ? v.barcode : (was?.barcode ?? null),
      weight: v.weight !== undefined ? v.weight : (was?.weight ?? null),
      weight_unit: v.weightUnit ?? was?.weightUnit ?? 'GRAMS',
      requires_shipping: v.requiresShipping ?? was?.requiresShipping ?? true,
      taxable: v.taxable ?? was?.taxable ?? true,
      position,
    };
  });
  await client.query('DELETE FROM master_variants WHERE master_product_id = $1', [productId]);
  await client.query(
    `INSERT INTO master_variants (id, master_product_id, item_id, sku, option_values, barcode,
                                  weight, weight_unit, requires_shipping, taxable, position)
     SELECT COALESCE(r.id, nextval(pg_get_serial_sequence('master_variants', 'id'))), $1,
            r.item_id, r.sku,
            ARRAY(SELECT e FROM jsonb_array_elements_text(r.option_values) WITH ORDINALITY AS x(e, n)
                   ORDER BY n),
            r.barcode, r.weight, r.weight_unit, r.requires_shipping, r.taxable, r.position
       FROM jsonb_to_recordset($2::jsonb) AS r(id bigint, item_id bigint, sku text,
              option_values jsonb, barcode text, weight numeric, weight_unit text,
              requires_shipping boolean, taxable boolean, position integer)`,
    [productId, JSON.stringify(rows)],
  );
}

/** Writes the base prices and costs that were sent (null clears). */
async function writeItemPrices(
  client: Queryable,
  inputs: VariantIn[],
  items: Map<string, EnsuredItem>,
): Promise<void> {
  const rows = inputs.filter(
    (v) => v.basePrice !== undefined || v.baseCompareAtPrice !== undefined || v.cost !== undefined,
  );
  if (rows.length === 0) return;
  await client.query(
    `UPDATE items i
        SET base_price = CASE WHEN t.set_base THEN t.base ELSE i.base_price END,
            base_compare_at_price = CASE WHEN t.set_compare THEN t.compare ELSE i.base_compare_at_price END,
            cost = CASE WHEN t.set_cost THEN t.cost ELSE i.cost END,
            cost_updated_at = CASE WHEN t.set_cost AND t.cost IS DISTINCT FROM i.cost THEN now()
                                   ELSE i.cost_updated_at END,
            updated_at = now()
       FROM unnest($1::bigint[], $2::boolean[], $3::numeric[], $4::boolean[], $5::numeric[],
                   $6::boolean[], $7::numeric[])
            AS t(id, set_base, base, set_compare, compare, set_cost, cost)
      WHERE i.id = t.id`,
    [
      rows.map((v) => items.get(normalizeSku(v.sku)!)!.itemId),
      rows.map((v) => v.basePrice !== undefined),
      rows.map((v) => v.basePrice ?? null),
      rows.map((v) => v.baseCompareAtPrice !== undefined),
      rows.map((v) => v.baseCompareAtPrice ?? null),
      rows.map((v) => v.cost !== undefined),
      rows.map((v) => v.cost ?? null),
    ],
  );
}

/**
 * Items created for this product (no store sells them) start at 0 when a store first does:
 * stock comes from a purchase order or "Add units". An item some store already has a variant
 * of is left to the usual start (onboarding), so no store's real number is overwritten with 0.
 */
async function startNewItems(client: Queryable, items: Map<string, EnsuredItem>): Promise<void> {
  const created = [...items.values()].filter((i) => i.created).map((i) => i.itemId);
  if (created.length === 0) return;
  await client.query(
    `INSERT INTO pool_adjustments (pool_level_id, kind, strategy, value)
     SELECT pl.id, 'initialize', 'value', 0 FROM pool_levels pl
      WHERE pl.item_id = ANY($1::bigint[]) AND pl.quantity IS NULL
        AND NOT EXISTS (SELECT 1 FROM pool_adjustments a
                         WHERE a.pool_level_id = pl.id AND a.kind = 'initialize'
                           AND a.applied_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM variants v
                         WHERE v.item_id = pl.item_id AND v.deleted_at IS NULL)`,
    [created],
  );
}

/**
 * Deletes items that were made for a variant and never used (a SKU typed wrong, then changed):
 * no store has them, their stock never started, and nothing else refers to them. Anything that
 * still refers to one (another feature's rows) keeps it.
 */
async function dropUnusedItems(client: Queryable, itemIds: number[]): Promise<void> {
  if (itemIds.length === 0) return;
  await client.query('SAVEPOINT drop_unused_items');
  try {
    await client.query(
      `DELETE FROM items i
        WHERE i.id = ANY($1::bigint[])
          AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM master_variants mv WHERE mv.item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM pool_levels pl
                           WHERE pl.item_id = i.id AND pl.quantity IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM supplier_items s WHERE s.item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM sales_lines s WHERE s.item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM price_overrides o WHERE o.item_id = i.id)`,
      [itemIds],
    );
    await client.query('RELEASE SAVEPOINT drop_unused_items');
  } catch (err) {
    // A reference we don't know about (foreign key): keep the item.
    if ((err as { code?: string }).code !== '23503') throw err;
    await client.query('ROLLBACK TO SAVEPOINT drop_unused_items');
  }
}

async function upsertStore(
  client: Queryable,
  productId: number,
  input: StoreIn,
  was: MasterProductStore | undefined,
): Promise<void> {
  const pick = <K extends keyof StoreIn>(key: K, current: StoreIn[K]): StoreIn[K] =>
    input[key] !== undefined ? input[key] : current;
  await client.query(
    `INSERT INTO master_product_stores
       (master_product_id, store_id, enabled, title, description_html, vendor, product_type,
        handle, seo_title, seo_description, extra_tags, status, publish_to_online_store)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (master_product_id, store_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, title = EXCLUDED.title,
           description_html = EXCLUDED.description_html, vendor = EXCLUDED.vendor,
           product_type = EXCLUDED.product_type, handle = EXCLUDED.handle,
           seo_title = EXCLUDED.seo_title, seo_description = EXCLUDED.seo_description,
           extra_tags = EXCLUDED.extra_tags, status = EXCLUDED.status,
           publish_to_online_store = EXCLUDED.publish_to_online_store, updated_at = now()`,
    [
      productId,
      input.storeId,
      pick('enabled', was?.enabled ?? false),
      pick('title', was?.title ?? null),
      pick('descriptionHtml', was?.descriptionHtml ?? null),
      pick('vendor', was?.vendor ?? null),
      pick('productType', was?.productType ?? null),
      pick('handle', was?.handle ?? null),
      pick('seoTitle', was?.seoTitle ?? null),
      pick('seoDescription', was?.seoDescription ?? null),
      pick('extraTags', was?.extraTags ?? []),
      pick('status', was?.status ?? null),
      pick('publishToOnlineStore', was?.publishToOnlineStore ?? true),
    ],
  );
}

/** Replaces the product's images with `inputs`; positions follow the list, per brand. */
async function writeMedia(
  client: Queryable,
  productId: number,
  inputs: MediaIn[],
  existing: MasterMedia[],
): Promise<void> {
  const keep = inputs.flatMap((m) => (m.id !== undefined ? [m.id] : []));
  const gone = existing.filter((m) => !keep.includes(m.id)).map((m) => m.id);
  if (gone.length) {
    await client.query('DELETE FROM master_media WHERE id = ANY($1::bigint[])', [gone]);
  }
  const positions = new Map<number | null, number>();
  for (const m of inputs) {
    const position = positions.get(m.storeId) ?? 0;
    positions.set(m.storeId, position + 1);
    if (m.id !== undefined) {
      await client.query(
        `UPDATE master_media SET store_id = $2, position = $3, alt = $4, option_value = $5
          WHERE id = $1 AND master_product_id = $6`,
        [m.id, m.storeId, position, m.alt, m.optionValue, productId],
      );
    } else {
      await client.query(
        `INSERT INTO master_media (master_product_id, store_id, position, alt, file_id,
                                   source_url, option_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          productId,
          m.storeId,
          position,
          m.alt,
          m.fileId ?? null,
          m.fileId ? null : (m.sourceUrl ?? null),
          m.optionValue,
        ],
      );
    }
  }
}
