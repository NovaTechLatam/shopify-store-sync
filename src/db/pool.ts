import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: the pool itself or a checked-out client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

// Return BIGINT (int8) columns as JS numbers. All our bigint columns (ids, quantities) are far
// below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (value) => Number(value));

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
