import type { Logger } from 'pino';
import type { Db } from '../db/pool.js';
import { getSettings } from '../settings.js';
import { WorkLoop } from '../util/work-loop.js';
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
      await retryClaim(db, claim, retryDelay(outcome.delayMs, claim.attempts), outcome.reason);
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

function retryDelay(requestedMs: number | undefined, attempts: number): number {
  if (requestedMs === undefined) return retryDelayMs(attempts);
  // The store keeps changing under our writes: stop hammering it, back off from 5s again.
  if (requestedMs === 0 && attempts > MAX_IMMEDIATE_RETRIES)
    return retryDelayMs(attempts - MAX_IMMEDIATE_RETRIES);
  return requestedMs;
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

/**
 * Background loop: keeps `concurrency` reconciles in flight while there is work, claiming another
 * pool level as soon as one finishes. Claims nothing while sync is paused (checked at most once
 * per second); reconciles already running finish normally.
 */
export class SyncWorker {
  private readonly loop: WorkLoop<ClaimedLevel>;

  constructor(opts: SyncWorkerOptions) {
    const { db, engine, logger } = opts;
    this.loop = new WorkLoop({
      name: 'sync worker',
      concurrency: opts.concurrency,
      idleMs: opts.idleMs ?? 1000,
      logger,
      claim: (limit) => claimPoolLevels(db, limit, LEASE_MS),
      run: async (claim) => {
        await processClaim(db, engine, claim, logger);
      },
      isPaused: () => isSyncPaused(db),
    });
  }

  start(): void {
    this.loop.start();
  }

  /** Wakes the loop early (e.g. right after a webhook was enqueued). */
  nudge(): void {
    this.loop.nudge();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }
}
