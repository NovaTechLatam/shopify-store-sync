import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyOnboarding, previewOnboarding } from '../../sync/onboarding.js';
import { badRequest } from '../errors.js';
import type { AppDeps } from '../server.js';

const Strategy = z.enum(['store', 'min', 'max', 'sum']);

const PreviewQuery = z.object({
  strategy: Strategy,
  sourceStoreId: z.coerce.number().int().positive().optional(),
});

const ApplyBody = z.object({
  strategy: Strategy,
  sourceStoreId: z.number().int().positive().optional(),
  poolLevelIds: z.array(z.number().int().positive()).max(100_000).optional(),
});

function requireSource(strategy: string, sourceStoreId?: number) {
  if (strategy === 'store' && !sourceStoreId)
    throw badRequest('Choose the store whose numbers should be copied');
}

export async function registerOnboardingRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/onboarding/preview', async (request) => {
    const q = PreviewQuery.parse(request.query);
    requireSource(q.strategy, q.sourceStoreId);
    return previewOnboarding(deps, q);
  });

  app.post('/api/onboarding/apply', async (request) => {
    const body = ApplyBody.parse(request.body);
    requireSource(body.strategy, body.sourceStoreId);
    const result = await applyOnboarding(deps.db, body);
    deps.onWork?.();
    return result;
  });
}
