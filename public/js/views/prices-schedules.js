import { api, isAbort, qs } from '../api.js';
import { confirmDialog, formDialog } from '../dialog.js';
import { debounce, h, icon, replace, uid } from '../dom.js';
import { money, plural } from '../format.js';
import { toast } from '../toast.js';
import { button, dataTable, emptyState, field, input, loadInto, muted } from '../ui.js';
import {
  amountProps,
  readAmount,
  scheduleStatusBadge,
  scheduleWhen,
  toLocalInput,
} from './prices-shared.js';

/** The "Sales & changes" tab: scheduled sales and base price changes. */
export async function render(container, { signal, watchRun }) {
  const results = h('div', { class: 'results' });
  let context = null;
  const newSale = button('New sale…', {
    iconName: 'plus',
    onClick: () => context && scheduleDialog('sale', null, context, reload),
  });
  const newChange = button('New price change…', {
    iconName: 'calendar',
    onClick: () => context && scheduleDialog('base_change', null, context, reload),
  });
  container.append(
    h(
      'div',
      { class: 'tab-toolbar' },
      h(
        'p',
        { class: 'muted' },
        'A sale lowers prices by a percentage between two dates, then puts them back. A price change sets new base prices on a date.',
      ),
      h('div', { class: 'row-actions' }, newSale, newChange),
    ),
    results,
  );
  const reload = () =>
    loadInto(results, {
      signal,
      keepContent: true,
      load: () =>
        Promise.all([
          api('/api/prices/schedules', { signal }),
          api('/api/prices?pageSize=1', { signal }),
        ]),
      render: ([schedules, prices]) => {
        context = { stores: prices.stores, baseCurrency: prices.baseCurrency, watchRun };
        if (schedules.length === 0) {
          return emptyState({
            title: 'No sales or price changes yet',
            message:
              'Plan a sale ahead: it starts and ends on its own, and your stores get the sale prices without you being there.',
            iconName: 'calendar',
          });
        }
        return scheduleTable(schedules, context, reload);
      },
    });
  await reload();
}

function scheduleTable(schedules, ctx, reload) {
  return dataTable({
    caption: 'Sales and price changes',
    rows: schedules,
    columns: [
      {
        label: 'Name',
        className: 'col-product',
        render: (s) =>
          h(
            'div',
            { class: 'product-cell' },
            h('span', { class: 'strong' }, s.name),
            h(
              'span',
              { class: 'product-meta' },
              s.kind === 'sale' ? `Sale · ${s.percentOff}% off` : 'New base prices',
            ),
          ),
      },
      { label: 'When', render: (s) => scheduleWhen(s) },
      {
        label: 'Stores',
        render: (s) =>
          s.kind === 'base_change'
            ? muted('Every store with a rule')
            : s.storeIds === null
              ? 'All stores'
              : s.stores.map((st) => st.name).join(', '),
      },
      {
        label: 'Products',
        render: (s) =>
          h(
            'span',
            { title: s.items.map((i) => i.sku).join(', ') },
            plural(s.items.length, 'product'),
          ),
      },
      {
        label: 'Status',
        render: (s) =>
          h(
            'div',
            { class: 'status-cell' },
            scheduleStatusBadge(s),
            s.status === 'failed' &&
              s.error &&
              h('span', { class: 'small' }, `Didn’t start: ${s.error}`),
          ),
      },
      {
        label: 'Actions',
        className: 'col-actions',
        render: (s) => actionsFor(s, ctx, reload),
      },
    ],
  });
}

function actionsFor(s, ctx, reload) {
  const out = [];
  if (s.status === 'scheduled') {
    out.push(
      button('Edit…', {
        size: 'small',
        attrs: { 'aria-label': `Edit “${s.name}”` },
        onClick: () => scheduleDialog(s.kind, s, ctx, reload),
      }),
    );
  }
  if (s.status === 'scheduled' || s.status === 'active') {
    const label = s.status === 'active' ? 'End now…' : 'Cancel…';
    const cancel = button(label, {
      size: 'small',
      variant: 'plain-critical',
      attrs: { 'aria-label': `${label.replace('…', '')} “${s.name}”…` },
      onClick: () => cancelSchedule(s, ctx, reload),
    });
    out.push(cancel);
  }
  return out.length ? h('div', { class: 'row-actions' }, out) : '';
}

async function cancelSchedule(s, ctx, reload) {
  const active = s.status === 'active';
  const what = s.kind === 'sale' ? 'sale' : 'price change';
  const done = await confirmDialog({
    title: active ? `End “${s.name}” now?` : `Cancel the ${what} “${s.name}”?`,
    message: h(
      'div',
      { class: 'stack' },
      h(
        'p',
        {},
        active
          ? 'Prices go back to what they were before the sale, in every store it covers. Fixed prices you changed during the sale stay as you set them.'
          : `It won’t start. Nothing changes in your stores.`,
      ),
      !active && h('p', { class: 'muted' }, 'You can plan it again with the same products later.'),
    ),
    confirmLabel: active ? 'End sale now' : `Cancel ${what}`,
    tone: 'critical',
    onConfirm: () =>
      api(`/api/prices/schedules/${s.id}/cancel`, { method: 'POST', toastErrors: false }),
  });
  if (!done) return;
  toast(
    active
      ? `“${s.name}” ended. The regular prices are going back to your stores now.`
      : `“${s.name}” is cancelled.`,
  );
  reload();
  if (active) {
    // The prices going back: show the update's progress at the top of the page.
    api(`/api/prices/runs?limit=1`)
      .then(([run]) => run && ctx.watchRun(run.id))
      .catch(() => {});
  }
}

/** Creating or editing a sale (kind 'sale') or a base price change ('base_change'). */
async function scheduleDialog(kind, schedule, ctx, reload) {
  const sale = kind === 'sale';
  const base = ctx.baseCurrency;
  const nextHour = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000);
  const name = input({
    required: true,
    maxlength: 100,
    value: schedule?.name ?? '',
    placeholder: sale ? 'e.g. Black Friday' : 'e.g. January prices',
  });
  const startsAt = input({
    type: 'datetime-local',
    required: true,
    value: toLocalInput(schedule?.startsAt ?? nextHour),
  });
  const endsAt = input({
    type: 'datetime-local',
    required: true,
    value: toLocalInput(schedule?.endsAt ?? new Date(nextHour.getTime() + 3 * 86_400_000)),
  });
  const percentOff = input({
    type: 'number',
    min: 1,
    max: 99,
    step: 'any',
    required: true,
    inputmode: 'decimal',
    class: 'input input-short',
    value: schedule?.percentOff ?? '',
  });
  const showCompareAt = h('input', {
    type: 'checkbox',
    class: 'checkbox-input',
    checked: schedule?.showCompareAt ?? true,
  });
  const storeName = uid('store');
  const stores = h(
    'fieldset',
    { class: 'checkbox-list' },
    h('legend', { class: 'field-label' }, 'Stores'),
    ctx.stores.map((s) => {
      const id = uid('store');
      return h(
        'label',
        { class: 'checkbox', for: id },
        h('input', {
          type: 'checkbox',
          id,
          name: storeName,
          value: String(s.id),
          checked: !schedule || schedule.storeIds === null || schedule.storeIds.includes(s.id),
        }),
        h(
          'span',
          {},
          s.name,
          !s.ruleEnabled &&
            h(
              'span',
              { class: 'field-hint block' },
              'Its rule is off: the sale takes the percentage off the price it has in Shopify.',
            ),
        ),
      );
    }),
  );

  // Chosen products (itemId → { sku, title, basePrice, newBase, newCompareAt }).
  const chosen = new Map(
    sale
      ? (schedule?.items ?? []).map((i) => [i.itemId, { ...i }])
      : (schedule?.changes ?? []).map((c) => [
          c.itemId,
          {
            itemId: c.itemId,
            sku: c.sku,
            title: c.title,
            basePrice: c.currentBasePrice,
            newBase: c.basePrice,
            newCompareAt: c.baseCompareAtPrice,
          },
        ]),
  );
  const picker = productPicker(chosen, { base, withPrices: !sale });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const saved = await formDialog({
    title: schedule ? `Edit “${schedule.name}”` : sale ? 'New sale' : 'New price change',
    intro: h(
      'p',
      {},
      sale
        ? 'From the start to the end, the chosen products cost less in the chosen stores. Afterwards their prices go back, unless you changed them meanwhile.'
        : 'On the date, the chosen products get new base prices, and the stores whose rule is on get the new prices.',
    ),
    content: [
      field({ label: 'Name', control: name }),
      h(
        'div',
        { class: 'rule-grid' },
        field({
          label: sale ? 'Starts' : 'On',
          control: startsAt,
          hint: `Times are in ${zone.replace(/_/g, ' ')}.`,
        }),
        sale && field({ label: 'Ends', control: endsAt }),
      ),
      sale &&
        field({
          label: 'Percent off',
          control: percentOff,
          hint: 'Between 1 and 99. Prices are rounded with each store’s rule, never up to the regular price.',
        }),
      sale &&
        h(
          'label',
          { class: 'checkbox' },
          showCompareAt,
          h(
            'span',
            {},
            'Show the regular price crossed out',
            h('span', { class: 'field-hint block' }, 'As the compare-at price in Shopify.'),
          ),
        ),
      sale && stores,
      picker.node,
    ],
    submitLabel: schedule ? 'Save' : sale ? 'Schedule sale' : 'Schedule price change',
    initialFocus: () => name,
    onSubmit: async (form) => {
      const start = new Date(startsAt.value);
      if (!name.value.trim()) throw new Error('Give it a name, like “Black Friday”.');
      if (Number.isNaN(start.getTime())) throw new Error('Choose when it starts.');
      if (chosen.size === 0) throw new Error('Choose at least one product.');
      let body;
      if (sale) {
        const end = new Date(endsAt.value);
        const percent = Number(percentOff.value);
        const storeIds = [...form.querySelectorAll(`input[name="${storeName}"]:checked`)].map(
          (el) => Number(el.value),
        );
        if (Number.isNaN(end.getTime())) throw new Error('Choose when it ends.');
        if (end <= start) throw new Error('The sale must end after it starts.');
        if (end.getTime() <= Date.now())
          throw new Error('The end is in the past. Choose a later end.');
        if (percentOff.value === '' || !(percent >= 1 && percent <= 99)) {
          throw new Error('Enter a percentage between 1 and 99.');
        }
        if (storeIds.length === 0) throw new Error('Choose at least one store.');
        body = {
          kind: 'sale',
          name: name.value.trim(),
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          storeIds: storeIds.length === ctx.stores.length ? null : storeIds,
          itemIds: [...chosen.keys()],
          percentOff: percent,
          showCompareAt: showCompareAt.checked,
        };
      } else {
        const changes = [];
        for (const c of chosen.values()) {
          if (c.newBase === null || Number.isNaN(c.newBase) || c.newBase < 0) {
            throw new Error(`Enter the new base price of ${c.sku}.`);
          }
          if (
            Number.isNaN(c.newCompareAt) ||
            (c.newCompareAt !== null && c.newCompareAt <= c.newBase)
          ) {
            throw new Error(
              `The compare-at price of ${c.sku} must be higher than its price. Leave it empty for none.`,
            );
          }
          changes.push({
            itemId: c.itemId,
            basePrice: c.newBase,
            baseCompareAtPrice: c.newCompareAt,
          });
        }
        body = {
          kind: 'base_change',
          name: name.value.trim(),
          startsAt: start.toISOString(),
          changes,
        };
      }
      if (schedule) {
        const { kind: _kind, ...patch } = body;
        return api(`/api/prices/schedules/${schedule.id}`, {
          method: 'PATCH',
          body: patch,
          toastErrors: false,
        });
      }
      return api('/api/prices/schedules', { method: 'POST', body, toastErrors: false });
    },
  });
  picker.stop();
  if (!saved) return;
  toast(
    schedule
      ? `“${saved.name}” saved.`
      : sale
        ? `Sale “${saved.name}” scheduled. It starts on its own; you don’t need to be here.`
        : `Price change “${saved.name}” scheduled.`,
  );
  reload();
}

/**
 * Search and pick products (several), for sales and price changes. With `withPrices`, each chosen
 * product gets inputs for its new base price and compare-at price.
 */
function productPicker(chosen, { base, withPrices }) {
  const search = input({ type: 'search', placeholder: 'SKU or product name', autocomplete: 'off' });
  const results = h('div', { class: 'picker-results' });
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const summary = h('div', { class: 'chosen-products' });
  let controller = null;

  const renderChosen = () => {
    if (chosen.size === 0) {
      replace(summary, h('p', { class: 'muted small' }, 'No products chosen yet.'));
      return;
    }
    replace(
      summary,
      h('p', { class: 'field-label' }, `Chosen: ${plural(chosen.size, 'product')}`),
      h(
        'ul',
        { class: 'plain-list chosen-list' },
        [...chosen.values()].map((c) => chosenRow(c)),
      ),
    );
  };
  const chosenRow = (c) => {
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'icon-button',
        'aria-label': `Remove ${c.sku}`,
        onclick: () => {
          chosen.delete(c.itemId);
          for (const box of results.querySelectorAll(`input[value="${c.itemId}"]`)) {
            box.checked = false;
          }
          renderChosen();
        },
      },
      icon('close', { size: 16 }),
    );
    if (!withPrices) {
      return h(
        'li',
        { class: 'chosen-item' },
        h('span', {}, h('span', { class: 'mono' }, c.sku), ' ', muted(c.title ?? '')),
        remove,
      );
    }
    const price = input({
      ...amountProps(base),
      class: 'input input-short',
      'aria-label': `New base price of ${c.sku}`,
      value: c.newBase ?? '',
    });
    const compareAt = input({
      ...amountProps(base),
      class: 'input input-short',
      'aria-label': `New compare-at price of ${c.sku}`,
      placeholder: 'None',
      value: c.newCompareAt ?? '',
    });
    price.addEventListener('input', () => (c.newBase = readAmount(price)));
    compareAt.addEventListener('input', () => (c.newCompareAt = readAmount(compareAt)));
    return h(
      'li',
      { class: 'chosen-item chosen-item-prices' },
      h(
        'div',
        { class: 'chosen-name' },
        h('span', { class: 'mono' }, c.sku),
        h(
          'span',
          { class: 'muted small' },
          `now ${c.basePrice === null ? 'no base price' : money(c.basePrice, base)}`,
        ),
      ),
      h(
        'div',
        { class: 'chosen-inputs' },
        h('label', { class: 'small' }, h('span', {}, 'Price'), price),
        h('label', { class: 'small' }, h('span', {}, 'Compare at'), compareAt),
      ),
      remove,
    );
  };

  const run = async () => {
    controller?.abort();
    controller = new AbortController();
    results.setAttribute('aria-busy', 'true');
    try {
      const data = await api(`/api/prices${qs({ search: search.value.trim(), pageSize: 20 })}`, {
        signal: controller.signal,
      });
      announcer.textContent = `${plural(data.total, 'product')} found`;
      replace(
        results,
        data.items.length === 0
          ? muted('No products found. Try another SKU or name.')
          : h(
              'fieldset',
              { class: 'picker' },
              h('legend', { class: 'sr-only' }, 'Products'),
              data.items.map((item) => option(item)),
            ),
      );
    } catch (err) {
      if (!isAbort(err)) replace(results, h('p', { class: 'field-error' }, err.message));
    } finally {
      results.removeAttribute('aria-busy');
    }
  };
  const option = (item) => {
    const id = uid('product');
    const box = h('input', {
      type: 'checkbox',
      id,
      value: String(item.itemId),
      checked: chosen.has(item.itemId),
    });
    box.addEventListener('change', () => {
      if (box.checked) {
        chosen.set(item.itemId, {
          itemId: item.itemId,
          sku: item.sku,
          title: item.title,
          basePrice: item.basePrice,
          newBase: item.basePrice,
          newCompareAt: item.baseCompareAtPrice,
        });
      } else {
        chosen.delete(item.itemId);
      }
      renderChosen();
    });
    return h(
      'label',
      { class: 'picker-option', for: id },
      box,
      h(
        'span',
        { class: 'picker-option-body' },
        h('span', { class: 'strong' }, item.title || item.sku),
        h(
          'span',
          { class: 'muted small' },
          h('span', { class: 'mono' }, item.sku),
          ` · base ${item.basePrice === null ? 'not set' : money(item.basePrice, base)}`,
        ),
      ),
    );
  };
  search.addEventListener('input', debounce(run, 250));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });
  renderChosen();
  run();
  return {
    node: h(
      'div',
      { class: 'product-picker' },
      field({ label: 'Find products', control: search, hint: 'Tick every product to include.' }),
      announcer,
      results,
      summary,
    ),
    stop: () => controller?.abort(),
  };
}
