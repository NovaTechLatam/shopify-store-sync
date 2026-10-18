import { describe, expect, it } from 'vitest';
import {
  BulkOperationInProgressError,
  ShopifyApiError,
  ShopifyUserErrors,
} from '../src/shopify/client.js';
import { parseOrdersBulkJsonl } from '../src/shopify/graphql-admin.js';
import type { ProductSetInputJson } from '../src/shopify/types.js';
import { FakeShop } from './fakes/fake-shopify.js';

// The fake stands in for Shopify in the feature tests, so its semantics are pinned here.

const PRODUCT_SCOPES = ['read_products', 'write_products', 'read_inventory', 'write_inventory'];

function shopWith(scopes: string[] = PRODUCT_SCOPES) {
  const shop = new FakeShop('brand.myshopify.com', 'Brand');
  const location = shop.addLocation('Main');
  shop.scopes = [...scopes, 'read_locations'];
  return { shop, location };
}

const teeInput = (location: string): ProductSetInputJson => ({
  title: 'Organic Tee',
  descriptionHtml: '<p>Soft</p>',
  tags: ['summer'],
  status: 'DRAFT',
  productOptions: [{ name: 'Size', values: [{ name: 'S' }, { name: 'M' }] }],
  files: [{ originalSource: 'https://example.com/front.jpg', alt: 'Front', contentType: 'IMAGE' }],
  variants: [
    {
      optionValues: [{ optionName: 'Size', name: 'S' }],
      sku: 'TEE-S',
      price: '49.90',
      compareAtPrice: '59.90',
      barcodes: [{ value: '4006381333931' }],
      inventoryItem: {
        tracked: true,
        cost: '12.50',
        measurement: { weight: { unit: 'GRAMS', value: 250 } },
      },
      inventoryQuantities: [{ locationId: location, name: 'available', quantity: 0 }],
      file: { originalSource: 'https://example.com/front.jpg', alt: 'Front', contentType: 'IMAGE' },
    },
    {
      optionValues: [{ optionName: 'Size', name: 'M' }],
      sku: 'TEE-M',
      price: '49.90',
      inventoryQuantities: [{ locationId: location, name: 'available', quantity: 3 }],
    },
  ],
});

describe('FakeShop products', () => {
  it('creates a product by custom id; a retried create updates it instead of duplicating it', async () => {
    const { shop, location } = shopWith();
    shop.failNext('productSet', 'throw_after'); // created, but the answer is lost
    await expect(
      shop.productSet({ identifier: { customId: '7' }, input: teeInput(location) }),
    ).rejects.toMatchObject({ kind: 'transient' });
    const result = await shop.productSet({
      identifier: { customId: '7' },
      input: teeInput(location),
    });

    const productIds = new Set(shop.variants.map((v) => v.productId));
    expect(productIds).toEqual(new Set([result.productId]));
    expect(shop.customIdOf(result.productId)).toBe('7');
    expect(result).toMatchObject({
      handle: 'organic-tee',
      media: [{ alt: 'Front', status: 'UPLOADED' }],
      variants: [
        { sku: 'TEE-S', selectedOptions: [{ name: 'Size', value: 'S' }] },
        { sku: 'TEE-M', selectedOptions: [{ name: 'Size', value: 'M' }] },
      ],
    });
    // New variants have inventory items the stock sync sees, stocked as asked.
    const [s, m] = result.variants;
    expect(await shop.listVariantsByInventoryItem(m!.inventoryItemId)).toEqual([
      expect.objectContaining({
        sku: 'TEE-M',
        productTitle: 'Organic Tee',
        variantTitle: 'M',
        price: 49.9,
      }),
    ]);
    expect(shop.level(s!.inventoryItemId, location)).toBe(0);
    expect(shop.level(m!.inventoryItemId, location)).toBe(3);

    const product = await shop.getProduct(result.productId);
    expect(product).toMatchObject({
      title: 'Organic Tee',
      status: 'DRAFT',
      tags: ['summer'],
      options: [{ name: 'Size', values: [{ name: 'S' }, { name: 'M' }] }],
      media: [
        {
          id: result.media[0]!.id,
          status: 'READY',
          url: expect.stringMatching(/^https:\/\/cdn\.shopify\.com\//),
        },
      ],
    });
    expect(product!.variants[0]).toMatchObject({
      sku: 'TEE-S',
      barcode: '4006381333931',
      price: 49.9,
      compareAtPrice: 59.9,
      mediaId: result.media[0]!.id,
      unitCost: 12.5,
      weight: { unit: 'GRAMS', value: 250 },
      position: 1,
    });
  });

  it('replaces variants and images on update: kept ones by id, missing ones deleted', async () => {
    const { shop, location } = shopWith();
    const created = await shop.productSet({ identifier: null, input: teeInput(location) });
    const [s, m] = created.variants;
    const product = (await shop.getProduct(created.productId))!;
    const updated = await shop.productSet({
      identifier: { id: created.productId },
      input: {
        title: 'Organic Tee 2',
        productOptions: [
          {
            id: product.options[0]!.id,
            values: [{ id: product.options[0]!.values[0]!.id }, { name: 'L' }],
          },
        ],
        variants: [
          { id: s!.id, optionValues: [{ optionName: 'Size', name: 'S' }], price: '45.00' },
          { optionValues: [{ optionName: 'Size', name: 'L' }], sku: 'TEE-L' },
        ],
        files: [{ originalSource: 'https://example.com/back.jpg', alt: 'Back' }],
      },
    });
    expect(updated.variants.map((v) => [v.id === s!.id, v.sku])).toEqual([
      [true, 'TEE-S'],
      [false, 'TEE-L'],
    ]);
    expect(shop.variants.some((v) => v.variantId === m!.id)).toBe(false);
    expect(shop.level(m!.inventoryItemId, location)).toBeUndefined();
    expect(shop.variants.find((v) => v.variantId === s!.id)).toMatchObject({
      price: 45,
      compareAtPrice: 59.9, // not sent: unchanged
      productTitle: 'Organic Tee 2',
    });
    const after = (await shop.getProduct(created.productId))!;
    expect(after.media.map((x) => x.alt)).toEqual(['Back']);
    // Its image was removed with the product's images.
    expect(after.variants[0]!.mediaId).toBeNull();

    // Fields left out stay as they were.
    await shop.productSet({ identifier: { id: created.productId }, input: { vendor: 'Acme' } });
    expect((await shop.getProduct(created.productId))!).toMatchObject({
      title: 'Organic Tee 2',
      vendor: 'Acme',
      descriptionHtml: '<p>Soft</p>',
    });
    expect((await shop.getProduct(created.productId))!.variants).toHaveLength(2);
  });

  it('refuses what Shopify refuses, changing nothing', async () => {
    const { shop, location } = shopWith();
    const created = await shop.productSet({ identifier: null, input: teeInput(location) });
    const userError = (p: Promise<unknown>): Promise<ShopifyUserErrors> =>
      p.then(
        () => {
          throw new Error('expected Shopify to refuse');
        },
        (e: unknown) => e as ShopifyUserErrors,
      );

    const missing = await userError(
      shop.productSet({ identifier: { id: 'gid://shopify/Product/1' }, input: { title: 'X' } }),
    );
    expect(missing).toBeInstanceOf(ShopifyUserErrors);
    expect(missing.errors[0]!.code).toBe('PRODUCT_DOES_NOT_EXIST');

    const taken = await userError(
      shop.productSet({ identifier: null, input: { title: 'Other', handle: 'organic-tee' } }),
    );
    expect(taken.errors.map((e) => e.code)).toEqual(['HANDLE_NOT_UNIQUE']);

    const alone = await userError(
      shop.productSet({
        identifier: { id: created.productId },
        input: { variants: [{ optionValues: [{ optionName: 'Size', name: 'S' }] }] },
      }),
    );
    expect(alone.errors.map((e) => e.code)).toEqual(['PRODUCT_OPTIONS_INPUT_MISSING']);

    const badValue = await userError(
      shop.productSet({
        identifier: { id: created.productId },
        input: {
          productOptions: [{ name: 'Size', values: [{ name: 'S' }] }],
          variants: [{ optionValues: [{ optionName: 'Size', name: 'XXL' }], sku: 'TEE-XXL' }],
        },
      }),
    );
    expect(badValue.errors.map((e) => e.code)).toEqual(['OPTION_VALUE_DOES_NOT_EXIST']);
    expect((await shop.getProduct(created.productId))!.variants).toHaveLength(2);

    // Like Shopify, a SKU may be used by two products.
    const twin = await shop.productSet({
      identifier: null,
      input: {
        title: 'Twin',
        productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
        variants: [
          { optionValues: [{ optionName: 'Title', name: 'Default Title' }], sku: 'TEE-S' },
        ],
      },
    });
    expect(shop.variants.filter((v) => v.sku === 'TEE-S')).toHaveLength(2);
    expect(twin.handle).toBe('twin');
  });

  it('gives a product made with addVariant the shape Shopify would', async () => {
    const { shop } = shopWith();
    const v = shop.addVariant('CAP', { productTitle: 'Waxed Cap', price: 25 });
    const product = await shop.getProduct(v.productId);
    expect(product).toMatchObject({
      title: 'Waxed Cap',
      handle: 'waxed-cap',
      options: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants: [{ id: v.variantId, sku: 'CAP', price: 25, position: 1 }],
    });
    expect(await shop.getProduct('gid://shopify/Product/404')).toBeNull();
  });

  it('needs the optional scopes, as Shopify answers ACCESS_DENIED', async () => {
    const { shop, location } = shopWith(['read_products', 'read_inventory', 'write_inventory']);
    const denied = { kind: 'auth', message: expect.stringContaining('write_products') };
    await expect(
      shop.productSet({ identifier: null, input: teeInput(location) }),
    ).rejects.toMatchObject(denied);
    await expect(shop.updateVariantPrices('gid://shopify/Product/1', [])).rejects.toMatchObject(
      denied,
    );
    await expect(shop.ensureProductIdDefinition()).rejects.toMatchObject(denied);
    await expect(
      shop.stageImage({ filename: 'a.png', mimeType: 'image/png', data: Buffer.from('x') }),
    ).rejects.toMatchObject(denied);
    await expect(shop.findOnlineStorePublication()).rejects.toMatchObject({ kind: 'auth' });
    await expect(shop.publishProduct('x', 'y')).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringContaining('write_publications'),
    });
    for (const call of [
      () => shop.getOrder('gid://shopify/Order/1'),
      () => shop.listOrdersUpdatedSince('2026-01-01T00:00:00Z', null),
      () => shop.startOrdersBulkExport('2026-01-01T00:00:00Z'),
    ])
      await expect(call()).rejects.toMatchObject({
        kind: 'auth',
        message: expect.stringContaining('read_orders'),
      });
    // Reading products needs only read_products.
    const v = shop.addVariant('CAP');
    await expect(shop.getProduct(v.productId)).resolves.not.toBeNull();
    expect(shop.calls.some((c) => c.op === 'productSet')).toBe(true);
  });
});

describe('FakeShop prices, costs, images and publishing', () => {
  it('updates the prices it accepts and reports the others', async () => {
    const { shop, location } = shopWith();
    const { productId, variants } = await shop.productSet({
      identifier: null,
      input: teeInput(location),
    });
    const [s, m] = variants;
    const other = shop.addVariant('OTHER');
    const { failed } = await shop.updateVariantPrices(productId, [
      { id: s!.id, price: '39.90', compareAtPrice: null },
      { id: m!.id, price: '-1' },
      { id: other.variantId, price: '5' },
    ]);
    expect(failed).toEqual([
      { variantId: m!.id, message: 'Price must be greater than or equal to 0' },
      { variantId: other.variantId, message: 'Product variant does not exist' },
    ]);
    expect(shop.variants.find((v) => v.variantId === s!.id)).toMatchObject({
      price: 39.9,
      compareAtPrice: null,
    });
    expect(shop.variants.find((v) => v.variantId === m!.id)!.price).toBe(49.9);
    expect(await shop.updateVariantPrices('gid://shopify/Product/404', [])).toEqual({
      failed: [{ variantId: null, message: 'Product does not exist' }],
    });
  });

  it('sets costs, stages uploads and publishes to the Online Store', async () => {
    const { shop, location } = shopWith([...PRODUCT_SCOPES, 'write_publications']);
    const { productId, variants } = await shop.productSet({
      identifier: null,
      input: teeInput(location),
    });
    await shop.updateInventoryItemCost(variants[1]!.inventoryItemId, '7.25');
    expect((await shop.getProduct(productId))!.variants[1]!.unitCost).toBe(7.25);
    await expect(
      shop.updateInventoryItemCost('gid://shopify/InventoryItem/404', '1'),
    ).rejects.toBeInstanceOf(ShopifyUserErrors);

    const data = Buffer.from([1, 2, 3]);
    const url = await shop.stageImage({ filename: 'front.png', mimeType: 'image/png', data });
    expect(shop.stagedUploads).toEqual([
      { filename: 'front.png', mimeType: 'image/png', data, resourceUrl: url },
    ]);

    const publication = await shop.findOnlineStorePublication();
    expect(publication).toBe(shop.publications[0]!.id);
    await shop.publishProduct(productId, publication!);
    await shop.publishProduct(productId, publication!); // already published: no change
    expect(shop.isPublished(productId)).toBe(true);
    await shop.unpublishProduct(productId, publication!);
    expect(shop.isPublished(productId)).toBe(false);
    await expect(
      shop.publishProduct('gid://shopify/Product/404', publication!),
    ).rejects.toBeInstanceOf(ShopifyUserErrors);
  });
});

describe('FakeShop orders', () => {
  it('pages orders by update time and reads one order', async () => {
    const { shop } = shopWith(['read_orders']);
    const tee = shop.addVariant('TEE', { price: 20 });
    const old = shop.addOrder({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const orders = [1, 2, 3].map((q) =>
      shop.addOrder({ lines: [{ variantId: tee.variantId, quantity: q }] }),
    );
    shop.orderPageSize = 2;
    const since = '2026-06-01T00:00:00Z';
    const first = await shop.listOrdersUpdatedSince(since, null);
    expect(first.orders.map((o) => o.id)).toEqual([orders[0]!.id, orders[1]!.id]);
    const second = await shop.listOrdersUpdatedSince(since, first.nextCursor);
    expect(second).toEqual({ orders: [orders[2]], nextCursor: null });
    expect(orders[2]!.lines[0]).toMatchObject({
      sku: 'TEE',
      inventoryItemId: tee.inventoryItemId,
      quantity: 3,
      currentQuantity: 3,
      unitPrice: 20,
      net: 60,
    });

    // A refund updates the order: it moves to the end.
    shop.updateOrder(orders[0]!.id, {
      lines: [{ ...orders[0]!.lines[0], currentQuantity: 0, net: 0 }],
    });
    const all = await shop.listOrdersUpdatedSince(since, null);
    shop.orderPageSize = 10;
    expect((await shop.listOrdersUpdatedSince(since, null)).orders.map((o) => o.id)).toEqual([
      orders[1]!.id,
      orders[2]!.id,
      orders[0]!.id,
    ]);
    expect(all.orders).toHaveLength(2);
    expect((await shop.getOrder(orders[0]!.id))!.lines[0]!.currentQuantity).toBe(0);
    expect(await shop.getOrder(old.id)).toMatchObject({ updatedAt: '2026-01-01T00:00:00.000Z' });
    shop.deleteOrder(old.id);
    expect(await shop.getOrder(old.id)).toBeNull();
  });

  it('keeps its place when an order changes between two pages, as Shopify’s cursors do', async () => {
    const { shop } = shopWith(['read_orders']);
    const orders = [1, 2, 3, 4].map(() => shop.addOrder());
    shop.orderPageSize = 2;
    const since = '2026-01-01T00:00:00Z';
    const first = await shop.listOrdersUpdatedSince(since, null);
    expect(first.orders.map((o) => o.id)).toEqual([orders[0]!.id, orders[1]!.id]);
    // Order 1 is refunded meanwhile: it moves behind the others.
    shop.updateOrder(orders[0]!.id, { cancelledAt: new Date().toISOString() });
    const second = await shop.listOrdersUpdatedSince(since, first.nextCursor);
    expect(second.orders.map((o) => o.id)).toEqual([orders[2]!.id, orders[3]!.id]);
    const third = await shop.listOrdersUpdatedSince(since, second.nextCursor);
    expect(third).toEqual({
      orders: [expect.objectContaining({ id: orders[0]!.id })],
      nextCursor: null,
    });
  });

  it('exports orders as Shopify’s JSONL, which parseOrdersBulkJsonl reads back', async () => {
    const { shop } = shopWith(['read_orders']);
    const tee = shop.addVariant('TEE', { price: 20 });
    const orders = [
      shop.addOrder({
        lines: [
          { variantId: tee.variantId, quantity: 2, discounts: 5 },
          { sku: 'GIFT', isGiftCard: true, unitPrice: 50 },
        ],
      }),
      shop.addOrder({ test: true, lines: [{ variantId: tee.variantId }] }),
    ];
    const { operationId } = await shop.startOrdersBulkExport('2026-01-01T00:00:00Z');
    const op = (await shop.getBulkOperation(operationId))!;
    expect(op).toMatchObject({ status: 'COMPLETED', objectCount: 5, errorCode: null });
    const res = await shop.bulkFetch(op.url!);
    const text = await res.text();
    // Children come before their parent.
    expect(JSON.parse(text.split('\n')[0]!)).toHaveProperty('__parentId', orders[0]!.id);
    async function* lines() {
      yield* text.split('\n');
    }
    expect(await parseOrdersBulkJsonl(lines())).toEqual(orders);

    // Nothing matches: no file.
    const empty = await shop.startOrdersBulkExport('2099-01-01T00:00:00Z');
    expect(await shop.getBulkOperation(empty.operationId)).toMatchObject({
      objectCount: 0,
      url: null,
    });
  });

  it('runs exports until told to finish, and refuses a second one while busy', async () => {
    const { shop } = shopWith(['read_orders']);
    shop.addOrder({ lines: [{ sku: 'TEE' }] });
    shop.bulkStartStatus = 'RUNNING';
    const { operationId } = await shop.startOrdersBulkExport('2026-01-01T00:00:00Z');
    expect(await shop.getBulkOperation(operationId)).toMatchObject({
      status: 'RUNNING',
      url: null,
    });
    shop.finishBulkOperation(operationId);
    expect(await shop.getBulkOperation(operationId)).toMatchObject({
      status: 'COMPLETED',
      objectCount: 2,
      url: expect.stringMatching(/\.jsonl$/),
    });
    const failing = await shop.startOrdersBulkExport('2026-01-01T00:00:00Z');
    shop.finishBulkOperation(failing.operationId, 'FAILED', 'ACCESS_DENIED');
    expect(await shop.getBulkOperation(failing.operationId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'ACCESS_DENIED',
      url: null,
    });
    expect(await shop.getBulkOperation('gid://shopify/BulkOperation/1')).toBeNull();

    shop.bulkBusy = true;
    const err = await shop.startOrdersBulkExport('2026-01-01T00:00:00Z').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BulkOperationInProgressError);
    expect(err).toBeInstanceOf(ShopifyApiError);
  });
});
