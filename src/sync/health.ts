import type { Logger } from 'pino';
import { setAlert } from '../alerts/alerts.js';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { ShopifyAdmin } from '../shopify/types.js';
import { enqueueTask } from '../tasks/queue.js';
import type { ShopifyRegistry } from './engine.js';
import { enqueuePoolLevels } from './queue.js';

/** Admin API access scopes the app needs on every store. */
export const REQUIRED_SCOPES: readonly string[] = [
  'read_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
];

export interface ConnectionCheck {
  ok: boolean;
  shopName?: string;
  missingScopes: string[];
  error?: string;
}

/** Calls the shop and checks that every required scope was granted. Never throws. */
export async function checkConnection(admin: ShopifyAdmin): Promise<ConnectionCheck> {
  try {
    const shop = await admin.getShop();
    const granted = new Set(shop.scopes);
    // Shopify grants write_X without listing read_X, but write_X includes read access.
    const missingScopes = REQUIRED_SCOPES.filter(
      (scope) => !granted.has(scope) && !granted.has(scope.replace(/^read_/, 'write_')),
    );
    if (missingScopes.length) {
      return {
        ok: false,
        shopName: shop.name,
        missingScopes,
        error: `The app is missing these permissions: ${missingScopes.join(', ')}`,
      };
    }
    return { ok: true, shopName: shop.name, missingScopes: [] };
  } catch (err) {
    return { ok: false, missingScopes: [], error: errorMessage(err) };
  }
}

/**
 * Re-tests a store the engine put in `error` (credentials rejected, shop unavailable). When it works
 * again the store is re-activated and everything it may have missed is queued: its pool levels, a
 * webhook check and a catalog sync. Stores in any other status are only tested.
 */
export async function checkStoreHealth(
  deps: {
    db: Db;
    shopify: ShopifyRegistry & { invalidate?(storeId?: number): void };
    logger: Logger;
  },
  storeId: number,
): Promise<ConnectionCheck> {
  const { db, shopify, logger } = deps;
  const store = (
    await db.query<{ name: string }>('SELECT name FROM stores WHERE id = $1', [storeId])
  ).rows[0];
  if (!store) return { ok: false, missingScopes: [], error: `Store ${storeId} not found` };

  // The merchant may have just fixed the credentials: don't reuse a client built from old ones.
  shopify.invalidate?.(storeId);
  let check: ConnectionCheck;
  try {
    check = await checkConnection(await shopify.forStore(storeId));
  } catch (err) {
    check = { ok: false, missingScopes: [], error: errorMessage(err) };
  }

  if (!check.ok) {
    const reason = (check.error ?? 'Connection test failed').replace(/\.+$/, '');
    const { rowCount } = await db.query(
      `UPDATE stores SET last_error = $2, updated_at = now() WHERE id = $1 AND status = 'error'`,
      [storeId, reason],
    );
    if (rowCount) {
      await setAlert(db, {
        open: true,
        kind: 'store_error',
        dedupeKey: `store_error:${storeId}`,
        storeId,
        message: `${store.name} is not syncing: ${reason}. Check its connection on the Stores page.`,
        details: { missingScopes: check.missingScopes },
      });
    }
    return check;
  }

  const reactivated = await withTransaction(db, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE stores SET status = 'active', last_error = NULL, catalog_pending = true, updated_at = now()
        WHERE id = $1 AND status = 'error'`,
      [storeId],
    );
    if (!rowCount) return false;
    await setAlert(client, {
      open: false,
      kind: 'store_error',
      dedupeKey: `store_error:${storeId}`,
      message: '',
    });
    // Writes left unsettled while the store was down are settled right away. Everything else waits
    // for the catalog sync below: links may have changed meanwhile (catalog_pending keeps the store
    // out of syncing until then, and the sync enqueues its items when it finishes).
    const { rows } = await client.query<{ id: number }>(
      'SELECT DISTINCT pool_level_id AS id FROM pending_writes WHERE store_id = $1',
      [storeId],
    );
    await enqueuePoolLevels(
      client,
      rows.map((r) => r.id),
      'store_recovered',
    );
    await enqueueTask(client, 'ensure_webhooks', { storeId });
    await enqueueTask(client, 'catalog_sync', { storeId });
    return true;
  });
  if (reactivated) logger.info({ storeId, shop: check.shopName }, 'store is reachable again');
  return check;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
