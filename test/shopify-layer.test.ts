import { afterEach, describe, expect, it } from 'vitest';
import { refreshInventoryItem, syncStoreCatalog } from '../src/catalog/catalog.js';
import { loadStores } from '../src/http/api/stores.js';
import {
  FEATURE_SCOPES,
  FeatureUnavailableError,
  featureStatus,
  missingScopes,
  requireFeature,
} from '../src/shopify/scopes.js';
import { checkStoreHealth } from '../src/sync/health.js';
import { registerStoreWebhooks } from '../src/webhooks/register.js';
import { OPTIONAL_WEBHOOK_TOPICS, WEBHOOK_TOPICS } from '../src/webhooks/topics.js';
import { Harness, silentLogger } from './helpers/harness.js';

const PUBLIC_URL = 'https://sync.example.com';
const URL_ = `${PUBLIC_URL}/webhooks/shopify`;
const ORDER_TOPICS = OPTIONAL_WEBHOOK_TOPICS.filter((t) => t.scope === 'read_orders').map(
  (t) => t.topic,
);

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function harness(stores = 1): Promise<Harness> {
  h = await Harness.create(stores);
  return h;
}

const deps = (hh: Harness) => ({
  db: hh.db,
  shopify: hh.registry,
  logger: silentLogger,
  publicUrl: PUBLIC_URL,
});

async function openAlerts(hh: Harness) {
  const { rows } = await hh.db.query<{ kind: string; dedupe_key: string; message: string }>(
    'SELECT kind, dedupe_key, message FROM alerts WHERE resolved_at IS NULL ORDER BY id',
  );
  return rows;
}

async function storeRow(hh: Harness, storeId: number) {
  const { rows } = await hh.db.query(
    `SELECT granted_scopes, scopes_checked_at, currency_code, iana_timezone, webhook_topics
       FROM stores WHERE id = $1`,
    [storeId],
  );
  return rows[0];
}

describe('optional scopes', () => {
  it('counts write access as read access, and an unknown grant as “let Shopify decide”', () => {
    expect(missingScopes(['read_products'], ['write_products'])).toEqual(['write_products']);
    expect(missingScopes(['write_orders'], ['read_orders'])).toEqual([]);
    expect(missingScopes(['read_orders'], ['read_orders', 'write_publications'])).toEqual([
      'write_publications',
    ]);
    expect(missingScopes(null, ['write_products'])).toEqual([]);
  });

  it('reports what each feature can do', () => {
    expect(featureStatus(['read_products', 'write_products', 'read_inventory'])).toEqual({
      catalog: { available: true, missingScopes: [] },
      publishing: { available: false, missingScopes: ['write_publications'] },
      pricing: { available: true, missingScopes: [] },
      sales: { available: false, missingScopes: ['read_orders'] },
    });
    expect(Object.values(featureStatus(null)).every((f) => f.available)).toBe(true);
    expect(Object.keys(featureStatus([]))).toEqual(Object.keys(FEATURE_SCOPES));
  });

  it('requireFeature refuses a store without the permission, in words the merchant can act on', async () => {
    const hh = await harness();
    const store = hh.stores[0]!;
    // Never checked: allowed (Shopify answers).
    await expect(requireFeature(hh.db, store.id, 'sales')).resolves.toBeUndefined();

    await hh.db.query(`UPDATE stores SET granted_scopes = $2 WHERE id = $1`, [
      store.id,
      ['read_products', 'write_orders'],
    ]);
    await expect(requireFeature(hh.db, store.id, 'sales')).resolves.toBeUndefined();
    const err = await requireFeature(hh.db, store.id, 'catalog').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureUnavailableError);
    expect(err).toMatchObject({
      statusCode: 409,
      storeName: 'brand0',
      feature: 'catalog',
      missing: ['write_products'],
    });
    expect((err as Error).message).toBe(
      '“brand0” hasn’t given Store Sync permission to create and update its products ' +
        '(write_products). Add it to the app’s access scopes and approve the update in the ' +
        'store’s Shopify admin, then click “Test connection” on the store’s page.',
    );
    await expect(requireFeature(hh.db, 9999, 'catalog')).rejects.toThrow(/not found/);
  });

  it('the health check records the scopes, currency and time zone it reads', async () => {
    const hh = await harness();
    const store = hh.stores[0]!;
    store.shop.scopes.push('write_products');
    store.shop.currencyCode = 'COP';
    store.shop.ianaTimezone = 'America/Bogota';
    await checkStoreHealth({ db: hh.db, shopify: hh.registry, logger: silentLogger }, store.id);
    expect(await storeRow(hh, store.id)).toMatchObject({
      granted_scopes: [...store.shop.scopes],
      scopes_checked_at: expect.any(Date),
      currency_code: 'COP',
      iana_timezone: 'America/Bogota',
    });
    const [view] = await loadStores(hh.db, store.id);
    expect(view).toMatchObject({
      currencyCode: 'COP',
      timezone: 'America/Bogota',
      scopesCheckedAt: expect.any(Date),
      features: {
        catalog: { available: true, missingScopes: [] },
        sales: { available: false, missingScopes: ['read_orders'] },
      },
    });
  });
});

describe('registering webhooks', () => {
  it('subscribes the orders topics only with read_orders, and records what it read', async () => {
    const hh = await harness();
    const store = hh.stores[0]!;
    store.shop.currencyCode = 'CLP';
    let result = await registerStoreWebhooks(deps(hh), store.id);
    expect(result.created).toEqual([...WEBHOOK_TOPICS, 'BULK_OPERATIONS_FINISH']);
    expect(await storeRow(hh, store.id)).toMatchObject({
      currency_code: 'CLP',
      granted_scopes: store.shop.scopes,
      webhook_topics: [...WEBHOOK_TOPICS, 'BULK_OPERATIONS_FINISH'],
    });

    store.shop.scopes.push('read_orders');
    result = await registerStoreWebhooks(deps(hh), store.id);
    expect(result).toEqual({ created: ORDER_TOPICS, deleted: [], refused: [] });
    expect(store.shop.subscriptions.filter((s) => s.uri === URL_)).toHaveLength(
      WEBHOOK_TOPICS.length + OPTIONAL_WEBHOOK_TOPICS.length,
    );
    // New topics aren't Shopify having dropped ours.
    expect(await openAlerts(hh)).toEqual([]);

    // The permission is taken away: the orders subscriptions go.
    store.shop.scopes = store.shop.scopes.filter((s) => s !== 'read_orders');
    result = await registerStoreWebhooks(deps(hh), store.id);
    expect(result.deleted.sort()).toEqual([...ORDER_TOPICS].sort());
    expect((await storeRow(hh, store.id)).webhook_topics).toEqual([
      ...WEBHOOK_TOPICS,
      'BULK_OPERATIONS_FINISH',
    ]);
  });

  it('alerts about re-created subscriptions only when they were registered before', async () => {
    const hh = await harness();
    const store = hh.stores[0]!;
    // A store set up by version 1: its 13 topics registered (migration 002 records them).
    for (const topic of WEBHOOK_TOPICS) await store.shop.createWebhookSubscription(topic, URL_);
    await hh.db.query(
      `UPDATE stores SET webhooks_registered_at = now(), webhook_topics = $2 WHERE id = $1`,
      [store.id, [...WEBHOOK_TOPICS]],
    );
    store.shop.scopes.push('read_orders');
    const upgrade = await registerStoreWebhooks(deps(hh), store.id);
    expect(upgrade.created).toEqual(OPTIONAL_WEBHOOK_TOPICS.map((t) => t.topic));
    expect(await openAlerts(hh)).toEqual([]);
    expect((await hh.db.query(`SELECT 1 FROM tasks WHERE kind = 'drift_scan'`)).rowCount).toBe(0);

    // Shopify drops an orders subscription: order updates are caught up by the sales sync.
    const orders = store.shop.subscriptions.findIndex((s) => s.topic === 'ORDERS_UPDATED');
    store.shop.subscriptions.splice(orders, 1);
    expect((await registerStoreWebhooks(deps(hh), store.id)).created).toEqual(['ORDERS_UPDATED']);
    expect(await openAlerts(hh)).toEqual([]);

    // ...and a stock one: stock changes may have been missed.
    const stock = store.shop.subscriptions.findIndex((s) => s.topic === 'INVENTORY_LEVELS_UPDATE');
    store.shop.subscriptions.splice(stock, 1);
    await registerStoreWebhooks(deps(hh), store.id);
    expect(await openAlerts(hh)).toEqual([
      {
        kind: 'webhooks_recreated',
        dedupe_key: `webhooks_recreated:${store.id}`,
        message: expect.stringContaining('1 webhook subscription was missing'),
      },
    ]);
    expect((await hh.db.query(`SELECT 1 FROM tasks WHERE kind = 'drift_scan'`)).rowCount).toBe(1);
  });

  it('keeps syncing stock when Shopify refuses the sales topics, and says how to fix it', async () => {
    const hh = await harness();
    const store = hh.stores[0]!;
    store.shop.scopes.push('read_orders');
    for (const topic of ORDER_TOPICS) store.shop.refusedTopics.add(topic);

    const result = await registerStoreWebhooks(deps(hh), store.id);
    expect(result.created).toEqual([...WEBHOOK_TOPICS, 'BULK_OPERATIONS_FINISH']);
    expect(result.refused.map((r) => r.topic)).toEqual(ORDER_TOPICS);
    expect(result.refused[0]!.message).toMatch(/protected customer data/);
    const row = await storeRow(hh, store.id);
    expect(row.webhook_topics).toEqual([...WEBHOOK_TOPICS, 'BULK_OPERATIONS_FINISH']);
    const alerts = await openAlerts(hh);
    expect(alerts).toEqual([
      {
        kind: 'sales_webhooks_refused',
        dedupe_key: `sales_webhooks_refused:${store.id}`,
        message: expect.stringContaining('Shopify didn’t allow live sales updates for brand0'),
      },
    ]);
    expect(alerts[0]!.message).toMatch(/Reports still work.*within 15 minutes/);
    expect(alerts[0]!.message).toMatch(/protected customer data/);

    // Approved: the topics are created, the alert resolved, and nothing counts as re-created.
    store.shop.refusedTopics.clear();
    expect((await registerStoreWebhooks(deps(hh), store.id)).created).toEqual(ORDER_TOPICS);
    expect(await openAlerts(hh)).toEqual([]);
    expect((await storeRow(hh, store.id)).webhook_topics).toHaveLength(
      WEBHOOK_TOPICS.length + OPTIONAL_WEBHOOK_TOPICS.length,
    );
  });
});

describe('catalog sync', () => {
  it('stores each variant’s current price and compare-at price', async () => {
    const hh = await harness();
    const store = hh.stores[0]!;
    const tee = store.shop.addVariant('TEE', { price: 41900, compareAtPrice: 49900 });
    store.shop.addVariant('CAP', { price: 12.9 });
    await syncStoreCatalog({ db: hh.db, shopify: hh.registry, logger: silentLogger }, store.id);
    const prices = async () =>
      (
        await hh.db.query(
          'SELECT sku, price, compare_at_price FROM variants WHERE store_id = $1 ORDER BY sku',
          [store.id],
        )
      ).rows;
    expect(await prices()).toEqual([
      { sku: 'CAP', price: 12.9, compare_at_price: null },
      { sku: 'TEE', price: 41900, compare_at_price: 49900 },
    ]);

    // A price change in Shopify reaches us with the inventory item refresh.
    store.shop.variants.find((v) => v.variantId === tee.variantId)!.compareAtPrice = null;
    await refreshInventoryItem(
      { db: hh.db, shopify: hh.registry, logger: silentLogger },
      store.id,
      tee.inventoryItemId,
    );
    expect((await prices())[1]).toEqual({ sku: 'TEE', price: 41900, compare_at_price: null });
  });
});
