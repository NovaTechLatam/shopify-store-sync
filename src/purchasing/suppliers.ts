import type { Queryable } from '../db/pool.js';
import { HttpError, badRequest, conflict, notFound } from '../http/errors.js';
import type { Settings } from '../settings.js';
import { suggestedExchangeRate } from './orders.js';
import { loadReorderRows } from './reorder.js';

/** Suppliers, what each sells us (supplier items), and an item's purchasing settings. */

export interface SupplierInput {
  name?: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  currencyCode?: string;
  leadTimeDays?: number | null;
  notes?: string | null;
}

/** A currency change that would reinterpret the supplier's prices: refused until confirmed. */
export class CurrencyChangeError extends HttpError {
  constructor(message: string, pricedItems: number) {
    super(409, message, { currencyChange: { pricedItems } });
  }
}

interface SupplierRow {
  id: number;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  currency_code: string;
  lead_time_days: number | null;
  notes: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  items: number;
  priced_items: number;
  preferred_items: number;
  open_orders: number;
  orders: number;
}

const SUPPLIER_SELECT = `
  SELECT s.id, s.name, s.contact_name, s.email, s.phone, s.currency_code, s.lead_time_days, s.notes,
         s.archived_at, s.created_at, s.updated_at,
         (SELECT count(*)::int FROM supplier_items si WHERE si.supplier_id = s.id) AS items,
         (SELECT count(*)::int FROM supplier_items si
           WHERE si.supplier_id = s.id AND si.unit_cost IS NOT NULL) AS priced_items,
         (SELECT count(*)::int FROM items i WHERE i.supplier_id = s.id) AS preferred_items,
         (SELECT count(*)::int FROM purchase_orders po
           WHERE po.supplier_id = s.id AND po.status IN ('draft', 'ordered', 'partial')) AS open_orders,
         (SELECT count(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id) AS orders
    FROM suppliers s`;

async function supplierView(db: Queryable, s: SupplierRow, baseCurrency: string) {
  return {
    id: s.id,
    name: s.name,
    contactName: s.contact_name,
    email: s.email,
    phone: s.phone,
    currencyCode: s.currency_code,
    leadTimeDays: s.lead_time_days,
    notes: s.notes,
    archivedAt: s.archived_at,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    itemCount: s.items,
    /** Products with a price from this supplier (in its currency). */
    pricedItemCount: s.priced_items,
    preferredCount: s.preferred_items,
    openOrders: s.open_orders,
    orderCount: s.orders,
    /** Prefills a new order's exchange rate (null: none known, the merchant enters it). */
    exchangeRate: await suggestedExchangeRate(db, s.currency_code, baseCurrency),
  };
}

export async function listSuppliers(
  db: Queryable,
  opts: { includeArchived: boolean; baseCurrency: string },
) {
  const { rows } = await db.query<SupplierRow>(
    `${SUPPLIER_SELECT} ${opts.includeArchived ? '' : 'WHERE s.archived_at IS NULL'}
      ORDER BY s.archived_at IS NOT NULL, lower(s.name), s.id`,
  );
  return Promise.all(rows.map((s) => supplierView(db, s, opts.baseCurrency)));
}

export async function loadSupplier(db: Queryable, supplierId: number, baseCurrency: string) {
  const { rows } = await db.query<SupplierRow>(`${SUPPLIER_SELECT} WHERE s.id = $1`, [supplierId]);
  if (!rows[0]) throw notFound('Supplier');
  return {
    ...(await supplierView(db, rows[0], baseCurrency)),
    items: await loadSupplierItems(db, supplierId),
  };
}

async function assertNameFree(db: Queryable, name: string, exceptId: number | null) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM suppliers WHERE lower(name) = lower($1) AND archived_at IS NULL
        AND ($2::bigint IS NULL OR id <> $2)`,
    [name, exceptId],
  );
  if (rowCount) throw conflict(`A supplier called “${name}” already exists`);
}

export async function createSupplier(
  db: Queryable,
  input: SupplierInput & { name: string; currencyCode: string },
): Promise<number> {
  await assertNameFree(db, input.name, null);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO suppliers (name, contact_name, email, phone, currency_code, lead_time_days, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.name,
      input.contactName ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.currencyCode,
      input.leadTimeDays ?? null,
      input.notes ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function updateSupplier(
  db: Queryable,
  supplierId: number,
  input: SupplierInput,
  opts: { confirmCurrencyChange?: boolean } = {},
): Promise<void> {
  if (input.name !== undefined) await assertNameFree(db, input.name, supplierId);
  // Its prices are numbers in its currency: a new currency changes what they mean, silently.
  // That has to be what the merchant wants (the dialog asks first).
  if (input.currencyCode !== undefined && !opts.confirmCurrencyChange) {
    const { rows } = await db.query<{ name: string; currency_code: string; priced: number }>(
      `SELECT s.name, s.currency_code,
              (SELECT count(*)::int FROM supplier_items si
                WHERE si.supplier_id = s.id AND si.unit_cost IS NOT NULL) AS priced
         FROM suppliers s WHERE s.id = $1`,
      [supplierId],
    );
    const s = rows[0];
    if (!s) throw notFound('Supplier');
    if (s.currency_code !== input.currencyCode && s.priced > 0) {
      const products = s.priced === 1 ? '1 product' : `${s.priced} products`;
      throw new CurrencyChangeError(
        `“${s.name}” has prices for ${products} in ${s.currency_code}. They stay the same numbers, ` +
          `now in ${input.currencyCode} (12.50 ${s.currency_code} becomes 12.50 ` +
          `${input.currencyCode}). Confirm the change, or update the prices first.`,
        s.priced,
      );
    }
  }
  // A NULL-able field is only changed when it was sent (null clears it).
  const set = (key: keyof SupplierInput) => input[key] !== undefined;
  const { rowCount } = await db.query(
    `UPDATE suppliers
        SET name = COALESCE($2, name),
            contact_name = CASE WHEN $3::boolean THEN $4 ELSE contact_name END,
            email = CASE WHEN $5::boolean THEN $6 ELSE email END,
            phone = CASE WHEN $7::boolean THEN $8 ELSE phone END,
            currency_code = COALESCE($9, currency_code),
            lead_time_days = CASE WHEN $10::boolean THEN $11::integer ELSE lead_time_days END,
            notes = CASE WHEN $12::boolean THEN $13 ELSE notes END,
            updated_at = now()
      WHERE id = $1`,
    [
      supplierId,
      input.name ?? null,
      set('contactName'),
      input.contactName ?? null,
      set('email'),
      input.email ?? null,
      set('phone'),
      input.phone ?? null,
      input.currencyCode ?? null,
      set('leadTimeDays'),
      input.leadTimeDays ?? null,
      set('notes'),
      input.notes ?? null,
    ],
  );
  if (!rowCount) throw notFound('Supplier');
}

/**
 * Archives a supplier: it leaves the lists and can't get new orders; its past orders stay. Its
 * products lose it as their preferred supplier (they show under "No supplier" in reorder
 * suggestions until another is chosen). Refused while it has open orders.
 */
export async function archiveSupplier(db: Queryable, supplierId: number): Promise<void> {
  const { rows } = await db.query<{ name: string; open: number }>(
    `SELECT s.name, (SELECT count(*)::int FROM purchase_orders po
                      WHERE po.supplier_id = s.id AND po.status IN ('draft', 'ordered', 'partial')) AS open
       FROM suppliers s WHERE s.id = $1`,
    [supplierId],
  );
  const supplier = rows[0];
  if (!supplier) throw notFound('Supplier');
  if (supplier.open > 0) {
    throw conflict(
      `“${supplier.name}” has ${supplier.open} open ${supplier.open === 1 ? 'order' : 'orders'}. Receive, close or cancel ${supplier.open === 1 ? 'it' : 'them'} first.`,
    );
  }
  await db.query(
    `UPDATE suppliers SET archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE id = $1`,
    [supplierId],
  );
  // Locked in id order like every bulk change of items (src/db/locks.ts), in this one statement.
  await db.query(
    `UPDATE items SET supplier_id = NULL
      WHERE id IN (SELECT id FROM items WHERE supplier_id = $1 ORDER BY id FOR NO KEY UPDATE)`,
    [supplierId],
  );
}

export async function restoreSupplier(db: Queryable, supplierId: number): Promise<void> {
  const { rows } = await db.query<{ name: string }>('SELECT name FROM suppliers WHERE id = $1', [
    supplierId,
  ]);
  if (!rows[0]) throw notFound('Supplier');
  await assertNameFree(db, rows[0].name, supplierId);
  await db.query('UPDATE suppliers SET archived_at = NULL, updated_at = now() WHERE id = $1', [
    supplierId,
  ]);
}

/** Only suppliers that never had an order: the others are archived, to keep the history. */
export async function deleteSupplier(db: Queryable, supplierId: number): Promise<void> {
  const { rows } = await db.query<{ name: string; orders: number }>(
    `SELECT s.name, (SELECT count(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id) AS orders
       FROM suppliers s WHERE s.id = $1`,
    [supplierId],
  );
  if (!rows[0]) throw notFound('Supplier');
  if (rows[0].orders > 0) {
    throw conflict(
      `“${rows[0].name}” has purchase orders, so it can’t be deleted. Archive it instead.`,
    );
  }
  await db.query('DELETE FROM suppliers WHERE id = $1', [supplierId]);
}

// ---- supplier items -----------------------------------------------------------------------------

export interface SupplierItemInput {
  supplierSku?: string | null;
  unitCost?: number | null;
  minOrderQty?: number | null;
  packSize?: number | null;
  /** true: the item's preferred supplier becomes this one; false: no longer this one. */
  preferred?: boolean;
}

export async function loadSupplierItems(db: Queryable, supplierId: number) {
  const { rows } = await db.query<{
    item_id: number;
    sku: string;
    title: string;
    supplier_sku: string | null;
    unit_cost: number | null;
    min_order_qty: number | null;
    pack_size: number | null;
    preferred: boolean;
    cost: number | null;
    updated_at: Date;
  }>(
    `SELECT si.item_id, i.sku, i.title, si.supplier_sku, si.unit_cost, si.min_order_qty,
            si.pack_size, i.supplier_id IS NOT DISTINCT FROM si.supplier_id AS preferred, i.cost,
            si.updated_at
       FROM supplier_items si JOIN items i ON i.id = si.item_id
      WHERE si.supplier_id = $1
      ORDER BY i.sku`,
    [supplierId],
  );
  return rows.map((r) => ({
    itemId: r.item_id,
    sku: r.sku,
    title: r.title,
    supplierSku: r.supplier_sku,
    unitCost: r.unit_cost,
    minOrderQty: r.min_order_qty,
    packSize: r.pack_size,
    preferred: r.preferred,
    cost: r.cost,
    updatedAt: r.updated_at,
  }));
}

/**
 * Adds or updates what a supplier sells us for an item. An item without a preferred supplier gets
 * this one, unless `preferred: false` says otherwise.
 */
export async function putSupplierItem(
  db: Queryable,
  supplierId: number,
  itemId: number,
  input: SupplierItemInput,
): Promise<void> {
  const { rows } = await db.query<{
    archived: boolean | null;
    item_supplier: number | null;
    item: boolean;
  }>(
    `SELECT (SELECT archived_at IS NOT NULL FROM suppliers WHERE id = $1) AS archived,
            (SELECT supplier_id FROM items WHERE id = $2) AS item_supplier,
            EXISTS (SELECT 1 FROM items WHERE id = $2) AS item`,
    [supplierId, itemId],
  );
  const r = rows[0]!;
  if (r.archived === null) throw notFound('Supplier');
  if (!r.item) throw notFound('Product');
  if (r.archived) throw conflict('This supplier is archived. Restore it first.');
  const set = (key: keyof SupplierItemInput) => input[key] !== undefined;
  await db.query(
    `INSERT INTO supplier_items (supplier_id, item_id, supplier_sku, unit_cost, min_order_qty, pack_size)
     VALUES ($1, $2, $4, $6, $8, $10)
     ON CONFLICT (supplier_id, item_id) DO UPDATE
       SET supplier_sku = CASE WHEN $3::boolean THEN EXCLUDED.supplier_sku ELSE supplier_items.supplier_sku END,
           unit_cost = CASE WHEN $5::boolean THEN EXCLUDED.unit_cost ELSE supplier_items.unit_cost END,
           min_order_qty = CASE WHEN $7::boolean THEN EXCLUDED.min_order_qty ELSE supplier_items.min_order_qty END,
           pack_size = CASE WHEN $9::boolean THEN EXCLUDED.pack_size ELSE supplier_items.pack_size END,
           updated_at = now()`,
    [
      supplierId,
      itemId,
      set('supplierSku'),
      input.supplierSku ?? null,
      set('unitCost'),
      input.unitCost ?? null,
      set('minOrderQty'),
      input.minOrderQty ?? null,
      set('packSize'),
      input.packSize ?? null,
    ],
  );
  if (input.preferred === true || (input.preferred === undefined && r.item_supplier === null)) {
    await db.query('UPDATE items SET supplier_id = $2 WHERE id = $1', [itemId, supplierId]);
  } else if (input.preferred === false && r.item_supplier === supplierId) {
    await db.query('UPDATE items SET supplier_id = NULL WHERE id = $1', [itemId]);
  }
}

/** Removes the supplier's details for the item (and the supplier as its preferred one). */
export async function deleteSupplierItem(
  db: Queryable,
  supplierId: number,
  itemId: number,
): Promise<void> {
  const { rowCount } = await db.query(
    'DELETE FROM supplier_items WHERE supplier_id = $1 AND item_id = $2',
    [supplierId, itemId],
  );
  if (!rowCount) throw notFound('Supplier product');
  await db.query('UPDATE items SET supplier_id = NULL WHERE id = $1 AND supplier_id = $2', [
    itemId,
    supplierId,
  ]);
}

// ---- an item's purchasing -----------------------------------------------------------------------

export interface ItemPurchasingInput {
  supplierId?: number | null;
  leadTimeDays?: number | null;
  reorderCoverDays?: number | null;
  reorderEnabled?: boolean;
}

export async function updateItemPurchasing(
  db: Queryable,
  itemId: number,
  input: ItemPurchasingInput,
): Promise<void> {
  if (input.supplierId !== undefined && input.supplierId !== null) {
    const { rows } = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM suppliers WHERE id = $1',
      [input.supplierId],
    );
    if (!rows[0]) throw badRequest('Choose a supplier from the list');
    if (rows[0].archived_at) throw conflict('This supplier is archived. Restore it first.');
  }
  const set = (key: keyof ItemPurchasingInput) => input[key] !== undefined;
  const { rowCount } = await db.query(
    `UPDATE items
        SET supplier_id = CASE WHEN $2::boolean THEN $3::bigint ELSE supplier_id END,
            lead_time_days = CASE WHEN $4::boolean THEN $5::integer ELSE lead_time_days END,
            reorder_cover_days = CASE WHEN $6::boolean THEN $7::integer ELSE reorder_cover_days END,
            reorder_enabled = COALESCE($8, reorder_enabled),
            updated_at = now()
      WHERE id = $1`,
    [
      itemId,
      set('supplierId'),
      input.supplierId ?? null,
      set('leadTimeDays'),
      input.leadTimeDays ?? null,
      set('reorderCoverDays'),
      input.reorderCoverDays ?? null,
      input.reorderEnabled ?? null,
    ],
  );
  if (!rowCount) throw notFound('Product');
}

/** Everything the product page shows about buying an item. */
export async function loadItemPurchasing(db: Queryable, itemId: number, settings: Settings) {
  const { rows } = await db.query<{
    id: number;
    sku: string;
    title: string;
    cost: number | null;
    cost_updated_at: Date | null;
    supplier_id: number | null;
    supplier_name: string | null;
    lead_time_days: number | null;
    reorder_cover_days: number | null;
    reorder_enabled: boolean;
    sync_enabled: boolean;
  }>(
    `SELECT i.id, i.sku, i.title, i.cost, i.cost_updated_at, i.supplier_id, s.name AS supplier_name,
            i.lead_time_days, i.reorder_cover_days, i.reorder_enabled, i.sync_enabled
       FROM items i LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.id = $1`,
    [itemId],
  );
  const item = rows[0];
  if (!item) throw notFound('Product');
  const [reorder, suppliers, orders] = await Promise.all([
    loadReorderRows(db, settings, { itemIds: [itemId] }),
    db.query<{
      supplier_id: number;
      name: string;
      currency_code: string;
      lead_time_days: number | null;
      supplier_sku: string | null;
      unit_cost: number | null;
      min_order_qty: number | null;
      pack_size: number | null;
    }>(
      `SELECT s.id AS supplier_id, s.name, s.currency_code, s.lead_time_days, si.supplier_sku,
              si.unit_cost, si.min_order_qty, si.pack_size
         FROM supplier_items si JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.item_id = $1 AND s.archived_at IS NULL
        ORDER BY lower(s.name)`,
      [itemId],
    ),
    db.query<{
      id: number;
      number: string;
      status: string;
      supplier_name: string;
      expected_on: string | null;
      quantity_ordered: number;
      quantity_received: number;
    }>(
      `SELECT po.id, po.number, po.status, s.name AS supplier_name, po.expected_on,
              l.quantity_ordered, l.quantity_received
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.purchase_order_id
         JOIN suppliers s ON s.id = po.supplier_id
        WHERE l.item_id = $1 AND po.status IN ('draft', 'ordered', 'partial')
        ORDER BY po.expected_on NULLS LAST, po.id`,
      [itemId],
    ),
  ]);
  return {
    itemId: item.id,
    sku: item.sku,
    title: item.title,
    baseCurrency: settings.baseCurrency,
    cost: item.cost,
    costUpdatedAt: item.cost_updated_at,
    costMethod: settings.costMethod,
    supplier: item.supplier_id ? { id: item.supplier_id, name: item.supplier_name! } : null,
    // The item's own settings (null = use the supplier's, then the default).
    leadTimeDays: item.lead_time_days,
    reorderCoverDays: item.reorder_cover_days,
    reorderEnabled: item.reorder_enabled,
    syncEnabled: item.sync_enabled,
    defaults: {
      leadTimeDays: settings.reorderDefaultLeadTimeDays,
      coverDays: settings.reorderCoverDays,
      safetyDays: settings.reorderSafetyDays,
      lookbackDays: settings.reorderLookbackDays,
    },
    /** The reorder figures; null while the item's syncing is paused. */
    reorder: reorder[0] ?? null,
    suppliers: suppliers.rows.map((s) => ({
      supplierId: s.supplier_id,
      name: s.name,
      currencyCode: s.currency_code,
      leadTimeDays: s.lead_time_days,
      supplierSku: s.supplier_sku,
      unitCost: s.unit_cost,
      minOrderQty: s.min_order_qty,
      packSize: s.pack_size,
      preferred: s.supplier_id === item.supplier_id,
    })),
    orders: orders.rows.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      supplierName: o.supplier_name,
      expectedOn: o.expected_on,
      quantityOrdered: o.quantity_ordered,
      quantityReceived: o.quantity_received,
      remaining: Math.max(0, o.quantity_ordered - o.quantity_received),
    })),
  };
}

/** Products for the order editor's picker, with what the chosen supplier charges for them. */
export async function searchItemsForOrder(
  db: Queryable,
  opts: { search?: string; supplierId?: number; limit: number },
) {
  const params: unknown[] = [opts.supplierId ?? null, opts.limit];
  let where = 'TRUE';
  if (opts.search) {
    params.push(`%${opts.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where = `(i.sku ILIKE $3 OR i.title ILIKE $3 OR si.supplier_sku ILIKE $3)`;
  }
  const { rows } = await db.query<{
    id: number;
    sku: string;
    title: string;
    cost: number | null;
    supplier_id: number | null;
    available: number | null;
    started: boolean;
    supplier_sku: string | null;
    supplier_unit_cost: number | null;
    sold_by_supplier: boolean;
  }>(
    `SELECT i.id, i.sku, i.title, i.cost, i.supplier_id,
            (SELECT sum(quantity)::int FROM pool_levels WHERE item_id = i.id) AS available,
            EXISTS (SELECT 1 FROM pool_levels WHERE item_id = i.id AND quantity IS NOT NULL) AS started,
            si.supplier_sku, si.unit_cost AS supplier_unit_cost, si.item_id IS NOT NULL AS sold_by_supplier
       FROM items i
       LEFT JOIN supplier_items si ON si.item_id = i.id AND si.supplier_id = $1
      WHERE ${where}
      ORDER BY si.item_id IS NULL, i.sku
      LIMIT $2`,
    params,
  );
  return rows.map((r) => ({
    itemId: r.id,
    sku: r.sku,
    title: r.title,
    cost: r.cost,
    preferredSupplierId: r.supplier_id,
    available: r.started ? r.available : null,
    supplierSku: r.supplier_sku,
    supplierUnitCost: r.supplier_unit_cost,
    soldBySupplier: r.sold_by_supplier,
  }));
}
