import type { Logger } from 'pino';
import { setAlert } from '../alerts/alerts.js';
import type { Db } from '../db/pool.js';
import { recordShopInfo } from '../shopify/scopes.js';
import type { ShopifyRegistry } from '../sync/engine.js';
import { enqueueTask } from '../tasks/queue.js';
import type { EnsureWebhooksResult } from './subscriptions.js';
import { ensureWebhooks, optionalTopics } from './subscriptions.js';
import { WEBHOOK_TOPICS, webhookUrl } from './topics.js';

export interface RegisterWebhooksDeps {
  db: Db;
  shopify: ShopifyRegistry;
  logger: Logger;
  /** Public base URL of this service; webhook subscriptions point at it. */
  publicUrl: string;
}

const CORE_TOPICS = new Set<string>(WEBHOOK_TOPICS);

/**
 * The ensure_webhooks task (and the dashboard's "set up live updates again"): reads the shop,
 * saving its scopes, currency and time zone; makes the subscriptions match what this store
 * should get; remembers the topics registered (stores.webhook_topics); and raises or resolves the
 * alerts about them.
 */
export async function registerStoreWebhooks(
  deps: RegisterWebhooksDeps,
  storeId: number,
): Promise<EnsureWebhooksResult> {
  const { db, logger } = deps;
  const { rows } = await db.query<{ name: string; webhook_topics: string[] }>(
    'SELECT name, webhook_topics FROM stores WHERE id = $1',
    [storeId],
  );
  const store = rows[0];
  if (!store) throw new Error(`Store ${storeId} not found`);

  const admin = await deps.shopify.forStore(storeId);
  const shop = await admin.getShop();
  await recordShopInfo(db, storeId, shop);
  const result = await ensureWebhooks(admin, webhookUrl(deps.publicUrl), { scopes: shop.scopes });

  const refusedTopics = new Set(result.refused.map((r) => r.topic));
  const registered = [...WEBHOOK_TOPICS, ...optionalTopics(shop.scopes)].filter(
    (t) => !refusedTopics.has(t),
  );
  await db.query(
    `UPDATE stores SET webhooks_registered_at = now(), webhook_topics = $2, updated_at = now()
      WHERE id = $1`,
    [storeId, registered],
  );
  const { created, deleted, refused } = result;
  if (created.length || deleted.length || refused.length)
    logger.info({ storeId, created, deleted, refused }, 'webhook subscriptions updated');

  // Shopify deletes subscriptions after repeated delivery failures: stock changes may have been
  // missed. Only a stock topic we had registered before counts (a topic added by a new version or
  // a newly granted scope is simply new; order updates are caught up by the sales sync).
  const before = new Set(store.webhook_topics);
  const recreated = created.filter((t) => before.has(t) && CORE_TOPICS.has(t));
  if (recreated.length) {
    await setAlert(db, {
      open: true,
      kind: 'webhooks_recreated',
      dedupeKey: `webhooks_recreated:${storeId}`,
      storeId,
      message:
        `Shopify had stopped sending stock updates for ${store.name} (${recreated.length} webhook ` +
        `subscription${recreated.length === 1 ? ' was' : 's were'} missing, usually after this service ` +
        `was unreachable for a while). They have been re-created and a full stock check is running.`,
      details: { created: recreated },
    });
    await enqueueTask(db, 'drift_scan', { storeId });
  }

  await setAlert(db, {
    open: refused.length > 0,
    kind: 'sales_webhooks_refused',
    dedupeKey: `sales_webhooks_refused:${storeId}`,
    storeId,
    message:
      `Shopify didn’t allow live sales updates for ${store.name}` +
      `${refused.length ? ` (${[...new Set(refused.map((r) => r.message))].join('; ')})` : ''}. ` +
      'Reports still work, but new orders and refunds show up within 15 minutes instead of right ' +
      'away. To fix this, request access to protected customer data in the app’s settings (in the ' +
      'Dev Dashboard: API access → Protected customer data access), release the new version and ' +
      'approve it in the store’s Shopify admin. We try again every 15 minutes.',
    details: { refused },
  });
  return result;
}
