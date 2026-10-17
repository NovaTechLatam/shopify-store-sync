import { z } from 'zod';
import type { Queryable } from './db/pool.js';

/**
 * Runtime settings, editable from the dashboard and stored in the `settings` table (one row per
 * key). Anything not stored falls back to the defaults below.
 */
export const SettingsSchema = z.object({
  /** Global kill switch: when true no pool level is reconciled (webhooks are still recorded). */
  syncPaused: z.boolean(),
  /** Why sync is paused (shown in the dashboard), e.g. set by the circuit breaker. */
  pausedReason: z.string().nullable(),
  /** Default low-stock alert threshold (items can override it). */
  lowStockThreshold: z.number().int().min(0),
  /** Slack-compatible incoming webhook URL; receives `{ text }`. */
  alertSlackWebhookUrl: z.string().url().nullable(),
  /** Generic webhook URL; receives the alert as JSON (use with Zapier/Make/n8n for WhatsApp, email...). */
  alertWebhookUrl: z.string().url().nullable(),
  /** Set once the merchant has run the initial sync from the onboarding screen. */
  onboardingCompleted: z.boolean(),
  /** After onboarding, start syncing items that appear later (new products) automatically. */
  autoInitializeNewItems: z.boolean(),
  /** How the starting quantity of a new item is chosen when it is auto-initialised. */
  autoInitializeStrategy: z.enum(['max', 'min']),
  /**
   * Circuit breaker: if more than this many items go from in-stock to zero (or less) because of
   * changes made in the stores within 10 minutes, sync pauses itself and raises an alert. Protects
   * against a bad CSV import in one store wiping out stock in every store. 0 disables it.
   */
  massZeroLimit: z.number().int().min(0),
  /** Keep the activity log for this many days. */
  eventRetentionDays: z.number().int().min(7),
  /** Circuit-breaker hits before this time (ISO) are ignored; set when sync is resumed. */
  breakerResetAt: z.string().nullable(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  syncPaused: false,
  pausedReason: null,
  lowStockThreshold: 5,
  alertSlackWebhookUrl: null,
  alertWebhookUrl: null,
  onboardingCompleted: false,
  autoInitializeNewItems: true,
  autoInitializeStrategy: 'max',
  massZeroLimit: 15,
  eventRetentionDays: 180,
  breakerResetAt: null,
};

/** Maps setting names to the `settings.key` column. */
const KEYS: Record<keyof Settings, string> = {
  syncPaused: 'sync_paused',
  pausedReason: 'paused_reason',
  lowStockThreshold: 'low_stock_threshold',
  alertSlackWebhookUrl: 'alert_slack_webhook_url',
  alertWebhookUrl: 'alert_webhook_url',
  onboardingCompleted: 'onboarding_completed',
  autoInitializeNewItems: 'auto_initialize_new_items',
  autoInitializeStrategy: 'auto_initialize_strategy',
  massZeroLimit: 'mass_zero_limit',
  eventRetentionDays: 'event_retention_days',
  breakerResetAt: 'breaker_reset_at',
};

export async function getSettings(db: Queryable): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM settings',
  );
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [name, key] of Object.entries(KEYS)) {
    if (!stored.has(key)) continue;
    const field = SettingsSchema.shape[name as keyof Settings];
    const parsed = field.safeParse(stored.get(key));
    if (parsed.success) merged[name] = parsed.data;
  }
  return merged as Settings;
}

export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export async function updateSettings(db: Queryable, patch: SettingsPatch): Promise<Settings> {
  const valid = SettingsPatchSchema.parse(patch);
  for (const [name, value] of Object.entries(valid)) {
    if (value === undefined) continue;
    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEYS[name as keyof Settings], JSON.stringify(value)],
    );
  }
  return getSettings(db);
}

/** Resumes sync after a manual or automatic pause, and gives the circuit breaker a fresh start. */
export async function resumeSync(db: Queryable): Promise<Settings> {
  await db.query(
    `UPDATE alerts SET resolved_at = now() WHERE kind = 'circuit_breaker' AND resolved_at IS NULL`,
  );
  // Database clock, to compare with circuit_breaker_hits.created_at.
  const { rows } = await db.query<{ now: Date }>('SELECT now() AS now');
  return updateSettings(db, {
    syncPaused: false,
    pausedReason: null,
    breakerResetAt: rows[0]!.now.toISOString(),
  });
}
