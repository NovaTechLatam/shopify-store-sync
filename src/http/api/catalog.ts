import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { createProduct, deleteProduct, updateProduct } from '../../products/editor.js';
import { importProduct, searchStoreProducts } from '../../products/import.js';
import { MAX_IMAGE_BYTES } from '../../products/images.js';
import { loadImage, saveImage } from '../../products/media.js';
import type { MasterProduct } from '../../products/model.js';
import { loadMasterProduct, loadMasterProducts, loadStoreContexts } from '../../products/model.js';
import { previewPublish } from '../../products/preview.js';
import { editorView, listRow, loadCurrentPrices, loadItemStock } from '../../products/views.js';
import { getSettings } from '../../settings.js';
import { enqueueTask } from '../../tasks/queue.js';
import { badRequest, notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';

const ListQuery = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['all', 'ACTIVE', 'DRAFT', 'ARCHIVED']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** "1,2,3" → [1, 2, 3]; empty = every store. */
const IdList = z
  .string()
  .trim()
  .max(2000)
  .regex(/^(\d+(,\d+)*)?$/, 'Use a comma-separated list of store ids')
  .transform((v) => (v ? v.split(',').map(Number) : undefined));

const PreviewQuery = z.object({ storeIds: IdList.optional() });

const PublishBody = z.object({
  storeIds: z.array(z.number().int().positive()).min(1).max(100),
});

const ImportSearchQuery = z.object({
  storeId: z.coerce.number().int().positive(),
  search: z.string().trim().max(200).optional(),
});

const ImportBody = z.object({
  storeId: z.number().int().positive(),
  productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/, 'Choose a product to import'),
});

const UploadQuery = z.object({ filename: z.string().max(255).optional() });

/** Catalog (master products): /api/catalog/... */
export async function registerCatalogRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  const productView = async (product: MasterProduct) => {
    const itemIds = product.variants.map((v) => v.itemId);
    const [stores, current, stock, settings] = await Promise.all([
      loadStoreContexts(db, itemIds),
      loadCurrentPrices(db, itemIds),
      loadItemStock(db, itemIds),
      getSettings(db),
    ]);
    return editorView(product, stores, current, stock, settings.baseCurrency);
  };
  const loadView = async (id: number) => {
    const product = await loadMasterProduct(db, id);
    if (!product) throw notFound('Product');
    return productView(product);
  };

  app.get('/api/catalog/products', async (request) => {
    const q = ListQuery.parse(request.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status !== 'all') {
      params.push(q.status);
      where.push(`mp.status = $${params.length}`);
    }
    if (q.search) {
      params.push(`%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(mp.title ILIKE $${params.length} OR EXISTS (
        SELECT 1 FROM master_variants mv
         WHERE mv.master_product_id = mp.id AND mv.sku ILIKE $${params.length}))`);
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM master_products mp ${sql}`,
      params,
    );
    const page = await db.query<{ id: number }>(
      `SELECT mp.id FROM master_products mp ${sql}
        ORDER BY mp.updated_at DESC, mp.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const products = await loadMasterProducts(
      db,
      page.rows.map((r) => r.id),
    );
    const itemIds = products.flatMap((p) => p.variants.map((v) => v.itemId));
    const [stores, current] = await Promise.all([
      loadStoreContexts(db, itemIds),
      loadCurrentPrices(db, itemIds),
    ]);
    return {
      total: total.rows[0]!.n,
      page: q.page,
      pageSize: q.pageSize,
      products: products.map((p) => listRow(p, stores, current)),
    };
  });

  app.post('/api/catalog/products', async (request, reply) => {
    const id = await createProduct(db, request.body);
    return reply.code(201).send(await loadView(id));
  });

  app.get('/api/catalog/products/:id', async (request) => {
    return loadView(parseId((request.params as { id: string }).id));
  });

  app.patch('/api/catalog/products/:id', async (request) => {
    const id = parseId((request.params as { id: string }).id);
    await updateProduct(db, id, request.body);
    return loadView(id);
  });

  app.delete('/api/catalog/products/:id', async (request, reply) => {
    await deleteProduct(db, parseId((request.params as { id: string }).id));
    return reply.code(204).send();
  });

  app.get('/api/catalog/products/:id/preview', async (request) => {
    const id = parseId((request.params as { id: string }).id);
    const q = PreviewQuery.parse(request.query);
    const product = await loadMasterProduct(db, id);
    if (!product) throw notFound('Product');
    const stores = await loadStoreContexts(
      db,
      product.variants.map((v) => v.itemId),
      q.storeIds,
    );
    const logger = request.log as unknown as Logger;
    return { stores: await previewPublish({ db, shopify: deps.shopify, logger }, product, stores) };
  });

  app.post('/api/catalog/products/:id/publish', async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const body = PublishBody.parse(request.body);
    const result = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: number }>(
        'SELECT id FROM master_products WHERE id = $1 FOR SHARE',
        [id],
      );
      if (!rows[0]) throw notFound('Product');
      const stores = await client.query<{ id: number; name: string; enabled: boolean | null }>(
        `SELECT s.id, s.name, mps.enabled FROM stores s
           LEFT JOIN master_product_stores mps ON mps.store_id = s.id AND mps.master_product_id = $1
          WHERE s.id = ANY($2::bigint[]) ORDER BY s.id`,
        [id, body.storeIds],
      );
      if (stores.rows.length !== new Set(body.storeIds).size) {
        throw badRequest('One of these stores doesn’t exist any more. Reload the page.');
      }
      const queued: number[] = [];
      const skipped: { storeId: number; reason: string }[] = [];
      for (const s of stores.rows) {
        if (!s.enabled) {
          skipped.push({ storeId: s.id, reason: `Not sold in ${s.name}.` });
          continue;
        }
        await client.query(
          `UPDATE master_product_stores SET publish_state = 'queued', last_error = NULL,
                                            updated_at = now()
            WHERE master_product_id = $1 AND store_id = $2`,
          [id, s.id],
        );
        await enqueueTask(client, 'publish_product', { masterProductId: id, storeId: s.id });
        queued.push(s.id);
      }
      return { queued, skipped };
    });
    if (result.queued.length) deps.onWork?.();
    return reply.code(202).send(result);
  });

  // Image uploads: the raw file as the body (no multipart), up to Shopify's 20 MB. Its type is
  // read from its bytes, so any image/* (or unknown) content type is taken here.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      /^(image\/|application\/octet-stream)/,
      { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES + 1024 },
      (_request, body, done) => done(null, body),
    );
    scope.post(
      '/api/catalog/media',
      { bodyLimit: MAX_IMAGE_BYTES + 1024 },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body)) {
          throw badRequest('Send the image file itself, with an image content type.');
        }
        const q = UploadQuery.parse(request.query);
        return reply.code(201).send(await saveImage(db, request.body, q.filename));
      },
    );
  });

  app.get('/api/catalog/media/:id', async (request, reply) => {
    const image = await loadImage(db, parseId((request.params as { id: string }).id));
    if (!image) throw notFound('Image');
    // An id always means the same bytes (uploads are kept by content).
    return reply
      .header('Content-Type', image.mimeType)
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(image.data);
  });

  app.get('/api/catalog/import/search', async (request) => {
    const q = ImportSearchQuery.parse(request.query);
    const store = await db.query('SELECT 1 FROM stores WHERE id = $1', [q.storeId]);
    if (!store.rowCount) throw notFound('Store');
    return { products: await searchStoreProducts(db, q.storeId, q.search) };
  });

  app.post('/api/catalog/import', async (request, reply) => {
    const body = ImportBody.parse(request.body);
    const result = await importProduct(
      { db, shopify: deps.shopify, logger: deps.logger },
      body.storeId,
      body.productId,
    );
    // Reading unknown variants may have queued stock work.
    deps.onWork?.();
    return reply.code(201).send(result);
  });

  app.get('/api/catalog/items/:itemId', async (request) => {
    const itemId = parseId((request.params as { itemId: string }).itemId, 'item id');
    return itemSection(db, itemId);
  });
}

/** The product page's catalog section: the item's catalog product, or where it could come from. */
async function itemSection(db: Db, itemId: number) {
  const item = await db.query('SELECT 1 FROM items WHERE id = $1', [itemId]);
  if (!item.rowCount) throw notFound('Item');
  const { rows } = await db.query<{ master_product_id: number }>(
    'SELECT master_product_id FROM master_variants WHERE item_id = $1',
    [itemId],
  );
  const [product] = rows[0] ? await loadMasterProducts(db, [rows[0].master_product_id]) : [];
  if (product) {
    const itemIds = product.variants.map((v) => v.itemId);
    const [stores, current] = await Promise.all([
      loadStoreContexts(db, itemIds),
      loadCurrentPrices(db, itemIds),
    ]);
    return { product: listRow(product, stores, current), importable: [] };
  }
  const importable = await db.query<{
    store_id: number;
    store_name: string;
    shopify_product_id: string;
    product_title: string;
  }>(
    `SELECT v.store_id, s.name AS store_name, v.shopify_product_id, v.product_title
       FROM variants v JOIN stores s ON s.id = v.store_id
      WHERE v.item_id = $1 AND v.deleted_at IS NULL AND NOT v.is_bundle
      ORDER BY s.id`,
    [itemId],
  );
  return {
    product: null,
    importable: importable.rows.map((r) => ({
      storeId: r.store_id,
      storeName: r.store_name,
      productId: r.shopify_product_id,
      productTitle: r.product_title,
    })),
  };
}
