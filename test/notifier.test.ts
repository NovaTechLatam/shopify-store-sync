import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAlert } from '../src/alerts/alerts.js';
import { dispatchAlerts, sendTestAlert } from '../src/alerts/notifier.js';
import { updateSettings } from '../src/settings.js';
import { Harness, silentLogger } from './helpers/harness.js';

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/secret';
const WEBHOOK_URL = 'https://hooks.zapier.com/hooks/catch/1/secret/';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** A fetch double that answers per URL and records every request. */
function fakeFetch(status: (url: string) => number | Error = () => 200) {
  const requests: { url: string; body: unknown; signal: AbortSignal | null | undefined }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: JSON.parse(String(init?.body)), signal: init?.signal });
    const answer = status(url);
    if (answer instanceof Error) throw answer;
    return new Response('ok', { status: answer });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, requests };
}

async function notified(): Promise<Record<string, boolean>> {
  const { rows } = await h.db.query<{ dedupe_key: string; notified: boolean }>(
    'SELECT dedupe_key, notified_at IS NOT NULL AS notified FROM alerts ORDER BY id',
  );
  return Object.fromEntries(rows.map((r) => [r.dedupe_key, r.notified]));
}

async function setup() {
  h = await Harness.create(1);
  const store = h.stores[0]!;
  const item = await h.addItem('TEE-BLK', [5]);
  await setAlert(h.db, {
    open: true,
    kind: 'oversold',
    dedupeKey: 'oversold:1',
    itemId: item.itemId,
    message: 'TEE-BLK is oversold: shared quantity is -1.',
  });
  await setAlert(h.db, {
    open: true,
    kind: 'store_error',
    dedupeKey: 'store_error:1',
    storeId: store.id,
    message: 'Brand <A> & co is not syncing',
  });
  return { store, item };
}

describe('alert notifier', () => {
  it('posts new alerts to Slack and to the webhook, then marks them notified', async () => {
    const { store, item } = await setup();
    await updateSettings(h.db, { alertSlackWebhookUrl: SLACK_URL, alertWebhookUrl: WEBHOOK_URL });
    const { fetchFn, requests } = fakeFetch();

    expect(await dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn })).toBe(2);

    expect(requests.map((r) => r.url)).toEqual([SLACK_URL, WEBHOOK_URL, WEBHOOK_URL]);
    expect(requests.every((r) => r.signal instanceof AbortSignal)).toBe(true);
    const slack = requests[0]!.body as { text: string };
    expect(slack.text).toContain('2 Store Sync alerts');
    expect(slack.text).toContain('TEE-BLK is oversold: shared quantity is -1.');
    expect(slack.text).toContain('*brand0*: Brand &lt;A&gt; &amp; co is not syncing');
    expect(requests[1]!.body).toEqual({
      id: expect.any(Number),
      kind: 'oversold',
      message: 'TEE-BLK is oversold: shared quantity is -1.',
      item: { id: item.itemId, sku: 'TEE-BLK' },
      store: null,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(requests[2]!.body).toMatchObject({
      kind: 'store_error',
      item: null,
      store: { id: store.id, name: 'brand0' },
    });
    expect(await notified()).toEqual({ 'oversold:1': true, 'store_error:1': true });

    // Already notified: nothing more to send.
    expect(await dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn })).toBe(0);
    expect(requests).toHaveLength(3);
  });

  it('skips resolved alerts and alerts older than a day', async () => {
    await setup();
    await updateSettings(h.db, { alertSlackWebhookUrl: SLACK_URL });
    await h.db.query(
      `UPDATE alerts SET created_at = now() - interval '25 hours' WHERE dedupe_key = 'oversold:1'`,
    );
    await setAlert(h.db, {
      open: false,
      kind: 'store_error',
      dedupeKey: 'store_error:1',
      message: '',
    });
    const { fetchFn, requests } = fakeFetch();
    expect(await dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn })).toBe(0);
    expect(requests).toEqual([]);
  });

  it('leaves alerts pending when no destination is set or none accepted them', async () => {
    await setup();
    const { fetchFn, requests } = fakeFetch(() => 500);
    expect(await dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn })).toBe(0);
    expect(requests).toEqual([]);

    await updateSettings(h.db, { alertSlackWebhookUrl: SLACK_URL, alertWebhookUrl: WEBHOOK_URL });
    expect(await dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn })).toBe(0);
    // A dead webhook is not retried for every alert in the same run.
    expect(requests.map((r) => r.url)).toEqual([SLACK_URL, WEBHOOK_URL]);
    expect(await notified()).toEqual({ 'oversold:1': false, 'store_error:1': false });

    const ok = fakeFetch();
    expect(await dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn: ok.fetchFn })).toBe(2);
    expect(await notified()).toEqual({ 'oversold:1': true, 'store_error:1': true });
  });

  it('counts an alert as notified when at least one destination accepted it', async () => {
    await setup();
    await updateSettings(h.db, { alertSlackWebhookUrl: SLACK_URL, alertWebhookUrl: WEBHOOK_URL });
    const { fetchFn } = fakeFetch((url) => (url === SLACK_URL ? 200 : new Error('fetch failed')));
    expect(await dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn })).toBe(2);
    expect(await notified()).toEqual({ 'oversold:1': true, 'store_error:1': true });
  });

  it('two runs at the same time never send an alert twice', async () => {
    await setup();
    await updateSettings(h.db, { alertWebhookUrl: WEBHOOK_URL });
    const { fetchFn, requests } = fakeFetch();
    const sent = await Promise.all([
      dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn }),
      dispatchAlerts({ db: h.db, logger: silentLogger, fetchFn }),
    ]);
    expect(sent[0]! + sent[1]!).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it('never logs the destination URLs', async () => {
    await setup();
    await updateSettings(h.db, { alertSlackWebhookUrl: SLACK_URL });
    const lines: string[] = [];
    const { default: pino } = await import('pino');
    const logger = pino({ level: 'debug' }, { write: (line: string) => lines.push(line) });
    const { fetchFn } = fakeFetch(() => new TypeError(`Failed to parse URL from ${SLACK_URL}`));
    await dispatchAlerts({ db: h.db, logger, fetchFn });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('secret');
  });
});

describe('test alert', () => {
  it('sends a sample to every destination and reports failures', async () => {
    h = await Harness.create(0);
    expect(await sendTestAlert({ db: h.db, logger: silentLogger })).toEqual({
      ok: false,
      error: 'No alert destination is set. Add a Slack or webhook URL first.',
    });

    await updateSettings(h.db, { alertSlackWebhookUrl: SLACK_URL, alertWebhookUrl: WEBHOOK_URL });
    const ok = fakeFetch();
    expect(await sendTestAlert({ db: h.db, logger: silentLogger, fetchFn: ok.fetchFn })).toEqual({
      ok: true,
    });
    expect(ok.requests.map((r) => r.url)).toEqual([SLACK_URL, WEBHOOK_URL]);
    expect(ok.requests[1]!.body).toMatchObject({ kind: 'test', item: null, store: null });

    const failing = fakeFetch((url) => (url === SLACK_URL ? 404 : 200));
    expect(
      await sendTestAlert({ db: h.db, logger: silentLogger, fetchFn: failing.fetchFn }),
    ).toEqual({ ok: false, error: 'Slack: HTTP 404' });
    // Nothing is stored: test alerts never show up as real alerts.
    expect((await h.db.query('SELECT 1 FROM alerts')).rowCount).toBe(0);
  });
});
