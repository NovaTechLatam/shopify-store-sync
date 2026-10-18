import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PriceInputs, PriceRule, Rounding, TargetPrice } from '../src/pricing/compute.js';
import { computeTargetPrice, roundPrice } from '../src/pricing/compute.js';
import { roundMoney } from '../src/util/money.js';

/**
 * The dashboard previews prices with its own copy of the rounding (public/js/pricing-compute.js).
 * Both must give the same answers: they are checked against the same examples, and against each
 * other on many generated rules.
 */

interface ClientCompute {
  roundMoney(value: number, decimals: number): number;
  roundPrice(value: number, rule: Rounding, currencyCode: string): number;
  computeTargetPrice(input: PriceInputs): TargetPrice;
}

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/pricing-vectors.json', import.meta.url), 'utf8'),
) as {
  roundMoney: { value: number; decimals: number; expected: number }[];
  roundPrice: { value: number; rule: Rounding; currencyCode: string; expected: number }[];
  computeTargetPrice: { input: PriceInputs; expected: TargetPrice }[];
};

// A variable path: the browser module has no type declarations for TypeScript to resolve.
const clientPath = new URL('../public/js/pricing-compute.js', import.meta.url).href;
const client = (await import(clientPath)) as ClientCompute;

const implementations = [
  ['server', { roundMoney, roundPrice, computeTargetPrice }],
  ['dashboard', client],
] as const;

describe.each(implementations)('price maths (%s)', (_name, impl) => {
  it('rounds money like the examples', () => {
    for (const v of vectors.roundMoney) {
      expect(impl.roundMoney(v.value, v.decimals), `${v.value} @ ${v.decimals}`).toBe(v.expected);
    }
  });

  it('rounds prices like the examples', () => {
    for (const v of vectors.roundPrice) {
      expect(
        impl.roundPrice(v.value, v.rule, v.currencyCode),
        `${v.value} ${JSON.stringify(v.rule)} ${v.currencyCode}`,
      ).toBe(v.expected);
    }
  });

  it('computes target prices like the examples', () => {
    for (const v of vectors.computeTargetPrice) {
      expect(impl.computeTargetPrice(v.input), JSON.stringify(v.input)).toEqual(v.expected);
    }
  });
});

describe('dashboard port', () => {
  it('agrees with the server on generated rules and prices', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const currencies = ['USD', 'EUR', 'COP', 'CLP', 'JPY', 'KWD', 'MXN'];
    const steps = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 100, 1000];
    for (let i = 0; i < 2000; i++) {
      const roundStep = pick(steps);
      const rule: PriceRule = {
        enabled: random() > 0.1,
        multiplier: pick([1, 1.1, 1.13, 1.3, 0.9, 2.5]),
        addAmount: pick([0, 0, 0.5, -1, 1000]),
        roundMode: pick(['none', 'ending', 'multiple'] as const),
        roundStep,
        roundEnding: pick([0, 0.9, 0.99, 0.5]) * roundStep,
        roundDirection: pick(['up', 'nearest', 'down'] as const),
        compareAtMode: pick(['none', 'keep', 'from_base', 'markup'] as const),
        compareAtMarkup: pick([1, 1.2, 1.25, 1.5]),
      };
      const basePrice = random() > 0.05 ? Math.round(random() * 50000) / 100 : null;
      const input: PriceInputs = {
        basePrice,
        baseCompareAtPrice:
          basePrice !== null && random() > 0.5 ? Math.round(basePrice * 130) / 100 : null,
        exchangeRate: pick([1, 0.92, 4100, 950.5, 149.87, 0.307]),
        rule: random() > 0.05 ? rule : null,
        currencyCode: pick(currencies),
        override:
          random() > 0.9
            ? { price: Math.round(random() * 9000) / 100, compareAtPrice: null }
            : null,
      };
      expect(client.computeTargetPrice(input), JSON.stringify(input)).toEqual(
        computeTargetPrice(input),
      );
    }
  });
});
