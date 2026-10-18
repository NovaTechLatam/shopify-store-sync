import { setAlert } from '../alerts/alerts.js';
import type { Queryable } from '../db/pool.js';
import { loadPace } from '../sales/pace.js';
import { getSettings, reportTimezone, type Settings } from '../settings.js';
import { todayIn } from '../util/time.js';

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
  /**
   * Shared stock available to sell: the sum of the item's started pool levels (can be < 0), plus
   * units added to them and not applied yet (a delivery just received).
   */
  available: number;
  /** Units ordered from suppliers and not received yet (ordered or partly received orders). */
  onOrder: number;
  leadTimeDays: number;
  coverDays: number;
  safetyDays: number;
  /** The preferred supplier's minimum order quantity and pack size for the item. */
  minOrderQty: number | null;
  packSize: number | null;
  /**
   * A reorder alert is open for the item: it stays needed until the stock lasts clearly longer
   * than the line (reorderCloseMargin), so an item right at the line doesn't flap.
   */
  alertOpen?: boolean;
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
 * Extra days of cover an item needs before its open reorder alert closes: the larger of 2 days and
 * 10% of lead time + safety days. Without it, an item right at the line would close and reopen
 * its alert (notifying each time) as the sales window moves by a sale or two.
 */
export function reorderCloseMargin(leadTimeDays: number, safetyDays: number): number {
  return Math.max(2, 0.1 * (leadTimeDays + safetyDays));
}

/**
 * The reorder figures of one item.
 *
 * - velocity = units sold ÷ window days;
 * - it needs a reorder when it sells and (available + on order) lasts no longer than the lead
 *   time plus the safety margin; once its alert is open, until it lasts longer than that plus
 *   reorderCloseMargin (hysteresis);
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
  const line =
    input.leadTimeDays +
    input.safetyDays +
    (input.alertOpen ? reorderCloseMargin(input.leadTimeDays, input.safetyDays) : 0);
  const needsReorder = tidy(position / velocity) <= line;
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

/** Past this many days a stock-out date means nothing (and a JS Date can't hold it for long). */
const STOCKOUT_HORIZON_DAYS = 36_500;

/**
 * The calendar day (YYYY-MM-DD) the stock runs out, `daysLeft` days after `now`, in `timeZone`
 * (the report time zone, like every "today"). null when it doesn't sell, or not within 100 years
 * (millions of units that sell one a month): such a date would overflow Date and break the list.
 */
export function stockoutDate(daysLeft: number | null, now: Date, timeZone = 'UTC'): string | null {
  if (daysLeft === null || !Number.isFinite(daysLeft) || daysLeft > STOCKOUT_HORIZON_DAYS) {
    return null;
  }
  const day = new Date(now.getTime() + Math.floor(daysLeft) * 86_400_000);
  return Number.isNaN(day.getTime()) ? null : todayIn(timeZone, day);
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
  alert_open: boolean;
}

/**
 * The reorder figures of every item that syncs (or of `itemIds`). An item whose reorder alert is
 * open keeps needing a reorder until it clears the line by reorderCloseMargin, so the Reorder tab
 * and the alerts agree.
 *
 * The pace is the one Reports shows (src/sales/pace.ts): the last `reorderLookbackDays`, starting
 * no earlier than the first order we have and than the item's first appearance.
 */
export async function loadReorderRows(
  db: Queryable,
  settings: Settings,
  opts: { now?: Date; itemIds?: number[] } = {},
): Promise<ReorderRow[]> {
  const now = opts.now ?? new Date();
  const timeZone = await reportTimezone(db, settings);
  const { rows } = await db.query<ReorderSqlRow>(
    `SELECT i.id, i.sku, i.title, i.reorder_enabled, i.lead_time_days, i.reorder_cover_days, i.cost,
            sup.id AS supplier_id, sup.name AS supplier_name, sup.currency_code AS supplier_currency,
            sup.lead_time_days AS supplier_lead_time_days,
            si.supplier_sku, si.unit_cost AS supplier_unit_cost, si.min_order_qty, si.pack_size,
            lv.available, lv.started_levels, oo.on_order,
            EXISTS (SELECT 1 FROM alerts a
                     WHERE a.kind = 'reorder' AND a.dedupe_key = 'reorder:' || i.id
                       AND a.resolved_at IS NULL) AS alert_open
       FROM items i
       LEFT JOIN suppliers sup ON sup.id = i.supplier_id AND sup.archived_at IS NULL
       LEFT JOIN supplier_items si ON si.supplier_id = sup.id AND si.item_id = i.id
       -- Units added but not applied to the stock yet (a delivery the sync engine hasn't reached,
       -- or syncing is paused) count: they are on the shelf, and no longer on order.
       CROSS JOIN LATERAL (
         SELECT (sum(pl.quantity) + COALESCE(sum(p.pending) FILTER (WHERE pl.quantity IS NOT NULL), 0))::int
                  AS available,
                count(pl.quantity)::int AS started_levels
           FROM pool_levels pl
           LEFT JOIN LATERAL (
             SELECT sum(pa.value) AS pending FROM pool_adjustments pa
              WHERE pa.pool_level_id = pl.id AND pa.kind = 'adjust' AND pa.applied_at IS NULL) p
             ON true
          WHERE pl.item_id = i.id) lv
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(GREATEST(l.quantity_ordered - l.quantity_received, 0)), 0)::int AS on_order
           FROM purchase_order_lines l
           JOIN purchase_orders po ON po.id = l.purchase_order_id
          WHERE l.item_id = i.id AND po.status IN ('ordered', 'partial')) oo
      WHERE i.sync_enabled AND ($1::bigint[] IS NULL OR i.id = ANY($1::bigint[]))
      ORDER BY i.sku`,
    [opts.itemIds ?? null],
  );
  const pace = await loadPace(db, {
    lookbackDays: settings.reorderLookbackDays,
    now,
    itemIds: rows.map((r) => r.id),
  });
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
    const { unitsSold, windowDays } = pace.get(r.id) ?? { unitsSold: 0, windowDays: 1 };
    const figures = computeReorder({
      unitsSold,
      windowDays,
      available,
      onOrder: r.on_order,
      leadTimeDays,
      coverDays,
      safetyDays: settings.reorderSafetyDays,
      minOrderQty: r.min_order_qty,
      packSize: r.pack_size,
      alertOpen: r.alert_open,
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
      unitsSold,
      windowDays,
      onOrder: r.on_order,
      leadTimeDays,
      leadTimeSource,
      coverDays,
      stockoutOn: stockKnown ? stockoutDate(figures.daysLeft, now, timeZone) : null,
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
 * number of times: an open alert is only updated (and not notified again), and stays open until
 * the item clears the line by a margin (see computeReorder).
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
