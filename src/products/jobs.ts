import type { FeatureHousekeepingStep, FeatureJob } from '../scheduler-types.js';
import { pruneUnusedImages } from './media.js';

// Publishing runs as tasks queued from the dashboard; nothing to do on a timer.
export const CATALOG_JOBS: FeatureJob[] = [];

export const CATALOG_HOUSEKEEPING: FeatureHousekeepingStep[] = [
  [
    'catalog: unused uploaded images',
    async ({ db, logger }) => {
      const deleted = await pruneUnusedImages(db);
      if (deleted) logger.info({ deleted }, 'unused catalog images deleted');
    },
  ],
];
