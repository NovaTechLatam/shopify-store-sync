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

export const PRICING_HOUSEKEEPING: FeatureHousekeepingStep[] = [
  // A run whose last open store was deleted (its row went with it) would show as running forever.
  [
    'finish orphaned price runs',
    async ({ db }) => {
      await db.query(
        `UPDATE price_runs r
            SET status = CASE WHEN EXISTS (SELECT 1 FROM price_run_stores
                                            WHERE run_id = r.id AND status = 'failed')
                              THEN 'failed' ELSE 'done' END,
                finished_at = now()
          WHERE r.status IN ('queued', 'running') AND r.created_at < now() - interval '5 minutes'
            AND NOT EXISTS (SELECT 1 FROM price_run_stores
                             WHERE run_id = r.id AND status IN ('queued', 'running'))`,
      );
    },
  ],
];
