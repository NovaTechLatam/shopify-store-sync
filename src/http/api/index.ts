import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.js';
import { registerAlertRoutes } from './alerts.js';
import { registerEventRoutes } from './events.js';
import { registerItemRoutes } from './items.js';
import { registerOnboardingRoutes } from './onboarding.js';
import { registerSettingsRoutes } from './settings.js';
import { registerStatusRoutes } from './status.js';
import { registerStoreRoutes } from './stores.js';
import { registerVariantRoutes } from './variants.js';
import { registerWarehouseRoutes } from './warehouses.js';

export async function registerApiRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await registerStatusRoutes(app, deps);
  await registerStoreRoutes(app, deps);
  await registerWarehouseRoutes(app, deps);
  await registerItemRoutes(app, deps);
  await registerVariantRoutes(app, deps);
  await registerOnboardingRoutes(app, deps);
  await registerEventRoutes(app, deps);
  await registerAlertRoutes(app, deps);
  await registerSettingsRoutes(app, deps);
}
