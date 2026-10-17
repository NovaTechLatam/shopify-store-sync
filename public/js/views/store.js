import { ApiError, api, latestOnly } from '../api.js';
import { confirmDialog } from '../dialog.js';
import { h, icon, replace, uid } from '../dom.js';
import { num, plural, timeAgo } from '../format.js';
import {
  AUTH_MODES,
  FEATURE_PERMISSIONS,
  connectionError,
  credentialFields,
  readCredentials,
  scopeList,
} from '../credentials.js';
import { storeProblem, storeStatusBadge } from '../labels.js';
import { refreshStatus } from '../shell.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  card,
  facts,
  field,
  input,
  loadInto,
  muted,
  pageHeader,
  replaceHeader,
  select,
  withBusy,
} from '../ui.js';

export async function render({ root, params, signal, setTitle }) {
  const storeId = Number(params[0]);
  setTitle('Store');
  const back = { href: '#/stores', label: 'Stores' };
  let header = pageHeader({ title: 'Store', back });
  const body = h('div', { class: 'stack-lg' });
  root.append(header, body);

  const reload = latestOnly(signal, (reqSignal) =>
    loadInto(body, {
      signal: reqSignal,
      keepContent: true,
      load: async () => {
        const [stores, warehouses, settings] = await Promise.all([
          api('/api/stores', { signal: reqSignal }),
          api('/api/warehouses', { signal: reqSignal }),
          api('/api/settings', { signal: reqSignal }),
        ]);
        const store = stores.find((s) => s.id === storeId);
        if (!store) throw new ApiError(404, 'This store doesn’t exist. It may have been removed.');
        return { store, warehouses, settings };
      },
      render: ({ store, warehouses, settings }) => {
        setTitle(store.name);
        header = replaceHeader(header, storeHeader(store, back, reload));
        return storeBody(store, warehouses, settings, reload);
      },
    }),
  );
  await reload();
}

function storeHeader(store, back, reload) {
  const test = button('Test connection', {
    onClick: () => withBusy(test, () => testConnection(store)),
  });
  let toggle;
  if (store.status === 'active') {
    toggle = button('Pause store', { iconName: 'pause', onClick: () => pauseStore(store, reload) });
  } else {
    toggle = button(store.status === 'paused' ? 'Resume store' : 'Try again', {
      variant: 'primary',
      iconName: store.status === 'paused' ? 'play' : 'refresh',
      onClick: () => withBusy(toggle, () => resumeStore(store, reload)),
    });
  }
  return pageHeader({
    title: store.name,
    subtitle: h(
      'a',
      { href: `https://${store.shopDomain}/admin`, target: '_blank', rel: 'noopener noreferrer' },
      store.shopDomain,
      ' ',
      icon('external', { size: 14 }),
      h('span', { class: 'sr-only' }, ' (opens Shopify admin in a new tab)'),
    ),
    back,
    badges: [storeStatusBadge(store.status)],
    actions: [test, toggle],
  });
}

function storeBody(store, warehouses, settings, reload) {
  const problem = storeProblem(store);
  return [
    problem &&
      banner(
        { tone: problem.tone, title: problem.title },
        store.lastError && h('p', { class: 'strong' }, store.lastError),
        h('p', {}, problem.hint),
      ),
    store.status === 'paused' &&
      banner(
        { tone: 'neutral', iconName: 'pause', title: 'This store is paused' },
        h(
          'p',
          {},
          'Its stock isn’t read or updated. Your other stores keep syncing with each other.',
        ),
      ),
    h('div', { class: 'grid-2' }, detailsCard(store), basicsCard(store, reload)),
    h(
      'div',
      { class: 'grid-2' },
      currencyCard(store, settings, reload),
      store.features && permissionsCard(store),
    ),
    locationsCard(store, warehouses, reload),
    maintenanceCard(store),
    credentialsCard(store, reload),
    removeCard(store),
  ];
}

function detailsCard(store) {
  const check = store.lastDriftScanAt
    ? [
        timeAgo(store.lastDriftScanAt),
        store.lastDriftCount > 0
          ? ` · ${plural(store.lastDriftCount, 'difference')} corrected`
          : ' · all matched',
      ]
    : muted('Not yet');
  return card(
    { title: 'Details' },
    facts([
      ['Connection', AUTH_MODES[store.authMode]?.label ?? store.authMode],
      ['Products', `${num(store.variantCount)} variants, ${num(store.linkedCount)} matched`],
      ['Last update from Shopify', timeAgo(store.lastWebhookAt, { never: 'None yet' })],
      ['Products last read', timeAgo(store.catalogSyncedAt, { never: 'Not yet' })],
      ['Live updates set up', timeAgo(store.webhooksRegisteredAt, { never: 'Not yet' })],
      ['Last full check', check],
      ['Connected', timeAgo(store.createdAt)],
    ]),
  );
}

function basicsCard(store, reload) {
  const name = input({ name: 'name', required: true, maxlength: 100, value: store.name });
  const buffer = input({
    type: 'number',
    name: 'safetyBuffer',
    min: 0,
    max: 100000,
    step: 1,
    required: true,
    inputmode: 'numeric',
    value: store.safetyBuffer,
    class: 'input input-short',
  });
  const save = button('Save', { type: 'submit', variant: 'primary', size: 'small' });
  const form = h(
    'form',
    { class: 'stack' },
    field({ label: 'Name', control: name }),
    field({
      label: 'Safety buffer',
      control: buffer,
      hint: `Show this many fewer units in ${store.name} to avoid overselling. With 10 in stock and a buffer of 2, it shows 8.`,
    }),
    h('div', { class: 'form-actions' }, save),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {};
    if (name.value.trim() !== store.name) body.name = name.value.trim();
    if (Number(buffer.value) !== store.safetyBuffer) body.safetyBuffer = Number(buffer.value);
    if (Object.keys(body).length === 0) {
      toast('Nothing to save: no changes.', { tone: 'info' });
      return;
    }
    const saved = await withBusy(save, () =>
      api(`/api/stores/${store.id}`, { method: 'PATCH', body }),
    ).catch(() => null);
    if (saved) {
      toast(
        body.safetyBuffer !== undefined
          ? 'Saved. The store’s numbers update in a few seconds.'
          : 'Saved.',
      );
      reload();
    }
  });
  return card({ title: 'Name and safety buffer' }, form);
}

const rateFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
});

/** "1 USD = 4,100.00 COP" */
const rateText = (rate, base, currency) => `1 ${base} = ${rateFormat.format(rate)} ${currency}`;

function currencyCard(store, settings, reload) {
  const base = settings.baseCurrency;
  const converts = store.currencyCode !== null && store.currencyCode !== base;
  return card(
    {
      title: 'Currency and time zone',
      description: 'Read from the store’s settings in Shopify.',
    },
    h(
      'div',
      { class: 'stack' },
      facts([
        ['Currency', store.currencyCode ?? muted('Not read yet')],
        ['Time zone', store.timezone ?? muted('Not read yet')],
        converts && ['Exchange rate', rateText(store.exchangeRate, base, store.currencyCode)],
      ]),
      converts && exchangeRateForm(store, base, reload),
    ),
  );
}

function exchangeRateForm(store, base, reload) {
  const rate = input({
    type: 'number',
    name: 'exchangeRate',
    value: store.exchangeRate,
    min: 0.00000001,
    max: 1000000000,
    step: 'any',
    required: true,
    inputmode: 'decimal',
    class: 'input input-short',
  });
  const preview = h('span', { class: 'preview-line', 'aria-live': 'polite' });
  const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const showPreview = () => {
    const value = Number(rate.value);
    const changed = rate.value !== '' && value > 0 && value !== store.exchangeRate;
    preview.textContent = changed ? `New rate: ${rateText(value, base, store.currencyCode)}` : '';
  };
  rate.addEventListener('input', showPreview);
  showPreview();
  const save = button('Save rate', { type: 'submit', size: 'small' });
  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    field({
      label: `${store.currencyCode} for 1 ${base}`,
      control: rate,
      hint: `Base prices and costs (in ${base}) are converted with this rate. Prices in ${store.name} change only when you update prices or publish products.`,
    }),
    error,
    h('div', { class: 'form-actions' }, save, preview),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = Number(rate.value);
    error.hidden = true;
    if (rate.value.trim() === '' || !Number.isFinite(value) || value <= 0 || value > 1e9) {
      error.textContent = `Enter how many ${store.currencyCode} one ${base} is worth, a number above 0.`;
      error.hidden = false;
      rate.focus();
      return;
    }
    if (value === store.exchangeRate) {
      toast('Nothing to save: no changes.', { tone: 'info' });
      return;
    }
    const saved = await withBusy(save, () =>
      api(`/api/stores/${store.id}`, { method: 'PATCH', body: { exchangeRate: value } }),
    ).catch(() => null);
    if (saved) {
      toast(`Exchange rate saved: ${rateText(value, base, store.currencyCode)}.`);
      reload();
    }
  });
  return form;
}

/** Which features the app's permissions on this store allow. */
function permissionsCard(store) {
  const checked = store.scopesCheckedAt !== null;
  const missing = [
    ...new Set(Object.values(store.features).flatMap((f) => (f.available ? [] : f.missingScopes))),
  ];
  return card(
    {
      title: 'Permissions for extra features',
      description: 'Syncing stock works without these. Each feature needs its own permission.',
    },
    h(
      'div',
      { class: 'stack' },
      permissionList(store, checked),
      !checked &&
        h(
          'p',
          { class: 'muted small' },
          'We haven’t read this store’s permissions yet. Click “Test connection” to check them now.',
        ),
      checked &&
        missing.length > 0 &&
        h(
          'div',
          { class: 'stack' },
          h('p', {}, 'To turn these on, add these permissions to the app:'),
          scopeList(missing),
          h(
            'p',
            { class: 'muted small' },
            store.authMode === 'client_credentials'
              ? 'In the Dev Dashboard, release a new app version with them and approve the update in this store’s Shopify admin. Then click “Test connection”.'
              : 'In the store’s admin, open the app under Develop apps, add them to the Admin API scopes and save. Then click “Test connection”.',
          ),
        ),
      checked && h('p', { class: 'muted small' }, 'Checked ', timeAgo(store.scopesCheckedAt), '.'),
    ),
  );
}

function permissionList(store, checked) {
  return h(
    'ul',
    { class: 'compact-list' },
    Object.entries(FEATURE_PERMISSIONS).map(([key, feature]) => {
      const status = store.features[key];
      return h(
        'li',
        { class: 'variant-row' },
        h(
          'div',
          {},
          h('p', { class: 'strong' }, feature.label),
          h('p', { class: 'muted small' }, feature.enables),
        ),
        !checked || !status
          ? badge('Not checked yet', 'neutral')
          : status.available
            ? badge('Allowed', 'success', 'check')
            : badge('Needs permission', 'warning', 'alert'),
      );
    }),
  );
}

function locationsCard(store, warehouses, reload) {
  const options = [
    { value: '', label: 'Not synced' },
    ...warehouses.map((w) => ({
      value: w.id,
      label: warehouses.length === 1 ? 'Holds the shared stock' : `Holds stock of ${w.name}`,
    })),
  ];
  return card(
    {
      title: 'Locations',
      description:
        'Choose the Shopify location where this store keeps the shared stock. Other locations are left alone.',
    },
    store.locations.length === 0
      ? h(
          'p',
          { class: 'muted' },
          'No locations found yet. They appear after the store’s products are read.',
        )
      : h(
          'ul',
          { class: 'compact-list' },
          store.locations.map((loc) => {
            const control = select(options, { value: loc.warehouseId ?? '' });
            control.addEventListener('change', () =>
              changeLocation(store, loc, control, warehouses, reload),
            );
            return h(
              'li',
              { class: 'location-row' },
              field({
                label: loc.name,
                control,
                hint: loc.isActive ? null : 'Inactive in Shopify',
                className: 'field-inline',
              }),
            );
          }),
        ),
  );
}

async function changeLocation(store, loc, control, warehouses, reload) {
  const warehouseId = control.value === '' ? null : Number(control.value);
  const revert = () => {
    control.value = loc.warehouseId ?? '';
  };
  const taken =
    warehouseId !== null &&
    store.locations.find((l) => l.id !== loc.id && l.warehouseId === warehouseId);
  if (taken) {
    toast(`“${taken.name}” already holds this stock. Set it to “Not synced” first.`, {
      tone: 'error',
    });
    revert();
    return;
  }
  const warehouse = warehouses.find((w) => w.id === warehouseId);
  const confirmed = await confirmDialog(
    warehouseId === null
      ? {
          title: `Stop syncing “${loc.name}”?`,
          message: h(
            'p',
            {},
            `Stock at this location stays as it is now and is no longer updated. Sales from it no longer change your other stores.`,
          ),
          confirmLabel: 'Stop syncing',
          tone: 'critical',
          onConfirm: () => saveLocation(store, loc, null),
        }
      : {
          title: `Sync stock at “${loc.name}”?`,
          message: [
            h(
              'p',
              {},
              `${store.name} will show the shared stock${warehouses.length > 1 ? ` of ${warehouse?.name}` : ''} at this location.`,
            ),
            h(
              'p',
              { class: 'strong' },
              'The numbers there now are replaced with the shared numbers for every product that is syncing.',
            ),
          ],
          confirmLabel: 'Sync this location',
          onConfirm: () => saveLocation(store, loc, warehouseId),
        },
  );
  if (confirmed) {
    toast(
      warehouseId === null
        ? `“${loc.name}” is no longer synced.`
        : `“${loc.name}” now holds the shared stock.`,
    );
    refreshStatus();
    reload();
  } else {
    revert();
  }
}

const saveLocation = (store, loc, warehouseId) =>
  api(`/api/stores/${store.id}/locations/${loc.id}`, {
    method: 'PUT',
    body: { warehouseId },
    toastErrors: false,
  });

function maintenanceCard(store) {
  const sync = button('Re-read products', {
    size: 'small',
    iconName: 'refresh',
    onClick: () =>
      withBusy(sync, async () => {
        await api(`/api/stores/${store.id}/sync-catalog`, { method: 'POST' });
        toast(`Reading products from ${store.name}. This can take a few minutes.`);
      }).catch(() => {}),
  });
  const webhooks = button('Reconnect live updates', {
    size: 'small',
    iconName: 'refresh',
    onClick: () =>
      withBusy(webhooks, async () => {
        const result = await api(`/api/stores/${store.id}/register-webhooks`, { method: 'POST' });
        toast(
          result.created.length === 0 && result.deleted.length === 0
            ? 'Live updates were already set up correctly.'
            : `Live updates set up (${num(result.created.length)} added, ${num(result.deleted.length)} removed).`,
        );
      }).catch(() => {}),
  });
  return card(
    {
      title: 'Maintenance',
      description: 'These run automatically. Use them after big changes in Shopify.',
    },
    h(
      'ul',
      { class: 'compact-list' },
      h(
        'li',
        { class: 'variant-row' },
        h(
          'div',
          {},
          h('p', { class: 'strong' }, 'Products and locations'),
          h(
            'p',
            { class: 'muted small' },
            'Reads every product, SKU and location from Shopify again.',
          ),
        ),
        sync,
      ),
      h(
        'li',
        { class: 'variant-row' },
        h(
          'div',
          {},
          h('p', { class: 'strong' }, 'Live updates'),
          h(
            'p',
            { class: 'muted small' },
            'Makes sure Shopify tells us about every stock change right away (webhooks).',
          ),
        ),
        webhooks,
      ),
    ),
  );
}

function credentialsCard(store, reload) {
  const mode = AUTH_MODES[store.authMode];
  const error = h('div', { class: 'form-error', role: 'alert', tabindex: '-1', hidden: true });
  const save = button('Test and save', { type: 'submit', variant: 'primary', size: 'small' });
  const form = h(
    'form',
    { class: 'stack' },
    h(
      'p',
      { class: 'muted small' },
      'Use this when you rotated the secret or reinstalled the app. Leave a field empty to keep the saved value.',
    ),
    credentialFields(store.authMode, { optional: true, clientId: store.clientId ?? '' }),
    error,
    h('div', { class: 'form-actions' }, save),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const body = readCredentials(form);
    if (body.clientId === store.clientId && !body.clientSecret) delete body.clientId;
    if (Object.keys(body).length === 0) {
      replace(error, icon('error'), h('span', {}, 'Enter at least one new value.'));
      error.hidden = false;
      return;
    }
    try {
      const saved = await withBusy(save, () =>
        api(`/api/stores/${store.id}`, { method: 'PATCH', body, toastErrors: false }),
      );
      if (!saved) return;
      toast('Credentials tested and saved.');
      refreshStatus();
      reload();
    } catch (err) {
      replace(error, icon('error'), h('div', {}, connectionError(err, store.authMode)));
      error.hidden = false;
      error.focus();
    }
  });
  return card(
    {
      title: 'Credentials',
      description: `Connected with: ${mode?.label ?? store.authMode}.`,
    },
    store.authMode === 'access_token' &&
      h(
        'p',
        {},
        store.hasWebhookSecret
          ? badge('API secret key saved', 'success', 'check')
          : badge('API secret key missing', 'warning', 'alert'),
      ),
    h('details', { class: 'disclosure' }, h('summary', {}, 'Update credentials'), form),
  );
}

function removeCard(store) {
  return card(
    {
      title: 'Remove store',
      description: `Stops syncing ${store.name} and removes it from this dashboard. Its stock numbers in Shopify stay exactly as they are now.`,
      className: 'card-danger',
    },
    button('Remove store', {
      variant: 'critical',
      onClick: () => removeStore(store),
    }),
  );
}

async function removeStore(store) {
  const confirmId = uid('confirm');
  const nameInput = input({ id: confirmId, autocomplete: 'off', spellcheck: 'false' });
  const removed = await confirmDialog({
    title: `Remove ${store.name}?`,
    message: [
      h(
        'p',
        {},
        'The store stops syncing right away. Its stock in Shopify isn’t changed. You can connect it again later; it then takes the shared numbers.',
      ),
      field({ label: `Type “${store.name}” to confirm`, control: nameInput }),
    ],
    confirmLabel: 'Remove store',
    tone: 'critical',
    onConfirm: async () => {
      if (nameInput.value.trim() !== store.name) {
        throw new Error(`Type the store name exactly: ${store.name}`);
      }
      await api(`/api/stores/${store.id}`, { method: 'DELETE', toastErrors: false });
    },
  });
  if (removed) {
    toast(`${store.name} was removed.`);
    refreshStatus();
    location.hash = '#/stores';
  }
}

async function testConnection(store) {
  try {
    const result = await api(`/api/stores/${store.id}/test`, { method: 'POST' });
    if (result.ok) {
      toast(`Connected to ${result.shopName ?? store.name}. All permissions are in place.`);
    } else if (result.missingScopes.length > 0) {
      toast(`Connected, but the app is missing permissions: ${result.missingScopes.join(', ')}.`, {
        tone: 'error',
      });
    } else {
      toast(`Couldn’t connect: ${result.error ?? 'unknown error'}`, { tone: 'error' });
    }
  } catch {
    // api() already showed the error.
  }
}

async function pauseStore(store, reload) {
  const paused = await confirmDialog({
    title: `Pause ${store.name}?`,
    message: h(
      'p',
      {},
      `We stop reading and updating ${store.name}’s stock until you resume it. Your other stores keep syncing with each other.`,
    ),
    confirmLabel: 'Pause store',
    tone: 'critical',
    onConfirm: () =>
      api(`/api/stores/${store.id}`, {
        method: 'PATCH',
        body: { status: 'paused' },
        toastErrors: false,
      }),
  });
  if (paused) {
    toast(`${store.name} is paused.`);
    refreshStatus();
    reload();
  }
}

async function resumeStore(store, reload) {
  try {
    await api(`/api/stores/${store.id}`, { method: 'PATCH', body: { status: 'active' } });
    toast(`${store.name} is active again. It catches up in a few seconds.`);
    refreshStatus();
    reload();
  } catch {
    // api() already showed the error.
  }
}
