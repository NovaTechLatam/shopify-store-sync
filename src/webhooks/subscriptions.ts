import type { ShopifyAdmin, WebhookSubscription } from '../shopify/types.js';
import { WEBHOOK_PATH, WEBHOOK_TOPICS } from './topics.js';

/**
 * Makes the store's subscriptions match WEBHOOK_TOPICS at `url`: creates missing, deletes duplicates
 * and our own subscriptions that point to a different URL ending in WEBHOOK_PATH (old domain).
 * Never deletes other subscriptions. Returns the topics created and deleted.
 *
 * Missing subscriptions are created before stale ones are deleted, so moving to a new domain
 * never leaves a gap in which changes go unnoticed.
 */
export async function ensureWebhooks(
  admin: ShopifyAdmin,
  url: string,
): Promise<{ created: string[]; deleted: string[] }> {
  // Every subscription ending in WEBHOOK_PATH is treated as ours: a wrong URL here would
  // replace all of them.
  if (!URL.canParse(url) || !url.endsWith(WEBHOOK_PATH))
    throw new Error(`Webhook URL must be an absolute URL ending in ${WEBHOOK_PATH}: ${url}`);

  const wanted = new Set<string>(WEBHOOK_TOPICS);
  const current = new Set<string>();
  const stale: WebhookSubscription[] = [];
  for (const sub of await admin.listWebhookSubscriptions()) {
    if (!sub.uri.endsWith(WEBHOOK_PATH)) continue;
    if (sub.uri === url && wanted.has(sub.topic) && !current.has(sub.topic)) current.add(sub.topic);
    else stale.push(sub);
  }

  const created: string[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    if (current.has(topic)) continue;
    await admin.createWebhookSubscription(topic, url);
    created.push(topic);
  }
  const deleted: string[] = [];
  for (const sub of stale) {
    await admin.deleteWebhookSubscription(sub.id);
    deleted.push(sub.topic);
  }
  return { created, deleted };
}
