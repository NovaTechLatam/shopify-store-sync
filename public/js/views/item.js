import { api, isAbort, latestOnly } from '../api.js';
import { confirmDialog, formDialog } from '../dialog.js';
import { h, icon, replace, uid } from '../dom.js';
import { num, signed, timeAgo } from '../format.js';
import { ITEM_SECTIONS } from '../item-sections.js';
import { alertBadge } from '../labels.js';
import { refreshStatus } from '../shell.js';
import { timeline } from '../timeline.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  card,
  dataTable,
  emptyState,
  field,
  input,
  linkButton,
  loadInto,
  muted,
  pageHeader,
  replaceHeader,
  withBusy,
} from '../ui.js';
import { quantity, storeQuantity } from './items.js';

// The engine applies changes within seconds; reload after that to show the new numbers.
const SETTLE_MS = 2500;

export async function render({ root, params, signal, setTitle }) {
  const itemId = Number(params[0]);
  setTitle('Product');
  const back = { href: '#/items', label: 'Products' };
  let header = pageHeader({ title: 'Product', back });
  const body = h('div', { class: 'stack-lg' });
  root.append(header, body);

  const reload = latestOnly(signal, (reqSignal) =>
    loadInto(body, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        Promise.all([
          api(`/api/items/${itemId}`, { signal: reqSignal }),
          api('/api/settings', { signal: reqSignal }),
        ]),
      render: ([item, settings]) => {
        setTitle(item.title || item.sku);
        header = replaceHeader(header, itemHeader(item, back, actions));
        return itemBody(item, settings, actions, reqSignal);
      },
    }),
  );
  const reloadSoon = () =>
    setTimeout(() => {
      if (!signal.aborted) reload();
    }, SETTLE_MS);
  const actions = { reload, reloadSoon };
  await reload();
}

function itemHeader(item, back, actions) {
  const resync = button('Sync now', {
    iconName: 'refresh',
    onClick: () =>
      withBusy(resync, async () => {
        await api(`/api/items/${item.id}/resync`, { method: 'POST' });
        toast('Checking every store for this product…');
        actions.reloadSoon();
      }).catch(() => {}),
  });
  const toggle = item.syncEnabled
    ? button('Pause syncing', { iconName: 'pause', onClick: () => pauseItem(item, actions) })
    : button('Resume syncing', {
        variant: 'primary',
        iconName: 'play',
        onClick: (e) => resumeItem(e.currentTarget, item, actions),
      });
  return pageHeader({
    title: item.title || item.sku,
    subtitle: h('span', {}, 'SKU ', h('span', { class: 'mono' }, item.sku)),
    back,
    badges: [itemStateBadge(item)],
    actions: [resync, toggle],
  });
}

function itemStateBadge(item) {
  if (!item.syncEnabled) return badge('Paused', 'neutral', 'pause');
  if (item.levels.some((l) => l.quantity === null)) return badge('Not started', 'neutral');
  return badge('Syncing', 'success', 'check');
}

function itemBody(item, settings, actions, signal) {
  const openAlerts = item.alerts.filter((a) => !a.resolvedAt);
  return [
    !item.syncEnabled &&
      banner(
        { tone: 'warning', iconName: 'pause', title: 'Syncing is paused for this product' },
        h(
          'p',
          {},
          'Stores keep the numbers they have now and are not updated for this product until you resume.',
        ),
      ),
    openAlerts.length > 0 &&
      card(
        { title: 'Open alerts' },
        h(
          'ul',
          { class: 'compact-list' },
          openAlerts.map((a) =>
            h(
              'li',
              {},
              h('div', { class: 'compact-list-head' }, alertBadge(a.kind), timeAgo(a.createdAt)),
              h('p', {}, a.message),
            ),
          ),
        ),
      ),
    item.issues.length > 0 &&
      banner(
        { tone: 'warning', title: 'Things to check' },
        h(
          'ul',
          { class: 'plain-list' },
          item.issues.map((issue) => h('li', {}, issue)),
        ),
        h(
          'p',
          { class: 'muted' },
          'Fix SKUs, tracking and missing products in Shopify; changes are picked up automatically. Updates waiting to be confirmed are retried on their own. ',
          h('a', { href: '#/mapping' }, 'Open matching'),
        ),
      ),
    item.levels.map((level) => stockCard(item, level, settings, actions)),
    ITEM_SECTIONS.map(({ name, section }) => featureSection(name, section, item, signal)),
    h(
      'div',
      { class: 'grid-2' },
      settingsCard(item, settings, actions),
      variantsCard(item, actions),
    ),
    card(
      {
        title: 'Activity',
        description: 'Every change to this product’s stock, newest first.',
        actions: linkButton('Full activity log', `#/activity?itemId=${item.id}`, {
          variant: 'plain',
          size: 'small',
        }),
      },
      item.events.length === 0
        ? emptyState({ title: 'No activity yet', iconName: 'pulse' })
        : timeline(item.events),
    ),
  ];
}

/**
 * A feature's part of the page (catalog, prices, sales, purchasing), loaded on its own: while it
 * loads it takes no room, and if it fails only it shows an error.
 */
function featureSection(name, section, item, signal) {
  const container = h('div', { class: 'item-section', dataset: { section: name } });
  const load = async () => {
    try {
      const node = await section(item, { signal });
      if (signal.aborted) return;
      if (node) replace(container, node);
      else container.remove();
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      console.warn(`item section ${name} failed`, err);
      const retry = button('Try again', {
        size: 'small',
        variant: 'plain',
        onClick: () => {
          replace(container);
          load();
        },
      });
      replace(
        container,
        h(
          'div',
          { class: 'section-error', role: 'alert' },
          icon('error'),
          h('p', {}, `Part of this page couldn’t be loaded: ${err?.message || 'unknown error'}`),
          retry,
        ),
      );
    }
  };
  load();
  return container;
}

function stockCard(item, level, settings, actions) {
  const multi = item.levels.length > 1;
  const title = multi ? `Stock in ${level.warehouseName}` : 'Shared stock';
  if (level.quantity === null) {
    return card(
      { title },
      banner(
        {
          tone: 'info',
          iconName: 'play',
          title: 'Not syncing yet',
          actions: linkButton('Start syncing', '#/onboarding', { variant: 'primary' }),
        },
        h(
          'p',
          {},
          'Choose this product’s starting number on the “Start syncing” page. Until then, its stock in each store is left alone.',
        ),
      ),
      storesTable(level),
    );
  }
  return card(
    {
      title,
      actions: [
        button('Set stock to…', {
          size: 'small',
          onClick: () => setStockDialog(item, level, actions),
        }),
        button('Add or remove units…', {
          size: 'small',
          onClick: () => adjustDialog(item, level, actions),
        }),
      ],
    },
    h(
      'div',
      { class: 'big-number' },
      h(
        'p',
        { class: 'big-number-value' },
        quantity(level.quantity, item.lowStockThreshold ?? settings.lowStockThreshold),
      ),
      h('p', { class: 'muted' }, 'units available to sell · changed ', timeAgo(level.updatedAt)),
    ),
    storesTable(level),
  );
}

function storesTable(level) {
  if (level.stores.length === 0) {
    return h(
      'p',
      { class: 'muted' },
      'No store sells this product from this warehouse yet. Check each store’s location on the Stores page.',
    );
  }
  return dataTable({
    caption: `What each store shows for ${level.warehouseName}`,
    columns: [
      { label: 'Store', render: (s) => s.storeName },
      {
        label: 'Should show',
        align: 'end',
        // Spelled out here; the products list keeps it short.
        render: (s) => (s.tracked && s.shows === null ? muted('Not syncing') : storeQuantity(s)),
      },
      {
        label: 'Last seen in store',
        align: 'end',
        render: (s) => (s.lastKnown === null ? muted('—', 'Not read yet') : num(s.lastKnown)),
      },
      {
        label: 'Variant',
        render: (s) =>
          h(
            'span',
            {},
            s.productTitle,
            s.variantTitle && s.variantTitle !== 'Default Title' ? ` · ${s.variantTitle}` : '',
          ),
      },
    ],
    rows: level.stores,
  });
}

function settingsCard(item, settings, actions) {
  const thresholdInput = input({
    type: 'number',
    name: 'threshold',
    min: 0,
    max: 1000000,
    step: 1,
    inputmode: 'numeric',
    value: item.lowStockThreshold ?? '',
    placeholder: `Default (${settings.lowStockThreshold})`,
    class: 'input input-short',
  });
  const save = button('Save', { type: 'submit', variant: 'primary', size: 'small' });
  const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const form = h(
    'form',
    { class: 'inline-form' },
    field({
      label: 'Low-stock alert at',
      control: thresholdInput,
      hint: `Get an alert when the shared stock drops to this number. Leave empty to use the default (${settings.lowStockThreshold}).`,
    }),
    error,
    h('div', { class: 'form-actions' }, save),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = thresholdInput.value.trim();
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1000000)) {
      error.textContent = 'Enter a whole number of 0 or more, or leave it empty.';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    await withBusy(save, async () => {
      await api(`/api/items/${item.id}`, { method: 'PATCH', body: { lowStockThreshold: value } });
      toast('Low-stock alert saved.');
      await actions.reload();
    }).catch(() => {});
  });
  return card({ title: 'Alerts for this product' }, form);
}

function variantsCard(item, actions) {
  const variants = new Map();
  for (const level of item.levels) for (const s of level.stores) variants.set(s.variantId, s);
  return card(
    {
      title: 'Linked in your stores',
      description: 'The variant in each store that shares this stock.',
    },
    variants.size === 0
      ? emptyState({ title: 'Not linked in any store', iconName: 'link' })
      : h(
          'ul',
          { class: 'compact-list' },
          [...variants.values()].map((s) =>
            h(
              'li',
              { class: 'variant-row' },
              h(
                'div',
                {},
                h('p', { class: 'strong' }, s.storeName),
                h(
                  'p',
                  { class: 'muted small' },
                  s.productTitle,
                  s.variantTitle && s.variantTitle !== 'Default Title'
                    ? ` · ${s.variantTitle}`
                    : '',
                ),
                !s.tracked && badge('Not tracked in Shopify', 'warning', 'alert'),
              ),
              button('Stop syncing', {
                size: 'small',
                variant: 'plain',
                onClick: () => unlinkVariant(item, s, actions),
              }),
            ),
          ),
        ),
  );
}

async function setStockDialog(item, level, actions) {
  const valueInput = input({
    type: 'number',
    name: 'value',
    min: 0,
    max: 1000000,
    step: 1,
    required: true,
    inputmode: 'numeric',
    value: Math.max(0, level.quantity),
  });
  const noteInput = input({ name: 'note', maxlength: 500, placeholder: 'e.g. Monthly count' });
  const name = uid('kind');
  // A shelf count still includes units sold but not shipped yet and units set aside; the API
  // subtracts them across every store for 'count', so it is the safe default after counting.
  const counted = h('input', {
    type: 'radio',
    name,
    value: 'count',
    checked: true,
    id: `${name}-count`,
  });
  const available = h('input', { type: 'radio', name, value: 'set', id: `${name}-set` });
  const result = await formDialog({
    title: 'Set stock to…',
    intro: h(
      'p',
      {},
      `${item.sku} has ${num(level.quantity)} available to sell${item.levels.length > 1 ? ` in ${level.warehouseName}` : ''}. Every store will show the new number (minus its safety buffer).`,
    ),
    content: [
      h(
        'fieldset',
        { class: 'radio-group' },
        h('legend', { class: 'field-label' }, 'What is this number?'),
        h(
          'label',
          { class: 'radio', for: counted.id },
          counted,
          h(
            'span',
            {},
            'Units I counted on the shelf',
            h(
              'span',
              { class: 'field-hint block' },
              'Count everything that is physically there, including units packed for orders and damaged ones. Units sold but not shipped yet, and units set aside as damaged or reserved, are subtracted so they aren’t sold.',
            ),
          ),
        ),
        h(
          'label',
          { class: 'radio', for: available.id },
          available,
          h(
            'span',
            {},
            'Units available to sell',
            h('span', { class: 'field-hint block' }, 'Used exactly as you enter it.'),
          ),
        ),
      ),
      field({ label: 'Number of units', control: valueInput }),
      field({
        label: 'Note',
        control: noteInput,
        optional: true,
        hint: 'Shown in the activity log.',
      }),
    ],
    initialFocus: () => valueInput,
    submitLabel: 'Save',
    onSubmit: async () => {
      const value = Number(valueInput.value);
      if (!Number.isInteger(value) || value < 0 || value > 1000000) {
        throw new Error('Enter a whole number between 0 and 1,000,000.');
      }
      const kind = counted.checked ? 'count' : 'set';
      await api(`/api/items/${item.id}/adjust`, {
        method: 'POST',
        body: {
          warehouseId: level.warehouseId,
          kind,
          value,
          note: noteInput.value.trim() || undefined,
        },
        toastErrors: false,
      });
      return { kind, value };
    },
  });
  if (result !== null) {
    toast(
      result.kind === 'count'
        ? `Count of ${num(result.value)} saved. Units waiting to ship or set aside are subtracted, then every store updates.`
        : `Stock set to ${num(result.value)}. Stores update in a few seconds.`,
    );
    actions.reloadSoon();
  }
}

async function adjustDialog(item, level, actions) {
  const name = uid('direction');
  const add = h('input', { type: 'radio', name, value: 'add', checked: true, id: `${name}-add` });
  const remove = h('input', { type: 'radio', name, value: 'remove', id: `${name}-remove` });
  const amountInput = input({
    type: 'number',
    name: 'amount',
    min: 1,
    max: 1000000,
    step: 1,
    required: true,
    inputmode: 'numeric',
  });
  const noteInput = input({
    name: 'note',
    maxlength: 500,
    placeholder: 'e.g. Delivery from supplier',
  });
  const preview = h('p', { class: 'preview-line', 'aria-live': 'polite' });
  const updatePreview = () => {
    const amount = Number(amountInput.value);
    if (!Number.isInteger(amount) || amount <= 0) {
      replace(preview, muted(`Now: ${num(level.quantity)}`));
      return;
    }
    const delta = remove.checked ? -amount : amount;
    replace(
      preview,
      `New stock: ${num(level.quantity)} → `,
      h('strong', {}, num(level.quantity + delta)),
    );
  };
  for (const el of [add, remove, amountInput]) el.addEventListener('input', updatePreview);
  updatePreview();

  const result = await formDialog({
    title: 'Add or remove units',
    intro: h(
      'p',
      {},
      'Use this when stock arrives or leaves outside your stores, for example a delivery from your supplier or damaged items. Enter it here once: every store is updated.',
    ),
    content: [
      h(
        'fieldset',
        { class: 'radio-group' },
        h('legend', { class: 'field-label' }, 'What happened?'),
        h('label', { class: 'radio', for: add.id }, add, 'Units arrived (add)'),
        h('label', { class: 'radio', for: remove.id }, remove, 'Units left (remove)'),
      ),
      field({ label: 'How many units', control: amountInput }),
      preview,
      field({
        label: 'Note',
        control: noteInput,
        optional: true,
        hint: 'Shown in the activity log.',
      }),
    ],
    initialFocus: () => amountInput,
    submitLabel: 'Save',
    onSubmit: async () => {
      const amount = Number(amountInput.value);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 1000000) {
        throw new Error('Enter a whole number of units, at least 1.');
      }
      if (remove.checked && amount > level.quantity) {
        throw new Error(
          `You can remove at most ${num(Math.max(0, level.quantity))} units. If your count is different, use “Set stock to…” instead.`,
        );
      }
      const value = remove.checked ? -amount : amount;
      await api(`/api/items/${item.id}/adjust`, {
        method: 'POST',
        body: {
          warehouseId: level.warehouseId,
          kind: 'adjust',
          value,
          note: noteInput.value.trim() || undefined,
        },
        toastErrors: false,
      });
      return value;
    },
  });
  if (result !== null) {
    toast(`${signed(result)} units saved. Stores update in a few seconds.`);
    actions.reloadSoon();
  }
}

async function pauseItem(item, actions) {
  const paused = await confirmDialog({
    title: 'Pause syncing this product?',
    message: h(
      'p',
      {},
      `Stores keep the numbers they show now for ${item.sku}, and they won’t be updated until you resume. A sale in one store will not lower the others.`,
    ),
    confirmLabel: 'Pause syncing',
    tone: 'critical',
    onConfirm: () =>
      api(`/api/items/${item.id}`, {
        method: 'PATCH',
        body: { syncEnabled: false },
        toastErrors: false,
      }),
  });
  if (paused) {
    toast(`Syncing paused for ${item.sku}.`);
    refreshStatus();
    actions.reload();
  }
}

async function resumeItem(btn, item, actions) {
  const ok = await withBusy(btn, async () => {
    await api(`/api/items/${item.id}`, { method: 'PATCH', body: { syncEnabled: true } });
    return true;
  }).catch(() => false);
  if (ok) {
    toast(`Syncing resumed for ${item.sku}.`);
    refreshStatus();
    actions.reloadSoon();
    actions.reload();
  }
}

async function unlinkVariant(item, s, actions) {
  const done = await confirmDialog({
    title: `Stop syncing in ${s.storeName}?`,
    message: [
      h(
        'p',
        {},
        `${s.storeName} will no longer share stock for ${item.sku}. Its number in Shopify stays as it is now.`,
      ),
      h(
        'p',
        { class: 'muted' },
        'You can undo this later from Matching → Ignored → “Match automatically”.',
      ),
    ],
    confirmLabel: 'Stop syncing',
    tone: 'critical',
    onConfirm: () =>
      api(`/api/variants/${s.variantId}/link`, {
        method: 'PUT',
        body: { itemId: null },
        toastErrors: false,
      }),
  });
  if (done) {
    toast(`${s.storeName} no longer syncs ${item.sku}.`);
    actions.reload();
  }
}
