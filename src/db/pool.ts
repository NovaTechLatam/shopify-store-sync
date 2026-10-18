import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: the pool itself or a checked-out client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

// Return BIGINT (int8) columns as JS numbers. All our bigint columns (ids, quantities) are far
// below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));
// ...and BIGINT[] (int8 array, OID 1016, not in the builtins enum) as arrays of numbers.
const INT8_ARRAY = 1016 as Parameters<typeof pg.types.setTypeParser>[0];
const parseBigintArray = pg.types.getTypeParser(INT8_ARRAY);
pg.types.setTypeParser(INT8_ARRAY, (value: string) =>
  (parseBigintArray(value) as (string | null)[]).map((v) => (v === null ? null : Number(v))),
);
// NUMERIC as JS numbers. Money columns are numeric(18,4) and exchange rates numeric(18,8): far
// inside a double's 15-16 significant digits, and every amount is rounded to the currency's
// decimals (src/util/money.ts) before it is sent to Shopify or shown. Also applies to sum() and
// avg() results, which Postgres returns as numeric.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));
// (NUMERIC[] already comes back as numbers.)
// DATE as the 'YYYY-MM-DD' text Postgres sends. The default parser builds a Date at local
// midnight, which shifts the day for anyone reading it in UTC (or another time zone).
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// ...and DATE[] (OID 1182, e.g. array_agg of dates) as arrays of those strings.
const DATE_ARRAY = 1182 as Parameters<typeof pg.types.setTypeParser>[0];
const parseTextArray = pg.types.getTypeParser(1009 as Parameters<typeof pg.types.setTypeParser>[0]);
pg.types.setTypeParser(DATE_ARRAY, (value: string) => parseTextArray(value) as (string | null)[]);

export function createDb(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max });
}

/** Runs `fn` inside a transaction, committing on success and rolling back on error. */
export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
