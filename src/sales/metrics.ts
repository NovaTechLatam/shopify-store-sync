/** Figures of the products report, worked out from the sums (pure). */

export interface ProductSums {
  /** Units sold in the period (after refunds). */
  units: number;
  /** Net revenue in the period, base currency. */
  revenue: number;
  /** Σ unit cost × units, of the lines that have a cost (base currency). */
  cost: number;
  /** Net revenue of the lines that have a cost (base currency): what margin is measured on. */
  revenueWithCost: number;
  /** Shared stock now: Σ of the item's started pool levels; null when none is started. */
  stock: number | null;
  /** Units sold in the pace window (all stores; see src/sales/pace.ts). */
  recentUnits: number;
  /** Days the pace window really covers. */
  paceDays: number;
}

export interface ProductFigures {
  /** (revenue − cost) ÷ revenue, on the lines with a cost; null without any. */
  margin: number | null;
  /** Units a day, over the pace window. */
  velocity: number;
  /** Shared stock ÷ units a day; null when it doesn't sell (or isn't stocked). */
  daysLeft: number | null;
  /** Units ÷ (units + stock): how much of what was there sold in the period. */
  sellThrough: number | null;
}

export function productFigures(s: ProductSums): ProductFigures {
  const velocity = s.paceDays > 0 ? s.recentUnits / s.paceDays : 0;
  // Without a shared stock number (not syncing yet, or not one of our products) there is no
  // days-left or sell-through; an oversold (negative) stock counts as none left.
  const onHand = s.stock === null ? null : Math.max(0, s.stock);
  return {
    margin: s.revenueWithCost > 0 ? (s.revenueWithCost - s.cost) / s.revenueWithCost : null,
    velocity,
    daysLeft: onHand !== null && velocity > 0 ? onHand / velocity : null,
    sellThrough: onHand !== null && s.units + onHand > 0 ? s.units / (s.units + onHand) : null,
  };
}

export const PRODUCT_SORTS = ['revenue', 'units', 'margin', 'daysLeft', 'sellThrough'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/**
 * Sorts report rows by a figure; rows without it (no cost, no sales) always go last, whichever
 * the direction. Ties are broken by SKU so pages are stable.
 */
export function sortRows<T extends { sku: string | null } & Record<ProductSort, number | null>>(
  rows: T[],
  sort: ProductSort,
  dir: 'asc' | 'desc',
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort];
    const y = b[sort];
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1;
    } else if (x !== y) {
      return (x - y) * sign;
    }
    return (a.sku ?? '￿').localeCompare(b.sku ?? '￿');
  });
}
