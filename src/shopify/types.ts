/**
 * The narrow slice of the Shopify Admin API the sync engine needs. The production implementation
 * is `GraphqlShopifyAdmin`; tests use an in-memory fake.
 */

export interface ShopInfo {
  name: string;
  myshopifyDomain: string;
  /** Access scopes granted to our app on this store. */
  scopes: string[];
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
}
