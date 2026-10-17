import type { Logger } from 'pino';
import { z } from 'zod';
import { setAlert } from '../alerts/alerts.js';
import type { CatalogDeps } from '../catalog/catalog.js';
import {
  refreshInventoryItem,
  removeInventoryItem,
  removeProduct,
  syncStoreCatalog,
  syncStoreLocations,
} from '../catalog/catalog.js';
import type { Db } from '../db/pool.js';
import { driftScan } from '../sync/drift.js';
import type { ShopifyRegistry } from '../sync/engine.js';
import { checkStoreHealth } from '../sync/health.js';
import { ensureWebhooks } from '../webhooks/subscriptions.js';
import { webhookUrl } from '../webhooks/topics.js';
import type { TaskKind, TaskPayloads } from './queue.js';
import { enqueueTask } from './queue.js';

export interface TaskDeps {
  db: Db;
  shopify: ShopifyRegistry;
  logger: Logger;
  /** Public base URL of this service; webhook subscriptions point at it. */
  publicUrl: string;
  fetchFn?: typeof fetch;
}

export type TaskHandler<K extends TaskKind> = (
  deps: TaskDeps,
  payload: TaskPayloads[K],
) => Promise<void>;

/** Statuses in which a store takes no background work (until the merchant changes it). */
const IDLE_STATUSES = new Set(['paused', 'disconnected']);

const storeId = z.number().int().positive();
const gid = z.string().regex(/^gid:\/\/shopify\/\w+\/\S+$/);

/** Task payloads are stored as JSON and may come from an older or newer release: check them. */
export const TASK_PAYLOAD_SCHEMAS: { [K in TaskKind]: z.ZodType<TaskPayloads[K]> } = {
  catalog_sync: z.object({ storeId }),
  sync_locations: z.object({ storeId }),
  refresh_inventory_item: z.object({ storeId, inventoryItemId: gid }),
  remove_inventory_item: z.object({ storeId, inventoryItemId: gid }),
  remove_product: z.object({ storeId, productId: gid }),
  ensure_webhooks: z.object({ storeId }),
  drift_scan: z.object({ storeId }),
  store_health: z.object({ storeId }),
};

export const TASK_HANDLERS: { [K in TaskKind]: TaskHandler<K> } = {
  catalog_sync: forStore(async (deps, { storeId }) => {
    await syncStoreCatalog(catalogDeps(deps), storeId);
  }),
  sync_locations: forStore(async (deps, { storeId }) => {
    await syncStoreLocations(catalogDeps(deps), storeId);
  }),
  refresh_inventory_item: forStore((deps, { storeId, inventoryItemId }) =>
    refreshInventoryItem(catalogDeps(deps), storeId, inventoryItemId),
  ),
  remove_inventory_item: forStore((deps, { storeId, inventoryItemId }) =>
    removeInventoryItem(deps.db, storeId, inventoryItemId),
  ),
  remove_product: forStore((deps, { storeId, productId }) =>
    removeProduct(deps.db, storeId, productId),
  ),
  ensure_webhooks: forStore((deps, { storeId }, store) => registerWebhooks(deps, storeId, store)),
  drift_scan: forStore(async (deps, { storeId }) => {
    await driftScan(deps, storeId);
  }),
  store_health: forStore(async (deps, { storeId }) => {
    await checkStoreHealth(deps, storeId);
  }),
};

interface StoreRow {
  name: string;
  status: string;
  webhooks_registered_at: Date | null;
}

/** Runs the handler only if the store still exists and is not paused or disconnected. */
function forStore<K extends TaskKind>(
  handler: (deps: TaskDeps, payload: TaskPayloads[K], store: StoreRow) => Promise<void>,
): TaskHandler<K> {
  return async (deps, payload) => {
    const { rows } = await deps.db.query<StoreRow>(
      'SELECT name, status, webhooks_registered_at FROM stores WHERE id = $1',
      [payload.storeId],
    );
    const store = rows[0];
    if (!store || IDLE_STATUSES.has(store.status)) {
      deps.logger.debug(
        { storeId: payload.storeId, status: store?.status ?? 'deleted' },
        'skipping task for inactive store',
      );
      return;
    }
    await handler(deps, payload, store);
  };
}

function catalogDeps(deps: TaskDeps): CatalogDeps {
  return { db: deps.db, shopify: deps.shopify, logger: deps.logger };
}

async function registerWebhooks(deps: TaskDeps, storeId: number, store: StoreRow): Promise<void> {
  const admin = await deps.shopify.forStore(storeId);
  const { created, deleted } = await ensureWebhooks(admin, webhookUrl(deps.publicUrl));
  await deps.db.query(
    'UPDATE stores SET webhooks_registered_at = now(), updated_at = now() WHERE id = $1',
    [storeId],
  );
  if (created.length || deleted.length)
    deps.logger.info({ storeId, created, deleted }, 'webhook subscriptions updated');
  // Shopify deletes subscriptions after repeated delivery failures: changes may have been missed.
  if (created.length && store.webhooks_registered_at) {
    await setAlert(deps.db, {
      open: true,
      kind: 'webhooks_recreated',
      dedupeKey: `webhooks_recreated:${storeId}`,
      storeId,
      message:
        `Shopify had stopped sending stock updates for ${store.name} (${created.length} webhook ` +
        `subscription${created.length === 1 ? ' was' : 's were'} missing, usually after this service ` +
        `was unreachable for a while). They have been re-created and a full stock check is running.`,
      details: { created },
    });
    await enqueueTask(deps.db, 'drift_scan', { storeId });
  }
}
