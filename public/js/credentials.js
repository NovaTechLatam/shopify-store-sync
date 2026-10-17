import { h } from './dom.js';
import { field, input } from './ui.js';

/** Shared by "Add store" and "Update credentials": the fields and help for each way to connect. */

export const REQUIRED_SCOPES = [
  'read_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
];

/**
 * Features that need more permissions than syncing stock (the store page shows which are
 * allowed). Keys match the API's `store.features`.
 */
export const FEATURE_PERMISSIONS = {
  catalog: { label: 'Catalog', enables: 'Create and update products from the catalog.' },
  publishing: {
    label: 'Online Store',
    enables: 'Show the products you publish in the Online Store sales channel.',
  },
  pricing: { label: 'Prices', enables: 'Update prices from Store Sync.' },
  sales: { label: 'Reports', enables: 'Read orders for sales reports and reorder suggestions.' },
};

/**
 * The optional permissions and the features (FEATURE_PERMISSIONS keys) each one turns on. Kept
 * in step with FEATURE_SCOPES in src/shopify/scopes.ts. Stock syncing never needs them.
 */
export const OPTIONAL_SCOPES = [
  { scope: 'write_products', features: ['catalog', 'pricing'] },
  { scope: 'write_publications', features: ['publishing'] },
  { scope: 'read_orders', features: ['sales'] },
];

/** "Catalog and Prices" */
function featureNames(features) {
  const labels = features.map((f) => FEATURE_PERMISSIONS[f]?.label ?? f);
  return labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
    : (labels[0] ?? '');
}

export const AUTH_MODES = {
  client_credentials: {
    label: 'Dev Dashboard app',
    tag: 'Recommended',
    summary: 'One app for all your stores, created at dev.shopify.com.',
  },
  access_token: {
    label: 'Existing custom app',
    tag: 'Legacy',
    summary: 'An app you already created in this store’s admin, under “Develop apps”.',
  },
};

export const secretInput = (props) =>
  input({ type: 'password', autocomplete: 'off', spellcheck: 'false', ...props });

export const scopeList = (scopes = REQUIRED_SCOPES) =>
  h(
    'ul',
    { class: 'scope-list' },
    scopes.map((s) => h('li', {}, h('code', {}, s))),
  );

/** Optional permissions, each with the features it turns on. */
export const optionalScopeList = (scopes = OPTIONAL_SCOPES.map((s) => s.scope)) =>
  h(
    'ul',
    { class: 'scope-list scope-list-described' },
    scopes.map((scope) => {
      const entry = OPTIONAL_SCOPES.find((s) => s.scope === scope);
      return h(
        'li',
        {},
        h('code', {}, scope),
        entry && h('span', { class: 'muted small' }, `For ${featureNames(entry.features)}`),
      );
    }),
  );

export function setupSteps(mode) {
  if (mode === 'client_credentials') {
    return h(
      'ol',
      { class: 'steps' },
      h(
        'li',
        {},
        'Go to ',
        h('strong', {}, 'dev.shopify.com'),
        ' and open your app (or create one).',
      ),
      h(
        'li',
        {},
        'Create a version with these access scopes, then release it:',
        scopeList(),
        'To use the extra features, add these too (you can also add them later):',
        optionalScopeList(),
      ),
      h(
        'li',
        {},
        'Install the app on this store from the app’s ',
        h('strong', {}, 'Installs'),
        ' card. The store must be in the same organization as the app.',
      ),
      h(
        'li',
        {},
        'Open the app’s ',
        h('strong', {}, 'Settings'),
        ', copy the ',
        h('strong', {}, 'Client ID'),
        ' and ',
        h('strong', {}, 'Client secret'),
        ', and paste them below.',
      ),
    );
  }
  return h(
    'ol',
    { class: 'steps' },
    h(
      'li',
      {},
      'In this store’s Shopify admin, go to ',
      h('strong', {}, 'Settings → Apps and sales channels → Develop apps'),
      ' and open your app.',
    ),
    h(
      'li',
      {},
      'Check that its Admin API access scopes include:',
      scopeList(),
      'To use the extra features, add these too (you can also add them later):',
      optionalScopeList(),
    ),
    h(
      'li',
      {},
      'Under ',
      h('strong', {}, 'API credentials'),
      ', copy the ',
      h('strong', {}, 'Admin API access token'),
      ' (it starts with shpat_) and the ',
      h('strong', {}, 'API secret key'),
      '.',
    ),
    h('li', {}, 'Don’t delete this app in Shopify later: the token would stop working.'),
  );
}

/**
 * Credential fields for one mode. `optional` (when rotating) leaves every field optional:
 * blank means "keep the saved value".
 */
export function credentialFields(mode, { optional = false, clientId = '' } = {}) {
  if (mode === 'client_credentials') {
    return [
      field({
        label: 'Client ID',
        control: input({
          name: 'clientId',
          required: !optional,
          autocomplete: 'off',
          spellcheck: 'false',
          value: clientId,
          maxlength: 200,
        }),
      }),
      field({
        label: 'Client secret',
        control: secretInput({ name: 'clientSecret', required: !optional, maxlength: 500 }),
        optional,
        hint: optional ? 'Leave empty to keep the saved secret.' : null,
      }),
    ];
  }
  return [
    field({
      label: 'Admin API access token',
      control: secretInput({ name: 'accessToken', required: !optional, maxlength: 500 }),
      optional,
      hint: optional ? 'Leave empty to keep the saved token.' : null,
    }),
    field({
      label: 'API secret key',
      control: secretInput({ name: 'webhookSecret', required: !optional, maxlength: 500 }),
      optional,
      hint: 'Shown next to the access token under API credentials. Lets us check that stock updates really come from Shopify.',
    }),
  ];
}

/** Reads the filled-in credential fields of a form (blank ones are left out). */
export function readCredentials(form) {
  const body = {};
  for (const name of ['clientId', 'clientSecret', 'accessToken', 'webhookSecret']) {
    const el = form.elements.namedItem(name);
    const value = el && !el.disabled ? el.value.trim() : '';
    if (value) body[name] = value;
  }
  return body;
}

/** The connection-test failure, with the missing scopes and how to grant them. */
export function connectionError(err, mode) {
  const missing = err?.body?.missingScopes ?? [];
  return [
    h('p', { class: 'strong' }, err.message),
    missing.length > 0 &&
      h(
        'div',
        {},
        h('p', {}, 'Permissions to add:'),
        scopeList(missing),
        h(
          'p',
          {},
          mode === 'client_credentials'
            ? 'In the Dev Dashboard, create a new app version with these scopes and release it. Then approve the update in this store’s Shopify admin and try again.'
            : 'In the store’s admin, open the app under Develop apps, add these Admin API scopes, save, and try again (Shopify may show a new token).',
        ),
      ),
  ];
}
