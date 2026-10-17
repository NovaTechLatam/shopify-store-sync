import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.js';

/** Purchasing and reorder: /api/purchasing/... */
export async function registerPurchasingRoutes(
  _app: FastifyInstance,
  _deps: AppDeps,
): Promise<void> {}
