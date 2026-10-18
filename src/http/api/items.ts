import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensureItem } from '../../catalog/catalog.js';
import { normalizeSku } from '../../catalog/sku.js';
import type { Queryable } from '../../db/pool.js';
import { getSettings } from '../../settings.js';
import { displayQuantity } from '../../sync/engine.js';
import { enqueuePoolLevels } from '../../sync/queue.js';
import { badRequest, conflict, notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';
import { loadEvents } from './events.js';
import { loadAlerts } from './alerts.js';

const ListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  filter: z.enum(['all', 'issues', 'uninitialized', 'low', 'oversold', 'disabled']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const CreateItemBody = z.object({
  sku: z.string().trim().min(1).max(255),
  title: z.string().trim().max(255).optional(),
});

const UpdateItemBody = z.object({
  title: z.string().trim().max(255).optional(),
  syncEnabled: z.boolean().optional(),
  lowStockThreshold: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

const AdjustBody = z.object({
  warehouseId: z.number().int().positive().optional(),
  kind: z.enum(['set', 'adjust', 'count']),
  value: z.number().int().min(-1_000_000).max(1_000_000),
  note: z.string().trim().max(500).optional(),
});

/**
 * WHERE clause fragments for the list filters. "Issues" = anything the merchant should look at:
 * an open alert, a write that hasn't been confirmed, a store that sells the item untracked, a
 * duplicate SKU in a store, or an active store that doesn't sell it at all.
 */
const FILTERS: Record<z.infer<typeof ListQuery>['filter'], string> = {
  all: 'TRUE',
  disabled: 'NOT i.sync_enabled',
  uninitialized:
    'EXISTS (SELECT 1 FROM pool_levels pl WHERE pl.item_id = i.id AND pl.quantity IS NULL)',
  oversold: 'EXISTS (SELECT 1 FROM pool_levels pl WHERE pl.item_id = i.id AND pl.quantity < 0)',
  low: `EXISTS (SELECT 1 FROM alerts a WHERE a.item_id = i.id AND a.kind = 'low_stock' AND a.resolved_at IS NULL)`,
  issues: `(
      EXISTS (SELECT 1 FROM alerts a WHERE a.item_id = i.id AND a.resolved_at IS NULL)
   OR EXISTS (SELECT 1 FROM pending_writes pw JOIN pool_levels pl ON pl.id = pw.pool_level_id WHERE pl.item_id = i.id)
   OR EXISTS (SELECT 1 FROM variants v WHERE v.item_id = i.id AND v.deleted_at IS NULL AND NOT v.tracked)
   OR EXISTS (SELECT 1 FROM variants v
               WHERE v.sku = i.sku AND v.deleted_at IS NULL AND NOT v.is_bundle AND v.item_id IS NULL
                 AND v.link_source = 'auto')
   OR EXISTS (SELECT 1 FROM stores s WHERE s.status = 'active'
               AND NOT EXISTS (SELECT 1 FROM variants v
                                WHERE v.store_id = s.id AND v.item_id = i.id AND v.deleted_at IS NULL)
               -- A catalog product reaches the stores when it's published: not a problem.
               AND NOT EXISTS (SELECT 1 FROM master_variants mv WHERE mv.item_id = i.id)))`,
};

export interface ItemSummary {
  id: number;
  sku: string;
  title: string;
  syncEnabled: boolean;
  lowStockThreshold: number | null;
  levels: {
    poolLevelId: number;
    warehouseId: number;
    warehouseName: string;
    quantity: number | null;
    updatedAt: Date;
    stores: {
      storeId: number;
      storeName: string;
      variantId: number;
      productTitle: string;
      variantTitle: string;
      tracked: boolean;
      lastKnown: number | null;
      shows: number | null;
      pendingWrite: boolean;
    }[];
  }[];
  issues: string[];
}

/** Builds dashboard summaries for the given items (in the given order). */
export async function loadItemSummaries(db: Queryable, itemIds: number[]): Promise<ItemSummary[]> {
  if (itemIds.length === 0) return [];
  const [items, levels, variants, baselines, pending, stores, duplicates] = await Promise.all([
    db.query<{
      id: number;
      sku: string;
      title: string;
      sync_enabled: boolean;
      low_stock_threshold: number | null;
    }>(
      'SELECT id, sku, title, sync_enabled, low_stock_threshold FROM items WHERE id = ANY($1::bigint[])',
      [itemIds],
    ),
    db.query<{
      id: number;
      item_id: number;
      warehouse_id: number;
      warehouse_name: string;
      quantity: number | null;
      updated_at: Date;
    }>(
      `SELECT pl.id, pl.item_id, pl.warehouse_id, w.name AS warehouse_name, pl.quantity, pl.updated_at
         FROM pool_levels pl JOIN warehouses w ON w.id = pl.warehouse_id
        WHERE pl.item_id = ANY($1::bigint[]) ORDER BY w.id`,
      [itemIds],
    ),
    db.query<{
      id: number;
      item_id: number;
      store_id: number;
      store_name: string;
      store_status: string;
      safety_buffer: number;
      product_title: string;
      variant_title: string;
      tracked: boolean;
      inventory_item_id: string;
    }>(
      `SELECT v.id, v.item_id, v.store_id, s.name AS store_name, s.status AS store_status, s.safety_buffer,
              v.product_title, v.variant_title, v.tracked, v.inventory_item_id
         FROM variants v JOIN stores s ON s.id = v.store_id
        WHERE v.item_id = ANY($1::bigint[]) AND v.deleted_at IS NULL AND NOT v.is_bundle
        ORDER BY s.id`,
      [itemIds],
    ),
    db.query<{
      pool_level_id: number;
      store_id: number;
      inventory_item_id: string;
      location_id: string;
      baseline: number | null;
    }>(
      `SELECT sl.pool_level_id, sl.store_id, sl.inventory_item_id, sl.location_id, sl.baseline
         FROM store_levels sl JOIN pool_levels pl ON pl.id = sl.pool_level_id
        WHERE pl.item_id = ANY($1::bigint[])`,
      [itemIds],
    ),
    db.query<{ pool_level_id: number; store_id: number }>(
      `SELECT pw.pool_level_id, pw.store_id FROM pending_writes pw JOIN pool_levels pl ON pl.id = pw.pool_level_id
        WHERE pl.item_id = ANY($1::bigint[])`,
      [itemIds],
    ),
    db.query<{
      id: number;
      name: string;
      status: string;
      locations: { warehouse_id: number; location_id: string }[];
    }>(
      `SELECT s.id, s.name, s.status,
              COALESCE(json_agg(json_build_object('warehouse_id', sl.warehouse_id,
                                                  'location_id', sl.shopify_location_id))
                       FILTER (WHERE sl.id IS NOT NULL), '[]') AS locations
         FROM stores s
         LEFT JOIN store_locations sl ON sl.store_id = s.id AND sl.warehouse_id IS NOT NULL AND sl.is_active
        GROUP BY s.id ORDER BY s.id`,
    ),
    db.query<{ sku: string; store_name: string }>(
      `SELECT v.sku, s.name AS store_name FROM variants v JOIN stores s ON s.id = v.store_id
        WHERE v.sku IN (SELECT sku FROM items WHERE id = ANY($1::bigint[]))
          AND v.deleted_at IS NULL AND NOT v.is_bundle
        GROUP BY v.sku, s.name HAVING count(*) > 1`,
      [itemIds],
    ),
  ]);
  // Items of catalog products (src/products): the brands each is meant to be sold in.
  const catalog = await db.query<{ item_id: number; store_id: number; enabled: boolean }>(
    `SELECT mv.item_id, mps.store_id, mps.enabled FROM master_variants mv
       JOIN master_product_stores mps ON mps.master_product_id = mv.master_product_id
      WHERE mv.item_id = ANY($1::bigint[])`,
    [itemIds],
  );
  const inCatalog = new Set(catalog.rows.map((c) => c.item_id));

  const byId = new Map(items.rows.map((i) => [i.id, i]));
  return itemIds.flatMap((itemId) => {
    const item = byId.get(itemId);
    if (!item) return [];
    const itemVariants = variants.rows.filter((v) => v.item_id === itemId);
    const issues: string[] = [];
    for (const v of itemVariants) if (!v.tracked) issues.push(`Not tracked in ${v.store_name}`);
    for (const d of duplicates.rows)
      if (d.sku === item.sku) issues.push(`Duplicate SKU in ${d.store_name}`);
    for (const s of stores.rows) {
      if (s.status !== 'active' || itemVariants.some((v) => v.store_id === s.id)) continue;
      if (!inCatalog.has(itemId)) {
        issues.push(`Missing in ${s.name}`);
        continue;
      }
      // A catalog product is only missing where it's meant to be sold and not published yet.
      const brand = catalog.rows.find((c) => c.item_id === itemId && c.store_id === s.id);
      if (brand?.enabled) issues.push(`Not published in ${s.name} yet`);
    }

    const itemLevels = levels.rows
      .filter((l) => l.item_id === itemId)
      .map((l) => ({
        poolLevelId: l.id,
        warehouseId: l.warehouse_id,
        warehouseName: l.warehouse_name,
        quantity: l.quantity,
        updatedAt: l.updated_at,
        stores: itemVariants.flatMap((v) => {
          const store = stores.rows.find((s) => s.id === v.store_id);
          const location = store?.locations.find((loc) => loc.warehouse_id === l.warehouse_id);
          if (!location) return []; // this store doesn't sell from this warehouse
          const base = baselines.rows.find(
            (b) =>
              b.pool_level_id === l.id &&
              b.store_id === v.store_id &&
              b.inventory_item_id === v.inventory_item_id &&
              b.location_id === location.location_id,
          );
          const participates = v.tracked && v.store_status === 'active';
          return [
            {
              storeId: v.store_id,
              storeName: v.store_name,
              variantId: v.id,
              productTitle: v.product_title,
              variantTitle: v.variant_title,
              tracked: v.tracked,
              lastKnown: base?.baseline ?? null,
              shows:
                participates && l.quantity !== null
                  ? displayQuantity(l.quantity, v.safety_buffer)
                  : null,
              pendingWrite: pending.rows.some(
                (p) => p.pool_level_id === l.id && p.store_id === v.store_id,
              ),
            },
          ];
        }),
      }));
    if (itemLevels.some((l) => l.stores.some((s) => s.pendingWrite))) {
      issues.push('An update to a store is waiting to be confirmed');
    }
    return [
      {
        id: item.id,
        sku: item.sku,
        title: item.title,
        syncEnabled: item.sync_enabled,
        lowStockThreshold: item.low_stock_threshold,
        levels: itemLevels,
        issues,
      },
    ];
  });
}

async function poolLevelIdsOf(db: Queryable, itemId: number): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM pool_levels WHERE item_id = $1', [
    itemId,
  ]);
  return rows.map((r) => r.id);
}

async function loadItem(db: Queryable, itemId: number): Promise<ItemSummary> {
  const [summary] = await loadItemSummaries(db, [itemId]);
  if (!summary) throw notFound('Item');
  return summary;
}

export async function registerItemRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get('/api/items', async (request) => {
    const q = ListQuery.parse(request.query);
    const params: unknown[] = [];
    let where = FILTERS[q.filter];
    if (q.search) {
      params.push(`%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where += ` AND (i.sku ILIKE $${params.length} OR i.title ILIKE $${params.length}
                 OR EXISTS (SELECT 1 FROM variants v WHERE v.item_id = i.id AND v.deleted_at IS NULL
                              AND (v.product_title ILIKE $${params.length} OR v.barcode ILIKE $${params.length})))`;
    }
    const total = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM items i WHERE ${where}`,
      params,
    );
    const page = await db.query<{ id: number }>(
      `SELECT i.id FROM items i WHERE ${where} ORDER BY i.sku
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: total.rows[0]!.n,
      page: q.page,
      pageSize: q.pageSize,
      items: await loadItemSummaries(
        db,
        page.rows.map((r) => r.id),
      ),
    };
  });

  app.get('/api/items/:id', async (request) => {
    const itemId = parseId((request.params as { id: string }).id);
    const item = await loadItem(db, itemId);
    const [events, alerts] = await Promise.all([
      loadEvents(db, { itemId, limit: 100 }),
      loadAlerts(db, { status: 'all', itemId }),
    ]);
    return { ...item, events: events.events, alerts };
  });

  app.post('/api/items', async (request, reply) => {
    const body = CreateItemBody.parse(request.body);
    const sku = normalizeSku(body.sku);
    if (!sku) throw badRequest('SKU is required');
    const exists = await db.query('SELECT 1 FROM items WHERE sku = $1', [sku]);
    if (exists.rowCount) throw conflict(`An item with SKU ${sku} already exists`);
    const itemId = await ensureItem(db, sku, body.title ?? '');
    return reply.code(201).send(await loadItem(db, itemId));
  });

  app.patch('/api/items/:id', async (request) => {
    const itemId = parseId((request.params as { id: string }).id);
    const body = UpdateItemBody.parse(request.body);
    const before = await loadItem(db, itemId);
    await db.query(
      `UPDATE items SET title = COALESCE($2, title),
                        sync_enabled = COALESCE($3, sync_enabled),
                        low_stock_threshold = CASE WHEN $4::boolean THEN $5::integer ELSE low_stock_threshold END,
                        updated_at = now()
        WHERE id = $1`,
      [
        itemId,
        body.title ?? null,
        body.syncEnabled ?? null,
        body.lowStockThreshold !== undefined,
        body.lowStockThreshold ?? null,
      ],
    );
    // Re-enabling sync (or changing the threshold) needs a reconcile to catch up / re-evaluate alerts.
    if (
      (body.syncEnabled === true && !before.syncEnabled) ||
      (body.lowStockThreshold !== undefined && body.lowStockThreshold !== before.lowStockThreshold)
    ) {
      await enqueuePoolLevels(db, await poolLevelIdsOf(db, itemId), 'item_updated');
      deps.onWork?.();
    }
    return loadItem(db, itemId);
  });

  app.post('/api/items/:id/adjust', async (request, reply) => {
    const itemId = parseId((request.params as { id: string }).id);
    const body = AdjustBody.parse(request.body);
    const { rows } = await db.query<{ id: number; quantity: number | null }>(
      `SELECT id, quantity FROM pool_levels WHERE item_id = $1 AND warehouse_id = COALESCE($2, warehouse_id)
        ORDER BY warehouse_id LIMIT 1`,
      [itemId, body.warehouseId ?? null],
    );
    const level = rows[0];
    if (!level) throw notFound('Item or warehouse');
    // "Set" and "count" describe the stock right now; applied later they'd erase sales made in
    // between. Relative changes ("received 24") stay correct whenever they are applied.
    if (body.kind !== 'adjust') {
      const [{ rows: item }, settings] = await Promise.all([
        db.query<{ sync_enabled: boolean }>('SELECT sync_enabled FROM items WHERE id = $1', [
          itemId,
        ]),
        getSettings(db),
      ]);
      if (settings.syncPaused || !item[0]?.sync_enabled) {
        throw conflict(
          'Syncing is paused for this product, so a stock count would be applied later with old ' +
            'numbers. Resume syncing first, then enter the count.',
        );
      }
    }
    if (level.quantity === null) {
      throw badRequest(
        'This item has not started syncing yet. Start it from the onboarding screen first.',
      );
    }
    if (body.kind !== 'adjust' && body.value < 0) throw badRequest('Stock can’t be set below zero');
    await db.query(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value, note) VALUES ($1, $2, $3, $4)`,
      [level.id, body.kind, body.value, body.note ?? null],
    );
    await enqueuePoolLevels(db, [level.id], 'manual_adjustment');
    deps.onWork?.();
    return reply.code(202).send({ queued: true });
  });

  app.post('/api/items/:id/resync', async (request, reply) => {
    const itemId = parseId((request.params as { id: string }).id);
    await loadItem(db, itemId);
    await enqueuePoolLevels(db, await poolLevelIdsOf(db, itemId), 'manual_resync');
    deps.onWork?.();
    return reply.code(202).send({ queued: true });
  });
}
