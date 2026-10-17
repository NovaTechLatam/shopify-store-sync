import { api } from '../api.js';
import { h, icon, replace, uid } from '../dom.js';
import {
  AUTH_MODES,
  connectionError,
  credentialFields,
  readCredentials,
  setupSteps,
} from '../credentials.js';
import { refreshStatus } from '../shell.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  card,
  field,
  input,
  linkButton,
  pageHeader,
  withBusy,
} from '../ui.js';

export function render({ root, setTitle }) {
  setTitle('Add store');
  const error = h('div', {
    class: 'form-error form-error-large',
    role: 'alert',
    tabindex: '-1',
    hidden: true,
  });
  const name = input({ name: 'name', required: true, maxlength: 100, autocomplete: 'off' });
  const domain = input({
    name: 'shopDomain',
    required: true,
    maxlength: 255,
    placeholder: 'my-brand.myshopify.com',
    autocomplete: 'off',
    spellcheck: 'false',
    autocapitalize: 'none',
  });
  const buffer = input({
    type: 'number',
    name: 'safetyBuffer',
    min: 0,
    max: 100000,
    step: 1,
    inputmode: 'numeric',
    value: 0,
    class: 'input input-short',
  });

  const modeName = uid('mode');
  const panels = {};
  const modeChoices = Object.entries(AUTH_MODES).map(([mode, info], index) => {
    const radio = h('input', {
      type: 'radio',
      name: modeName,
      value: mode,
      checked: index === 0,
      id: `${modeName}-${mode}`,
    });
    radio.addEventListener('change', () => showMode(mode));
    // Disabled fieldsets are neither validated nor submitted.
    panels[mode] = h(
      'fieldset',
      { class: 'mode-panel', disabled: index !== 0, hidden: index !== 0 },
      h('legend', { class: 'sr-only' }, `${info.label} details`),
      h('h3', { class: 'subheading' }, 'How to get these'),
      setupSteps(mode),
      credentialFields(mode),
    );
    return h(
      'label',
      { class: 'choice', for: radio.id },
      radio,
      h(
        'span',
        { class: 'choice-body' },
        h(
          'span',
          { class: 'choice-title' },
          info.label,
          badge(info.tag, mode === 'client_credentials' ? 'success' : 'neutral'),
        ),
        h('span', { class: 'choice-text' }, info.summary),
      ),
    );
  });
  const showMode = (mode) => {
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== mode;
      panel.disabled = key !== mode;
    }
  };

  const submit = button('Connect store', { type: 'submit', variant: 'primary' });
  const form = h(
    'form',
    { class: 'stack-lg form-narrow' },
    error,
    card(
      { title: 'Store' },
      h(
        'div',
        { class: 'stack' },
        field({
          label: 'Name',
          control: name,
          hint: 'Shown in this dashboard, for example the brand name.',
        }),
        field({
          label: 'Shopify address',
          control: domain,
          hint: 'Ends in .myshopify.com. Find it in Shopify admin → Settings → Domains.',
        }),
      ),
    ),
    card(
      {
        title: 'Connection',
        description: 'How this dashboard is allowed to read and update stock.',
      },
      h(
        'fieldset',
        { class: 'choices' },
        h('legend', { class: 'sr-only' }, 'Connection type'),
        modeChoices,
      ),
      Object.values(panels),
    ),
    card(
      { title: 'Safety buffer' },
      field({
        label: 'Units to hold back in this store',
        control: buffer,
        hint: 'Show this many fewer units in this store to avoid overselling. Example: with 10 in stock and a buffer of 2, this store shows 8. Use 0 to show everything.',
      }),
    ),
    banner(
      { tone: 'info', title: 'What happens when you connect' },
      h(
        'p',
        {},
        'We test the connection first. Once connected, this store shows the shared stock for every product that is already syncing: its current numbers for those products are replaced. Prices, images and titles are never touched.',
      ),
    ),
    h(
      'div',
      { class: 'form-actions' },
      submit,
      linkButton('Cancel', '#/stores', { variant: 'plain' }),
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const mode = form.querySelector(`input[name="${modeName}"]:checked`).value;
    const safetyBuffer = Number(buffer.value || 0);
    if (!Number.isInteger(safetyBuffer) || safetyBuffer < 0) {
      showError({ message: 'The safety buffer must be a whole number of 0 or more.' }, mode);
      return;
    }
    const body = {
      name: name.value.trim(),
      shopDomain: domain.value.trim(),
      authMode: mode,
      safetyBuffer,
      ...readCredentials(form),
    };
    try {
      const store = await withBusy(submit, () =>
        api('/api/stores', { method: 'POST', body, toastErrors: false }),
      );
      if (!store) return; // already submitting
      toast(`${store.name} is connected. Reading its products now…`);
      refreshStatus();
      location.hash = `#/stores/${store.id}`;
    } catch (err) {
      showError(err, mode);
    }
  });

  function showError(err, mode) {
    replace(
      error,
      h('div', { class: 'form-error-icon' }, icon('error', { size: 20 })),
      h('div', {}, connectionError(err, mode)),
    );
    error.hidden = false;
    error.focus();
  }

  root.append(
    pageHeader({
      title: 'Add a store',
      subtitle: 'Connect one of your brand stores. Repeat this for each store.',
      back: { href: '#/stores', label: 'Stores' },
    }),
    form,
  );
}
