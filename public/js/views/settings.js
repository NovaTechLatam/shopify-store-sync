import { api, latestOnly } from '../api.js';
import { formDialog } from '../dialog.js';
import { h, icon, replace } from '../dom.js';
import { refreshStatus, resumeSync } from '../shell.js';
import { toast } from '../toast.js';
import {
  banner,
  button,
  card,
  field,
  input,
  loadInto,
  pageHeader,
  select,
  withBusy,
} from '../ui.js';

export async function render({ root, signal, setTitle }) {
  setTitle('Settings');
  const body = h('div', { class: 'stack-lg form-narrow' });
  root.append(pageHeader({ title: 'Settings' }), body);
  const reload = latestOnly(signal, (reqSignal) =>
    loadInto(body, {
      signal: reqSignal,
      keepContent: true,
      load: () => api('/api/settings', { signal: reqSignal }),
      render: (settings) => [syncCard(settings, reload), settingsForm(settings, reload)],
    }),
  );
  await reload();
}

function syncCard(settings, reload) {
  if (settings.syncPaused) {
    return card(
      { title: 'Sync' },
      banner(
        {
          tone: 'warning',
          iconName: 'pause',
          title: 'Sync is paused',
          actions: button('Resume sync', {
            variant: 'primary',
            onClick: async (e) => {
              if (await resumeSync(e.currentTarget)) reload();
            },
          }),
        },
        h('p', {}, settings.pausedReason || 'Paused from the dashboard.'),
        h(
          'p',
          { class: 'muted' },
          'Changes made in your stores while paused are counted when you resume.',
        ),
      ),
    );
  }
  return card(
    {
      title: 'Sync',
      description:
        'Emergency stop: pausing stops every stock update to your stores until you resume. Use it if something looks wrong.',
    },
    h(
      'div',
      { class: 'variant-row' },
      h('p', { class: 'text-success' }, icon('check'), ' Sync is running.'),
      button('Pause all syncing', {
        variant: 'critical',
        iconName: 'pause',
        onClick: () => pause(reload),
      }),
    ),
  );
}

async function pause(reload) {
  const reason = h('textarea', {
    class: 'input textarea',
    name: 'reason',
    maxlength: 500,
    rows: 2,
    placeholder: 'e.g. Checking a stock count',
  });
  const paused = await formDialog({
    title: 'Pause all syncing?',
    intro: h(
      'p',
      {},
      'No store is updated until you resume. Sales keep coming in and are counted when you resume, but until then each store only knows its own sales.',
    ),
    content: field({
      label: 'Reason',
      control: reason,
      optional: true,
      hint: 'Shown on the overview so everyone knows why.',
    }),
    submitLabel: 'Pause syncing',
    tone: 'critical',
    onSubmit: () =>
      api('/api/settings/pause', {
        method: 'POST',
        body: { reason: reason.value.trim() || undefined },
        toastErrors: false,
      }),
  });
  if (paused) {
    toast('Sync is paused.');
    await refreshStatus();
    reload();
  }
}

/** Editable settings: one form, saved together, sending only what changed. */
function settingsForm(settings, reload) {
  const threshold = numberInput('lowStockThreshold', settings.lowStockThreshold, 0);
  const slack = input({
    type: 'url',
    name: 'alertSlackWebhookUrl',
    value: settings.alertSlackWebhookUrl ?? '',
    placeholder: 'https://hooks.slack.com/services/…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const webhook = input({
    type: 'url',
    name: 'alertWebhookUrl',
    value: settings.alertWebhookUrl ?? '',
    placeholder: 'https://hooks.zapier.com/…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const autoStart = input({
    type: 'checkbox',
    name: 'autoInitializeNewItems',
    checked: settings.autoInitializeNewItems,
    class: 'checkbox-input',
  });
  const strategy = select(
    [
      { value: 'max', label: 'Highest number across stores' },
      { value: 'min', label: 'Lowest number across stores' },
    ],
    { name: 'autoInitializeStrategy', value: settings.autoInitializeStrategy },
  );
  const massZero = numberInput('massZeroLimit', settings.massZeroLimit, 0);
  const retention = numberInput('eventRetentionDays', settings.eventRetentionDays, 7);

  const read = () => ({
    lowStockThreshold: Number(threshold.value),
    alertSlackWebhookUrl: slack.value.trim() || null,
    alertWebhookUrl: webhook.value.trim() || null,
    autoInitializeNewItems: autoStart.checked,
    autoInitializeStrategy: strategy.value,
    massZeroLimit: Number(massZero.value),
    eventRetentionDays: Number(retention.value),
  });
  const changes = () =>
    Object.fromEntries(Object.entries(read()).filter(([key, value]) => value !== settings[key]));

  const save = button('Save settings', { type: 'submit', variant: 'primary', disabled: true });
  const dirtyNote = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const testResult = h('p', { class: 'small', role: 'status' });
  const hasDestination = Boolean(settings.alertSlackWebhookUrl || settings.alertWebhookUrl);
  const test = button('Send test alert', {
    size: 'small',
    disabled: !hasDestination,
    onClick: () => sendTest(test, testResult),
  });
  const testHint = h(
    'p',
    { class: 'field-hint' },
    hasDestination
      ? 'Sends a test message to the saved addresses.'
      : 'Add and save an address first.',
  );

  const actions = h('div', { class: 'form-actions save-bar' }, save, dirtyNote);
  const form = h(
    'form',
    { class: 'stack-lg' },
    card(
      { title: 'Low stock' },
      field({
        label: 'Default low-stock alert at',
        control: threshold,
        hint: 'Get an alert when a product’s shared stock drops to this number or below. You can change it per product.',
      }),
    ),
    card(
      { title: 'Where to send alerts' },
      h(
        'div',
        { class: 'stack' },
        field({
          label: 'Slack webhook URL',
          control: slack,
          optional: true,
          hint: 'In Slack, create an “Incoming Webhook” for a channel and paste its address here.',
        }),
        field({
          label: 'Webhook URL',
          control: webhook,
          optional: true,
          hint: 'Receives every alert as JSON. Use Zapier or Make to forward alerts to WhatsApp or email.',
        }),
        h('div', { class: 'test-alert' }, test, testHint, testResult),
      ),
    ),
    card(
      { title: 'New products' },
      h(
        'div',
        { class: 'stack' },
        h(
          'label',
          { class: 'checkbox' },
          autoStart,
          h(
            'span',
            {},
            'Start syncing new products automatically',
            h(
              'span',
              { class: 'field-hint block' },
              'When a product shows up in your stores after setup, it starts syncing without you doing anything.',
            ),
          ),
        ),
        field({ label: 'Starting number for new products', control: strategy }),
      ),
    ),
    card(
      { title: 'Safety' },
      field({
        label: 'Pause sync if more products than this sell out within 10 minutes',
        control: massZero,
        hint: 'Protects you from a mistake in one store (like a bad CSV import) wiping out stock in every store. Sync pauses and you get an alert. 0 turns this off.',
      }),
    ),
    card(
      { title: 'History' },
      field({
        label: 'Keep activity for (days)',
        control: retention,
        hint: 'At least 7 days.',
      }),
    ),
    actions,
  );

  const refreshDirty = () => {
    const dirty = Object.keys(changes()).length > 0;
    save.disabled = !dirty;
    // While there is something to save, keep the button in reach at the bottom of the screen.
    actions.classList.toggle('is-dirty', dirty);
    strategy.disabled = !autoStart.checked;
    dirtyNote.textContent = dirty ? 'You have unsaved changes.' : '';
    // The test uses the saved addresses: don't let the merchant test an unsaved one by mistake.
    test.disabled = dirty || !hasDestination;
    testHint.textContent = dirty
      ? 'Save your changes first.'
      : hasDestination
        ? 'Sends a test message to the saved addresses.'
        : 'Add and save an address first.';
  };
  form.addEventListener('input', refreshDirty);
  form.addEventListener('change', refreshDirty);
  refreshDirty();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const patch = changes();
    if (Object.keys(patch).length === 0) return;
    const saved = await withBusy(save, () =>
      api('/api/settings', { method: 'PATCH', body: patch }),
    ).catch(() => null);
    if (saved) {
      toast('Settings saved.');
      reload();
    }
  });
  return form;
}

function numberInput(name, value, min) {
  return input({
    type: 'number',
    name,
    value,
    min,
    max: 1000000,
    step: 1,
    required: true,
    inputmode: 'numeric',
    class: 'input input-short',
  });
}

async function sendTest(btn, result) {
  result.textContent = '';
  const outcome = await withBusy(btn, () =>
    api('/api/settings/test-alert', { method: 'POST' }),
  ).catch(() => null);
  if (!outcome) return;
  replace(
    result,
    outcome.ok
      ? h(
          'span',
          { class: 'text-success' },
          icon('check'),
          ' Test alert sent. Check Slack or your webhook.',
        )
      : h(
          'span',
          { class: 'text-critical' },
          icon('error'),
          ` The test failed: ${outcome.error ?? 'unknown error'}`,
        ),
  );
}
