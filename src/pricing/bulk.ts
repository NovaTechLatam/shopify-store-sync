import { currencyDecimals, roundMoney } from '../util/money.js';
import { roundPrice } from './compute.js';
import type { PriceRule } from './compute.js';

/**
 * BULK EDITS of base prices, compare-at prices and costs (pure): the new value of one item's
 * field. The route applies it to every item in one transaction.
 */

export type BulkOp = 'set' | 'percent' | 'add' | 'round';

/** Rounding of a bulk edit, in the base currency (same modes as a store's price rule). */
export interface BulkRounding {
  mode: 'ending' | 'multiple';
  step: number;
  ending: number;
  direction: PriceRule['roundDirection'];
}

export interface BulkChange {
  op: BulkOp;
  /**
   * set: the new value (null clears the field); percent: the change in percent (10 = +10%,
   * −15 = −15%); add: the amount to add (negative to subtract); round: unused.
   */
  value: number | null;
  /** Applied after the change (required for 'round'). Without it, results are rounded to the
   *  currency's decimals. */
  rounding: BulkRounding | null;
}

/**
 * The field's new value, or `undefined` when the item is left as it is (a relative change of an
 * empty field: there is nothing to change). May be negative: the caller refuses those.
 */
export function bulkValue(
  old: number | null,
  change: BulkChange,
  currencyCode: string,
): number | null | undefined {
  let next: number;
  switch (change.op) {
    case 'set':
      if (change.value === null) return null;
      next = change.value;
      break;
    case 'percent':
      if (old === null || change.value === null) return undefined;
      next = old * (1 + change.value / 100);
      break;
    case 'add':
      if (old === null || change.value === null) return undefined;
      next = old + change.value;
      break;
    case 'round':
      if (old === null) return undefined;
      next = old;
      break;
  }
  // A negative result is reported as such, not rounded up to a price.
  if (next < 0) return next;
  if (change.rounding) {
    return roundPrice(
      next,
      {
        roundMode: change.rounding.mode,
        roundStep: change.rounding.step,
        roundEnding: change.rounding.ending,
        roundDirection: change.rounding.direction,
      },
      currencyCode,
    );
  }
  return roundMoney(next, currencyDecimals(currencyCode));
}
