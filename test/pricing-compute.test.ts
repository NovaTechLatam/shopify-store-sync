import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/pool.js';
import type { PriceInputs, PriceRule, PriceRuleRow } from '../src/pricing/compute.js';
import {
  DEFAULT_PRICE_RULE,
  computeTargetPrice,
  roundPrice,
  rowToPriceRule,
} from '../src/pricing/compute.js';
import { TEST_DATABASE_URL, resetDatabase } from './helpers/harness.js';

const rounding = (
  roundMode: PriceRule['roundMode'],
  roundStep: number,
  roundEnding: number,
  roundDirection: PriceRule['roundDirection'],
) => ({ roundMode, roundStep, roundEnding, roundDirection });

const rule = (overrides: Partial<PriceRule> = {}): PriceRule => ({
  ...DEFAULT_PRICE_RULE,
  enabled: true,
  ...overrides,
});

const inputs = (overrides: Partial<PriceInputs> = {}): PriceInputs => ({
  basePrice: 10,
  baseCompareAtPrice: null,
  exchangeRate: 1,
  rule: rule(),
  currencyCode: 'USD',
  override: null,
  ...overrides,
});

describe('roundPrice', () => {
  it('rounds to a price ending (12.34 with step 1, ending 0.90)', () => {
    expect(roundPrice(12.34, rounding('ending', 1, 0.9, 'up'), 'USD')).toBe(12.9);
    expect(roundPrice(12.34, rounding('ending', 1, 0.9, 'nearest'), 'USD')).toBe(11.9);
    expect(roundPrice(12.34, rounding('ending', 1, 0.9, 'down'), 'USD')).toBe(11.9);
    expect(roundPrice(12.5, rounding('ending', 1, 0.99, 'nearest'), 'USD')).toBe(12.99);
  });

  it('rounds to an ending in a currency with big numbers (COP, step 1000, ending 900)', () => {
    const cop = (direction: PriceRule['roundDirection']) =>
      roundPrice(41234, rounding('ending', 1000, 900, direction), 'COP');
    expect(cop('up')).toBe(41900);
    expect(cop('nearest')).toBe(40900);
    expect(cop('down')).toBe(40900);
    expect(roundPrice(41500, rounding('ending', 1000, 900, 'nearest'), 'COP')).toBe(41900);
  });

  it('rounds to a multiple of the step', () => {
    expect(roundPrice(23, rounding('multiple', 5, 0, 'nearest'), 'USD')).toBe(25);
    expect(roundPrice(22.4, rounding('multiple', 5, 0, 'nearest'), 'USD')).toBe(20);
    expect(roundPrice(22.5, rounding('multiple', 5, 0, 'nearest'), 'USD')).toBe(25);
    expect(roundPrice(21, rounding('multiple', 5, 0, 'up'), 'USD')).toBe(25);
    expect(roundPrice(24, rounding('multiple', 5, 0, 'down'), 'USD')).toBe(20);
    expect(roundPrice(12.34, rounding('multiple', 0.05, 0, 'nearest'), 'USD')).toBe(12.35);
    expect(roundPrice(41234, rounding('multiple', 100, 0, 'up'), 'CLP')).toBe(41300);
  });

  it('rounds only to the currency’s decimals in mode none', () => {
    expect(roundPrice(9990.4, rounding('none', 1, 0, 'up'), 'CLP')).toBe(9990);
    expect(roundPrice(9990.5, rounding('none', 1, 0, 'down'), 'CLP')).toBe(9991);
    expect(roundPrice(1501.23, rounding('none', 1, 0, 'nearest'), 'JPY')).toBe(1501);
    expect(roundPrice(12.345, rounding('none', 1, 0, 'nearest'), 'USD')).toBe(12.35);
    expect(roundPrice(1.2345, rounding('none', 1, 0, 'nearest'), 'KWD')).toBe(1.235);
  });

  it('leaves values that are already on a step alone despite floating point noise', () => {
    expect(roundPrice(12.9, rounding('ending', 1, 0.9, 'up'), 'USD')).toBe(12.9);
    expect(roundPrice(12.9, rounding('ending', 1, 0.9, 'down'), 'USD')).toBe(12.9);
    expect(roundPrice(0.1 + 0.2, rounding('multiple', 0.1, 0, 'up'), 'USD')).toBe(0.3);
    expect(roundPrice(12.9, rounding('multiple', 0.1, 0, 'down'), 'USD')).toBe(12.9);
    expect(roundPrice(1.1 * 3, rounding('multiple', 1.1, 0, 'up'), 'USD')).toBe(3.3);
    expect(roundPrice(41900, rounding('ending', 1000, 900, 'up'), 'COP')).toBe(41900);
  });

  it('rounds up instead when rounding down would go below zero', () => {
    expect(roundPrice(0.5, rounding('ending', 1, 0.9, 'down'), 'USD')).toBe(0.9);
    expect(roundPrice(0.5, rounding('ending', 1, 0.9, 'nearest'), 'USD')).toBe(0.9);
    expect(roundPrice(400, rounding('ending', 1000, 900, 'down'), 'COP')).toBe(900);
    expect(roundPrice(-2, rounding('multiple', 5, 0, 'down'), 'USD')).toBe(0);
  });
});

describe('computeTargetPrice', () => {
  it('uses an override whether or not the rule is on', () => {
    const override = { price: 19.5, compareAtPrice: 25 };
    for (const r of [null, rule({ enabled: false }), rule({ multiplier: 3 })]) {
      expect(computeTargetPrice(inputs({ rule: r, override }))).toEqual({
        status: 'ok',
        source: 'override',
        price: 19.5,
        compareAtPrice: 25,
      });
    }
    // Even without a base price.
    expect(computeTargetPrice(inputs({ basePrice: null, override }))).toMatchObject({
      status: 'ok',
      price: 19.5,
    });
  });

  it('drops an override’s compare-at price that is not above the price, and rounds to decimals', () => {
    expect(
      computeTargetPrice(inputs({ override: { price: 20, compareAtPrice: 20 } })),
    ).toMatchObject({ price: 20, compareAtPrice: null });
    expect(
      computeTargetPrice(inputs({ override: { price: 20, compareAtPrice: null } })),
    ).toMatchObject({ price: 20, compareAtPrice: null });
    expect(
      computeTargetPrice(
        inputs({ currencyCode: 'CLP', override: { price: 9990.4, compareAtPrice: 12000.6 } }),
      ),
    ).toMatchObject({ price: 9990, compareAtPrice: 12001 });
  });

  it('has no price when the store has no rule, the rule is off, or there is no base price', () => {
    expect(computeTargetPrice(inputs({ rule: null }))).toEqual({
      status: 'none',
      reason: 'rule_disabled',
    });
    expect(computeTargetPrice(inputs({ rule: rule({ enabled: false }) }))).toEqual({
      status: 'none',
      reason: 'rule_disabled',
    });
    expect(computeTargetPrice(inputs({ basePrice: null }))).toEqual({
      status: 'none',
      reason: 'no_base_price',
    });
    // A disabled rule wins over a missing base price.
    expect(computeTargetPrice(inputs({ basePrice: null, rule: null }))).toEqual({
      status: 'none',
      reason: 'rule_disabled',
    });
  });

  it('converts the base price: base × rate × multiplier + add, then rounds', () => {
    const cop = computeTargetPrice(
      inputs({
        basePrice: 10,
        exchangeRate: 4100,
        currencyCode: 'COP',
        rule: rule({
          multiplier: 1.3,
          roundMode: 'ending',
          roundStep: 1000,
          roundEnding: 900,
          roundDirection: 'up',
          compareAtMode: 'none',
        }),
      }),
    );
    expect(cop).toEqual({ status: 'ok', source: 'rule', price: 53900, compareAtPrice: null });
    expect(computeTargetPrice(inputs({ rule: rule({ addAmount: 2.5 }) }))).toMatchObject({
      price: 12.5,
    });
    expect(
      computeTargetPrice(
        inputs({ basePrice: 10, exchangeRate: 150.123, currencyCode: 'JPY', rule: rule() }),
      ),
    ).toMatchObject({ price: 1501 });
    expect(
      computeTargetPrice(
        inputs({ basePrice: 12.34, rule: rule({ roundMode: 'ending', roundEnding: 0.9 }) }),
      ),
    ).toMatchObject({ price: 11.9 });
  });

  it('never goes below zero', () => {
    expect(
      computeTargetPrice(inputs({ basePrice: 1, rule: rule({ addAmount: -5 }) })),
    ).toMatchObject({ status: 'ok', price: 0 });
  });

  it('computes the compare-at price in each mode', () => {
    const at = (mode: PriceRule['compareAtMode'], extra: Partial<PriceInputs> = {}) =>
      computeTargetPrice(
        inputs({
          basePrice: 10,
          baseCompareAtPrice: 15,
          exchangeRate: 2,
          rule: rule({ compareAtMode: mode, compareAtMarkup: 1.5 }),
          ...extra,
        }),
      );
    expect(at('none')).toMatchObject({ price: 20, compareAtPrice: null });
    expect(at('keep')).toMatchObject({ price: 20, compareAtPrice: 'keep' });
    expect(at('from_base')).toMatchObject({ price: 20, compareAtPrice: 30 });
    expect(at('from_base', { baseCompareAtPrice: null })).toMatchObject({ compareAtPrice: null });
    // Not above the price: no compare-at price.
    expect(at('from_base', { baseCompareAtPrice: 10 })).toMatchObject({ compareAtPrice: null });
    expect(at('from_base', { baseCompareAtPrice: 8 })).toMatchObject({ compareAtPrice: null });
    expect(at('markup')).toMatchObject({ price: 20, compareAtPrice: 30 });
    expect(
      computeTargetPrice(inputs({ rule: rule({ compareAtMode: 'markup', compareAtMarkup: 1 }) })),
    ).toMatchObject({ price: 10, compareAtPrice: null });
  });

  it('rounds the compare-at price with the same rule', () => {
    const r = rule({
      roundMode: 'ending',
      roundStep: 1,
      roundEnding: 0.99,
      roundDirection: 'up',
      compareAtMode: 'markup',
      compareAtMarkup: 1.25,
    });
    // 12.34 → 12.99; 12.99 × 1.25 = 16.2375 → 16.99
    expect(computeTargetPrice(inputs({ basePrice: 12.34, rule: r }))).toEqual({
      status: 'ok',
      source: 'rule',
      price: 12.99,
      compareAtPrice: 16.99,
    });
    const fromBase = rule({ ...r, compareAtMode: 'from_base' });
    expect(
      computeTargetPrice(inputs({ basePrice: 12.34, baseCompareAtPrice: 15.1, rule: fromBase })),
    ).toMatchObject({ price: 12.99, compareAtPrice: 15.99 });
  });
});

describe('rowToPriceRule', () => {
  let db: Db;
  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL, 2);
    await resetDatabase(db);
  });
  afterAll(async () => {
    await db.end();
  });

  it('maps a row, and DEFAULT_PRICE_RULE matches the table defaults', async () => {
    const { rows: stores } = await db.query<{ id: number }>(
      `INSERT INTO stores (name, shop_domain, auth_mode, access_token_enc)
       VALUES ('Brand', 'brand.myshopify.com', 'access_token', 'x') RETURNING id`,
    );
    const { rows } = await db.query<PriceRuleRow>(
      'INSERT INTO price_rules (store_id) VALUES ($1) RETURNING *',
      [stores[0]!.id],
    );
    expect(rowToPriceRule(rows[0]!)).toEqual(DEFAULT_PRICE_RULE);

    const { rows: custom } = await db.query<PriceRuleRow>(
      `UPDATE price_rules SET enabled = true, multiplier = 1.3, add_amount = 0.5,
              round_mode = 'ending', round_step = 1000, round_ending = 900,
              round_direction = 'up', compare_at_mode = 'markup', compare_at_markup = 1.25
        WHERE store_id = $1 RETURNING *`,
      [stores[0]!.id],
    );
    expect(rowToPriceRule(custom[0]!)).toEqual({
      enabled: true,
      multiplier: 1.3,
      addAmount: 0.5,
      roundMode: 'ending',
      roundStep: 1000,
      roundEnding: 900,
      roundDirection: 'up',
      compareAtMode: 'markup',
      compareAtMarkup: 1.25,
    });
    // Numeric strings (e.g. from JSON) work too.
    expect(rowToPriceRule({ ...custom[0]!, multiplier: '1.300000' }).multiplier).toBe(1.3);
  });
});
