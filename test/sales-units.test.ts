import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/sales/csv.js';
import { historyWindow, readLines } from '../src/sales/history.js';
import { productFigures, sortRows } from '../src/sales/metrics.js';
import {
  addDays,
  datesBetween,
  daysInPeriod,
  isDate,
  resolvePeriod,
  todayIn,
} from '../src/sales/period.js';

const DAY = 24 * 60 * 60_000;

describe('CSV', () => {
  it('neutralises anything a spreadsheet would run as a formula', () => {
    for (const evil of ['=1+1', '+1', '-1+1', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(evil).replace(/^"/, '').startsWith(`'`)).toBe(true);
    }
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('TEE-1')).toBe('TEE-1');
    // Excel where ';' separates lists splits there: the formula after it would run.
    expect(csvCell('Linen tee;=HYPERLINK("http://x");x')).toBe(
      '"Linen tee;=HYPERLINK(""http://x"");x"',
    );
    expect(toCsv([['TEE-1', 'a;=1+2;b', 3]])).toBe('﻿TEE-1,"a;=1+2;b",3\r\n');
  });

  it('quotes like RFC 4180 and keeps our numbers as numbers', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(
      toCsv([
        ['a', 1],
        ['Café, Ñ', null],
      ]),
    ).toBe('\uFEFFa,1\r\n"Café, Ñ",\r\n');
  });
});

describe('report periods', () => {
  it('checks and walks calendar dates', () => {
    expect(isDate('2026-10-17')).toBe(true);
    expect(isDate('2026-02-29')).toBe(false);
    expect(isDate('2028-02-29')).toBe(true);
    expect(isDate('2026-1-7')).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysInPeriod('2026-10-01', '2026-10-31')).toBe(31);
    // Daylight saving changes don't matter: dates, not instants.
    expect(datesBetween('2026-03-07', '2026-03-09')).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
  });

  it('only takes years it can walk, and always stops walking', () => {
    expect(isDate('9999-12-31')).toBe(false);
    expect(isDate('3000-01-01')).toBe(false);
    expect(isDate('1969-12-31')).toBe(false);
    expect(isDate('2999-12-31')).toBe(true);
    expect(isDate('1970-01-01')).toBe(true);
    // The day after 9999-12-31 is '+010000-01-01': walking by text comparison never ended.
    expect(datesBetween('9999-12-30', '9999-12-31')).toEqual(['9999-12-30', '9999-12-31']);
    expect(datesBetween('2026-10-02', '2026-10-01')).toEqual([]);
  });

  it('knows what day it is in each time zone', () => {
    const now = new Date('2026-10-18T03:30:00Z');
    expect(todayIn('UTC', now)).toBe('2026-10-18');
    expect(todayIn('America/Bogota', now)).toBe('2026-10-17');
    expect(todayIn('Asia/Tokyo', now)).toBe('2026-10-18');
  });

  it('defaults to the last 30 days and refuses impossible periods', () => {
    const now = new Date('2026-10-18T03:30:00Z');
    expect(resolvePeriod({}, 'America/Bogota', now)).toEqual({
      from: '2026-09-18',
      to: '2026-10-17',
      days: 30,
    });
    expect(resolvePeriod({ to: '2026-10-31' }, 'UTC', now).from).toBe('2026-10-02');
    expect(resolvePeriod({ from: '2026-10-17', to: '2026-10-17' }, 'UTC', now).days).toBe(1);
    expect(() => resolvePeriod({ from: '2026-10-18', to: '2026-10-17' }, 'UTC', now)).toThrow(
      'The start date must be on or before the end date.',
    );
    expect(() => resolvePeriod({ from: '2010-01-01', to: '2026-10-17' }, 'UTC', now)).toThrow(
      /at most 10 years/,
    );
  });
});

describe('history window', () => {
  const now = new Date('2026-10-18T00:00:00Z');
  it('gives Shopify’s 60 days without read_all_orders', () => {
    expect(historyWindow(now, 90, ['read_orders'])).toEqual({
      from: new Date(now.getTime() - 60 * DAY),
      days: 60,
      capped: true,
    });
    expect(historyWindow(now, 60, ['read_orders']).capped).toBe(false);
    expect(historyWindow(now, 30, null)).toMatchObject({ days: 30, capped: false });
  });

  it('reads as far back as the setting says with it', () => {
    expect(historyWindow(now, 365, ['read_orders', 'read_all_orders'])).toMatchObject({
      days: 365,
      capped: false,
    });
  });
});

describe('export file lines', () => {
  async function* chunks(...parts: (string | Uint8Array)[]) {
    for (const p of parts) yield typeof p === 'string' ? new TextEncoder().encode(p) : p;
  }
  const collect = async (it: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const line of it) out.push(line);
    return out;
  };

  it('splits lines across chunks, CRLF or LF, with or without a final newline', async () => {
    expect(await collect(readLines(chunks('{"a":1}\n{"b"', ':2}\r\n', '{"c":3}')))).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
    expect(await collect(readLines(chunks('x\n')))).toEqual(['x']);
    expect(await collect(readLines(chunks()))).toEqual([]);
  });

  it('keeps characters whose bytes are split between chunks', async () => {
    const bytes = new TextEncoder().encode('{"title":"Café ☕"}\n');
    const at = bytes.indexOf(0xe2) + 1; // inside the 3-byte ☕
    expect(await collect(readLines(chunks(bytes.slice(0, at), bytes.slice(at))))).toEqual([
      '{"title":"Café ☕"}',
    ]);
  });
});

describe('product figures', () => {
  const sums = {
    units: 30,
    revenue: 600,
    cost: 240,
    revenueWithCost: 400,
    stock: 90,
    recentUnits: 60,
    paceDays: 30,
  };

  it('works out margin, pace, days left and sell-through', () => {
    expect(productFigures(sums)).toEqual({
      margin: 0.4,
      velocity: 2,
      daysLeft: 45,
      sellThrough: 0.25,
    });
  });

  it('has no figure where it would mean nothing', () => {
    expect(productFigures({ ...sums, revenueWithCost: 0, cost: 0 }).margin).toBeNull();
    expect(productFigures({ ...sums, recentUnits: 0 })).toMatchObject({
      velocity: 0,
      daysLeft: null,
    });
    expect(productFigures({ ...sums, stock: null })).toMatchObject({
      daysLeft: null,
      sellThrough: null,
    });
    // Oversold: nothing left, everything sold.
    expect(productFigures({ ...sums, stock: -4 })).toMatchObject({ daysLeft: 0, sellThrough: 1 });
    expect(productFigures({ ...sums, units: 0, stock: 0 }).sellThrough).toBeNull();
  });

  it('sorts with missing figures last in both directions', () => {
    const rows = [
      { sku: 'B', revenue: 5, units: 1, margin: null, daysLeft: 3, sellThrough: 0.5 },
      { sku: 'A', revenue: 5, units: 2, margin: 0.2, daysLeft: null, sellThrough: 0.1 },
      { sku: 'C', revenue: 9, units: 3, margin: 0.5, daysLeft: 1, sellThrough: null },
    ];
    const skus = (r: typeof rows) => r.map((x) => x.sku);
    expect(skus(sortRows(rows, 'revenue', 'desc'))).toEqual(['C', 'A', 'B']);
    expect(skus(sortRows(rows, 'revenue', 'asc'))).toEqual(['A', 'B', 'C']);
    expect(skus(sortRows(rows, 'margin', 'asc'))).toEqual(['A', 'C', 'B']);
    expect(skus(sortRows(rows, 'margin', 'desc'))).toEqual(['C', 'A', 'B']);
    expect(skus(sortRows(rows, 'daysLeft', 'asc'))).toEqual(['C', 'B', 'A']);
  });
});
