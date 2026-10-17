import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reevaluateStockAlerts } from '../../alerts/alerts.js';
import { sendTestAlert } from '../../alerts/notifier.js';
import { SettingsPatchSchema, getSettings, resumeSync, updateSettings } from '../../settings.js';
import type { AppDeps } from '../server.js';

/** Settings the dashboard may change directly (pause state goes through pause/resume). */
const EditableSettings = SettingsPatchSchema.omit({
  syncPaused: true,
  pausedReason: true,
  breakerResetAt: true,
  onboardingCompleted: true,
}).strict();

const PauseBody = z.object({ reason: z.string().trim().max(500).optional() }).default({});

export async function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get('/api/settings', async () => getSettings(db));

  app.patch('/api/settings', async (request) => {
    const patch = EditableSettings.parse(request.body);
    const settings = await updateSettings(db, patch);
    if (patch.lowStockThreshold !== undefined) await reevaluateStockAlerts(db);
    return settings;
  });

  app.post('/api/settings/pause', async (request) => {
    const body = PauseBody.parse(request.body ?? {});
    return updateSettings(db, {
      syncPaused: true,
      pausedReason: body.reason || 'Paused from the dashboard',
    });
  });

  app.post('/api/settings/resume', async () => {
    const settings = await resumeSync(db);
    deps.onWork?.();
    return settings;
  });

  app.post('/api/settings/test-alert', async () =>
    sendTestAlert({ db, logger: deps.logger, fetchFn: deps.fetchFn }),
  );
}
