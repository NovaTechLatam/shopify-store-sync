import type { Queryable } from '../db/pool.js';
import type { ShopInfo } from './types.js';

/**
 * Access scopes of the features beyond stock syncing. They are optional: a store without them
 * keeps syncing stock (REQUIRED_SCOPES in src/sync/health.ts are the only ones checked when a
 * store connects), and the feature shows a "needs permission" state for that store instead of
 * calling Shopify. The granted scopes are read with the shop (stores.granted_scopes).
 */
export const FEATURE_SCOPES = {
  catalog: ['write_products'],
  publishing: ['write_publications'],
  pricing: ['write_products'],
  sales: ['read_orders'],
} as const;

export type Feature = keyof typeof FEATURE_SCOPES;

export const FEATURES = Object.keys(FEATURE_SCOPES) as Feature[];

/** What each feature needs the permission for, completing “hasn’t given Store Sync permission to …”. */
const FEATURE_ACTIONS: Record<Feature, string> = {
  catalog: 'create and update its products',
  publishing: 'show products in its Online Store',
  pricing: 'update its prices',
  sales: 'read its orders',
};

/**
 * The scopes of `needed` that `granted` lacks. write_X includes read_X (Shopify lists only the
 * write scope). `granted` null = never checked: nothing is reported missing, so the feature tries
 * and Shopify's answer decides (an ACCESS_DENIED then says what is missing).
 */
export function missingScopes(
  granted: readonly string[] | null,
  needed: readonly string[],
): string[] {
  if (granted === null) return [];
  const have = new Set(granted);
  return needed.filter((scope) => !have.has(scope) && !have.has(scope.replace(/^read_/, 'write_')));
}

export function featureStatus(
  granted: readonly string[] | null,
): Record<Feature, { available: boolean; missingScopes: string[] }> {
  const out = {} as Record<Feature, { available: boolean; missingScopes: string[] }>;
  for (const feature of FEATURES) {
    const missing = missingScopes(granted, FEATURE_SCOPES[feature]);
    out[feature] = { available: missing.length === 0, missingScopes: missing };
  }
  return out;
}

/** A feature was asked to work on a store whose app permissions don't allow it. */
export class FeatureUnavailableError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly storeName: string,
    readonly feature: Feature,
    readonly missing: string[],
  ) {
    super(
      `“${storeName}” hasn’t given Store Sync permission to ${FEATURE_ACTIONS[feature]} ` +
        `(${missing.join(', ')}). Add it to the app’s access scopes and approve the update in ` +
        'the store’s Shopify admin, then click “Test connection” on the store’s page.',
    );
    this.name = 'FeatureUnavailableError';
  }
}

/**
 * Throws FeatureUnavailableError when the store's granted scopes (as last read) lack what the
 * feature needs. Feature tasks call it before talking to Shopify, so a missing permission is
 * reported on the feature's own rows instead of failing (and retrying) against Shopify.
 */
export async function requireFeature(
  db: Queryable,
  storeId: number,
  feature: Feature,
): Promise<void> {
  const { rows } = await db.query<{ name: string; granted_scopes: string[] | null }>(
    'SELECT name, granted_scopes FROM stores WHERE id = $1',
    [storeId],
  );
  const store = rows[0];
  if (!store) throw new Error(`Store ${storeId} not found`);
  const missing = missingScopes(store.granted_scopes, FEATURE_SCOPES[feature]);
  if (missing.length) throw new FeatureUnavailableError(store.name, feature, missing);
}

/**
 * Saves what we learned from getShop(): the granted scopes (when they were read), the store's
 * currency and time zone. Called wherever the shop is read (connection tests, health checks,
 * webhook registration).
 */
export async function recordShopInfo(
  db: Queryable,
  storeId: number,
  shop: ShopInfo,
): Promise<void> {
  await db.query(
    `UPDATE stores SET granted_scopes = $2, scopes_checked_at = now(), currency_code = $3,
                       iana_timezone = $4
      WHERE id = $1`,
    [storeId, shop.scopes, shop.currencyCode, shop.ianaTimezone],
  );
}
