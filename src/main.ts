import pino from 'pino';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createDb } from './db/pool.js';
import { buildServer } from './http/server.js';
import { Scheduler } from './scheduler.js';
import { DbShopifyRegistry, createShopifyAdmin } from './shopify/registry.js';
import { SyncEngine } from './sync/engine.js';
import { SyncWorker } from './sync/worker.js';
import { enqueueTask } from './tasks/queue.js';
import { TaskRunner } from './tasks/runner.js';
import { SecretBox } from './util/crypto.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', '*.accessToken', '*.clientSecret', '*.webhookSecret'],
  });

  const db = createDb(config.DATABASE_URL, config.DATABASE_POOL_SIZE);
  db.on('error', (err) => logger.error({ err }, 'idle database client error'));
  const applied = await migrate(db);
  if (applied.length) logger.info({ applied }, 'database migrations applied');

  const secrets = new SecretBox(config.ENCRYPTION_KEY);
  const clientOptions = { apiVersion: config.SHOPIFY_API_VERSION, logger };
  const shopify = new DbShopifyRegistry(db, secrets, clientOptions);
  const engine = new SyncEngine({ db, shopify, logger });
  const taskDeps = { db, shopify, logger, publicUrl: config.PUBLIC_URL };

  const worker = new SyncWorker({ db, engine, logger, concurrency: config.WORKER_CONCURRENCY });
  const tasks = new TaskRunner({ db, deps: taskDeps, logger, concurrency: 2 });
  const onWork = () => {
    worker.nudge();
    tasks.nudge();
  };
  const scheduler = new Scheduler({
    db,
    logger,
    driftIntervalMs: config.RECONCILE_INTERVAL_MINUTES * 60_000,
    catalogIntervalMs: config.CATALOG_REFRESH_INTERVAL_MINUTES * 60_000,
    onWork,
  });

  const app = await buildServer({
    db,
    secrets,
    shopify,
    createAdmin: (creds) => createShopifyAdmin(creds, clientOptions),
    logger,
    publicUrl: config.PUBLIC_URL,
    adminUsername: config.ADMIN_USERNAME,
    adminPassword: config.ADMIN_PASSWORD,
    onWork,
  });
  await app.listen({ host: config.HOST, port: config.PORT });

  if (config.WORKER_ENABLED) {
    // Webhook subscriptions may have been removed by Shopify while we were down.
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM stores WHERE status = 'active'`,
    );
    for (const { id } of rows) await enqueueTask(db, 'ensure_webhooks', { storeId: id });
    worker.start();
    tasks.start();
    scheduler.start();
    logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'sync worker started');
  }
  logger.info(
    { url: config.PUBLIC_URL, apiVersion: config.SHOPIFY_API_VERSION },
    'store sync is running',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      scheduler.stop();
      await app.close();
      await Promise.all([worker.stop(), tasks.stop()]);
      await db.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
