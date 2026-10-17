import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/pool.js';
import { buildServer } from '../src/http/server.js';
import type { StoreCredentials } from '../src/shopify/registry.js';
import type { ShopifyAdmin } from '../src/shopify/types.js';
import { SyncEngine } from '../src/sync/engine.js';
import { drainQueue } from '../src/sync/worker.js';
import { runTasksOnce } from '../src/tasks/runner.js';
import { SecretBox } from '../src/util/crypto.js';
import { FakeShop } from './fakes/fake-shopify.js';
import { TEST_DATABASE_URL, resetDatabase, silentLogger } from './helpers/harness.js';

const PUBLIC_URL = 'https://sync.example.com';
const AUTH = `Basic ${Buffer.from('admin:correct-horse-battery').toString('base64')}`;
const KEY = Buffer.alloc(32, 7).toString('base64');

/** Fake shops by domain; credentials must be "good-token" / "good-secret" to connect. */
class FakeShopify {
  readonly shops = new Map<string, FakeShop>();
  constructor(private readonly db: Db) {}

  createAdmin = (creds: StoreCredentials): ShopifyAdmin => {
    const shop = this.shops.get(creds.shopDomain);
    const valid = creds.accessToken === 'good-token' || creds.clientSecret === 'good-secret';
    if (!shop || !valid) {
      return new Proxy({} as ShopifyAdmin, {
        get: () => async () => {
          const { ShopifyApiError } = await import('../src/shopify/client.js');
          throw new ShopifyApiError('Shopify rejected the credentials (HTTP 401).', 'auth', 401);
        },
      });
    }
    return shop;
  };

  async forStore(storeId: number): Promise<ShopifyAdmin> {
    const { rows } = await this.db.query<{ shop_domain: string }>(
      'SELECT shop_domain FROM stores WHERE id = $1',
      [storeId],
    );
    const shop = rows[0] && this.shops.get(rows[0].shop_domain);
    if (!shop) throw new Error(`no fake shop for store ${storeId}`);
    return shop;
  }

  invalidate(): void {}
}

let db: Db;
let app: FastifyInstance;
let shopify: FakeShopify;
let engine: SyncEngine;
const secrets = new SecretBox(KEY);

beforeEach(async () => {
  db = createDb(TEST_DATABASE_URL, 5);
  await resetDatabase(db);
  shopify = new FakeShopify(db);
  engine = new SyncEngine({ db, shopify, logger: silentLogger });
  app = await buildServer({
    db,
    secrets,
    shopify,
    createAdmin: shopify.createAdmin,
    logger: silentLogger,
    publicUrl: PUBLIC_URL,
    adminUsername: 'admin',
    adminPassword: 'correct-horse-battery',
  });
});

afterEach(async () => {
  await app.close();
  await db.end();
});

const api = async (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) => {
  const res = await app.inject({
    method,
    url,
    payload: payload as object,
    headers: { authorization: AUTH, 'x-requested-with': 'store-sync' },
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined };
};

/** Runs background tasks and reconciles until both queues are empty. */
async function settle() {
  const deps = { db, shopify, logger: silentLogger, publicUrl: PUBLIC_URL };
  for (let i = 0; i < 20; i++) {
    const t = await runTasksOnce(db, deps, silentLogger, 10);
    const r = await drainQueue(db, engine, silentLogger, { concurrency: 4 });
    if (t === 0 && r === 0) return;
  }
  throw new Error('did not settle');
}

function addShop(domain: string, skus: Record<string, number>) {
  const shop = new FakeShop(domain, domain.split('.')[0]);
  const location = shop.addLocation('Warehouse');
  for (const [sku, qty] of Object.entries(skus)) {
    const v = shop.addVariant(sku);
    shop.stock(v.inventoryItemId, location, qty);
  }
  shopify.shops.set(domain, shop);
  return { shop, location };
}

async function connect(name: string, domain: string) {
  const res = await api('POST', '/api/stores', {
    name,
    shopDomain: domain,
    authMode: 'access_token',
    accessToken: 'good-token',
    webhookSecret: `secret-${name}`,
  });
  expect(res.status).toBe(201);
  return res.body as { id: number };
}

describe('HTTP API', () => {
  it('does not let a client pick its own IP to dodge the login lockout', async () => {
    const wrong = `Basic ${Buffer.from('admin:nope').toString('base64')}`;
    for (let i = 0; i < 25; i++) {
      await app.inject({
        method: 'GET',
        url: '/api/status',
        headers: { authorization: wrong, 'x-forwarded-for': `203.0.113.${i}` },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: wrong, 'x-forwarded-for': '198.51.100.7' },
    });
    expect(res.statusCode).toBe(429);
  });

  it('requires the admin login except for health checks', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const anonymous = await app.inject({ method: 'GET', url: '/api/status' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['www-authenticate']).toContain('Basic');
    const wrong = `Basic ${Buffer.from('admin:nope').toString('base64')}`;
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: wrong } }))
        .statusCode,
    ).toBe(401);
    for (let i = 0; i < 20; i++) {
      await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: wrong } });
    }
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: wrong } }))
        .statusCode,
    ).toBe(429);
    const ok = await app.inject({ method: 'GET', url: '/healthz' });
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses to add a store whose credentials do not work', async () => {
    addShop('brand-a.myshopify.com', {});
    const res = await api('POST', '/api/stores', {
      name: 'Brand A',
      shopDomain: 'brand-a',
      authMode: 'access_token',
      accessToken: 'wrong',
      webhookSecret: 'secret',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Could not connect');
    expect((await api('GET', '/api/stores')).body).toEqual([]);
  });

  it('reports missing permissions when connecting', async () => {
    const { shop } = addShop('brand-a.myshopify.com', {});
    shop.scopes = ['read_products'];
    const res = await api('POST', '/api/stores', {
      name: 'Brand A',
      shopDomain: 'https://Brand-A.myshopify.com/admin',
      authMode: 'access_token',
      accessToken: 'good-token',
      webhookSecret: 'secret',
    });
    expect(res.status).toBe(400);
    expect(res.body.missingScopes).toEqual(
      expect.arrayContaining(['write_inventory', 'read_locations']),
    );
  });

  it('runs the whole flow: connect, match, onboard, sync, adjust, webhooks', async () => {
    const a = addShop('brand-a.myshopify.com', { 'TEE-M': 10, 'MUG-1': 4 });
    const b = addShop('brand-b.myshopify.com', { 'tee-m ': 6, 'MUG-1': 9 });
    const storeA = await connect('Brand A', 'brand-a.myshopify.com');
    const storeB = await connect('Brand B', 'brand-b');
    await settle();

    // Catalog matched by SKU (case/space-insensitive), locations auto-mapped, webhooks registered.
    const stores = (await api('GET', '/api/stores')).body;
    expect(stores.map((s: any) => s.linkedCount)).toEqual([2, 2]);
    expect(stores.every((s: any) => s.locations[0].warehouseId !== null)).toBe(true);
    expect(a.shop.subscriptions.some((s) => s.topic === 'INVENTORY_LEVELS_UPDATE')).toBe(true);
    expect(a.shop.subscriptions[0]!.uri).toBe(`${PUBLIC_URL}/webhooks/shopify`);

    let items = (await api('GET', '/api/items?filter=uninitialized')).body;
    expect(items.total).toBe(2);

    // Dry run first: copying Brand A's numbers changes Brand B only.
    const preview = (
      await api('GET', `/api/onboarding/preview?strategy=store&sourceStoreId=${storeA.id}`)
    ).body;
    expect(preview.rows).toHaveLength(2);
    const tee = preview.rows.find((r: any) => r.sku === 'TEE-M');
    expect(tee.proposed).toBe(10);
    expect(tee.changes).toEqual([{ storeId: storeB.id, from: 6, to: 10 }]);
    expect(b.shop.level(b.shop.variants[0]!.inventoryItemId, b.location)).toBe(6); // untouched by preview

    expect(
      (await api('POST', '/api/onboarding/apply', { strategy: 'store', sourceStoreId: storeA.id }))
        .status,
    ).toBe(200);
    await settle();
    expect(b.shop.level(b.shop.variants[0]!.inventoryItemId, b.location)).toBe(10);
    expect(b.shop.level(b.shop.variants[1]!.inventoryItemId, b.location)).toBe(4);
    expect((await api('GET', '/api/status')).body.onboardingCompleted).toBe(true);

    items = (await api('GET', '/api/items?search=tee')).body;
    expect(items.total).toBe(1);
    const teeItem = items.items[0];
    expect(teeItem.levels[0].quantity).toBe(10);
    expect(teeItem.levels[0].stores.map((s: any) => s.shows)).toEqual([10, 10]);

    // "We received 5 more" from the dashboard.
    expect(
      (
        await api('POST', `/api/items/${teeItem.id}/adjust`, {
          kind: 'adjust',
          value: 5,
          note: 'Delivery #12',
        })
      ).status,
    ).toBe(202);
    await settle();
    expect(a.shop.level(a.shop.variants[0]!.inventoryItemId, a.location)).toBe(15);
    expect(b.shop.level(b.shop.variants[0]!.inventoryItemId, b.location)).toBe(15);

    // A sale in Brand B arrives as a signed webhook.
    const itemB = b.shop.variants[0]!.inventoryItemId;
    b.shop.externalAdjust(itemB, b.location, -2);
    const numericItem = itemB.split('/').pop();
    const numericLoc = b.location.split('/').pop();
    const body = `{"inventory_item_id":"${numericItem}","location_id":"${numericLoc}","available":13,"updated_at":"2026-10-17T10:00:00Z","admin_graphql_api_id":"gid://shopify/InventoryLevel/${numericLoc}?inventory_item_id=${numericItem}"}`;
    const hmac = createHmac('sha256', 'secret-Brand B').update(body).digest('base64');
    const hook = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': 'brand-b.myshopify.com',
        'x-shopify-topic': 'inventory_levels/update',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-webhook-id': 'wh-1',
      },
    });
    expect(hook.statusCode).toBe(200);
    await settle();
    expect(a.shop.level(a.shop.variants[0]!.inventoryItemId, a.location)).toBe(13);

    // The activity log tells the story.
    const detail = (await api('GET', `/api/items/${teeItem.id}`)).body;
    const kinds = detail.events.map((e: any) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['initialized', 'manual_adjust', 'external_change', 'propagated']),
    );
    const events = (await api('GET', `/api/events?storeId=${storeB.id}&kind=external_change`)).body
      .events;
    expect(events[0]).toMatchObject({ storeName: 'Brand B', delta: -2, sku: 'TEE-M' });
  });

  it('refuses changes that could come from another website (CSRF)', async () => {
    const forged = await app.inject({
      method: 'POST',
      url: '/api/settings/pause',
      payload: 'reason=pwned',
      headers: { authorization: AUTH, 'content-type': 'text/plain' },
    });
    expect(forged.statusCode).toBe(403);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/settings/pause',
      headers: {
        authorization: AUTH,
        'x-requested-with': 'store-sync',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(crossSite.statusCode).toBe(403);
    expect((await api('GET', '/api/settings')).body.syncPaused).toBe(false);
  });

  it('rejects unsigned webhooks', async () => {
    addShop('brand-a.myshopify.com', {});
    await connect('Brand A', 'brand-a.myshopify.com');
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'x-shopify-shop-domain': 'brand-a.myshopify.com',
        'x-shopify-topic': 'inventory_levels/update',
        'x-shopify-hmac-sha256': 'bogus',
        'x-shopify-webhook-id': 'x',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('applies safety buffers and location mapping changes', async () => {
    const a = addShop('brand-a.myshopify.com', { SKU: 10 });
    const b = addShop('brand-b.myshopify.com', { SKU: 10 });
    await connect('Brand A', 'brand-a.myshopify.com');
    const storeB = await connect('Brand B', 'brand-b.myshopify.com');
    await settle();
    await api('POST', '/api/onboarding/apply', { strategy: 'min' });
    await settle();
    const patched = await api('PATCH', `/api/stores/${storeB.id}`, { safetyBuffer: 3 });
    expect(patched.body.safetyBuffer).toBe(3);
    await settle();
    expect(b.shop.level(b.shop.variants[0]!.inventoryItemId, b.location)).toBe(7);
    expect(a.shop.level(a.shop.variants[0]!.inventoryItemId, a.location)).toBe(10);

    // A second location in Brand B can't hold the same warehouse.
    const second = b.shop.addLocation('Second');
    await settle();
    await api('POST', `/api/stores/${storeB.id}/sync-catalog`);
    await settle();
    const store = (await api('GET', `/api/stores/${storeB.id}`)).body;
    const other = store.locations.find((l: any) => l.shopifyLocationId === second);
    const res = await api('PUT', `/api/stores/${storeB.id}/locations/${other.id}`, {
      warehouseId: 1,
    });
    expect(res.status).toBe(409);
  });

  it('pauses and resumes sync, and manages settings and alerts', async () => {
    expect(
      (await api('POST', '/api/settings/pause', { reason: 'Stock count' })).body.syncPaused,
    ).toBe(true);
    expect((await api('GET', '/api/status')).body.pausedReason).toBe('Stock count');
    expect((await api('POST', '/api/settings/resume')).body.syncPaused).toBe(false);
    const settings = await api('PATCH', '/api/settings', {
      lowStockThreshold: 3,
      massZeroLimit: 0,
    });
    expect(settings.body).toMatchObject({ lowStockThreshold: 3, massZeroLimit: 0 });
    expect((await api('PATCH', '/api/settings', { syncPaused: true })).status).toBe(400);
    expect((await api('PATCH', '/api/settings', { alertWebhookUrl: 'not a url' })).status).toBe(
      400,
    );
    expect((await api('GET', '/api/alerts')).body).toEqual([]);
  });

  it('lists unmatched and conflicting variants and links them manually', async () => {
    addShop('brand-a.myshopify.com', { 'TEE-M': 5, 'ONLY-A': 1, DUP: 1 });
    const b = addShop('brand-b.myshopify.com', { 'TEE-M': 5, 'TYPO-A': 1 });
    const extra = b.shop.addVariant('DUP');
    b.shop.stock(extra.inventoryItemId, b.location, 1);
    const dup2 = b.shop.addVariant('DUP');
    b.shop.stock(dup2.inventoryItemId, b.location, 1);
    await connect('Brand A', 'brand-a.myshopify.com');
    await connect('Brand B', 'brand-b.myshopify.com');
    await settle();

    const unmatched = (await api('GET', '/api/variants?filter=unmatched')).body;
    expect(unmatched.variants.map((v: any) => v.sku).sort()).toEqual(['DUP', 'ONLY-A', 'TYPO-A']);
    const conflicts = (await api('GET', '/api/variants?filter=conflicts')).body;
    expect(conflicts.variants.map((v: any) => v.sku)).toEqual(['DUP', 'DUP']);

    // "TYPO-A" in Brand B is really the same product as "ONLY-A".
    const onlyA = (await api('GET', '/api/items?search=ONLY-A')).body.items[0];
    const typo = unmatched.variants.find((v: any) => v.sku === 'TYPO-A');
    expect((await api('PUT', `/api/variants/${typo.id}/link`, { itemId: onlyA.id })).status).toBe(
      200,
    );
    const linked = (await api('GET', `/api/items/${onlyA.id}`)).body;
    expect(linked.levels[0].stores.map((s: any) => s.storeName)).toEqual(['Brand A', 'Brand B']);
    expect(
      (await api('GET', '/api/variants?filter=unmatched')).body.variants.map((v: any) => v.sku),
    ).toEqual(['DUP']);
  });

  it('serves the dashboard behind the login', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
    const page = await app.inject({ method: 'GET', url: '/', headers: { authorization: AUTH } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('keeps accepting webhooks signed with the previous client secret after a rotation', async () => {
    const shop = addShop('brand-a.myshopify.com', { SKU: 1 });
    const created = await api('POST', '/api/stores', {
      name: 'Brand A',
      shopDomain: 'brand-a',
      authMode: 'client_credentials',
      clientId: 'id',
      clientSecret: 'good-secret',
    });
    expect(created.status).toBe(201);
    shop.shop.scopes = [...shop.shop.scopes];
    const rotate = await api('PATCH', `/api/stores/${created.body.id}`, {
      clientSecret: 'good-secret',
    });
    expect(rotate.status).toBe(200);
    const body = '{"admin_graphql_api_id":"gid://shopify/InventoryItem/1"}';
    const send = (secret: string, id: string) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/shopify',
        payload: body,
        headers: {
          'content-type': 'application/json',
          'x-shopify-shop-domain': 'brand-a.myshopify.com',
          'x-shopify-topic': 'inventory_items/update',
          'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body).digest('base64'),
          'x-shopify-webhook-id': id,
        },
      });
    expect((await send('good-secret', 'w1')).statusCode).toBe(200);
    // Shopify signs with the oldest unrevoked secret: after rotating to a new one, the old one
    // must still be accepted for a while.
    await db.query(
      `UPDATE stores SET previous_client_secret_enc = $1, client_secret_rotated_at = now()`,
      [secrets.encrypt('old-secret')],
    );
    expect((await send('old-secret', 'w2')).statusCode).toBe(200);
    await db.query(`UPDATE stores SET client_secret_rotated_at = now() - interval '8 days'`);
    expect((await send('old-secret', 'w3')).statusCode).toBe(401);
  });

  it('resuming a store re-reads its catalog before it syncs again', async () => {
    addShop('brand-a.myshopify.com', { SKU: 10 });
    const b = addShop('brand-b.myshopify.com', { SKU: 10 });
    await connect('Brand A', 'brand-a.myshopify.com');
    const storeB = await connect('Brand B', 'brand-b.myshopify.com');
    await settle();
    await api('POST', '/api/onboarding/apply', { strategy: 'min' });
    await settle();
    await api('PATCH', `/api/stores/${storeB.id}`, { status: 'paused' });
    // While paused, B's variant becomes a different product with 25 units.
    b.shop.variants[0]!.sku = 'HAT';
    b.shop.externalAdjust(b.shop.variants[0]!.inventoryItemId, b.location, +15);
    const resumed = await api('PATCH', `/api/stores/${storeB.id}`, { status: 'active' });
    expect(resumed.body.status).toBe('active');
    await settle();
    const items = (await api('GET', '/api/items')).body.items;
    expect(items.find((i: any) => i.sku === 'SKU').levels[0].quantity).toBe(10);
    // B's variant is now its own product, started from B's own number.
    expect(items.find((i: any) => i.sku === 'HAT').levels[0].quantity).toBe(25);
  });

  it('keeps a store paused when its credentials are fixed while asking to pause it', async () => {
    addShop('brand-a.myshopify.com', { SKU: 1 });
    const store = await connect('Brand A', 'brand-a.myshopify.com');
    await db.query(`UPDATE stores SET status = 'error' WHERE id = $1`, [store.id]);
    const res = await api('PATCH', `/api/stores/${store.id}`, {
      accessToken: 'good-token',
      status: 'paused',
    });
    expect(res.body.status).toBe('paused');
  });

  it('refuses a stock count while syncing is paused, so it can’t be applied later with old numbers', async () => {
    addShop('brand-a.myshopify.com', { SKU: 10 });
    await connect('Brand A', 'brand-a.myshopify.com');
    await settle();
    await api('POST', '/api/onboarding/apply', { strategy: 'min' });
    await settle();
    const item = (await api('GET', '/api/items')).body.items[0];
    await api('PATCH', `/api/items/${item.id}`, { syncEnabled: false });
    expect(
      (await api('POST', `/api/items/${item.id}/adjust`, { kind: 'count', value: 40 })).status,
    ).toBe(409);
    expect(
      (await api('POST', `/api/items/${item.id}/adjust`, { kind: 'adjust', value: 4 })).status,
    ).toBe(202);
    await api('PATCH', `/api/items/${item.id}`, { syncEnabled: true });
    await api('POST', '/api/settings/pause');
    expect(
      (await api('POST', `/api/items/${item.id}/adjust`, { kind: 'set', value: 40 })).status,
    ).toBe(409);
  });
});
