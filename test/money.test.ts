import { describe, expect, it } from 'vitest';
import { CURRENCY_CODE, currencyDecimals, roundMoney, toMoneyString } from '../src/util/money.js';

describe('money', () => {
  it('knows how many decimals each currency is written with', () => {
    expect(currencyDecimals('USD')).toBe(2);
    expect(currencyDecimals('COP')).toBe(2);
    expect(currencyDecimals('CLP')).toBe(0);
    expect(currencyDecimals('JPY')).toBe(0);
    expect(currencyDecimals('KWD')).toBe(3);
    // Unknown or malformed codes fall back to 2.
    expect(currencyDecimals('XYZ')).toBe(2);
    expect(currencyDecimals('not a code')).toBe(2);
  });

  it('rounds half away from zero on the decimal value, not the binary one', () => {
    expect(roundMoney(1.005, 2)).toBe(1.01);
    expect(roundMoney(2.675, 2)).toBe(2.68);
    expect(roundMoney(-1.005, 2)).toBe(-1.01);
    expect(roundMoney(1.004, 2)).toBe(1);
    expect(roundMoney(9990.5, 0)).toBe(9991);
    expect(roundMoney(9990.4, 0)).toBe(9990);
    expect(roundMoney(-9990.5, 0)).toBe(-9991);
    expect(roundMoney(123.456789, 4)).toBe(123.4568);
    expect(roundMoney(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundMoney(1.2345, 3)).toBe(1.235);
    // Tiny and huge values in exponent notation.
    expect(roundMoney(1e-7, 2)).toBe(0);
    expect(roundMoney(1.5e-7, 7)).toBe(2e-7);
    expect(roundMoney(1e21, 2)).toBe(1e21);
    // Never a negative zero (it would print as "-0.00").
    expect(Object.is(roundMoney(-0.004, 2), 0)).toBe(true);
    expect(roundMoney(Number.NaN, 2)).toBeNaN();
  });

  it('formats amounts the way Shopify takes them', () => {
    expect(toMoneyString(12.9, 'USD')).toBe('12.90');
    expect(toMoneyString(0, 'USD')).toBe('0.00');
    expect(toMoneyString(1.005, 'USD')).toBe('1.01');
    expect(toMoneyString(41900, 'CLP')).toBe('41900');
    expect(toMoneyString(41900.5, 'CLP')).toBe('41901');
    expect(toMoneyString(1499.99, 'JPY')).toBe('1500');
    expect(toMoneyString(1.2345, 'KWD')).toBe('1.235');
    expect(toMoneyString(41234.5678, 'COP')).toBe('41234.57');
  });

  it('validates currency codes', () => {
    expect(CURRENCY_CODE.parse('USD')).toBe('USD');
    expect(CURRENCY_CODE.safeParse('usd').success).toBe(false);
    expect(CURRENCY_CODE.safeParse('US').success).toBe(false);
    expect(CURRENCY_CODE.safeParse('USDT').success).toBe(false);
  });
});
