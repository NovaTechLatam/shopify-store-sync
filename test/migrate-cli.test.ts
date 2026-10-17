import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/pool.js';
import { TEST_DATABASE_URL } from './helpers/harness.js';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/db/migrate-cli.ts', import.meta.url));

function runCli(env: NodeJS.ProcessEnv) {
  return exec(process.execPath, ['--import', 'tsx', CLI], { env, timeout: 20_000 });
}

describe('migrate CLI', () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL, 2);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });

  afterAll(async () => {
    await db.end();
  });

  it('applies pending migrations, then reports the database is up to date', async () => {
    const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };

    const first = await runCli(env);
    expect(first.stdout).toMatch(/Applied migrations: .*001_init\.sql/);
    const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toContain('001_init.sql');

    const second = await runCli(env);
    expect(second.stdout.trim()).toBe('Database is up to date');
  });

  it('exits with an error when DATABASE_URL is missing', async () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    await expect(runCli(env)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('DATABASE_URL is required'),
    });
  });
});
