import { migrate } from './migrate.js';
import { createDb } from './pool.js';

/**
 * Applies pending migrations without starting the service (`npm run migrate`, or
 * `node dist/db/migrate-cli.js` in the container). The service also migrates on every start.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb(url, 1);
  try {
    const applied = await migrate(db);
    console.log(
      applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date',
    );
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
