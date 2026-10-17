import type { Db, DbClient, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';

/**
 * The sync queue holds at most one row per pool level. Webhooks and scans "mark the pool level
 * dirty" by upserting its row; any number of notifications collapse into one reconcile, which
 * always reads live values, so nothing is lost by coalescing.
 *
 * A worker claims rows with a lease (unique token + expiry). The token doubles as a fencing
 * token: every database write the engine makes is guarded by "the lease is still mine", so a
 * worker that stalled past its lease can't clobber the work of the worker that took over.
 */

export interface ClaimedLevel {
  poolLevelId: number;
  leaseToken: string;
  generation: number;
  attempts: number;
}

export class LeaseLostError extends Error {
  constructor(poolLevelId: number) {
    super(`Lease on pool level ${poolLevelId} was lost`);
    this.name = 'LeaseLostError';
  }
}

export async function enqueuePoolLevels(
  db: Queryable,
  poolLevelIds: number[],
  reason: string,
  delayMs = 0,
): Promise<void> {
  if (poolLevelIds.length === 0) return;
  await db.query(
    `INSERT INTO sync_queue (pool_level_id, reason, run_after)
     SELECT DISTINCT unnest($1::bigint[]), $2, now() + make_interval(secs => $3::double precision / 1000)
     ON CONFLICT (pool_level_id) DO UPDATE
       SET generation = sync_queue.generation + 1,
           reason = EXCLUDED.reason,
           run_after = LEAST(sync_queue.run_after, EXCLUDED.run_after)`,
    [poolLevelIds, reason, delayMs],
  );
}

export async function claimPoolLevels(
  db: Queryable,
  limit: number,
  leaseMs: number,
): Promise<ClaimedLevel[]> {
  const { rows } = await db.query<{
    pool_level_id: number;
    lease_token: string;
    generation: number;
    attempts: number;
  }>(
    `UPDATE sync_queue q
        SET lease_token = gen_random_uuid(),
            leased_until = now() + make_interval(secs => $2::double precision / 1000),
            attempts = q.attempts + 1
      WHERE q.pool_level_id IN (
        SELECT pool_level_id FROM sync_queue
         WHERE run_after <= now() AND (leased_until IS NULL OR leased_until < now())
         ORDER BY run_after
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING q.pool_level_id, q.lease_token, q.generation, q.attempts`,
    [limit, leaseMs],
  );
  return rows.map((r) => ({
    poolLevelId: r.pool_level_id,
    leaseToken: r.lease_token,
    generation: r.generation,
    attempts: r.attempts,
  }));
}

/**
 * Finishes a claim. If nothing was enqueued while we worked, the row is deleted; otherwise it is
 * released to run again right away (new information arrived mid-reconcile).
 */
export async function completeClaim(db: Queryable, claim: ClaimedLevel): Promise<void> {
  const deleted = await db.query(
    'DELETE FROM sync_queue WHERE pool_level_id = $1 AND lease_token = $2 AND generation = $3',
    [claim.poolLevelId, claim.leaseToken, claim.generation],
  );
  if (deleted.rowCount === 0) {
    await db.query(
      `UPDATE sync_queue SET lease_token = NULL, leased_until = NULL, attempts = 0, last_error = NULL,
              run_after = now()
        WHERE pool_level_id = $1 AND lease_token = $2`,
      [claim.poolLevelId, claim.leaseToken],
    );
  }
}

/** Releases a claim to be retried after `delayMs`. */
export async function retryClaim(
  db: Queryable,
  claim: ClaimedLevel,
  delayMs: number,
  error?: string,
): Promise<void> {
  await db.query(
    `UPDATE sync_queue
        SET lease_token = NULL, leased_until = NULL, last_error = $3,
            run_after = now() + make_interval(secs => $4::double precision / 1000)
      WHERE pool_level_id = $1 AND lease_token = $2`,
    [claim.poolLevelId, claim.leaseToken, error ?? null, delayMs],
  );
}

/** Runs `fn` in a transaction that first verifies (and row-locks) our lease. */
export async function withLease<T>(
  db: Db,
  poolLevelId: number,
  leaseToken: string,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (client) => {
    const { rowCount } = await client.query(
      'SELECT 1 FROM sync_queue WHERE pool_level_id = $1 AND lease_token = $2 FOR UPDATE',
      [poolLevelId, leaseToken],
    );
    if (rowCount === 0) throw new LeaseLostError(poolLevelId);
    return fn(client);
  });
}

/** Exponential backoff for failed reconciles: 5s, 10s, 20s ... capped at 10 minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.min(10 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}
