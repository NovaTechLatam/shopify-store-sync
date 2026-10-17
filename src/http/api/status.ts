import type { FastifyInstance } from 'fastify';
import { getSettings } from '../../settings.js';
import type { AppDeps } from '../server.js';

export async function registerStatusRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db } = deps;

  app.get('/api/status', async () => {
    const [settings, queue, tasks, items, stores, alerts, variants] = await Promise.all([
      getSettings(db),
      db.query<{ ready: number; delayed: number; running: number; failing: number }>(
        `SELECT count(*) FILTER (WHERE run_after <= now() AND (leased_until IS NULL OR leased_until < now()))::int AS ready,
                count(*) FILTER (WHERE run_after > now() AND lease_token IS NULL)::int AS delayed,
                count(*) FILTER (WHERE leased_until >= now())::int AS running,
                count(*) FILTER (WHERE attempts >= 3)::int AS failing
           FROM sync_queue`,
      ),
      db.query<{ ready: number; running: number; failing: number }>(
        `SELECT count(*) FILTER (WHERE run_after <= now() AND (leased_until IS NULL OR leased_until < now()))::int AS ready,
                count(*) FILTER (WHERE leased_until >= now())::int AS running,
                count(*) FILTER (WHERE attempts >= 3)::int AS failing
           FROM tasks`,
      ),
      db.query<{
        total: number;
        initialized: number;
        uninitialized: number;
        disabled: number;
        oversold: number;
      }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM pool_levels pl
                                                    WHERE pl.item_id = i.id AND pl.quantity IS NULL))::int AS initialized,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pool_levels pl
                                                WHERE pl.item_id = i.id AND pl.quantity IS NULL))::int AS uninitialized,
                count(*) FILTER (WHERE NOT i.sync_enabled)::int AS disabled,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pool_levels pl
                                                WHERE pl.item_id = i.id AND pl.quantity < 0))::int AS oversold
           FROM items i
          WHERE EXISTS (SELECT 1 FROM variants v WHERE v.item_id = i.id AND v.deleted_at IS NULL)`,
      ),
      db.query<{
        id: number;
        name: string;
        status: string;
        last_webhook_at: Date | null;
        last_drift_scan_at: Date | null;
        last_drift_count: number | null;
      }>(
        `SELECT id, name, status, last_webhook_at, last_drift_scan_at, last_drift_count FROM stores ORDER BY id`,
      ),
      db.query<{ open: number; low: number }>(
        `SELECT count(*)::int AS open, count(*) FILTER (WHERE kind = 'low_stock')::int AS low
           FROM alerts WHERE resolved_at IS NULL`,
      ),
      db.query<{ unmatched: number; conflicts: number }>(
        `SELECT count(*) FILTER (WHERE v.item_id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM variants o WHERE o.item_id = v.item_id AND o.store_id <> v.store_id
                     AND o.deleted_at IS NULL))::int AS unmatched,
                count(*) FILTER (WHERE v.item_id IS NULL AND v.link_source = 'auto' AND v.sku IS NOT NULL
                  AND EXISTS (SELECT 1 FROM variants o WHERE o.store_id = v.store_id AND o.sku = v.sku
                     AND o.id <> v.id AND o.deleted_at IS NULL AND NOT o.is_bundle))::int AS conflicts
           FROM variants v
          WHERE v.deleted_at IS NULL AND NOT v.is_bundle`,
      ),
    ]);
    return {
      syncPaused: settings.syncPaused,
      pausedReason: settings.pausedReason,
      onboardingCompleted: settings.onboardingCompleted,
      queue: queue.rows[0],
      tasks: tasks.rows[0],
      items: { ...items.rows[0], lowStock: alerts.rows[0]!.low },
      stores: stores.rows.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        lastWebhookAt: s.last_webhook_at,
        lastDriftScanAt: s.last_drift_scan_at,
        lastDriftCount: s.last_drift_count,
      })),
      openAlerts: alerts.rows[0]!.open,
      unmatchedVariants: variants.rows[0]!.unmatched,
      conflicts: variants.rows[0]!.conflicts,
    };
  });
}
