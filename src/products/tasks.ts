import { z } from 'zod';
import type { FeatureTasks } from '../tasks/types.js';
import { positiveId } from '../tasks/types.js';
import { publishProductTask } from './publish.js';
import type { CatalogTaskPayloads } from './task-types.js';

export const CATALOG_TASKS: FeatureTasks<CatalogTaskPayloads> = {
  schemas: {
    publish_product: z.object({ masterProductId: positiveId, storeId: positiveId }),
  },
  handlers: {
    // Not wrapped in forStore: a paused store must end as "failed" (with the reason) on the
    // product, not stay queued forever.
    publish_product: (deps, { masterProductId, storeId }) =>
      publishProductTask(deps, masterProductId, storeId),
  },
};
