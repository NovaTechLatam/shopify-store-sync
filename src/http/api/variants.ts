import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resetToAutoLink, setManualLink } from '../../catalog/catalog.js';
import { badRequest, notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';

const VariantsQuery = z.object({
  filter: z.enum(['unmatched', 'conflicts', 'ignored', 'all']).default('unmatched'),
  storeId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const LinkBody = z.object({ itemId: z.number().int().positive().nullable() });

const DUPLICATE_IN_STORE = `EXISTS (SELECT 1 FROM variants o
   WHERE o.store_id = v.store_id AND o.sku = v.sku AND o.id <> v.id AND o.deleted_at IS NULL AND NOT o.is_bundle)`;

/**
 * - unmatched: sold in one store only (no other store has the same SKU) — often a SKU typo.
 * - conflicts: the same SKU is used by several variants of one store, so we can't tell which to sync.
 * - ignored:   bundles, variants without SKU, and variants set to "never sync".
 */
const FILTERS: Record<z.infer<typeof VariantsQuery>['filter'], string> = {
  all: 'TRUE',
  unmatched: `NOT v.is_bundle AND v.sku IS NOT NULL AND (
      (v.item_id IS NULL AND v.link_source = 'auto' AND NOT ${DUPLICATE_IN_STORE})
   OR (v.item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM variants o
         WHERE o.item_id = v.item_id AND o.store_id <> v.store_id AND o.deleted_at IS NULL)))`,
  conflicts: `NOT v.is_bundle AND v.sku IS NOT NULL AND v.item_id IS NULL AND v.link_source = 'auto'
              AND ${DUPLICATE_IN_STORE}`,
  ignored: `(v.is_bundle OR v.sku IS NULL OR (v.link_source = 'manual' AND v.item_id IS NULL))`,
};

export async function registerVariantRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get('/api/variants', async (request) => {
    const q = VariantsQuery.parse(request.query);
    const params: unknown[] = [];
    let where = `v.deleted_at IS NULL AND ${FILTERS[q.filter]}`;
    if (q.storeId) {
      params.push(q.storeId);
      where += ` AND v.store_id = $${params.length}`;
    }
    if (q.search) {
      params.push(`%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where += ` AND (v.sku ILIKE $${params.length} OR v.product_title ILIKE $${params.length}
                 OR v.barcode ILIKE $${params.length})`;
    }
    const total = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM variants v WHERE ${where}`,
      params,
    );
    const { rows } = await db.query<{
      id: number;
      store_id: number;
      store_name: string;
      sku: string | null;
      barcode: string | null;
      product_title: string;
      variant_title: string;
      tracked: boolean;
      is_bundle: boolean;
      item_id: number | null;
      item_sku: string | null;
      link_source: string;
      deleted_at: Date | null;
    }>(
      `SELECT v.id, v.store_id, s.name AS store_name, v.sku, v.barcode, v.product_title, v.variant_title,
              v.tracked, v.is_bundle, v.item_id, i.sku AS item_sku, v.link_source, v.deleted_at
         FROM variants v JOIN stores s ON s.id = v.store_id LEFT JOIN items i ON i.id = v.item_id
        WHERE ${where}
        ORDER BY v.sku NULLS LAST, s.id, v.id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: total.rows[0]!.n,
      variants: rows.map((v) => ({
        id: v.id,
        storeId: v.store_id,
        storeName: v.store_name,
        sku: v.sku,
        barcode: v.barcode,
        productTitle: v.product_title,
        variantTitle: v.variant_title,
        tracked: v.tracked,
        isBundle: v.is_bundle,
        itemId: v.item_id,
        itemSku: v.item_sku,
        linkSource: v.link_source,
        deleted: v.deleted_at !== null,
      })),
    };
  });

  app.put('/api/variants/:id/link', async (request) => {
    const variantId = parseId((request.params as { id: string }).id);
    const body = LinkBody.parse(request.body);
    try {
      await setManualLink(db, variantId, body.itemId);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    deps.onWork?.();
    return { ok: true };
  });

  app.delete('/api/variants/:id/link', async (request) => {
    const variantId = parseId((request.params as { id: string }).id);
    const exists = await db.query('SELECT 1 FROM variants WHERE id = $1', [variantId]);
    if (!exists.rowCount) throw notFound('Variant');
    await resetToAutoLink(db, variantId);
    deps.onWork?.();
    return { ok: true };
  });
}
