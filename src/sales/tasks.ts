import { z } from 'zod';
import type { FeatureTasks } from '../tasks/types.js';
import { positiveId, shopifyGid } from '../tasks/types.js';
import type { SalesTaskPayloads } from './task-types.js';

const notImplemented = async () => {
  throw new Error('not implemented');
};

export const SALES_TASKS: FeatureTasks<SalesTaskPayloads> = {
  schemas: {
    refresh_order: z.object({ storeId: positiveId, orderId: shopifyGid }),
    remove_order: z.object({ storeId: positiveId, orderId: shopifyGid }),
    sync_orders: z.object({ storeId: positiveId }),
    sales_backfill: z.object({ storeId: positiveId }),
  },
  handlers: {
    refresh_order: notImplemented,
    remove_order: notImplemented,
    sync_orders: notImplemented,
    sales_backfill: notImplemented,
  },
};
