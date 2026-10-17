import { describe, expect, it } from 'vitest';
import {
  ClientCredentialsTokenProvider,
  ShopifyApiError,
  ShopifyGraphqlClient,
  StaticTokenProvider,
  type TokenProvider,
} from '../src/shopify/client.js';
import { GraphqlShopifyAdmin, interpretSetResult } from '../src/shopify/graphql-admin.js';

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
