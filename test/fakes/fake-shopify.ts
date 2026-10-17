import { ShopifyApiError } from '../../src/shopify/client.js';
import type {
  SetAvailableInput,
  SetAvailableResult,
  ShopInfo,
  ShopifyAdmin,
  ShopifyLocation,
  ShopifyVariant,
  WebhookSubscription,
} from '../../src/shopify/types.js';

export interface LevelChange {
  inventoryItemId: string;
  locationId: string;
  available: number;
  /** `api` = written through this fake's ShopifyAdmin API (i.e. by the sync engine). */
  source: 'api' | 'external';
}

type FaultMode = 'throw_before' | 'throw_after';

/**
 * In-memory Shopify shop that implements the same port as the real GraphQL client, with the
 * semantics the sync engine relies on: compare-and-set writes (changeFromQuantity) and 24h
 * idempotency keys (cached success, IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED after a failure).
 * Tests can inject concurrent changes and network faults.
 */
export class FakeShop implements ShopifyAdmin {
  readonly locations: ShopifyLocation[] = [];
  readonly variants: ShopifyVariant[] = [];
  private readonly levels = new Map<string, number>();
  private readonly idempotency = new Map<
    string,
    { fingerprint: string; result: SetAvailableResult }
  >();
  readonly subscriptions: WebhookSubscription[] = [];
  /** Every quantity change, in order. Tests turn these into webhooks. */
  readonly changes: LevelChange[] = [];
  readonly calls: { op: string; args: unknown }[] = [];

  /** Runs before a setAvailable is evaluated (after the request "reaches" Shopify). */
  beforeSet?: (input: SetAvailableInput) => void;
  /** Runs before readAvailable returns. */
  afterRead?: (locationId: string, ids: string[]) => void;
  private faults: { op: 'setAvailable' | 'readAvailable'; mode: FaultMode }[] = [];
  private nextId = 1;

  constructor(
    readonly domain: string,
    readonly name = domain,
  ) {}

  // ---- test helpers -------------------------------------------------------------------------

  addLocation(name = 'Warehouse', isActive = true): string {
    const id = `gid://shopify/Location/${this.domain}-${this.nextId++}`;
    this.locations.push({ id, name, isActive });
    return id;
  }

  addVariant(sku: string | null, opts: Partial<ShopifyVariant> = {}): ShopifyVariant {
    const n = this.nextId++;
    const variant: ShopifyVariant = {
      productId: opts.productId ?? `gid://shopify/Product/${this.domain}-${n}`,
      variantId: `gid://shopify/ProductVariant/${this.domain}-${n}`,
      inventoryItemId: `gid://shopify/InventoryItem/${this.domain}-${n}`,
      sku,
      barcode: opts.barcode ?? null,
      productTitle: opts.productTitle ?? `Product ${sku ?? n}`,
      variantTitle: opts.variantTitle ?? 'Default Title',
      tracked: opts.tracked ?? true,
      isBundle: opts.isBundle ?? false,
    };
    this.variants.push(variant);
    return variant;
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

  /** Makes the next matching call fail with a transient network error, before or after it takes effect. */
  failNext(op: 'setAvailable' | 'readAvailable', mode: FaultMode): void {
    this.faults.push({ op, mode });
  }

  /** Forget idempotency keys, as Shopify does after 24 hours. */
  expireIdempotencyKeys(): void {
    this.idempotency.clear();
  }

  // ---- ShopifyAdmin --------------------------------------------------------------------------

  scopes = ['read_products', 'read_inventory', 'write_inventory', 'read_locations'];

  async getShop(): Promise<ShopInfo> {
    return { name: this.name, myshopifyDomain: this.domain, scopes: [...this.scopes] };
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
    if (!this.levels.has(k)) this.levels.set(k, 0);
  }

  async listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
    return this.subscriptions.map((s) => ({ ...s }));
  }

  async createWebhookSubscription(topic: string, uri: string): Promise<void> {
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

  private takeFault(op: 'setAvailable' | 'readAvailable') {
    const idx = this.faults.findIndex((f) => f.op === op);
    if (idx < 0) return undefined;
    return this.faults.splice(idx, 1)[0];
  }
}

function key(inventoryItemId: string, locationId: string): string {
  return `${inventoryItemId}|${locationId}`;
}
