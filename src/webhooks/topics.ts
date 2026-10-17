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

export function webhookUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
}
