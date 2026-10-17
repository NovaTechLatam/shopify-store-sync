import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../../db/pool.js';
import { notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';

const AlertsQuery = z.object({ status: z.enum(['open', 'all']).default('open') });

export async function loadAlerts(db: Queryable, q: { status: 'open' | 'all'; itemId?: number }) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (q.status === 'open') conditions.push('a.resolved_at IS NULL');
  if (q.itemId) {
    params.push(q.itemId);
    conditions.push(`a.item_id = $${params.length}`);
  }
  const { rows } = await db.query<{
    id: number;
    kind: string;
    message: string;
    item_id: number | null;
    sku: string | null;
    store_id: number | null;
    store_name: string | null;
    created_at: Date;
    notified_at: Date | null;
    resolved_at: Date | null;
  }>(
    `SELECT a.id, a.kind, a.message, a.item_id, i.sku, a.store_id, s.name AS store_name,
            a.created_at, a.notified_at, a.resolved_at
       FROM alerts a
       LEFT JOIN items i ON i.id = a.item_id
       LEFT JOIN stores s ON s.id = a.store_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY a.resolved_at IS NULL DESC, a.created_at DESC
      LIMIT 500`,
    params,
  );
  return rows.map((a) => ({
    id: a.id,
    kind: a.kind,
    message: a.message,
    itemId: a.item_id,
    sku: a.sku,
    storeId: a.store_id,
    storeName: a.store_name,
    createdAt: a.created_at,
    notifiedAt: a.notified_at,
    resolvedAt: a.resolved_at,
  }));
}

export async function registerAlertRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/alerts', async (request) => loadAlerts(deps.db, AlertsQuery.parse(request.query)));

  app.post('/api/alerts/:id/resolve', async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const { rowCount } = await deps.db.query(
      'UPDATE alerts SET resolved_at = COALESCE(resolved_at, now()) WHERE id = $1',
      [id],
    );
    if (!rowCount) throw notFound('Alert');
    return { ok: true };
  });
}
