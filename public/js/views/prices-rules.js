import { api } from '../api.js';
import { h } from '../dom.js';
import { money } from '../format.js';
import { computeTargetPrice } from '../pricing-compute.js';
import { toast } from '../toast.js';
import { badge, banner, button, card, field, input, loadInto, select, withBusy } from '../ui.js';

const rateFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });

/** The Rules tab: one card per store with its price rule and live examples. */
export async function render(container, { signal }) {
  const body = h('div', { class: 'stack-lg' });
  container.append(
    h(
      'p',
      { class: 'tab-help muted' },
      'Each store’s price is the base price converted with the store’s exchange rate, multiplied, then rounded. Saving a rule doesn’t change any prices in your stores: use “Update prices in stores…” when you’re ready.',
    ),
    body,
  );
  const reload = () =>
    loadInto(body, {
      signal,
      load: () => api('/api/prices/rules', { signal }),
      render: (data) => data.rules.map((r) => ruleCard(r, data, reload)),
    });
  await reload();
}

const MODES = [
  { value: 'none', label: 'Only to the currency’s decimals' },
  { value: 'ending', label: 'So prices end in…' },
  { value: 'multiple', label: 'To a multiple of…' },
];
const DIRECTIONS = [
  { value: 'up', label: 'Round up' },
  { value: 'nearest', label: 'To the nearest' },
  { value: 'down', label: 'Round down' },
];
const COMPARE_AT = [
  { value: 'from_base', label: 'Convert the base compare-at price the same way' },
  { value: 'markup', label: 'The price plus a markup' },
  { value: 'keep', label: 'Leave the store’s as it is' },
  { value: 'none', label: 'No compare-at price' },
];

function numberInput(value, props = {}) {
  return input({
    type: 'number',
    step: 'any',
    inputmode: 'decimal',
    class: 'input input-short',
    value,
    ...props,
  });
}

function ruleCard(r, data, reload) {
  const base = data.baseCurrency;
  const currency = r.currencyCode;
  const rule = r.rule;
  const enabled = h('input', { type: 'checkbox', class: 'checkbox-input', checked: rule.enabled });
  const multiplier = numberInput(rule.multiplier, { min: 0.000001, required: true });
  const addAmount = numberInput(rule.addAmount, { required: true });
  const roundMode = select(MODES, { value: rule.roundMode });
  const roundStep = numberInput(rule.roundStep, { min: 0.0001, required: true });
  const roundEnding = numberInput(rule.roundEnding, { min: 0 });
  const roundDirection = select(DIRECTIONS, { value: rule.roundDirection });
  const compareAtMode = select(COMPARE_AT, { value: rule.compareAtMode });
  const compareAtMarkup = numberInput(rule.compareAtMarkup, { min: 1 });

  const stepField = field({
    label: `Step (${currency})`,
    control: roundStep,
    hint: ' ',
  });
  const endingField = field({ label: `Ending (${currency})`, control: roundEnding });
  const directionField = field({ label: 'Direction', control: roundDirection });
  const markupField = field({
    label: 'Markup',
    control: compareAtMarkup,
    hint: '1.25 shows a compare-at price 25% above the price.',
  });
  const examples = h('ul', { class: 'plain-list rule-examples', 'aria-live': 'polite' });
  const error = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const save = button('Save rule', { type: 'submit', variant: 'primary', disabled: true });
  const dirtyNote = h('span', { class: 'muted small', 'aria-live': 'polite' });

  const read = () => ({
    enabled: enabled.checked,
    multiplier: Number(multiplier.value),
    addAmount: Number(addAmount.value || 0),
    roundMode: roundMode.value,
    roundStep: Number(roundStep.value),
    roundEnding: roundMode.value === 'ending' ? Number(roundEnding.value || 0) : 0,
    roundDirection: roundDirection.value,
    compareAtMode: compareAtMode.value,
    compareAtMarkup: Number(compareAtMarkup.value || 1),
  });
  const problem = (next) => {
    if (!(next.multiplier > 0)) return 'Enter a multiplier above 0, like 1 or 1.3.';
    if (!Number.isFinite(next.addAmount)) return 'Enter an amount to add, or 0.';
    if (next.roundMode !== 'none' && !(next.roundStep >= 0.0001)) {
      return 'Enter a rounding step above 0, like 1 or 0.05.';
    }
    if (
      next.roundMode === 'ending' &&
      !(next.roundEnding >= 0 && next.roundEnding < next.roundStep)
    ) {
      return 'The ending must be smaller than the step (for prices ending in .90 with a step of 1, use 0.90).';
    }
    if (next.compareAtMode === 'markup' && !(next.compareAtMarkup >= 1)) {
      return 'Enter a markup of 1 or more, like 1.25.';
    }
    return null;
  };

  const refresh = () => {
    const next = read();
    stepField.hidden = next.roundMode === 'none';
    stepField.querySelector('.field-hint').textContent =
      next.roundMode === 'ending'
        ? 'Step 1 with ending 0.90 gives 12.90; step 1000 with ending 900 gives 41,900.'
        : 'Step 5 turns 23 into 25; step 0.05 turns 12.34 into 12.35.';
    endingField.hidden = next.roundMode !== 'ending';
    directionField.hidden = next.roundMode === 'none';
    markupField.hidden = next.compareAtMode !== 'markup';
    const dirty = Object.entries(next).some(([key, value]) => value !== rule[key]);
    save.disabled = !dirty;
    dirtyNote.textContent = dirty ? 'You have unsaved changes.' : '';
    const issue = problem(next);
    examples.replaceChildren(
      ...(issue
        ? [h('li', { class: 'muted' }, 'Examples appear once the rule is complete.')]
        : exampleLines(next, data, r)),
    );
  };

  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    r.canUpdate
      ? null
      : banner(
          { tone: 'warning', title: 'Store Sync may not change prices in this store yet' },
          h(
            'p',
            {},
            `It needs the “${r.missingScopes.join('”, “')}” permission. `,
            h('a', { href: `#/stores/${r.storeId}` }, 'See the store’s permissions'),
            '.',
          ),
        ),
    h(
      'label',
      { class: 'checkbox' },
      enabled,
      h(
        'span',
        {},
        'Manage this store’s prices with this rule',
        h(
          'span',
          { class: 'field-hint block' },
          'When it’s off, Store Sync never changes this store’s prices, except products you give a fixed price.',
        ),
      ),
    ),
    h(
      'div',
      { class: 'rule-grid' },
      field({
        label: 'Multiply by',
        control: multiplier,
        hint: '1.3 is 30% above the converted base price.',
      }),
      field({
        label: `Then add (${currency})`,
        control: addAmount,
        hint: 'Use a minus sign to subtract.',
      }),
    ),
    h(
      'div',
      { class: 'rule-grid' },
      field({ label: 'Round', control: roundMode }),
      stepField,
      endingField,
      directionField,
    ),
    h(
      'div',
      { class: 'rule-grid' },
      field({ label: 'Compare-at price', control: compareAtMode }),
      markupField,
    ),
    h('div', { class: 'rule-preview' }, h('p', { class: 'field-label' }, 'Examples'), examples),
    error,
    h('div', { class: 'form-actions' }, save, dirtyNote),
  );
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const next = read();
    const issue = problem(next);
    error.hidden = !issue;
    error.textContent = issue ?? '';
    if (issue) return;
    const saved = await withBusy(save, () =>
      api(`/api/prices/rules/${r.storeId}`, { method: 'PUT', body: next }),
    ).catch(() => null);
    if (!saved) return;
    toast(
      next.enabled
        ? `Rule saved for ${r.storeName}. Its prices change when you update prices in stores.`
        : `Rule saved. Store Sync won’t change ${r.storeName}’s prices (except fixed prices).`,
    );
    reload();
  });

  const converts = currency !== base;
  return card(
    {
      title: r.storeName,
      description: converts
        ? [
            `Prices in ${currency} · 1 ${base} = ${rateFormat.format(r.exchangeRate)} ${currency} · `,
            h('a', { href: `#/stores/${r.storeId}` }, 'Change the exchange rate'),
          ]
        : `Prices in ${currency}, the base currency.`,
      actions: rule.enabled && r.saved ? badge('On', 'success', 'check') : badge('Off', 'neutral'),
      className: 'rule-card',
    },
    form,
  );
}

/** "Base $24.99 → COP 112,900 (compare at …)" for a few base prices, with the rule as typed. */
function exampleLines(rule, data, r) {
  const base = data.baseCurrency;
  const samples = data.samples.length
    ? data.samples
    : [10, 25, 99.99].map((basePrice) => ({ basePrice, baseCompareAtPrice: null, sku: null }));
  return samples.map((s) => {
    const target = computeTargetPrice({
      basePrice: s.basePrice,
      baseCompareAtPrice: s.baseCompareAtPrice,
      exchangeRate: r.exchangeRate,
      rule: { ...rule, enabled: true },
      currencyCode: r.currencyCode,
      override: null,
    });
    const compareAt = target.compareAtPrice;
    return h(
      'li',
      {},
      s.sku && h('span', { class: 'mono muted' }, `${s.sku} `),
      `${money(s.basePrice, base)} → `,
      h('strong', {}, money(target.price, r.currencyCode)),
      typeof compareAt === 'number' &&
        h('span', { class: 'muted' }, ` (compare at ${money(compareAt, r.currencyCode)})`),
      compareAt === 'keep' && h('span', { class: 'muted' }, ' (compare-at price kept)'),
    );
  });
}
