import type { Queryable } from '../db/pool.js';

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export interface StockState {
  poolLevelId: number;
  itemId: number;
  sku: string;
  /** Shared available quantity after the change. */
  quantity: number;
  /** Item-specific threshold; falls back to the `low_stock_threshold` setting. */
  threshold: number | null;
}

/**
 * Opens or resolves the low-stock and oversold alerts of one item after its shared quantity
 * changed. Alerts are de-duplicated by key: at most one open alert per (kind, pool level).
 */
export async function evaluateStockAlerts(db: Queryable, state: StockState): Promise<void> {
  const threshold = state.threshold ?? (await getDefaultThreshold(db));
  const oversold = state.quantity < 0;
  const low = !oversold && state.quantity <= threshold;

  await setAlert(db, {
    open: oversold,
    kind: 'oversold',
    dedupeKey: `oversold:${state.poolLevelId}`,
    itemId: state.itemId,
    message: `${state.sku} is oversold: shared quantity is ${state.quantity}.`,
    details: { quantity: state.quantity },
  });
  await setAlert(db, {
    open: low,
    kind: 'low_stock',
    dedupeKey: `low_stock:${state.poolLevelId}`,
    itemId: state.itemId,
    message: `${state.sku} is low on stock: ${state.quantity} left (threshold ${threshold}).`,
    details: { quantity: state.quantity, threshold },
  });
}

/**
 * Re-evaluates low-stock and oversold alerts of every initialised pool level from the stored
 * shared quantities (no Shopify calls), e.g. after the default threshold changed.
 */
export async function reevaluateStockAlerts(db: Queryable): Promise<void> {
  const threshold = await getDefaultThreshold(db);
  const levels = `
    SELECT pl.id AS pool_level_id, pl.item_id, i.sku, pl.quantity,
           COALESCE(i.low_stock_threshold, $1::integer) AS threshold
      FROM pool_levels pl JOIN items i ON i.id = pl.item_id
     WHERE pl.quantity IS NOT NULL`;
  for (const kind of ['low_stock', 'oversold'] as const) {
    const condition =
      kind === 'oversold' ? 'l.quantity < 0' : 'l.quantity >= 0 AND l.quantity <= l.threshold';
    await db.query(
      `UPDATE alerts a SET resolved_at = now()
         FROM (${levels}) l
        WHERE a.dedupe_key = '${kind}:' || l.pool_level_id AND a.resolved_at IS NULL AND NOT (${condition})`,
      [threshold],
    );
    const message =
      kind === 'oversold'
        ? `l.sku || ' is oversold: shared quantity is ' || l.quantity || '.'`
        : `l.sku || ' is low on stock: ' || l.quantity || ' left (threshold ' || l.threshold || ').'`;
    await db.query(
      `INSERT INTO alerts (kind, dedupe_key, item_id, message, details)
       SELECT '${kind}', '${kind}:' || l.pool_level_id, l.item_id, ${message},
              json_build_object('quantity', l.quantity, 'threshold', l.threshold)
         FROM (${levels}) l
        WHERE ${condition}
       ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL DO NOTHING`,
      [threshold],
    );
  }
}

export async function setAlert(
  db: Queryable,
  a: {
    open: boolean;
    kind: string;
    dedupeKey: string;
    message: string;
    itemId?: number | null;
    storeId?: number | null;
    details?: unknown;
    /**
     * For alerts about an event (not an ongoing condition): a new occurrence while the alert is
     * still open counts as a new incident, so it is notified again.
     */
    renotify?: boolean;
  },
): Promise<void> {
  if (a.open) {
    await db.query(
      `INSERT INTO alerts (kind, dedupe_key, item_id, store_id, message, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL
       DO UPDATE SET message = EXCLUDED.message, details = EXCLUDED.details,
                     notified_at = CASE WHEN $7 THEN NULL ELSE alerts.notified_at END,
                     created_at = CASE WHEN $7 THEN now() ELSE alerts.created_at END`,
      [
        a.kind,
        a.dedupeKey,
        a.itemId ?? null,
        a.storeId ?? null,
        a.message,
        JSON.stringify(a.details ?? null),
        a.renotify ?? false,
      ],
    );
  } else {
    await db.query(
      'UPDATE alerts SET resolved_at = now() WHERE dedupe_key = $1 AND resolved_at IS NULL',
      [a.dedupeKey],
    );
  }
}

async function getDefaultThreshold(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ value: unknown }>(
    `SELECT value FROM settings WHERE key = 'low_stock_threshold'`,
  );
  const value = rows[0]?.value;
  return typeof value === 'number' && value >= 0 ? value : DEFAULT_LOW_STOCK_THRESHOLD;
}
