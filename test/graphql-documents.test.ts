import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  NoDeprecatedCustomRule,
  buildClientSchema,
  getVariableValues,
  parse,
  validate,
  type IntrospectionQuery,
  type OperationDefinitionNode,
} from 'graphql';
import { describe, expect, it } from 'vitest';
import type { ShopifyGraphqlClient } from '../src/shopify/client.js';
import { GRAPHQL_DOCUMENTS, GraphqlShopifyAdmin } from '../src/shopify/graphql-admin.js';
import type { ProductSetInputJson, ProductVariantSetInputJson } from '../src/shopify/types.js';

// Introspection of the Admin API 2026-10 schema (from the @shopify/dev-mcp package).
const introspection = JSON.parse(
  gunzipSync(
    readFileSync(new URL('./fixtures/shopify-admin-2026-10.schema.json.gz', import.meta.url)),
  ).toString(),
) as { data?: IntrospectionQuery } & IntrospectionQuery;
const schema = buildClientSchema(introspection.data ?? introspection);

/**
 * Deprecated fields still in use, on purpose. The stock sync's variant reads use
 * ProductVariant.barcode (deprecated in 2026-10 for `barcodes`, still served, returns the first
 * barcode). Replacing it with `barcodes(first: 1)` adds a connection per variant: about 3 more
 * points each, which would push a 200-variant page past Shopify's 1,000-point query limit and
 * double what a catalog sync spends of the rate limit it shares with stock writes. Move them when
 * the field is removed (the next API version bump shows it), together with smaller pages.
 */
const ALLOWED_DEPRECATED: Record<string, string[]> = {
  variants: ['ProductVariant.barcode'],
  productVariants: ['ProductVariant.barcode'],
  inventoryItemVariants: ['ProductVariant.barcode'],
};

describe('GraphQL documents', () => {
  for (const [name, source] of Object.entries(GRAPHQL_DOCUMENTS)) {
    it(`${name} is valid against Admin API 2026-10`, () => {
      const errors = validate(schema, parse(source)).map((e) => e.message);
      expect(errors).toEqual([]);
    });

    it(`${name} uses no deprecated fields or values`, () => {
      const allowed = ALLOWED_DEPRECATED[name] ?? [];
      const errors = validate(schema, parse(source), [NoDeprecatedCustomRule])
        .map((e) => e.message)
        .filter((m) => !allowed.some((field) => m.startsWith(`The field ${field} is deprecated`)));
      expect(errors).toEqual([]);
    });
  }

  it('never uses inventory fields removed in 2026-04', () => {
    for (const source of Object.values(GRAPHQL_DOCUMENTS)) {
      expect(source).not.toMatch(/compareQuantity|ignoreCompareQuantity/);
    }
  });

  it('only allows deprecated fields that are actually used', () => {
    for (const [name, fields] of Object.entries(ALLOWED_DEPRECATED)) {
      const messages = validate(
        schema,
        parse(GRAPHQL_DOCUMENTS[name as keyof typeof GRAPHQL_DOCUMENTS]),
        [NoDeprecatedCustomRule],
      ).map((e) => e.message);
      for (const field of fields)
        expect(messages.some((m) => m.startsWith(`The field ${field} is deprecated`))).toBe(true);
    }
  });
});

/** Just enough of each answer for the adapter to carry on. */
const EMPTY_PAGE = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
const REPLIES: Record<string, unknown> = {
  StoreSyncProductSet: {
    productSet: {
      product: {
        id: 'gid://shopify/Product/1',
        handle: 'tee',
        media: EMPTY_PAGE,
        variants: EMPTY_PAGE,
      },
      productSetOperation: null,
      userErrors: [],
    },
  },
  StoreSyncStagedUploadsCreate: {
    stagedUploadsCreate: {
      stagedTargets: [
        { url: 'https://upload.test/', resourceUrl: 'https://upload.test/r', parameters: [] },
      ],
      userErrors: [],
    },
  },
  StoreSyncProductIdDefinition: { metafieldDefinitionCreate: { userErrors: [] } },
  StoreSyncPublish: { publishablePublish: { userErrors: [] } },
  StoreSyncUnpublish: { publishableUnpublish: { userErrors: [] } },
  StoreSyncVariantPrices: { productVariantsBulkUpdate: { userErrors: [] } },
  StoreSyncVariantPricesRead: { nodes: [] },
  StoreSyncInventoryItemCost: { inventoryItemUpdate: { userErrors: [] } },
  StoreSyncBulkRun: {
    bulkOperationRunQuery: {
      bulkOperation: { id: 'gid://shopify/BulkOperation/1' },
      userErrors: [],
    },
  },
  StoreSyncOrders: { orders: EMPTY_PAGE },
  StoreSyncOrder: { order: null },
  StoreSyncProduct: { product: null },
  StoreSyncBulkStatus: { bulkOperation: null },
  StoreSyncPublications: { publications: EMPTY_PAGE },
  StoreSyncWebhookCreate: { webhookSubscriptionCreate: { userErrors: [] } },
};

describe('GraphQL variables', () => {
  it('the adapter sends variables Admin API 2026-10 accepts (input shapes, enums, scalars)', async () => {
    const problems: string[] = [];
    const sent = new Set<string>();
    const client = {
      fetchFn: async () => new Response(null, { status: 204 }),
      async request(query: string, variables: Record<string, unknown> = {}) {
        const op = parse(query).definitions.find(
          (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition',
        )!;
        const name = op.name!.value;
        sent.add(name);
        const { errors } = getVariableValues(schema, op.variableDefinitions ?? [], variables);
        for (const e of errors ?? []) problems.push(`${name}: ${e.message}`);
        return REPLIES[name];
      },
    } as unknown as ShopifyGraphqlClient;
    const admin = new GraphqlShopifyAdmin(client);

    // Every field our ProductSetInputJson allows, as catalog publishing will send them.
    const image = {
      originalSource: 'https://cdn.shopify.com/front.jpg',
      alt: 'Front',
      contentType: 'IMAGE' as const,
      filename: 'front.jpg',
    };
    const variant: ProductVariantSetInputJson = {
      optionValues: [{ optionName: 'Size', name: 'S' }],
      sku: 'TEE-S',
      barcodes: [{ value: '4006381333931' }],
      price: '12.90',
      compareAtPrice: null,
      taxable: true,
      inventoryPolicy: 'DENY',
      position: 1,
      inventoryItem: {
        tracked: true,
        requiresShipping: true,
        cost: '4.50',
        measurement: { weight: { unit: 'GRAMS', value: 250 } },
      },
      inventoryQuantities: [
        { locationId: 'gid://shopify/Location/1', name: 'available', quantity: 0 },
      ],
      file: image,
    };
    const create: ProductSetInputJson = {
      title: 'Tee',
      descriptionHtml: '<p>Soft</p>',
      handle: 'tee',
      redirectNewHandle: true,
      vendor: 'Brand',
      productType: 'Shirts',
      tags: ['summer'],
      status: 'DRAFT',
      seo: { title: 'Tee', description: null },
      productOptions: [{ name: 'Size', position: 1, values: [{ name: 'S' }] }],
      variants: [variant],
      files: [image],
    };
    const update: ProductSetInputJson = {
      ...create,
      productOptions: [
        {
          id: 'gid://shopify/ProductOption/1',
          values: [{ id: 'gid://shopify/ProductOptionValue/1' }],
        },
      ],
      variants: [
        {
          ...variant,
          id: 'gid://shopify/ProductVariant/1',
          optionValues: [
            { optionId: 'gid://shopify/ProductOption/1', id: 'gid://shopify/ProductOptionValue/1' },
          ],
          inventoryQuantities: undefined,
          compareAtPrice: '15.90',
          file: { id: 'gid://shopify/MediaImage/1' },
        },
      ],
      files: [{ id: 'gid://shopify/MediaImage/1', alt: 'Front' }],
    };
    await admin.productSet({ identifier: { customId: '12' }, input: create });
    await admin.productSet({ identifier: null, input: create });
    await admin.productSet({ identifier: { id: 'gid://shopify/Product/1' }, input: update });
    await admin.stageImage({
      filename: 'front.png',
      mimeType: 'image/png',
      data: Buffer.from('x'),
    });
    await admin.ensureProductIdDefinition();
    await admin.publishProduct('gid://shopify/Product/1', 'gid://shopify/Publication/1');
    await admin.unpublishProduct('gid://shopify/Product/1', 'gid://shopify/Publication/1');
    await admin.updateVariantPrices('gid://shopify/Product/1', [
      { id: 'gid://shopify/ProductVariant/1', price: '10.00', compareAtPrice: null },
      { id: 'gid://shopify/ProductVariant/2', price: '11.00' },
      { id: 'gid://shopify/ProductVariant/3', price: '12.00', compareAtPrice: '15.00' },
    ]);
    await admin.updateInventoryItemCost('gid://shopify/InventoryItem/1', '4.50');
    await admin.readVariantPrices(['gid://shopify/ProductVariant/1']);
    await admin.startOrdersBulkExport('2026-08-18T00:00:00Z');
    await admin.listOrdersUpdatedSince('2026-08-18T00:00:00Z', null);
    await admin.getOrder('gid://shopify/Order/1');
    await admin.getProduct('gid://shopify/Product/1');
    await admin.getBulkOperation('gid://shopify/BulkOperation/1');
    await admin.findOnlineStorePublication();
    await admin.createWebhookSubscription('ORDERS_CREATE', 'https://sync.test/webhooks/shopify');

    expect(problems).toEqual([]);
    expect(sent.size).toBe(Object.keys(REPLIES).length);
  });
});
