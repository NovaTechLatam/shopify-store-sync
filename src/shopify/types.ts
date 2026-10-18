/**
 * The slice of the Shopify Admin API Store Sync uses: what the sync engine needs, and the
 * products, prices, publications and orders of the features. The production implementation is
 * `GraphqlShopifyAdmin`; tests use an in-memory fake (test/fakes/fake-shopify.ts).
 */

export type WeightUnit = 'GRAMS' | 'KILOGRAMS' | 'OUNCES' | 'POUNDS';

export interface ShopInfo {
  name: string;
  myshopifyDomain: string;
  /** Access scopes granted to our app on this store. */
  scopes: string[];
  /** What the shop sells in (prices, costs and order amounts), e.g. 'COP'. */
  currencyCode: string;
  /** e.g. 'America/Bogota'. */
  ianaTimezone: string;
  /** The shop's default unit for product weights. */
  weightUnit: WeightUnit;
}

export interface LevelQuantities {
  available: number;
  /** Held for open (unfulfilled) orders. */
  committed: number;
  /** On the shelf but not for sale: reserved + damaged + safety_stock + quality_control. */
  unavailable: number;
}

export interface ShopifyLocation {
  id: string; // gid://shopify/Location/1
  name: string;
  isActive: boolean;
}

export interface ShopifyVariant {
  productId: string;
  variantId: string;
  inventoryItemId: string;
  sku: string | null;
  barcode: string | null;
  productTitle: string;
  variantTitle: string;
  /** Shopify only counts stock for tracked inventory items. */
  tracked: boolean;
  /** Bundle parents (requiresComponents) have no stock of their own and can't be written. */
  isBundle: boolean;
  /** In the shop's currency. */
  price: number | null;
  compareAtPrice: number | null;
}

export interface SetAvailableInput {
  inventoryItemId: string;
  locationId: string;
  /** Compare-and-set guard: the write only applies if the store currently has exactly this value. */
  changeFrom: number;
  quantity: number;
  /** Same key + same input = same outcome for 24h (Shopify idempotency window). */
  idempotencyKey: string;
}

/**
 * Outcome of a compare-and-set write.
 * - `applied`: Shopify confirmed the write (possibly a cached replay of an earlier success).
 * - `stale`: the store's quantity was not `changeFrom`; nothing was written.
 * - `not_applied`: a replay of a key whose first attempt failed; nothing was written.
 * - `in_progress`: another request with this key is still running; outcome unknown, retry later.
 * - `not_stocked`: the item is not stocked at that location (API versions before 2026-10 only).
 * - `rejected`: any other user error (invalid item, quantity out of range, ...); nothing was written.
 */
export type SetAvailableResult =
  | { status: 'applied' }
  | { status: 'stale' }
  | { status: 'not_applied' }
  | { status: 'in_progress' }
  | { status: 'not_stocked' }
  | { status: 'rejected'; message: string };

export interface WebhookSubscription {
  id: string;
  topic: string; // GraphQL enum form, e.g. INVENTORY_LEVELS_UPDATE
  uri: string;
}

// ---- products -------------------------------------------------------------------------------

export type ProductStatus = 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED';
/** Shopify processes images after they are attached; `READY` ones have a URL. */
export type MediaStatus = 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';

/** The metafield that holds our master product id in every store (a Shopify "custom ID"). */
export const PRODUCT_ID_NAMESPACE = '$app:store_sync';
export const PRODUCT_ID_KEY = 'master_product_id';

export interface ShopifyProduct {
  id: string; // gid://shopify/Product/1
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: ProductStatus;
  seo: { title: string | null; description: string | null };
  /** In position order. A product without options has one: "Title" / "Default Title". */
  options: { id: string; name: string; position: number; values: { id: string; name: string }[] }[];
  /** Images only (videos and 3D models are left out), in the product's order. */
  media: ShopifyProductImage[];
  /** Every variant, in position order. */
  variants: ShopifyProductVariant[];
}

export interface ShopifyProductImage {
  id: string; // gid://shopify/MediaImage/1
  /** '' when the image has no alt text. */
  alt: string;
  status: MediaStatus;
  /** CDN URL; null until Shopify has processed the image. */
  url: string | null;
}

export interface ShopifyProductVariant {
  id: string;
  sku: string | null;
  title: string;
  position: number;
  /** The first barcode (a variant can have up to 20; we only use one). */
  barcode: string | null;
  price: number;
  compareAtPrice: number | null;
  taxable: boolean;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  selectedOptions: { name: string; value: string }[];
  /** The variant's image, if it has one. */
  mediaId: string | null;
  inventoryItemId: string;
  tracked: boolean;
  requiresShipping: boolean;
  weight: { unit: WeightUnit; value: number } | null;
  /** Unit cost in the shop's currency. */
  unitCost: number | null;
}

/**
 * The parts of Shopify's `ProductSetInput` we send, in its GraphQL shape (money and costs as
 * decimal strings, ids as GIDs). Omitted fields are left as they are in the store; lists that are
 * sent (variants, options, files, tags) replace what the store has.
 */
export interface ProductSetInputJson {
  title?: string;
  descriptionHtml?: string;
  handle?: string;
  /** With a new handle: redirect the old product URL to the new one. */
  redirectNewHandle?: boolean;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: ProductStatus;
  seo?: { title?: string | null; description?: string | null };
  /** Must be sent together with `variants` (and the other way round). At most 3. */
  productOptions?: ProductOptionSetInputJson[];
  variants?: ProductVariantSetInputJson[];
  files?: FileSetInputJson[];
  metafields?: MetafieldInputJson[];
}

export interface ProductOptionSetInputJson {
  id?: string;
  name?: string;
  position?: number;
  values?: { id?: string; name?: string }[];
}

export interface ProductVariantSetInputJson {
  /** An existing variant to update; without it a new variant (and inventory item) is created. */
  id?: string;
  /** One per product option, by name (`optionName` + `name`) or by id (`optionId` + `id`). */
  optionValues: { optionName?: string; optionId?: string; name?: string; id?: string }[];
  sku?: string;
  /** Replaces every barcode of the variant; [] removes them. */
  barcodes?: { value: string }[];
  price?: string;
  /** null removes the compare-at price. */
  compareAtPrice?: string | null;
  taxable?: boolean;
  inventoryPolicy?: 'DENY' | 'CONTINUE';
  position?: number;
  inventoryItem?: {
    tracked?: boolean;
    requiresShipping?: boolean;
    cost?: string | null;
    measurement?: { weight?: { unit: WeightUnit; value: number } };
  };
  /** New variants only: the starting quantity per location (name 'available'). */
  inventoryQuantities?: { locationId: string; name: 'available'; quantity: number }[];
  /** The variant's image: one of the product's `files`, by `id` or the same `originalSource`. */
  file?: FileSetInputJson;
}

export interface FileSetInputJson {
  /** An image already on the product (gid://shopify/MediaImage/1). */
  id?: string;
  /** A new image: a public https URL or a staged upload's resourceUrl. */
  originalSource?: string;
  alt?: string;
  contentType?: 'IMAGE';
  filename?: string;
}

export interface MetafieldInputJson {
  namespace?: string;
  key: string;
  type?: string;
  value: string;
}

/**
 * Which product productSet writes: `{ id }` updates that product (never creates); `{ customId }`
 * creates or updates the product holding that master product id (so a retried create can't make
 * a duplicate); null always creates.
 */
export type ProductSetIdentifier = { id: string } | { customId: string } | null;

export interface ProductSetRequest {
  identifier: ProductSetIdentifier;
  input: ProductSetInputJson;
  /** We always wait for the result (Shopify's asynchronous mode isn't used). */
  synchronous?: true;
}

export interface ProductSetResult {
  productId: string;
  handle: string;
  /** Every image of the product after the write, in order (new ones may still be processing). */
  media: { id: string; alt: string; status: MediaStatus }[];
  variants: {
    id: string;
    sku: string | null;
    inventoryItemId: string;
    selectedOptions: { name: string; value: string }[];
  }[];
}

export interface VariantPriceInput {
  id: string;
  /** Decimal string in the shop's currency (see toMoneyString). */
  price: string;
  /** undefined = leave as it is; null = remove the compare-at price. */
  compareAtPrice?: string | null;
}

// ---- orders ---------------------------------------------------------------------------------

/** An order as Shopify has it now (refunds, edits and cancellation applied). No customer data. */
export interface ShopifyOrder {
  id: string; // gid://shopify/Order/1
  name: string; // '#1001'
  /** ISO timestamps. */
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  /** The shop's currency when the order was placed; every amount below is in it. */
  currencyCode: string;
  sourceName: string | null;
  taxesIncluded: boolean;
  lines: ShopifyOrderLine[];
}

export interface ShopifyOrderLine {
  id: string; // gid://shopify/LineItem/1
  sku: string | null;
  /** Units ordered, including refunded and removed ones. */
  quantity: number;
  /** Units after refunds, removals and cancellation. */
  currentQuantity: number;
  isGiftCard: boolean;
  /** null when the variant was deleted since. */
  variantId: string | null;
  inventoryItemId: string | null;
  /** Price of one unit before discounts. */
  unitPrice: number;
  /** Every discount allocated to the line (including on units refunded since). */
  discounts: number;
  /** Net amount of the current units: after discounts, refunds and removals, before tax. */
  net: number;
}

export type BulkOperationStatus =
  'CREATED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELING' | 'CANCELED' | 'EXPIRED';

export interface BulkOperationInfo {
  id: string; // gid://shopify/BulkOperation/1
  status: BulkOperationStatus;
  /** ACCESS_DENIED | INTERNAL_SERVER_ERROR | TIMEOUT when it failed. */
  errorCode: string | null;
  /** The JSONL result (valid for 7 days); null while running and when nothing matched. */
  url: string | null;
  /** What was exported before a failure. */
  partialDataUrl: string | null;
  objectCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ShopifyAdmin {
  getShop(): Promise<ShopInfo>;
  listLocations(): Promise<ShopifyLocation[]>;
  /** Every variant of every product (paged internally). */
  listVariants(): Promise<ShopifyVariant[]>;
  /** Variants of one product, or `null` if the product no longer exists. */
  listProductVariants(productId: string): Promise<ShopifyVariant[] | null>;
  /** Variants that use an inventory item (empty if the item no longer exists). */
  listVariantsByInventoryItem(inventoryItemId: string): Promise<ShopifyVariant[]>;
  /**
   * Current "available" quantity of each inventory item at one location. Items that are not
   * stocked at the location (or don't exist) map to `null`.
   */
  readAvailable(
    locationId: string,
    inventoryItemIds: string[],
  ): Promise<Map<string, number | null>>;
  /** All quantities of each item at one location, read together (one consistent snapshot). */
  readLevels(
    locationId: string,
    inventoryItemIds: string[],
  ): Promise<Map<string, LevelQuantities | null>>;
  setAvailable(input: SetAvailableInput): Promise<SetAvailableResult>;
  /** Stocks an item at a location (no-op if already stocked). */
  activateInventory(inventoryItemId: string, locationId: string): Promise<void>;
  listWebhookSubscriptions(): Promise<WebhookSubscription[]>;
  createWebhookSubscription(topic: string, uri: string): Promise<void>;
  deleteWebhookSubscription(id: string): Promise<void>;

  // The methods below need optional scopes (see src/shopify/scopes.ts): write_products for
  // products, prices and images, write_publications for the Online Store, read_orders for orders.
  // Without them Shopify answers ACCESS_DENIED, thrown as a ShopifyApiError of kind 'auth'.
  // Mutations without an idempotency key are written so a retry is harmless (absolute values,
  // upserts by identifier).

  /** One product with every variant, or null if it doesn't exist (any more). */
  getProduct(productId: string): Promise<ShopifyProduct | null>;
  /** Creates our master-product-id metafield definition (once per store; "already exists" is fine). */
  ensureProductIdDefinition(): Promise<void>;
  /** Creates or updates a whole product. Rejections throw ShopifyUserErrors. */
  productSet(req: ProductSetRequest): Promise<ProductSetResult>;
  /** Uploads an image to Shopify's storage; returns the URL to use as a file's originalSource. */
  stageImage(file: { filename: string; mimeType: string; data: Buffer }): Promise<string>;
  /** The Online Store sales channel's publication, or null if the store has none. */
  findOnlineStorePublication(): Promise<string | null>;
  /** Makes a product visible in a sales channel (no-op if it already is). */
  publishProduct(productId: string, publicationId: string): Promise<void>;
  unpublishProduct(productId: string, publicationId: string): Promise<void>;
  /**
   * What some variants charge now, by id (any number, read 250 at a time). Variants that no longer
   * exist are left out.
   */
  readVariantPrices(
    variantIds: string[],
  ): Promise<Map<string, { price: number; compareAtPrice: number | null }>>;
  /**
   * Sets the prices of variants of one product. Variants Shopify refuses are returned; the others
   * are updated (partial updates allowed).
   */
  updateVariantPrices(
    productId: string,
    variants: VariantPriceInput[],
  ): Promise<{ failed: { variantId: string | null; message: string }[] }>;
  /** Sets an inventory item's unit cost (decimal string in the shop's currency). */
  updateInventoryItemCost(inventoryItemId: string, cost: string): Promise<void>;

  /** One order with every line, or null if it doesn't exist or can't be read (older than 60 days). */
  getOrder(orderId: string): Promise<ShopifyOrder | null>;
  /** A page of orders updated at or after `since` (ISO), oldest update first. */
  listOrdersUpdatedSince(
    since: string,
    after: string | null,
  ): Promise<{ orders: ShopifyOrder[]; nextCursor: string | null }>;
  /**
   * Starts a bulk export of orders updated since `since` (see parseOrdersBulkJsonl). Throws
   * BulkOperationInProgressError when Shopify won't run another one now.
   */
  startOrdersBulkExport(since: string): Promise<{ operationId: string }>;
  /** null if Shopify doesn't know this operation. */
  getBulkOperation(id: string): Promise<BulkOperationInfo | null>;
}
