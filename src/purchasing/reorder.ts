import { setAlert } from '../alerts/alerts.js';
import type { Queryable } from '../db/pool.js';
import { getSettings, type Settings } from '../settings.js';

/**
 * Reorder planning: how fast each item sells (all stores together), how long the shared stock
 * lasts, and how much to order so a delivery arrives in time and covers the next weeks.
 *
 * The maths is the pure `computeReorder`; `loadReorderRows` reads its inputs for every item with
 * one query; `runReorderCheck` keeps the `reorder` alerts in line with the result.
 */

export interface ReorderInputs {
  /** Units sold (after refunds and cancellations) in the sales window. */
  unitsSold: number;
  /** Length of the sales window in days (at least 1). */
  windowDays: number;
  /** Shared stock available to sell: the sum of the item's started pool levels (can be < 0). */
  available: number;
  /** Units ordered from suppliers and not received yet (ordered or partly received orders). */
  onOrder: number;
  leadTimeDays: number;
  coverDays: number;
  safetyDays: number;
  /** The preferred supplier's minimum order quantity and pack size for the item. */
  minOrderQty: number | null;
  packSize: number | null;
}

export interface ReorderFigures {
  /** Units a day. */
  velocity: number;
  /** Days until the stock on hand runs out at that pace; null when it doesn't sell. */
  daysLeft: number | null;
  /** Days that stock on hand plus stock on order last; null when it doesn't sell. */
  coverageDays: number | null;
  needsReorder: boolean;
  /** Units to order now (0 when no order is needed). */
  suggested: number;
}

// Float noise guard: 0.1 × 30 is 3.0000000000000004, which must not round up to 4.
const tidy = (n: number) => Math.round(n * 1e6) / 1e6;

/** At least the minimum order quantity, then up to a whole number of packs. */
export function roundToOrderQuantity(
  quantity: number,
  minOrderQty: number | null,
  packSize: number | null,
): number {
  if (quantity <= 0) return 0;
  let q = Math.ceil(tidy(quantity));
  if (minOrderQty && q < minOrderQty) q = minOrderQty;
  if (packSize && packSize > 1) q = Math.ceil(q / packSize) * packSize;
  return q;
}

/**
 * The reorder figures of one item.
 *
 * - velocity = units sold ÷ window days;
 * - it needs a reorder when it sells and (available + on order) lasts no longer than the lead
 *   time plus the safety margin;
 * - the suggestion brings the stock, once the order arrives, to `coverDays` of sales:
 *   velocity × (lead + cover) − (available + on order), rounded up, at least the supplier's
 *   minimum and in whole packs. When the safety margin is longer than the cover (an unusual
 *   setting), the margin is used instead, so a needed reorder never suggests 0.
 */
export function computeReorder(input: ReorderInputs): ReorderFigures {
  const windowDays = Math.max(1, input.windowDays);
  const velocity = Math.max(0, input.unitsSold) / windowDays;
  if (velocity <= 0) {
    return { velocity: 0, daysLeft: null, coverageDays: null, needsReorder: false, suggested: 0 };
  }
  const position = input.available + input.onOrder;
  const daysLeft = Math.max(0, input.available) / velocity;
  const coverageDays = Math.max(0, position) / velocity;
  const needsReorder = tidy(position / velocity) <= input.leadTimeDays + input.safetyDays;
  if (!needsReorder) return { velocity, daysLeft, coverageDays, needsReorder, suggested: 0 };
  const targetDays = input.leadTimeDays + Math.max(input.coverDays, input.safetyDays);
  const raw = Math.max(1, Math.ceil(tidy(velocity * targetDays - position)));
  return {
    velocity,
    daysLeft,
    coverageDays,
    needsReorder,
    suggested: roundToOrderQuantity(raw, input.minOrderQty, input.packSize),
  };
}

/** The calendar day (YYYY-MM-DD, UTC) the stock runs out, `daysLeft` days after `now`. */
export function stockoutDate(daysLeft: number | null, now: Date): string | null {
  if (daysLeft === null || !Number.isFinite(daysLeft)) return null;
  return new Date(now.getTime() + Math.floor(daysLeft) * 86_400_000).toISOString().slice(0, 10);
}

export type LeadTimeSource = 'item' | 'supplier' | 'default';

export interface ReorderRow extends ReorderFigures {
  itemId: number;
  sku: string;
  title: string;
  reorderEnabled: boolean;
  /** False when no pool level of the item has started syncing: its stock isn't known. */
  stockKnown: boolean;
  available: number;
  unitsSold: number;
  windowDays: number;
  onOrder: number;
  leadTimeDays: number;
  leadTimeSource: LeadTimeSource;
  coverDays: number;
  stockoutOn: string | null;
  supplier: { id: number; name: string; currencyCode: string } | null;
  supplierSku: string | null;
  supplierUnitCost: number | null;
  minOrderQty: number | null;
  packSize: number | null;
  /** The item's unit cost, base currency. */
  cost: number | null;
}

interface ReorderSqlRow {
  id: number;
  sku: string;
  title: string;
  reorder_enabled: boolean;
  lead_time_days: number | null;
  reorder_cover_days: number | null;
  cost: number | null;
  supplier_id: number | null;
  supplier_name: string | null;
  supplier_currency: string | null;
  supplier_lead_time_days: number | null;
  supplier_sku: string | null;
  supplier_unit_cost: number | null;
  min_order_qty: number | null;
  pack_size: number | null;
  available: number | null;
  started_levels: number;
  on_order: number;
  units_sold: number;
  window_days: number;
}

/**
 * The reorder figures of every item that syncs (or of `itemIds`), from one query.
 *
 * The sales window is the last `reorderLookbackDays`, but starts no earlier than the first order
 * we have (any store) and than the item's first appearance (created in Store Sync, or its first
 * recorded sale if that is earlier): a product launched 5 days ago isn't diluted over 30 days,
 * and products that already sold before Store Sync was installed keep their history.
 */
export async function loadReorderRows(
  db: Queryable,
  settings: Settings,
  opts: { now?: Date; itemIds?: number[] } = {},
): Promise<ReorderRow[]> {
  const now = opts.now ?? new Date();
  const { rows } = await db.query<ReorderSqlRow>(
    `WITH bounds AS (
       SELECT $2::timestamptz - make_interval(days => $1) AS lookback_start,
              (SELECT min(processed_at) FROM sales_orders WHERE NOT test) AS first_order
     )
     SELECT i.id, i.sku, i.title, i.reorder_enabled, i.lead_time_days, i.reorder_cover_days, i.cost,
            sup.id AS supplier_id, sup.name AS supplier_name, sup.currency_code AS supplier_currency,
            sup.lead_time_days AS supplier_lead_time_days,
            si.supplier_sku, si.unit_cost AS supplier_unit_cost, si.min_order_qty, si.pack_size,
            lv.available, lv.started_levels, oo.on_order, s.units_sold,
            GREATEST(1, EXTRACT(EPOCH FROM ($2::timestamptz - w.start)) / 86400)::float8 AS window_days
       FROM items i
       CROSS JOIN bounds b
       LEFT JOIN suppliers sup ON sup.id = i.supplier_id AND sup.archived_at IS NULL
       LEFT JOIN supplier_items si ON si.supplier_id = sup.id AND si.item_id = i.id
       CROSS JOIN LATERAL (
         SELECT sum(pl.quantity)::int AS available, count(pl.quantity)::int AS started_levels
           FROM pool_levels pl WHERE pl.item_id = i.id) lv
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(GREATEST(l.quantity_ordered - l.quantity_received, 0)), 0)::int AS on_order
           FROM purchase_order_lines l
           JOIN purchase_orders po ON po.id = l.purchase_order_id
          WHERE l.item_id = i.id AND po.status IN ('ordered', 'partial')) oo
       CROSS JOIN LATERAL (
         SELECT min(processed_at) AS first_sold FROM sales_lines WHERE item_id = i.id) fs
       -- GREATEST/LEAST skip NULLs: no orders at all, or no sale of this item, just don't count.
       CROSS JOIN LATERAL (
         SELECT LEAST(GREATEST(b.lookback_start, b.first_order, LEAST(i.created_at, fs.first_sold)),
                      $2::timestamptz) AS start) w
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(sl.current_quantity), 0)::int AS units_sold
           FROM sales_lines sl
           JOIN sales_orders so ON so.id = sl.order_id
          WHERE sl.item_id = i.id AND sl.processed_at >= w.start AND sl.processed_at <= $2::timestamptz
            AND NOT so.test AND so.cancelled_at IS NULL AND NOT sl.is_gift_card) s
      WHERE i.sync_enabled AND ($3::bigint[] IS NULL OR i.id = ANY($3::bigint[]))
      ORDER BY i.sku`,
    [settings.reorderLookbackDays, now, opts.itemIds ?? null],
  );
  return rows.map((r) => {
    const leadTimeSource: LeadTimeSource =
      r.lead_time_days !== null
        ? 'item'
        : r.supplier_lead_time_days !== null
          ? 'supplier'
          : 'default';
    const leadTimeDays =
      r.lead_time_days ?? r.supplier_lead_time_days ?? settings.reorderDefaultLeadTimeDays;
    const coverDays = r.reorder_cover_days ?? settings.reorderCoverDays;
    const stockKnown = r.started_levels > 0;
    const available = r.available ?? 0;
    const figures = computeReorder({
      unitsSold: r.units_sold,
      windowDays: r.window_days,
      available,
      onOrder: r.on_order,
      leadTimeDays,
      coverDays,
      safetyDays: settings.reorderSafetyDays,
      minOrderQty: r.min_order_qty,
      packSize: r.pack_size,
    });
    // Without a known stock (not started) or with reordering switched off, never suggest one.
    const counts = stockKnown && r.reorder_enabled;
    return {
      ...figures,
      needsReorder: counts && figures.needsReorder,
      suggested: counts ? figures.suggested : 0,
      itemId: r.id,
      sku: r.sku,
      title: r.title,
      reorderEnabled: r.reorder_enabled,
      stockKnown,
      available,
      unitsSold: r.units_sold,
      windowDays: r.window_days,
      onOrder: r.on_order,
      leadTimeDays,
      leadTimeSource,
      coverDays,
      stockoutOn: stockKnown ? stockoutDate(figures.daysLeft, now) : null,
      supplier:
        r.supplier_id !== null
          ? { id: r.supplier_id, name: r.supplier_name!, currencyCode: r.supplier_currency! }
          : null,
      supplierSku: r.supplier_sku,
      supplierUnitCost: r.supplier_unit_cost,
      minOrderQty: r.min_order_qty,
      packSize: r.pack_size,
      cost: r.cost,
    };
  });
}

const perDayFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const countFormat = new Intl.NumberFormat('en-US');
const plural = (n: number, one: string, many = `${one}s`) =>
  `${countFormat.format(n)} ${n === 1 ? one : many}`;

/** The alert text: a sentence that stands on its own in Slack or an email. */
export function reorderMessage(row: ReorderRow): string {
  const pace = `${perDayFormat.format(row.velocity)} a day`;
  const start =
    row.available <= 0
      ? `${row.sku} is out of stock and sells about ${pace}.`
      : row.daysLeft !== null && row.daysLeft < 1
        ? `${row.sku} will run out in less than a day at the current pace (${pace}).`
        : `${row.sku} will run out in about ${plural(Math.floor(row.daysLeft ?? 0), 'day')} at the current pace (${pace}).`;
  const onOrder =
    row.onOrder > 0
      ? ` ${plural(row.onOrder, 'unit')} ${row.onOrder === 1 ? 'is' : 'are'} already on order.`
      : '';
  const order = row.supplier
    ? `Suggested order: ${plural(row.suggested, 'unit')} from ${row.supplier.name}.`
    : `Suggested order: ${plural(row.suggested, 'unit')} (choose a supplier for it).`;
  return `${start}${onOrder} Lead time is ${plural(row.leadTimeDays, 'day')}. ${order}`;
}

/**
 * Opens a `reorder` alert (key `reorder:<itemId>`) for every item that needs ordering and
 * resolves the others; with reorder alerts switched off, resolves them all. Safe to run any
 * number of times: an open alert is only updated (and not notified again).
 */
export async function runReorderCheck(
  db: Queryable,
  opts: { now?: Date } = {},
): Promise<{ open: number; resolved: number }> {
  const settings = await getSettings(db);
  if (!settings.reorderAlertsEnabled) {
    const { rowCount } = await db.query(
      `UPDATE alerts SET resolved_at = now() WHERE kind = 'reorder' AND resolved_at IS NULL`,
    );
    return { open: 0, resolved: rowCount ?? 0 };
  }
  const rows = await loadReorderRows(db, settings, { now: opts.now });
  const needed = rows.filter((r) => r.needsReorder);
  for (const row of needed) {
    await setAlert(db, {
      open: true,
      kind: 'reorder',
      dedupeKey: `reorder:${row.itemId}`,
      itemId: row.itemId,
      message: reorderMessage(row),
      details: {
        suggested: row.suggested,
        daysLeft: row.daysLeft,
        velocity: row.velocity,
        supplierId: row.supplier?.id ?? null,
      },
    });
  }
  const { rowCount } = await db.query(
    `UPDATE alerts SET resolved_at = now()
      WHERE kind = 'reorder' AND resolved_at IS NULL
        AND NOT (dedupe_key = ANY($1::text[]))`,
    [needed.map((r) => `reorder:${r.itemId}`)],
  );
  return { open: needed.length, resolved: rowCount ?? 0 };
}
