import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';

const WarehouseBody = z.object({ name: z.string().trim().min(1).max(100) });

export async function registerWarehouseRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  const list = async () => {
    const { rows } = await db.query<{ id: number; name: string; mapped_stores: number }>(
      `SELECT w.id, w.name, count(sl.id)::int AS mapped_stores
         FROM warehouses w LEFT JOIN store_locations sl ON sl.warehouse_id = w.id
        GROUP BY w.id ORDER BY w.id`,
    );
    return rows.map((w) => ({ id: w.id, name: w.name, mappedStores: w.mapped_stores }));
  };

  app.get('/api/warehouses', list);

  app.post('/api/warehouses', async (request, reply) => {
    const body = WarehouseBody.parse(request.body);
    const { rows } = await db.query<{ id: number }>(
      'INSERT INTO warehouses (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id',
      [body.name],
    );
    if (!rows[0]) throw conflict(`A warehouse called “${body.name}” already exists`);
    // Every item gets a (not yet initialised) pool level in the new warehouse.
    await db.query(
      `INSERT INTO pool_levels (item_id, warehouse_id) SELECT id, $1 FROM items ON CONFLICT DO NOTHING`,
      [rows[0].id],
    );
    return reply.code(201).send((await list()).find((w) => w.id === rows[0]!.id));
  });

  app.patch('/api/warehouses/:id', async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const body = WarehouseBody.parse(request.body);
    const taken = await db.query('SELECT 1 FROM warehouses WHERE name = $1 AND id <> $2', [
      body.name,
      id,
    ]);
    if (taken.rowCount) throw conflict(`A warehouse called “${body.name}” already exists`);
    const { rowCount } = await db.query('UPDATE warehouses SET name = $2 WHERE id = $1', [
      id,
      body.name,
    ]);
    if (!rowCount) throw notFound('Warehouse');
    return (await list()).find((w) => w.id === id);
  });

  app.delete('/api/warehouses/:id', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const mapped = await db.query('SELECT 1 FROM store_locations WHERE warehouse_id = $1', [id]);
    if (mapped.rowCount) throw conflict('Unmap every store location from this warehouse first');
    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM warehouses');
    if (count.rows[0]!.n <= 1) throw conflict('You need at least one warehouse');
    // Purchase orders keep the warehouse they deliver to (their history).
    const ordered = await db.query('SELECT 1 FROM purchase_orders WHERE warehouse_id = $1', [id]);
    if (ordered.rowCount) throw conflict('Purchase orders deliver to this warehouse, so keep it');
    const { rowCount } = await db.query('DELETE FROM warehouses WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Warehouse');
    return reply.code(204).send();
  });
}
