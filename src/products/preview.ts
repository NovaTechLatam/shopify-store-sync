import { featureStatus } from '../shopify/scopes.js';
import type { ContentChange, DesiredContent } from './desired.js';
import {
  contentChanges,
  contentFromShopify,
  contentHash,
  desiredContent,
  leavesOnlineStore,
  variantDetailChanges,
  variantOrderChange,
} from './desired.js';
import type { MasterProduct, StoreContext } from './model.js';
import type { PriceChange } from './plan.js';
import type { PrepareDeps } from './prepare.js';
import { prepare } from './prepare.js';

/**
 * PUBLISH PREVIEW: per store, what publishing would do. Field changes are against what was last
 * published (or, before the first publish of an existing product, against the product in the
 * store); deletions of variants and images are against the product as Shopify has it now, so the
 * merchant sees exactly what goes.
 */

export interface StorePreview {
  storeId: number;
  storeName: string;
  currencyCode: string | null;
  action: 'create' | 'update' | 'skip' | 'blocked';
  /** Why it's skipped or blocked. */
  reasons: string[];
  /** Good to know (an existing product is used, the product is created again...). */
  notes: string[];
  warnings: string[];
  /** The brand's title. */
  title: string;
  fields: ContentChange[];
  variantsAdded: string[];
  /** Deleted in the store, with their stock there. */
  variantsRemoved: { sku: string | null; title: string }[];
  /** SKUs whose barcode, weight, shipping or tax setting changes. */
  variantsUpdated: string[];
  /** null = unknown (Shopify couldn't be read). */
  imagesAdded: number | null;
  imagesRemoved: { alt: string; url: string | null }[] | null;
  prices: PriceChange[];
  /** Nothing would change (an update that sends the same thing). */
  upToDate: boolean;
}

export async function previewPublish(
  deps: PrepareDeps,
  product: MasterProduct,
  stores: StoreContext[],
): Promise<StorePreview[]> {
  const out: StorePreview[] = [];
  // One store at a time: each may read Shopify, and the stores share nothing.
  for (const store of stores) out.push(await previewStore(deps, product, store));
  return out;
}

async function previewStore(
  deps: PrepareDeps,
  product: MasterProduct,
  store: StoreContext,
): Promise<StorePreview> {
  const ps = product.stores.get(store.id);
  const content = desiredContent(product, store.id);
  const base: StorePreview = {
    storeId: store.id,
    storeName: store.name,
    currencyCode: store.currencyCode,
    action: 'skip',
    reasons: [],
    notes: [],
    warnings: [],
    title: content.title,
    fields: [],
    variantsAdded: [],
    variantsRemoved: [],
    variantsUpdated: [],
    imagesAdded: 0,
    imagesRemoved: [],
    prices: [],
    upToDate: false,
  };
  if (!ps?.enabled) {
    return {
      ...base,
      reasons: [`Not sold in ${store.name}. Turn on “Sell in ${store.name}” to publish there.`],
    };
  }
  const prepared = await prepare(deps, product, store, 'preview');
  if (prepared.blocked.length || !prepared.plan) {
    return { ...base, action: 'blocked', reasons: prepared.blocked, warnings: prepared.warnings };
  }
  const { plan, live } = prepared;
  const notes: string[] = [];
  const warnings = [...prepared.warnings];
  if (prepared.adopted) {
    notes.push(
      `${store.name} already has “${prepared.adopted.title}” with these SKUs: it’s updated ` +
        'instead of creating a copy.',
    );
  }
  const asFound =
    !prepared.recreated && !prepared.adopted && leavesOnlineStore(ps.publishedSnapshot, content);
  if (content.onlineStore && content.status === 'ACTIVE' && !asFound) {
    const publishing = featureStatus(store.grantedScopes).publishing;
    if (!publishing.available) {
      warnings.push(
        `${store.name} hasn’t given Store Sync permission to show products in its Online Store ` +
          `(${publishing.missingScopes.join(', ')}): the product is saved there but not shown.`,
      );
    }
  }

  // What it looked like: as last published, else (an existing product) as the store has it.
  let before: DesiredContent | null = null;
  if (ps.publishedSnapshot && live && !prepared.adopted) before = ps.publishedSnapshot;
  else if (live && !prepared.liveFromCatalog) {
    before = contentFromShopify(live, {
      images: new Map(),
      handleManaged: content.handle !== null,
      onlineStore: content.onlineStore,
    });
  }
  const fields = before ? contentChanges(before, content) : [];
  const order = before && variantOrderChange(before, content);
  if (order) {
    fields.push({
      field: 'variantOrder',
      label: 'Variant order',
      from: order.from.join(', '),
      to: order.to.join(', '),
    });
  }
  const variantsUpdated = before ? variantDetailChanges(before, content) : [];
  const imagesKnown = !prepared.liveFromCatalog;
  const result: StorePreview = {
    ...base,
    action: plan.mode,
    notes,
    warnings,
    fields,
    variantsAdded: live ? plan.addedVariants : [],
    variantsRemoved: plan.removedVariants.map((v) => ({ sku: v.sku, title: v.title })),
    variantsUpdated,
    imagesAdded: imagesKnown ? plan.newImages.length : null,
    imagesRemoved: imagesKnown ? plan.removedImages.map((m) => ({ alt: m.alt, url: m.url })) : null,
    prices: plan.priceChanges,
  };
  // Whatever the lists above show, a brand whose content differs from what was last published
  // isn't up to date (it shows as changed until it's published again).
  let sameAsPublished = true;
  if (before && before === ps.publishedSnapshot) {
    const { onlineStoreAsFound: _flag, ...published } = ps.publishedSnapshot;
    sameAsPublished = contentHash(published) === contentHash(content);
  }
  result.upToDate =
    plan.mode === 'update' &&
    sameAsPublished &&
    fields.length === 0 &&
    plan.addedVariants.length === 0 &&
    plan.removedVariants.length === 0 &&
    variantsUpdated.length === 0 &&
    (!imagesKnown || (plan.newImages.length === 0 && plan.removedImages.length === 0)) &&
    plan.priceChanges.length === 0;
  return result;
}
