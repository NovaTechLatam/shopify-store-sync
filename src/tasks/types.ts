import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import type { ShopifyRegistry } from '../sync/engine.js';
import type { TaskKind, TaskPayloads } from './queue.js';

/** What every task handler gets. */
export interface TaskDeps {
  db: Db;
  shopify: ShopifyRegistry;
  logger: Logger;
  /** Public base URL of this service; webhook subscriptions point at it. */
  publicUrl: string;
  fetchFn?: typeof fetch;
}

export type TaskHandler<K extends TaskKind> = (
  deps: TaskDeps,
  payload: TaskPayloads[K],
) => Promise<void>;

/**
 * What a feature adds to the task registry (src/tasks/handlers.ts): a payload schema and a
 * handler for each of its task kinds, typed against the feature's own payload type.
 */
export interface FeatureTasks<P extends Record<string, object>> {
  schemas: { [K in keyof P]: z.ZodType<P[K]> };
  handlers: { [K in keyof P]: (deps: TaskDeps, payload: P[K]) => Promise<void> };
}

/** Pieces of payload schemas. */
export const positiveId = z.number().int().positive();
export const shopifyGid = z.string().regex(/^gid:\/\/shopify\/\w+\/\S+$/);

/** The store a per-store task is about, as forStore() hands it to the handler. */
export interface TaskStore {
  name: string;
  status: string;
  webhooks_registered_at: Date | null;
}

/** Statuses in which a store takes no background work (until the merchant changes it). */
const IDLE_STATUSES = new Set(['paused', 'disconnected']);

/** Runs the handler only if the store still exists and is not paused or disconnected. */
export function forStore<P extends { storeId: number }>(
  handler: (deps: TaskDeps, payload: P, store: TaskStore) => Promise<void>,
): (deps: TaskDeps, payload: P) => Promise<void> {
  return async (deps, payload) => {
    const { rows } = await deps.db.query<TaskStore>(
      'SELECT name, status, webhooks_registered_at FROM stores WHERE id = $1',
      [payload.storeId],
    );
    const store = rows[0];
    if (!store || IDLE_STATUSES.has(store.status)) {
      deps.logger.debug(
        { storeId: payload.storeId, status: store?.status ?? 'deleted' },
        'skipping task for inactive store',
      );
      return;
    }
    await handler(deps, payload, store);
  };
}
