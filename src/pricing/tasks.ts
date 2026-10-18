import { z } from 'zod';
import type { FeatureTasks } from '../tasks/types.js';
import { positiveId } from '../tasks/types.js';
import { applyPrices } from './runs.js';
import { runSchedule } from './schedules.js';
import type { PricingTaskPayloads } from './task-types.js';

export const PRICING_TASKS: FeatureTasks<PricingTaskPayloads> = {
  schemas: {
    apply_prices: z.object({ runId: positiveId, storeId: positiveId }),
    price_schedule: z.object({ scheduleId: positiveId }),
  },
  handlers: {
    // Not wrapped in forStore: a paused store must still end its part of the run (as failed,
    // saying why) instead of leaving it queued.
    apply_prices: (deps, payload) => applyPrices(deps, payload),
    price_schedule: (deps, { scheduleId }) => runSchedule(deps, scheduleId),
  },
};
