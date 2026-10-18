import { normalizeSku } from '../catalog/sku.js';
import type {
  FileSetInputJson,
  ProductOptionSetInputJson,
  ProductSetInputJson,
  ProductVariantSetInputJson,
  ShopifyProduct,
  ShopifyProductVariant,
} from '../shopify/types.js';
import { currencyDecimals, roundMoney, toMoneyString } from '../util/money.js';
import type { DesiredContent, VariantPricing } from './desired.js';
import { priceToSend } from './desired.js';

/**
 * WHAT A PUBLISH SENDS TO ONE STORE (pure)
 *
 * productSet replaces lists: variants and images left out of the input are deleted from the
 * store's product. So the input is built from the store's product as Shopify has it now: each
 * variant we keep is sent with its id (matched by SKU, never recreated: a new variant would get a
 * new inventory item and lose its stock link), each image already there by its media id. The plan
 * also lists exactly what Shopify will delete, which the publish preview shows.
 */

export interface PlanInput {
  content: DesiredContent;
  /** By normalised SKU. */
  pricing: Map<string, VariantPricing>;
  /** The store's currency (prices are sent in it). */
  currencyCode: string;
  /** The store's product as Shopify has it now; null = create a new product. */
  live: ShopifyProduct | null;
  /** Our image → its Shopify media in this store. Links to media the product lost are ignored. */
  mediaLinks: Map<number, string>;
  /** New variants start at 0 available at these locations (the store's synced ones). */
  locationIds: string[];
  /**
   * Where Shopify fetches each image to add: a staged upload's URL, or an https URL. Images
   * without one get a placeholder (fine for a preview, never sent).
   */
  sources: Map<number, { originalSource: string; filename?: string }>;
}

export interface PriceChange {
  sku: string;
  /** What the store has now; null = a new variant. */
  from: { price: number; compareAtPrice: number | null } | null;
  /** compareAtPrice undefined = left as it is. */
  to: { price: number; compareAtPrice: number | null | undefined };
}

export interface PublishPlan {
  mode: 'create' | 'update';
  input: ProductSetInputJson;
  /** Our images to add, in the order they are sent (Shopify returns their media in that order). */
  newImages: number[];
  /** Our images the store already has: image → Shopify media id. */
  keptImages: Map<number, string>;
  /** Variants of the store's product left out: Shopify deletes them (and their stock). */
  removedVariants: { id: string; sku: string | null; title: string; inventoryItemId: string }[];
  /** Images of the store's product left out: Shopify deletes them. */
  removedImages: { id: string; alt: string; url: string | null }[];
  /** SKUs the store's product doesn't have yet. */
  addedVariants: string[];
  /** Prices that will be different afterwards (store currency). */
  priceChanges: PriceChange[];
  /** Why this can't be sent as it is (a new variant without any price). */
  problems: string[];
}

/** Placeholder source of an image that isn't uploaded yet (previews only). */
export const PENDING_SOURCE = 'https://store-sync.invalid/pending-upload';

export function buildProductSetInput(p: PlanInput): PublishPlan {
  const { content, live, currencyCode } = p;
  const decimals = currencyDecimals(currencyCode);
  const money = (n: number) => toMoneyString(n, currencyCode);
  const problems: string[] = [];

  // ---- images -----------------------------------------------------------------------------
  const liveMedia = new Set((live?.media ?? []).map((m) => m.id));
  const files: FileSetInputJson[] = [];
  const fileOf = new Map<number, FileSetInputJson>();
  const newImages: number[] = [];
  const keptImages = new Map<number, string>();
  for (const image of content.images) {
    const linked = p.mediaLinks.get(image.mediaId);
    let file: FileSetInputJson;
    if (linked && liveMedia.has(linked) && ![...keptImages.values()].includes(linked)) {
      file = { id: linked, alt: image.alt };
      keptImages.set(image.mediaId, linked);
    } else {
      // Not in the store (new, or deleted there since): Shopify fetches it again.
      const source = p.sources.get(image.mediaId);
      file = {
        originalSource: source?.originalSource ?? `${PENDING_SOURCE}/${image.mediaId}`,
        alt: image.alt,
        contentType: 'IMAGE',
        ...(source?.filename ? { filename: source.filename } : {}),
      };
      newImages.push(image.mediaId);
    }
    files.push(file);
    fileOf.set(image.mediaId, file);
  }
  const kept = new Set(keptImages.values());
  const removedImages = (live?.media ?? [])
    .filter((m) => !kept.has(m.id))
    .map((m) => ({ id: m.id, alt: m.alt, url: m.url }));

  // ---- options ----------------------------------------------------------------------------
  // A product without options has Shopify's lone "Title" / "Default Title".
  const options =
    content.options.length === 0 ? [{ name: 'Title', values: ['Default Title'] }] : content.options;
  const productOptions: ProductOptionSetInputJson[] = options.map((o, i) => {
    const existing = live?.options.find((x) => x.name === o.name);
    return {
      ...(existing ? { id: existing.id } : {}),
      name: o.name,
      position: i + 1,
      values: o.values.map((name) => {
        const value = existing?.values.find((x) => x.name === name);
        return value ? { id: value.id, name } : { name };
      }),
    };
  });

  // ---- variants ---------------------------------------------------------------------------
  // The store's variants by SKU; a second variant with the same SKU isn't ours to keep.
  const liveBySku = new Map<string, ShopifyProductVariant>();
  for (const v of live?.variants ?? []) {
    const sku = normalizeSku(v.sku);
    if (sku && !liveBySku.has(sku)) liveBySku.set(sku, v);
  }
  const keptVariants = new Set<string>();
  const addedVariants: string[] = [];
  const priceChanges: PriceChange[] = [];
  const variants: ProductVariantSetInputJson[] = content.variants.map((v, i) => {
    const sku = normalizeSku(v.sku) ?? v.sku;
    const existing = liveBySku.get(sku);
    const input: ProductVariantSetInputJson = {
      optionValues:
        content.options.length === 0
          ? [{ optionName: 'Title', name: 'Default Title' }]
          : content.options.map((o, j) => ({ optionName: o.name, name: v.optionValues[j] ?? '' })),
      sku: v.sku,
      barcodes: v.barcode ? [{ value: v.barcode }] : [],
      taxable: v.taxable,
      position: i + 1,
      inventoryItem: {
        // Stock is only counted (and synced) for tracked items.
        tracked: true,
        requiresShipping: v.requiresShipping,
        ...(v.weight
          ? { measurement: { weight: { unit: v.weight.unit, value: v.weight.value } } }
          : {}),
      },
    };
    if (existing) {
      input.id = existing.id;
      keptVariants.add(existing.id);
    } else {
      addedVariants.push(v.sku);
      // Only when the variant is created: quantities of an existing variant are the sync's job.
      input.inventoryPolicy = 'DENY';
      if (p.locationIds.length) {
        input.inventoryQuantities = p.locationIds.map((locationId) => ({
          locationId,
          name: 'available' as const,
          quantity: 0,
        }));
      }
    }

    const pricing = p.pricing.get(sku);
    const send = pricing ? priceToSend(pricing, existing !== undefined) : null;
    if (send === null) {
      problems.push(`SKU ${v.sku} has no price for this store: set its base price first.`);
    } else if (send) {
      input.price = money(send.price);
      if (send.compareAtPrice !== undefined)
        input.compareAtPrice = send.compareAtPrice === null ? null : money(send.compareAtPrice);
      const from = existing
        ? { price: existing.price, compareAtPrice: existing.compareAtPrice }
        : null;
      const same = (a: number | null, b: number | null) =>
        (a === null ? null : roundMoney(a, decimals)) ===
        (b === null ? null : roundMoney(b, decimals));
      const changed =
        !from ||
        !same(from.price, send.price) ||
        (send.compareAtPrice !== undefined && !same(from.compareAtPrice, send.compareAtPrice));
      if (changed) priceChanges.push({ sku: v.sku, from, to: send });
    }
    if (pricing && pricing.cost !== null) input.inventoryItem!.cost = money(pricing.cost);

    // The first image for one of this variant's option values (e.g. the "Red" photo).
    const image = content.images.find(
      (img) => img.optionValue !== null && v.optionValues.includes(img.optionValue),
    );
    const file = image && fileOf.get(image.mediaId);
    if (file) input.file = { ...file };
    return input;
  });
  const removedVariants = (live?.variants ?? [])
    .filter((v) => !keptVariants.has(v.id))
    .map((v) => ({ id: v.id, sku: v.sku, title: v.title, inventoryItemId: v.inventoryItemId }));

  const input: ProductSetInputJson = {
    title: content.title,
    descriptionHtml: content.descriptionHtml,
    vendor: content.vendor,
    productType: content.productType,
    tags: content.tags,
    status: content.status,
    seo: { title: content.seo.title, description: content.seo.description },
    productOptions,
    variants,
    files,
  };
  if (content.handle !== null) {
    input.handle = content.handle;
    // Old links to the product keep working.
    if (live && live.handle !== content.handle) input.redirectNewHandle = true;
  }

  return {
    mode: live ? 'update' : 'create',
    input,
    newImages,
    keptImages,
    removedVariants,
    removedImages,
    addedVariants,
    priceChanges,
    problems,
  };
}
