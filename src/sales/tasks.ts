import { z } from 'zod';
import type { FeatureTasks } from '../tasks/types.js';
import { forStore, positiveId, shopifyGid } from '../tasks/types.js';
import { deleteOrder, refreshOrder, runSalesBackfill, syncOrders } from './sync.js';
import type { SalesTaskPayloads } from './task-types.js';

// Paused and disconnected stores are skipped (forStore): their tasks run again once the store is
// active (the scheduler re-queues the sync and the history import).
export const SALES_TASKS: FeatureTasks<SalesTaskPayloads> = {
  schemas: {
    refresh_order: z.object({ storeId: positiveId, orderId: shopifyGid }),
    remove_order: z.object({ storeId: positiveId, orderId: shopifyGid }),
    sync_orders: z.object({ storeId: positiveId }),
    sales_backfill: z.object({ storeId: positiveId, poll: z.boolean().optional() }),
  },
  handlers: {
    refresh_order: forStore((deps, { storeId, orderId }) => refreshOrder(deps, storeId, orderId)),
    // DB only: a deletion is recorded even while the store is paused.
    remove_order: (deps, { storeId, orderId }) => deleteOrder(deps, storeId, orderId),
    sync_orders: forStore((deps, { storeId }) => syncOrders(deps, storeId)),
    sales_backfill: forStore((deps, { storeId, poll }) =>
      runSalesBackfill(deps, storeId, { poll: poll ?? false }),
    ),
  },
};
