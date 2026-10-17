import { h } from './dom.js';
import { field, input } from './ui.js';

/** Shared by "Add store" and "Update credentials": the fields and help for each way to connect. */

export const REQUIRED_SCOPES = [
  'read_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
];

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
      h('li', {}, 'Create a version with these access scopes, then release it:', scopeList()),
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
    h('li', {}, 'Check that its Admin API access scopes include:', scopeList()),
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
