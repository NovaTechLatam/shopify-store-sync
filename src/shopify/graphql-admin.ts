import { randomUUID } from 'node:crypto';
import type { ShopifyGraphqlClient, ShopifyUserError } from './client.js';
import { BulkOperationInProgressError, ShopifyApiError, ShopifyUserErrors } from './client.js';
import type {
  BulkOperationInfo,
  BulkOperationStatus,
  MediaStatus,
  ProductSetInputJson,
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
  ShopifyProductImage,
  ShopifyProductVariant,
  ShopifyVariant,
  VariantPriceInput,
  WebhookSubscription,
  WeightUnit,
} from './types.js';
import { PRODUCT_ID_KEY, PRODUCT_ID_NAMESPACE } from './types.js';
import { roundMoney } from '../util/money.js';

/** Shared by the order and orders documents (a fragment must be in the same document). */
const SALES_FRAGMENTS = /* GraphQL */ `
  fragment StoreSyncSalesOrder on Order {
    id
    name
    processedAt
    updatedAt
    cancelledAt
    test
    currencyCode
    sourceName
    taxesIncluded
  }
  fragment StoreSyncSalesLine on LineItem {
    id
    sku
    quantity
    currentQuantity
    isGiftCard
    variant {
      id
      inventoryItem {
        id
      }
    }
    originalUnitPriceSet {
      shopMoney {
        amount
      }
    }
    discountAllocations {
      allocatedAmountSet {
        shopMoney {
          amount
        }
      }
    }
    priceAfterAllDiscountsBeforeTaxesSet {
      shopMoney {
        amount
      }
    }
  }
`;

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
        currencyCode
        ianaTimezone
        weightUnit
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
      price
      compareAtPrice
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
            price
            compareAtPrice
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

  // Prices of some variants by id: about one point each, where reading the variants of every
  // product of a store costs hundreds per page.
  variantPricesRead: /* GraphQL */ `
    query StoreSyncVariantPricesRead($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          price
          compareAtPrice
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
            price
            compareAtPrice
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
    query StoreSyncLevels($ids: [ID!]!, $locationId: ID!, $names: [String!]!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevel(locationId: $locationId) {
            quantities(names: $names) {
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

  // ---- products (write_products) ----------------------------------------------------------

  // Variants are read separately (productVariantDetails): with them a single query would far
  // exceed Shopify's 1,000-point limit.
  product: /* GraphQL */ `
    query StoreSyncProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        descriptionHtml
        vendor
        productType
        tags
        status
        seo {
          title
          description
        }
        options {
          id
          name
          position
          optionValues {
            id
            name
          }
        }
        media(first: 100) {
          nodes {
            ...StoreSyncMedia
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
    fragment StoreSyncMedia on Media {
      id
      alt
      status
      mediaContentType
      ... on MediaImage {
        image {
          url
        }
      }
    }
  `,

  productMedia: /* GraphQL */ `
    query StoreSyncProductMedia($id: ID!, $after: String) {
      product(id: $id) {
        id
        media(first: 100, after: $after) {
          nodes {
            id
            alt
            status
            mediaContentType
            ... on MediaImage {
              image {
                url
              }
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

  productVariantDetails: /* GraphQL */ `
    query StoreSyncProductVariantDetails($id: ID!, $after: String) {
      product(id: $id) {
        id
        variants(first: 40, after: $after) {
          nodes {
            id
            title
            position
            sku
            barcodes(first: 1) {
              nodes {
                value
              }
            }
            price
            compareAtPrice
            taxable
            inventoryPolicy
            selectedOptions {
              name
              value
            }
            media(first: 1) {
              nodes {
                id
              }
            }
            inventoryItem {
              id
              tracked
              requiresShipping
              measurement {
                weight {
                  unit
                  value
                }
              }
              unitCost {
                amount
              }
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

  // Variants of a product after productSet, beyond the first 100 its result carries.
  productVariantOptions: /* GraphQL */ `
    query StoreSyncProductVariantOptions($id: ID!, $after: String) {
      product(id: $id) {
        id
        variants(first: 100, after: $after) {
          nodes {
            id
            sku
            selectedOptions {
              name
              value
            }
            inventoryItem {
              id
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

  // An "id" metafield gives unique values: productSet can then upsert by our master product id.
  productIdDefinition: /* GraphQL */ `
    mutation StoreSyncProductIdDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition {
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

  // No idempotency key exists for productSet: callers update by id or upsert by custom id, and
  // send the whole state (lists replace what the store has), so a retry writes the same thing.
  productSet: /* GraphQL */ `
    mutation StoreSyncProductSet(
      $identifier: ProductSetIdentifiers
      $input: ProductSetInput!
      $synchronous: Boolean!
    ) {
      productSet(identifier: $identifier, input: $input, synchronous: $synchronous) {
        product {
          ...StoreSyncProductSetResult
        }
        productSetOperation {
          id
          status
          userErrors {
            code
            field
            message
          }
        }
        userErrors {
          code
          field
          message
        }
      }
    }
    fragment StoreSyncProductSetResult on Product {
      id
      handle
      media(first: 100) {
        nodes {
          id
          alt
          status
          mediaContentType
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      variants(first: 100) {
        nodes {
          id
          sku
          selectedOptions {
            name
            value
          }
          inventoryItem {
            id
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  // IMAGE, not the deprecated PRODUCT_IMAGE; POST (multipart) rather than PUT, whose header
  // names are ambiguous in Shopify's guide.
  stagedUploadsCreate: /* GraphQL */ `
    mutation StoreSyncStagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `,

  // ---- publications (write_publications) --------------------------------------------------

  // Publication.name and .app are deprecated: the channel is recognised by its catalog.
  publications: /* GraphQL */ `
    query StoreSyncPublications($after: String) {
      publications(first: 20, after: $after, catalogType: APP) {
        nodes {
          id
          catalog {
            id
            title
            ... on AppCatalog {
              apps(first: 1) {
                nodes {
                  id
                  handle
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `,

  // Publishing a product that is already published succeeds without a change: safe to retry.
  publish: /* GraphQL */ `
    mutation StoreSyncPublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors {
          field
          message
        }
      }
    }
  `,

  unpublish: /* GraphQL */ `
    mutation StoreSyncUnpublish($id: ID!, $input: [PublicationInput!]!) {
      publishableUnpublish(id: $id, input: $input) {
        userErrors {
          field
          message
        }
      }
    }
  `,

  // Absolute prices: a retry writes the same values. Valid variants are updated even when others
  // are refused (allowPartialUpdates).
  variantPrices: /* GraphQL */ `
    mutation StoreSyncVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(
        productId: $productId
        variants: $variants
        allowPartialUpdates: true
      ) {
        productVariants {
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

  // Needs write_inventory, which syncing stock already requires.
  inventoryItemCost: /* GraphQL */ `
    mutation StoreSyncInventoryItemCost($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `,

  // ---- orders (read_orders) ---------------------------------------------------------------

  // Never select customer fields: protected customer data that isn't approved comes back as a
  // GraphQL error, which fails the whole query. Amounts are shopMoney (the shop's currency).
  order: /* GraphQL */ `
    query StoreSyncOrder($id: ID!, $linesAfter: String) {
      order(id: $id) {
        ...StoreSyncSalesOrder
        lineItems(first: 50, after: $linesAfter) {
          nodes {
            ...StoreSyncSalesLine
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
    ${SALES_FRAGMENTS}
  `,

  // The sort key matches the range filter (Shopify may time out otherwise). Orders with more
  // lines than the first page holds are completed with the order query.
  orders: /* GraphQL */ `
    query StoreSyncOrders($query: String!, $after: String) {
      orders(first: 10, after: $after, query: $query, sortKey: UPDATED_AT) {
        nodes {
          ...StoreSyncSalesOrder
          lineItems(first: 8) {
            nodes {
              ...StoreSyncSalesLine
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    ${SALES_FRAGMENTS}
  `,

  // Not sent as a request: the query a bulk export runs (bulkRun's $query), with __SINCE__
  // replaced by an ISO timestamp. Kept here so it is validated with the others. Bulk queries take
  // no page sizes, allow at most two levels of connections, and write one JSONL line per node
  // (children carry __parentId; since 2026-01 they may come before their parent).
  ordersBulkQuery: /* GraphQL */ `
    {
      orders(query: "updated_at:>='__SINCE__'", sortKey: UPDATED_AT) {
        edges {
          node {
            id
            name
            processedAt
            updatedAt
            cancelledAt
            test
            currencyCode
            sourceName
            taxesIncluded
            lineItems {
              edges {
                node {
                  id
                  sku
                  quantity
                  currentQuantity
                  isGiftCard
                  variant {
                    id
                    inventoryItem {
                      id
                    }
                  }
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                    }
                  }
                  discountAllocations {
                    allocatedAmountSet {
                      shopMoney {
                        amount
                      }
                    }
                  }
                  priceAfterAllDiscountsBeforeTaxesSet {
                    shopMoney {
                      amount
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `,

  bulkRun: /* GraphQL */ `
    mutation StoreSyncBulkRun($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation {
          id
          status
        }
        userErrors {
          code
          field
          message
        }
      }
    }
  `,

  // currentBulkOperation is deprecated in 2026-10: operations are polled by id.
  bulkStatus: /* GraphQL */ `
    query StoreSyncBulkStatus($id: ID!) {
      bulkOperation(id: $id) {
        id
        status
        errorCode
        createdAt
        completedAt
        objectCount
        url
        partialDataUrl
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
  /** Money scalars arrive as decimal strings. */
  price: string | null;
  compareAtPrice: string | null;
}

interface MediaNode {
  id: string;
  alt: string | null;
  status: MediaStatus;
  mediaContentType: string;
  image?: { url: string } | null;
}

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  status: ProductStatus;
  seo: { title: string | null; description: string | null };
  options: {
    id: string;
    name: string;
    position: number;
    optionValues: { id: string; name: string }[];
  }[];
  media: { nodes: MediaNode[]; pageInfo: PageInfo };
}

interface ProductVariantDetailNode {
  id: string;
  title: string;
  position: number;
  sku: string | null;
  barcodes: { nodes: { value: string }[] };
  price: string;
  compareAtPrice: string | null;
  taxable: boolean;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  selectedOptions: { name: string; value: string }[];
  media: { nodes: { id: string }[] };
  inventoryItem: {
    id: string;
    tracked: boolean;
    requiresShipping: boolean;
    measurement: { weight: { unit: WeightUnit; value: number } | null };
    unitCost: { amount: string } | null;
  };
}

interface VariantOptionsNode {
  id: string;
  sku: string | null;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string };
}

interface Money {
  shopMoney: { amount: string };
}

/** Order fields as the order(s) queries and the bulk export return them. */
interface OrderNode {
  id: string;
  name: string;
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  currencyCode: string;
  sourceName: string | null;
  taxesIncluded: boolean;
}

interface OrderLineNode {
  id: string;
  sku: string | null;
  quantity: number;
  currentQuantity: number;
  isGiftCard: boolean;
  variant: { id: string; inventoryItem: { id: string } | null } | null;
  originalUnitPriceSet: Money;
  discountAllocations: { allocatedAmountSet: Money }[];
  priceAfterAllDiscountsBeforeTaxesSet: Money;
}

type OrderWithLines = OrderNode & {
  lineItems: { nodes: OrderLineNode[]; pageInfo: PageInfo };
};

interface ProductSetNode {
  id: string;
  handle: string;
  media: { nodes: MediaNode[]; pageInfo: PageInfo };
  variants: { nodes: VariantOptionsNode[]; pageInfo: PageInfo };
}

/** Estimated cost of the order query (a page of 50 lines). */
const ORDER_COST = 460;

/** Rough Shopify cost of a productSet: the result's selection plus Shopify's input complexity. */
function productSetCost(input: ProductSetRequest['input']): number {
  const files = input.files?.length ?? 0;
  const variants = input.variants ?? [];
  const variantFiles = variants.filter((v) => v.file).length;
  return Math.ceil(420 + files * 1.9 + variants.length * 0.2 + variantFiles * 0.6);
}

/** Variants per productVariantsBulkUpdate call (Shopify's limit for input lists). */
export const PRICE_UPDATE_CHUNK = 250;
/** Ids per `nodes(ids:)` query (Shopify's limit). */
const NODES_PER_READ = 250;
const UPLOAD_TIMEOUT_MS = 120_000;

/** Shopify quantity states that are on the shelf but not for sale. */
const UNAVAILABLE_NAMES = ['reserved', 'damaged', 'safety_stock', 'quality_control'] as const;
const QUANTITY_NAMES = ['available', 'committed', ...UNAVAILABLE_NAMES] as const;

/** Shopify's `nodes` query accepts at most 250 IDs; 100 keeps each query's cost near 300 points. */
export const READ_BATCH_SIZE = 100;

export class GraphqlShopifyAdmin implements ShopifyAdmin {
  constructor(private readonly client: ShopifyGraphqlClient) {}

  async getShop(): Promise<ShopInfo> {
    const data = await this.client.request<{
      shop: {
        name: string;
        myshopifyDomain: string;
        currencyCode: string;
        ianaTimezone: string;
        weightUnit: WeightUnit;
      };
      currentAppInstallation: { accessScopes: { handle: string }[] };
    }>(GRAPHQL_DOCUMENTS.shop, {}, 3);
    return {
      name: data.shop.name,
      myshopifyDomain: data.shop.myshopifyDomain,
      scopes: data.currentAppInstallation.accessScopes.map((s) => s.handle),
      currencyCode: data.shop.currencyCode,
      ianaTimezone: data.shop.ianaTimezone,
      weightUnit: data.shop.weightUnit,
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

  async readAvailable(locationId: string, inventoryItemIds: string[]) {
    const levels = await this.readQuantities(['available'], locationId, inventoryItemIds);
    return new Map([...levels].map(([id, q]) => [id, q ? (q.available ?? 0) : null]));
  }

  async readLevels(locationId: string, inventoryItemIds: string[]) {
    const levels = await this.readQuantities(QUANTITY_NAMES, locationId, inventoryItemIds);
    return new Map(
      [...levels].map(([id, q]) => [
        id,
        q
          ? {
              available: q.available ?? 0,
              committed: q.committed ?? 0,
              unavailable: UNAVAILABLE_NAMES.reduce((sum, name) => sum + (q[name] ?? 0), 0),
            }
          : null,
      ]),
    );
  }

  private async readQuantities(
    names: readonly string[],
    locationId: string,
    inventoryItemIds: string[],
  ): Promise<Map<string, Record<string, number> | null>> {
    type Node = {
      id?: string;
      inventoryLevel?: { quantities: { name: string; quantity: number }[] } | null;
    } | null;
    const result = new Map<string, Record<string, number> | null>();
    const unique = [...new Set(inventoryItemIds)];
    for (let i = 0; i < unique.length; i += READ_BATCH_SIZE) {
      const ids = unique.slice(i, i + READ_BATCH_SIZE);
      const data = await this.client.request<{ nodes: Node[] }>(
        GRAPHQL_DOCUMENTS.levels,
        { ids, locationId, names },
        ids.length * 3 + 1,
      );
      ids.forEach((id, idx) => {
        const level = data.nodes[idx]?.inventoryLevel;
        result.set(
          id,
          level ? Object.fromEntries(level.quantities.map((q) => [q.name, q.quantity])) : null,
        );
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
      // A fresh key per attempt: a key reused within 24h returns the cached answer without
      // activating again (e.g. after staff stopped stocking the item there). The read that
      // follows tells us whether it worked; the client reuses the key for its own retries.
      { inventoryItemId, locationId, idempotencyKey: randomUUID() },
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
    // Webhook mutations have no idempotency key, so a retried request (after a timeout or 5xx
    // that hid a success) finds its own subscription already there: that's fine.
    const errors = data.webhookSubscriptionCreate.userErrors.filter(
      (e) => !/already been taken/i.test(e.message),
    );
    // A ShopifyUserErrors, so ensureWebhooks can tell a refused optional topic (missing scope,
    // protected customer data not approved) from a failed request.
    if (errors.length) throw userErrors(`webhookSubscriptionCreate(${topic}) failed`, errors);
  }

  async deleteWebhookSubscription(id: string): Promise<void> {
    const data = await this.client.request<{
      webhookSubscriptionDelete: { userErrors: UserError[] };
    }>(GRAPHQL_DOCUMENTS.webhookDelete, { id });
    const errors = data.webhookSubscriptionDelete.userErrors.filter(
      (e) => !/does not exist|not found/i.test(e.message),
    );
    if (errors.length) {
      throw new ShopifyApiError(
        `webhookSubscriptionDelete failed: ${errors.map((e) => e.message).join('; ')}`,
        'invalid',
      );
    }
  }

  // ---- products -------------------------------------------------------------------------------

  async getProduct(productId: string): Promise<ShopifyProduct | null> {
    const data = await this.client.request<{ product: ProductNode | null }>(
      GRAPHQL_DOCUMENTS.product,
      { id: productId },
      215,
    );
    const p = data.product;
    if (!p) return null;
    const media = [...p.media.nodes];
    let after = p.media.pageInfo.hasNextPage ? p.media.pageInfo.endCursor : null;
    while (after) {
      const page: { product: { media: { nodes: MediaNode[]; pageInfo: PageInfo } } | null } =
        await this.client.request(GRAPHQL_DOCUMENTS.productMedia, { id: productId, after }, 205);
      if (!page.product) return null;
      media.push(...page.product.media.nodes);
      after = page.product.media.pageInfo.hasNextPage
        ? page.product.media.pageInfo.endCursor
        : null;
    }
    const variants: ShopifyProductVariant[] = [];
    do {
      const page: {
        product: { variants: { nodes: ProductVariantDetailNode[]; pageInfo: PageInfo } } | null;
      } = await this.client.request(
        GRAPHQL_DOCUMENTS.productVariantDetails,
        { id: productId, after },
        490,
      );
      if (!page.product) return null;
      variants.push(...page.product.variants.nodes.map(toProductVariant));
      after = page.product.variants.pageInfo.hasNextPage
        ? page.product.variants.pageInfo.endCursor
        : null;
    } while (after);
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      descriptionHtml: p.descriptionHtml,
      vendor: p.vendor,
      productType: p.productType,
      tags: p.tags,
      status: p.status,
      seo: { title: p.seo.title, description: p.seo.description },
      options: [...p.options]
        .sort((a, b) => a.position - b.position)
        .map((o) => ({
          id: o.id,
          name: o.name,
          position: o.position,
          values: o.optionValues.map((v) => ({ id: v.id, name: v.name })),
        })),
      media: media.filter(isImage).map(toProductImage),
      variants: variants.sort((a, b) => a.position - b.position),
    };
  }

  async ensureProductIdDefinition(): Promise<void> {
    const data = await this.client.request<{
      metafieldDefinitionCreate: { userErrors: UserError[] };
    }>(
      GRAPHQL_DOCUMENTS.productIdDefinition,
      {
        definition: {
          name: 'Store Sync product',
          description: 'Links this product to its product in Store Sync’s catalog.',
          namespace: PRODUCT_ID_NAMESPACE,
          key: PRODUCT_ID_KEY,
          type: 'id',
          ownerType: 'PRODUCT',
        },
      },
      12,
    );
    // A definition we created before (or a retried request that did): that's what we want.
    const errors = data.metafieldDefinitionCreate.userErrors.filter(
      (e) => e.code !== 'TAKEN' && !/taken|already exists/i.test(e.message),
    );
    if (errors.length)
      throw userErrors('Shopify didn’t create the Store Sync product id field', errors);
  }

  async productSet(req: ProductSetRequest): Promise<ProductSetResult> {
    const input: ProductSetInputJson = { ...req.input };
    let identifier: Record<string, unknown> | null = null;
    if (req.identifier && 'id' in req.identifier) {
      identifier = { id: req.identifier.id };
    } else if (req.identifier && 'customId' in req.identifier) {
      const value = req.identifier.customId;
      identifier = {
        customId: { namespace: PRODUCT_ID_NAMESPACE, key: PRODUCT_ID_KEY, value },
      };
      // Shopify requires the metafields sent (if any) to hold the custom id; sending it also
      // stamps it on a product this call creates. Only use customId to create: productSet
      // replaces a product's metafields with the list it is given.
      input.metafields = [
        ...(input.metafields ?? []).filter(
          (m) =>
            !(
              m.key === PRODUCT_ID_KEY &&
              (m.namespace ?? PRODUCT_ID_NAMESPACE) === PRODUCT_ID_NAMESPACE
            ),
        ),
        { namespace: PRODUCT_ID_NAMESPACE, key: PRODUCT_ID_KEY, type: 'id', value },
      ];
    }
    const data = await this.client.request<{
      productSet: {
        product: ProductSetNode | null;
        productSetOperation: { userErrors: UserError[] } | null;
        userErrors: UserError[];
      };
    }>(
      GRAPHQL_DOCUMENTS.productSet,
      { identifier, input, synchronous: true },
      productSetCost(input),
    );
    const payload = data.productSet;
    const errors = [...payload.userErrors, ...(payload.productSetOperation?.userErrors ?? [])];
    if (errors.length) throw userErrors('Shopify didn’t accept the product', errors);
    const product = payload.product;
    if (!product) throw new ShopifyApiError('productSet returned no product', 'transient');

    const media = [...product.media.nodes];
    let after = product.media.pageInfo.hasNextPage ? product.media.pageInfo.endCursor : null;
    while (after) {
      const page: { product: { media: { nodes: MediaNode[]; pageInfo: PageInfo } } | null } =
        await this.client.request(GRAPHQL_DOCUMENTS.productMedia, { id: product.id, after }, 205);
      if (!page.product) break;
      media.push(...page.product.media.nodes);
      after = page.product.media.pageInfo.hasNextPage
        ? page.product.media.pageInfo.endCursor
        : null;
    }
    const variants = [...product.variants.nodes];
    after = product.variants.pageInfo.hasNextPage ? product.variants.pageInfo.endCursor : null;
    while (after) {
      const page: {
        product: { variants: { nodes: VariantOptionsNode[]; pageInfo: PageInfo } } | null;
      } = await this.client.request(
        GRAPHQL_DOCUMENTS.productVariantOptions,
        { id: product.id, after },
        305,
      );
      if (!page.product) break;
      variants.push(...page.product.variants.nodes);
      after = page.product.variants.pageInfo.hasNextPage
        ? page.product.variants.pageInfo.endCursor
        : null;
    }
    return {
      productId: product.id,
      handle: product.handle,
      media: media.filter(isImage).map((m) => ({ id: m.id, alt: m.alt ?? '', status: m.status })),
      variants: variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        inventoryItemId: v.inventoryItem.id,
        selectedOptions: v.selectedOptions.map((o) => ({ name: o.name, value: o.value })),
      })),
    };
  }

  async stageImage(file: { filename: string; mimeType: string; data: Buffer }): Promise<string> {
    const data = await this.client.request<{
      stagedUploadsCreate: {
        stagedTargets: {
          url: string | null;
          resourceUrl: string | null;
          parameters: { name: string; value: string }[];
        }[];
        userErrors: UserError[];
      };
    }>(
      GRAPHQL_DOCUMENTS.stagedUploadsCreate,
      {
        input: [
          {
            filename: file.filename,
            mimeType: file.mimeType,
            resource: 'IMAGE',
            httpMethod: 'POST',
            fileSize: String(file.data.length),
          },
        ],
      },
      12,
    );
    const { stagedTargets, userErrors: errors } = data.stagedUploadsCreate;
    if (errors.length) throw userErrors('Shopify didn’t accept the image upload', errors);
    const target = stagedTargets[0];
    if (!target?.url || !target.resourceUrl)
      throw new ShopifyApiError('stagedUploadsCreate returned no upload target', 'transient');

    // Shopify's storage wants every parameter it gave us as a form field, and the file last.
    // It's not the Admin API: no access token.
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append(
      'file',
      new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
      file.filename,
    );
    let res: Response;
    try {
      res = await this.client.fetchFn(target.url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ShopifyApiError(
        `Uploading ${file.filename} to Shopify failed: ${(err as Error).message}`,
        'transient',
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ShopifyApiError(
        `Uploading ${file.filename} to Shopify failed with HTTP ${res.status}: ${body.slice(0, 300)}`,
        'transient',
        res.status,
      );
    }
    return target.resourceUrl;
  }

  // ---- publications ---------------------------------------------------------------------------

  async findOnlineStorePublication(): Promise<string | null> {
    type Node = {
      id: string;
      catalog: { title: string; apps?: { nodes: { handle: string | null }[] } } | null;
    };
    const publications: Node[] = [];
    let after: string | null = null;
    do {
      const data: { publications: { nodes: Node[]; pageInfo: PageInfo } } =
        await this.client.request(GRAPHQL_DOCUMENTS.publications, { after }, 102);
      publications.push(...data.publications.nodes);
      after = data.publications.pageInfo.hasNextPage ? data.publications.pageInfo.endCursor : null;
    } while (after);
    // The app handle doesn't depend on the admin's language; the catalog title is the fallback.
    const byHandle = publications.find((p) =>
      p.catalog?.apps?.nodes.some((a) => a.handle === 'online_store'),
    );
    const byTitle = publications.find((p) => p.catalog?.title === 'Online Store');
    return (byHandle ?? byTitle)?.id ?? null;
  }

  async publishProduct(productId: string, publicationId: string): Promise<void> {
    const data = await this.client.request<{ publishablePublish: { userErrors: UserError[] } }>(
      GRAPHQL_DOCUMENTS.publish,
      { id: productId, input: [{ publicationId }] },
      12,
    );
    const errors = data.publishablePublish.userErrors;
    if (errors.length) throw userErrors('Shopify didn’t publish the product', errors);
  }

  async unpublishProduct(productId: string, publicationId: string): Promise<void> {
    const data = await this.client.request<{ publishableUnpublish: { userErrors: UserError[] } }>(
      GRAPHQL_DOCUMENTS.unpublish,
      { id: productId, input: [{ publicationId }] },
      12,
    );
    const errors = data.publishableUnpublish.userErrors;
    if (errors.length) throw userErrors('Shopify didn’t unpublish the product', errors);
  }

  // ---- prices and costs -----------------------------------------------------------------------

  async readVariantPrices(
    variantIds: string[],
  ): Promise<Map<string, { price: number; compareAtPrice: number | null }>> {
    const prices = new Map<string, { price: number; compareAtPrice: number | null }>();
    for (let i = 0; i < variantIds.length; i += NODES_PER_READ) {
      const ids = variantIds.slice(i, i + NODES_PER_READ);
      const data = await this.client.request<{
        nodes: ({ id: string; price: string; compareAtPrice: string | null } | null)[];
      }>(GRAPHQL_DOCUMENTS.variantPricesRead, { ids }, ids.length + 1);
      for (const n of data.nodes) {
        // Deleted variants come back as null (or as an empty object for another type).
        if (n?.id)
          prices.set(n.id, { price: Number(n.price), compareAtPrice: money(n.compareAtPrice) });
      }
    }
    return prices;
  }

  async updateVariantPrices(
    productId: string,
    variants: VariantPriceInput[],
  ): Promise<{ failed: { variantId: string | null; message: string }[] }> {
    const failed: { variantId: string | null; message: string }[] = [];
    for (let i = 0; i < variants.length; i += PRICE_UPDATE_CHUNK) {
      const chunk = variants.slice(i, i + PRICE_UPDATE_CHUNK);
      const data = await this.client.request<{
        productVariantsBulkUpdate: { userErrors: UserError[] };
      }>(
        GRAPHQL_DOCUMENTS.variantPrices,
        {
          productId,
          variants: chunk.map((v) => ({
            id: v.id,
            price: v.price,
            // Left out = unchanged; null = removed.
            ...(v.compareAtPrice === undefined ? {} : { compareAtPrice: v.compareAtPrice }),
          })),
        },
        12 + chunk.length,
      );
      for (const e of data.productVariantsBulkUpdate.userErrors) {
        // field is ["variants", "<index in this call>", "price"] for a variant's own error.
        const index = e.field?.[0] === 'variants' ? Number(e.field[1]) : NaN;
        const variant = Number.isInteger(index) ? chunk[index] : undefined;
        failed.push({ variantId: variant?.id ?? null, message: e.message });
      }
    }
    return { failed };
  }

  async updateInventoryItemCost(inventoryItemId: string, cost: string): Promise<void> {
    const data = await this.client.request<{ inventoryItemUpdate: { userErrors: UserError[] } }>(
      GRAPHQL_DOCUMENTS.inventoryItemCost,
      { id: inventoryItemId, input: { cost } },
      12,
    );
    const errors = data.inventoryItemUpdate.userErrors;
    if (errors.length) throw userErrors('Shopify didn’t accept the cost', errors);
  }

  // ---- orders ---------------------------------------------------------------------------------

  async getOrder(orderId: string): Promise<ShopifyOrder | null> {
    const data = await this.client.request<{ order: OrderWithLines | null }>(
      GRAPHQL_DOCUMENTS.order,
      { id: orderId, linesAfter: null },
      ORDER_COST,
    );
    if (!data.order) return null;
    return this.withAllLines(data.order);
  }

  async listOrdersUpdatedSince(
    since: string,
    after: string | null,
  ): Promise<{ orders: ShopifyOrder[]; nextCursor: string | null }> {
    const data = await this.client.request<{
      orders: { nodes: OrderWithLines[]; pageInfo: PageInfo };
    }>(GRAPHQL_DOCUMENTS.orders, { query: `updated_at:>='${isoTime(since)}'`, after }, 760);
    const orders: ShopifyOrder[] = [];
    for (const node of data.orders.nodes) orders.push(await this.withAllLines(node));
    return {
      orders,
      nextCursor: data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null,
    };
  }

  /** The order with its first page of lines, completed with the order query when there are more. */
  private async withAllLines(node: OrderWithLines): Promise<ShopifyOrder> {
    const lines = node.lineItems.nodes.map(toOrderLine);
    let after = node.lineItems.pageInfo.hasNextPage ? node.lineItems.pageInfo.endCursor : null;
    while (after) {
      const page: { order: OrderWithLines | null } = await this.client.request(
        GRAPHQL_DOCUMENTS.order,
        { id: node.id, linesAfter: after },
        ORDER_COST,
      );
      if (!page.order) break;
      lines.push(...page.order.lineItems.nodes.map(toOrderLine));
      after = page.order.lineItems.pageInfo.hasNextPage
        ? page.order.lineItems.pageInfo.endCursor
        : null;
    }
    return toOrder(node, lines);
  }

  async startOrdersBulkExport(since: string): Promise<{ operationId: string }> {
    const query = GRAPHQL_DOCUMENTS.ordersBulkQuery.replace('__SINCE__', isoTime(since));
    const data = await this.client.request<{
      bulkOperationRunQuery: { bulkOperation: { id: string } | null; userErrors: UserError[] };
    }>(GRAPHQL_DOCUMENTS.bulkRun, { query }, 12);
    // No idempotency key: a retried request may start a second export, which is harmless (the
    // caller keeps the id it got; Shopify runs up to 5 at once).
    const { bulkOperation, userErrors: errors } = data.bulkOperationRunQuery;
    if (errors.some((e) => e.code === 'OPERATION_IN_PROGRESS' || e.code === 'LIMIT_REACHED')) {
      throw new BulkOperationInProgressError(
        `Shopify is already running another export for this store: ${errors.map((e) => e.message).join('; ')}`,
      );
    }
    if (errors.length) throw userErrors('Shopify didn’t start the order export', errors);
    if (!bulkOperation)
      throw new ShopifyApiError('bulkOperationRunQuery returned no operation', 'transient');
    return { operationId: bulkOperation.id };
  }

  async getBulkOperation(id: string): Promise<BulkOperationInfo | null> {
    const data = await this.client.request<{
      bulkOperation: {
        id: string;
        status: BulkOperationStatus;
        errorCode: string | null;
        createdAt: string;
        completedAt: string | null;
        objectCount: string;
        url: string | null;
        partialDataUrl: string | null;
      } | null;
    }>(GRAPHQL_DOCUMENTS.bulkStatus, { id }, 3);
    const op = data.bulkOperation;
    if (!op) return null;
    return {
      id: op.id,
      status: op.status,
      errorCode: op.errorCode,
      url: op.url,
      partialDataUrl: op.partialDataUrl,
      // UnsignedInt64 arrives as a string.
      objectCount: Number(op.objectCount),
      createdAt: op.createdAt,
      completedAt: op.completedAt,
    };
  }
}

/**
 * Orders from a bulk export's JSONL (GRAPHQL_DOCUMENTS.ordersBulkQuery): one JSON object per line,
 * orders and their line items as separate lines joined by `__parentId`. Since 2026-01 Shopify no
 * longer groups children after their parent, so the whole file is read before joining. Lines of
 * other types are skipped, and so are line items whose order isn't in the file.
 */
export async function parseOrdersBulkJsonl(lines: AsyncIterable<string>): Promise<ShopifyOrder[]> {
  const orders = new Map<string, OrderNode>();
  const children = new Map<string, ShopifyOrderLine[]>();
  let lineNo = 0;
  for await (const raw of lines) {
    lineNo++;
    const text = raw.trim();
    if (!text) continue;
    let obj: { id?: unknown; __parentId?: unknown };
    try {
      obj = JSON.parse(text) as typeof obj;
    } catch {
      throw new Error(`Line ${lineNo} of the order export is not valid JSON`);
    }
    if (typeof obj.id !== 'string') continue;
    if (obj.id.startsWith('gid://shopify/Order/') && obj.__parentId === undefined) {
      orders.set(obj.id, obj as OrderNode);
    } else if (obj.id.startsWith('gid://shopify/LineItem/') && typeof obj.__parentId === 'string') {
      const list = children.get(obj.__parentId) ?? [];
      list.push(toOrderLine(obj as OrderLineNode));
      children.set(obj.__parentId, list);
    }
  }
  return [...orders.values()].map((o) => toOrder(o, children.get(o.id) ?? []));
}

/** Rejects with ShopifyUserErrors: what Shopify refused, in its own words. */
function userErrors(what: string, errors: UserError[]): ShopifyUserErrors {
  const list: ShopifyUserError[] = errors.map((e) => ({
    code: e.code ?? null,
    field: e.field ?? null,
    message: e.message,
  }));
  return new ShopifyUserErrors(
    `${what}: ${list.map((e) => e.message.replace(/\.+$/, '')).join('; ')}`,
    list,
  );
}

/**
 * An ISO timestamp for a Shopify search query (never raw input: it ends up inside a query), in
 * whole seconds as Shopify's search syntax shows them ('2026-10-01T10:20:30Z'). Rounded down: the
 * queries are `>=`, so they may include a little more, never less.
 */
function isoTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a timestamp: ${value}`);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Decimal strings (Money, Decimal) as numbers; null stays null. */
function money(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function isImage(m: MediaNode): boolean {
  return m.mediaContentType === 'IMAGE';
}

function toProductImage(m: MediaNode): ShopifyProductImage {
  return { id: m.id, alt: m.alt ?? '', status: m.status, url: m.image?.url ?? null };
}

function toProductVariant(n: ProductVariantDetailNode): ShopifyProductVariant {
  return {
    id: n.id,
    sku: n.sku,
    title: n.title,
    position: n.position,
    barcode: n.barcodes.nodes[0]?.value ?? null,
    price: Number(n.price),
    compareAtPrice: money(n.compareAtPrice),
    taxable: n.taxable,
    inventoryPolicy: n.inventoryPolicy,
    selectedOptions: n.selectedOptions.map((o) => ({ name: o.name, value: o.value })),
    mediaId: n.media.nodes[0]?.id ?? null,
    inventoryItemId: n.inventoryItem.id,
    tracked: n.inventoryItem.tracked,
    requiresShipping: n.inventoryItem.requiresShipping,
    weight: n.inventoryItem.measurement.weight
      ? {
          unit: n.inventoryItem.measurement.weight.unit,
          value: n.inventoryItem.measurement.weight.value,
        }
      : null,
    unitCost: money(n.inventoryItem.unitCost?.amount),
  };
}

function toOrder(n: OrderNode, lines: ShopifyOrderLine[]): ShopifyOrder {
  return {
    id: n.id,
    name: n.name,
    processedAt: n.processedAt,
    updatedAt: n.updatedAt,
    cancelledAt: n.cancelledAt,
    test: n.test,
    currencyCode: n.currencyCode,
    sourceName: n.sourceName,
    taxesIncluded: n.taxesIncluded,
    lines,
  };
}

function toOrderLine(n: OrderLineNode): ShopifyOrderLine {
  const discounts = n.discountAllocations.reduce(
    (sum, d) => sum + Number(d.allocatedAmountSet.shopMoney.amount),
    0,
  );
  return {
    id: n.id,
    sku: n.sku,
    quantity: n.quantity,
    currentQuantity: n.currentQuantity,
    isGiftCard: n.isGiftCard,
    variantId: n.variant?.id ?? null,
    inventoryItemId: n.variant?.inventoryItem?.id ?? null,
    unitPrice: Number(n.originalUnitPriceSet.shopMoney.amount),
    // Summing decimal strings as floats leaves noise (0.1 + 0.2): amounts have 4 decimals at most.
    discounts: roundMoney(discounts, 4),
    net: Number(n.priceAfterAllDiscountsBeforeTaxesSet.shopMoney.amount),
  };
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
    price: money(n.price),
    compareAtPrice: money(n.compareAtPrice),
  };
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
