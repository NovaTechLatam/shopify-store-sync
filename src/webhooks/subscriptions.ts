import { ShopifyApiError, ShopifyUserErrors } from '../shopify/client.js';
import { missingScopes } from '../shopify/scopes.js';
import type { ShopifyAdmin, WebhookSubscription } from '../shopify/types.js';
import { OPTIONAL_WEBHOOK_TOPICS, WEBHOOK_PATH, WEBHOOK_TOPICS } from './topics.js';

export interface EnsureWebhooksResult {
  created: string[];
  deleted: string[];
  /** Optional topics Shopify wouldn't subscribe us to, with its reason. */
  refused: { topic: string; message: string }[];
}

/**
 * Makes the store's subscriptions match the wanted topics at `url`: WEBHOOK_TOPICS, plus the
 * OPTIONAL_WEBHOOK_TOPICS whose scope is among `scopes` (the store's granted scopes; without them
 * only the core topics are wanted). Creates missing ones, deletes duplicates, topics no longer
 * wanted and our own subscriptions that point to a different URL ending in WEBHOOK_PATH (old
 * domain). Never deletes other subscriptions.
 *
 * Missing subscriptions are created before stale ones are deleted, so moving to a new domain
 * never leaves a gap in which changes go unnoticed. A core topic that can't be created throws
 * (stock syncing depends on it); an optional one Shopify refuses (missing scope, protected
 * customer data not approved) is reported in `refused` and the rest carries on.
 */
export async function ensureWebhooks(
  admin: ShopifyAdmin,
  url: string,
  opts: { scopes?: readonly string[] } = {},
): Promise<EnsureWebhooksResult> {
  // Every subscription ending in WEBHOOK_PATH is treated as ours: a wrong URL here would
  // replace all of them.
  if (!URL.canParse(url) || !url.endsWith(WEBHOOK_PATH))
    throw new Error(`Webhook URL must be an absolute URL ending in ${WEBHOOK_PATH}: ${url}`);

  const optional = optionalTopics(opts.scopes);
  const wanted = new Set<string>([...WEBHOOK_TOPICS, ...optional]);
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
  const refused: { topic: string; message: string }[] = [];
  for (const topic of optional) {
    if (current.has(topic)) continue;
    try {
      await admin.createWebhookSubscription(topic, url);
      created.push(topic);
    } catch (err) {
      // Network trouble isn't a refusal: let the caller retry the whole run.
      if (!(err instanceof ShopifyApiError) || (err.kind !== 'invalid' && err.kind !== 'auth'))
        throw err;
      refused.push({
        topic,
        message:
          err instanceof ShopifyUserErrors
            ? err.errors.map((e) => e.message).join('; ')
            : err.message,
      });
    }
  }
  const deleted: string[] = [];
  for (const sub of stale) {
    await admin.deleteWebhookSubscription(sub.id);
    deleted.push(sub.topic);
  }
  return { created, deleted, refused };
}

/** The optional topics a store with these scopes gets (none when the scopes aren't known). */
export function optionalTopics(scopes: readonly string[] | undefined): string[] {
  if (!scopes) return [];
  return OPTIONAL_WEBHOOK_TOPICS.filter(
    (t) => t.scope === null || missingScopes(scopes, [t.scope]).length === 0,
  ).map((t) => t.topic);
}
