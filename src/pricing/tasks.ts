import { z } from 'zod';
import type { FeatureTasks } from '../tasks/types.js';
import { positiveId } from '../tasks/types.js';
import type { PricingTaskPayloads } from './task-types.js';

export const PRICING_TASKS: FeatureTasks<PricingTaskPayloads> = {
  schemas: {
    apply_prices: z.object({ runId: positiveId, storeId: positiveId }),
  },
  handlers: {
    apply_prices: async () => {
      throw new Error('not implemented');
    },
  },
};
