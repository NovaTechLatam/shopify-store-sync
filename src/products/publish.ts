import type { Logger } from 'pino';
import { setAlert } from '../alerts/alerts.js';
import {
  dropNewProductStarts,
  refreshInventoryItem,
  removeInventoryItem,
  startUnsoldAtZero,
  withCatalogLock,
} from '../catalog/catalog.js';
import { normalizeSku } from '../catalog/sku.js';
import type { Db, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { withStorePriceLock } from '../pricing/runs.js';
import { ShopifyApiError, ShopifyUserErrors } from '../shopify/client.js';
import { featureStatus, FeatureUnavailableError, requireFeature } from '../shopify/scopes.js';
import type {
  ProductSetIdentifier,
  ProductSetResult,
  ProductVariantSetInputJson,
  ShopifyAdmin,
} from '../shopify/types.js';
import { enqueueTask } from '../tasks/queue.js';
import type { TaskDeps } from '../tasks/types.js';
import type { DesiredContent } from './desired.js';
import { contentHash, desiredContent, leavesOnlineStore } from './desired.js';
import type { MasterProduct, StoreContext } from './model.js';
import { loadMasterProduct, loadStoreContexts } from './model.js';
import { buildProductSetInput } from './plan.js';
import { prepare } from './prepare.js';

/**
 * PUBLISHING (the publish_product task): creates or updates one master product in one store.
 *
 * Safe to run again at any point. productSet has no idempotency key, so:
 *  - an update addresses the product by id and sends its whole state (absolute values);
 *  - a create first looks for a product of the store that already has our SKUs (a previous
 *    attempt that got through, or the merchant's own) and updates it instead; otherwise it
 *    upserts by our custom id (the master product id in a metafield), so a retried create finds
 *    the product the first attempt made.
 * Shopify is never called inside a database transaction.
 *
 * Failures the merchant must fix (permissions, a paused store, SKU conflicts, what Shopify
 * refused) are recorded on the brand's row and end the task. Network trouble and Shopify outages
 * are thrown, so the task runner retries.
 */

/** A reason not to publish that only the merchant can fix. */
export class PublishBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishBlockedError';
  }
}

export async function publishProductTask(
  deps: TaskDeps,
  masterProductId: number,
  storeId: number,
): Promise<void> {
  const { db } = deps;
  const log = deps.logger.child({ masterProductId, storeId });
  const { rows } = await db.query<{ enabled: boolean }>(
    'SELECT enabled FROM master_product_stores WHERE master_product_id = $1 AND store_id = $2',
    [masterProductId, storeId],
  );
  // The product (or the store) was deleted meanwhile: nothing to do.
  if (!rows[0]) return;
  const [store] = await loadStoreContexts(db, [], [storeId]);
  if (!store) return;
  if (!rows[0].enabled) {
    // "Sell here" was turned off after publishing was asked for: back to the last known state.
    await db.query(
      `UPDATE master_product_stores
          SET publish_state = CASE WHEN published_hash IS NULL THEN 'never' ELSE 'published' END,
              updated_at = now()
        WHERE master_product_id = $1 AND store_id = $2 AND publish_state IN ('queued', 'publishing')`,
      [masterProductId, storeId],
    );
    // An earlier attempt that was interrupted may have left starts at 0 for it.
    await dropStartsOf(db, masterProductId);
    return;
  }

  try {
    await requireFeature(db, storeId, 'catalog');
    await setState(db, masterProductId, storeId, 'publishing');
    // Prices are worked out at the start and sent with the product: no price update of the store
    // (a sale starting or ending) may land in between and be overwritten.
    const done = await withStorePriceLock(db, storeId, () =>
      publish(deps, masterProductId, store, log),
    );
    if (done) {
      await resolveFailure(db, masterProductId, storeId);
      log.info({ warnings: done.warnings.length }, 'product published');
    }
  } catch (err) {
    const message = failureMessage(err, store);
    if (message !== null) {
      log.warn({ err }, 'publishing failed');
      await recordFailure(db, masterProductId, store, message);
      // No variant was made: the starts at 0 this publish (or an interrupted one) left go, unless
      // another brand is still publishing the product.
      await dropStartsOf(db, masterProductId);
      return;
    }
    // Worth retrying (network, Shopify outage, our database): say so while waiting.
    log.warn({ err }, 'publishing interrupted; will retry');
    await db.query(
      `UPDATE master_product_stores SET publish_state = 'queued', last_error = $3, updated_at = now()
        WHERE master_product_id = $1 AND store_id = $2`,
      [
        masterProductId,
        storeId,
        `Interrupted, trying again soon: ${err instanceof Error ? err.message : String(err)}`,
      ],
    );
    throw err;
  }
}

/** The message to record for a failure that retrying won't fix; null = retry. */
function failureMessage(err: unknown, store: StoreContext): string | null {
  if (err instanceof PublishBlockedError || err instanceof FeatureUnavailableError) {
    return err.message;
  }
  if (err instanceof ShopifyUserErrors) return userErrorsMessage(err, store);
  if (err instanceof ShopifyApiError) {
    switch (err.kind) {
      case 'auth':
        return (
          `Shopify refused: ${store.name} hasn’t given Store Sync the permission this needs ` +
          `(${err.message}). Check the app’s access scopes, then click “Test connection” on the ` +
          'store’s page and publish again.'
        );
      case 'store_unavailable':
        return `${store.name} isn’t available in Shopify right now (${err.message}).`;
      case 'invalid':
        return `Shopify didn’t accept the request: ${err.message}`;
      case 'transient':
        return null;
    }
  }
  return null;
}

/** What Shopify refused, in words the merchant can act on. */
function userErrorsMessage(err: ShopifyUserErrors, store: StoreContext): string {
  const parts = err.errors.map((e) => {
    if (e.code === 'HANDLE_NOT_UNIQUE') {
      return (
        `the web address (handle) is already used by another product in ${store.name}: ` +
        'choose another handle for this brand'
      );
    }
    return e.message.replace(/\.+$/, '');
  });
  return `${store.name} refused the product: ${[...new Set(parts)].join('; ')}.`;
}

/** Takes back the starts at 0 of a product's items nothing needs any more (see catalog.ts). */
async function dropStartsOf(db: Db, productId: number): Promise<void> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query<{ item_id: number }>(
      'SELECT item_id FROM master_variants WHERE master_product_id = $1',
      [productId],
    );
    await dropNewProductStarts(
      client,
      rows.map((r) => r.item_id),
    );
  });
}

async function setState(db: Queryable, productId: number, storeId: number, state: string) {
  await db.query(
    `UPDATE master_product_stores SET publish_state = $3, updated_at = now()
      WHERE master_product_id = $1 AND store_id = $2`,
    [productId, storeId, state],
  );
}

async function recordFailure(db: Db, productId: number, store: StoreContext, message: string) {
  const { rows } = await db.query<{ title: string }>(
    `UPDATE master_product_stores mps SET publish_state = 'failed', last_error = $3, updated_at = now()
       FROM master_products mp
      WHERE mps.master_product_id = $1 AND mps.store_id = $2 AND mp.id = mps.master_product_id
      RETURNING mp.title`,
    [productId, store.id, message],
  );
  if (!rows[0]) return;
  await setAlert(db, {
    open: true,
    kind: 'catalog_publish_failed',
    dedupeKey: `catalog_publish_failed:${productId}:${store.id}`,
    storeId: store.id,
    message: `“${rows[0].title}” couldn’t be published to ${store.name}: ${message}`,
    details: { masterProductId: productId },
    renotify: true,
  });
}

async function resolveFailure(db: Queryable, productId: number, storeId: number) {
  await setAlert(db, {
    open: false,
    kind: 'catalog_publish_failed',
    dedupeKey: `catalog_publish_failed:${productId}:${storeId}`,
    message: '',
  });
}

/** The publish itself; returns null when the product no longer exists. */
async function publish(
  deps: TaskDeps,
  productId: number,
  store: StoreContext,
  log: Logger,
): Promise<{ warnings: string[] } | null> {
  const { db } = deps;
  const loaded = await loadMasterProduct(db, productId);
  if (!loaded) return null;
  // The store's fixed prices for this product's items (the context was loaded without them).
  const [priced] = await loadStoreContexts(
    db,
    loaded.variants.map((v) => v.itemId),
    [store.id],
  );
  const ctx = priced ?? store;
  const product: MasterProduct = loaded;
  const admin = await deps.shopify.forStore(store.id);

  const prepared = await prepare(deps, product, ctx, 'publish');
  if (prepared.blocked.length || !prepared.plan) {
    throw new PublishBlockedError(prepared.blocked.join(' '));
  }
  const warnings = [...prepared.warnings];
  const { live } = prepared;
  if (prepared.recreated) await unlink(db, productId, store.id);
  if (prepared.adopted) {
    warnings.push(
      `Updated “${prepared.adopted.title}”, which ${store.name} already had with these SKUs.`,
    );
  }

  // Upload what the store doesn't have yet: our uploads through Shopify's staging, URLs as is.
  const content = desiredContent(product, store.id);
  const sources = new Map<number, { originalSource: string; filename?: string }>();
  for (const mediaId of prepared.plan.newImages) {
    const media = product.media.find((m) => m.id === mediaId)!;
    if (media.fileId === null) {
      sources.set(mediaId, { originalSource: media.sourceUrl! });
      continue;
    }
    const file = await loadFile(db, media.fileId);
    const resourceUrl = await admin.stageImage(file);
    sources.set(mediaId, { originalSource: resourceUrl, filename: file.filename });
  }
  const ps = product.stores.get(store.id);
  const plan = buildProductSetInput({
    content,
    pricing: prepared.pricing,
    currencyCode: ctx.currencyCode!,
    live,
    mediaLinks: live && !prepared.adopted ? (ps?.mediaLinks ?? new Map()) : new Map(),
    locationIds: ctx.locationIds,
    sources,
  });

  let identifier: ProductSetIdentifier;
  if (live) {
    identifier = { id: live.id };
  } else {
    if (!ctx.productIdDefinitionAt) {
      await admin.ensureProductIdDefinition();
      await db.query('UPDATE stores SET product_id_definition_at = now() WHERE id = $1', [
        store.id,
      ]);
    }
    identifier = { customId: String(productId) };
  }
  // A SKU no store sells yet starts at 0 with its first publish: written before the product, so
  // the start is there when its new variant is linked below, and still there when an interrupted
  // write is tried again. A SKU the merchant created in a store first keeps that store's number
  // and starts like any other product (startUnsoldAtZero). If the store refuses the product for
  // good, publishProductTask takes the start back (dropNewProductStarts).
  const added = new Set(plan.addedVariants.map((sku) => normalizeSku(sku)));
  const startItems = product.variants
    .filter((v) => added.has(v.normalizedSku))
    .map((v) => v.itemId);
  if (startItems.length) {
    await withCatalogLock(db, (client) =>
      startUnsoldAtZero(client, { itemIds: startItems, storeId: store.id }),
    );
  }
  const result = await admin.productSet({ identifier, input: plan.input, synchronous: true });
  log.debug(
    { productId: result.productId, mode: plan.mode, removed: plan.removedVariants.length },
    'productSet done',
  );

  // Remember the product and which Shopify media each of our images became. New media are the
  // ones not among those we referenced, in the order we sent them.
  const keptIds = new Set(plan.keptImages.values());
  const fresh = result.media.filter((m) => !keptIds.has(m.id));
  if (fresh.length !== plan.newImages.length) {
    warnings.push(
      `${store.name} has ${result.media.length} images for this product, ` +
        `${result.media.length - fresh.length + plan.newImages.length} expected.`,
    );
  }
  const links = new Map(plan.keptImages);
  plan.newImages.forEach((mediaId, i) => {
    const media = fresh[i];
    if (media) links.set(mediaId, media.id);
  });
  await withTransaction(db, async (client) => {
    await client.query(
      `UPDATE master_product_stores SET shopify_product_id = $3, updated_at = now()
        WHERE master_product_id = $1 AND store_id = $2`,
      [productId, store.id, result.productId],
    );
    await client.query(
      `DELETE FROM master_media_links l USING master_media m
        WHERE m.id = l.master_media_id AND m.master_product_id = $1 AND l.store_id = $2`,
      [productId, store.id],
    );
    // Images deleted from the catalog meanwhile are skipped.
    await client.query(
      `INSERT INTO master_media_links (master_media_id, store_id, shopify_media_id)
       SELECT m.id, $2, t.shopify_media_id
         FROM unnest($3::bigint[], $4::text[]) AS t(media_id, shopify_media_id)
         JOIN master_media m ON m.id = t.media_id AND m.master_product_id = $1
       ON CONFLICT (master_media_id, store_id) DO UPDATE SET shopify_media_id = EXCLUDED.shopify_media_id`,
      [productId, store.id, [...links.keys()], [...links.values()]],
    );
  });

  // Link new variants to their items now, not when the next catalog read comes round: stock
  // starts syncing (new items start at 0) as soon as the reconcile runs. Variants already linked
  // and tracked keep their link (same SKU); only the prices we just sent are recorded for them.
  const catalogDeps = { db, shopify: deps.shopify, logger: log };
  for (const v of plan.removedVariants) await removeInventoryItem(db, store.id, v.inventoryItemId);
  const { rows: settled } = await db.query<{ shopify_variant_id: string }>(
    `SELECT shopify_variant_id FROM variants
      WHERE store_id = $1 AND shopify_variant_id = ANY($2::text[]) AND deleted_at IS NULL
        AND item_id IS NOT NULL AND tracked`,
    [store.id, result.variants.map((v) => v.id)],
  );
  const linked = new Set(settled.map((r) => r.shopify_variant_id));
  for (const v of result.variants) {
    if (linked.has(v.id)) continue;
    try {
      await refreshInventoryItem(catalogDeps, store.id, v.inventoryItemId);
    } catch (err) {
      // The webhook Shopify sends does the same a moment later; make sure it happens.
      log.warn({ err, inventoryItemId: v.inventoryItemId }, 'variant link deferred');
      await enqueueTask(db, 'refresh_inventory_item', {
        storeId: store.id,
        inventoryItemId: v.inventoryItemId,
      });
    }
  }

  await recordSentPrices(db, store.id, plan.input.variants ?? [], result.variants);

  // An imported brand's Online Store stays as it was found until the merchant changes it, and so
  // does a product the store already had (adopted): whether it showed there isn't read, and a
  // product kept off the Online Store on purpose (sold in person only) must not appear there.
  const asFound =
    !prepared.recreated &&
    (prepared.adopted !== null || leavesOnlineStore(ps?.publishedSnapshot, content));
  if (!asFound) warnings.push(...(await onlineStore(db, admin, ctx, content, result.productId)));
  await db.query(
    `UPDATE master_product_stores
        SET publish_state = 'published', published_hash = $3, published_snapshot = $4,
            published_at = now(), last_error = NULL, warnings = $5, updated_at = now()
      WHERE master_product_id = $1 AND store_id = $2`,
    [
      productId,
      store.id,
      contentHash(content),
      JSON.stringify(asFound ? { ...content, onlineStoreAsFound: true } : content),
      warnings,
    ],
  );
  return { warnings };
}

/**
 * Our copy of the store's prices (variants.price, what the store charges now) gets what we just
 * sent, so the product doesn't look out of date until the next catalog read.
 */
async function recordSentPrices(
  db: Queryable,
  storeId: number,
  sent: ProductVariantSetInputJson[],
  created: ProductSetResult['variants'],
) {
  const bySku = new Map(sent.map((v) => [normalizeSku(v.sku ?? null), v]));
  const rows = created.flatMap((v) => {
    const input = bySku.get(normalizeSku(v.sku));
    return input?.price === undefined ? [] : [{ id: v.id, input }];
  });
  if (rows.length === 0) return;
  await db.query(
    `UPDATE variants v
        SET price = t.price,
            compare_at_price = CASE WHEN t.set_compare THEN t.compare ELSE v.compare_at_price END,
            updated_at = now()
       FROM unnest($2::text[], $3::numeric[], $4::boolean[], $5::numeric[])
            AS t(id, price, set_compare, compare)
      WHERE v.store_id = $1 AND v.shopify_variant_id = t.id AND v.deleted_at IS NULL`,
    [
      storeId,
      rows.map((r) => r.id),
      rows.map((r) => r.input.price!),
      rows.map((r) => r.input.compareAtPrice !== undefined),
      rows.map((r) => r.input.compareAtPrice ?? null),
    ],
  );
}

/** The linked product is gone from the store: forget it and the media we had there. */
async function unlink(db: Db, productId: number, storeId: number) {
  await withTransaction(db, async (client) => {
    await client.query(
      `UPDATE master_product_stores SET shopify_product_id = NULL, updated_at = now()
        WHERE master_product_id = $1 AND store_id = $2`,
      [productId, storeId],
    );
    await client.query(
      `DELETE FROM master_media_links l USING master_media m
        WHERE m.id = l.master_media_id AND m.master_product_id = $1 AND l.store_id = $2`,
      [productId, storeId],
    );
  });
}

async function loadFile(db: Queryable, fileId: number) {
  const { rows } = await db.query<{ filename: string; mime_type: string; data: Buffer }>(
    'SELECT filename, mime_type, data FROM media_files WHERE id = $1',
    [fileId],
  );
  const file = rows[0];
  if (!file)
    throw new PublishBlockedError(
      'An image of this product is missing. Remove it and upload it again.',
    );
  return { filename: file.filename, mimeType: file.mime_type, data: file.data };
}

/**
 * Shows (or hides) the product in the store's Online Store. Missing permission or no Online
 * Store is a warning: the product itself was saved.
 */
async function onlineStore(
  db: Queryable,
  admin: ShopifyAdmin,
  store: StoreContext,
  content: DesiredContent,
  productId: string,
): Promise<string[]> {
  const show = content.onlineStore && content.status === 'ACTIVE';
  // Not shown and never asked to be: nothing to undo.
  if (!show && content.onlineStore) return [];
  const publishing = featureStatus(store.grantedScopes).publishing;
  if (!publishing.available) {
    return [
      `${store.name} hasn’t given Store Sync permission to change what its Online Store shows ` +
        `(${publishing.missingScopes.join(', ')}). Do it in Shopify, or add the permission.`,
    ];
  }
  try {
    let publicationId = store.onlineStorePublicationId;
    if (!publicationId) {
      publicationId = await admin.findOnlineStorePublication();
      if (!publicationId) return [`${store.name} has no Online Store sales channel.`];
      await db.query('UPDATE stores SET online_store_publication_id = $2 WHERE id = $1', [
        store.id,
        publicationId,
      ]);
    }
    if (show) await admin.publishProduct(productId, publicationId);
    else await admin.unpublishProduct(productId, publicationId);
    return [];
  } catch (err) {
    if (err instanceof ShopifyUserErrors) {
      // Perhaps the publication we remembered is gone: look it up again next time.
      await db.query('UPDATE stores SET online_store_publication_id = NULL WHERE id = $1', [
        store.id,
      ]);
      return [`${store.name}’s Online Store didn’t take the change: ${err.message}`];
    }
    if (err instanceof ShopifyApiError && err.kind === 'auth') {
      return [`${store.name} refused the Online Store change: ${err.message}`];
    }
    throw err;
  }
}
