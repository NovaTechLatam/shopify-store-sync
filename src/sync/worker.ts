import type { Logger } from 'pino';
import type { Db } from '../db/pool.js';
import { getSettings } from '../settings.js';
import type { ReconcileOutcome, SyncEngine } from './engine.js';
import type { ClaimedLevel } from './queue.js';
import {
  LeaseLostError,
  claimPoolLevels,
  completeClaim,
  retryClaim,
  retryDelayMs,
} from './queue.js';

/** Long enough for a reconcile that waits out Shopify rate limits; expired leases are re-claimed. */
export const LEASE_MS = 5 * 60_000;
/** After this many immediate retries in a row (stale writes), fall back to backoff. */
const MAX_IMMEDIATE_RETRIES = 5;

export async function isSyncPaused(db: Db): Promise<boolean> {
  return (await getSettings(db)).syncPaused;
}

/** Reconciles one claimed pool level and settles its queue row. Never throws. */
export async function processClaim(
  db: Db,
  engine: SyncEngine,
  claim: ClaimedLevel,
  logger: Logger,
): Promise<ReconcileOutcome | 'lease_lost' | 'error'> {
  try {
    const outcome = await engine.reconcile(claim);
    if (outcome.status === 'retry') {
      const immediate = outcome.delayMs === 0 && claim.attempts <= MAX_IMMEDIATE_RETRIES;
      const delay = immediate ? 0 : (outcome.delayMs ?? retryDelayMs(claim.attempts));
      await retryClaim(db, claim, delay, outcome.reason);
    } else {
      await completeClaim(db, claim);
    }
    return outcome;
  } catch (err) {
    if (err instanceof LeaseLostError) {
      logger.warn(
        { poolLevelId: claim.poolLevelId },
        'lease lost mid-reconcile; another worker took over',
      );
      return 'lease_lost';
    }
    logger.error({ err, poolLevelId: claim.poolLevelId }, 'reconcile failed');
    await retryClaim(db, claim, retryDelayMs(claim.attempts), (err as Error).message).catch(
      (e: unknown) => logger.error({ err: e }, 'failed to release claim'),
    );
    return 'error';
  }
}

/**
 * Claims and processes dirty pool levels until the queue has nothing ready. Returns how many
 * were processed. Used by the worker loop and by tests.
 */
export async function drainQueue(
  db: Db,
  engine: SyncEngine,
  logger: Logger,
  opts: { concurrency?: number; maxRounds?: number } = {},
): Promise<number> {
  const concurrency = opts.concurrency ?? 4;
  let processed = 0;
  for (let round = 0; round < (opts.maxRounds ?? Infinity); round++) {
    const claims = await claimPoolLevels(db, concurrency, LEASE_MS);
    if (claims.length === 0) break;
    await Promise.all(claims.map((c) => processClaim(db, engine, c, logger)));
    processed += claims.length;
  }
  return processed;
}

export interface SyncWorkerOptions {
  db: Db;
  engine: SyncEngine;
  logger: Logger;
  concurrency: number;
  /** Poll interval when the queue is empty. */
  idleMs?: number;
}

/** Background loop: keeps `concurrency` reconciles in flight while there is work. */
export class SyncWorker {
  private running = false;
  private stopped?: Promise<void>;
  private wake?: () => void;

  constructor(private readonly opts: SyncWorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = this.loop();
  }

  /** Wakes the loop early (e.g. right after a webhook was enqueued). */
  nudge(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.stopped;
  }

  private async loop(): Promise<void> {
    const { db, engine, logger, concurrency } = this.opts;
    const idleMs = this.opts.idleMs ?? 1000;
    while (this.running) {
      let worked = 0;
      try {
        if (!(await isSyncPaused(db)))
          worked = await drainQueue(db, engine, logger, { concurrency, maxRounds: 1 });
      } catch (err) {
        logger.error({ err }, 'sync worker iteration failed');
      }
      if (worked === 0 && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, idleMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }
}
