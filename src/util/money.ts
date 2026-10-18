import { z } from 'zod';

/**
 * Money helpers. Amounts are plain JS numbers everywhere (numeric columns are parsed to numbers,
 * see src/db/pool.ts); they are rounded to the currency's decimals only when sent to Shopify or
 * shown, so a chain of conversions doesn't accumulate rounding.
 */

/** An ISO 4217 currency code, e.g. 'USD'. */
export const CURRENCY_CODE = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code');

const decimalsCache = new Map<string, number>();

/** Decimals a currency is written with: USD 2, CLP and JPY 0, KWD 3. Unknown codes get 2. */
export function currencyDecimals(code: string): number {
  let decimals = decimalsCache.get(code);
  if (decimals === undefined) {
    decimals = 2;
    try {
      const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
      decimals = format.resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      // Not a well-formed currency code: keep 2.
    }
    decimalsCache.set(code, decimals);
  }
  return decimals;
}

/**
 * Rounds half away from zero to `decimals` places, on the number's decimal representation:
 * 1.005 → 1.01 and 2.675 → 2.68, where `Math.round(x * 100) / 100` and `toFixed` give 1 and 2.67
 * (1.005 is stored as 1.00499999…, and its shortest decimal form is what the merchant typed).
 * Results of arithmetic are first cut to 15 significant digits, which drops the binary noise:
 * 2.5 × 1.13 is 2.8249999999999997 in floating point but 2.825 on paper, so it rounds to 2.83.
 */
export function roundMoney(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const decimal = Number(Math.abs(value).toPrecision(15));
  const magnitude = shift(Math.round(shift(decimal, decimals)), -decimals);
  return magnitude === 0 ? 0 : Math.sign(value) * magnitude;
}

/** Multiplies by 10^by exactly, by moving the exponent of the decimal representation. */
function shift(value: number, by: number): number {
  const [mantissa, exponent = '0'] = String(value).split('e');
  return Number(`${mantissa}e${Number(exponent) + by}`);
}

/** The amount as Shopify's Money/Decimal inputs take it: '12.90', '41900' (CLP). */
export function toMoneyString(value: number, currencyCode: string): string {
  // "NaN" or "Infinity" would reach Shopify as a price: a bug upstream, never a value to send.
  if (!Number.isFinite(value)) throw new Error(`Not an amount of money: ${value}`);
  const decimals = currencyDecimals(currencyCode);
  return roundMoney(value, decimals).toFixed(decimals);
}
