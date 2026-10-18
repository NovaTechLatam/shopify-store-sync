import type { Queryable } from './pool.js';

/**
 * EVERY ADVISORY LOCK STORE SYNC TAKES, in one place.
 *
 * Postgres has two key spaces for advisory locks: one bigint (`pg_advisory_lock(key)`) and two
 * integers (`pg_advisory_lock(class, id)`, here always a class and a store id). The spaces never
 * overlap, but a number used in both reads like a clash and invites one later, so every lock gets
 * its own number whatever its space. Add new ones here (the next free number is 727_007); a test
 * checks they stay unique and that no other source file writes one of these numbers itself.
 */

/** Single-key locks: `pg_advisory_lock(key)` / `pg_advisory_xact_lock(key)`. */
export const LOCKS = {
  /** Session lock: one instance applies the migrations (src/db/migrate.ts). Never renumber it. */
  migrations: 727_001,
  /** Transaction lock held by every catalog writer (src/catalog/catalog.ts). Never renumber it. */
  catalog: 727_002,
  /** Transaction lock: price runs are created one at a time, so two can't both find a store free. */
  priceRunCreate: 727_003,
  /** Transaction lock: schedules are created and edited one at a time (the overlap check). */
  priceSchedules: 727_006,
} as const;

/** Two-key lock classes: `pg_advisory_lock(class, storeId)`, one lock per store. */
export const LOCK_CLASSES = {
  /** Session lock: one task writes a store's prices at a time (src/pricing/runs.ts). */
  priceApply: 727_004,
  /** Session lock: one check of a store's order history import at a time (src/sales/sync.ts). */
  salesBackfill: 727_005,
} as const;

/**
 * Locks `items` rows for an update, in id order, until the transaction ends.
 *
 * Every transaction that changes several items (bulk price edits, deliveries, catalog saves and
 * imports, scheduled price changes) locks them this way first: two of them working on the same
 * items then wait for each other instead of each holding one row the other wants (a deadlock,
 * where Postgres aborts one). NO KEY UPDATE, like an UPDATE of non-key columns takes: it doesn't
 * block the key-share locks that inserting rows referencing an item takes (an order line, a stock
 * level), which would otherwise join the cycle in whatever order those come.
 */
export async function lockItemRows(client: Queryable, itemIds: number[]): Promise<void> {
  if (itemIds.length === 0) return;
  await client.query(
    'SELECT id FROM items WHERE id = ANY($1::bigint[]) ORDER BY id FOR NO KEY UPDATE',
    [itemIds],
  );
}
