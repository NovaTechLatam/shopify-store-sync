import { z } from 'zod';
import type { FeatureTasks } from '../tasks/types.js';
import { forStore, positiveId } from '../tasks/types.js';
import { pushItemCosts } from './costs.js';
import { runReorderCheck } from './reorder.js';
import type { PurchasingTaskPayloads } from './task-types.js';

export const PURCHASING_TASKS: FeatureTasks<PurchasingTaskPayloads> = {
  schemas: {
    reorder_check: z.object({}),
    push_item_costs: z.object({
      storeId: positiveId,
      itemIds: z.array(positiveId).max(10_000),
    }),
  },
  handlers: {
    reorder_check: async (deps) => {
      const result = await runReorderCheck(deps.db);
      deps.logger.debug(result, 'reorder alerts checked');
    },
    push_item_costs: forStore(async (deps, { storeId, itemIds }) => {
      await pushItemCosts(deps, storeId, itemIds);
    }),
  },
};
