import { lockCatalog, startUnsoldAtZero } from '../catalog/catalog.js';
import type { Db, DbClient, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { HttpError, badRequest, conflict, notFound } from '../http/errors.js';
import { reportToday, type Settings } from '../settings.js';
import { enqueuePoolLevels } from '../sync/queue.js';
import { enqueueTask } from '../tasks/queue.js';
import { roundMoney, toMoneyString } from '../util/money.js';
import { nextItemCost, toBaseCost } from './costs.js';
import { toCsv } from './csv.js';

/**
 * Purchase orders: draft → ordered → partial → received; ordered/partial → closed (the rest isn't
 * coming); draft/ordered → cancelled (only while nothing was received). Every status change is
 * checked here, on a row locked for the transaction, so two clicks (or two people) can't take an
 * order down two paths at once.
 *
 * Receiving books the units into the shared stock with `pool_adjustments` ('adjust', event kind
 * 'po_received'); the sync engine applies them and updates every store.
 */

export type OrderStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'closed' | 'cancelled';
export const ORDER_STATUSES: OrderStatus[] = [
  'draft',
  'ordered',
  'partial',
  'received',
  'closed',
  'cancelled',
];
/** Orders whose remaining units are still expected ("on order"). */
export const OPEN_STATUSES: OrderStatus[] = ['ordered', 'partial'];

export interface OrderLineInput {
  /** An existing line (updates); omitted = matched by item, or a new line. */
  id?: number;
  itemId: number;
  quantityOrdered: number;
  /** Order currency. Omitted on a new line = the supplier's price, else the item cost × rate. */
  unitCost?: number;
}

export interface OrderInput {
  supplierId?: number;
  warehouseId?: number;
  currencyCode?: string;
  exchangeRate?: number;
  expectedOn?: string | null;
  notes?: string | null;
  lines?: OrderLineInput[];
}

interface OrderRow {
  id: number;
  number: string;
  status: OrderStatus;
  supplier_id: number;
  supplier_name: string;
  warehouse_id: number;
  currency_code: string;
  exchange_rate: number;
}

interface LineRow {
  id: number;
  item_id: number;
  sku: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost: number;
  /** A delivery was booked on the line (maybe undone since). */
  has_deliveries: boolean;
}

const STATUS_WORDS: Record<OrderStatus, string> = {
  draft: 'is a draft',
  ordered: 'is ordered',
  partial: 'is partly received',
  received: 'is fully received',
  closed: 'is closed',
  cancelled: 'was cancelled',
};

/** Locks the order for the rest of the transaction. */
async function lockOrder(client: Queryable, orderId: number): Promise<OrderRow> {
  const { rows } = await client.query<OrderRow>(
    `SELECT po.id, po.number, po.status, po.supplier_id, s.name AS supplier_name, po.warehouse_id,
            po.currency_code, po.exchange_rate
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.id = $1
        FOR UPDATE OF po`,
    [orderId],
  );
  if (!rows[0]) throw notFound('Purchase order');
  return rows[0];
}

async function lockLines(client: Queryable, orderId: number): Promise<LineRow[]> {
  const { rows } = await client.query<LineRow>(
    `SELECT l.id, l.item_id, i.sku, l.quantity_ordered, l.quantity_received, l.unit_cost,
            EXISTS (SELECT 1 FROM po_receipt_lines rl WHERE rl.line_id = l.id) AS has_deliveries
       FROM purchase_order_lines l JOIN items i ON i.id = l.item_id
      WHERE l.purchase_order_id = $1
      ORDER BY l.id
        FOR UPDATE OF l`,
    [orderId],
  );
  return rows;
}

/**
 * Locks the items' rows in id order (the order every bulk change of items uses: src/db/locks.ts).
 * Receipts and reversals take these before writing anything else that two of them could share
 * (item costs, the sync queue rows of the items' stock), so two deliveries with the same products,
 * or a delivery and a bulk price edit, wait for each other instead of deadlocking.
 */
async function lockItems(
  client: Queryable,
  itemIds: number[],
): Promise<Map<number, { cost: number | null; syncEnabled: boolean }>> {
  const { rows } = await client.query<{ id: number; cost: number | null; sync_enabled: boolean }>(
    `SELECT id, cost, sync_enabled FROM items WHERE id = ANY($1::bigint[]) ORDER BY id
        FOR NO KEY UPDATE`,
    [itemIds],
  );
  return new Map(rows.map((r) => [r.id, { cost: r.cost, syncEnabled: r.sync_enabled }]));
}

/** The order's number: PO-0001 … PO-9999, then PO-10000 and on. */
async function nextNumber(client: Queryable): Promise<string> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT nextval('purchase_order_number_seq') AS n`,
  );
  return `PO-${String(rows[0]!.n).padStart(4, '0')}`;
}

/**
 * The exchange rate to suggest for an order in `currency` (units of it per 1 base currency): 1 for
 * the base currency, else the rate of the latest order in that currency, else the rate a store
 * that sells in it was given (not the default 1 nobody set: see exchangeRateUnset), else null
 * (the merchant has to enter it).
 */
export async function suggestedExchangeRate(
  db: Queryable,
  currency: string,
  baseCurrency: string,
): Promise<number | null> {
  if (currency === baseCurrency) return 1;
  const { rows } = await db.query<{ rate: number | null }>(
    `SELECT COALESCE(
              (SELECT exchange_rate FROM purchase_orders WHERE currency_code = $1
                ORDER BY created_at DESC, id DESC LIMIT 1),
              (SELECT exchange_rate FROM stores
                WHERE currency_code = $1 AND (exchange_rate <> 1 OR exchange_rate_set_at IS NOT NULL)
                ORDER BY id LIMIT 1)) AS rate`,
    [currency],
  );
  return rows[0]?.rate ?? null;
}

async function defaultWarehouse(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM warehouses ORDER BY id LIMIT 1');
  if (!rows[0]) throw conflict('Add a warehouse first');
  return rows[0].id;
}

async function loadSupplierForOrder(db: Queryable, supplierId: number) {
  const { rows } = await db.query<{
    id: number;
    name: string;
    currency_code: string;
    archived_at: Date | null;
  }>('SELECT id, name, currency_code, archived_at FROM suppliers WHERE id = $1', [supplierId]);
  const supplier = rows[0];
  if (!supplier) throw badRequest('Choose a supplier from the list');
  if (supplier.archived_at) {
    throw conflict(`“${supplier.name}” is archived. Restore it on the Suppliers tab first.`);
  }
  return supplier;
}

async function assertWarehouse(db: Queryable, warehouseId: number): Promise<void> {
  const { rowCount } = await db.query('SELECT 1 FROM warehouses WHERE id = $1', [warehouseId]);
  if (!rowCount) throw badRequest('Choose a warehouse from the list');
}

/**
 * Unit costs for new lines without one, in the order's currency: the supplier's price for the item
 * (when the order is in the supplier's currency), else the item's cost × the order's rate, else 0.
 */
async function defaultUnitCosts(
  db: Queryable,
  order: { supplierId: number; currencyCode: string; exchangeRate: number },
  itemIds: number[],
): Promise<Map<number, number>> {
  const { rows } = await db.query<{
    id: number;
    cost: number | null;
    supplier_cost: number | null;
    supplier_currency: string;
  }>(
    `SELECT i.id, i.cost, si.unit_cost AS supplier_cost, s.currency_code AS supplier_currency
       FROM items i
       CROSS JOIN suppliers s
       LEFT JOIN supplier_items si ON si.supplier_id = s.id AND si.item_id = i.id
      WHERE s.id = $1 AND i.id = ANY($2::bigint[])`,
    [order.supplierId, itemIds],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      r.supplier_cost !== null && r.supplier_currency === order.currencyCode
        ? r.supplier_cost
        : r.cost !== null
          ? roundMoney(r.cost * order.exchangeRate, 4)
          : 0,
    ]),
  );
}

async function assertItems(db: Queryable, itemIds: number[]): Promise<Map<number, string>> {
  const { rows } = await db.query<{ id: number; sku: string }>(
    'SELECT id, sku FROM items WHERE id = ANY($1::bigint[])',
    [itemIds],
  );
  const found = new Map(rows.map((r) => [r.id, r.sku]));
  const missing = itemIds.filter((id) => !found.has(id));
  if (missing.length) {
    throw badRequest(
      `${missing.length === 1 ? 'A product on the order no longer exists' : 'Some products on the order no longer exist'}. Remove ${missing.length === 1 ? 'it' : 'them'} and try again.`,
      { missingItemIds: missing },
    );
  }
  return found;
}

/**
 * Replaces the order's lines with `input` (in that order). Existing lines are matched by id, else
 * by item; lines left out are removed. Lines with received units can't go below what was received.
 * Lines that had a delivery, even one undone since, can't be removed: deleting the line would
 * delete its part of the delivery, and the order's history would lose it.
 */
async function replaceLines(
  client: Queryable,
  order: { id: number; supplierId: number; currencyCode: string; exchangeRate: number },
  input: OrderLineInput[],
): Promise<void> {
  const existing = await lockLines(client, order.id);
  const skus = await assertItems(client, [...new Set(input.map((l) => l.itemId))]);
  const seen = new Set<number>();
  for (const line of input) {
    if (seen.has(line.itemId)) {
      throw badRequest(`${skus.get(line.itemId)} is on the order twice. Keep one line for it.`);
    }
    seen.add(line.itemId);
  }
  const defaults = await defaultUnitCosts(
    client,
    order,
    input.filter((l) => l.unitCost === undefined).map((l) => l.itemId),
  );
  const kept = new Set<number>();
  for (const [position, line] of input.entries()) {
    const match =
      line.id !== undefined
        ? existing.find((l) => l.id === line.id)
        : existing.find((l) => l.item_id === line.itemId);
    if (line.id !== undefined && !match) throw badRequest('A line of this order no longer exists');
    if (match && match.item_id !== line.itemId) {
      throw badRequest('To order another product, remove the line and add a new one');
    }
    if (match) {
      if (line.quantityOrdered < match.quantity_received) {
        throw badRequest(
          `${match.sku}: ${match.quantity_received} were already received, so at least ${match.quantity_received} must stay on the order.`,
        );
      }
      kept.add(match.id);
      await client.query(
        `UPDATE purchase_order_lines
            SET quantity_ordered = $2, unit_cost = COALESCE($3, unit_cost), position = $4
          WHERE id = $1`,
        [match.id, line.quantityOrdered, line.unitCost ?? null, position],
      );
    } else {
      await client.query(
        `INSERT INTO purchase_order_lines (purchase_order_id, item_id, quantity_ordered, unit_cost, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          order.id,
          line.itemId,
          line.quantityOrdered,
          line.unitCost ?? defaults.get(line.itemId) ?? 0,
          position,
        ],
      );
    }
  }
  for (const line of existing) {
    if (kept.has(line.id)) continue;
    if (line.quantity_received > 0) {
      throw badRequest(`${line.sku} can’t be removed: units of it were already received.`);
    }
    if (line.has_deliveries) {
      throw badRequest(
        `${line.sku} can’t be removed: a delivery of it was recorded on this order (and undone). Lower its quantity instead, or close the order when the rest isn’t coming.`,
      );
    }
    await client.query('DELETE FROM purchase_order_lines WHERE id = $1', [line.id]);
  }
}

/** Status after receiving or undoing a delivery, from what each line has received. */
async function receivedStatus(
  client: Queryable,
  orderId: number,
): Promise<'ordered' | 'partial' | 'received'> {
  const { rows } = await client.query<{ any_received: boolean; all_received: boolean }>(
    `SELECT COALESCE(bool_or(quantity_received > 0), false) AS any_received,
            COALESCE(bool_and(quantity_received >= quantity_ordered), false) AS all_received
       FROM purchase_order_lines WHERE purchase_order_id = $1`,
    [orderId],
  );
  const r = rows[0]!;
  return !r.any_received ? 'ordered' : r.all_received ? 'received' : 'partial';
}

export async function createOrder(
  db: Db,
  input: OrderInput & { supplierId: number },
  settings: Settings,
): Promise<number> {
  return withTransaction(db, (client) => insertOrder(client, input, settings));
}

async function insertOrder(
  client: DbClient,
  input: OrderInput & { supplierId: number },
  settings: Settings,
): Promise<number> {
  const supplier = await loadSupplierForOrder(client, input.supplierId);
  const warehouseId = input.warehouseId ?? (await defaultWarehouse(client));
  await assertWarehouse(client, warehouseId);
  const currencyCode = input.currencyCode ?? supplier.currency_code;
  const exchangeRate = resolveRate(currencyCode, input.exchangeRate, settings);
  const number = await nextNumber(client);
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO purchase_orders
       (number, supplier_id, warehouse_id, currency_code, exchange_rate, expected_on, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      number,
      supplier.id,
      warehouseId,
      currencyCode,
      exchangeRate,
      input.expectedOn ?? null,
      input.notes ?? null,
    ],
  );
  const id = rows[0]!.id;
  if (input.lines?.length) {
    await replaceLines(
      client,
      { id, supplierId: supplier.id, currencyCode, exchangeRate },
      input.lines,
    );
  }
  return id;
}

/**
 * The base currency is always 1; another currency needs the rate the merchant entered (the
 * dashboard prefills it with `suggestedExchangeRate`), so a stale rate is never used silently.
 */
function resolveRate(currencyCode: string, given: number | undefined, settings: Settings): number {
  if (currencyCode === settings.baseCurrency) return 1;
  if (given !== undefined) return given;
  throw badRequest(
    `Enter the exchange rate: how many ${currencyCode} make 1 ${settings.baseCurrency}.`,
  );
}

/**
 * Edits an order. Drafts: everything. Ordered or partly received: expected date, notes, lines
 * (quantities never below what was received, unit costs, new lines). Otherwise only the notes.
 */
export async function updateOrder(
  db: Db,
  orderId: number,
  input: OrderInput,
  settings: Settings,
): Promise<void> {
  await withTransaction(db, async (client) => {
    const order = await lockOrder(client, orderId);
    const isDraft = order.status === 'draft';
    const isOpen = OPEN_STATUSES.includes(order.status);
    const draftOnly = (
      ['supplierId', 'warehouseId', 'currencyCode', 'exchangeRate'] as const
    ).filter((key) => input[key] !== undefined);
    if (!isDraft && draftOnly.length) {
      throw conflict(
        `${order.number} ${STATUS_WORDS[order.status]}: its supplier, warehouse and currency can’t change anymore.`,
      );
    }
    if (!isDraft && !isOpen && (input.lines !== undefined || input.expectedOn !== undefined)) {
      throw conflict(`${order.number} ${STATUS_WORDS[order.status]}: only its notes can change.`);
    }

    let supplierId = order.supplier_id;
    let currencyCode = order.currency_code;
    let exchangeRate = order.exchange_rate;
    if (isDraft) {
      if (input.supplierId !== undefined && input.supplierId !== order.supplier_id) {
        supplierId = (await loadSupplierForOrder(client, input.supplierId)).id;
      }
      if (input.warehouseId !== undefined) await assertWarehouse(client, input.warehouseId);
      const newCurrency =
        input.currencyCode !== undefined && input.currencyCode !== order.currency_code;
      if (input.currencyCode !== undefined) currencyCode = input.currencyCode;
      // A new currency needs its own rate; the same one keeps the rate unless a new one is given.
      if (newCurrency || input.exchangeRate !== undefined) {
        exchangeRate = resolveRate(
          currencyCode,
          input.exchangeRate ?? (newCurrency ? undefined : exchangeRate),
          settings,
        );
      }
    }
    await client.query(
      `UPDATE purchase_orders
          SET supplier_id = $2, warehouse_id = COALESCE($3, warehouse_id), currency_code = $4,
              exchange_rate = $5,
              expected_on = CASE WHEN $6::boolean THEN $7::date ELSE expected_on END,
              notes = CASE WHEN $8::boolean THEN $9 ELSE notes END,
              updated_at = now()
        WHERE id = $1`,
      [
        orderId,
        supplierId,
        input.warehouseId ?? null,
        currencyCode,
        exchangeRate,
        input.expectedOn !== undefined,
        input.expectedOn ?? null,
        input.notes !== undefined,
        input.notes ?? null,
      ],
    );
    if (input.lines !== undefined) {
      if (isOpen && input.lines.length === 0) {
        throw badRequest(
          `${order.number} is ordered, so it needs at least one line. Cancel it instead.`,
        );
      }
      await replaceLines(
        client,
        { id: orderId, supplierId, currencyCode, exchangeRate },
        input.lines,
      );
      if (isOpen) {
        const status = await receivedStatus(client, orderId);
        await client.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [
          orderId,
          status,
        ]);
      }
    }
  });
}

/** Draft → ordered. Already ordered (a second click): nothing changes. */
export async function markOrdered(db: Db, orderId: number): Promise<void> {
  await withTransaction(db, async (client) => {
    const order = await lockOrder(client, orderId);
    if (order.status !== 'draft') {
      if (['ordered', 'partial', 'received'].includes(order.status)) return;
      throw conflict(`${order.number} ${STATUS_WORDS[order.status]}, so it can’t be ordered.`);
    }
    const { rows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM purchase_order_lines WHERE purchase_order_id = $1',
      [orderId],
    );
    if (rows[0]!.n === 0) throw badRequest('Add at least one product to the order first');
    await client.query(
      `UPDATE purchase_orders SET status = 'ordered', ordered_at = now(), updated_at = now()
        WHERE id = $1`,
      [orderId],
    );
  });
}

/** Ordered or partly received → closed: whatever wasn't delivered is no longer expected. */
export async function closeOrder(db: Db, orderId: number): Promise<void> {
  await withTransaction(db, async (client) => {
    const order = await lockOrder(client, orderId);
    if (order.status === 'closed') return;
    if (!OPEN_STATUSES.includes(order.status)) {
      throw conflict(
        order.status === 'draft'
          ? `${order.number} is a draft: delete it instead.`
          : `${order.number} ${STATUS_WORDS[order.status]}, so there is nothing left to close.`,
      );
    }
    await client.query(
      `UPDATE purchase_orders SET status = 'closed', closed_at = now(), updated_at = now()
        WHERE id = $1`,
      [orderId],
    );
  });
}

/** Draft or ordered, with nothing received → cancelled. */
export async function cancelOrder(db: Db, orderId: number): Promise<void> {
  await withTransaction(db, async (client) => {
    const order = await lockOrder(client, orderId);
    if (order.status === 'cancelled') return;
    const { rows } = await client.query<{ received: number }>(
      `SELECT COALESCE(sum(quantity_received), 0)::int AS received
         FROM purchase_order_lines WHERE purchase_order_id = $1`,
      [orderId],
    );
    if (!['draft', 'ordered'].includes(order.status) || rows[0]!.received > 0) {
      throw conflict(
        order.status === 'partial' || rows[0]!.received > 0
          ? `Units were already received on ${order.number}, so it can’t be cancelled. Close it instead: the rest is then no longer expected.`
          : `${order.number} ${STATUS_WORDS[order.status]}, so it can’t be cancelled.`,
      );
    }
    await client.query(
      `UPDATE purchase_orders SET status = 'cancelled', closed_at = now(), updated_at = now()
        WHERE id = $1`,
      [orderId],
    );
  });
}

/** Drafts only: nothing was ordered, so nothing is lost. */
export async function deleteOrder(db: Db, orderId: number): Promise<void> {
  await withTransaction(db, async (client) => {
    const order = await lockOrder(client, orderId);
    if (order.status !== 'draft') {
      throw conflict(
        `Only drafts can be deleted, and ${order.number} ${STATUS_WORDS[order.status]}. Cancel or close it instead.`,
      );
    }
    await client.query('DELETE FROM purchase_orders WHERE id = $1', [orderId]);
  });
}

// ---- receiving ----------------------------------------------------------------------------------

export interface ReceiveInput {
  /** Made by the dashboard once per delivery: the same request sent again books nothing new. */
  requestId: string;
  note?: string | null;
  lines: { lineId: number; quantity: number }[];
  /** Receive more than ordered (otherwise refused with how many remain). */
  allowOver?: boolean;
}

export interface ReceiveResult {
  receiptId: number;
  /** The request was already booked: this is the earlier receipt, nothing was added. */
  duplicate: boolean;
  /** Items whose cost changed (base currency). */
  costChanged: number[];
}

export class OverReceiptError extends HttpError {
  constructor(
    message: string,
    readonly lines: { lineId: number; sku: string; remaining: number; quantity: number }[],
  ) {
    super(409, message, { overReceipt: lines });
  }
}

/**
 * Books a delivery, in one transaction: the receipt and its lines, an 'adjust' pool adjustment per
 * line (event 'po_received'), the lines' received quantities, the order's status, the items'
 * costs, then the stock is queued for syncing. A draft is marked ordered first.
 *
 * A pool level that hasn't started (quantity NULL) of an item no store sells yet, without a pending
 * start, gets an `initialize` with value 0 first: a new product starts at 0 plus this delivery as
 * soon as a store sells it. Items that a store sells but that weren't started keep waiting for the
 * merchant to start them (from the onboarding page); the delivery is added then.
 */
export async function receiveOrder(
  db: Db,
  orderId: number,
  input: ReceiveInput,
  settings: Settings,
): Promise<ReceiveResult> {
  try {
    return await withTransaction(db, (client) => receiveLocked(client, orderId, input, settings));
  } catch (err) {
    // The same request id on another order, booked at the same moment (unique index).
    if ((err as { code?: string }).code === '23505' && /request_id/.test(String(err))) {
      throw conflict('This delivery was already recorded on another purchase order.');
    }
    throw err;
  }
}

async function receiveLocked(
  client: DbClient,
  orderId: number,
  input: ReceiveInput,
  settings: Settings,
): Promise<ReceiveResult> {
  // The order's lock serialises deliveries of one order, so a retried request finds the receipt
  // of the first one here (after it committed) instead of booking twice.
  const order = await lockOrder(client, orderId);
  const { rows: earlier } = await client.query<{ id: number; purchase_order_id: number }>(
    'SELECT id, purchase_order_id FROM po_receipts WHERE request_id = $1',
    [input.requestId],
  );
  if (earlier[0]) {
    if (earlier[0].purchase_order_id !== orderId) {
      throw conflict('This delivery was already recorded on another purchase order.');
    }
    return { receiptId: earlier[0].id, duplicate: true, costChanged: [] };
  }
  if (!['draft', 'ordered', 'partial'].includes(order.status)) {
    throw conflict(
      `${order.number} ${STATUS_WORDS[order.status]}, so nothing can be received on it.`,
    );
  }
  if (input.lines.length === 0) throw badRequest('Enter how many units arrived');
  const lineIds = input.lines.map((l) => l.lineId);
  if (new Set(lineIds).size !== lineIds.length) throw badRequest('A line is listed twice');

  const lines = await lockLines(client, orderId);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const wanted = input.lines
    .map((l) => {
      const line = byId.get(l.lineId);
      if (!line) throw badRequest('A line of this delivery isn’t on the order anymore. Reload.');
      return { line, quantity: l.quantity };
    })
    .sort((a, b) => a.line.id - b.line.id);

  if (!input.allowOver) {
    const over = wanted.filter(
      (w) => w.line.quantity_received + w.quantity > w.line.quantity_ordered,
    );
    if (over.length) {
      const details = over.map((w) => ({
        lineId: w.line.id,
        sku: w.line.sku,
        remaining: Math.max(0, w.line.quantity_ordered - w.line.quantity_received),
        quantity: w.quantity,
      }));
      const first = details[0]!;
      throw new OverReceiptError(
        over.length === 1
          ? `Only ${first.remaining} of ${first.sku} ${first.remaining === 1 ? 'remains' : 'remain'} on ${order.number}, and you entered ${first.quantity}. Check the number, or confirm that more arrived than you ordered.`
          : `More than ordered for ${details.map((d) => `${d.sku} (${d.remaining} remaining)`).join(', ')}. Check the numbers, or confirm that more arrived than you ordered.`,
        details,
      );
    }
  }

  const itemIds = wanted.map((w) => w.line.item_id).sort((a, b) => a - b);

  // The item's stock level in the order's warehouse (every item has one per warehouse; created if
  // a warehouse was somehow added without it).
  await client.query(
    `INSERT INTO pool_levels (item_id, warehouse_id)
     SELECT unnest($1::bigint[]), $2 ON CONFLICT DO NOTHING`,
    [itemIds, order.warehouse_id],
  );
  const { rows: levels } = await client.query<{
    id: number;
    item_id: number;
    quantity: number | null;
  }>(
    `SELECT id, item_id, quantity FROM pool_levels
      WHERE item_id = ANY($1::bigint[]) AND warehouse_id = $2`,
    [itemIds, order.warehouse_id],
  );
  const levelOf = new Map(levels.map((l) => [l.item_id, l]));
  // Catalog matching links variants under the catalog lock: hold it while deciding "no store
  // sells it", so a store linking the item right now can't slip in between. Taken before the
  // item rows, in the same order as the catalog's own transactions take them.
  const notStarted = levels.filter((l) => l.quantity === null).map((l) => l.id);
  if (notStarted.length) await lockCatalog(client);

  const items = await lockItems(client, itemIds);
  // The stock the average mixes the delivery with: the started levels plus units added but not
  // applied yet (earlier deliveries of a product no store sells yet, or while syncing is paused).
  // Without them, two deliveries before a launch would leave the cost at the last price.
  const { rows: stock } = await client.query<{ item_id: number; stock: number }>(
    `SELECT pl.item_id, (COALESCE(sum(pl.quantity), 0) + COALESCE(sum(p.value), 0))::int AS stock
       FROM pool_levels pl
       LEFT JOIN LATERAL (
         SELECT sum(pa.value) AS value FROM pool_adjustments pa
          WHERE pa.pool_level_id = pl.id AND pa.kind = 'adjust' AND pa.applied_at IS NULL) p ON true
      WHERE pl.item_id = ANY($1::bigint[])
      GROUP BY pl.item_id`,
    [itemIds],
  );
  const stockBefore = new Map(stock.map((s) => [s.item_id, s.stock]));

  // The same rule as a catalog product's first publish: a product no store sells starts at 0.
  if (notStarted.length) await startUnsoldAtZero(client, { poolLevelIds: notStarted });

  const { rows: receipt } = await client.query<{ id: number }>(
    `INSERT INTO po_receipts (purchase_order_id, request_id, note) VALUES ($1, $2, $3) RETURNING id`,
    [orderId, input.requestId, input.note ?? null],
  );
  const receiptId = receipt[0]!.id;
  const details = {
    purchaseOrderId: orderId,
    number: order.number,
    supplierName: order.supplier_name,
    receiptId,
  };

  const costChanged: number[] = [];
  for (const { line, quantity } of wanted) {
    const level = levelOf.get(line.item_id)!;
    const { rows: adjustment } = await client.query<{ id: number }>(
      `INSERT INTO pool_adjustments (pool_level_id, kind, value, note, event_kind, details)
       VALUES ($1, 'adjust', $2, $3, 'po_received', $4) RETURNING id`,
      [
        level.id,
        quantity,
        `Received ${quantity} on ${order.number} from ${order.supplier_name}`,
        JSON.stringify({ ...details, lineId: line.id, quantity }),
      ],
    );
    await client.query(
      `INSERT INTO po_receipt_lines (receipt_id, line_id, quantity, pool_adjustment_id)
       VALUES ($1, $2, $3, $4)`,
      [receiptId, line.id, quantity, adjustment[0]!.id],
    );
    await client.query(
      'UPDATE purchase_order_lines SET quantity_received = quantity_received + $2 WHERE id = $1',
      [line.id, quantity],
    );
    // A line without a price (0) says nothing about what the item costs: leave the cost alone.
    if (line.unit_cost > 0) {
      const item = items.get(line.item_id)!;
      const cost = nextItemCost({
        method: settings.costMethod,
        oldCost: item.cost,
        stockBefore: stockBefore.get(line.item_id) ?? 0,
        quantity,
        unitCost: toBaseCost(line.unit_cost, order.exchange_rate),
      });
      if (cost !== item.cost) {
        await client.query('UPDATE items SET cost = $2, cost_updated_at = now() WHERE id = $1', [
          line.item_id,
          cost,
        ]);
        costChanged.push(line.item_id);
      }
    }
  }

  const status = await receivedStatus(client, orderId);
  await client.query(
    `UPDATE purchase_orders
        SET status = $2, ordered_at = COALESCE(ordered_at, now()), updated_at = now()
      WHERE id = $1`,
    [orderId, status],
  );

  if (settings.pushCostsToShopify && costChanged.length) {
    const { rows: stores } = await client.query<{ id: number }>(
      `SELECT id FROM stores WHERE status = 'active' ORDER BY id`,
    );
    for (const store of stores) {
      await enqueueTask(
        client,
        'push_item_costs',
        { storeId: store.id, itemIds: costChanged },
        { dedupeKey: `push_item_costs:${store.id}:${receiptId}` },
      );
    }
  }
  // Last: the engine picks the adjustments up as soon as this commits.
  await enqueuePoolLevels(
    client,
    wanted.map((w) => levelOf.get(w.line.item_id)!.id).sort((a, b) => a - b),
    'po_received',
  );
  return { receiptId, duplicate: false, costChanged };
}

/**
 * Items of a receipt whose units can't reach the stores yet, and why: not started (no store
 * sells the item yet, or it wasn't started from the onboarding page) or paused.
 */
export async function waitingItems(
  db: Queryable,
  receiptId: number,
): Promise<{ itemId: number; sku: string; reason: 'not_started' | 'paused' }[]> {
  const { rows } = await db.query<{
    item_id: number;
    sku: string;
    started: boolean;
    sync_enabled: boolean;
  }>(
    `SELECT i.id AS item_id, i.sku, i.sync_enabled, pl.quantity IS NOT NULL AS started
       FROM po_receipt_lines rl
       JOIN purchase_order_lines l ON l.id = rl.line_id
       JOIN purchase_orders po ON po.id = l.purchase_order_id
       JOIN items i ON i.id = l.item_id
       JOIN pool_levels pl ON pl.item_id = i.id AND pl.warehouse_id = po.warehouse_id
      WHERE rl.receipt_id = $1
      ORDER BY i.sku`,
    [receiptId],
  );
  return rows
    .filter((r) => !r.started || !r.sync_enabled)
    .map((r) => ({
      itemId: r.item_id,
      sku: r.sku,
      reason: !r.started ? ('not_started' as const) : ('paused' as const),
    }));
}

/**
 * Undoes a delivery: takes its units out of the shared stock again (an 'adjust' of minus the
 * quantity, event 'po_receipt_reversed'), lowers the lines' received quantities and puts the order
 * back to ordered or partly received (a closed order stays closed). The items' costs are not
 * recalculated: the average can't be unwound exactly once later deliveries are mixed in. Undoing
 * twice changes nothing the second time.
 */
export async function reverseReceipt(
  db: Db,
  orderId: number,
  receiptId: number,
): Promise<{ alreadyReversed: boolean }> {
  return withTransaction(db, async (client) => {
    const order = await lockOrder(client, orderId);
    const { rows: receipts } = await client.query<{ id: number; reversed_at: Date | null }>(
      `SELECT id, reversed_at FROM po_receipts WHERE id = $1 AND purchase_order_id = $2
          FOR UPDATE`,
      [receiptId, orderId],
    );
    const receipt = receipts[0];
    if (!receipt) throw notFound('Delivery');
    if (receipt.reversed_at) return { alreadyReversed: true };

    const { rows: lines } = await client.query<{
      line_id: number;
      quantity: number;
      item_id: number;
      sku: string;
    }>(
      `SELECT rl.line_id, rl.quantity, l.item_id, i.sku
         FROM po_receipt_lines rl
         JOIN purchase_order_lines l ON l.id = rl.line_id
         JOIN items i ON i.id = l.item_id
        WHERE rl.receipt_id = $1
        ORDER BY l.id
          FOR UPDATE OF l`,
      [receiptId],
    );
    const itemIds = lines.map((l) => l.item_id);
    await lockItems(client, itemIds);
    await client.query(
      `INSERT INTO pool_levels (item_id, warehouse_id)
       SELECT unnest($1::bigint[]), $2 ON CONFLICT DO NOTHING`,
      [itemIds, order.warehouse_id],
    );
    const { rows: levels } = await client.query<{ id: number; item_id: number }>(
      `SELECT id, item_id FROM pool_levels WHERE item_id = ANY($1::bigint[]) AND warehouse_id = $2`,
      [itemIds, order.warehouse_id],
    );
    const levelOf = new Map(levels.map((l) => [l.item_id, l.id]));
    const details = {
      purchaseOrderId: orderId,
      number: order.number,
      supplierName: order.supplier_name,
      receiptId,
    };
    for (const line of lines) {
      await client.query(
        `INSERT INTO pool_adjustments (pool_level_id, kind, value, note, event_kind, details)
         VALUES ($1, 'adjust', $2, $3, 'po_receipt_reversed', $4)`,
        [
          levelOf.get(line.item_id),
          -line.quantity,
          `Undid the delivery of ${line.quantity} on ${order.number} from ${order.supplier_name}`,
          JSON.stringify({ ...details, lineId: line.line_id, quantity: line.quantity }),
        ],
      );
      await client.query(
        `UPDATE purchase_order_lines SET quantity_received = quantity_received - $2 WHERE id = $1`,
        [line.line_id, line.quantity],
      );
    }
    await client.query('UPDATE po_receipts SET reversed_at = now() WHERE id = $1', [receiptId]);
    const status = order.status === 'closed' ? 'closed' : await receivedStatus(client, orderId);
    await client.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [
      orderId,
      status,
    ]);
    await enqueuePoolLevels(
      client,
      [...levelOf.values()].sort((a, b) => a - b),
      'po_receipt_reversed',
    );
    return { alreadyReversed: false };
  });
}

// ---- reading ------------------------------------------------------------------------------------

export interface OrderLineView {
  id: number;
  itemId: number;
  sku: string;
  title: string;
  supplierSku: string | null;
  quantityOrdered: number;
  quantityReceived: number;
  remaining: number;
  unitCost: number;
  lineTotal: number;
  /** The item's stock in the order's warehouse has started syncing. */
  syncing: boolean;
  /** A delivery was recorded on the line (maybe undone since): it can't be removed. */
  hasDeliveries: boolean;
}

export interface OrderView {
  id: number;
  number: string;
  status: OrderStatus;
  supplier: {
    id: number;
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    currencyCode: string;
    archived: boolean;
  };
  warehouse: { id: number; name: string };
  currencyCode: string;
  exchangeRate: number;
  baseCurrency: string;
  expectedOn: string | null;
  overdue: boolean;
  notes: string | null;
  orderedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: OrderLineView[];
  totals: {
    lines: number;
    quantityOrdered: number;
    quantityReceived: number;
    remaining: number;
    /** Order currency. */
    total: number;
    /** Base currency. */
    totalBase: number;
    /** Share of the ordered units received (over-deliveries count up to what was ordered). */
    receivedFraction: number;
  };
  receipts: {
    id: number;
    note: string | null;
    createdAt: Date;
    reversedAt: Date | null;
    units: number;
    lines: { lineId: number; itemId: number; sku: string; title: string; quantity: number }[];
  }[];
  allowed: {
    /** 'full' (draft), 'open' (ordered/partial: dates, notes, lines), 'notes'. */
    edit: 'full' | 'open' | 'notes';
    order: boolean;
    receive: boolean;
    close: boolean;
    cancel: boolean;
    delete: boolean;
  };
}

export async function loadOrder(
  db: Queryable,
  orderId: number,
  settings: Pick<Settings, 'baseCurrency'>,
): Promise<OrderView> {
  const { rows } = await db.query<{
    id: number;
    number: string;
    status: OrderStatus;
    supplier_id: number;
    supplier_name: string;
    contact_name: string | null;
    email: string | null;
    phone: string | null;
    supplier_currency: string;
    supplier_archived: boolean;
    warehouse_id: number;
    warehouse_name: string;
    currency_code: string;
    exchange_rate: number;
    expected_on: string | null;
    overdue: boolean;
    notes: string | null;
    ordered_at: Date | null;
    closed_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT po.id, po.number, po.status, po.supplier_id, s.name AS supplier_name, s.contact_name,
            s.email, s.phone, s.currency_code AS supplier_currency,
            s.archived_at IS NOT NULL AS supplier_archived,
            po.warehouse_id, w.name AS warehouse_name, po.currency_code, po.exchange_rate,
            po.expected_on, (po.expected_on < $2::date AND po.status IN ('ordered', 'partial')) AS overdue,
            po.notes, po.ordered_at, po.closed_at, po.created_at, po.updated_at
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
      WHERE po.id = $1`,
    // Overdue from the day after the expected date, in the report time zone (not the server's).
    [orderId, await reportToday(db)],
  );
  const po = rows[0];
  if (!po) throw notFound('Purchase order');
  const [lines, receipts] = await Promise.all([
    db.query<{
      id: number;
      item_id: number;
      sku: string;
      title: string;
      supplier_sku: string | null;
      quantity_ordered: number;
      quantity_received: number;
      unit_cost: number;
      syncing: boolean;
      has_deliveries: boolean;
    }>(
      `SELECT l.id, l.item_id, i.sku, i.title, si.supplier_sku, l.quantity_ordered,
              l.quantity_received, l.unit_cost,
              COALESCE((SELECT pl.quantity IS NOT NULL FROM pool_levels pl
                         WHERE pl.item_id = l.item_id AND pl.warehouse_id = $2), false) AS syncing,
              EXISTS (SELECT 1 FROM po_receipt_lines rl WHERE rl.line_id = l.id) AS has_deliveries
         FROM purchase_order_lines l
         JOIN items i ON i.id = l.item_id
         LEFT JOIN supplier_items si ON si.supplier_id = $3 AND si.item_id = l.item_id
        WHERE l.purchase_order_id = $1
        ORDER BY l.position, l.id`,
      [orderId, po.warehouse_id, po.supplier_id],
    ),
    db.query<{
      id: number;
      note: string | null;
      created_at: Date;
      reversed_at: Date | null;
      lines: { lineId: number; itemId: number; sku: string; title: string; quantity: number }[];
    }>(
      `SELECT r.id, r.note, r.created_at, r.reversed_at,
              json_agg(json_build_object('lineId', rl.line_id, 'itemId', l.item_id, 'sku', i.sku,
                                         'title', i.title, 'quantity', rl.quantity)
                       ORDER BY l.position, l.id) AS lines
         FROM po_receipts r
         JOIN po_receipt_lines rl ON rl.receipt_id = r.id
         JOIN purchase_order_lines l ON l.id = rl.line_id
         JOIN items i ON i.id = l.item_id
        WHERE r.purchase_order_id = $1
        GROUP BY r.id
        ORDER BY r.created_at DESC, r.id DESC`,
      [orderId],
    ),
  ]);
  const lineViews: OrderLineView[] = lines.rows.map((l) => ({
    id: l.id,
    itemId: l.item_id,
    sku: l.sku,
    title: l.title,
    supplierSku: l.supplier_sku,
    quantityOrdered: l.quantity_ordered,
    quantityReceived: l.quantity_received,
    remaining: Math.max(0, l.quantity_ordered - l.quantity_received),
    unitCost: l.unit_cost,
    lineTotal: roundMoney(l.quantity_ordered * l.unit_cost, 4),
    syncing: l.syncing,
    hasDeliveries: l.has_deliveries,
  }));
  const sum = (f: (l: OrderLineView) => number) => lineViews.reduce((a, l) => a + f(l), 0);
  const quantityOrdered = sum((l) => l.quantityOrdered);
  const total = roundMoney(
    sum((l) => l.lineTotal),
    4,
  );
  const receivedCapped = sum((l) => Math.min(l.quantityReceived, l.quantityOrdered));
  const received = sum((l) => l.quantityReceived);
  const status = po.status;
  return {
    id: po.id,
    number: po.number,
    status,
    supplier: {
      id: po.supplier_id,
      name: po.supplier_name,
      contactName: po.contact_name,
      email: po.email,
      phone: po.phone,
      currencyCode: po.supplier_currency,
      archived: po.supplier_archived,
    },
    warehouse: { id: po.warehouse_id, name: po.warehouse_name },
    currencyCode: po.currency_code,
    exchangeRate: po.exchange_rate,
    baseCurrency: settings.baseCurrency,
    expectedOn: po.expected_on,
    overdue: po.overdue,
    notes: po.notes,
    orderedAt: po.ordered_at,
    closedAt: po.closed_at,
    createdAt: po.created_at,
    updatedAt: po.updated_at,
    lines: lineViews,
    totals: {
      lines: lineViews.length,
      quantityOrdered,
      quantityReceived: received,
      remaining: sum((l) => l.remaining),
      total,
      totalBase: roundMoney(total / po.exchange_rate, 4),
      receivedFraction: quantityOrdered > 0 ? receivedCapped / quantityOrdered : 0,
    },
    receipts: receipts.rows.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.created_at,
      reversedAt: r.reversed_at,
      units: r.lines.reduce((a, l) => a + l.quantity, 0),
      lines: r.lines,
    })),
    allowed: {
      edit: status === 'draft' ? 'full' : OPEN_STATUSES.includes(status) ? 'open' : 'notes',
      order: status === 'draft' && lineViews.length > 0,
      receive: ['draft', 'ordered', 'partial'].includes(status) && lineViews.length > 0,
      close: OPEN_STATUSES.includes(status),
      cancel: ['draft', 'ordered'].includes(status) && received === 0,
      delete: status === 'draft',
    },
  };
}

export interface OrderListQuery {
  status: OrderStatus | 'open' | 'all';
  supplierId?: number;
  search?: string;
  page: number;
  pageSize: number;
}

const STATUS_FILTER: Record<OrderListQuery['status'], OrderStatus[] | null> = {
  all: null,
  open: ['draft', 'ordered', 'partial'],
  draft: ['draft'],
  ordered: ['ordered'],
  partial: ['partial'],
  received: ['received'],
  closed: ['closed'],
  cancelled: ['cancelled'],
};

export async function listOrders(db: Queryable, q: OrderListQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (q.supplierId) add('po.supplier_id = ?', q.supplierId);
  if (q.search) {
    add(
      `(po.number ILIKE ? OR s.name ILIKE ? OR EXISTS (
          SELECT 1 FROM purchase_order_lines l JOIN items i ON i.id = l.item_id
           WHERE l.purchase_order_id = po.id AND (i.sku ILIKE ? OR i.title ILIKE ?)))`,
      `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    );
  }
  // Chip counts follow the supplier and search, not the status itself.
  const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const counts = await db.query<{ status: OrderStatus; n: number }>(
    `SELECT po.status, count(*)::int AS n
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
       ${countWhere} GROUP BY po.status`,
    params,
  );
  const statuses = STATUS_FILTER[q.status];
  if (statuses) add('po.status = ANY(?::text[])', statuses);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${where}`,
    params,
  );
  const { rows } = await db.query<{
    id: number;
    number: string;
    status: OrderStatus;
    supplier_id: number;
    supplier_name: string;
    warehouse_id: number;
    warehouse_name: string;
    currency_code: string;
    exchange_rate: number;
    expected_on: string | null;
    overdue: boolean;
    created_at: Date;
    ordered_at: Date | null;
    updated_at: Date;
    lines: number;
    quantity_ordered: number;
    quantity_received: number;
    received_capped: number;
    total: number;
  }>(
    `SELECT po.id, po.number, po.status, po.supplier_id, s.name AS supplier_name, po.warehouse_id,
            w.name AS warehouse_name, po.currency_code, po.exchange_rate, po.expected_on,
            (po.expected_on < $${params.length + 3}::date AND po.status IN ('ordered', 'partial'))
              AS overdue,
            po.created_at, po.ordered_at, po.updated_at,
            t.lines, t.quantity_ordered, t.quantity_received, t.received_capped, t.total
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS lines,
                COALESCE(sum(quantity_ordered), 0)::int AS quantity_ordered,
                COALESCE(sum(quantity_received), 0)::int AS quantity_received,
                COALESCE(sum(LEAST(quantity_received, quantity_ordered)), 0)::int AS received_capped,
                COALESCE(sum(quantity_ordered * unit_cost), 0) AS total
           FROM purchase_order_lines WHERE purchase_order_id = po.id) t
       ${where}
      ORDER BY po.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize, await reportToday(db)],
  );
  const statusCounts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<
    OrderStatus,
    number
  >;
  for (const c of counts.rows) statusCounts[c.status] = c.n;
  return {
    total: total.rows[0]!.n,
    page: q.page,
    pageSize: q.pageSize,
    counts: {
      ...statusCounts,
      open: statusCounts.draft + statusCounts.ordered + statusCounts.partial,
      all: ORDER_STATUSES.reduce((a, s) => a + statusCounts[s], 0),
    },
    orders: rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      supplier: { id: r.supplier_id, name: r.supplier_name },
      warehouse: { id: r.warehouse_id, name: r.warehouse_name },
      currencyCode: r.currency_code,
      exchangeRate: r.exchange_rate,
      expectedOn: r.expected_on,
      overdue: r.overdue,
      createdAt: r.created_at,
      orderedAt: r.ordered_at,
      updatedAt: r.updated_at,
      lines: r.lines,
      quantityOrdered: r.quantity_ordered,
      quantityReceived: r.quantity_received,
      total: roundMoney(r.total, 4),
      receivedFraction: r.quantity_ordered > 0 ? r.received_capped / r.quantity_ordered : 0,
    })),
  };
}

/** The order as a spreadsheet: one row per line, money in the order's currency. */
export function orderCsv(order: OrderView): string {
  const money = (n: number) => Number(toMoneyString(n, order.currencyCode));
  return toCsv([
    [
      'Order',
      'Supplier',
      'Status',
      'Currency',
      'SKU',
      'Supplier SKU',
      'Product',
      'Ordered',
      'Received',
      'Remaining',
      'Unit cost',
      'Line total',
    ],
    ...order.lines.map((l) => [
      order.number,
      order.supplier.name,
      order.status,
      order.currencyCode,
      l.sku,
      l.supplierSku,
      l.title,
      l.quantityOrdered,
      l.quantityReceived,
      l.remaining,
      money(l.unitCost),
      money(l.lineTotal),
    ]),
  ]);
}

// ---- from reorder suggestions -------------------------------------------------------------------

/**
 * One draft order per preferred supplier for the given items and quantities. Items without a
 * supplier are refused (listed), so nothing is created half way. Orders are in the supplier's
 * currency, at the rate given in `exchangeRates` (units of that currency per 1 base currency),
 * else the suggested one. A currency without either is refused (listed in `exchangeRatesNeeded`,
 * for the dashboard to ask): a made-up rate of 1 would turn every price in it into a wrong cost.
 */
export async function createDraftOrders(
  db: Db,
  lines: { itemId: number; quantity: number }[],
  settings: Settings,
  exchangeRates: Record<string, number> = {},
): Promise<{ orderIds: number[] }> {
  return withTransaction(db, async (client) => {
    const itemIds = [...new Set(lines.map((l) => l.itemId))];
    if (itemIds.length !== lines.length) throw badRequest('A product is listed twice');
    await assertItems(client, itemIds);
    const { rows } = await client.query<{
      id: number;
      sku: string;
      supplier_id: number | null;
      currency_code: string | null;
    }>(
      `SELECT i.id, i.sku, s.id AS supplier_id, s.currency_code
         FROM items i LEFT JOIN suppliers s ON s.id = i.supplier_id AND s.archived_at IS NULL
        WHERE i.id = ANY($1::bigint[]) ORDER BY i.sku`,
      [itemIds],
    );
    const without = rows.filter((r) => r.supplier_id === null);
    if (without.length) {
      throw badRequest(
        `Choose a supplier for ${without.map((r) => r.sku).join(', ')} first, or leave ${without.length === 1 ? 'it' : 'them'} out.`,
        { itemsWithoutSupplier: without.map((r) => r.id) },
      );
    }
    const groups = new Map<number, { currency: string; lines: OrderLineInput[] }>();
    const quantityOf = new Map(lines.map((l) => [l.itemId, l.quantity]));
    for (const r of rows) {
      const group = groups.get(r.supplier_id!) ?? { currency: r.currency_code!, lines: [] };
      group.lines.push({ itemId: r.id, quantityOrdered: quantityOf.get(r.id)! });
      groups.set(r.supplier_id!, group);
    }
    const rates = new Map<string, number>();
    const needed: string[] = [];
    for (const currency of [...new Set([...groups.values()].map((g) => g.currency))].sort()) {
      const rate =
        currency === settings.baseCurrency
          ? 1
          : (exchangeRates[currency] ??
            (await suggestedExchangeRate(client, currency, settings.baseCurrency)));
      if (rate === null) needed.push(currency);
      else rates.set(currency, rate);
    }
    if (needed.length) {
      const base = settings.baseCurrency;
      throw badRequest(
        needed.length === 1
          ? `Enter the exchange rate for the ${needed[0]} order: how many ${needed[0]} make 1 ${base}.`
          : `Enter the exchange rates for the ${needed.join(' and ')} orders: how many of each make 1 ${base}.`,
        { exchangeRatesNeeded: needed, baseCurrency: base },
      );
    }
    const orderIds: number[] = [];
    for (const [supplierId, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      orderIds.push(
        await insertOrder(
          client,
          { supplierId, exchangeRate: rates.get(group.currency)!, lines: group.lines },
          settings,
        ),
      );
    }
    return { orderIds };
  });
}
