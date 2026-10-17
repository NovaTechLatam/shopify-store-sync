import { createHash } from 'node:crypto';
import type { ShopifyGraphqlClient } from './client.js';
import { ShopifyApiError } from './client.js';
import type {
  SetAvailableInput,
  SetAvailableResult,
  ShopInfo,
  ShopifyAdmin,
  ShopifyLocation,
  ShopifyVariant,
  WebhookSubscription,
} from './types.js';

/**
 * Every GraphQL document this service sends. `test/graphql-documents.test.ts` validates them
 * against the vendored Admin API 2026-10 schema.
 */
export const GRAPHQL_DOCUMENTS = {
  shop: /* GraphQL */ `
    query StoreSyncShop {
      shop {
        name
        myshopifyDomain
      }
      currentAppInstallation {
        accessScopes {
          handle
        }
      }
    }
  `,

  locations: /* GraphQL */ `
    query StoreSyncLocations($after: String) {
      locations(first: 100, after: $after, includeInactive: true) {
        nodes {
          id
          name
          isActive
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  variants: /* GraphQL */ `
    query StoreSyncVariants($after: String) {
      productVariants(first: 200, after: $after, sortKey: ID) {
        nodes {
          ...StoreSyncVariant
          product {
            id
            title
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    fragment StoreSyncVariant on ProductVariant {
      id
      sku
      barcode
      title
      requiresComponents
      inventoryItem {
        id
        tracked
      }
    }
  `,

  productVariants: /* GraphQL */ `
    query StoreSyncProductVariants($id: ID!, $after: String) {
      product(id: $id) {
        id
        title
        variants(first: 200, after: $after) {
          nodes {
            id
            sku
            barcode
            title
            requiresComponents
            inventoryItem {
              id
              tracked
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `,

  inventoryItemVariants: /* GraphQL */ `
    query StoreSyncInventoryItemVariants($id: ID!) {
      inventoryItem(id: $id) {
        id
        tracked
        variants(first: 10) {
          nodes {
            id
            sku
            barcode
            title
            requiresComponents
            product {
              id
              title
            }
          }
        }
      }
    }
  `,

  // `inventoryLevel` is null when the item isn't (actively) stocked at the location.
  levels: /* GraphQL */ `
    query StoreSyncLevels($ids: [ID!]!, $locationId: ID!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) {
              name
              quantity
            }
          }
        }
      }
    }
  `,

  // Since 2026-04 both `changeFromQuantity` (explicitly) and `@idempotent` are required.
  setAvailable: /* GraphQL */ `
    mutation StoreSyncSetAvailable($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup {
          id
        }
        userErrors {
          code
          field
          message
        }
      }
    }
  `,

  // Since 2026-04, activating without quantities preserves any existing quantity.
  activate: /* GraphQL */ `
    mutation StoreSyncActivate($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId)
        @idempotent(key: $idempotencyKey) {
        inventoryLevel {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `,

  webhooks: /* GraphQL */ `
    query StoreSyncWebhooks($after: String) {
      webhookSubscriptions(first: 100, after: $after) {
        nodes {
          id
          topic
          uri
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  webhookCreate: /* GraphQL */ `
    mutation StoreSyncWebhookCreate($topic: WebhookSubscriptionTopic!, $uri: String!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
        webhookSubscription {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `,

  webhookDelete: /* GraphQL */ `
    mutation StoreSyncWebhookDelete($id: ID!) {
      webhookSubscriptionDelete(id: $id) {
        deletedWebhookSubscriptionId
        userErrors {
          field
          message
        }
      }
    }
  `,
} as const;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface UserError {
  code?: string | null;
  field?: string[] | null;
  message: string;
}

interface VariantNode {
  id: string;
  sku: string | null;
  barcode: string | null;
  title: string;
  requiresComponents: boolean;
}

/** Shopify's `nodes` query accepts at most 250 IDs; 100 keeps each query's cost near 300 points. */
export const READ_BATCH_SIZE = 100;

export class GraphqlShopifyAdmin implements ShopifyAdmin {
  constructor(private readonly client: ShopifyGraphqlClient) {}

  async getShop(): Promise<ShopInfo> {
    const data = await this.client.request<{
      shop: { name: string; myshopifyDomain: string };
      currentAppInstallation: { accessScopes: { handle: string }[] };
    }>(GRAPHQL_DOCUMENTS.shop, {}, 3);
    return {
      name: data.shop.name,
      myshopifyDomain: data.shop.myshopifyDomain,
      scopes: data.currentAppInstallation.accessScopes.map((s) => s.handle),
    };
  }

  async listLocations(): Promise<ShopifyLocation[]> {
    const out: ShopifyLocation[] = [];
    let after: string | null = null;
    do {
      const data: { locations: { nodes: ShopifyLocation[]; pageInfo: PageInfo } } =
        await this.client.request(GRAPHQL_DOCUMENTS.locations, { after }, 102);
      out.push(...data.locations.nodes);
      after = data.locations.pageInfo.hasNextPage ? data.locations.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async listVariants(): Promise<ShopifyVariant[]> {
    type Node = VariantNode & {
      product: { id: string; title: string };
      inventoryItem: { id: string; tracked: boolean };
    };
    const out: ShopifyVariant[] = [];
    let after: string | null = null;
    do {
      const data: { productVariants: { nodes: Node[]; pageInfo: PageInfo } } =
        await this.client.request(GRAPHQL_DOCUMENTS.variants, { after }, 602);
      for (const n of data.productVariants.nodes)
        out.push(toVariant(n, n.product, n.inventoryItem));
      after = data.productVariants.pageInfo.hasNextPage
        ? data.productVariants.pageInfo.endCursor
        : null;
    } while (after);
    return out;
  }

  async listProductVariants(productId: string): Promise<ShopifyVariant[] | null> {
    type Node = VariantNode & { inventoryItem: { id: string; tracked: boolean } };
    type Data = {
      product: {
        id: string;
        title: string;
        variants: { nodes: Node[]; pageInfo: PageInfo };
      } | null;
    };
    const out: ShopifyVariant[] = [];
    let after: string | null = null;
    do {
      const data: Data = await this.client.request(
        GRAPHQL_DOCUMENTS.productVariants,
        { id: productId, after },
        402,
      );
      if (!data.product) return null;
      const product = data.product;
      for (const n of product.variants.nodes) out.push(toVariant(n, product, n.inventoryItem));
      after = product.variants.pageInfo.hasNextPage ? product.variants.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async listVariantsByInventoryItem(inventoryItemId: string): Promise<ShopifyVariant[]> {
    type Data = {
      inventoryItem: {
        id: string;
        tracked: boolean;
        variants: { nodes: (VariantNode & { product: { id: string; title: string } })[] };
      } | null;
    };
    const data = await this.client.request<Data>(
      GRAPHQL_DOCUMENTS.inventoryItemVariants,
      { id: inventoryItemId },
      25,
    );
    const item = data.inventoryItem;
    if (!item) return [];
    return item.variants.nodes.map((n) => toVariant(n, n.product, item));
  }

  async readAvailable(
    locationId: string,
    inventoryItemIds: string[],
  ): Promise<Map<string, number | null>> {
    type Node = {
      id?: string;
      inventoryLevel?: { quantities: { name: string; quantity: number }[] } | null;
    } | null;
    const result = new Map<string, number | null>();
    const unique = [...new Set(inventoryItemIds)];
    for (let i = 0; i < unique.length; i += READ_BATCH_SIZE) {
      const ids = unique.slice(i, i + READ_BATCH_SIZE);
      const data = await this.client.request<{ nodes: Node[] }>(
        GRAPHQL_DOCUMENTS.levels,
        { ids, locationId },
        ids.length * 3 + 1,
      );
      ids.forEach((id, idx) => {
        const node = data.nodes[idx];
        const available = node?.inventoryLevel?.quantities.find((q) => q.name === 'available');
        result.set(id, available ? available.quantity : null);
      });
    }
    return result;
  }

  async setAvailable(input: SetAvailableInput): Promise<SetAvailableResult> {
    const data = await this.client.request<{
      inventorySetQuantities: {
        inventoryAdjustmentGroup: { id: string } | null;
        userErrors: UserError[];
      };
    }>(GRAPHQL_DOCUMENTS.setAvailable, {
      idempotencyKey: input.idempotencyKey,
      input: {
        name: 'available',
        reason: 'correction',
        // Shows up in the store's inventory history next to our app's name.
        referenceDocumentUri: `gid://store-sync/SyncWrite/${input.idempotencyKey}`,
        quantities: [
          {
            inventoryItemId: input.inventoryItemId,
            locationId: input.locationId,
            quantity: input.quantity,
            changeFromQuantity: input.changeFrom,
          },
        ],
      },
    });
    return interpretSetResult(data.inventorySetQuantities.userErrors);
  }

  async activateInventory(inventoryItemId: string, locationId: string): Promise<void> {
    const data = await this.client.request<{ inventoryActivate: { userErrors: UserError[] } }>(
      GRAPHQL_DOCUMENTS.activate,
      // Deterministic key: activating the same item at the same location is the same operation.
      {
        inventoryItemId,
        locationId,
        idempotencyKey: deterministicUuid(`activate:${inventoryItemId}:${locationId}`),
      },
    );
    const errors = data.inventoryActivate.userErrors;
    if (errors.length) {
      throw new ShopifyApiError(
        `inventoryActivate failed: ${errors.map((e) => e.message).join('; ')}`,
        'invalid',
      );
    }
  }

  async listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
    const out: WebhookSubscription[] = [];
    let after: string | null = null;
    do {
      const data: { webhookSubscriptions: { nodes: WebhookSubscription[]; pageInfo: PageInfo } } =
        await this.client.request(GRAPHQL_DOCUMENTS.webhooks, { after }, 102);
      out.push(...data.webhookSubscriptions.nodes);
      after = data.webhookSubscriptions.pageInfo.hasNextPage
        ? data.webhookSubscriptions.pageInfo.endCursor
        : null;
    } while (after);
    return out;
  }

  async createWebhookSubscription(topic: string, uri: string): Promise<void> {
    const data = await this.client.request<{
      webhookSubscriptionCreate: { userErrors: UserError[] };
    }>(GRAPHQL_DOCUMENTS.webhookCreate, { topic, uri });
    const errors = data.webhookSubscriptionCreate.userErrors;
    if (errors.length) {
      throw new ShopifyApiError(
        `webhookSubscriptionCreate(${topic}) failed: ${errors.map((e) => e.message).join('; ')}`,
        'invalid',
      );
    }
  }

  async deleteWebhookSubscription(id: string): Promise<void> {
    const data = await this.client.request<{
      webhookSubscriptionDelete: { userErrors: UserError[] };
    }>(GRAPHQL_DOCUMENTS.webhookDelete, { id });
    const errors = data.webhookSubscriptionDelete.userErrors;
    if (errors.length) {
      throw new ShopifyApiError(
        `webhookSubscriptionDelete failed: ${errors.map((e) => e.message).join('; ')}`,
        'invalid',
      );
    }
  }
}

function toVariant(
  n: VariantNode,
  product: { id: string; title: string },
  inventoryItem: { id: string; tracked: boolean },
): ShopifyVariant {
  return {
    productId: product.id,
    variantId: n.id,
    inventoryItemId: inventoryItem.id,
    sku: n.sku,
    barcode: n.barcode,
    productTitle: product.title,
    variantTitle: n.title,
    tracked: inventoryItem.tracked,
    isBundle: n.requiresComponents,
  };
}

/** UUID-formatted SHA-1 digest of `name` (stable across retries and restarts). */
export function deterministicUuid(name: string): string {
  const hex = createHash('sha1').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function interpretSetResult(userErrors: UserError[]): SetAvailableResult {
  if (userErrors.length === 0) return { status: 'applied' };
  const codes = new Set(userErrors.map((e) => e.code));
  if (codes.has('CHANGE_FROM_QUANTITY_STALE') || codes.has('COMPARE_QUANTITY_STALE'))
    return { status: 'stale' };
  if (codes.has('IDEMPOTENCY_CONCURRENT_REQUEST')) return { status: 'in_progress' };
  if (codes.has('IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED')) return { status: 'not_applied' };
  // Removed from the enum in 2026-10 (writes now create an inactive level instead), kept for older versions.
  if (codes.has('ITEM_NOT_STOCKED_AT_LOCATION')) return { status: 'not_stocked' };
  return {
    status: 'rejected',
    message: userErrors.map((e) => `${e.code ?? 'ERROR'}: ${e.message}`).join('; '),
  };
}
