import { withTransaction } from '../db/pool.js';
import type { FeatureHousekeepingStep, FeatureJob } from '../scheduler-types.js';
import { enqueueTask } from '../tasks/queue.js';
import { dueScheduleIds } from './schedules.js';

export const PRICING_JOBS: FeatureJob[] = [
  {
    // Sales and price changes start and end within a minute of their time. Due rows are claimed
    // (FOR UPDATE SKIP LOCKED) while their task is queued, so instances running this at the same
    // moment queue each once; the task itself re-checks under a row lock.
    name: 'price_schedules',
    everyMs: 60_000,
    async run({ db, logger, onWork }) {
      const ids = await withTransaction(db, async (client) => {
        const due = await dueScheduleIds(client);
        for (const scheduleId of due) await enqueueTask(client, 'price_schedule', { scheduleId });
        return due;
      });
      if (ids.length === 0) return;
      logger.debug({ scheduleIds: ids }, 'price schedules due');
      onWork?.();
    },
  },
];

export const PRICING_HOUSEKEEPING: FeatureHousekeepingStep[] = [];
