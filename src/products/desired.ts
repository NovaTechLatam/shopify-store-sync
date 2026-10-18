import { createHash } from 'node:crypto';
import { normalizeSku } from '../catalog/sku.js';
import type { TargetPrice } from '../pricing/compute.js';
import { computeTargetPrice } from '../pricing/compute.js';
import type { ProductStatus, ShopifyProduct, WeightUnit } from '../shopify/types.js';
import { currencyDecimals, roundMoney } from '../util/money.js';
import type {
  MasterOption,
  MasterProduct,
  MasterStatus,
  MasterVariant,
  StoreContext,
} from './model.js';

/**
 * WHAT A BRAND'S VERSION OF A PRODUCT SHOULD BE (pure)
 *
 * `desiredContent` applies a brand's overlay to the master product: everything publishing sends
 * except prices and costs, with our own ids (never Shopify's). Its hash is what "changed since
 * the last publish" compares, so it must be stable: the same product gives the same JSON whatever
 * the order rows came back in, and Shopify ids (which a create or re-upload changes) stay out.
 *
 * Prices and costs are left out on purpose: they follow the base prices, exchange rates and price
 * rules, which change on their own (a price rule edit, a delivery's average cost) and are applied
 * by the Prices page too. Whether a store's prices are up to date is checked against what it
 * charges now (variants.price) instead.
 */

export interface DesiredVariant {
  /** As typed. */
  sku: string;
  /** One per option, in option order. */
  optionValues: string[];
  barcode: string | null;
  weight: { unit: WeightUnit; value: number } | null;
  requiresShipping: boolean;
  taxable: boolean;
}

export interface DesiredImage {
  /** master_media.id */
  mediaId: number;
  alt: string;
  /** Variants with this option value show this image. */
  optionValue: string | null;
}

export interface DesiredContent {
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  /** null = not managed: Shopify makes one from the title, and keeps it. */
  handle: string | null;
  seo: { title: string | null; description: string | null };
  /** UNLISTED only describes a store's product as it is (the catalog never sets it). */
  status: MasterStatus | Extract<ProductStatus, 'UNLISTED'>;
  /** [] = one variant without options. */
  options: MasterOption[];
  variants: DesiredVariant[];
  /** The brand's own images first, then the shared ones. */
  images: DesiredImage[];
  /** Shown in the Online Store sales channel (when active). */
  onlineStore: boolean;
}

/** What was last published to a brand (master_product_stores.published_snapshot). */
export interface PublishedSnapshot extends DesiredContent {
  /**
   * Set by an import: whether the store showed the product in its Online Store wasn't read, so
   * publishing leaves that as it is until the merchant changes the setting or the status (a
   * product kept off the Online Store on purpose must not appear there on the next publish).
   */
  onlineStoreAsFound?: true;
}

/** Whether publishing `content` leaves the Online Store alone: imported, setting untouched. */
export function leavesOnlineStore(
  previous: PublishedSnapshot | null | undefined,
  content: DesiredContent,
): boolean {
  // An unlisted product becoming active (the import says so) is not a status change here.
  const listed = (status: DesiredContent['status']) => (status === 'UNLISTED' ? 'ACTIVE' : status);
  return (
    previous?.onlineStoreAsFound === true &&
    previous.onlineStore === content.onlineStore &&
    listed(previous.status) === listed(content.status)
  );
}

/** The brand's version of the product (`storeId`'s overlay over the master). */
export function desiredContent(product: MasterProduct, storeId: number): DesiredContent {
  const s = product.stores.get(storeId);
  const own = product.media.filter((m) => m.storeId === storeId);
  const shared = product.media.filter((m) => m.storeId === null);
  const byPosition = (a: { position: number; id: number }, b: { position: number; id: number }) =>
    a.position - b.position || a.id - b.id;
  return {
    title: s?.title ?? product.title,
    descriptionHtml: s?.descriptionHtml ?? product.descriptionHtml,
    vendor: s?.vendor ?? product.vendor,
    productType: s?.productType ?? product.productType,
    tags: contentTags([...product.tags, ...(s?.extraTags ?? [])]),
    handle: s?.handle ?? product.handle,
    seo: {
      title: s?.seoTitle ?? product.seoTitle,
      description: s?.seoDescription ?? product.seoDescription,
    },
    status: s?.status ?? product.status,
    options: product.options.map((o) => ({ name: o.name, values: [...o.values] })),
    variants: [...product.variants]
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map(desiredVariant),
    images: [...own.sort(byPosition), ...shared.sort(byPosition)].map((m) => ({
      mediaId: m.id,
      alt: m.alt,
      optionValue: m.optionValue,
    })),
    onlineStore: s?.publishToOnlineStore ?? true,
  };
}

function desiredVariant(v: MasterVariant): DesiredVariant {
  return {
    sku: v.sku,
    optionValues: [...v.optionValues],
    barcode: v.barcode,
    weight: v.weight === null ? null : { unit: v.weightUnit, value: roundWeight(v.weight) },
    requiresShipping: v.requiresShipping,
    taxable: v.taxable,
  };
}

/** Tags are case-insensitive in Shopify: keep the first spelling of each. */
export function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * A product's tags as compared and sent: unique, in alphabetical order. Shopify keeps a set (it
 * lists tags alphabetically), so order means nothing: a brand with an extra tag that sorts among
 * the master's must not look changed after an import.
 */
export function contentTags(tags: string[]): string[] {
  return uniqueTags(tags).sort((a, b) => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** Weights are stored with 3 decimals (numeric(12,3)). */
function roundWeight(value: number): number {
  return roundMoney(value, 3);
}

/** sha256 of the content's stable JSON: equal content, equal hash. */
export function contentHash(content: DesiredContent): string {
  return createHash('sha256').update(stableJson(content)).digest('hex');
}

/** JSON with object keys sorted at every level (array order kept: it means something). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---- prices --------------------------------------------------------------------------------------

export interface VariantPricing {
  /** The price the store should have (rule, or a fixed price for this store). */
  target: TargetPrice;
  /**
   * For a variant the store doesn't have yet when there is no target because the store's rule is
   * off: the base price converted at the exchange rate, so a new product never goes out at 0.
   * null = no base price either.
   */
  fallback: { price: number; compareAtPrice: number | null } | null;
  /** Unit cost in the store's currency (items.cost × rate); null = not set. */
  cost: number | null;
}

/** A variant's prices and cost in a store (`currencyCode`: the store's). */
export function variantPricing(
  variant: Pick<MasterVariant, 'itemId' | 'basePrice' | 'baseCompareAtPrice' | 'cost'>,
  store: Pick<StoreContext, 'exchangeRate' | 'rule' | 'overrides'>,
  currencyCode: string,
): VariantPricing {
  const decimals = currencyDecimals(currencyCode);
  const rate = store.exchangeRate;
  const target = computeTargetPrice({
    basePrice: variant.basePrice,
    baseCompareAtPrice: variant.baseCompareAtPrice,
    exchangeRate: rate,
    rule: store.rule,
    currencyCode,
    override: store.overrides.get(variant.itemId) ?? null,
  });
  let fallback: VariantPricing['fallback'] = null;
  if (variant.basePrice !== null) {
    const price = roundMoney(variant.basePrice * rate, decimals);
    const compareAt =
      variant.baseCompareAtPrice === null
        ? null
        : roundMoney(variant.baseCompareAtPrice * rate, decimals);
    fallback = {
      price,
      compareAtPrice: compareAt !== null && compareAt > price ? compareAt : null,
    };
  }
  return {
    target,
    fallback,
    cost: variant.cost === null ? null : roundMoney(variant.cost * rate, decimals),
  };
}

/**
 * The price and compare-at price publishing sends for a variant. `exists`: the store already has
 * the variant. Then a missing target means "leave the store's price alone" (undefined); a new
 * variant falls back to the converted base price. `compareAtPrice` undefined = leave it.
 * Returns null when a new variant has no price at all.
 */
export function priceToSend(
  pricing: VariantPricing,
  exists: boolean,
): { price: number; compareAtPrice: number | null | undefined } | undefined | null {
  if (pricing.target.status === 'ok') {
    const c = pricing.target.compareAtPrice;
    return { price: pricing.target.price, compareAtPrice: c === 'keep' ? undefined : c };
  }
  if (exists) return undefined;
  if (pricing.target.reason === 'rule_disabled' && pricing.fallback) return pricing.fallback;
  return null;
}

// ---- what a store has now --------------------------------------------------------------------

/**
 * A Shopify product as DesiredContent, to compare it with ours: what an import or adoption takes
 * over, or what is in the store now. `images` maps Shopify media ids to our images (unlinked
 * media are left out); `handleManaged` false leaves the handle out like desiredContent does.
 */
export function contentFromShopify(
  product: ShopifyProduct,
  opts: {
    images: Map<string, { mediaId: number; optionValue: string | null }>;
    handleManaged: boolean;
    onlineStore: boolean;
  },
): DesiredContent {
  const options = optionsOf(product);
  return {
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    tags: contentTags(product.tags),
    handle: opts.handleManaged ? product.handle : null,
    seo: { title: product.seo.title ?? null, description: product.seo.description ?? null },
    // Kept as is: publishing sends Active, which lists an unlisted product again.
    status: product.status,
    options,
    variants: product.variants.map((v) => ({
      sku: v.sku ?? '',
      optionValues: options.map(
        (o) => v.selectedOptions.find((s) => s.name === o.name)?.value ?? '',
      ),
      barcode: v.barcode || null,
      weight: v.weight ? { unit: v.weight.unit, value: roundWeight(v.weight.value) } : null,
      requiresShipping: v.requiresShipping,
      taxable: v.taxable,
    })),
    images: product.media.flatMap((m) => {
      const ours = opts.images.get(m.id);
      return ours ? [{ mediaId: ours.mediaId, alt: m.alt, optionValue: ours.optionValue }] : [];
    }),
    onlineStore: opts.onlineStore,
  };
}

/** Shopify's lone "Title" option of a product without options. */
export function hasOnlyDefaultOption(product: Pick<ShopifyProduct, 'options'>): boolean {
  return (
    product.options.length === 0 ||
    (product.options.length === 1 &&
      product.options[0]!.name === 'Title' &&
      product.options[0]!.values.every((v) => v.name === 'Default Title'))
  );
}

/** A product's options as the catalog keeps them: the values some variant uses, in order. */
export function optionsOf(product: Pick<ShopifyProduct, 'options' | 'variants'>): MasterOption[] {
  if (hasOnlyDefaultOption(product)) return [];
  return product.options.map((o) => {
    const used = new Set(
      product.variants.flatMap((v) =>
        v.selectedOptions.filter((s) => s.name === o.name).map((s) => s.value),
      ),
    );
    const values = o.values.map((v) => v.name).filter((name) => used.has(name));
    // Values a variant uses that the option list didn't give (shouldn't happen) go last.
    for (const value of used) if (!values.includes(value)) values.push(value);
    return { name: o.name, values };
  });
}

/** Field-by-field differences between two versions, for the publish preview. */
export interface ContentChange {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

const LABELS: [keyof DesiredContent | 'seoTitle' | 'seoDescription', string][] = [
  ['title', 'Title'],
  ['descriptionHtml', 'Description'],
  ['vendor', 'Vendor'],
  ['productType', 'Product type'],
  ['tags', 'Tags'],
  ['handle', 'Web address (handle)'],
  ['seoTitle', 'Search engine title'],
  ['seoDescription', 'Search engine description'],
  ['status', 'Status'],
  ['options', 'Options'],
  ['images', 'Images'],
  ['onlineStore', 'Online Store'],
];

/** What differs between `before` and `after` in the product's own fields (not variants or images). */
export function contentChanges(before: DesiredContent, after: DesiredContent): ContentChange[] {
  const text = (c: DesiredContent, field: string): string | null => {
    switch (field) {
      case 'tags':
        return c.tags.join(', ') || null;
      case 'seoTitle':
        return c.seo.title;
      case 'seoDescription':
        return c.seo.description;
      case 'options':
        return c.options.map((o) => `${o.name}: ${o.values.join(', ')}`).join(' · ') || null;
      case 'images':
        // Order and alt text matter (the first image is the main one).
        return (
          c.images
            .map((i) => (i.alt || 'no description') + (i.optionValue ? ` (${i.optionValue})` : ''))
            .join(', ') || null
        );
      case 'onlineStore':
        return c.onlineStore ? 'Shown' : 'Hidden';
      case 'status':
        return c.status.charAt(0) + c.status.slice(1).toLowerCase();
      default: {
        const value = c[field as keyof DesiredContent];
        return typeof value === 'string' && value !== '' ? value : null;
      }
    }
  };
  const out: ContentChange[] = [];
  for (const [field, label] of LABELS) {
    // Not managed (handle): nothing will change.
    if (field === 'handle' && after.handle === null) continue;
    const from = text(before, field);
    const to = text(after, field);
    if (from !== to) out.push({ field, label, from, to });
  }
  return out;
}

/** Variants whose shared details (barcode, weight, shipping, tax) differ, by SKU. */
export function variantDetailChanges(before: DesiredContent, after: DesiredContent): string[] {
  const key = (v: DesiredVariant) => normalizeSku(v.sku) ?? v.sku;
  const old = new Map(before.variants.map((v) => [key(v), v]));
  return after.variants.flatMap((v) => {
    const was = old.get(key(v));
    if (!was) return [];
    const same =
      stableJson({ ...was, sku: '' }) === stableJson({ ...v, sku: '' }) && was.sku === v.sku;
    return same ? [] : [v.sku];
  });
}
