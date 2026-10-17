import { z } from 'zod';
import type { CatalogDeps } from '../catalog/catalog.js';
import {
  refreshInventoryItem,
  removeInventoryItem,
  removeProduct,
  syncStoreCatalog,
  syncStoreLocations,
} from '../catalog/catalog.js';
import { CATALOG_TASKS } from '../products/tasks.js';
import { PRICING_TASKS } from '../pricing/tasks.js';
import { PURCHASING_TASKS } from '../purchasing/tasks.js';
import { SALES_TASKS } from '../sales/tasks.js';
import { driftScan } from '../sync/drift.js';
import { checkStoreHealth } from '../sync/health.js';
import { registerStoreWebhooks } from '../webhooks/register.js';
import type { CoreTaskPayloads, TaskKind, TaskPayloads } from './queue.js';
import type { TaskDeps, TaskHandler } from './types.js';
import { forStore, positiveId as storeId, shopifyGid as gid } from './types.js';

// Moved to ./types.js so feature modules can use them without importing this registry.
export type { TaskDeps, TaskHandler } from './types.js';
export { forStore } from './types.js';

/** Task payloads are stored as JSON and may come from an older or newer release: check them. */
const CORE_SCHEMAS: { [K in keyof CoreTaskPayloads]: z.ZodType<CoreTaskPayloads[K]> } = {
  catalog_sync: z.object({ storeId }),
  sync_locations: z.object({ storeId }),
  refresh_inventory_item: z.object({ storeId, inventoryItemId: gid }),
  remove_inventory_item: z.object({ storeId, inventoryItemId: gid }),
  remove_product: z.object({ storeId, productId: gid }),
  ensure_webhooks: z.object({ storeId }),
  drift_scan: z.object({ storeId }),
  store_health: z.object({ storeId }),
};

const CORE_HANDLERS: { [K in keyof CoreTaskPayloads]: TaskHandler<K> } = {
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
  ensure_webhooks: forStore(async (deps, { storeId }) => {
    await registerStoreWebhooks(deps, storeId);
  }),
  drift_scan: forStore(async (deps, { storeId }) => {
    await driftScan(deps, storeId);
  }),
  store_health: forStore(async (deps, { storeId }) => {
    await checkStoreHealth(deps, storeId);
  }),
};

// Features register their task kinds in their own modules (src/<feature>/tasks.ts).
export const TASK_PAYLOAD_SCHEMAS: { [K in TaskKind]: z.ZodType<TaskPayloads[K]> } = {
  ...CORE_SCHEMAS,
  ...CATALOG_TASKS.schemas,
  ...PRICING_TASKS.schemas,
  ...SALES_TASKS.schemas,
  ...PURCHASING_TASKS.schemas,
};

export const TASK_HANDLERS: { [K in TaskKind]: TaskHandler<K> } = {
  ...CORE_HANDLERS,
  ...CATALOG_TASKS.handlers,
  ...PRICING_TASKS.handlers,
  ...SALES_TASKS.handlers,
  ...PURCHASING_TASKS.handlers,
};

function catalogDeps(deps: TaskDeps): CatalogDeps {
  return { db: deps.db, shopify: deps.shopify, logger: deps.logger };
}
