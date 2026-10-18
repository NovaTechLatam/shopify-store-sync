import { currencyDecimals, roundMoney } from '../util/money.js';

/**
 * PRICE COMPUTATION (pure)
 *
 * What a store's price for an item should be, from the item's base price (base currency), the
 * store's exchange rate and price rule, or a fixed price set for that store (an override). Used by
 * the price list, the "update prices in stores" task and catalog publishing, so all of them agree.
 */

/** A store's price rule (`price_rules`, camelCase). See the table's comments for the meaning. */
export interface PriceRule {
  /** false = Store Sync doesn't manage this store's prices (overrides still apply). */
  enabled: boolean;
  multiplier: number;
  /** Added after the multiplier, in the store's currency. */
  addAmount: number;
  roundMode: 'none' | 'ending' | 'multiple';
  roundStep: number;
  /** For 'ending': the price ends in this (step 1, ending 0.90 → 12.90). Below `roundStep`. */
  roundEnding: number;
  roundDirection: 'up' | 'nearest' | 'down';
  /** none = no compare-at price; keep = leave the store's; from_base = base compare-at through the
   *  rule; markup = price × compareAtMarkup. */
  compareAtMode: 'none' | 'keep' | 'from_base' | 'markup';
  compareAtMarkup: number;
}

/** The `price_rules` column defaults: a store without a row behaves like this. */
export const DEFAULT_PRICE_RULE: PriceRule = {
  enabled: false,
  multiplier: 1,
  addAmount: 0,
  roundMode: 'none',
  roundStep: 1,
  roundEnding: 0,
  roundDirection: 'nearest',
  compareAtMode: 'from_base',
  compareAtMarkup: 1,
};

export interface PriceInputs {
  /** Base currency; null = no base price set yet. */
  basePrice: number | null;
  baseCompareAtPrice: number | null;
  /** Units of the store's currency per 1 unit of the base currency. */
  exchangeRate: number;
  /** null = the store has no rule (same as a disabled one). */
  rule: PriceRule | null;
  /** The store's currency (decides the decimals). */
  currencyCode: string;
  /** A fixed price for this item in this store (store currency), instead of the rule. */
  override: { price: number; compareAtPrice: number | null } | null;
}

export type TargetPrice =
  | {
      status: 'ok';
      source: 'override' | 'rule';
      price: number;
      /** null = no compare-at price; 'keep' = leave whatever the store has. */
      compareAtPrice: number | null | 'keep';
    }
  | { status: 'none'; reason: 'rule_disabled' | 'no_base_price' };

type Rounding = Pick<PriceRule, 'roundMode' | 'roundStep' | 'roundEnding' | 'roundDirection'>;

const DIRECTIONS = { up: Math.ceil, nearest: Math.round, down: Math.floor } as const;

/**
 * Rounds a computed price the way the rule says, then to the currency's decimals:
 *   none:     currency decimals only
 *   multiple: step × f(value / step)                  (step 5: 23 → 25 nearest)
 *   ending:   k × step + ending, k = f((value − ending) / step)  (step 1, ending 0.90: 12.34 → 12.90 up)
 * with f = ceil, round or floor for up, nearest, down. Rounding never goes below zero: when down
 * or nearest would (0.30 with ending 0.90: −0.10), it rounds up instead (0.90), rather than
 * leaving a price of 0 for computeTargetPrice to clamp to.
 */
export function roundPrice(value: number, rule: Rounding, currencyCode: string): number {
  const decimals = currencyDecimals(currencyCode);
  if (rule.roundMode === 'none') return roundMoney(value, decimals);
  const step = rule.roundStep;
  const ending = rule.roundMode === 'ending' ? rule.roundEnding : 0;
  // 12.90 / 0.1 is 128.99999999999997 in binary floating point: without snapping, ceil and floor
  // would jump a whole step on values that are already exactly on it.
  const quotient = snap((value - ending) / step);
  let result = DIRECTIONS[rule.roundDirection](quotient) * step + ending;
  if (result < 0) result = Math.ceil(quotient) * step + ending;
  return roundMoney(result, decimals);
}

/** The price an item should have in a store, or why there is none. */
export function computeTargetPrice(input: PriceInputs): TargetPrice {
  const decimals = currencyDecimals(input.currencyCode);
  if (input.override) {
    // A fixed price is used as entered, whether or not the store's rule is on.
    const price = roundMoney(input.override.price, decimals);
    const compareAt = input.override.compareAtPrice;
    return {
      status: 'ok',
      source: 'override',
      price,
      compareAtPrice: compareAtAbove(
        compareAt === null ? null : roundMoney(compareAt, decimals),
        price,
      ),
    };
  }
  const { rule } = input;
  if (!rule || !rule.enabled) return { status: 'none', reason: 'rule_disabled' };
  if (input.basePrice === null) return { status: 'none', reason: 'no_base_price' };

  const convert = (base: number) =>
    Math.max(
      0,
      roundPrice(
        base * input.exchangeRate * rule.multiplier + rule.addAmount,
        rule,
        input.currencyCode,
      ),
    );
  const price = convert(input.basePrice);
  let compareAt: number | null | 'keep';
  switch (rule.compareAtMode) {
    case 'none':
      compareAt = null;
      break;
    case 'keep':
      compareAt = 'keep';
      break;
    case 'from_base':
      compareAt = input.baseCompareAtPrice === null ? null : convert(input.baseCompareAtPrice);
      break;
    case 'markup':
      compareAt = roundPrice(price * rule.compareAtMarkup, rule, input.currencyCode);
      break;
  }
  return {
    status: 'ok',
    source: 'rule',
    price,
    compareAtPrice: compareAt === 'keep' ? 'keep' : compareAtAbove(compareAt, price),
  };
}

/** A `price_rules` row as the database returns it (numeric columns already numbers). */
export interface PriceRuleRow {
  enabled: boolean;
  multiplier: number | string;
  add_amount: number | string;
  round_mode: string;
  round_step: number | string;
  round_ending: number | string;
  round_direction: string;
  compare_at_mode: string;
  compare_at_markup: number | string;
}

export function rowToPriceRule(row: PriceRuleRow): PriceRule {
  return {
    enabled: row.enabled,
    multiplier: Number(row.multiplier),
    addAmount: Number(row.add_amount),
    roundMode: row.round_mode as PriceRule['roundMode'],
    roundStep: Number(row.round_step),
    roundEnding: Number(row.round_ending),
    roundDirection: row.round_direction as PriceRule['roundDirection'],
    compareAtMode: row.compare_at_mode as PriceRule['compareAtMode'],
    compareAtMarkup: Number(row.compare_at_markup),
  };
}

/** A compare-at price only makes sense above the price (Shopify shows no sale otherwise). */
function compareAtAbove(compareAt: number | null, price: number): number | null {
  return compareAt !== null && compareAt > price ? compareAt : null;
}

function snap(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
