import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import type { AppDeps } from '../server.js';

const EventsQuery = z.object({
  itemId: z.coerce.number().int().positive().optional(),
  storeId: z.coerce.number().int().positive().optional(),
  kind: z.string().trim().max(50).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function loadEvents(db: Queryable, q: Partial<z.infer<typeof EventsQuery>>) {
  const limit = q.limit ?? 50;
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (q.itemId) add('e.item_id = ?', q.itemId);
  if (q.storeId) add('e.store_id = ?', q.storeId);
  if (q.kind) add('e.kind = ?', q.kind);
  if (q.before) add('e.id < ?', q.before);
  params.push(limit + 1);
  const { rows } = await db.query<{
    id: number;
    kind: string;
    item_id: number | null;
    sku: string | null;
    store_id: number | null;
    store_name: string | null;
    delta: number | null;
    quantity_before: number | null;
    quantity_after: number | null;
    message: string | null;
    details: unknown;
    created_at: Date;
  }>(
    `SELECT e.id, e.kind, e.item_id, i.sku, e.store_id, s.name AS store_name, e.delta, e.quantity_before,
            e.quantity_after, e.message, e.details, e.created_at
       FROM inventory_events e
       LEFT JOIN items i ON i.id = e.item_id
       LEFT JOIN stores s ON s.id = e.store_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY e.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  return {
    events: page.map((e) => ({
      id: e.id,
      kind: e.kind,
      itemId: e.item_id,
      sku: e.sku,
      storeId: e.store_id,
      storeName: e.store_name,
      delta: e.delta,
      quantityBefore: e.quantity_before,
      quantityAfter: e.quantity_after,
      message: e.message,
      details: e.details,
      createdAt: e.created_at,
    })),
    nextBefore: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

export async function registerEventRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/events', async (request) => loadEvents(deps.db, EventsQuery.parse(request.query)));
}
