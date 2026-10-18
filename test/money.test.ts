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
    expect(Object.is(roundMoney(-0, 2), 0)).toBe(true);
    expect(Object.is(roundMoney(-0.4, 0), 0)).toBe(true);
    expect(roundMoney(Number.NaN, 2)).toBeNaN();
  });

  it('rounds the result of arithmetic as it would be on paper (binary noise ignored)', () => {
    // 2.8249999999999997, 3.0149999999999997, 15.075000000000001 and 4.949999999999999 in floats.
    expect(roundMoney(2.5 * 1.13, 2)).toBe(2.83);
    expect(roundMoney(1.005 * 3, 2)).toBe(3.02);
    expect(roundMoney(-1.005 * 3, 2)).toBe(-3.02);
    expect(roundMoney(10.05 * 1.5, 2)).toBe(15.08);
    expect(roundMoney(3.3 * 1.5, 1)).toBe(5);
    // The 0.005 boundary itself, on both sides.
    expect(roundMoney(0.005, 2)).toBe(0.01);
    expect(roundMoney(0.0049, 2)).toBe(0);
    expect(roundMoney(-0.005, 2)).toBe(-0.01);
    // Big amounts in currencies without (or with many) decimals.
    expect(roundMoney(41234567.5, 0)).toBe(41234568);
    expect(roundMoney(4123.4567 * 12345.67, 2)).toBe(50906835.68);
    expect(roundMoney(99_999_999_999.995, 2)).toBe(100_000_000_000);
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
    expect(toMoneyString(-0, 'USD')).toBe('0.00');
    expect(toMoneyString(-0.004, 'USD')).toBe('0.00');
    expect(toMoneyString(2.5 * 1.13, 'USD')).toBe('2.83');
    expect(toMoneyString(9990.4, 'CLP')).toBe('9990');
    expect(toMoneyString(9990.5, 'JPY')).toBe('9991');
    expect(toMoneyString(123456789.125, 'COP')).toBe('123456789.13');
    expect(toMoneyString(1.0005, 'KWD')).toBe('1.001');
  });

  it('refuses to format something that isn’t an amount', () => {
    expect(() => toMoneyString(Number.NaN, 'USD')).toThrow('Not an amount of money');
    expect(() => toMoneyString(Number.POSITIVE_INFINITY, 'CLP')).toThrow();
  });

  it('validates currency codes', () => {
    expect(CURRENCY_CODE.parse('USD')).toBe('USD');
    expect(CURRENCY_CODE.safeParse('usd').success).toBe(false);
    expect(CURRENCY_CODE.safeParse('US').success).toBe(false);
    expect(CURRENCY_CODE.safeParse('USDT').success).toBe(false);
  });
});
