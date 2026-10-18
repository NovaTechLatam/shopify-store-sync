import { describe, expect, it } from 'vitest';
import { nextItemCost, toBaseCost } from '../src/purchasing/costs.js';
import { csvCell, toCsv } from '../src/purchasing/csv.js';
import {
  computeReorder,
  reorderMessage,
  roundToOrderQuantity,
  stockoutDate,
  type ReorderInputs,
  type ReorderRow,
} from '../src/purchasing/reorder.js';

const base: ReorderInputs = {
  unitsSold: 90,
  windowDays: 30,
  available: 30,
  onOrder: 0,
  leadTimeDays: 14,
  coverDays: 30,
  safetyDays: 7,
  minOrderQty: null,
  packSize: null,
};

describe('computeReorder', () => {
  it('measures the pace and how long the stock lasts', () => {
    const r = computeReorder(base);
    expect(r.velocity).toBe(3);
    expect(r.daysLeft).toBe(10);
    expect(r.coverageDays).toBe(10);
  });

  it('needs a reorder when stock and stock on order last no longer than lead time + safety', () => {
    // 3 a day, 63 units = 21 days = 14 lead + 7 safety: exactly at the line.
    expect(computeReorder({ ...base, available: 63 }).needsReorder).toBe(true);
    expect(computeReorder({ ...base, available: 64 }).needsReorder).toBe(false);
    // Stock on order counts: 30 here + 40 coming = 23.3 days.
    expect(computeReorder({ ...base, onOrder: 40 }).needsReorder).toBe(false);
  });

  it('suggests enough for lead time + cover days, minus what is there and on order', () => {
    // 3 × (14 + 30) − 30 = 102
    expect(computeReorder(base).suggested).toBe(102);
    // − 20 on order
    expect(computeReorder({ ...base, onOrder: 20 }).suggested).toBe(82);
    expect(computeReorder({ ...base, available: 64 }).suggested).toBe(0);
  });

  it('rounds the suggestion up to the minimum order and the pack size', () => {
    expect(computeReorder({ ...base, minOrderQty: 150 }).suggested).toBe(150);
    expect(computeReorder({ ...base, packSize: 12 }).suggested).toBe(108);
    // MOQ 100 is not a multiple of the pack: whole packs of at least 100.
    expect(computeReorder({ ...base, minOrderQty: 100, packSize: 24 }).suggested).toBe(120);
  });

  it('never suggests anything for an item that does not sell', () => {
    const r = computeReorder({ ...base, unitsSold: 0, available: 0 });
    expect(r).toEqual({
      velocity: 0,
      daysLeft: null,
      coverageDays: null,
      needsReorder: false,
      suggested: 0,
    });
  });

  it('counts oversold stock against the order, but days left never go below 0', () => {
    const r = computeReorder({ ...base, available: -6 });
    expect(r.daysLeft).toBe(0);
    expect(r.needsReorder).toBe(true);
    expect(r.suggested).toBe(3 * 44 + 6);
  });

  it('uses at least 1 day of window, and guards against float noise', () => {
    // 1 unit sold within a fraction of a day: 1 a day, not 24 a day.
    expect(computeReorder({ ...base, unitsSold: 1, windowDays: 0.04, available: 0 }).velocity).toBe(
      1,
    );
    // 3 units over 30 days = 0.1 a day; 0.1 × 30 is 3.0000000000000004 in floating point.
    const r = computeReorder({
      ...base,
      unitsSold: 3,
      windowDays: 30,
      available: 0,
      leadTimeDays: 0,
      coverDays: 30,
      safetyDays: 0,
    });
    expect(r.suggested).toBe(3);
  });

  it('never suggests 0 for a needed reorder, even with a safety margin longer than the cover', () => {
    const r = computeReorder({ ...base, available: 60, coverDays: 1, safetyDays: 7 });
    expect(r.needsReorder).toBe(true);
    // lead 14 + max(cover 1, safety 7) = 21 days × 3 − 60 = 3
    expect(r.suggested).toBe(3);
    const exact = computeReorder({ ...base, available: 63, coverDays: 1, safetyDays: 7 });
    expect(exact.needsReorder).toBe(true);
    expect(exact.suggested).toBe(1);
  });
});

describe('roundToOrderQuantity', () => {
  it('leaves 0 alone and rounds up', () => {
    expect(roundToOrderQuantity(0, 10, 6)).toBe(0);
    expect(roundToOrderQuantity(-3, 10, 6)).toBe(0);
    expect(roundToOrderQuantity(1.2, null, null)).toBe(2);
    expect(roundToOrderQuantity(7, 10, null)).toBe(10);
    expect(roundToOrderQuantity(13, null, 6)).toBe(18);
    expect(roundToOrderQuantity(12, null, 6)).toBe(12);
    expect(roundToOrderQuantity(5, null, 1)).toBe(5);
  });
});

describe('stockoutDate', () => {
  it('is the day the stock runs out, or null when it does not sell', () => {
    const now = new Date('2026-10-18T15:00:00Z');
    expect(stockoutDate(9.7, now)).toBe('2026-10-27');
    expect(stockoutDate(0, now)).toBe('2026-10-18');
    expect(stockoutDate(null, now)).toBeNull();
  });
});

describe('reorderMessage', () => {
  const row = (over: Partial<ReorderRow>): ReorderRow => ({
    ...computeReorder(base),
    itemId: 1,
    sku: 'TEE-1',
    title: 'Tee',
    reorderEnabled: true,
    stockKnown: true,
    available: 27,
    unitsSold: 90,
    windowDays: 30,
    onOrder: 0,
    leadTimeDays: 14,
    leadTimeSource: 'supplier',
    coverDays: 30,
    stockoutOn: null,
    supplier: { id: 1, name: 'Acme', currencyCode: 'USD' },
    supplierSku: null,
    supplierUnitCost: null,
    minOrderQty: null,
    packSize: null,
    cost: null,
    ...over,
  });

  it('says when it runs out, the pace, the lead time and the order', () => {
    expect(reorderMessage(row({ daysLeft: 9.2, velocity: 3, suggested: 120 }))).toBe(
      'TEE-1 will run out in about 9 days at the current pace (3 a day). Lead time is 14 days. ' +
        'Suggested order: 120 units from Acme.',
    );
  });

  it('covers out of stock, fractions of a day, stock on order and no supplier', () => {
    expect(
      reorderMessage(
        row({ available: 0, daysLeft: 0, velocity: 2.46, suggested: 1, supplier: null }),
      ),
    ).toBe(
      'TEE-1 is out of stock and sells about 2.5 a day. Lead time is 14 days. ' +
        'Suggested order: 1 unit (choose a supplier for it).',
    );
    expect(
      reorderMessage(
        row({ available: 2, daysLeft: 0.5, velocity: 4, onOrder: 1, leadTimeDays: 1 }),
      ),
    ).toBe(
      'TEE-1 will run out in less than a day at the current pace (4 a day). 1 unit is already on ' +
        'order. Lead time is 1 day. Suggested order: 102 units from Acme.',
    );
  });
});

describe('nextItemCost', () => {
  it('averages the stock on hand with the delivery', () => {
    // 10 at 5.00 + 30 at 7.00 = 6.50
    expect(
      nextItemCost({ method: 'average', oldCost: 5, stockBefore: 10, quantity: 30, unitCost: 7 }),
    ).toBe(6.5);
  });

  it('takes the delivery price for "last", without an old cost, or with no stock', () => {
    expect(
      nextItemCost({ method: 'last', oldCost: 5, stockBefore: 10, quantity: 30, unitCost: 7 }),
    ).toBe(7);
    expect(
      nextItemCost({ method: 'average', oldCost: null, stockBefore: 10, quantity: 3, unitCost: 7 }),
    ).toBe(7);
    expect(
      nextItemCost({ method: 'average', oldCost: 5, stockBefore: 0, quantity: 3, unitCost: 7 }),
    ).toBe(7);
  });

  it('counts oversold stock as none, and keeps 4 decimals', () => {
    expect(
      nextItemCost({ method: 'average', oldCost: 5, stockBefore: -4, quantity: 3, unitCost: 7 }),
    ).toBe(7);
    // (1 × 1 + 2 × 2) / 3 = 1.6666…
    expect(
      nextItemCost({ method: 'average', oldCost: 1, stockBefore: 1, quantity: 2, unitCost: 2 }),
    ).toBe(1.6667);
  });

  it('converts an order price to the base currency', () => {
    expect(toBaseCost(41_000, 4100)).toBe(10);
    expect(toBaseCost(10, 3)).toBe(3.3333);
  });
});

describe('csv', () => {
  it('quotes per RFC 4180 and defuses formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
    expect(csvCell(-3.5)).toBe('-3.5');
    expect(csvCell(null)).toBe('');
    expect(
      toCsv([
        ['a', 1],
        ['b', null],
      ]),
    ).toBe('a,1\r\nb,\r\n');
  });
});
