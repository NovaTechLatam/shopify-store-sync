import { z } from 'zod';
import type { FeatureTasks } from '../tasks/types.js';
import { positiveId } from '../tasks/types.js';
import type { PurchasingTaskPayloads } from './task-types.js';

const notImplemented = async () => {
  throw new Error('not implemented');
};

export const PURCHASING_TASKS: FeatureTasks<PurchasingTaskPayloads> = {
  schemas: {
    reorder_check: z.object({}),
    push_item_costs: z.object({ storeId: positiveId, itemIds: z.array(positiveId) }),
  },
  handlers: {
    reorder_check: notImplemented,
    push_item_costs: notImplemented,
  },
};
