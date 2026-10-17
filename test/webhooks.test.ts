import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureItem } from '../src/catalog/catalog.js';
import { createDb, type Db } from '../src/db/pool.js';
import { SecretBox } from '../src/util/crypto.js';
import {
  UNINSTALLED_ERROR,
  handleShopifyWebhook,
  type WebhookDeps,
} from '../src/webhooks/intake.js';
import { ensureWebhooks } from '../src/webhooks/subscriptions.js';
import { WEBHOOK_TOPICS, webhookUrl } from '../src/webhooks/topics.js';
import { FakeShop } from './fakes/fake-shopify.js';
import { TEST_DATABASE_URL, resetDatabase } from './helpers/harness.js';

const WEBHOOK_SECRET = 'legacy-api-secret-key';
const CLIENT_SECRET = 'dev-dashboard-client-secret';
// Both ids exceed 2^53 and differ by one: parsed as JS numbers they become the same id.
const TEE_ITEM = '271878346596884015';
const DECOY_ITEM = '271878346596884014';
const LOCATION = '24826418';

let db: Db;
let secrets: SecretBox;
let deps: WebhookDeps;
let onWork: ReturnType<typeof vi.fn<() => void>>;
let logLines: string[];

beforeEach(async () => {
  db = createDb(TEST_DATABASE_URL, 10);
  await resetDatabase(db);
  secrets = new SecretBox(randomBytes(32).toString('base64'));
  logLines = [];
  onWork = vi.fn<() => void>();
  deps = {
    db,
    secrets,
    logger: pino({ level: 'debug' }, { write: (line: string) => logLines.push(line) }),
    onWork,
  };
});

afterEach(async () => {
  await db.end();
});

async function addStore(
  name: string,
  opts: { webhookSecret?: string; clientSecret?: string } = {},
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO stores (name, shop_domain, auth_mode, access_token_enc, client_id, client_secret_enc,
                         webhook_secret_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      name,
      `${name}.myshopify.com`,
      opts.clientSecret ? 'client_credentials' : 'access_token',
      opts.clientSecret ? null : secrets.encrypt('shpat_test'),
      opts.clientSecret ? 'client-id' : null,
      opts.clientSecret ? secrets.encrypt(opts.clientSecret) : null,
      opts.webhookSecret ? secrets.encrypt(opts.webhookSecret) : null,
    ],
  );
  return rows[0]!.id;
}

/** A store whose location 24826418 is mapped, selling TEE and DECOY (18-digit inventory items). */
async function addSyncedStore() {
  const storeId = await addStore('legacy', { webhookSecret: WEBHOOK_SECRET });
  await db.query(
    `INSERT INTO store_locations (store_id, shopify_location_id, name, warehouse_id)
     VALUES ($1, $2, 'Main', (SELECT min(id) FROM warehouses))`,
    [storeId, `gid://shopify/Location/${LOCATION}`],
  );
  const levels: Record<string, number> = {};
  for (const [sku, inventoryItem] of [
    ['TEE', TEE_ITEM],
    ['DECOY', DECOY_ITEM],
  ] as const) {
    const itemId = await ensureItem(db, sku);
    await db.query(
      `INSERT INTO variants (store_id, item_id, shopify_product_id, shopify_variant_id, inventory_item_id, sku)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        storeId,
        itemId,
        `gid://shopify/Product/${inventoryItem}`,
        `gid://shopify/ProductVariant/${inventoryItem}`,
        `gid://shopify/InventoryItem/${inventoryItem}`,
        sku,
      ],
    );
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM pool_levels WHERE item_id = $1',
      [itemId],
    );
    levels[sku] = rows[0]!.id;
  }
  return { storeId, levels };
}

function deliver(
  shop: string,
  topic: string,
  payload: string,
  opts: { secret?: string; webhookId?: string | null; headers?: Record<string, string> } = {},
) {
  const rawBody = Buffer.from(payload);
  const headers: Record<string, string> = {
    'x-shopify-shop-domain': shop,
    'x-shopify-topic': topic,
    'x-shopify-hmac-sha256': createHmac('sha256', opts.secret ?? WEBHOOK_SECRET)
      .update(rawBody)
      .digest('base64'),
    'x-shopify-triggered-at': new Date().toISOString(),
    ...opts.headers,
  };
  if (opts.webhookId !== null) headers['x-shopify-webhook-id'] = opts.webhookId ?? randomUUID();
  return handleShopifyWebhook(deps, { headers, rawBody });
}

function levelPayload(inventoryItem: string, location = LOCATION): string {
  return (
    `{"inventory_item_id":${inventoryItem},"location_id":${location},"available":9,` +
    `"updated_at":"2026-10-17T10:00:00-04:00",` +
    `"admin_graphql_api_id":"gid://shopify/InventoryLevel/${location}?inventory_item_id=${inventoryItem}"}`
  );
}

async function queued() {
  const { rows } = await db.query<{ pool_level_id: number; reason: string }>(
    'SELECT pool_level_id, reason FROM sync_queue ORDER BY pool_level_id',
  );
  return rows;
}

async function tasks() {
  const { rows } = await db.query<{ kind: string; payload: unknown; generation: number }>(
    'SELECT kind, payload, generation FROM tasks ORDER BY id',
  );
  return rows;
}

describe('webhook intake', () => {
  it('accepts a correctly signed webhook and rejects bad signatures and unknown shops', async () => {
    const storeId = await addStore('legacy', { webhookSecret: WEBHOOK_SECRET });
    const shop = 'legacy.myshopify.com';

    expect(await deliver(shop, 'locations/update', '{"id":1}', { secret: 'wrong' })).toEqual({
      status: 401,
      body: 'unauthorized',
    });
    expect((await deliver('stranger.myshopify.com', 'locations/update', '{"id":1}')).status).toBe(
      401,
    );
    const unsigned = await handleShopifyWebhook(deps, {
      headers: { 'x-shopify-shop-domain': shop, 'x-shopify-topic': 'locations/update' },
      rawBody: Buffer.from('{"id":1}'),
    });
    expect(unsigned.status).toBe(401);
    const { rows: before } = await db.query('SELECT count(*)::int AS n FROM webhook_events');
    expect(before[0].n).toBe(0);

    // Header names and the shop domain are case-insensitive.
    expect(
      await deliver('Legacy.MyShopify.com', 'Locations/Update', '{"id":1}', {
        headers: { 'X-Shopify-Shop-Domain': 'Legacy.MyShopify.com' },
      }),
    ).toEqual({ status: 200, body: 'ok' });
    const { rows } = await db.query('SELECT last_webhook_at FROM stores WHERE id = $1', [storeId]);
    expect(rows[0].last_webhook_at).toBeInstanceOf(Date);
  });

  it('verifies with the client secret when no webhook secret is saved, and explains a missing secret', async () => {
    await addStore('devapp', { clientSecret: CLIENT_SECRET });
    await addStore('nosecret');

    const ok = await deliver('devapp.myshopify.com', 'locations/update', '{}', {
      secret: CLIENT_SECRET,
    });
    expect(ok.status).toBe(200);
    expect((await deliver('devapp.myshopify.com', 'locations/update', '{}')).status).toBe(401);

    expect((await deliver('nosecret.myshopify.com', 'locations/update', '{}')).status).toBe(401);
    expect(logLines.some((line) => line.includes('Add the API secret key'))).toBe(true);
    expect(logLines.some((line) => line.includes(WEBHOOK_SECRET))).toBe(false);
  });

  it('processes each webhook once, even without a webhook id', async () => {
    await addStore('legacy', { webhookSecret: WEBHOOK_SECRET });
    const shop = 'legacy.myshopify.com';
    const body = '{"admin_graphql_api_id":"gid://shopify/InventoryItem/42"}';

    expect((await deliver(shop, 'inventory_items/update', body, { webhookId: 'w-1' })).body).toBe(
      'ok',
    );
    expect(await deliver(shop, 'inventory_items/update', body, { webhookId: 'w-1' })).toEqual({
      status: 200,
      body: 'duplicate',
    });
    expect((await tasks()).map((t) => t.generation)).toEqual([1]);
    expect(onWork).toHaveBeenCalledTimes(1);

    const anonymous = '{"id":7}';
    expect((await deliver(shop, 'products/delete', anonymous, { webhookId: null })).body).toBe(
      'ok',
    );
    expect((await deliver(shop, 'products/delete', anonymous, { webhookId: null })).body).toBe(
      'duplicate',
    );
  });

  it('enqueues exactly the pool level of an inventory level, keeping 18-digit ids exact', async () => {
    expect(Number(TEE_ITEM)).toBe(Number(DECOY_ITEM));
    const { levels } = await addSyncedStore();
    const shop = 'legacy.myshopify.com';

    expect(await deliver(shop, 'inventory_levels/update', levelPayload(TEE_ITEM))).toEqual({
      status: 200,
      body: 'ok',
    });
    expect(await queued()).toEqual([{ pool_level_id: levels.TEE, reason: 'webhook' }]);
    expect(onWork).toHaveBeenCalledTimes(1);

    // Only the admin_graphql_api_id carries the ids.
    await db.query('DELETE FROM sync_queue');
    const gidOnly = `{"admin_graphql_api_id":"gid://shopify/InventoryLevel/${LOCATION}?inventory_item_id=${DECOY_ITEM}"}`;
    expect((await deliver(shop, 'inventory_levels/connect', gidOnly)).body).toBe('ok');
    expect(await queued()).toEqual([{ pool_level_id: levels.DECOY, reason: 'webhook' }]);

    // A location we don't sync: nothing to do.
    await db.query('DELETE FROM sync_queue');
    onWork.mockClear();
    expect(
      (await deliver(shop, 'inventory_levels/update', levelPayload(TEE_ITEM, '99'))).body,
    ).toBe('ok');
    expect(await queued()).toEqual([]);
    expect(await tasks()).toEqual([]);
    expect(onWork).not.toHaveBeenCalled();
  });

  it('asks for a catalog refresh when an inventory level belongs to an unknown inventory item', async () => {
    const { storeId } = await addSyncedStore();
    const unknown = '271878346596884099';
    await deliver('legacy.myshopify.com', 'inventory_levels/update', levelPayload(unknown));
    expect(await queued()).toEqual([]);
    expect(await tasks()).toEqual([
      {
        kind: 'refresh_inventory_item',
        payload: { storeId, inventoryItemId: `gid://shopify/InventoryItem/${unknown}` },
        generation: 1,
      },
    ]);
    expect(onWork).toHaveBeenCalledTimes(1);
  });

  it('turns catalog and location webhooks into background tasks', async () => {
    const storeId = await addStore('legacy', { webhookSecret: WEBHOOK_SECRET });
    const shop = 'legacy.myshopify.com';
    const item = `{"id":${TEE_ITEM},"sku":"TEE","admin_graphql_api_id":"gid://shopify/InventoryItem/${TEE_ITEM}"}`;
    await deliver(shop, 'inventory_items/create', item);
    await deliver(shop, 'inventory_items/update', item);
    await deliver(shop, 'inventory_items/delete', `{"id":${DECOY_ITEM}}`);
    await deliver(shop, 'products/delete', '{"id":788032119674292922}');
    await deliver(shop, 'locations/deactivate', `{"id":${LOCATION},"active":false}`);

    expect(await tasks()).toEqual([
      {
        kind: 'refresh_inventory_item',
        payload: { storeId, inventoryItemId: `gid://shopify/InventoryItem/${TEE_ITEM}` },
        generation: 2, // create + update coalesce into one refresh
      },
      {
        kind: 'remove_inventory_item',
        payload: { storeId, inventoryItemId: `gid://shopify/InventoryItem/${DECOY_ITEM}` },
        generation: 1,
      },
      {
        kind: 'remove_product',
        payload: { storeId, productId: 'gid://shopify/Product/788032119674292922' },
        generation: 1,
      },
      { kind: 'sync_locations', payload: { storeId }, generation: 1 },
    ]);
    expect(onWork).toHaveBeenCalledTimes(5);
  });

  it('disconnects the store when the app is uninstalled', async () => {
    const storeId = await addStore('legacy', { webhookSecret: WEBHOOK_SECRET });
    expect(
      (await deliver('legacy.myshopify.com', 'app/uninstalled', '{"id":1,"name":"Legacy"}')).body,
    ).toBe('ok');
    const { rows } = await db.query('SELECT status, last_error FROM stores WHERE id = $1', [
      storeId,
    ]);
    expect(rows[0]).toEqual({ status: 'disconnected', last_error: UNINSTALLED_ERROR });
    const alerts = await db.query(
      'SELECT kind, dedupe_key, store_id FROM alerts WHERE resolved_at IS NULL',
    );
    expect(alerts.rows).toEqual([
      { kind: 'store_error', dedupe_key: `store_error:${storeId}`, store_id: storeId },
    ]);
    expect(onWork).not.toHaveBeenCalled();
  });

  it('acknowledges topics it does not handle and payloads without the expected ids', async () => {
    await addStore('legacy', { webhookSecret: WEBHOOK_SECRET });
    const shop = 'legacy.myshopify.com';
    expect(await deliver(shop, 'orders/create', '{"id":1}')).toEqual({
      status: 200,
      body: 'ignored',
    });
    expect((await deliver(shop, 'inventory_levels/update', '{"available":3}')).body).toBe(
      'ignored',
    );
    expect(await tasks()).toEqual([]);
  });

  it('answers 500 and records nothing when processing fails, so the retry is not a duplicate', async () => {
    await addStore('legacy', { webhookSecret: WEBHOOK_SECRET });
    const body = `{"admin_graphql_api_id":"gid://shopify/InventoryItem/${TEE_ITEM}"}`;
    await db.query('ALTER TABLE tasks RENAME TO tasks_offline');
    const failed = await deliver('legacy.myshopify.com', 'inventory_items/update', body, {
      webhookId: 'w-retry',
    });
    expect(failed).toEqual({ status: 500, body: 'error' });
    await db.query('ALTER TABLE tasks_offline RENAME TO tasks');

    const retried = await deliver('legacy.myshopify.com', 'inventory_items/update', body, {
      webhookId: 'w-retry',
    });
    expect(retried).toEqual({ status: 200, body: 'ok' });
    expect(await tasks()).toHaveLength(1);
  });
});

describe('ensureWebhooks', () => {
  const url = webhookUrl('https://sync.example.com');

  it('subscribes every topic on a fresh shop, and does nothing the second time', async () => {
    const shop = new FakeShop('a.myshopify.com');
    expect(url).toBe('https://sync.example.com/webhooks/shopify');

    const first = await ensureWebhooks(shop, url);
    expect(first).toEqual({ created: [...WEBHOOK_TOPICS], deleted: [] });
    expect(shop.subscriptions.map((s) => [s.topic, s.uri])).toEqual(
      WEBHOOK_TOPICS.map((t) => [t, url]),
    );
    expect(await ensureWebhooks(shop, url)).toEqual({ created: [], deleted: [] });
  });

  it('moves our subscriptions off an old domain and drops duplicates, leaving other apps alone', async () => {
    const shop = new FakeShop('a.myshopify.com');
    await ensureWebhooks(shop, 'https://old.example.com/webhooks/shopify');
    await shop.createWebhookSubscription('INVENTORY_LEVELS_UPDATE', url);
    await shop.createWebhookSubscription('INVENTORY_LEVELS_UPDATE', url);
    await shop.createWebhookSubscription('ORDERS_CREATE', 'https://other-app.example.com/hooks');
    await shop.createWebhookSubscription(
      'PRODUCTS_UPDATE',
      'arn:aws:events:us-east-1::event-source',
    );

    const result = await ensureWebhooks(shop, url);
    expect(result.created).toEqual(WEBHOOK_TOPICS.filter((t) => t !== 'INVENTORY_LEVELS_UPDATE'));
    expect(result.deleted.sort()).toEqual([...WEBHOOK_TOPICS, 'INVENTORY_LEVELS_UPDATE'].sort());
    expect(
      shop.subscriptions
        .filter((s) => s.uri === url)
        .map((s) => s.topic)
        .sort(),
    ).toEqual([...WEBHOOK_TOPICS].sort());
    expect(shop.subscriptions.filter((s) => s.uri !== url).map((s) => s.topic)).toEqual([
      'ORDERS_CREATE',
      'PRODUCTS_UPDATE',
    ]);
  });

  it('refuses a URL that is not our webhook endpoint', async () => {
    const shop = new FakeShop('a.myshopify.com');
    await expect(ensureWebhooks(shop, 'https://sync.example.com/')).rejects.toThrow(
      /webhooks\/shopify/,
    );
    await expect(ensureWebhooks(shop, '/webhooks/shopify')).rejects.toThrow();
    expect(shop.subscriptions).toEqual([]);
  });
});
