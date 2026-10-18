import type { FeatureHousekeepingStep, FeatureJob } from '../scheduler-types.js';
import { enqueueTask } from '../tasks/queue.js';

/** How often reorder alerts are re-checked (sales and stock change all the time). */
export const REORDER_CHECK_EVERY_MS = 60 * 60_000;

export const PURCHASING_JOBS: FeatureJob[] = [
  {
    // A single de-duplicated task: several instances asking at once still run it once. Receipts,
    // order changes and reorder settings also ask for it, so this hourly run only catches up on
    // sales.
    name: 'reorder_check',
    everyMs: REORDER_CHECK_EVERY_MS,
    run: async ({ db, onWork }) => {
      await enqueueTask(db, 'reorder_check', {});
      onWork?.();
    },
  },
];

export const PURCHASING_HOUSEKEEPING: FeatureHousekeepingStep[] = [];
