import { describe, expect, it } from 'vitest';
import { bulkValue } from '../src/pricing/bulk.js';
import type { PriceRule } from '../src/pricing/compute.js';
import {
  DEFAULT_PRICE_RULE,
  differsFromTarget,
  marginOf,
  salePrice,
} from '../src/pricing/compute.js';
import { parseReason, reasonText } from '../src/pricing/runs.js';

const rule = (overrides: Partial<PriceRule> = {}): PriceRule => ({
  ...DEFAULT_PRICE_RULE,
  enabled: true,
  ...overrides,
});

describe('salePrice', () => {
  it('takes the percentage off and rounds to the currency without a rule', () => {
    expect(salePrice(20, 25, null, 'USD')).toBe(15);
    expect(salePrice(19.99, 10, null, 'USD')).toBe(17.99); // 17.991
    expect(salePrice(41900, 15, null, 'COP')).toBe(35615);
    expect(salePrice(9990, 33, null, 'CLP')).toBe(6693); // 6693.3
    // A rule that is off doesn't round.
    expect(
      salePrice(19.99, 10, rule({ enabled: false, roundMode: 'ending', roundEnding: 0.9 }), 'USD'),
    ).toBe(17.99);
  });

  it('rounds with the store’s rule when it is on', () => {
    const endings = rule({
      roundMode: 'ending',
      roundStep: 1,
      roundEnding: 0.99,
      roundDirection: 'up',
    });
    // 29.99 × 0.8 = 23.992 → the next price ending in .99 up is 24.99.
    expect(salePrice(29.99, 20, endings, 'USD')).toBe(24.99);
    const nearest = { ...endings, roundDirection: 'nearest' as const };
    expect(salePrice(29.99, 20, nearest, 'USD')).toBe(23.99);
  });

  it('never ends up at or above the regular price because of rounding up', () => {
    const endings = rule({
      roundMode: 'ending',
      roundStep: 1,
      roundEnding: 0.9,
      roundDirection: 'up',
    });
    // 12.90 × 0.95 = 12.255 → up to 12.90 (no discount) → down to 11.90.
    expect(salePrice(12.9, 5, endings, 'USD')).toBe(11.9);
    const cop = rule({
      roundMode: 'ending',
      roundStep: 1000,
      roundEnding: 900,
      roundDirection: 'up',
    });
    // 41,900 × 0.99 = 41,481 → up 41,900 (same) → down 40,900.
    expect(salePrice(41900, 1, cop, 'COP')).toBe(40900);
    // 0.90 × 0.9 = 0.81: up gives 0.90 again, down would be −0.10 (so up again): plain 0.81.
    expect(salePrice(0.9, 10, endings, 'USD')).toBe(0.81);
  });

  it('has no sale price when nothing lower above zero exists', () => {
    expect(salePrice(0, 20, null, 'USD')).toBeNull();
    expect(salePrice(1, 10, null, 'CLP')).toBeNull(); // 0.9 pesos → 1
    expect(salePrice(0.01, 50, null, 'USD')).toBeNull();
  });
});

describe('differsFromTarget', () => {
  const ok = (price: number, compareAtPrice: number | null | 'keep' = null) =>
    ({ status: 'ok', source: 'rule', price, compareAtPrice }) as const;

  it('compares at the currency’s decimals', () => {
    expect(differsFromTarget({ price: 12.9, compareAtPrice: null }, ok(12.9), 'USD')).toBe(false);
    expect(differsFromTarget({ price: 12.9001, compareAtPrice: null }, ok(12.9), 'USD')).toBe(
      false,
    );
    expect(differsFromTarget({ price: 12.89, compareAtPrice: null }, ok(12.9), 'USD')).toBe(true);
    expect(differsFromTarget({ price: 41900.4, compareAtPrice: null }, ok(41900), 'CLP')).toBe(
      false,
    );
  });

  it('compares the compare-at price unless the target keeps it', () => {
    expect(differsFromTarget({ price: 10, compareAtPrice: 15 }, ok(10, 15), 'USD')).toBe(false);
    expect(differsFromTarget({ price: 10, compareAtPrice: 15 }, ok(10), 'USD')).toBe(true);
    expect(differsFromTarget({ price: 10, compareAtPrice: null }, ok(10, 15), 'USD')).toBe(true);
    expect(differsFromTarget({ price: 10, compareAtPrice: 99 }, ok(10, 'keep'), 'USD')).toBe(false);
    // 0 is "none" in Shopify's eyes.
    expect(differsFromTarget({ price: 10, compareAtPrice: 0 }, ok(10), 'USD')).toBe(false);
  });

  it('never differs without a known price or a target', () => {
    expect(differsFromTarget(null, ok(10), 'USD')).toBe(false);
    expect(
      differsFromTarget(
        { price: 10, compareAtPrice: null },
        { status: 'none', reason: 'rule_disabled' },
        'USD',
      ),
    ).toBe(false);
  });
});

describe('marginOf', () => {
  it('is the share of the price left after the cost (converted to the store’s currency)', () => {
    expect(marginOf(20, 8, 1)).toBeCloseTo(0.6);
    expect(marginOf(41000, 5, 4100)).toBeCloseTo(0.5);
    expect(marginOf(10, 12, 1)).toBeCloseTo(-0.2);
  });

  it('is unknown without a cost or a price', () => {
    expect(marginOf(20, null, 1)).toBeNull();
    expect(marginOf(null, 5, 1)).toBeNull();
    expect(marginOf(0, 5, 1)).toBeNull();
  });
});

describe('bulkValue', () => {
  const change = (
    op: 'set' | 'percent' | 'add' | 'round',
    value: number | null,
    rounding: Parameters<typeof bulkValue>[1]['rounding'] = null,
  ) => ({ op, value, rounding });

  it('sets, clears, and rounds what it sets to the currency', () => {
    expect(bulkValue(10, change('set', 12.5), 'USD')).toBe(12.5);
    expect(bulkValue(null, change('set', 12.345), 'USD')).toBe(12.35);
    expect(bulkValue(10, change('set', null), 'USD')).toBeNull();
    expect(bulkValue(10, change('set', 41900.6), 'CLP')).toBe(41901);
  });

  it('changes by a percentage or an amount', () => {
    expect(bulkValue(19.99, change('percent', 10), 'USD')).toBe(21.99); // 21.989
    expect(bulkValue(20, change('percent', -15), 'USD')).toBe(17);
    expect(bulkValue(20, change('add', 2.5), 'USD')).toBe(22.5);
    expect(bulkValue(20, change('add', -2.5), 'USD')).toBe(17.5);
  });

  it('rounds afterwards when asked', () => {
    const ending = { mode: 'ending' as const, step: 1, ending: 0.99, direction: 'up' as const };
    expect(bulkValue(19.99, change('percent', 10, ending), 'USD')).toBe(21.99);
    expect(bulkValue(20, change('percent', 10, ending), 'USD')).toBe(22.99);
    expect(bulkValue(23.4, change('round', null, ending), 'USD')).toBe(23.99);
    const multiple = {
      mode: 'multiple' as const,
      step: 5,
      ending: 0,
      direction: 'nearest' as const,
    };
    expect(bulkValue(23, change('round', null, multiple), 'USD')).toBe(25);
  });

  it('leaves empty fields alone for relative changes', () => {
    expect(bulkValue(null, change('percent', 10), 'USD')).toBeUndefined();
    expect(bulkValue(null, change('add', 1), 'USD')).toBeUndefined();
    expect(
      bulkValue(
        null,
        change('round', null, { mode: 'multiple', step: 1, ending: 0, direction: 'up' }),
        'USD',
      ),
    ).toBeUndefined();
  });

  it('reports negative results as they are (the route refuses them)', () => {
    expect(bulkValue(2, change('add', -5), 'USD')).toBe(-3);
    expect(
      bulkValue(
        2,
        change('add', -5, { mode: 'multiple', step: 1, ending: 0, direction: 'up' }),
        'USD',
      ),
    ).toBe(-3);
  });
});

describe('run reasons', () => {
  it('round-trips through the text stored on the run', () => {
    for (const reason of [
      { kind: 'manual' } as const,
      { kind: 'sale_start', scheduleId: 12 } as const,
      { kind: 'sale_end', scheduleId: 12 } as const,
      { kind: 'base_change', scheduleId: 7 } as const,
    ]) {
      expect(parseReason(reasonText(reason))).toEqual(reason);
    }
    expect(reasonText({ kind: 'base_change', scheduleId: 7 })).toBe('schedule:7');
    expect(parseReason('something else')).toEqual({ kind: 'manual' });
  });
});
