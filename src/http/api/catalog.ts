import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.js';

/** Catalog (master products): /api/catalog/... */
export async function registerCatalogRoutes(_app: FastifyInstance, _deps: AppDeps): Promise<void> {}
