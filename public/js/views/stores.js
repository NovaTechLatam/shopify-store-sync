import { api, latestOnly } from '../api.js';
import { confirmDialog, formDialog } from '../dialog.js';
import { h, icon } from '../dom.js';
import { num, plural, timeAgo } from '../format.js';
import { storeProblem, storeStatusBadge } from '../labels.js';
import { toast } from '../toast.js';
import {
  button,
  card,
  dataTable,
  emptyState,
  field,
  input,
  linkButton,
  loadInto,
  pageHeader,
} from '../ui.js';

export async function render({ root, signal, setTitle }) {
  setTitle('Stores');
  const body = h('div', { class: 'stack-lg' });
  root.append(
    pageHeader({
      title: 'Stores',
      subtitle: 'Your brand stores that share one stock.',
      actions: [linkButton('Add store', '#/stores/new', { variant: 'primary', iconName: 'plus' })],
    }),
    body,
  );
  const reload = latestOnly(signal, (reqSignal) =>
    loadInto(body, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        Promise.all([
          api('/api/stores', { signal: reqSignal }),
          api('/api/warehouses', { signal: reqSignal }),
        ]),
      render: ([stores, warehouses]) => [
        storesList(stores),
        warehousesCard(warehouses, stores, reload),
      ],
    }),
  );
  await reload();
}

function storesList(stores) {
  if (stores.length === 0) {
    return card(
      {},
      emptyState({
        title: 'No stores connected yet',
        message: 'Connect each of your brand stores. It takes about five minutes per store.',
        iconName: 'store',
        action: linkButton('Add your first store', '#/stores/new', { variant: 'primary' }),
      }),
    );
  }
  return dataTable({
    caption: 'Connected stores',
    rowHref: (s) => `#/stores/${s.id}`,
    columns: [
      {
        label: 'Store',
        className: 'col-product',
        render: (s) =>
          h(
            'div',
            { class: 'product-cell' },
            h('a', { href: `#/stores/${s.id}`, class: 'product-link' }, s.name),
            h('span', { class: 'muted small' }, s.shopDomain),
          ),
      },
      {
        label: 'Status',
        render: (s) => {
          const problem = storeProblem(s);
          return h(
            'div',
            { class: 'status-cell' },
            storeStatusBadge(s.status),
            problem && h('span', { class: `small text-${problem.tone}` }, problem.title),
          );
        },
      },
      {
        label: 'Products matched',
        align: 'end',
        render: (s) => `${num(s.linkedCount)} of ${num(s.variantCount)}`,
      },
      {
        label: 'Last update',
        render: (s) => timeAgo(s.lastWebhookAt, { never: 'None yet' }),
      },
      { label: 'Shared stock location', render: sharedLocation },
    ],
    rows: stores,
  });
}

function sharedLocation(store) {
  const mapped = store.locations.filter((l) => l.warehouseId !== null);
  if (mapped.length === 0) {
    return h('span', { class: 'text-warning' }, icon('alert'), ' Not chosen');
  }
  return mapped.map((l) => h('div', {}, l.name, !l.isActive && ' (inactive)'));
}

function warehousesCard(warehouses, stores, reload) {
  const canDelete = warehouses.length > 1;
  return card(
    {
      title: 'Warehouses',
      description:
        'Where your physical stock is kept. Most businesses have one. Each store chooses which of its Shopify locations holds this stock.',
      actions: button('Add warehouse', {
        size: 'small',
        iconName: 'plus',
        onClick: () => addWarehouse(reload),
      }),
    },
    h(
      'ul',
      { class: 'compact-list' },
      warehouses.map((w) =>
        h(
          'li',
          { class: 'variant-row' },
          h(
            'div',
            {},
            h('p', { class: 'strong' }, w.name),
            h(
              'p',
              { class: 'muted small' },
              w.mappedStores === 0
                ? 'No store location uses it yet'
                : `Used by ${plural(w.mappedStores, 'store location')}`,
            ),
          ),
          h(
            'div',
            { class: 'row-actions' },
            button('Rename', { size: 'small', onClick: () => renameWarehouse(w, reload) }),
            canDelete &&
              w.mappedStores === 0 &&
              button('Delete', {
                size: 'small',
                variant: 'plain-critical',
                onClick: () => deleteWarehouse(w, reload),
              }),
          ),
        ),
      ),
    ),
    stores.length > 0 &&
      warehouses.length === 1 &&
      h(
        'p',
        { class: 'muted small card-footnote' },
        'Only add another warehouse if you keep separate stock in another place. Each product then has a separate stock number per warehouse.',
      ),
  );
}

async function addWarehouse(reload) {
  const name = input({ name: 'name', required: true, maxlength: 100, autocomplete: 'off' });
  const created = await formDialog({
    title: 'Add a warehouse',
    intro: h(
      'p',
      {},
      'Each product gets a separate stock number in this warehouse, starting empty. Then choose, for each store, which Shopify location holds this stock.',
    ),
    content: field({ label: 'Warehouse name', control: name }),
    submitLabel: 'Add warehouse',
    onSubmit: () =>
      api('/api/warehouses', {
        method: 'POST',
        body: { name: name.value.trim() },
        toastErrors: false,
      }),
  });
  if (created) {
    toast(`Warehouse “${created.name}” added.`);
    reload();
  }
}

async function renameWarehouse(warehouse, reload) {
  const name = input({
    name: 'name',
    required: true,
    maxlength: 100,
    value: warehouse.name,
    autocomplete: 'off',
  });
  const renamed = await formDialog({
    title: 'Rename warehouse',
    content: field({ label: 'Warehouse name', control: name }),
    submitLabel: 'Save',
    onSubmit: () =>
      api(`/api/warehouses/${warehouse.id}`, {
        method: 'PATCH',
        body: { name: name.value.trim() },
        toastErrors: false,
      }),
  });
  if (renamed) {
    toast('Warehouse renamed.');
    reload();
  }
}

async function deleteWarehouse(warehouse, reload) {
  const deleted = await confirmDialog({
    title: `Delete “${warehouse.name}”?`,
    message: h(
      'p',
      {},
      'Its stock numbers are removed. No store location uses it, so nothing changes in your stores.',
    ),
    confirmLabel: 'Delete warehouse',
    tone: 'critical',
    onConfirm: () =>
      api(`/api/warehouses/${warehouse.id}`, { method: 'DELETE', toastErrors: false }),
  });
  if (deleted) {
    toast('Warehouse deleted.');
    reload();
  }
}
