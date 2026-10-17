import { z } from 'zod';
import type { FeatureTasks } from '../tasks/types.js';
import { positiveId } from '../tasks/types.js';
import type { CatalogTaskPayloads } from './task-types.js';

export const CATALOG_TASKS: FeatureTasks<CatalogTaskPayloads> = {
  schemas: {
    publish_product: z.object({ masterProductId: positiveId, storeId: positiveId }),
  },
  handlers: {
    publish_product: async () => {
      throw new Error('not implemented');
    },
  },
};
