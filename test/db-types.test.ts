import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/pool.js';
import { TEST_DATABASE_URL } from './helpers/harness.js';

let db: Db;

beforeAll(() => {
  db = createDb(TEST_DATABASE_URL, 1);
});

afterAll(async () => {
  await db.end();
});

describe('database types', () => {
  it('returns money (numeric) and its sums as numbers, dates as YYYY-MM-DD', async () => {
    const { rows } = await db.query(
      `SELECT 12.9000::numeric(18,4) AS price, NULL::numeric AS missing,
              sum(x) AS total, avg(x) AS mean, sum(n) AS units,
              ARRAY[1.5, 2.25]::numeric[] AS prices,
              '2026-10-17'::date AS day, NULL::date AS no_day,
              ARRAY['2026-10-17'::date, NULL, '2026-01-02'::date] AS days
         FROM (VALUES (1.25::numeric, 2), (2.5, 3)) AS t(x, n)`,
    );
    expect(rows[0]).toEqual({
      price: 12.9,
      missing: null,
      total: 3.75,
      mean: 1.875,
      units: 5,
      prices: [1.5, 2.25],
      day: '2026-10-17',
      no_day: null,
      days: ['2026-10-17', null, '2026-01-02'],
    });
  });
});
