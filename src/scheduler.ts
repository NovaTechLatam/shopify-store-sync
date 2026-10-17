import type { Logger } from 'pino';
import { dispatchAlerts } from './alerts/notifier.js';
import type { Db } from './db/pool.js';
import { PRICING_HOUSEKEEPING, PRICING_JOBS } from './pricing/jobs.js';
import { CATALOG_HOUSEKEEPING, CATALOG_JOBS } from './products/jobs.js';
import { PURCHASING_HOUSEKEEPING, PURCHASING_JOBS } from './purchasing/jobs.js';
import { SALES_HOUSEKEEPING, SALES_JOBS } from './sales/jobs.js';
import type { FeatureHousekeepingStep, FeatureJob } from './scheduler-types.js';
import { getSettings } from './settings.js';
import type { TaskKind } from './tasks/queue.js';
import { enqueueTask } from './tasks/queue.js';

/** Recurring work of the features (src/<feature>/jobs.ts). */
export const FEATURE_JOBS: FeatureJob[] = [
  ...CATALOG_JOBS,
  ...PRICING_JOBS,
  ...SALES_JOBS,
  ...PURCHASING_JOBS,
];
export const FEATURE_HOUSEKEEPING: FeatureHousekeepingStep[] = [
  ...CATALOG_HOUSEKEEPING,
  ...PRICING_HOUSEKEEPING,
  ...SALES_HOUSEKEEPING,
  ...PURCHASING_HOUSEKEEPING,
];

export interface SchedulerOptions {
  db: Db;
  logger: Logger;
  /** Drift scan of every active store. */
  driftIntervalMs: number;
  /** Full catalog re-read of every active store. */
  catalogIntervalMs: number;
  /** Webhook subscription check of every active store. Default 15 minutes. */
  webhookCheckIntervalMs?: number;
  /** Re-test of stores in `error`. Default 5 minutes. */
  healthIntervalMs?: number;
  /** Alert delivery and clean-up. Default 1 minute. */
  housekeepingIntervalMs?: number;
  /** Called after tasks were enqueued (wakes the task runner). */
  onWork?: () => void;
  /** Used to deliver alerts. */
  fetchFn?: typeof fetch;
  /** Default FEATURE_JOBS; tests pass their own. */
  featureJobs?: FeatureJob[];
  /** Default FEATURE_HOUSEKEEPING; tests pass their own. */
  featureHousekeeping?: FeatureHousekeepingStep[];
}

/**
 * Per-store schedules are due when the store's own timestamp (last drift scan, catalog sync,
 * webhook check) is older than the interval, so restarts and extra instances don't add runs.
 * They are checked this often.
 */
const DUE_CHECK_MS = 60_000;
/** First runs after start() are spread over this window. */
const STARTUP_SPREAD_MS = 5_000;
/** Rows deleted per clean-up run, so a big backlog never becomes one long transaction. */
const PRUNE_BATCH = 10_000;
/** Alerts whose dedupe key is `<kind>:<pool level id>`; they outlive a deleted warehouse. */
const POOL_LEVEL_ALERT_KINDS = ['low_stock', 'oversold', 'possible_double_count'];

type StoreTaskKind = Extract<TaskKind, 'drift_scan' | 'catalog_sync' | 'ensure_webhooks'>;

const LAST_RUN_COLUMN: Record<StoreTaskKind, string> = {
  drift_scan: 'last_drift_scan_at',
  catalog_sync: 'catalog_synced_at',
  ensure_webhooks: 'webhooks_registered_at',
};

interface Job {
  name: string;
  everyMs: number;
  run(now: number): Promise<void>;
  nextAt: number;
  running: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * Periodic work: queues drift scans, catalog syncs, webhook checks and health checks as background
 * tasks, delivers alerts and prunes old rows. Each job runs on its own timer and never overlaps
 * itself; failures are logged and the job simply runs again next time.
 */
export class Scheduler {
  private readonly jobs: Job[];
  private started = false;
  /** Bumped by start() so timers from an earlier start() don't keep rescheduling. */
  private generation = 0;

  constructor(private readonly opts: SchedulerOptions) {
    const job = (name: string, everyMs: number, run: (now: number) => Promise<void>): Job => ({
      name,
      everyMs,
      run,
      nextAt: 0,
      running: false,
    });
    const storeJob = (kind: StoreTaskKind, intervalMs: number) =>
      job(kind, Math.min(intervalMs, DUE_CHECK_MS), (now) =>
        this.enqueueDue(kind, intervalMs, now),
      );
    this.jobs = [
      storeJob('drift_scan', opts.driftIntervalMs),
      storeJob('catalog_sync', opts.catalogIntervalMs),
      storeJob('ensure_webhooks', opts.webhookCheckIntervalMs ?? 15 * 60_000),
      job('store_health', opts.healthIntervalMs ?? 5 * 60_000, () => this.enqueueHealthChecks()),
      job('housekeeping', opts.housekeepingIntervalMs ?? 60_000, (now) => this.housekeeping(now)),
      ...(opts.featureJobs ?? FEATURE_JOBS).map((feature) =>
        job(feature.name, feature.everyMs, (now) => feature.run(this.context(now))),
      ),
    ];
  }

  private context(now: number) {
    return { db: this.opts.db, logger: this.opts.logger, onWork: this.opts.onWork, now };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    for (const job of this.jobs) this.schedule(job, Math.random() * STARTUP_SPREAD_MS, generation);
  }

  /** Stops scheduling; a job that is running finishes on its own. */
  stop(): void {
    this.started = false;
    for (const job of this.jobs) clearTimeout(job.timer);
  }

  /** Runs every job that is due at `now` and not already running. */
  async tick(now = Date.now()): Promise<void> {
    await Promise.all(this.jobs.filter((j) => now >= j.nextAt).map((j) => this.runJob(j, now)));
  }

  private schedule(job: Job, delayMs: number, generation: number): void {
    job.timer = setTimeout(() => {
      void this.runJob(job, Date.now()).then(() => {
        if (!this.started || generation !== this.generation) return;
        // Small jitter so instances and jobs drift apart instead of hitting the database together.
        this.schedule(job, job.everyMs * (1 + Math.random() * 0.05), generation);
      });
    }, delayMs);
  }

  private async runJob(job: Job, now: number): Promise<void> {
    if (job.running) return;
    job.running = true;
    job.nextAt = now + job.everyMs;
    try {
      await job.run(now);
    } catch (err) {
      this.opts.logger.error({ err, job: job.name }, 'scheduled job failed');
    } finally {
      job.running = false;
    }
  }

  /** Queues `kind` for every active store whose last run is older than `intervalMs`. */
  private async enqueueDue(kind: StoreTaskKind, intervalMs: number, now: number): Promise<void> {
    const column = LAST_RUN_COLUMN[kind];
    // A store that already has this task queued (maybe retrying) is left alone: re-queuing would
    // cancel its backoff, or make a running task run twice.
    const { rows } = await this.opts.db.query<{ id: number }>(
      `SELECT s.id FROM stores s
        WHERE s.status = 'active' AND (s.${column} IS NULL OR s.${column} <= $1)
          AND NOT EXISTS (SELECT 1 FROM tasks t
                           WHERE t.kind = $2 AND t.payload->>'storeId' = s.id::text)
        ORDER BY s.id`,
      [new Date(now - intervalMs), kind],
    );
    await this.enqueueForStores(
      kind,
      rows.map((r) => r.id),
    );
  }

  private async enqueueHealthChecks(): Promise<void> {
    const { rows } = await this.opts.db.query<{ id: number }>(
      `SELECT id FROM stores WHERE status = 'error' ORDER BY id`,
    );
    await this.enqueueForStores(
      'store_health',
      rows.map((r) => r.id),
    );
  }

  private async enqueueForStores(kind: TaskKind, storeIds: number[]): Promise<void> {
    if (storeIds.length === 0) return;
    for (const storeId of storeIds) await enqueueTask(this.opts.db, kind, { storeId });
    this.opts.logger.debug({ kind, storeIds }, 'scheduled tasks queued');
    this.opts.onWork?.();
  }

  private async housekeeping(now: number): Promise<void> {
    const { db, logger, fetchFn } = this.opts;
    const steps: [string, () => Promise<unknown>][] = [
      [
        'resolve alerts of deleted pool levels',
        () =>
          db.query(
            `UPDATE alerts a SET resolved_at = now()
              WHERE a.resolved_at IS NULL AND a.kind = ANY($1::text[])
                AND a.dedupe_key ~ '^[a-z_]+:[0-9]+$'
                AND NOT EXISTS (SELECT 1 FROM pool_levels pl
                                 WHERE pl.id = split_part(a.dedupe_key, ':', 2)::bigint)`,
            [POOL_LEVEL_ALERT_KINDS],
          ),
      ],
      [
        'prune webhook log',
        () =>
          db.query(
            `DELETE FROM webhook_events WHERE event_id IN (
               SELECT event_id FROM webhook_events WHERE received_at < now() - interval '7 days' LIMIT $1)`,
            [PRUNE_BATCH],
          ),
      ],
      [
        'prune activity log',
        async () => {
          const { eventRetentionDays } = await getSettings(db);
          await db.query(
            `DELETE FROM inventory_events WHERE id IN (
               SELECT id FROM inventory_events
                WHERE created_at < now() - make_interval(days => $1) LIMIT $2)`,
            [eventRetentionDays, PRUNE_BATCH],
          );
        },
      ],
      [
        'prune circuit breaker hits',
        () =>
          db.query(`DELETE FROM circuit_breaker_hits WHERE created_at < now() - interval '1 day'`),
      ],
      ...(this.opts.featureHousekeeping ?? FEATURE_HOUSEKEEPING).map(
        ([name, run]): [string, () => Promise<unknown>] => [name, () => run(this.context(now))],
      ),
      // Last, so alerts raised by the steps above go out in this run.
      ['deliver alerts', () => dispatchAlerts({ db, logger, fetchFn })],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (err) {
        logger.error({ err, step: name }, 'housekeeping step failed');
      }
    }
  }
}
