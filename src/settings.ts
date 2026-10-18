import { z } from 'zod';
import type { Queryable } from './db/pool.js';
import { CURRENCY_CODE } from './util/money.js';
import { todayIn } from './util/time.js';

/**
 * An IANA time zone name ('America/Bogota', 'UTC') that both Intl and Postgres understand. Offsets
 * like '+05:00' are refused: Postgres reads them as POSIX zones, with the sign reversed.
 */
export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

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
  /** Currency of base prices and unit costs. Stores convert from it with their exchange rate. */
  baseCurrency: CURRENCY_CODE,
  /** Raise an alert when an item will run out before a new delivery could arrive. */
  reorderAlertsEnabled: z.boolean(),
  /** Sales pace is measured over this many past days. */
  reorderLookbackDays: z.number().int().min(7).max(365),
  /** Extra days of stock kept as a margin on top of the lead time. */
  reorderSafetyDays: z.number().int().min(0).max(365),
  /** A suggested order covers this many days of sales after it arrives (items can override it). */
  reorderCoverDays: z.number().int().min(1).max(365),
  /** Order-to-delivery days when neither the item nor its supplier says. */
  reorderDefaultLeadTimeDays: z.number().int().min(0).max(365),
  /** How far back sales history is read from the stores when a store is connected. */
  salesHistoryDays: z.number().int().min(1).max(3650),
  /** How a delivery changes an item's cost: weighted average with the stock on hand, or last price. */
  costMethod: z.enum(['average', 'last']),
  /**
   * Copy item costs to each store's "Cost per item" in Shopify: after a delivery changes them, and
   * when a catalog product is published. Off, Store Sync never writes costs to Shopify.
   */
  pushCostsToShopify: z.boolean(),
  /** Days in reports start and end in this time zone; '' = the first store's time zone. */
  reportTimezone: z
    .string()
    .refine((v) => v === '' || isTimeZone(v), 'Use a time zone name like America/Bogota'),
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
  baseCurrency: 'USD',
  reorderAlertsEnabled: true,
  reorderLookbackDays: 30,
  reorderSafetyDays: 7,
  reorderCoverDays: 30,
  reorderDefaultLeadTimeDays: 14,
  salesHistoryDays: 60,
  costMethod: 'average',
  pushCostsToShopify: false,
  reportTimezone: '',
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
  baseCurrency: 'base_currency',
  reorderAlertsEnabled: 'reorder_alerts_enabled',
  reorderLookbackDays: 'reorder_lookback_days',
  reorderSafetyDays: 'reorder_safety_days',
  reorderCoverDays: 'reorder_cover_days',
  reorderDefaultLeadTimeDays: 'reorder_default_lead_time_days',
  salesHistoryDays: 'sales_history_days',
  costMethod: 'cost_method',
  pushCostsToShopify: 'push_costs_to_shopify',
  reportTimezone: 'report_timezone',
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

/**
 * The time zone report days follow, and every "today" Store Sync works out (an order overdue, the
 * day stock runs out): the reportTimezone setting, else the first store's time zone, else UTC.
 */
export async function reportTimezone(db: Queryable, settings?: Settings): Promise<string> {
  const setting = (settings ?? (await getSettings(db))).reportTimezone;
  if (setting) return setting;
  const { rows } = await db.query<{ iana_timezone: string }>(
    'SELECT iana_timezone FROM stores WHERE iana_timezone IS NOT NULL ORDER BY id',
  );
  // Shopify's names are IANA names; a name our Intl (and Postgres) don't know is skipped.
  return rows.find((r) => isTimeZone(r.iana_timezone))?.iana_timezone ?? 'UTC';
}

/** Today's date ('YYYY-MM-DD') in the report time zone. */
export async function reportToday(
  db: Queryable,
  settings?: Settings,
  now: Date = new Date(),
): Promise<string> {
  return todayIn(await reportTimezone(db, settings), now);
}

/**
 * Whether Postgres knows a time zone name: reports group sales by day `AT TIME ZONE` it, so a name
 * only Node knows would make every report fail. Checked when the setting is saved.
 */
export async function postgresKnowsTimeZone(db: Queryable, name: string): Promise<boolean> {
  const { rows } = await db.query<{ known: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE lower(name) = lower($1)) AS known',
    [name],
  );
  return rows[0]!.known;
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
