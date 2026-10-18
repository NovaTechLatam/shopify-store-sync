import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ORDER_STATUSES,
  cancelOrder,
  closeOrder,
  createDraftOrders,
  createOrder,
  deleteOrder,
  listOrders,
  loadOrder,
  markOrdered,
  orderCsv,
  receiveOrder,
  reverseReceipt,
  updateOrder,
  waitingItems,
} from '../../purchasing/orders.js';
import { loadReorderRows } from '../../purchasing/reorder.js';
import {
  archiveSupplier,
  createSupplier,
  deleteSupplier,
  deleteSupplierItem,
  listSuppliers,
  loadItemPurchasing,
  loadSupplier,
  loadSupplierItems,
  putSupplierItem,
  restoreSupplier,
  searchItemsForOrder,
  updateItemPurchasing,
  updateSupplier,
} from '../../purchasing/suppliers.js';
import { getSettings } from '../../settings.js';
import { missingScopes } from '../../shopify/scopes.js';
import { enqueueTask } from '../../tasks/queue.js';
import { CURRENCY_CODE } from '../../util/money.js';
import { notFound, parseId } from '../errors.js';
import type { AppDeps } from '../server.js';

const Id = z.number().int().positive();
/** Unit costs, numeric(18,4). */
const Money = z.number().min(0).max(1_000_000_000_000);
/** Units of the order's currency per 1 base currency, like stores.exchange_rate. */
const Rate = z.number().min(0.00000001).max(1_000_000_000);
const Days = z.number().int().min(0).max(365);
const Quantity = z.number().int().min(1).max(1_000_000);
/** Optional text: '' (an emptied field) is stored as NULL. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));
const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31')
  .refine((v) => {
    const date = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(v);
  }, 'Not a real date');

const SupplierBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    contactName: optionalText(200),
    email: optionalText(254).refine(
      (v) => v === null || v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      'Enter an email address like orders@example.com',
    ),
    phone: optionalText(50),
    currencyCode: CURRENCY_CODE.optional(),
    leadTimeDays: Days.nullable().optional(),
    notes: optionalText(2000),
  })
  .strict();
const SupplierPatch = SupplierBody.partial().strict();
const SupplierListQuery = z.object({ archived: z.enum(['true', 'false']).default('false') });

const SupplierItemBody = z
  .object({
    supplierSku: optionalText(100),
    unitCost: Money.nullable().optional(),
    minOrderQty: Quantity.nullable().optional(),
    packSize: Quantity.nullable().optional(),
    preferred: z.boolean().optional(),
  })
  .strict();

const ItemPurchasingBody = z
  .object({
    supplierId: Id.nullable().optional(),
    leadTimeDays: Days.nullable().optional(),
    reorderCoverDays: z.number().int().min(1).max(365).nullable().optional(),
    reorderEnabled: z.boolean().optional(),
  })
  .strict();

const ItemSearchQuery = z.object({
  search: z.string().trim().max(200).optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const LineBody = z
  .object({
    id: Id.optional(),
    itemId: Id,
    quantityOrdered: Quantity,
    unitCost: Money.optional(),
  })
  .strict();
const OrderFields = {
  warehouseId: Id.optional(),
  currencyCode: CURRENCY_CODE.optional(),
  exchangeRate: Rate.optional(),
  expectedOn: DateOnly.nullable().optional(),
  notes: optionalText(2000),
};
const OrderCreateBody = z
  .object({ supplierId: Id, ...OrderFields, lines: z.array(LineBody).max(500).default([]) })
  .strict();
const OrderPatchBody = z
  .object({
    supplierId: Id.optional(),
    ...OrderFields,
    lines: z.array(LineBody).max(500).optional(),
  })
  .strict();
const OrderListQuery = z.object({
  status: z.enum([...ORDER_STATUSES, 'open', 'all']).default('open'),
  supplierId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const ReceiveBody = z
  .object({
    requestId: z.uuid(),
    note: optionalText(500),
    lines: z
      .array(z.object({ lineId: Id, quantity: Quantity }).strict())
      .min(1)
      .max(500),
    allowOver: z.boolean().optional(),
  })
  .strict();

const ReorderQuery = z.object({
  filter: z.enum(['needed', 'all']).default('needed'),
  // A supplier id, or 'none' for products without one.
  supplierId: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
const DraftOrdersBody = z
  .object({
    lines: z
      .array(z.object({ itemId: Id, quantity: Quantity }).strict())
      .min(1)
      .max(500),
  })
  .strict();

const params = (request: { params: unknown }) => request.params as Record<string, string>;

/** Purchasing and reorder: /api/purchasing/... */
export async function registerPurchasingRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  /** Stock on order or sales pace changed: re-check the reorder alerts soon. */
  const recheckReorder = async () => {
    await enqueueTask(db, 'reorder_check', {});
    deps.onWork?.();
  };
  const orderView = async (orderId: number) => loadOrder(db, orderId, await getSettings(db));
  const supplierView = async (supplierId: number) =>
    loadSupplier(db, supplierId, (await getSettings(db)).baseCurrency);

  // ---- suppliers --------------------------------------------------------------------------------

  app.get('/api/purchasing/suppliers', async (request) => {
    const q = SupplierListQuery.parse(request.query);
    const settings = await getSettings(db);
    return listSuppliers(db, {
      includeArchived: q.archived === 'true',
      baseCurrency: settings.baseCurrency,
    });
  });

  app.post('/api/purchasing/suppliers', async (request, reply) => {
    const body = SupplierBody.parse(request.body);
    const settings = await getSettings(db);
    const id = await createSupplier(db, {
      ...body,
      currencyCode: body.currencyCode ?? settings.baseCurrency,
    });
    return reply.code(201).send(await supplierView(id));
  });

  app.get('/api/purchasing/suppliers/:id', async (request) =>
    supplierView(parseId(params(request).id)),
  );

  app.patch('/api/purchasing/suppliers/:id', async (request) => {
    const id = parseId(params(request).id);
    const body = SupplierPatch.parse(request.body);
    await updateSupplier(db, id, body);
    if (body.leadTimeDays !== undefined) await recheckReorder();
    return supplierView(id);
  });

  app.post('/api/purchasing/suppliers/:id/archive', async (request) => {
    const id = parseId(params(request).id);
    await archiveSupplier(db, id);
    await recheckReorder();
    return supplierView(id);
  });

  app.post('/api/purchasing/suppliers/:id/restore', async (request) => {
    const id = parseId(params(request).id);
    await restoreSupplier(db, id);
    return supplierView(id);
  });

  app.delete('/api/purchasing/suppliers/:id', async (request, reply) => {
    await deleteSupplier(db, parseId(params(request).id));
    await recheckReorder();
    return reply.code(204).send();
  });

  app.get('/api/purchasing/suppliers/:id/items', async (request) => {
    const id = parseId(params(request).id);
    return (await supplierView(id)).items;
  });

  app.get('/api/purchasing/suppliers/:id/items/:itemId', async (request) => {
    const id = parseId(params(request).id);
    const itemId = parseId(params(request).itemId, 'product id');
    const item = (await supplierView(id)).items.find((i) => i.itemId === itemId);
    if (!item) throw notFound('Supplier product');
    return item;
  });

  app.put('/api/purchasing/suppliers/:id/items/:itemId', async (request) => {
    const id = parseId(params(request).id);
    const itemId = parseId(params(request).itemId, 'product id');
    await putSupplierItem(db, id, itemId, SupplierItemBody.parse(request.body));
    await recheckReorder();
    return (await loadSupplierItems(db, id)).find((i) => i.itemId === itemId);
  });

  app.delete('/api/purchasing/suppliers/:id/items/:itemId', async (request, reply) => {
    const id = parseId(params(request).id);
    await deleteSupplierItem(db, id, parseId(params(request).itemId, 'product id'));
    await recheckReorder();
    return reply.code(204).send();
  });

  // ---- items ------------------------------------------------------------------------------------

  app.get('/api/purchasing/items/:itemId', async (request) => {
    const itemId = parseId(params(request).itemId, 'product id');
    return loadItemPurchasing(db, itemId, await getSettings(db));
  });

  app.patch('/api/purchasing/items/:itemId', async (request) => {
    const itemId = parseId(params(request).itemId, 'product id');
    await updateItemPurchasing(db, itemId, ItemPurchasingBody.parse(request.body));
    await recheckReorder();
    return loadItemPurchasing(db, itemId, await getSettings(db));
  });

  app.get('/api/purchasing/item-search', async (request) =>
    searchItemsForOrder(db, ItemSearchQuery.parse(request.query)),
  );

  // ---- purchase orders --------------------------------------------------------------------------

  app.get('/api/purchasing/orders', async (request) =>
    listOrders(db, OrderListQuery.parse(request.query)),
  );

  app.post('/api/purchasing/orders', async (request, reply) => {
    const body = OrderCreateBody.parse(request.body);
    const settings = await getSettings(db);
    const id = await createOrder(db, body, settings);
    return reply.code(201).send(await loadOrder(db, id, settings));
  });

  // GET /orders/:id, and /orders/:id.csv for the spreadsheet.
  app.get('/api/purchasing/orders/:id', async (request, reply) => {
    const raw = params(request).id ?? '';
    const csv = raw.endsWith('.csv');
    const order = await orderView(parseId(csv ? raw.slice(0, -4) : raw));
    if (!csv) return order;
    return reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${order.number}.csv"`)
      .send(orderCsv(order));
  });

  app.patch('/api/purchasing/orders/:id', async (request) => {
    const id = parseId(params(request).id);
    const body = OrderPatchBody.parse(request.body);
    await updateOrder(db, id, body, await getSettings(db));
    if (body.lines !== undefined) await recheckReorder();
    return orderView(id);
  });

  app.delete('/api/purchasing/orders/:id', async (request, reply) => {
    await deleteOrder(db, parseId(params(request).id));
    return reply.code(204).send();
  });

  app.post('/api/purchasing/orders/:id/order', async (request) => {
    const id = parseId(params(request).id);
    await markOrdered(db, id);
    await recheckReorder();
    return orderView(id);
  });

  app.post('/api/purchasing/orders/:id/close', async (request) => {
    const id = parseId(params(request).id);
    await closeOrder(db, id);
    await recheckReorder();
    return orderView(id);
  });

  app.post('/api/purchasing/orders/:id/cancel', async (request) => {
    const id = parseId(params(request).id);
    await cancelOrder(db, id);
    await recheckReorder();
    return orderView(id);
  });

  app.post('/api/purchasing/orders/:id/receive', async (request, reply) => {
    const id = parseId(params(request).id);
    const body = ReceiveBody.parse(request.body);
    const settings = await getSettings(db);
    const result = await receiveOrder(db, id, body, settings);
    // The adjustments, cost pushes and the sync queue are committed: wake the workers.
    deps.onWork?.();
    if (!result.duplicate) await recheckReorder();
    const order = await loadOrder(db, id, settings);
    return reply.code(result.duplicate ? 200 : 201).send({
      receipt: order.receipts.find((r) => r.id === result.receiptId) ?? null,
      order,
      waiting: await waitingItems(db, result.receiptId),
      duplicate: result.duplicate,
    });
  });

  app.post('/api/purchasing/orders/:id/receipts/:receiptId/reverse', async (request) => {
    const id = parseId(params(request).id);
    const receiptId = parseId(params(request).receiptId, 'delivery id');
    const result = await reverseReceipt(db, id, receiptId);
    if (!result.alreadyReversed) {
      deps.onWork?.();
      await recheckReorder();
    }
    return { ...(await orderView(id)), alreadyReversed: result.alreadyReversed };
  });

  // ---- reorder ----------------------------------------------------------------------------------

  app.get('/api/purchasing/reorder', async (request) => {
    const q = ReorderQuery.parse(request.query);
    const settings = await getSettings(db);
    const [all, sales, stores] = await Promise.all([
      loadReorderRows(db, settings),
      db.query<{ any: boolean }>('SELECT EXISTS (SELECT 1 FROM sales_orders) AS any'),
      db.query<{ granted_scopes: string[] | null }>(
        `SELECT granted_scopes FROM stores WHERE status IN ('active', 'error')`,
      ),
    ]);
    const needle = q.search?.toLowerCase();
    const inScope = all.filter(
      (r) =>
        (q.supplierId === undefined ||
          (q.supplierId === 'none' ? r.supplier === null : r.supplier?.id === q.supplierId)) &&
        (!needle ||
          r.sku.toLowerCase().includes(needle) ||
          r.title.toLowerCase().includes(needle) ||
          (r.supplierSku ?? '').toLowerCase().includes(needle)),
    );
    const rows = (q.filter === 'needed' ? inScope.filter((r) => r.needsReorder) : inScope).sort(
      (a, b) =>
        Number(b.needsReorder) - Number(a.needsReorder) ||
        (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
        a.sku.localeCompare(b.sku),
    );
    return {
      total: rows.length,
      page: q.page,
      pageSize: q.pageSize,
      counts: { needed: inScope.filter((r) => r.needsReorder).length, all: inScope.length },
      baseCurrency: settings.baseCurrency,
      settings: {
        alertsEnabled: settings.reorderAlertsEnabled,
        lookbackDays: settings.reorderLookbackDays,
        safetyDays: settings.reorderSafetyDays,
        coverDays: settings.reorderCoverDays,
        defaultLeadTimeDays: settings.reorderDefaultLeadTimeDays,
      },
      sales: {
        recorded: sales.rows[0]!.any,
        // Stores that let Store Sync read their orders (the sales history comes from them).
        storesWithPermission: stores.rows.filter(
          (s) => missingScopes(s.granted_scopes, ['read_orders']).length === 0,
        ).length,
        stores: stores.rows.length,
      },
      rows: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
    };
  });

  app.post('/api/purchasing/reorder/draft-orders', async (request, reply) => {
    const body = DraftOrdersBody.parse(request.body);
    const result = await createDraftOrders(db, body.lines, await getSettings(db));
    return reply.code(201).send(result);
  });
}
