import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Db, DbClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { setAlert } from '../alerts/alerts.js';
import { enqueuePoolLevels } from '../sync/queue.js';
import { enqueueTask } from '../tasks/queue.js';
import type { SecretBox } from '../util/crypto.js';
import { verifyShopifyHmac } from '../util/crypto.js';

/**
 * Shopify webhook intake. Shopify expects an answer within 5 seconds and delivers at least once,
 * in any order, sometimes a day late. So we only verify, de-duplicate and mark work: a pool level
 * to reconcile (the engine re-reads live values, so a late or repeated webhook is harmless) or a
 * task (catalog, orders) that re-reads what changed. Payload IDs can exceed 2^53, so they are
 * taken from the raw body as strings and never parsed as JSON numbers.
 */

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export interface WebhookDeps {
  db: Db;
  secrets: SecretBox;
  logger: Logger;
  /** Wakes the workers after work was enqueued. */
  onWork?: () => void;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

interface WebhookStore {
  id: number;
  name: string;
  webhook_secret_enc: string | null;
  client_secret_enc: string | null;
  previous_client_secret_enc: string | null;
}

interface Dispatched {
  body: 'ok' | 'ignored';
  /** Pool levels or tasks were enqueued. */
  work: boolean;
}

export const UNINSTALLED_ERROR = 'The app was uninstalled from this store';

const UNAUTHORIZED: WebhookResponse = { status: 401, body: 'unauthorized' };

export async function handleShopifyWebhook(
  deps: WebhookDeps,
  req: WebhookRequest,
): Promise<WebhookResponse> {
  const shop = header(req.headers, 'x-shopify-shop-domain')?.trim().toLowerCase();
  const topic = header(req.headers, 'x-shopify-topic')?.trim().toLowerCase() ?? '';
  const log = deps.logger.child({ shop, topic });
  try {
    if (!shop) {
      log.warn('webhook without a shop domain rejected');
      return UNAUTHORIZED;
    }
    // Shop domains are stored lowercased.
    const { rows } = await deps.db.query<WebhookStore>(
      `SELECT id, name, webhook_secret_enc, client_secret_enc,
              CASE WHEN client_secret_rotated_at > now() - interval '7 days'
                   THEN previous_client_secret_enc END AS previous_client_secret_enc
         FROM stores WHERE shop_domain = $1`,
      [shop],
    );
    const store = rows[0];
    if (!store) {
      log.warn('webhook from an unknown shop rejected');
      return UNAUTHORIZED;
    }
    // Every secret Shopify may sign with: the explicit webhook secret, the app's client secret,
    // and for a week after a rotation the previous one (Shopify keeps using the oldest
    // unrevoked secret until the old one is revoked).
    const secrets = [
      store.webhook_secret_enc,
      store.client_secret_enc,
      store.previous_client_secret_enc,
    ].filter((v): v is string => Boolean(v));
    if (secrets.length === 0) {
      log.warn(
        { storeId: store.id },
        `Webhook from ${store.name} rejected: no API secret key is saved for this store, so its ` +
          'webhooks cannot be verified. Add the API secret key in the store settings.',
      );
      return UNAUTHORIZED;
    }
    const hmac = header(req.headers, 'x-shopify-hmac-sha256');
    if (!secrets.some((enc) => verifyShopifyHmac(req.rawBody, hmac, deps.secrets.decrypt(enc)))) {
      log.warn({ storeId: store.id }, 'webhook with an invalid signature rejected');
      return UNAUTHORIZED;
    }

    const body = req.rawBody.toString('utf8');
    const eventId =
      header(req.headers, 'x-shopify-webhook-id') ??
      `sha256:${createHash('sha256').update(`${store.id}\n${topic}\n${body}`).digest('hex')}`;
    log.debug(
      { storeId: store.id, eventId, triggeredAt: header(req.headers, 'x-shopify-triggered-at') },
      'webhook received',
    );

    // The de-duplication record commits together with the work it caused: if marking the work
    // fails, Shopify's retry is processed instead of being dropped as a duplicate.
    const outcome = await withTransaction(deps.db, async (client) => {
      const fresh = await client.query(
        `INSERT INTO webhook_events (event_id, store_id, topic) VALUES ($1, $2, $3)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, store.id, topic],
      );
      if (fresh.rowCount === 0) return null;
      await client.query('UPDATE stores SET last_webhook_at = now() WHERE id = $1', [store.id]);
      return dispatch(client, store, topic, body, log);
    });
    if (!outcome) return { status: 200, body: 'duplicate' };
    if (outcome.work) deps.onWork?.();
    return { status: 200, body: outcome.body };
  } catch (err) {
    log.error({ err }, 'webhook handling failed; Shopify will retry');
    return { status: 500, body: 'error' };
  }
}

async function dispatch(
  client: DbClient,
  store: WebhookStore,
  topic: string,
  body: string,
  log: Logger,
): Promise<Dispatched> {
  const storeId = store.id;
  switch (topic) {
    case 'inventory_levels/update':
    case 'inventory_levels/connect':
    case 'inventory_levels/disconnect': {
      const level = inventoryLevelIds(body);
      if (!level) return malformed(log);
      return inventoryLevelChanged(client, storeId, level.inventoryItemId, level.locationId);
    }
    case 'inventory_items/create':
    case 'inventory_items/update':
    case 'inventory_items/delete': {
      const inventoryItemId = resourceGid(body, 'InventoryItem');
      if (!inventoryItemId) return malformed(log);
      const kind =
        topic === 'inventory_items/delete' ? 'remove_inventory_item' : 'refresh_inventory_item';
      await enqueueTask(client, kind, { storeId, inventoryItemId });
      return { body: 'ok', work: true };
    }
    case 'products/delete': {
      const productId = resourceGid(body, 'Product');
      if (!productId) return malformed(log);
      await enqueueTask(client, 'remove_product', { storeId, productId });
      return { body: 'ok', work: true };
    }
    case 'locations/create':
    case 'locations/update':
    case 'locations/activate':
    case 'locations/deactivate':
    case 'locations/delete':
      await enqueueTask(client, 'sync_locations', { storeId });
      return { body: 'ok', work: true };
    // Sales history: the task re-reads the order, so late, repeated or out-of-order deliveries
    // are harmless. Order payloads hold many nested ids (line items, variants, customer...):
    // only the type-anchored admin_graphql_api_id is the order's.
    case 'orders/create':
    case 'orders/updated':
    case 'orders/cancelled': {
      const orderId = anchoredGid(body, 'Order');
      if (!orderId) return malformed(log);
      await enqueueTask(client, 'refresh_order', { storeId, orderId });
      return { body: 'ok', work: true };
    }
    case 'refunds/create': {
      // The refund's own id comes first; the order is `order_id`.
      const id = numericField(body, 'order_id');
      if (!id) return malformed(log);
      await enqueueTask(client, 'refresh_order', { storeId, orderId: `gid://shopify/Order/${id}` });
      return { body: 'ok', work: true };
    }
    case 'orders/delete': {
      // The payload is just {"id": …}.
      const orderId = resourceGid(body, 'Order');
      if (!orderId) return malformed(log);
      await enqueueTask(client, 'remove_order', { storeId, orderId });
      return { body: 'ok', work: true };
    }
    case 'bulk_operations/finish':
      // Our order history export finished (or failed): the backfill checks which and goes on.
      await enqueueTask(client, 'sales_backfill', { storeId });
      return { body: 'ok', work: true };
    case 'app/uninstalled':
      await client.query(
        `UPDATE stores SET status = 'disconnected', last_error = $2, updated_at = now() WHERE id = $1`,
        [storeId, UNINSTALLED_ERROR],
      );
      await setAlert(client, {
        open: true,
        kind: 'store_error',
        dedupeKey: `store_error:${storeId}`,
        storeId,
        message:
          `${store.name} stopped syncing: the app was uninstalled from this store. Install it ` +
          'again and update the store credentials to resume.',
      });
      log.warn({ storeId }, 'app uninstalled; store disconnected');
      return { body: 'ok', work: false };
    default:
      return { body: 'ignored', work: false };
  }
}

/**
 * Marks the pool levels fed by this inventory level dirty. An inventory item we have never seen
 * (a new variant whose catalog webhook hasn't been processed yet) is looked up first.
 */
async function inventoryLevelChanged(
  client: DbClient,
  storeId: number,
  inventoryItemId: string,
  locationId: string,
): Promise<Dispatched> {
  const { rows } = await client.query<{ pool_level_id: number | null }>(
    `SELECT pl.id AS pool_level_id
       FROM variants v
       LEFT JOIN store_locations sl ON sl.store_id = v.store_id AND sl.shopify_location_id = $3
                                   AND sl.warehouse_id IS NOT NULL
       LEFT JOIN pool_levels pl ON pl.item_id = v.item_id AND pl.warehouse_id = sl.warehouse_id
      WHERE v.store_id = $1 AND v.inventory_item_id = $2 AND v.deleted_at IS NULL`,
    [storeId, inventoryItemId, locationId],
  );
  if (rows.length === 0) {
    await enqueueTask(client, 'refresh_inventory_item', { storeId, inventoryItemId });
    return { body: 'ok', work: true };
  }
  const poolLevelIds = rows.map((r) => r.pool_level_id).filter((id): id is number => id !== null);
  await enqueuePoolLevels(client, poolLevelIds, 'webhook');
  return { body: 'ok', work: poolLevelIds.length > 0 };
}

function malformed(log: Logger): Dispatched {
  // Authentic but unusable: a retry would carry the same payload, so acknowledge it.
  log.warn('webhook payload is missing the expected ids; ignored');
  return { body: 'ignored', work: false };
}

/** Node lowercases header names, but callers (and tests) may not. */
function header(headers: WebhookRequest['headers'], name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first || undefined;
  }
  return undefined;
}

/** The decimal digits of `"<field>": 123` (or `"123"`) in a raw JSON body. */
function numericField(body: string, field: string): string | null {
  return new RegExp(`"${field}"\\s*:\\s*"?(\\d+)`).exec(body)?.[1] ?? null;
}

type ResourceType = 'InventoryItem' | 'Product' | 'Order';

/** `gid://shopify/<type>/<n>` from the payload's admin_graphql_api_id, else from its `id`. */
function resourceGid(body: string, type: ResourceType): string | null {
  const anchored = anchoredGid(body, type);
  if (anchored) return anchored;
  const id = numericField(body, 'id');
  return id ? `gid://shopify/${type}/${id}` : null;
}

/** The first admin_graphql_api_id of that type (never another object's id). */
function anchoredGid(body: string, type: ResourceType): string | null {
  const id = new RegExp(`"admin_graphql_api_id"\\s*:\\s*"gid://shopify/${type}/(\\d+)`).exec(
    body,
  )?.[1];
  return id ? `gid://shopify/${type}/${id}` : null;
}

/**
 * Inventory level payloads carry `inventory_item_id` and `location_id`, and an
 * admin_graphql_api_id like gid://shopify/InventoryLevel/<location id>?inventory_item_id=<id>.
 */
function inventoryLevelIds(body: string): { inventoryItemId: string; locationId: string } | null {
  const gid =
    /"admin_graphql_api_id"\s*:\s*"gid:\/\/shopify\/InventoryLevel\/(\d+)\?inventory_item_id=(\d+)/.exec(
      body,
    );
  const inventoryItemId = numericField(body, 'inventory_item_id') ?? gid?.[2];
  const locationId = numericField(body, 'location_id') ?? gid?.[1];
  if (!inventoryItemId || !locationId) return null;
  return {
    inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
    locationId: `gid://shopify/Location/${locationId}`,
  };
}
