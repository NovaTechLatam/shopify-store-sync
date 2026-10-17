import type { Logger } from 'pino';
import type { Db } from './db/pool.js';

/** What a feature's scheduled job or housekeeping step gets on each run. */
export interface FeatureJobContext {
  db: Db;
  logger: Logger;
  /** Call after enqueueing tasks, to wake the task runner. */
  onWork?: () => void;
  /** The scheduler's clock (ms), for "due" checks; tests move it forward. */
  now: number;
}

/**
 * Recurring work of a feature, run by the scheduler like its own jobs: on its own timer with a
 * little jitter, never overlapping itself, failures logged. Every instance runs a scheduler, so a
 * job must be safe to run on several at once: claim rows (FOR UPDATE SKIP LOCKED) or enqueue
 * de-duplicated tasks, and keep "last done" times in the database, not in memory.
 */
export interface FeatureJob {
  name: string;
  everyMs: number;
  run(ctx: FeatureJobContext): Promise<void>;
}

/** A step added to the scheduler's housekeeping run (every minute), before alerts are delivered. */
export type FeatureHousekeepingStep = [
  name: string,
  run: (ctx: FeatureJobContext) => Promise<void>,
];
