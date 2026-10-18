import {
  BulkOperationInProgressError,
  ShopifyApiError,
  ShopifyUserErrors,
  type ShopifyUserError,
} from '../../src/shopify/client.js';
import type {
  BulkOperationInfo,
  BulkOperationStatus,
  FileSetInputJson,
  LevelQuantities,
  MediaStatus,
  ProductSetRequest,
  ProductSetResult,
  ProductStatus,
  SetAvailableInput,
  SetAvailableResult,
  ShopInfo,
  ShopifyAdmin,
  ShopifyLocation,
  ShopifyOrder,
  ShopifyOrderLine,
  ShopifyProduct,
  ShopifyVariant,
  VariantPriceInput,
  WebhookSubscription,
  WeightUnit,
} from '../../src/shopify/types.js';
import { OPTIONAL_WEBHOOK_TOPICS } from '../../src/webhooks/topics.js';

export interface LevelChange {
  inventoryItemId: string;
  locationId: string;
  available: number;
  /** `api` = written through this fake's ShopifyAdmin API (i.e. by the sync engine). */
  source: 'api' | 'external';
}

type FaultMode = 'throw_before' | 'throw_after';

/** Operations `failNext` can make fail. */
export type FakeOp =
  | 'setAvailable'
  | 'readAvailable'
  | 'getProduct'
  | 'productSet'
  | 'stageImage'
  | 'publishProduct'
  | 'unpublishProduct'
  | 'updateVariantPrices'
  | 'updateInventoryItemCost'
  | 'getOrder'
  | 'listOrdersUpdatedSince'
  | 'startOrdersBulkExport'
  | 'getBulkOperation'
  | 'createWebhookSubscription';

/** A product as the fake keeps it; its variants live in `FakeShop.variants` (+ details). */
interface FakeProduct {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: ProductStatus;
  seo: { title: string | null; description: string | null };
  options: { id: string; name: string; position: number; values: { id: string; name: string }[] }[];
  media: FakeMedia[];
  /** Our master product id (the custom-id metafield), when productSet set one. */
  customId: string | null;
}

interface FakeMedia {
  id: string;
  alt: string;
  status: MediaStatus;
  url: string | null;
  /** The originalSource it was created from (a URL or a staged upload's resourceUrl). */
  source: string | null;
}

/** What a product variant has beyond the ShopifyVariant the stock sync uses. */
interface VariantDetails {
  position: number;
  taxable: boolean;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  selectedOptions: { name: string; value: string }[];
  mediaId: string | null;
  requiresShipping: boolean;
  weight: { unit: WeightUnit; value: number } | null;
  unitCost: number | null;
}

/** For `addOrder`: everything optional; a line with only `variantId` takes its SKU from the shop. */
export type OrderInput = Partial<Omit<ShopifyOrder, 'lines'>> & {
  lines?: Partial<ShopifyOrderLine>[];
};

/**
 * In-memory Shopify shop that implements the same port as the real GraphQL client, with the
 * semantics the sync engine relies on: compare-and-set writes (changeFromQuantity) and 24h
 * idempotency keys (cached success, IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED after a failure).
 * Tests can inject concurrent changes and network faults.
 *
 * It also models what the features use: products (productSet with Shopify's replace semantics),
 * staged uploads, the Online Store publication, prices and costs, orders and bulk exports. Methods
 * that need an optional scope throw ShopifyApiError(kind 'auth') without it, as Shopify answers
 * ACCESS_DENIED.
 */
export class FakeShop implements ShopifyAdmin {
  readonly locations: ShopifyLocation[] = [];
  /** Every variant of every product (what listVariants returns), in creation order. */
  readonly variants: ShopifyVariant[] = [];
  private readonly levels = new Map<string, number>();
  private readonly committed = new Map<string, number>();
  private readonly unavailable = new Map<string, number>();
  private readonly inactive = new Map<string, number>();
  private readonly idempotency = new Map<
    string,
    { fingerprint: string; result: SetAvailableResult }
  >();
  readonly subscriptions: WebhookSubscription[] = [];
  /** Every quantity change, in order. Tests turn these into webhooks. */
  readonly changes: LevelChange[] = [];
  readonly calls: { op: string; args: unknown }[] = [];

  private readonly products = new Map<string, FakeProduct>();
  private readonly details = new Map<string, VariantDetails>();
  /** Images uploaded through stageImage. */
  readonly stagedUploads: {
    filename: string;
    mimeType: string;
    data: Buffer;
    resourceUrl: string;
  }[] = [];
  readonly publications: { id: string; name: string }[] = [
    { id: `gid://shopify/Publication/${nextGlobalId()}`, name: 'Online Store' },
  ];
  /** productId → publication ids it is published to. */
  readonly published = new Map<string, Set<string>>();
  /** Set once ensureProductIdDefinition has run. */
  productIdDefinition = false;
  readonly orders: ShopifyOrder[] = [];
  /** Orders per page of listOrdersUpdatedSince. */
  orderPageSize = 10;
  readonly bulkOperations = new Map<string, BulkOperationInfo>();
  /** JSONL of finished exports, by their url (serve them with `bulkFetch`). */
  readonly bulkFiles = new Map<string, string>();
  /** Makes startOrdersBulkExport refuse, as when another export is still running. */
  bulkBusy = false;
  /** How a new export starts: COMPLETED at once (default) or RUNNING until finishBulkOperation. */
  bulkStartStatus: 'COMPLETED' | 'RUNNING' = 'COMPLETED';
  /** Topics Shopify refuses whatever the scopes (protected customer data not approved). */
  readonly refusedTopics = new Set<string>();

  /** Runs before a setAvailable is evaluated (after the request "reaches" Shopify). */
  beforeSet?: (input: SetAvailableInput) => void;
  /** Runs before readAvailable returns. */
  afterRead?: (locationId: string, ids: string[]) => void;
  private faults: { op: FakeOp; mode: FaultMode }[] = [];
  private nextId = 1;
  private lastOrderUpdate = 0;

  currencyCode = 'USD';
  ianaTimezone = 'America/New_York';
  weightUnit: WeightUnit = 'GRAMS';

  constructor(
    readonly domain: string,
    readonly name = domain,
  ) {}

  // ---- test helpers -------------------------------------------------------------------------

  addLocation(name = 'Warehouse', isActive = true): string {
    const id = `gid://shopify/Location/${nextGlobalId()}`;
    this.locations.push({ id, name, isActive });
    return id;
  }

  addVariant(sku: string | null, opts: Partial<ShopifyVariant> = {}): ShopifyVariant {
    const n = nextGlobalId();
    const variant: ShopifyVariant = {
      productId: opts.productId ?? `gid://shopify/Product/${n}`,
      variantId: `gid://shopify/ProductVariant/${n}`,
      inventoryItemId: `gid://shopify/InventoryItem/${n}`,
      sku,
      barcode: opts.barcode ?? null,
      productTitle: opts.productTitle ?? `Product ${sku ?? n}`,
      variantTitle: opts.variantTitle ?? 'Default Title',
      tracked: opts.tracked ?? true,
      isBundle: opts.isBundle ?? false,
      price: opts.price ?? null,
      compareAtPrice: opts.compareAtPrice ?? null,
    };
    this.variants.push(variant);
    return variant;
  }

  /**
   * A product with options, variants and images, as if created in the Shopify admin (same
   * semantics and validation as productSet, without the scope check or the call log).
   */
  addProduct(input: ProductSetRequest['input']): ProductSetResult {
    return this.applyProductSet({ identifier: null, input });
  }

  /** Deletes a variant (and with it its inventory item), as deleting it in the Shopify admin does. */
  removeVariant(variantId: string): void {
    const idx = this.variants.findIndex((v) => v.variantId === variantId);
    if (idx < 0) throw new Error(`no variant ${variantId}`);
    const [removed] = this.variants.splice(idx, 1);
    this.details.delete(variantId);
    for (const k of [...this.levels.keys()])
      if (k.startsWith(`${removed!.inventoryItemId}|`)) this.levels.delete(k);
  }

  /** Deletes a product and its variants, as the Shopify admin does. */
  removeProduct(productId: string): void {
    for (const v of this.variants.filter((x) => x.productId === productId))
      this.removeVariant(v.variantId);
    this.products.delete(productId);
    this.published.delete(productId);
  }

  /** An inactive level (not stocked, invisible to reads) that still holds a quantity. */
  stockInactive(inventoryItemId: string, locationId: string, available: number): void {
    const k = key(inventoryItemId, locationId);
    this.levels.delete(k);
    this.inactive.set(k, available);
  }

  /** Stocks the item at the location with `available` units (no change event). */
  stock(inventoryItemId: string, locationId: string, available: number): void {
    this.levels.set(key(inventoryItemId, locationId), available);
  }

  level(inventoryItemId: string, locationId: string): number | undefined {
    return this.levels.get(key(inventoryItemId, locationId));
  }

  /** A change made outside the sync engine: an order, a staff edit, a POS sale, a restock... */
  externalAdjust(inventoryItemId: string, locationId: string, delta: number): number {
    const k = key(inventoryItemId, locationId);
    const current = this.levels.get(k);
    if (current === undefined) throw new Error(`not stocked: ${k}`);
    const next = current + delta;
    this.levels.set(k, next);
    this.changes.push({ inventoryItemId, locationId, available: next, source: 'external' });
    return next;
  }

  /** An order is placed: units move from available to committed (as Shopify does). */
  placeOrder(inventoryItemId: string, locationId: string, qty: number): void {
    this.externalAdjust(inventoryItemId, locationId, -qty);
    const k = key(inventoryItemId, locationId);
    this.committed.set(k, (this.committed.get(k) ?? 0) + qty);
  }

  /** Staff move units out of "available" into an unsellable state (damaged, safety stock...). */
  markUnavailable(inventoryItemId: string, locationId: string, qty: number): void {
    this.externalAdjust(inventoryItemId, locationId, -qty);
    const k = key(inventoryItemId, locationId);
    this.unavailable.set(k, (this.unavailable.get(k) ?? 0) + qty);
  }

  /** An order is fulfilled: committed units leave; available doesn't change. */
  fulfillOrder(inventoryItemId: string, locationId: string, qty: number): void {
    const k = key(inventoryItemId, locationId);
    this.committed.set(k, (this.committed.get(k) ?? 0) - qty);
  }

  /** Makes the next matching call fail with a transient network error, before or after it takes effect. */
  failNext(op: FakeOp, mode: FaultMode): void {
    this.faults.push({ op, mode });
  }

  /** Forget idempotency keys, as Shopify does after 24 hours. */
  expireIdempotencyKeys(): void {
    this.idempotency.clear();
  }

  /** Whether a product is visible in a publication (default: the Online Store). */
  isPublished(productId: string, publicationId = this.publications[0]!.id): boolean {
    return this.published.get(productId)?.has(publicationId) ?? false;
  }

  /** The product's custom id (our master product id), if it has one. */
  customIdOf(productId: string): string | null {
    return this.products.get(productId)?.customId ?? null;
  }

  /**
   * An order placed in this store (only the record: stock is changed with placeOrder). Its
   * updatedAt is later than every order's before, unless given.
   */
  addOrder(input: OrderInput = {}): ShopifyOrder {
    const n = nextGlobalId();
    const updatedAt = input.updatedAt ?? this.nextUpdatedAt();
    const order: ShopifyOrder = {
      id: input.id ?? `gid://shopify/Order/${n}`,
      name: input.name ?? `#${1001 + this.orders.length}`,
      processedAt: input.processedAt ?? updatedAt,
      updatedAt,
      cancelledAt: input.cancelledAt ?? null,
      test: input.test ?? false,
      currencyCode: input.currencyCode ?? this.currencyCode,
      sourceName: input.sourceName === undefined ? 'web' : input.sourceName,
      taxesIncluded: input.taxesIncluded ?? false,
      lines: (input.lines ?? []).map((l) => this.orderLine(l)),
    };
    this.orders.push(order);
    return structuredClone(order);
  }

  /** Changes an order (a refund, an edit, a cancellation) and bumps its updatedAt. */
  updateOrder(orderId: string, patch: OrderInput): ShopifyOrder {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) throw new Error(`no order ${orderId}`);
    const { lines, ...fields } = patch;
    Object.assign(order, fields, { updatedAt: patch.updatedAt ?? this.nextUpdatedAt() });
    if (lines) order.lines = lines.map((l) => this.orderLine(l));
    return structuredClone(order);
  }

  deleteOrder(orderId: string): void {
    const idx = this.orders.findIndex((o) => o.id === orderId);
    if (idx >= 0) this.orders.splice(idx, 1);
  }

  /** Ends a RUNNING export: COMPLETED (with its file) or failed. */
  finishBulkOperation(
    id: string,
    status: Exclude<BulkOperationStatus, 'CREATED' | 'RUNNING'> = 'COMPLETED',
    errorCode: string | null = null,
  ): void {
    const op = this.bulkOperations.get(id);
    if (!op) throw new Error(`no bulk operation ${id}`);
    const pending = this.pendingBulk.get(id);
    op.status = status;
    op.errorCode = errorCode;
    op.completedAt = new Date().toISOString();
    if (status === 'COMPLETED' && pending) {
      op.url = pending.url;
      op.objectCount = pending.objectCount;
    }
    this.pendingBulk.delete(id);
  }

  /** A fetch that serves the export files (for the code that downloads them). */
  readonly bulkFetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const text = this.bulkFiles.get(url);
    return text === undefined
      ? new Response('not found', { status: 404 })
      : new Response(text, { status: 200, headers: { 'content-type': 'application/jsonl' } });
  }) as typeof fetch;

  // ---- ShopifyAdmin --------------------------------------------------------------------------

  scopes = ['read_products', 'read_inventory', 'write_inventory', 'read_locations'];

  async getShop(): Promise<ShopInfo> {
    return {
      name: this.name,
      myshopifyDomain: this.domain,
      scopes: [...this.scopes],
      currencyCode: this.currencyCode,
      ianaTimezone: this.ianaTimezone,
      weightUnit: this.weightUnit,
    };
  }

  async listLocations(): Promise<ShopifyLocation[]> {
    return this.locations.map((l) => ({ ...l }));
  }

  async listVariants(): Promise<ShopifyVariant[]> {
    return this.variants.map((v) => ({ ...v }));
  }

  async listProductVariants(productId: string): Promise<ShopifyVariant[] | null> {
    const variants = this.variants.filter((v) => v.productId === productId);
    return variants.length ? variants.map((v) => ({ ...v })) : null;
  }

  async listVariantsByInventoryItem(inventoryItemId: string): Promise<ShopifyVariant[]> {
    return this.variants
      .filter((v) => v.inventoryItemId === inventoryItemId)
      .map((v) => ({ ...v }));
  }

  async readAvailable(
    locationId: string,
    inventoryItemIds: string[],
  ): Promise<Map<string, number | null>> {
    this.calls.push({ op: 'readAvailable', args: { locationId, inventoryItemIds } });
    const fault = this.takeFault('readAvailable');
    if (fault) throw new ShopifyApiError('fake network error', 'transient');
    const out = new Map<string, number | null>();
    for (const id of inventoryItemIds) out.set(id, this.levels.get(key(id, locationId)) ?? null);
    this.afterRead?.(locationId, inventoryItemIds);
    return out;
  }

  async readLevels(
    locationId: string,
    inventoryItemIds: string[],
  ): Promise<Map<string, LevelQuantities | null>> {
    this.calls.push({ op: 'readLevels', args: { locationId, inventoryItemIds } });
    const fault = this.takeFault('readAvailable');
    if (fault) throw new ShopifyApiError('fake network error', 'transient');
    const out = new Map<string, LevelQuantities | null>();
    for (const id of inventoryItemIds) {
      const k = key(id, locationId);
      const available = this.levels.get(k);
      out.set(
        id,
        available === undefined
          ? null
          : {
              available,
              committed: this.committed.get(k) ?? 0,
              unavailable: this.unavailable.get(k) ?? 0,
            },
      );
    }
    this.afterRead?.(locationId, inventoryItemIds);
    return out;
  }

  async setAvailable(input: SetAvailableInput): Promise<SetAvailableResult> {
    this.calls.push({ op: 'setAvailable', args: input });
    const fault = this.takeFault('setAvailable');
    if (fault?.mode === 'throw_before')
      throw new ShopifyApiError('fake network error', 'transient');

    const fingerprint = JSON.stringify([
      input.inventoryItemId,
      input.locationId,
      input.changeFrom,
      input.quantity,
    ]);
    const cached = this.idempotency.get(input.idempotencyKey);
    let result: SetAvailableResult;
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        result = { status: 'rejected', message: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH' };
      } else {
        result =
          cached.result.status === 'applied' ? { status: 'applied' } : { status: 'not_applied' };
      }
    } else {
      this.beforeSet?.(input);
      const k = key(input.inventoryItemId, input.locationId);
      const current = this.levels.get(k);
      if (current === undefined) {
        result = { status: 'not_stocked' };
      } else if (input.quantity < 0) {
        result = { status: 'rejected', message: 'INVALID_QUANTITY_NEGATIVE' };
      } else if (current !== input.changeFrom) {
        result = { status: 'stale' };
      } else {
        this.levels.set(k, input.quantity);
        this.changes.push({
          inventoryItemId: input.inventoryItemId,
          locationId: input.locationId,
          available: input.quantity,
          source: 'api',
        });
        result = { status: 'applied' };
      }
      this.idempotency.set(input.idempotencyKey, { fingerprint, result });
    }

    if (fault?.mode === 'throw_after')
      throw new ShopifyApiError('fake timeout after commit', 'transient');
    return result;
  }

  async activateInventory(inventoryItemId: string, locationId: string): Promise<void> {
    this.calls.push({ op: 'activateInventory', args: { inventoryItemId, locationId } });
    const k = key(inventoryItemId, locationId);
    // Since 2026-04 activating keeps the quantity an inactive level still holds.
    if (!this.levels.has(k)) this.levels.set(k, this.inactive.get(k) ?? 0);
    this.inactive.delete(k);
  }

  async listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
    return this.subscriptions.map((s) => ({ ...s }));
  }

  async createWebhookSubscription(topic: string, uri: string): Promise<void> {
    this.calls.push({ op: 'createWebhookSubscription', args: { topic, uri } });
    this.fault('createWebhookSubscription', 'throw_before');
    // Orders topics need their scope, and Shopify's approval for protected customer data.
    const scope = OPTIONAL_WEBHOOK_TOPICS.find((t) => t.topic === topic)?.scope;
    if (scope && !this.hasScope(scope)) {
      throw userErrors(`webhookSubscriptionCreate(${topic}) failed`, [
        {
          code: null,
          field: ['topic'],
          message: `Access denied for topic ${topic}: needs ${scope}`,
        },
      ]);
    }
    if (this.refusedTopics.has(topic)) {
      throw userErrors(`webhookSubscriptionCreate(${topic}) failed`, [
        {
          code: null,
          field: ['webhookSubscription'],
          message:
            'This app is not approved to subscribe to webhook topics containing protected customer data.',
        },
      ]);
    }
    this.subscriptions.push({
      id: `gid://shopify/WebhookSubscription/${this.nextId++}`,
      topic,
      uri,
    });
  }

  async deleteWebhookSubscription(id: string): Promise<void> {
    const idx = this.subscriptions.findIndex((s) => s.id === id);
    if (idx >= 0) this.subscriptions.splice(idx, 1);
  }

  // ---- products ------------------------------------------------------------------------------

  async getProduct(productId: string): Promise<ShopifyProduct | null> {
    this.calls.push({ op: 'getProduct', args: { productId } });
    this.requireScope('read_products', 'product');
    this.fault('getProduct', 'throw_before');
    const product = this.productRecord(productId);
    if (!product) return null;
    return {
      id: product.id,
      title: product.title,
      handle: product.handle,
      descriptionHtml: product.descriptionHtml,
      vendor: product.vendor,
      productType: product.productType,
      tags: [...product.tags],
      status: product.status,
      seo: { ...product.seo },
      options: product.options.map((o) => ({ ...o, values: o.values.map((v) => ({ ...v })) })),
      media: product.media.map((m) => ({ id: m.id, alt: m.alt, status: m.status, url: m.url })),
      variants: this.productVariants(productId).map((v) => {
        const d = this.detailsOf(v);
        return {
          id: v.variantId,
          sku: v.sku,
          title: v.variantTitle,
          position: d.position,
          barcode: v.barcode,
          price: v.price ?? 0,
          compareAtPrice: v.compareAtPrice,
          taxable: d.taxable,
          inventoryPolicy: d.inventoryPolicy,
          selectedOptions: d.selectedOptions.map((o) => ({ ...o })),
          mediaId: d.mediaId,
          inventoryItemId: v.inventoryItemId,
          tracked: v.tracked,
          requiresShipping: d.requiresShipping,
          weight: d.weight ? { ...d.weight } : null,
          unitCost: d.unitCost,
        };
      }),
    };
  }

  async ensureProductIdDefinition(): Promise<void> {
    this.calls.push({ op: 'ensureProductIdDefinition', args: {} });
    this.requireScope('write_products', 'metafieldDefinitionCreate');
    this.productIdDefinition = true;
  }

  async productSet(req: ProductSetRequest): Promise<ProductSetResult> {
    this.calls.push({ op: 'productSet', args: structuredClone(req) });
    this.requireScope('write_products', 'productSet');
    this.fault('productSet', 'throw_before');
    const result = this.applyProductSet(req);
    this.fault('productSet', 'throw_after');
    return result;
  }

  async stageImage(file: { filename: string; mimeType: string; data: Buffer }): Promise<string> {
    this.calls.push({
      op: 'stageImage',
      args: { filename: file.filename, mimeType: file.mimeType, size: file.data.length },
    });
    this.requireScope('write_products', 'stagedUploadsCreate');
    this.fault('stageImage', 'throw_before');
    const resourceUrl = `https://shopify-staged-uploads.storage.googleapis.com/tmp/${nextGlobalId()}/${encodeURIComponent(file.filename)}`;
    this.stagedUploads.push({ ...file, data: Buffer.from(file.data), resourceUrl });
    return resourceUrl;
  }

  async findOnlineStorePublication(): Promise<string | null> {
    this.calls.push({ op: 'findOnlineStorePublication', args: {} });
    this.requireScope('read_publications', 'publications');
    return this.publications.find((p) => p.name === 'Online Store')?.id ?? null;
  }

  async publishProduct(productId: string, publicationId: string): Promise<void> {
    this.calls.push({ op: 'publishProduct', args: { productId, publicationId } });
    this.requireScope('write_publications', 'publishablePublish');
    this.fault('publishProduct', 'throw_before');
    this.checkPublishable(productId, publicationId, 'publish');
    const set = this.published.get(productId) ?? new Set<string>();
    set.add(publicationId);
    this.published.set(productId, set);
  }

  async unpublishProduct(productId: string, publicationId: string): Promise<void> {
    this.calls.push({ op: 'unpublishProduct', args: { productId, publicationId } });
    this.requireScope('write_publications', 'publishableUnpublish');
    this.fault('unpublishProduct', 'throw_before');
    this.checkPublishable(productId, publicationId, 'unpublish');
    this.published.get(productId)?.delete(publicationId);
  }

  async updateVariantPrices(
    productId: string,
    variants: VariantPriceInput[],
  ): Promise<{ failed: { variantId: string | null; message: string }[] }> {
    this.calls.push({
      op: 'updateVariantPrices',
      args: { productId, variants: structuredClone(variants) },
    });
    this.requireScope('write_products', 'productVariantsBulkUpdate');
    this.fault('updateVariantPrices', 'throw_before');
    if (!this.productRecord(productId))
      return { failed: [{ variantId: null, message: 'Product does not exist' }] };
    const failed: { variantId: string | null; message: string }[] = [];
    for (const input of variants) {
      const variant = this.variants.find(
        (v) => v.variantId === input.id && v.productId === productId,
      );
      const price = Number(input.price);
      const compareAt =
        input.compareAtPrice === undefined || input.compareAtPrice === null
          ? input.compareAtPrice
          : Number(input.compareAtPrice);
      if (!variant) {
        failed.push({ variantId: input.id, message: 'Product variant does not exist' });
      } else if (!Number.isFinite(price) || price < 0) {
        failed.push({ variantId: input.id, message: 'Price must be greater than or equal to 0' });
      } else if (typeof compareAt === 'number' && (!Number.isFinite(compareAt) || compareAt < 0)) {
        failed.push({
          variantId: input.id,
          message: 'Compare at price must be greater than or equal to 0',
        });
      } else {
        variant.price = price;
        if (compareAt !== undefined) variant.compareAtPrice = compareAt;
      }
    }
    this.fault('updateVariantPrices', 'throw_after');
    return { failed };
  }

  async updateInventoryItemCost(inventoryItemId: string, cost: string): Promise<void> {
    this.calls.push({ op: 'updateInventoryItemCost', args: { inventoryItemId, cost } });
    this.requireScope('write_inventory', 'inventoryItemUpdate');
    this.fault('updateInventoryItemCost', 'throw_before');
    const variant = this.variants.find((v) => v.inventoryItemId === inventoryItemId);
    if (!variant) {
      throw userErrors('Shopify didn’t accept the cost', [
        { code: null, field: ['id'], message: 'Inventory item does not exist' },
      ]);
    }
    const value = Number(cost);
    if (!Number.isFinite(value) || value < 0) {
      throw userErrors('Shopify didn’t accept the cost', [
        {
          code: null,
          field: ['input', 'cost'],
          message: 'Cost must be greater than or equal to 0',
        },
      ]);
    }
    this.detailsOf(variant).unitCost = value;
  }

  // ---- orders --------------------------------------------------------------------------------

  async getOrder(orderId: string): Promise<ShopifyOrder | null> {
    this.calls.push({ op: 'getOrder', args: { orderId } });
    this.requireScope('read_orders', 'order');
    this.fault('getOrder', 'throw_before');
    const order = this.orders.find((o) => o.id === orderId);
    return order ? structuredClone(order) : null;
  }

  async listOrdersUpdatedSince(
    since: string,
    after: string | null,
  ): Promise<{ orders: ShopifyOrder[]; nextCursor: string | null }> {
    this.calls.push({ op: 'listOrdersUpdatedSince', args: { since, after } });
    this.requireScope('read_orders', 'orders');
    this.fault('listOrdersUpdatedSince', 'throw_before');
    const matching = this.ordersUpdatedSince(since);
    // Like Shopify's cursors, ours mark a position in the sort order (update time, id), not an
    // offset: an order updated between two pages moves to the end and is read again later,
    // while the ones after the cursor are not skipped.
    const start =
      after === null ? 0 : matching.findIndex((o) => compareOrders(o, decodeCursor(after)) > 0);
    const from = start < 0 ? matching.length : start;
    const page = matching.slice(from, from + this.orderPageSize);
    const last = page[page.length - 1];
    return {
      orders: page.map((o) => structuredClone(o)),
      nextCursor:
        last && from + page.length < matching.length ? `${last.updatedAt}|${last.id}` : null,
    };
  }

  async startOrdersBulkExport(since: string): Promise<{ operationId: string }> {
    this.calls.push({ op: 'startOrdersBulkExport', args: { since } });
    this.requireScope('read_orders', 'bulkOperationRunQuery');
    this.fault('startOrdersBulkExport', 'throw_before');
    if (this.bulkBusy) {
      throw new BulkOperationInProgressError(
        'Shopify is already running another export for this store: A bulk query operation for this app and shop is already in progress',
      );
    }
    const n = nextGlobalId();
    const id = `gid://shopify/BulkOperation/${n}`;
    // Children before their parent, as Shopify may write them (groupObjects is off by default).
    const lines: string[] = [];
    const orders = this.ordersUpdatedSince(since);
    for (const order of orders) {
      for (const line of order.lines) lines.push(JSON.stringify(bulkLine(line, order.id)));
      lines.push(JSON.stringify(bulkOrder(order)));
    }
    const url = lines.length ? `https://storage.googleapis.com/shopify-bulk/${n}.jsonl` : null;
    if (url) this.bulkFiles.set(url, lines.map((l) => `${l}\n`).join(''));
    const now = new Date().toISOString();
    const running = this.bulkStartStatus === 'RUNNING';
    if (running) this.pendingBulk.set(id, { url, objectCount: lines.length });
    this.bulkOperations.set(id, {
      id,
      status: running ? 'RUNNING' : 'COMPLETED',
      errorCode: null,
      url: running ? null : url,
      partialDataUrl: null,
      objectCount: running ? 0 : lines.length,
      createdAt: now,
      completedAt: running ? null : now,
    });
    return { operationId: id };
  }

  async getBulkOperation(id: string): Promise<BulkOperationInfo | null> {
    this.calls.push({ op: 'getBulkOperation', args: { id } });
    this.fault('getBulkOperation', 'throw_before');
    const op = this.bulkOperations.get(id);
    return op ? { ...op } : null;
  }

  // ---- internals -----------------------------------------------------------------------------

  /** Results of RUNNING exports, published when they finish. */
  private readonly pendingBulk = new Map<string, { url: string | null; objectCount: number }>();

  private hasScope(scope: string): boolean {
    return this.scopes.includes(scope) || this.scopes.includes(scope.replace(/^read_/, 'write_'));
  }

  /** What Shopify answers without the scope: ACCESS_DENIED, which the client throws as `auth`. */
  private requireScope(scope: string, field: string): void {
    if (!this.hasScope(scope)) {
      throw new ShopifyApiError(
        `Shopify GraphQL error: Access denied for ${field} field. Required access: \`${scope}\` access scope.`,
        'auth',
      );
    }
  }

  private fault(op: FakeOp, mode: FaultMode): void {
    const idx = this.faults.findIndex((f) => f.op === op && f.mode === mode);
    if (idx < 0) return;
    this.faults.splice(idx, 1);
    throw new ShopifyApiError(
      mode === 'throw_before' ? 'fake network error' : 'fake timeout after commit',
      'transient',
    );
  }

  private takeFault(op: FakeOp) {
    const idx = this.faults.findIndex((f) => f.op === op);
    if (idx < 0) return undefined;
    return this.faults.splice(idx, 1)[0];
  }

  private nextUpdatedAt(): string {
    const t = Math.max(Date.now(), this.lastOrderUpdate + 1);
    this.lastOrderUpdate = t;
    return new Date(t).toISOString();
  }

  private ordersUpdatedSince(since: string): ShopifyOrder[] {
    const from = Date.parse(since);
    return this.orders.filter((o) => Date.parse(o.updatedAt) >= from).sort(compareOrders);
  }

  private orderLine(l: Partial<ShopifyOrderLine>): ShopifyOrderLine {
    const variant = l.variantId
      ? this.variants.find((v) => v.variantId === l.variantId)
      : undefined;
    const quantity = l.quantity ?? 1;
    const currentQuantity = l.currentQuantity ?? quantity;
    const unitPrice = l.unitPrice ?? variant?.price ?? 0;
    const discounts = l.discounts ?? 0;
    return {
      id: l.id ?? `gid://shopify/LineItem/${nextGlobalId()}`,
      sku: l.sku !== undefined ? l.sku : (variant?.sku ?? null),
      quantity,
      currentQuantity,
      isGiftCard: l.isGiftCard ?? false,
      variantId: l.variantId ?? null,
      inventoryItemId: l.inventoryItemId ?? variant?.inventoryItemId ?? null,
      unitPrice,
      discounts,
      net: l.net ?? Math.max(0, unitPrice * currentQuantity - discounts),
    };
  }

  private productVariants(productId: string): ShopifyVariant[] {
    return this.variants
      .filter((v) => v.productId === productId)
      .sort((a, b) => this.detailsOf(a).position - this.detailsOf(b).position);
  }

  private detailsOf(v: ShopifyVariant): VariantDetails {
    let d = this.details.get(v.variantId);
    if (!d) {
      // A variant made with addVariant: give it what Shopify would have.
      const siblings = this.variants.filter((x) => x.productId === v.productId);
      d = {
        position: siblings.indexOf(v) + 1,
        taxable: true,
        inventoryPolicy: 'DENY',
        selectedOptions: [{ name: 'Title', value: v.variantTitle }],
        mediaId: null,
        requiresShipping: true,
        weight: null,
        unitCost: null,
      };
      this.details.set(v.variantId, d);
    }
    return d;
  }

  /** The product, made up from its variants when they were added with addVariant. */
  private productRecord(productId: string): FakeProduct | undefined {
    const known = this.products.get(productId);
    if (known) return known;
    const variants = this.variants.filter((v) => v.productId === productId);
    if (!variants.length) return undefined;
    const title = variants[0]!.productTitle;
    const product: FakeProduct = {
      id: productId,
      title,
      handle: this.uniqueHandle(slug(title), productId),
      descriptionHtml: '',
      vendor: '',
      productType: '',
      tags: [],
      status: 'ACTIVE',
      seo: { title: null, description: null },
      options: [
        {
          id: `gid://shopify/ProductOption/${nextGlobalId()}`,
          name: 'Title',
          position: 1,
          values: [...new Set(variants.map((v) => v.variantTitle))].map((name) => ({
            id: `gid://shopify/ProductOptionValue/${nextGlobalId()}`,
            name,
          })),
        },
      ],
      media: [],
      customId: null,
    };
    this.products.set(productId, product);
    return product;
  }

  private uniqueHandle(base: string, exceptId: string | null): string {
    const taken = (h: string) =>
      [...this.products.values()].some((p) => p.handle === h && p.id !== exceptId);
    let handle = base || 'product';
    for (let i = 1; taken(handle); i++) handle = `${base}-${i}`;
    return handle;
  }

  private checkPublishable(productId: string, publicationId: string, verb: string): void {
    const errors: ShopifyUserError[] = [];
    if (!this.productRecord(productId))
      errors.push({ code: null, field: ['id'], message: 'Product does not exist' });
    if (!this.publications.some((p) => p.id === publicationId))
      errors.push({
        code: null,
        field: ['input', '0', 'publicationId'],
        message: 'Publication does not exist',
      });
    if (errors.length) throw userErrors(`Shopify didn’t ${verb} the product`, errors);
  }

  /**
   * productSet as Shopify documents it: by id (update only), by custom id (create or update) or
   * neither (create). Fields left out stay as they are; lists sent (options with variants,
   * files, tags) replace what the product has, so variants and images left out are deleted. New
   * variants get a new inventory item. Everything is validated before anything changes.
   */
  private applyProductSet(req: ProductSetRequest): ProductSetResult {
    const { identifier, input } = req;
    const errors: ShopifyUserError[] = [];
    const fail = (code: string, field: string[], message: string) =>
      errors.push({ code, field, message });

    let product: FakeProduct | undefined;
    if (identifier && 'id' in identifier) {
      product = this.productRecord(identifier.id);
      if (!product) {
        throw userErrors('Shopify didn’t accept the product', [
          {
            code: 'PRODUCT_DOES_NOT_EXIST',
            field: ['identifier', 'id'],
            message: 'Product does not exist',
          },
        ]);
      }
    } else if (identifier && 'customId' in identifier) {
      product = [...this.products.values()].find((p) => p.customId === identifier.customId);
    }
    const creating = !product;
    const existingVariants = product ? this.productVariants(product.id) : [];

    if (creating && !input.title?.trim()) fail('BLANK', ['input', 'title'], 'Title can’t be blank');
    // Options and variants go together; without both nothing else is worth checking.
    if ((input.productOptions === undefined) !== (input.variants === undefined)) {
      throw userErrors('Shopify didn’t accept the product', [
        input.variants
          ? {
              code: 'PRODUCT_OPTIONS_INPUT_MISSING',
              field: ['input', 'productOptions'],
              message: 'Must specify product options when updating variants',
            }
          : {
              code: 'VARIANTS_INPUT_MISSING',
              field: ['input', 'variants'],
              message: 'Must specify variants when updating options',
            },
      ]);
    }
    if (input.handle !== undefined) {
      const owner = [...this.products.values()].find(
        (p) => p.handle === input.handle && p.id !== product?.id,
      );
      if (owner)
        fail(
          'HANDLE_NOT_UNIQUE',
          ['input', 'handle'],
          `Handle '${input.handle}' already in use. Please provide a new handle.`,
        );
    }

    // Options and values given by id or by name keep their ids; new ones get ids.
    const options = (input.productOptions ?? []).map((o, i) => {
      const prior = product?.options.find((p) => (o.id ? p.id === o.id : p.name === o.name));
      if (o.id && !prior)
        fail(
          'OPTION_DOES_NOT_EXIST',
          ['input', 'productOptions', String(i)],
          'Option does not exist',
        );
      const values = (o.values ?? []).map((v) => {
        const priorValue = prior?.values.find((p) => (v.id ? p.id === v.id : p.name === v.name));
        return {
          id: priorValue?.id ?? `gid://shopify/ProductOptionValue/${nextGlobalId()}`,
          name: v.name ?? priorValue?.name ?? '',
        };
      });
      if (values.length === 0)
        fail(
          'OPTION_VALUES_MISSING',
          ['input', 'productOptions', String(i), 'values'],
          'Option values must be provided',
        );
      return {
        id: prior?.id ?? `gid://shopify/ProductOption/${nextGlobalId()}`,
        name: o.name ?? prior?.name ?? '',
        position: o.position ?? i + 1,
        values,
      };
    });
    if (options.length > 3)
      fail(
        'OPTIONS_OVER_LIMIT',
        ['input', 'productOptions'],
        'Can only specify a maximum of 3 options',
      );
    if (new Set(options.map((o) => o.name)).size !== options.length)
      fail('DUPLICATED_OPTION_NAME', ['input', 'productOptions'], 'Duplicated option name.');

    // Files: existing ones by id, new ones from originalSource.
    const media: FakeMedia[] | undefined = input.files?.map((f, i) => {
      if (f.id) {
        const prior = product?.media.find((m) => m.id === f.id);
        if (!prior)
          fail('INVALID_INPUT', ['input', 'files', String(i), 'id'], `File ${f.id} does not exist`);
        return { ...(prior ?? emptyMedia(f.id)), alt: f.alt ?? prior?.alt ?? '' };
      }
      if (!f.originalSource)
        fail(
          'INVALID_INPUT',
          ['input', 'files', String(i)],
          'File needs an id or an originalSource',
        );
      return {
        id: `gid://shopify/MediaImage/${nextGlobalId()}`,
        alt: f.alt ?? '',
        status: 'UPLOADED' as const,
        url: null,
        source: f.originalSource ?? null,
      };
    });
    const mediaFor = (file: FileSetInputJson | undefined, at: string[]): string | null => {
      if (!file) return null;
      const list = media ?? product?.media ?? [];
      const found = file.id
        ? list.find((m) => m.id === file.id)
        : list.find((m) => m.source !== null && m.source === file.originalSource);
      if (!found) fail('INVALID_INPUT', at, 'A variant’s file must also be in the product’s files');
      return found?.id ?? null;
    };

    // Variants: the full list (missing ones are deleted).
    const variantPlans = (input.variants ?? []).map((v, i) => {
      const at = ['input', 'variants', String(i)];
      const prior = v.id ? existingVariants.find((x) => x.variantId === v.id) : undefined;
      if (v.id && !prior)
        fail('PRODUCT_VARIANT_DOES_NOT_EXIST', [...at, 'id'], 'Product variant does not exist');
      if (v.optionValues.length !== options.length)
        fail(
          'INVALID_VARIANT',
          [...at, 'optionValues'],
          'Each variant needs a value for every option',
        );
      const selectedOptions = v.optionValues.map((ov) => {
        const option = options.find((o) =>
          ov.optionId ? o.id === ov.optionId : o.name === ov.optionName,
        );
        const value = option?.values.find((x) => (ov.id ? x.id === ov.id : x.name === ov.name));
        if (!option || !value)
          fail(
            'OPTION_VALUE_DOES_NOT_EXIST',
            [...at, 'optionValues'],
            `Option value ${ov.name ?? ov.id} does not exist`,
          );
        return { option, name: option?.name ?? '', value: value?.name ?? '' };
      });
      const ordered = [...selectedOptions].sort(
        (a, b) => (a.option?.position ?? 0) - (b.option?.position ?? 0),
      );
      const price = v.price === undefined ? undefined : Number(v.price);
      if (price !== undefined && (!Number.isFinite(price) || price < 0))
        fail('INVALID_INPUT', [...at, 'price'], 'Price must be greater than or equal to 0');
      for (const q of v.inventoryQuantities ?? []) {
        if (!this.locations.some((l) => l.id === q.locationId))
          fail(
            'INVALID_INPUT',
            [...at, 'inventoryQuantities'],
            `Location ${q.locationId} does not exist`,
          );
        else if (prior && !this.levels.has(key(prior.inventoryItemId, q.locationId)))
          fail(
            'INVALID_INPUT',
            [...at, 'inventoryQuantities'],
            'Quantities can only be set where the variant is stocked',
          );
      }
      return {
        input: v,
        prior,
        selected: ordered.map((s) => ({ name: s.name, value: s.value })),
        price,
        mediaId: mediaFor(v.file, [...at, 'file']),
      };
    });
    const combos = variantPlans.map((p) => p.selected.map((s) => s.value).join(' / '));
    if (new Set(combos).size !== combos.length)
      fail('INVALID_VARIANT', ['input', 'variants'], 'Two variants have the same option values');

    if (errors.length) throw userErrors('Shopify didn’t accept the product', errors);

    // ---- apply ----
    const target: FakeProduct = product ?? {
      id: `gid://shopify/Product/${nextGlobalId()}`,
      title: '',
      handle: '',
      descriptionHtml: '',
      vendor: '',
      productType: '',
      tags: [],
      status: 'ACTIVE',
      seo: { title: null, description: null },
      options: [],
      media: [],
      customId: identifier && 'customId' in identifier ? identifier.customId : null,
    };
    if (input.title !== undefined) target.title = input.title;
    if (input.handle !== undefined) target.handle = input.handle;
    else if (creating) target.handle = this.uniqueHandle(slug(target.title), target.id);
    if (input.descriptionHtml !== undefined) target.descriptionHtml = input.descriptionHtml;
    if (input.vendor !== undefined) target.vendor = input.vendor;
    if (input.productType !== undefined) target.productType = input.productType;
    if (input.tags !== undefined) target.tags = [...input.tags];
    if (input.status !== undefined) target.status = input.status;
    if (input.seo?.title !== undefined) target.seo.title = input.seo.title;
    if (input.seo?.description !== undefined) target.seo.description = input.seo.description;
    if (media) target.media = media;
    this.products.set(target.id, target);

    if (input.variants) {
      target.options = options;
      const keep = new Set(variantPlans.flatMap((p) => (p.prior ? [p.prior.variantId] : [])));
      for (const v of existingVariants) if (!keep.has(v.variantId)) this.removeVariant(v.variantId);
      variantPlans.forEach((plan, i) => {
        const v = plan.input;
        let variant = plan.prior;
        if (!variant) {
          const n = nextGlobalId();
          variant = {
            productId: target.id,
            variantId: `gid://shopify/ProductVariant/${n}`,
            inventoryItemId: `gid://shopify/InventoryItem/${n}`,
            sku: null,
            barcode: null,
            productTitle: target.title,
            variantTitle: '',
            tracked: true,
            isBundle: false,
            price: 0,
            compareAtPrice: null,
          };
          this.variants.push(variant);
        }
        const d = this.detailsOf(variant);
        if (v.sku !== undefined) variant.sku = v.sku;
        if (v.barcodes !== undefined) variant.barcode = v.barcodes[0]?.value ?? null;
        if (plan.price !== undefined) variant.price = plan.price;
        else if (variant.price === null) variant.price = 0;
        if (v.compareAtPrice !== undefined)
          variant.compareAtPrice = v.compareAtPrice === null ? null : Number(v.compareAtPrice);
        if (v.inventoryItem?.tracked !== undefined) variant.tracked = v.inventoryItem.tracked;
        variant.variantTitle = plan.selected.map((s) => s.value).join(' / ');
        d.position = v.position ?? i + 1;
        d.selectedOptions = plan.selected;
        if (v.taxable !== undefined) d.taxable = v.taxable;
        if (v.inventoryPolicy !== undefined) d.inventoryPolicy = v.inventoryPolicy;
        if (v.inventoryItem?.requiresShipping !== undefined)
          d.requiresShipping = v.inventoryItem.requiresShipping;
        if (v.inventoryItem?.measurement?.weight !== undefined)
          d.weight = { ...v.inventoryItem.measurement.weight };
        if (v.inventoryItem?.cost !== undefined)
          d.unitCost = v.inventoryItem.cost === null ? null : Number(v.inventoryItem.cost);
        if (v.file !== undefined) d.mediaId = plan.mediaId;
        for (const q of v.inventoryQuantities ?? [])
          this.levels.set(key(variant.inventoryItemId, q.locationId), q.quantity);
      });
    } else if (creating) {
      // Shopify gives a product created without variants its one default variant.
      const value = {
        id: `gid://shopify/ProductOptionValue/${nextGlobalId()}`,
        name: 'Default Title',
      };
      target.options = [
        {
          id: `gid://shopify/ProductOption/${nextGlobalId()}`,
          name: 'Title',
          position: 1,
          values: [value],
        },
      ];
      const v = this.addVariant(null, {
        productId: target.id,
        productTitle: target.title,
        variantTitle: 'Default Title',
        price: 0,
      });
      this.detailsOf(v);
    }
    // Images whose variant pointed at a removed image lose it.
    const mediaIds = new Set(target.media.map((m) => m.id));
    for (const v of this.productVariants(target.id)) {
      v.productTitle = target.title;
      const d = this.detailsOf(v);
      if (d.mediaId && !mediaIds.has(d.mediaId)) d.mediaId = null;
    }

    const result: ProductSetResult = {
      productId: target.id,
      handle: target.handle,
      media: target.media.map((m) => ({ id: m.id, alt: m.alt, status: m.status })),
      variants: this.productVariants(target.id).map((v) => ({
        id: v.variantId,
        sku: v.sku,
        inventoryItemId: v.inventoryItemId,
        selectedOptions: this.detailsOf(v).selectedOptions.map((o) => ({ ...o })),
      })),
    };
    // Shopify processes new images after answering: they're ready by the next read.
    for (const m of target.media) {
      if (m.status !== 'READY') {
        m.status = 'READY';
        m.url = `https://cdn.shopify.com/s/files/1/fake/${m.id.split('/').pop()}.jpg`;
      }
    }
    return result;
  }
}

// Numeric, process-wide unique IDs, like Shopify's (webhook payloads carry only the number).
let globalId = 1_000_000_000_000;
function nextGlobalId(): number {
  return ++globalId;
}

function key(inventoryItemId: string, locationId: string): string {
  return `${inventoryItemId}|${locationId}`;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The orders query's sort order: update time, then id. */
function compareOrders(
  a: Pick<ShopifyOrder, 'updatedAt' | 'id'>,
  b: Pick<ShopifyOrder, 'updatedAt' | 'id'>,
): number {
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id);
}

function decodeCursor(cursor: string): Pick<ShopifyOrder, 'updatedAt' | 'id'> {
  const at = cursor.indexOf('|');
  return { updatedAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

function emptyMedia(id: string): FakeMedia {
  return { id, alt: '', status: 'READY', url: null, source: null };
}

function userErrors(what: string, errors: ShopifyUserError[]): ShopifyUserErrors {
  return new ShopifyUserErrors(`${what}: ${errors.map((e) => e.message).join('; ')}`, errors);
}

/** A bulk export line for an order (the fields of GRAPHQL_DOCUMENTS.ordersBulkQuery). */
function bulkOrder(o: ShopifyOrder) {
  return {
    id: o.id,
    name: o.name,
    processedAt: o.processedAt,
    updatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt,
    test: o.test,
    currencyCode: o.currencyCode,
    sourceName: o.sourceName,
    taxesIncluded: o.taxesIncluded,
  };
}

function bulkLine(l: ShopifyOrderLine, orderId: string) {
  const money = (amount: number) => ({ shopMoney: { amount: String(amount) } });
  return {
    id: l.id,
    sku: l.sku,
    quantity: l.quantity,
    currentQuantity: l.currentQuantity,
    isGiftCard: l.isGiftCard,
    variant: l.variantId
      ? { id: l.variantId, inventoryItem: l.inventoryItemId ? { id: l.inventoryItemId } : null }
      : null,
    originalUnitPriceSet: money(l.unitPrice),
    discountAllocations: l.discounts ? [{ allocatedAmountSet: money(l.discounts) }] : [],
    priceAfterAllDiscountsBeforeTaxesSet: money(l.net),
    __parentId: orderId,
  };
}
