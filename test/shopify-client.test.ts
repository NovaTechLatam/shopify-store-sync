import { describe, expect, it } from 'vitest';
import {
  BulkOperationInProgressError,
  ClientCredentialsTokenProvider,
  ShopifyApiError,
  ShopifyGraphqlClient,
  ShopifyUserErrors,
  StaticTokenProvider,
  type TokenProvider,
} from '../src/shopify/client.js';
import {
  GraphqlShopifyAdmin,
  interpretSetResult,
  parseOrdersBulkJsonl,
} from '../src/shopify/graphql-admin.js';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch stub that returns the queued replies in order and records every request. */
function fakeFetch(replies: Reply[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const reply = replies.shift();
    if (!reply) throw new Error('no more replies');
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  }) as unknown as typeof fetch;
  return { fn, requests };
}

const noSleep = async () => {};

function client(replies: Reply[], tokens: TokenProvider = new StaticTokenProvider('shpat_test')) {
  const f = fakeFetch(replies);
  const c = new ShopifyGraphqlClient({
    shopDomain: 'brand.myshopify.com',
    apiVersion: '2026-10',
    tokens,
    fetchFn: f.fn,
    sleep: noSleep,
  });
  return { c, requests: f.requests };
}

describe('ShopifyGraphqlClient', () => {
  it('sends the query to the versioned endpoint with the access token', async () => {
    const { c, requests } = client([{ body: { data: { shop: { name: 'Brand' } } } }]);
    const data = await c.request<{ shop: { name: string } }>('query { shop { name } }');
    expect(data.shop.name).toBe('Brand');
    expect(requests[0]!.url).toBe('https://brand.myshopify.com/admin/api/2026-10/graphql.json');
    expect((requests[0]!.init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(
      'shpat_test',
    );
  });

  it('retries THROTTLED responses and then succeeds', async () => {
    const throttled = {
      body: {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: {
          cost: {
            requestedQueryCost: 50,
            throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 10, restoreRate: 100 },
          },
        },
      },
    };
    const { c, requests } = client([throttled, throttled, { body: { data: { ok: true } } }]);
    await expect(c.request('query { ok }')).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(3);
  });

  it('retries 5xx and network errors, then gives up as transient', async () => {
    const replies: Reply[] = [
      new Error('ECONNRESET'),
      { status: 502 },
      { body: { data: { ok: 1 } } },
    ];
    const { c } = client(replies);
    await expect(c.request('query { ok }')).resolves.toEqual({ ok: 1 });

    const failing = client(Array.from({ length: 10 }, () => ({ status: 503 })));
    await expect(failing.c.request('query { ok }')).rejects.toMatchObject({ kind: 'transient' });
  });

  it('never sends a request marked `once` twice when it may have got through', async () => {
    for (const unsure of [new Error('The operation was aborted due to timeout'), { status: 502 }]) {
      const { c, requests } = client([unsure, { body: { data: { ok: 1 } } }]);
      await expect(c.request('mutation { ok }', {}, 10, { once: true })).rejects.toMatchObject({
        kind: 'transient',
      });
      expect(requests).toHaveLength(1);
    }
    // Throttling is refused before anything is done: that is retried.
    const { c, requests } = client([{ status: 429 }, { body: { data: { ok: 1 } } }]);
    await expect(c.request('mutation { ok }', {}, 10, { once: true })).resolves.toEqual({ ok: 1 });
    expect(requests).toHaveLength(2);
  });

  it('classifies auth and unavailable shops', async () => {
    await expect(client([{ status: 401 }, { status: 401 }]).c.request('q')).rejects.toMatchObject({
      kind: 'auth',
    });
    await expect(client([{ status: 402 }]).c.request('q')).rejects.toMatchObject({
      kind: 'store_unavailable',
    });
    await expect(
      client([{ body: { errors: [{ message: 'Field x does not exist' }] } }]).c.request('q'),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refreshes a client-credentials token once on 401', async () => {
    const tokenReplies: Reply[] = [
      { body: { access_token: 'first', expires_in: 86399 } },
      { body: { access_token: 'second', expires_in: 86399 } },
    ];
    const tokenFetch = fakeFetch(tokenReplies);
    const tokens = new ClientCredentialsTokenProvider(
      'brand.myshopify.com',
      'id',
      'secret',
      tokenFetch.fn,
    );
    const { c, requests } = client([{ status: 401 }, { body: { data: { ok: true } } }], tokens);
    await expect(c.request('query { ok }')).resolves.toEqual({ ok: true });
    const used = requests.map(
      (r) => (r.init.headers as Record<string, string>)['X-Shopify-Access-Token'],
    );
    expect(used).toEqual(['first', 'second']);
    expect(String(tokenFetch.requests[0]!.init.body)).toContain('grant_type=client_credentials');
  });

  it('caches client-credentials tokens until shortly before they expire', async () => {
    let now = 0;
    const tokenFetch = fakeFetch([
      { body: { access_token: 'a', expires_in: 86399 } },
      { body: { access_token: 'b', expires_in: 86399 } },
    ]);
    const tokens = new ClientCredentialsTokenProvider(
      's.myshopify.com',
      'id',
      'secret',
      tokenFetch.fn,
      () => now,
    );
    expect(await tokens.getToken()).toBe('a');
    now = 60 * 60_000;
    expect(await tokens.getToken()).toBe('a');
    now = 86_399_000 - 60_000; // within 5 minutes of expiry
    expect(await tokens.getToken()).toBe('b');
  });

  it('reports a rejected client-credentials request as an auth problem', async () => {
    const tokenFetch = fakeFetch([{ status: 400, body: { error: 'shop_not_permitted' } }]);
    const tokens = new ClientCredentialsTokenProvider(
      's.myshopify.com',
      'id',
      'secret',
      tokenFetch.fn,
    );
    const err = await tokens.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect((err as ShopifyApiError).kind).toBe('auth');
    expect((err as ShopifyApiError).message).toContain('shop_not_permitted');
  });
  it('reserves points for requests in flight, so concurrent callers do not overdraw the bucket', async () => {
    const bucket = (available: number) => ({
      data: { ok: true },
      extensions: {
        cost: {
          throttleStatus: {
            maximumAvailable: 1000,
            currentlyAvailable: available,
            restoreRate: 50,
          },
        },
      },
    });
    let answerFirst!: () => void;
    const firstAnswered = new Promise<void>((resolve) => (answerFirst = resolve));
    let sent = 0;
    const fetchFn = (async () => {
      sent++;
      if (sent === 2) await firstAnswered; // the first of the two concurrent requests hangs
      return new Response(JSON.stringify(bucket(sent === 1 ? 350 : 49)), { status: 200 });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const inFlight: { first?: Promise<unknown> } = {};
    const c = new ShopifyGraphqlClient({
      shopDomain: 'brand.myshopify.com',
      apiVersion: '2026-10',
      tokens: new StaticTokenProvider('shpat_test'),
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
        answerFirst();
        await inFlight.first;
      },
    });
    await c.request('query { ok }'); // learn the bucket: 350 points available
    expect(sleeps).toEqual([]);

    const first = (inFlight.first = c.request('query { ok }', {}, 301));
    const second = c.request('query { ok }', {}, 301);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    // The second request waited for points: 350 - 301 reserved = 49, short by 252 at 50/s.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(4_500);
    expect(sent).toBe(3);
  });

  it('does not hold reserved points across a failed attempt', async () => {
    const { c, requests } = client([
      new Error('ECONNRESET'),
      { status: 503 },
      { body: { data: { ok: 1 } } },
      { body: { data: { ok: 2 } } },
    ]);
    await expect(c.request('query { ok }', {}, 900)).resolves.toEqual({ ok: 1 });
    await expect(c.request('query { ok }', {}, 900)).resolves.toEqual({ ok: 2 });
    expect(requests).toHaveLength(4);
  });
});

describe('GraphqlShopifyAdmin mutations', () => {
  it('activates with a fresh idempotency key each call', async () => {
    const ok = { body: { data: { inventoryActivate: { userErrors: [] } } } };
    const { c, requests } = client([ok, ok]);
    const admin = new GraphqlShopifyAdmin(c);
    await admin.activateInventory('gid://shopify/InventoryItem/1', 'gid://shopify/Location/1');
    await admin.activateInventory('gid://shopify/InventoryItem/1', 'gid://shopify/Location/1');
    const keys = requests.map(
      (r) =>
        (JSON.parse(r.init.body as string) as { variables: { idempotencyKey: string } }).variables
          .idempotencyKey,
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('treats a webhook that already exists (a retried create) as created', async () => {
    const taken = {
      body: {
        data: {
          webhookSubscriptionCreate: {
            userErrors: [
              {
                field: ['webhookSubscription'],
                message: 'Address for this topic has already been taken',
              },
            ],
          },
        },
      },
    };
    const invalid = {
      body: {
        data: {
          webhookSubscriptionCreate: {
            userErrors: [{ field: ['uri'], message: 'Address is invalid' }],
          },
        },
      },
    };
    const { c } = client([taken, invalid]);
    const admin = new GraphqlShopifyAdmin(c);
    await expect(
      admin.createWebhookSubscription(
        'INVENTORY_LEVELS_UPDATE',
        'https://sync.example.com/webhooks',
      ),
    ).resolves.toBeUndefined();
    await expect(
      admin.createWebhookSubscription('INVENTORY_LEVELS_UPDATE', 'not a url'),
    ).rejects.toThrow(/Address is invalid/);
  });
});

describe('interpretSetResult', () => {
  it('maps Shopify user errors to outcomes', () => {
    expect(interpretSetResult([])).toEqual({ status: 'applied' });
    expect(interpretSetResult([{ code: 'CHANGE_FROM_QUANTITY_STALE', message: 'x' }])).toEqual({
      status: 'stale',
    });
    expect(interpretSetResult([{ code: 'IDEMPOTENCY_CONCURRENT_REQUEST', message: 'x' }])).toEqual({
      status: 'in_progress',
    });
    expect(
      interpretSetResult([{ code: 'IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED', message: 'x' }]),
    ).toEqual({
      status: 'not_applied',
    });
    expect(
      interpretSetResult([{ code: 'INVALID_QUANTITY_NEGATIVE', message: 'no' }]),
    ).toMatchObject({
      status: 'rejected',
    });
  });
});

/** The variables of the n-th GraphQL request. */
function variablesOf(requests: { init: RequestInit }[], n: number): any {
  return (JSON.parse(requests[n]!.init.body as string) as { variables: unknown }).variables;
}
const page = (hasNextPage: boolean, endCursor: string | null = null) => ({
  hasNextPage,
  endCursor,
});
const ok = (data: unknown) => ({ body: { data } });

describe('GraphqlShopifyAdmin: shop and catalog reads', () => {
  it('reads the shop’s currency, time zone and weight unit with its scopes', async () => {
    const { c } = client([
      ok({
        shop: {
          name: 'Brand',
          myshopifyDomain: 'brand.myshopify.com',
          currencyCode: 'COP',
          ianaTimezone: 'America/Bogota',
          weightUnit: 'KILOGRAMS',
        },
        currentAppInstallation: {
          accessScopes: [{ handle: 'read_products' }, { handle: 'read_orders' }],
        },
      }),
    ]);
    expect(await new GraphqlShopifyAdmin(c).getShop()).toEqual({
      name: 'Brand',
      myshopifyDomain: 'brand.myshopify.com',
      scopes: ['read_products', 'read_orders'],
      currencyCode: 'COP',
      ianaTimezone: 'America/Bogota',
      weightUnit: 'KILOGRAMS',
    });
  });

  it('reads variant prices as numbers', async () => {
    const node = (id: number, price: string, compareAtPrice: string | null) => ({
      id: `gid://shopify/ProductVariant/${id}`,
      sku: `SKU-${id}`,
      barcode: null,
      title: 'Default Title',
      requiresComponents: false,
      price,
      compareAtPrice,
      inventoryItem: { id: `gid://shopify/InventoryItem/${id}`, tracked: true },
      product: { id: 'gid://shopify/Product/1', title: 'Tee' },
    });
    const { c } = client([
      ok({
        productVariants: {
          nodes: [node(1, '41900.00', '49900.00'), node(2, '12.9', null)],
          pageInfo: page(false),
        },
      }),
    ]);
    const variants = await new GraphqlShopifyAdmin(c).listVariants();
    expect(variants.map((v) => [v.price, v.compareAtPrice])).toEqual([
      [41900, 49900],
      [12.9, null],
    ]);
  });

  it('reads some variants’ prices by id, 250 at a time, skipping deleted ones', async () => {
    const ids = Array.from({ length: 251 }, (_, i) => `gid://shopify/ProductVariant/${i + 1}`);
    const { c, requests } = client([
      ok({
        nodes: [
          { id: ids[0], price: '41900.00', compareAtPrice: '49900.00' },
          null,
          ...ids.slice(2, 250).map((id) => ({ id, price: '1.00', compareAtPrice: null })),
        ],
      }),
      ok({ nodes: [{ id: ids[250], price: '12.9', compareAtPrice: null }] }),
    ]);
    const prices = await new GraphqlShopifyAdmin(c).readVariantPrices(ids);
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => JSON.parse(String(r.init.body)).variables.ids.length)).toEqual([
      250, 1,
    ]);
    expect(prices.size).toBe(250);
    expect(prices.get(ids[0]!)).toEqual({ price: 41900, compareAtPrice: 49900 });
    expect(prices.has(ids[1]!)).toBe(false);
    expect(prices.get(ids[250]!)).toEqual({ price: 12.9, compareAtPrice: null });
  });

  it('reads a whole product: every media and variant page, normalised', async () => {
    const variant = (n: number, position: number) => ({
      id: `gid://shopify/ProductVariant/${n}`,
      title: `S / Red ${n}`,
      position,
      sku: `TEE-${n}`,
      barcodes: { nodes: n === 1 ? [{ value: '4006381333931' }] : [] },
      price: '49.90',
      compareAtPrice: n === 1 ? '59.90' : null,
      taxable: true,
      inventoryPolicy: 'DENY',
      selectedOptions: [{ name: 'Size', value: 'S' }],
      media: { nodes: n === 1 ? [{ id: 'gid://shopify/MediaImage/10' }] : [] },
      inventoryItem: {
        id: `gid://shopify/InventoryItem/${n}`,
        tracked: true,
        requiresShipping: n === 1,
        measurement: { weight: n === 1 ? { unit: 'GRAMS', value: 250 } : null },
        unitCost: n === 1 ? { amount: '12.5' } : null,
      },
    });
    const { c, requests } = client([
      ok({
        product: {
          id: 'gid://shopify/Product/1',
          title: 'Tee',
          handle: 'tee',
          descriptionHtml: '<p>Soft</p>',
          vendor: 'Acme',
          productType: 'Shirts',
          tags: ['summer'],
          status: 'ACTIVE',
          seo: { title: null, description: 'A tee' },
          options: [
            { id: 'o2', name: 'Color', position: 2, optionValues: [{ id: 'v3', name: 'Red' }] },
            { id: 'o1', name: 'Size', position: 1, optionValues: [{ id: 'v1', name: 'S' }] },
          ],
          media: {
            nodes: [
              {
                id: 'gid://shopify/MediaImage/10',
                alt: 'Front',
                status: 'READY',
                mediaContentType: 'IMAGE',
                image: { url: 'https://cdn.shopify.com/a.jpg' },
              },
              {
                id: 'gid://shopify/Video/11',
                alt: null,
                status: 'READY',
                mediaContentType: 'VIDEO',
              },
            ],
            pageInfo: page(true, 'm1'),
          },
        },
      }),
      ok({
        product: {
          media: {
            nodes: [
              {
                id: 'gid://shopify/MediaImage/12',
                alt: null,
                status: 'PROCESSING',
                mediaContentType: 'IMAGE',
                image: null,
              },
            ],
            pageInfo: page(false),
          },
        },
      }),
      ok({ product: { variants: { nodes: [variant(2, 2)], pageInfo: page(true, 'v1') } } }),
      ok({ product: { variants: { nodes: [variant(1, 1)], pageInfo: page(false) } } }),
    ]);
    const product = await new GraphqlShopifyAdmin(c).getProduct('gid://shopify/Product/1');
    expect(variablesOf(requests, 1)).toEqual({ id: 'gid://shopify/Product/1', after: 'm1' });
    expect(variablesOf(requests, 3)).toEqual({ id: 'gid://shopify/Product/1', after: 'v1' });
    expect(product).toMatchObject({
      title: 'Tee',
      seo: { title: null, description: 'A tee' },
      options: [
        { id: 'o1', name: 'Size', position: 1, values: [{ id: 'v1', name: 'S' }] },
        { id: 'o2', name: 'Color', position: 2, values: [{ id: 'v3', name: 'Red' }] },
      ],
      media: [
        {
          id: 'gid://shopify/MediaImage/10',
          alt: 'Front',
          status: 'READY',
          url: 'https://cdn.shopify.com/a.jpg',
        },
        { id: 'gid://shopify/MediaImage/12', alt: '', status: 'PROCESSING', url: null },
      ],
    });
    expect(product!.variants).toEqual([
      {
        id: 'gid://shopify/ProductVariant/1',
        sku: 'TEE-1',
        title: 'S / Red 1',
        position: 1,
        barcode: '4006381333931',
        price: 49.9,
        compareAtPrice: 59.9,
        taxable: true,
        inventoryPolicy: 'DENY',
        selectedOptions: [{ name: 'Size', value: 'S' }],
        mediaId: 'gid://shopify/MediaImage/10',
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        tracked: true,
        requiresShipping: true,
        weight: { unit: 'GRAMS', value: 250 },
        unitCost: 12.5,
      },
      expect.objectContaining({
        position: 2,
        barcode: null,
        weight: null,
        unitCost: null,
        mediaId: null,
      }),
    ]);

    const missing = client([ok({ product: null })]);
    expect(
      await new GraphqlShopifyAdmin(missing.c).getProduct('gid://shopify/Product/9'),
    ).toBeNull();
  });
});

describe('GraphqlShopifyAdmin: product writes', () => {
  const setResult = (variantsPage = page(false)) => ({
    productSet: {
      product: {
        id: 'gid://shopify/Product/1',
        handle: 'tee',
        media: {
          nodes: [
            {
              id: 'gid://shopify/MediaImage/10',
              alt: null,
              status: 'UPLOADED',
              mediaContentType: 'IMAGE',
            },
            {
              id: 'gid://shopify/ExternalVideo/11',
              alt: null,
              status: 'READY',
              mediaContentType: 'EXTERNAL_VIDEO',
            },
          ],
          pageInfo: page(false),
        },
        variants: {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/1',
              sku: 'TEE-S',
              selectedOptions: [{ name: 'Size', value: 'S' }],
              inventoryItem: { id: 'gid://shopify/InventoryItem/1' },
            },
          ],
          pageInfo: variantsPage,
        },
      },
      productSetOperation: null,
      userErrors: [],
    },
  });

  it('creates by custom id: the identifier and the matching metafield are sent', async () => {
    const { c, requests } = client([ok(setResult())]);
    const result = await new GraphqlShopifyAdmin(c).productSet({
      identifier: { customId: '42' },
      input: {
        title: 'Tee',
        metafields: [
          { namespace: 'custom', key: 'care', type: 'single_line_text_field', value: 'Cold' },
        ],
      },
    });
    const vars = variablesOf(requests, 0);
    expect(vars.identifier).toEqual({
      customId: { namespace: '$app:store_sync', key: 'master_product_id', value: '42' },
    });
    expect(vars.synchronous).toBe(true);
    expect(vars.input.metafields).toEqual([
      { namespace: 'custom', key: 'care', type: 'single_line_text_field', value: 'Cold' },
      { namespace: '$app:store_sync', key: 'master_product_id', type: 'id', value: '42' },
    ]);
    expect(result).toEqual({
      productId: 'gid://shopify/Product/1',
      handle: 'tee',
      media: [{ id: 'gid://shopify/MediaImage/10', alt: '', status: 'UPLOADED' }],
      variants: [
        {
          id: 'gid://shopify/ProductVariant/1',
          sku: 'TEE-S',
          inventoryItemId: 'gid://shopify/InventoryItem/1',
          selectedOptions: [{ name: 'Size', value: 'S' }],
        },
      ],
    });
  });

  it('updates by id, and reads the variants beyond the first 100', async () => {
    const more = {
      product: {
        variants: {
          nodes: [
            {
              id: 'gid://shopify/ProductVariant/101',
              sku: null,
              selectedOptions: [{ name: 'Size', value: 'XL' }],
              inventoryItem: { id: 'gid://shopify/InventoryItem/101' },
            },
          ],
          pageInfo: page(false),
        },
      },
    };
    const { c, requests } = client([ok(setResult(page(true, 'c100'))), ok(more)]);
    const result = await new GraphqlShopifyAdmin(c).productSet({
      identifier: { id: 'gid://shopify/Product/1' },
      input: { title: 'Tee' },
    });
    expect(variablesOf(requests, 0).identifier).toEqual({ id: 'gid://shopify/Product/1' });
    expect(variablesOf(requests, 0).input.metafields).toBeUndefined();
    expect(variablesOf(requests, 1)).toEqual({ id: 'gid://shopify/Product/1', after: 'c100' });
    expect(result.variants.map((v) => v.id)).toEqual([
      'gid://shopify/ProductVariant/1',
      'gid://shopify/ProductVariant/101',
    ]);

    const create = client([ok(setResult())]);
    await new GraphqlShopifyAdmin(create.c).productSet({
      identifier: null,
      input: { title: 'New' },
    });
    expect(variablesOf(create.requests, 0).identifier).toBeNull();
  });

  it('sends a product write once, and refuses one over Shopify’s query cost limit', async () => {
    const timedOut = client([new Error('The operation was aborted due to timeout')]);
    await expect(
      new GraphqlShopifyAdmin(timedOut.c).productSet({
        identifier: { customId: '12' },
        input: { title: 'Tee' },
      }),
    ).rejects.toMatchObject({ kind: 'transient' });
    // The client didn't send the create again: the publish task looks for the product first.
    expect(timedOut.requests).toHaveLength(1);

    const huge = client([]);
    const files = Array.from({ length: 450 }, (_, i) => ({
      originalSource: `https://cdn.shopify.com/${i}.jpg`,
      alt: '',
      contentType: 'IMAGE' as const,
    }));
    await expect(
      new GraphqlShopifyAdmin(huge.c).productSet({
        identifier: null,
        input: { title: 'Tee', files },
      }),
    ).rejects.toMatchObject({
      kind: 'invalid',
      message: expect.stringContaining('too many images'),
    });
    expect(huge.requests).toHaveLength(0);
  });

  it('turns userErrors into ShopifyUserErrors listing them', async () => {
    const refused = ok({
      productSet: {
        product: null,
        productSetOperation: null,
        userErrors: [
          {
            code: 'HANDLE_NOT_UNIQUE',
            field: ['input', 'handle'],
            message: 'Handle already in use.',
          },
          {
            code: 'INVALID_VARIANT',
            field: ['input', 'variants', '0'],
            message: 'Variant is invalid',
          },
        ],
      },
    });
    const { c } = client([refused]);
    const err = await new GraphqlShopifyAdmin(c)
      .productSet({ identifier: null, input: { title: 'Tee' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyUserErrors);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect((err as ShopifyUserErrors).kind).toBe('invalid');
    expect((err as ShopifyUserErrors).message).toBe(
      'Shopify didn’t accept the product: Handle already in use; Variant is invalid',
    );
    expect((err as ShopifyUserErrors).errors).toEqual([
      { code: 'HANDLE_NOT_UNIQUE', field: ['input', 'handle'], message: 'Handle already in use.' },
      { code: 'INVALID_VARIANT', field: ['input', 'variants', '0'], message: 'Variant is invalid' },
    ]);
  });

  it('accepts a product id definition that already exists', async () => {
    const taken = ok({
      metafieldDefinitionCreate: {
        userErrors: [
          {
            code: 'TAKEN',
            field: ['definition', 'key'],
            message: "Key is in use for Product metafields on the '$app:store_sync' namespace.",
          },
        ],
      },
    });
    const other = ok({
      metafieldDefinitionCreate: {
        userErrors: [
          { code: 'RESOURCE_TYPE_LIMIT_EXCEEDED', field: null, message: 'Too many definitions' },
        ],
      },
    });
    const { c, requests } = client([taken, other]);
    const admin = new GraphqlShopifyAdmin(c);
    await expect(admin.ensureProductIdDefinition()).resolves.toBeUndefined();
    expect(variablesOf(requests, 0).definition).toMatchObject({
      namespace: '$app:store_sync',
      key: 'master_product_id',
      type: 'id',
      ownerType: 'PRODUCT',
    });
    await expect(admin.ensureProductIdDefinition()).rejects.toThrow(/Too many definitions/);
  });

  it('stages an image: a POST upload with every parameter first and the file last, without the token', async () => {
    const target = {
      url: 'https://shopify-staged-uploads.storage.googleapis.com/',
      resourceUrl: 'https://shopify-staged-uploads.storage.googleapis.com/tmp/1/front.png',
      parameters: [
        { name: 'Content-Type', value: 'image/png' },
        { name: 'key', value: 'tmp/1/front.png' },
        { name: 'policy', value: 'abc' },
      ],
    };
    const { c, requests } = client([
      ok({ stagedUploadsCreate: { stagedTargets: [target], userErrors: [] } }),
      { status: 201, body: {} },
    ]);
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    const url = await new GraphqlShopifyAdmin(c).stageImage({
      filename: 'front.png',
      mimeType: 'image/png',
      data,
    });
    expect(url).toBe(target.resourceUrl);
    expect(variablesOf(requests, 0).input).toEqual([
      {
        filename: 'front.png',
        mimeType: 'image/png',
        resource: 'IMAGE',
        httpMethod: 'POST',
        fileSize: '5',
      },
    ]);
    const upload = requests[1]!;
    expect(upload.url).toBe(target.url);
    expect(upload.init.method).toBe('POST');
    expect(upload.init.headers).toBeUndefined();
    const form = upload.init.body as FormData;
    expect([...form.keys()]).toEqual(['Content-Type', 'key', 'policy', 'file']);
    const file = form.get('file') as File;
    expect(file.name).toBe('front.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(data);
  });

  it('reports a refused upload as transient, and refused staging as user errors', async () => {
    const target = {
      url: 'https://upload.example/',
      resourceUrl: 'https://upload.example/x',
      parameters: [],
    };
    const failing = client([
      ok({ stagedUploadsCreate: { stagedTargets: [target], userErrors: [] } }),
      { status: 403, body: { error: 'SignatureDoesNotMatch' } },
    ]);
    const file = { filename: 'a.jpg', mimeType: 'image/jpeg', data: Buffer.from('x') };
    await expect(new GraphqlShopifyAdmin(failing.c).stageImage(file)).rejects.toMatchObject({
      kind: 'transient',
      status: 403,
      message: expect.stringContaining('SignatureDoesNotMatch'),
    });
    const refused = client([
      ok({
        stagedUploadsCreate: {
          stagedTargets: [],
          userErrors: [
            { field: ['input', '0', 'mimeType'], message: 'Mime type is not supported' },
          ],
        },
      }),
    ]);
    await expect(new GraphqlShopifyAdmin(refused.c).stageImage(file)).rejects.toBeInstanceOf(
      ShopifyUserErrors,
    );
  });

  it('finds the Online Store publication by its app, across pages', async () => {
    const pub = (id: number, title: string, handle: string | null) => ({
      id: `gid://shopify/Publication/${id}`,
      catalog: {
        title,
        apps: { nodes: handle ? [{ id: `gid://shopify/App/${id}`, handle }] : [] },
      },
    });
    const { c, requests } = client([
      ok({ publications: { nodes: [pub(1, 'Point of Sale', 'pos')], pageInfo: page(true, 'p1') } }),
      ok({
        publications: { nodes: [pub(2, 'Tienda online', 'online_store')], pageInfo: page(false) },
      }),
    ]);
    expect(await new GraphqlShopifyAdmin(c).findOnlineStorePublication()).toBe(
      'gid://shopify/Publication/2',
    );
    expect(variablesOf(requests, 1)).toEqual({ after: 'p1' });
    const none = client([
      ok({ publications: { nodes: [pub(1, 'Point of Sale', 'pos')], pageInfo: page(false) } }),
    ]);
    expect(await new GraphqlShopifyAdmin(none.c).findOnlineStorePublication()).toBeNull();
  });

  it('publishes and unpublishes to a publication', async () => {
    const { c, requests } = client([
      ok({ publishablePublish: { userErrors: [] } }),
      ok({
        publishableUnpublish: {
          userErrors: [{ field: ['id'], message: 'Product does not exist' }],
        },
      }),
    ]);
    const admin = new GraphqlShopifyAdmin(c);
    await admin.publishProduct('gid://shopify/Product/1', 'gid://shopify/Publication/2');
    expect(variablesOf(requests, 0)).toEqual({
      id: 'gid://shopify/Product/1',
      input: [{ publicationId: 'gid://shopify/Publication/2' }],
    });
    await expect(
      admin.unpublishProduct('gid://shopify/Product/1', 'gid://shopify/Publication/2'),
    ).rejects.toThrow('Shopify didn’t unpublish the product: Product does not exist');
  });
});

describe('GraphqlShopifyAdmin: prices and costs', () => {
  it('updates prices in chunks of 250 and reports the variants Shopify refused', async () => {
    const variants = Array.from({ length: 300 }, (_, i) => ({
      id: `gid://shopify/ProductVariant/${i}`,
      price: '10.00',
      // Left out (kept), cleared, or set.
      compareAtPrice: i % 3 === 0 ? undefined : i % 3 === 1 ? null : '12.00',
    }));
    const { c, requests } = client([
      ok({ productVariantsBulkUpdate: { userErrors: [] } }),
      ok({
        productVariantsBulkUpdate: {
          userErrors: [
            {
              code: 'NEGATIVE_PRICE_VALUE',
              field: ['variants', '1', 'price'],
              message: 'Price can’t be negative',
            },
            { code: 'PRODUCT_SUSPENDED', field: ['productId'], message: 'Product is suspended' },
          ],
        },
      }),
    ]);
    const result = await new GraphqlShopifyAdmin(c).updateVariantPrices(
      'gid://shopify/Product/1',
      variants,
    );
    expect(requests).toHaveLength(2);
    const first = variablesOf(requests, 0);
    const second = variablesOf(requests, 1);
    expect(first.productId).toBe('gid://shopify/Product/1');
    expect(first.variants).toHaveLength(250);
    expect(second.variants).toHaveLength(50);
    expect(first.variants.slice(0, 3)).toEqual([
      { id: 'gid://shopify/ProductVariant/0', price: '10.00' },
      { id: 'gid://shopify/ProductVariant/1', price: '10.00', compareAtPrice: null },
      { id: 'gid://shopify/ProductVariant/2', price: '10.00', compareAtPrice: '12.00' },
    ]);
    expect(result.failed).toEqual([
      { variantId: 'gid://shopify/ProductVariant/251', message: 'Price can’t be negative' },
      { variantId: null, message: 'Product is suspended' },
    ]);
  });

  it('sets an inventory item’s cost', async () => {
    const { c, requests } = client([
      ok({ inventoryItemUpdate: { userErrors: [] } }),
      ok({
        inventoryItemUpdate: {
          userErrors: [{ field: ['input', 'cost'], message: 'Cost is invalid' }],
        },
      }),
    ]);
    const admin = new GraphqlShopifyAdmin(c);
    await admin.updateInventoryItemCost('gid://shopify/InventoryItem/1', '12.50');
    expect(variablesOf(requests, 0)).toEqual({
      id: 'gid://shopify/InventoryItem/1',
      input: { cost: '12.50' },
    });
    await expect(
      admin.updateInventoryItemCost('gid://shopify/InventoryItem/1', 'x'),
    ).rejects.toThrow('Shopify didn’t accept the cost: Cost is invalid');
  });
});

describe('GraphqlShopifyAdmin: orders', () => {
  const money = (amount: string) => ({ shopMoney: { amount } });
  const line = (n: number, extra: object = {}) => ({
    id: `gid://shopify/LineItem/${n}`,
    sku: `SKU-${n}`,
    quantity: 2,
    currentQuantity: 1,
    isGiftCard: false,
    variant: {
      id: `gid://shopify/ProductVariant/${n}`,
      inventoryItem: { id: `gid://shopify/InventoryItem/${n}` },
    },
    originalUnitPriceSet: money('49.90'),
    discountAllocations: [
      { allocatedAmountSet: money('0.1') },
      { allocatedAmountSet: money('0.2') },
    ],
    priceAfterAllDiscountsBeforeTaxesSet: money('44.90'),
    ...extra,
  });
  const order = (id: string, lines: object[], linesPage = page(false)) => ({
    id,
    name: '#1001',
    processedAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-02T08:00:00Z',
    cancelledAt: null,
    test: false,
    currencyCode: 'EUR',
    sourceName: 'web',
    taxesIncluded: true,
    lineItems: { nodes: lines, pageInfo: linesPage },
  });

  it('reads an order with every line, amounts as numbers', async () => {
    const { c, requests } = client([
      ok({ order: order('gid://shopify/Order/555', [line(1)], page(true, 'l1')) }),
      ok({ order: order('gid://shopify/Order/555', [line(2, { variant: null, sku: null })]) }),
    ]);
    const result = await new GraphqlShopifyAdmin(c).getOrder('gid://shopify/Order/555');
    expect(variablesOf(requests, 0)).toEqual({ id: 'gid://shopify/Order/555', linesAfter: null });
    expect(variablesOf(requests, 1)).toEqual({ id: 'gid://shopify/Order/555', linesAfter: 'l1' });
    expect(result).toEqual({
      id: 'gid://shopify/Order/555',
      name: '#1001',
      processedAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-02T08:00:00Z',
      cancelledAt: null,
      test: false,
      currencyCode: 'EUR',
      sourceName: 'web',
      taxesIncluded: true,
      lines: [
        {
          id: 'gid://shopify/LineItem/1',
          sku: 'SKU-1',
          quantity: 2,
          currentQuantity: 1,
          isGiftCard: false,
          variantId: 'gid://shopify/ProductVariant/1',
          inventoryItemId: 'gid://shopify/InventoryItem/1',
          unitPrice: 49.9,
          discounts: 0.3,
          net: 44.9,
        },
        expect.objectContaining({
          id: 'gid://shopify/LineItem/2',
          sku: null,
          variantId: null,
          inventoryItemId: null,
        }),
      ],
    });
    const gone = client([ok({ order: null })]);
    expect(await new GraphqlShopifyAdmin(gone.c).getOrder('gid://shopify/Order/1')).toBeNull();
  });

  it('lists orders updated since a time, completing orders with many lines', async () => {
    const { c, requests } = client([
      ok({
        orders: {
          nodes: [
            order('gid://shopify/Order/1', [line(1)]),
            order('gid://shopify/Order/2', [line(2)], page(true, 'l2')),
          ],
          pageInfo: page(true, 'o2'),
        },
      }),
      ok({ order: order('gid://shopify/Order/2', [line(3)]) }),
    ]);
    const result = await new GraphqlShopifyAdmin(c).listOrdersUpdatedSince(
      '2026-10-01T05:00:00.999+05:00',
      'o1',
    );
    // In UTC and whole seconds (rounded down: the filter is >=), as Shopify's search syntax takes it.
    expect(variablesOf(requests, 0)).toEqual({
      query: "updated_at:>='2026-10-01T00:00:00Z'",
      after: 'o1',
    });
    expect(variablesOf(requests, 1)).toEqual({ id: 'gid://shopify/Order/2', linesAfter: 'l2' });
    expect(result.nextCursor).toBe('o2');
    expect(result.orders.map((o) => [o.id, o.lines.map((l) => l.id)])).toEqual([
      ['gid://shopify/Order/1', ['gid://shopify/LineItem/1']],
      ['gid://shopify/Order/2', ['gid://shopify/LineItem/2', 'gid://shopify/LineItem/3']],
    ]);
    // Never pasted into a search query as given.
    await expect(
      new GraphqlShopifyAdmin(client([]).c).listOrdersUpdatedSince("' OR status:any", null),
    ).rejects.toThrow(/Not a timestamp/);
  });

  it('starts a bulk export of the orders updated since a time', async () => {
    const { c, requests } = client([
      ok({
        bulkOperationRunQuery: {
          bulkOperation: { id: 'gid://shopify/BulkOperation/7', status: 'CREATED' },
          userErrors: [],
        },
      }),
      ok({
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [
            {
              code: 'OPERATION_IN_PROGRESS',
              field: null,
              message: 'A bulk query operation for this app and shop is already in progress',
            },
          ],
        },
      }),
      ok({
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ code: 'INVALID', field: ['query'], message: 'Bad query' }],
        },
      }),
    ]);
    const admin = new GraphqlShopifyAdmin(c);
    expect(await admin.startOrdersBulkExport('2026-08-18T00:00:00Z')).toEqual({
      operationId: 'gid://shopify/BulkOperation/7',
    });
    const query: string = variablesOf(requests, 0).query;
    expect(query).toContain(
      'orders(query: "updated_at:>=\'2026-08-18T00:00:00Z\'", sortKey: UPDATED_AT)',
    );
    expect(query).not.toContain('__SINCE__');
    await expect(admin.startOrdersBulkExport('2026-08-18T00:00:00Z')).rejects.toBeInstanceOf(
      BulkOperationInProgressError,
    );
    await expect(admin.startOrdersBulkExport('2026-08-18T00:00:00Z')).rejects.toBeInstanceOf(
      ShopifyUserErrors,
    );
  });

  it('reads a bulk operation', async () => {
    const { c } = client([
      ok({
        bulkOperation: {
          id: 'gid://shopify/BulkOperation/7',
          status: 'COMPLETED',
          errorCode: null,
          createdAt: '2026-10-17T10:00:00Z',
          completedAt: '2026-10-17T10:02:00Z',
          objectCount: '1234',
          url: 'https://storage.googleapis.com/x.jsonl',
          partialDataUrl: null,
        },
      }),
      ok({ bulkOperation: null }),
    ]);
    const admin = new GraphqlShopifyAdmin(c);
    expect(await admin.getBulkOperation('gid://shopify/BulkOperation/7')).toEqual({
      id: 'gid://shopify/BulkOperation/7',
      status: 'COMPLETED',
      errorCode: null,
      url: 'https://storage.googleapis.com/x.jsonl',
      partialDataUrl: null,
      objectCount: 1234,
      createdAt: '2026-10-17T10:00:00Z',
      completedAt: '2026-10-17T10:02:00Z',
    });
    expect(await admin.getBulkOperation('gid://shopify/BulkOperation/8')).toBeNull();
  });
});

describe('parseOrdersBulkJsonl', () => {
  async function* linesOf(text: string) {
    yield* text.split('\n');
  }

  it('joins line items to their order, wherever they come in the file', async () => {
    const orderLine = (id: string, extra = '') =>
      `{"id":"gid://shopify/Order/${id}","name":"#${id}","processedAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-03T08:12:00Z","cancelledAt":null,"test":false,"currencyCode":"EUR","sourceName":"web","taxesIncluded":true${extra}}`;
    const item = (id: string, parent: string) =>
      `{"id":"gid://shopify/LineItem/${id}","sku":"TEE-BLK-M","quantity":2,"currentQuantity":1,"isGiftCard":false,"variant":{"id":"gid://shopify/ProductVariant/444","inventoryItem":{"id":"gid://shopify/InventoryItem/333"}},"originalUnitPriceSet":{"shopMoney":{"amount":"49.9"}},"discountAllocations":[{"allocatedAmountSet":{"shopMoney":{"amount":"10.0"}}}],"priceAfterAllDiscountsBeforeTaxesSet":{"shopMoney":{"amount":"44.9"}},"__parentId":"gid://shopify/Order/${parent}"}`;
    const text = [
      item('999', '555'), // before its order
      orderLine('555'),
      '',
      orderLine('556'),
      item('1000', '556'),
      item('1001', '555'),
      '{"id":"gid://shopify/Refund/77","__parentId":"gid://shopify/Order/555"}', // not ours
      item('1002', '404'), // its order isn't in the file
      '',
    ].join('\n');
    const orders = await parseOrdersBulkJsonl(linesOf(text));
    expect(orders.map((o) => [o.id, o.lines.map((l) => l.id)])).toEqual([
      ['gid://shopify/Order/555', ['gid://shopify/LineItem/999', 'gid://shopify/LineItem/1001']],
      ['gid://shopify/Order/556', ['gid://shopify/LineItem/1000']],
    ]);
    expect(orders[0]).toMatchObject({ name: '#555', currencyCode: 'EUR', taxesIncluded: true });
    expect(orders[0]!.lines[0]).toEqual({
      id: 'gid://shopify/LineItem/999',
      sku: 'TEE-BLK-M',
      quantity: 2,
      currentQuantity: 1,
      isGiftCard: false,
      variantId: 'gid://shopify/ProductVariant/444',
      inventoryItemId: 'gid://shopify/InventoryItem/333',
      unitPrice: 49.9,
      discounts: 10,
      net: 44.9,
    });
  });

  it('refuses a broken line', async () => {
    await expect(
      parseOrdersBulkJsonl(linesOf('{"id":"gid://shopify/Order/1"}\n{"id":')),
    ).rejects.toThrow(/Line 2/);
  });
});
