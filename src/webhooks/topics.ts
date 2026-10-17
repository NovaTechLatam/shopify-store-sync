/** Where Shopify delivers our webhooks. Also how we recognise our own subscriptions. */
export const WEBHOOK_PATH = '/webhooks/shopify';

/** Every topic the sync listens to (GraphQL enum form, as used when subscribing). */
export const WEBHOOK_TOPICS = [
  'INVENTORY_LEVELS_UPDATE',
  'INVENTORY_LEVELS_CONNECT',
  'INVENTORY_LEVELS_DISCONNECT',
  'INVENTORY_ITEMS_CREATE',
  'INVENTORY_ITEMS_UPDATE',
  'INVENTORY_ITEMS_DELETE',
  'PRODUCTS_DELETE',
  'LOCATIONS_CREATE',
  'LOCATIONS_UPDATE',
  'LOCATIONS_ACTIVATE',
  'LOCATIONS_DEACTIVATE',
  'LOCATIONS_DELETE',
  'APP_UNINSTALLED',
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

/**
 * Topics of the optional features, subscribed only when the store granted their scope (null =
 * none needed). Shopify may still refuse them: orders topics carry protected customer data, which
 * the app must be approved for. A refusal doesn't stop stock syncing (see ensureWebhooks).
 */
export const OPTIONAL_WEBHOOK_TOPICS = [
  { topic: 'ORDERS_CREATE', scope: 'read_orders' },
  { topic: 'ORDERS_UPDATED', scope: 'read_orders' },
  { topic: 'ORDERS_CANCELLED', scope: 'read_orders' },
  { topic: 'ORDERS_DELETE', scope: 'read_orders' },
  { topic: 'REFUNDS_CREATE', scope: 'read_orders' },
  // Our order history export finished (the sales backfill also polls, in case it never comes).
  { topic: 'BULK_OPERATIONS_FINISH', scope: null },
] as const satisfies readonly { topic: string; scope: string | null }[];

export type OptionalWebhookTopic = (typeof OPTIONAL_WEBHOOK_TOPICS)[number]['topic'];

export function webhookUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
}
