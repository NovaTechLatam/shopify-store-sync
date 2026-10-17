import type { Queryable } from '../db/pool.js';

/**
 * Background tasks other than reconciling pool levels. Each task has a de-duplication key, so
 * asking for the same work many times (e.g. 50 webhooks for one product) runs it once; asking
 * while it runs makes it run once more afterwards.
 */
export type TaskPayloads = {
  /** Full re-read of a store's locations and variants, then SKU matching. */
  catalog_sync: { storeId: number };
  /** Re-read a store's locations (location webhooks). */
  sync_locations: { storeId: number };
  /** Re-read the variants of one inventory item (inventory_items/create|update webhooks). */
  refresh_inventory_item: { storeId: number; inventoryItemId: string };
  /** An inventory item was deleted in Shopify. */
  remove_inventory_item: { storeId: number; inventoryItemId: string };
  /** A product was deleted in Shopify. */
  remove_product: { storeId: number; productId: string };
  /** Make sure all webhook subscriptions exist and point at us. */
  ensure_webhooks: { storeId: number };
  /** Compare every synced level of a store with what we expect; reconcile differences. */
  drift_scan: { storeId: number };
  /** Re-test a store in `error` state and re-activate it when it works again. */
  store_health: { storeId: number };
};

export type TaskKind = keyof TaskPayloads;

export interface ClaimedTask<K extends TaskKind = TaskKind> {
  id: number;
  kind: K;
  payload: TaskPayloads[K];
  leaseToken: string;
  generation: number;
  attempts: number;
}

export function defaultDedupeKey(kind: TaskKind, payload: Record<string, unknown>): string {
  const parts = Object.keys(payload)
    .sort()
    .map((k) => `${k}=${String(payload[k])}`);
  return [kind, ...parts].join(':');
}

export async function enqueueTask<K extends TaskKind>(
  db: Queryable,
  kind: K,
  payload: TaskPayloads[K],
  opts: { delayMs?: number; dedupeKey?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO tasks (kind, dedupe_key, payload, run_after)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision / 1000))
     ON CONFLICT (dedupe_key) DO UPDATE
       SET payload = EXCLUDED.payload,
           generation = tasks.generation + 1,
           run_after = LEAST(tasks.run_after, EXCLUDED.run_after)`,
    [
      kind,
      opts.dedupeKey ?? defaultDedupeKey(kind, payload as Record<string, unknown>),
      JSON.stringify(payload),
      opts.delayMs ?? 0,
    ],
  );
}

export async function claimTasks(
  db: Queryable,
  limit: number,
  leaseMs: number,
): Promise<ClaimedTask[]> {
  const { rows } = await db.query<{
    id: number;
    kind: TaskKind;
    payload: TaskPayloads[TaskKind];
    lease_token: string;
    generation: number;
    attempts: number;
  }>(
    `UPDATE tasks t
        SET lease_token = gen_random_uuid(),
            leased_until = now() + make_interval(secs => $2::double precision / 1000),
            attempts = t.attempts + 1
      WHERE t.id IN (
        SELECT id FROM tasks
         WHERE run_after <= now() AND (leased_until IS NULL OR leased_until < now())
         ORDER BY run_after
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING t.id, t.kind, t.payload, t.lease_token, t.generation, t.attempts`,
    [limit, leaseMs],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    payload: r.payload,
    leaseToken: r.lease_token,
    generation: r.generation,
    attempts: r.attempts,
  }));
}

/** Deletes a finished task, unless it was re-requested while running (then it runs again). */
export async function completeTask(db: Queryable, task: ClaimedTask): Promise<void> {
  const deleted = await db.query(
    'DELETE FROM tasks WHERE id = $1 AND lease_token = $2 AND generation = $3',
    [task.id, task.leaseToken, task.generation],
  );
  if (deleted.rowCount === 0) {
    await db.query(
      `UPDATE tasks SET lease_token = NULL, leased_until = NULL, attempts = 0, last_error = NULL, run_after = now()
        WHERE id = $1 AND lease_token = $2`,
      [task.id, task.leaseToken],
    );
  }
}

export async function failTask(
  db: Queryable,
  task: ClaimedTask,
  error: string,
  delayMs: number,
): Promise<void> {
  await db.query(
    `UPDATE tasks
        SET lease_token = NULL, leased_until = NULL, last_error = $3,
            run_after = now() + make_interval(secs => $4::double precision / 1000)
      WHERE id = $1 AND lease_token = $2`,
    [task.id, task.leaseToken, error, delayMs],
  );
}

/** Pushes a running task's lease out again, as long as it is still ours. */
export async function extendTaskLease(
  db: Queryable,
  task: ClaimedTask,
  leaseMs: number,
): Promise<void> {
  await db.query(
    `UPDATE tasks SET leased_until = now() + make_interval(secs => $3::double precision / 1000)
      WHERE id = $1 AND lease_token = $2`,
    [task.id, task.leaseToken, leaseMs],
  );
}
