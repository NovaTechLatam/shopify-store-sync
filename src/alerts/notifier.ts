import type { Logger } from 'pino';
import type { Db } from '../db/pool.js';
import type { Settings } from '../settings.js';
import { getSettings } from '../settings.js';

/**
 * Pushes new alerts to the merchant: a Slack-compatible incoming webhook (`{ text }`) and/or a
 * generic webhook that receives each alert as JSON (for Zapier, Make, n8n... to forward to email or
 * WhatsApp). Webhook URLs embed their own credentials, so they are never logged.
 */

export interface NotifierDeps {
  db: Db;
  logger: Logger;
  fetchFn?: typeof fetch;
}

/** Body sent to the generic webhook. */
export interface AlertPayload {
  id: number;
  kind: string;
  message: string;
  item: { id: number; sku: string } | null;
  store: { id: number; name: string } | null;
  createdAt: string;
}

const TIMEOUT_MS = 10_000;
/** Older alerts are only shown in the dashboard; a notification about them would be noise. */
const MAX_AGE = '24 hours';
/** Per run (every minute), so a burst of alerts is spread out instead of flooding the channel. */
const BATCH_SIZE = 20;

type Destination = 'slack' | 'webhook';

/**
 * Sends open alerts nobody was notified about yet, and marks them notified. Alerts are claimed
 * (notified_at set) before sending so concurrent runs never send one twice; an alert that no
 * destination accepted is released for the next run. Returns how many alerts were delivered.
 */
export async function dispatchAlerts(deps: NotifierDeps): Promise<number> {
  const { db, logger } = deps;
  const settings = await getSettings(db);
  if (!settings.alertSlackWebhookUrl && !settings.alertWebhookUrl) return 0;

  const { rows } = await db.query<{
    id: number;
    kind: string;
    message: string;
    item_id: number | null;
    sku: string | null;
    store_id: number | null;
    store_name: string | null;
    created_at: Date;
  }>(
    `WITH claimed AS (
       UPDATE alerts SET notified_at = now()
        WHERE id IN (SELECT id FROM alerts
                      WHERE resolved_at IS NULL AND notified_at IS NULL
                        AND created_at > now() - $1::interval
                      ORDER BY id LIMIT $2
                      FOR UPDATE SKIP LOCKED)
       RETURNING id, kind, message, item_id, store_id, created_at)
     SELECT c.*, i.sku, s.name AS store_name
       FROM claimed c
       LEFT JOIN items i ON i.id = c.item_id
       LEFT JOIN stores s ON s.id = c.store_id
      ORDER BY c.id`,
    [MAX_AGE, BATCH_SIZE],
  );
  if (rows.length === 0) return 0;
  const alerts: AlertPayload[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    message: r.message,
    item: r.item_id !== null && r.sku !== null ? { id: r.item_id, sku: r.sku } : null,
    store:
      r.store_id !== null && r.store_name !== null ? { id: r.store_id, name: r.store_name } : null,
    createdAt: r.created_at.toISOString(),
  }));

  const delivered = new Set<number>();
  if (settings.alertSlackWebhookUrl) {
    const error = await post(deps, settings.alertSlackWebhookUrl, { text: slackText(alerts) });
    if (error) logger.warn({ destination: 'slack', error }, 'could not send alerts');
    else for (const a of alerts) delivered.add(a.id);
  }
  if (settings.alertWebhookUrl) {
    for (const alert of alerts) {
      const error = await post(deps, settings.alertWebhookUrl, alert);
      if (error) {
        // Most likely down for every alert; don't wait out a timeout per alert.
        logger.warn({ destination: 'webhook', alertId: alert.id, error }, 'could not send alert');
        break;
      }
      delivered.add(alert.id);
    }
  }

  const failed = alerts.filter((a) => !delivered.has(a.id)).map((a) => a.id);
  if (failed.length) {
    await db.query('UPDATE alerts SET notified_at = NULL WHERE id = ANY($1::bigint[])', [failed]);
  }
  return delivered.size;
}

/** Sends a sample alert to every configured destination. */
export async function sendTestAlert(deps: NotifierDeps): Promise<{ ok: boolean; error?: string }> {
  const settings = await getSettings(deps.db);
  const destinations = configured(settings);
  if (destinations.length === 0) {
    return { ok: false, error: 'No alert destination is set. Add a Slack or webhook URL first.' };
  }
  const message = 'Test alert from Store Sync: alerts reach this destination.';
  const failures: string[] = [];
  for (const [destination, url] of destinations) {
    const body: unknown =
      destination === 'slack'
        ? { text: slackText([{ message, store: null }]) }
        : ({
            id: 0,
            kind: 'test',
            message,
            item: null,
            store: null,
            createdAt: new Date().toISOString(),
          } satisfies AlertPayload);
    const error = await post(deps, url, body);
    if (error) failures.push(`${destination === 'slack' ? 'Slack' : 'Webhook'}: ${error}`);
  }
  if (failures.length) {
    deps.logger.warn({ failures }, 'test alert failed');
    return { ok: false, error: failures.join('; ') };
  }
  return { ok: true };
}

function configured(settings: Settings): [Destination, string][] {
  const out: [Destination, string][] = [];
  if (settings.alertSlackWebhookUrl) out.push(['slack', settings.alertSlackWebhookUrl]);
  if (settings.alertWebhookUrl) out.push(['webhook', settings.alertWebhookUrl]);
  return out;
}

/** POSTs JSON; resolves to an error description (without the URL), or null on a 2xx answer. */
async function post(deps: NotifierDeps, url: string, body: unknown): Promise<string | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError')
      return `no answer within ${TIMEOUT_MS / 1000} seconds`;
    const message = (err instanceof Error ? err.message : String(err)).split(url).join('<url>');
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return typeof code === 'string' ? `${message} (${code})` : message;
  }
}

function slackText(alerts: Pick<AlertPayload, 'message' | 'store'>[]): string {
  const lines = alerts.map(
    (a) => `• ${a.store ? `*${escapeSlack(a.store.name)}*: ` : ''}${escapeSlack(a.message)}`,
  );
  const title = alerts.length === 1 ? 'Store Sync alert' : `${alerts.length} Store Sync alerts`;
  return [`:warning: ${title}`, ...lines].join('\n');
}

/** Slack treats <, > and & as markup. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
