import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { Db } from '../db/pool.js';
import type { StoreCredentials } from '../shopify/registry.js';
import type { ShopifyAdmin } from '../shopify/types.js';
import type { ShopifyRegistry } from '../sync/engine.js';
import type { SecretBox } from '../util/crypto.js';
import { handleShopifyWebhook } from '../webhooks/intake.js';
import { WEBHOOK_PATH } from '../webhooks/topics.js';
import { registerApiRoutes } from './api/index.js';
import { basicAuth } from './auth.js';
import { HttpError } from './errors.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

export interface AppDeps {
  db: Db;
  secrets: SecretBox;
  shopify: ShopifyRegistry & { invalidate(storeId?: number): void };
  /** Builds a client for credentials that aren't saved yet (connection test before adding a store). */
  createAdmin: (creds: StoreCredentials) => ShopifyAdmin;
  logger: Logger;
  publicUrl: string;
  adminUsername: string;
  adminPassword: string;
  /** Wakes the background workers after work was queued. */
  onWork?: () => void;
  fetchFn?: typeof fetch;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    trustProxy: true,
    // Shopify product payloads can be large; everything else is small.
    bodyLimit: 5 * 1024 * 1024,
    disableRequestLogging: true,
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, ...err.details });
    }
    if (err instanceof ZodError) {
      const message = err.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send({ error: message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message });
    }
    request.log.error({ err, url: request.url }, 'request failed');
    return reply
      .code(500)
      .send({ error: 'Something went wrong on our side. Check the server logs.' });
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.get('/healthz', async (_request, reply) => {
    try {
      await deps.db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // Shopify webhooks: signed with HMAC, so no Basic auth; the raw body is needed to verify it.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    scope.post(WEBHOOK_PATH, async (request, reply) => {
      const result = await handleShopifyWebhook(
        { db: deps.db, secrets: deps.secrets, logger: deps.logger, onWork: deps.onWork },
        {
          headers: request.headers,
          rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        },
      );
      return reply.code(result.status).type('text/plain').send(result.body);
    });
  });

  // Everything else (dashboard + admin API) requires the admin login.
  await app.register(async (scope) => {
    scope.addHook('onRequest', basicAuth(deps.adminUsername, deps.adminPassword));
    await registerApiRoutes(scope, deps);
    await scope.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', index: ['index.html'] });
  });

  return app;
}
