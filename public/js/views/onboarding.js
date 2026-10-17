import { api, qs } from '../api.js';
import { h, icon, replace, srOnly, uid } from '../dom.js';
import { num, plural } from '../format.js';
import { hasMappedLocation } from '../labels.js';
import { refreshStatus, updateShell } from '../shell.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  card,
  dataTable,
  emptyState,
  filterBar,
  linkButton,
  loadInto,
  loadingState,
  muted,
  pageHeader,
  select,
  statTile,
  withBusy,
} from '../ui.js';

const STEPS = ['Before you start', 'Starting numbers', 'Review changes', 'Start syncing'];

const STRATEGIES = [
  {
    value: 'store',
    title: 'Copy one store’s numbers',
    tag: ['Recommended', 'success'],
    text: 'Pick the store whose stock numbers you trust most. The other stores are set to match it.',
  },
  {
    value: 'min',
    title: 'Lowest number across stores',
    tag: ['Safest', 'info'],
    text: 'Never promises more than any store had. You may sell a little less until you correct a count.',
  },
  {
    value: 'max',
    title: 'Highest number across stores',
    text: 'For when one store is up to date and the others show less.',
  },
  {
    value: 'sum',
    title: 'Add them up',
    text: 'Only if each store had its own separate stock that you are now putting together.',
  },
];

const ROWS_PER_PAGE = 100;
const POLL_MS = 3000;

export async function render({ root, signal, setTitle }) {
  setTitle('Start syncing');
  const stepper = h('ol', { class: 'stepper', 'aria-label': 'Steps' });
  const body = h('div', { class: 'stack-lg' });
  root.append(
    pageHeader({
      title: 'Start syncing',
      subtitle:
        'Choose one starting stock number for every product. Nothing changes in your stores until you confirm.',
    }),
    stepper,
    body,
  );
  const state = { step: 1, strategy: 'store', sourceStoreId: null, stores: [], status: null };

  function go(step, { focus = true } = {}) {
    state.step = step;
    replace(
      stepper,
      STEPS.map((label, i) =>
        h(
          'li',
          {
            class: [i + 1 < step && 'is-done', i + 1 === step && 'is-current'],
            'aria-current': i + 1 === step ? 'step' : null,
          },
          h(
            'span',
            { class: 'stepper-number' },
            i + 1 < step ? icon('check', { size: 14 }) : String(i + 1),
          ),
          h('span', { class: 'stepper-label' }, label),
        ),
      ),
    );
    const steps = { 1: intro, 2: chooseStrategy, 3: preview };
    const rendering = steps[step]?.();
    if (focus) body.querySelector('h2')?.focus({ preventScroll: false });
    return rendering;
  }

  /** Step heading; focused on step change so screen readers announce where they are. */
  const stepTitle = (text) => h('h2', { class: 'card-title', tabindex: '-1' }, text);

  async function intro() {
    await loadInto(body, {
      signal,
      load: () => Promise.all([api('/api/status', { signal }), api('/api/stores', { signal })]),
      render: ([status, stores]) => {
        updateShell(status);
        state.status = status;
        state.stores = stores;
        state.sourceStoreId ??= stores.find((s) => s.status === 'active')?.id ?? null;
        return introContent(status, stores);
      },
    });
  }

  function introContent(status, stores) {
    if (stores.length === 0) {
      return card(
        {},
        stepTitle('Connect your stores first'),
        emptyState({
          title: 'No stores yet',
          message: 'Add each of your brand stores, then come back here.',
          iconName: 'store',
          action: linkButton('Add a store', '#/stores/new', { variant: 'primary' }),
        }),
      );
    }
    const inactive = stores.filter((s) => s.status !== 'active');
    const unmapped = stores.filter((s) => s.status === 'active' && !hasMappedLocation(s));
    const checks = [
      {
        ok: inactive.length === 0,
        text:
          inactive.length === 0
            ? `${plural(stores.length, 'store')} connected`
            : `${inactive.map((s) => s.name).join(', ')} ${inactive.length === 1 ? 'is' : 'are'} paused or can’t connect. ${inactive.length === 1 ? 'It joins' : 'They join'} later and then take${inactive.length === 1 ? 's' : ''} the shared numbers.`,
        href: inactive.length ? `#/stores/${inactive[0].id}` : null,
        linkLabel: inactive.length ? `Open ${inactive[0].name}` : null,
      },
      {
        ok: unmapped.length === 0,
        text:
          unmapped.length === 0
            ? 'Every store has a location for the shared stock'
            : `Choose the shared stock location for ${unmapped.map((s) => s.name).join(', ')}`,
        href: unmapped.length ? `#/stores/${unmapped[0].id}` : null,
        linkLabel: unmapped.length ? `Choose for ${unmapped[0].name}` : null,
      },
      {
        ok: status.unmatchedVariants === 0 && status.conflicts === 0,
        text:
          status.unmatchedVariants === 0 && status.conflicts === 0
            ? `${plural(status.items.total, 'product')} matched across stores by SKU`
            : `${plural(status.items.total, 'product')} matched by SKU. ${plural(status.unmatchedVariants, 'variant')} ${status.unmatchedVariants === 1 ? 'is' : 'are'} sold in only one store and ${plural(status.conflicts, 'variant')} ${status.conflicts === 1 ? 'has' : 'have'} a duplicate SKU. You can fix these now or later.`,
        href: status.unmatchedVariants || status.conflicts ? '#/mapping' : null,
        linkLabel: 'Open matching',
      },
    ];
    const nothingToDo = status.items.uninitialized === 0;
    return [
      card(
        {},
        stepTitle('Before you start'),
        h(
          'ul',
          { class: 'checklist' },
          checks.map((c) =>
            h(
              'li',
              { class: c.ok ? 'is-ok' : 'is-warning' },
              icon(c.ok ? 'check' : 'alert', { size: 18 }),
              h(
                'span',
                {},
                srOnly(c.ok ? 'Done: ' : 'Check: '),
                c.text,
                c.href && [' ', h('a', { href: c.href }, c.linkLabel)],
              ),
            ),
          ),
        ),
      ),
      card(
        { title: 'How syncing works' },
        h(
          'ul',
          { class: 'plain-list' },
          h('li', {}, 'Each product gets one shared stock number.'),
          h('li', {}, 'Every store shows that number (minus its safety buffer, if you set one).'),
          h('li', {}, 'A sale, return or edit in any store changes the number in all stores.'),
          h('li', {}, 'Prices, images and titles are never touched.'),
        ),
      ),
      nothingToDo
        ? banner(
            {
              tone: 'success',
              title: 'Everything is already syncing',
              actions: linkButton('See products', '#/items'),
            },
            h('p', {}, 'There are no products waiting to start.'),
          )
        : h(
            'div',
            { class: 'form-actions' },
            button(`Choose starting numbers for ${plural(status.items.uninitialized, 'product')}`, {
              variant: 'primary',
              iconName: 'arrowRight',
              onClick: () => go(2),
            }),
          ),
    ];
  }

  function chooseStrategy() {
    const active = state.stores.filter((s) => s.status === 'active');
    const name = uid('strategy');
    const storeSelect = select(
      active.map((s) => ({ value: s.id, label: s.name })),
      { value: state.sourceStoreId ?? '', id: uid('source'), disabled: state.strategy !== 'store' },
    );
    storeSelect.addEventListener('change', () => {
      state.sourceStoreId = Number(storeSelect.value);
    });
    const choices = STRATEGIES.map((s) => {
      const radio = h('input', {
        type: 'radio',
        name,
        value: s.value,
        id: `${name}-${s.value}`,
        checked: state.strategy === s.value,
        disabled: s.value === 'store' && active.length === 0,
      });
      radio.addEventListener('change', () => {
        state.strategy = s.value;
        storeSelect.disabled = s.value !== 'store';
      });
      return h(
        'div',
        { class: 'choice-wrap' },
        h(
          'label',
          { class: 'choice', for: radio.id },
          radio,
          h(
            'span',
            { class: 'choice-body' },
            h('span', { class: 'choice-title' }, s.title, s.tag && badge(s.tag[0], s.tag[1])),
            h('span', { class: 'choice-text' }, s.text),
          ),
        ),
        s.value === 'store' &&
          h(
            'div',
            { class: 'choice-extra' },
            h('label', { class: 'field-label', for: storeSelect.id }, 'Store to copy'),
            storeSelect,
          ),
      );
    });
    replace(
      body,
      card(
        {},
        stepTitle('How should we pick each product’s starting number?'),
        h(
          'fieldset',
          { class: 'choices' },
          h('legend', { class: 'sr-only' }, 'Starting number'),
          choices,
        ),
        h(
          'p',
          { class: 'example' },
          icon('info'),
          h(
            'span',
            {},
            'Example: Brand A shows 10 and Brand B shows 7. Copy Brand A → 10. Lowest → 7. Highest → 10. Add them up → 17.',
          ),
        ),
      ),
      h(
        'div',
        { class: 'form-actions' },
        button('Back', { iconName: 'chevronLeft', onClick: () => go(1) }),
        button('Preview changes', {
          variant: 'primary',
          iconName: 'arrowRight',
          onClick: () => {
            if (state.strategy === 'store' && !state.sourceStoreId) {
              toast('Choose the store whose numbers should be copied.', { tone: 'error' });
              return;
            }
            go(3);
          },
        }),
      ),
    );
  }

  async function preview() {
    const content = h('div', { class: 'stack-lg' });
    replace(body, card({}, stepTitle('Review changes'), content));
    await loadInto(content, {
      signal,
      loading: loadingState({
        label: 'Reading current stock',
        note: 'Reading the current stock in every store… This can take a minute for big catalogs.',
        lines: 6,
      }),
      load: () =>
        api(
          `/api/onboarding/preview${qs({
            strategy: state.strategy,
            sourceStoreId: state.strategy === 'store' ? state.sourceStoreId : '',
          })}`,
          { signal },
        ),
      render: (result) => previewContent(result),
    });
    if (content.querySelector('.state-error')) {
      content.append(h('div', { class: 'form-actions' }, button('Back', { onClick: () => go(2) })));
    }
  }

  function previewContent(result) {
    const startable = result.rows.filter((r) => r.proposed !== null);
    if (startable.length === 0) {
      return [
        emptyState({
          title: 'Nothing to start',
          message:
            result.rows.length > 0
              ? 'None of these products are sold in the store you chose to copy. Go back and choose another option.'
              : 'No product is waiting to start, or no active store with a chosen location sells them yet.',
          iconName: 'info',
        }),
        h('div', { class: 'form-actions' }, button('Back', { onClick: () => go(2) })),
      ];
    }
    const { summary } = result;
    const stores = new Map();
    for (const row of result.rows) for (const s of row.stores) stores.set(s.storeId, s.storeName);
    const changing = startable.filter((r) => r.changes.length > 0);
    const risky = startable.filter((r) => r.changes.some((c) => changeSeverity(c)));
    const views = { changes: changing, risky, all: startable };
    let view = risky.length > 0 ? 'risky' : 'changes';
    let limit = ROWS_PER_PAGE;
    const tableArea = h('div');
    const renderTable = () => {
      const rows = views[view];
      replace(
        tableArea,
        rows.length === 0
          ? muted(
              view === 'risky'
                ? 'No store drops to zero or loses a lot.'
                : 'No store numbers change.',
            )
          : [
              changesTable(rows.slice(0, limit), stores),
              rows.length > limit &&
                h(
                  'div',
                  { class: 'form-actions' },
                  button(`Show ${num(Math.min(ROWS_PER_PAGE, rows.length - limit))} more`, {
                    onClick: () => {
                      limit += ROWS_PER_PAGE;
                      renderTable();
                    },
                  }),
                  muted(`Showing ${num(limit)} of ${num(rows.length)}`),
                ),
            ],
      );
    };
    renderTable();

    const understood = h('input', { type: 'checkbox', id: uid('understood') });
    const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const start = button(`Start syncing ${plural(startable.length, 'product')}`, {
      variant: 'primary',
      disabled: true,
      onClick: () => apply(startable, start, error),
    });
    understood.addEventListener('change', () => {
      start.disabled = !understood.checked;
    });
    const skipped = result.rows.filter((r) => r.proposed === null);

    return [
      h(
        'div',
        { class: 'stats' },
        statTile({
          label: 'Products to start',
          value: num(startable.length),
          note: `${num(summary.itemsChanging)} change in at least one store`,
        }),
        statTile({
          label: 'Store numbers to update',
          value: num(summary.storesWrites),
          note: `+${num(summary.unitsAdded)} / −${num(summary.unitsRemoved)} units in total`,
        }),
        statTile({
          label: 'Drop to zero',
          value: num(summary.zeroedInSomeStore),
          tone: summary.zeroedInSomeStore > 0 ? 'critical' : 'neutral',
          note: 'products a store will show as sold out',
        }),
        statTile({
          label: 'Skipped',
          value: num(summary.skipped),
          tone: summary.skipped > 0 ? 'warning' : 'neutral',
          note:
            state.strategy === 'store'
              ? 'not sold in the store you copy'
              : 'products that can’t start',
        }),
      ),
      filterBar({
        label: 'Rows to show',
        value: view,
        options: [
          { value: 'risky', label: 'Zeroes and big drops', count: risky.length },
          { value: 'changes', label: 'All changes', count: changing.length },
          { value: 'all', label: 'All products', count: startable.length },
        ],
        onChange: (value) => {
          view = value;
          limit = ROWS_PER_PAGE;
          renderTable();
        },
      }),
      tableArea,
      skipped.length > 0 &&
        h(
          'details',
          { class: 'disclosure' },
          h('summary', {}, `Skipped products (${num(skipped.length)})`),
          h(
            'p',
            { class: 'muted small' },
            'These are not sold in the store you chose to copy, so they don’t start now. Start them later with another option.',
          ),
          h(
            'ul',
            { class: 'plain-list mono small' },
            skipped
              .slice(0, 200)
              .map((r) => h('li', {}, `${r.sku} ${r.title ? `· ${r.title}` : ''}`)),
          ),
        ),
      banner(
        { tone: 'warning', title: 'Starting sync replaces the stock numbers in your stores' },
        h(
          'p',
          {},
          'Every store is set to the shared numbers shown above. This can’t be undone automatically. We read your stores again the moment syncing starts, so orders placed in between are counted.',
        ),
      ),
      h(
        'div',
        { class: 'confirm-box' },
        h(
          'label',
          { class: 'checkbox', for: understood.id },
          understood,
          'I understand that my stores’ stock numbers will be replaced.',
        ),
        error,
        h(
          'div',
          { class: 'form-actions' },
          button('Back', { iconName: 'chevronLeft', onClick: () => go(2) }),
          start,
        ),
      ),
    ];
  }

  async function apply(rows, start, error) {
    error.hidden = true;
    try {
      const result = await withBusy(start, () =>
        api('/api/onboarding/apply', {
          method: 'POST',
          body: {
            strategy: state.strategy,
            sourceStoreId: state.strategy === 'store' ? state.sourceStoreId : undefined,
            // Exactly the products the merchant reviewed; anything newer gets its own preview.
            poolLevelIds: rows.map((r) => r.poolLevelId),
          },
          toastErrors: false,
        }),
      );
      if (!result) return;
      refreshStatus();
      go(4);
      progress(result.queued);
    } catch (err) {
      replace(error, icon('error'), h('span', {}, err.message));
      error.hidden = false;
    }
  }

  async function progress(queued) {
    const bar = h('div', { class: 'progress-bar' });
    const meter = h(
      'div',
      {
        class: 'progress',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-label': 'Products syncing',
      },
      bar,
    );
    const text = h('p', { 'aria-live': 'polite' }, 'Starting…');
    const done = h('div');
    replace(
      body,
      card(
        {},
        stepTitle('Syncing has started'),
        h(
          'p',
          {},
          `${plural(queued, 'product')} queued. You can leave this page: syncing continues in the background.`,
        ),
        meter,
        text,
        done,
      ),
    );
    body.querySelector('h2')?.focus();

    let idleChecks = 0;
    while (!signal.aborted) {
      try {
        const status = await api('/api/status', { signal });
        updateShell(status);
        const { initialized, total, uninitialized } = status.items;
        const pending = status.queue.ready + status.queue.running;
        meter.setAttribute('aria-valuemax', String(total));
        meter.setAttribute('aria-valuenow', String(initialized));
        bar.style.width = `${total ? Math.round((initialized / total) * 100) : 100}%`;
        text.textContent = `${num(initialized)} of ${plural(total, 'product')} syncing.`;
        // Two quiet polls in a row: the queue has drained (retries may follow later).
        idleChecks = pending === 0 ? idleChecks + 1 : 0;
        if (idleChecks >= 2) {
          replace(
            done,
            banner(
              {
                tone: 'success',
                title: 'All set: your stores now share one stock',
                actions: [
                  linkButton('Go to overview', '#/', { variant: 'primary' }),
                  linkButton('See products', '#/items'),
                ],
              },
              uninitialized > 0 &&
                h(
                  'p',
                  {},
                  `${plural(uninitialized, 'product')} haven’t started (skipped, or a store couldn’t be read yet). `,
                  h('a', { href: '#/items?filter=uninitialized' }, 'See them'),
                ),
            ),
          );
          return;
        }
      } catch {
        if (signal.aborted) return;
        text.textContent = 'Couldn’t check progress. Retrying…';
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  await go(1, { focus: false });
}

/** 'zero' when a store goes to 0 from stock, 'drop' when it loses at least half (and 5+). */
function changeSeverity(c) {
  if (c.from === null || c.from <= 0 || c.to >= c.from) return null;
  if (c.to === 0) return 'zero';
  const drop = c.from - c.to;
  return drop >= 5 && drop >= c.from / 2 ? 'drop' : null;
}

function changesTable(rows, stores) {
  return dataTable({
    caption: 'Stock changes per store',
    className: 'preview-table',
    columns: [
      {
        label: 'Product',
        className: 'col-product',
        render: (r) =>
          h(
            'div',
            { class: 'product-cell' },
            h('span', { class: 'strong' }, r.title || r.sku),
            h('span', { class: 'mono muted small' }, r.sku),
          ),
      },
      {
        label: 'Shared stock',
        align: 'end',
        render: (r) => h('strong', {}, num(r.proposed)),
      },
      ...[...stores].map(([storeId, storeName]) => ({
        label: storeName,
        align: 'end',
        render: (r) => changeCell(r, storeId),
      })),
    ],
    rows,
  });
}

function changeCell(row, storeId) {
  const s = row.stores.find((x) => x.storeId === storeId);
  if (!s) return muted('—', 'Not sold in this store');
  const c = row.changes.find((x) => x.storeId === storeId);
  if (!c) return h('span', { class: 'muted' }, num(s.live), srOnly(' (no change)'));
  const severity = changeSeverity(c);
  return h(
    'span',
    { class: ['change', severity && `change-${severity}`] },
    severity && icon(severity === 'zero' ? 'error' : 'alert'),
    c.from === null ? muted('none') : num(c.from),
    ' → ',
    h('strong', {}, num(c.to)),
    severity && srOnly(severity === 'zero' ? ' (drops to zero)' : ' (big drop)'),
  );
}
