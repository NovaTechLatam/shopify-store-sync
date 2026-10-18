import { api, latestOnly, qs } from '../api.js';
import { confirmDialog } from '../dialog.js';
import { debounce, h, icon, replace, srOnly, uid } from '../dom.js';
import { dateOnly, days, money, num, percent, plural, timeAgo } from '../format.js';
import { toast } from '../toast.js';
import {
  badge,
  banner,
  button,
  card,
  emptyState,
  input,
  linkButton,
  loadInto,
  muted,
  pageHeader,
  pagination,
  select,
  statTile,
} from '../ui.js';

/** #/reports: sales of every brand, from the orders Store Sync reads from each store. */

const PRESETS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range' },
];

/** The products table's sorts; `first` is the direction a header click starts with. */
const SORTS = [
  { value: 'revenue', label: 'Revenue', first: 'desc' },
  { value: 'units', label: 'Units', first: 'desc' },
  { value: 'margin', label: 'Margin', first: 'desc' },
  { value: 'daysLeft', label: 'Days left', first: 'asc' },
  { value: 'sellThrough', label: 'Sell-through', first: 'desc' },
];
const SORT_OPTIONS = SORTS.flatMap((s) => [
  { value: `${s.value}:desc`, label: `${s.label}, highest first` },
  { value: `${s.value}:asc`, label: `${s.label}, lowest first` },
]);
const PAGE_SIZE = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Days of stock left below this are highlighted. */
const LOW_DAYS = 14;

export async function render({ root, query, signal, setTitle }) {
  setTitle('Reports');
  const state = readState(query);
  const filters = h('div', { class: 'report-filters' });
  const body = h('div', { class: 'stack-lg' });
  root.append(
    pageHeader({
      title: 'Reports',
      subtitle: 'Sales of all your brands together, from every store’s orders.',
    }),
    filters,
    body,
  );

  // Stores, time zone and how complete each store's history is: loaded once per visit (again
  // after an import is restarted).
  let status = null;
  // Parts of the products card that outlive a reload of its rows.
  const view = {
    products: h('div', { class: 'results' }),
    announcer: h('p', { class: 'sr-only', 'aria-live': 'polite' }),
    csv: null,
    sortSelect: null,
  };

  const periodQuery = () => {
    const range = rangeOf(state, status.timezone);
    return {
      from: range.from,
      to: range.to,
      storeIds: state.storeIds ? [...state.storeIds].join(',') : '',
    };
  };

  const loadProducts = latestOnly(signal, async (reqSignal) => {
    writeUrl(state);
    const params = { ...periodQuery(), search: state.search, sort: state.sort, dir: state.dir };
    // The download follows what's on screen.
    if (view.csv) view.csv.href = `/api/reports/products.csv${qs(params)}`;
    if (view.sortSelect) view.sortSelect.value = `${state.sort}:${state.dir}`;
    await loadInto(view.products, {
      signal: reqSignal,
      keepContent: true,
      load: () =>
        api(`/api/reports/products${qs({ ...params, page: state.page, pageSize: PAGE_SIZE })}`, {
          signal: reqSignal,
        }),
      render: (list) => {
        view.announcer.textContent = `${plural(list.total, 'product')} found`;
        return productsTable(list, state, status, {
          onSort,
          onPage: (page) => {
            state.page = page;
            loadProducts().then(() => view.products.scrollIntoView({ block: 'start' }));
          },
        });
      },
    });
  });

  const onSort = (value, dir) => {
    state.sort = value;
    state.dir = dir;
    state.page = 1;
    loadProducts();
  };
  const onSearch = debounce((value) => {
    state.search = value.trim();
    state.page = 1;
    loadProducts();
  }, 300);

  const onResync = async (store) => {
    const ok = await confirmDialog({
      title: `Import the order history of “${store.name}” again?`,
      message:
        'Store Sync reads this store’s orders from Shopify again, as far back as Shopify allows (useful after giving it the “read all orders” permission). Sales already in your reports stay while it runs; it usually takes a few minutes.',
      confirmLabel: 'Import again',
      onConfirm: () => api(`/api/reports/stores/${store.storeId}/resync`, { method: 'POST' }),
    });
    if (!ok) return;
    toast(`Importing the order history of ${store.name}. Reports fill in when it’s done.`);
    status = null;
    reload();
  };

  let filterControls = null;
  const reload = latestOnly(signal, async (reqSignal) => {
    writeUrl(state);
    await loadInto(body, {
      signal: reqSignal,
      keepContent: true,
      load: async () => {
        status ??= await api('/api/reports/status', { signal: reqSignal });
        if (status.stores.length === 0) return { summary: null };
        const summary = await api(`/api/reports/summary${qs(periodQuery())}`, {
          signal: reqSignal,
        });
        return { summary };
      },
      render: ({ summary }) => {
        if (!filterControls && status.stores.length > 0) {
          filterControls = reportFilters(state, status, () => {
            state.page = 1;
            reload();
          });
          replace(filters, filterControls);
        }
        if (!summary) return noStores();
        const { nodes, withProducts } = reportBody(summary, status, state, {
          view,
          onSearch,
          onSort,
          onResync,
        });
        if (withProducts) loadProducts();
        return nodes;
      },
    });
  });

  await reload();
}

function readState(query) {
  const sort = SORTS.some((s) => s.value === query.get('sort')) ? query.get('sort') : 'revenue';
  const state = {
    period: PRESETS.some((p) => p.value === query.get('period')) ? query.get('period') : '30d',
    from: DATE.test(query.get('from') ?? '') ? query.get('from') : '',
    to: DATE.test(query.get('to') ?? '') ? query.get('to') : '',
    storeIds: parseIds(query.get('stores')),
    sort,
    dir: ['asc', 'desc'].includes(query.get('dir'))
      ? query.get('dir')
      : SORTS.find((s) => s.value === sort).first,
    search: query.get('search') ?? '',
    page: Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1),
  };
  if (state.period === 'custom' && rangeProblem(state.from, state.to)) state.period = '30d';
  return state;
}

/** Keeps the report in the address (refresh, sharing) without re-rendering the page. */
function writeUrl(state) {
  const sort = SORTS.find((s) => s.value === state.sort);
  history.replaceState(
    null,
    '',
    `#/reports${qs({
      period: state.period === '30d' ? '' : state.period,
      from: state.period === 'custom' ? state.from : '',
      to: state.period === 'custom' ? state.to : '',
      stores: state.storeIds ? [...state.storeIds].join(',') : '',
      sort: state.sort === 'revenue' ? '' : state.sort,
      dir: state.dir === sort.first ? '' : state.dir,
      search: state.search,
      page: state.page > 1 ? state.page : '',
    })}`,
  );
}

// ---- filters ----------------------------------------------------------------------------------

/**
 * Period chips (with a custom range form) and store chips. Built once: a click updates the chips
 * in place, so keyboard focus stays where it was.
 */
function reportFilters(state, status, onChange) {
  const periodChips = PRESETS.map((p) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        dataset: { value: p.value },
        'aria-controls': p.value === 'custom' ? 'report-range' : null,
      },
      p.value === 'custom' && icon('calendar', { size: 14 }),
      p.label,
    ),
  );
  const range = customRange((from, to) => {
    state.period = 'custom';
    state.from = from;
    state.to = to;
    sync();
    onChange();
  });

  const storeChips =
    status.stores.length > 1
      ? [
          h('button', { type: 'button', class: 'chip', dataset: { store: 'all' } }, 'All stores'),
          ...status.stores.map((s) =>
            h(
              'button',
              { type: 'button', class: 'chip', dataset: { store: String(s.storeId) } },
              h('span', {
                class: ['swatch', seriesClass(status, s.storeId)],
                'aria-hidden': 'true',
              }),
              s.name,
            ),
          ),
        ]
      : [];

  const sync = () => {
    for (const chip of periodChips) {
      const pressed = chip.dataset.value === state.period;
      chip.setAttribute('aria-pressed', String(pressed));
      if (chip.dataset.value === 'custom') chip.setAttribute('aria-expanded', String(pressed));
    }
    range.form.hidden = state.period !== 'custom';
    for (const chip of storeChips) {
      const id = chip.dataset.store;
      const pressed = id === 'all' ? state.storeIds === null : !!state.storeIds?.has(Number(id));
      chip.setAttribute('aria-pressed', String(pressed));
    }
  };

  for (const chip of periodChips) {
    chip.addEventListener('click', () => {
      const value = chip.dataset.value;
      if (value === 'custom') {
        // Opens the form on the period on screen (so nothing changes until "Show").
        if (state.period !== 'custom') {
          const current = rangeOf(state, status.timezone);
          Object.assign(state, { period: 'custom', from: current.from, to: current.to });
          range.set(current);
        }
        sync();
        range.focus();
        return;
      }
      state.period = value;
      sync();
      onChange();
    });
  }
  for (const chip of storeChips) {
    chip.addEventListener('click', () => {
      const id = chip.dataset.store;
      if (id === 'all') state.storeIds = null;
      else {
        const next = new Set(state.storeIds ?? []);
        if (next.has(Number(id))) next.delete(Number(id));
        else next.add(Number(id));
        // None, or every store: that's all stores.
        state.storeIds = next.size === 0 || next.size === status.stores.length ? null : next;
      }
      sync();
      onChange();
    });
  }

  range.set(rangeOf(state, status.timezone));
  sync();
  return h(
    'div',
    { class: 'report-filters-inner' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Period' }, periodChips),
    range.form,
    storeChips.length > 0 &&
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Stores' }, storeChips),
  );
}

function customRange(onApply) {
  const from = input({ type: 'date', id: uid('from') });
  const to = input({ type: 'date', id: uid('to') });
  const error = h('p', { class: 'field-error', role: 'alert', id: uid('range-error') });
  error.hidden = true;
  for (const el of [from, to]) {
    el.setAttribute('aria-describedby', error.id);
    el.addEventListener('input', () => {
      error.hidden = true;
      from.removeAttribute('aria-invalid');
      to.removeAttribute('aria-invalid');
    });
  }
  const form = h(
    'form',
    { class: 'report-range', id: 'report-range', novalidate: true },
    h(
      'div',
      { class: 'report-range-fields' },
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field-label', for: from.id }, 'From'),
        from,
      ),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: to.id }, 'To'), to),
      button('Show', { type: 'submit', variant: 'primary' }),
    ),
    error,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const problem = rangeProblem(from.value, to.value);
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      from.setAttribute('aria-invalid', 'true');
      to.setAttribute('aria-invalid', 'true');
      (DATE.test(from.value) ? to : from).focus();
      return;
    }
    onApply(from.value, to.value);
  });
  return {
    form,
    set: (range) => {
      from.value = range.from ?? '';
      to.value = range.to ?? '';
    },
    focus: () => from.focus(),
  };
}

/** What's wrong with a custom range, in words; null when it's fine. */
export function rangeProblem(from, to) {
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '')) return 'Enter a start and an end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  if (daysBetween(from, to) > 3660) return 'Choose a period of at most 10 years.';
  return null;
}

// ---- the report ----------------------------------------------------------------------------------

function reportBody(summary, status, state, actions) {
  const coverage = summary.coverage.stores;
  if (coverage.length > 0 && coverage.every((c) => c.permission === 'missing')) {
    return { nodes: [noPermission(coverage)], withProducts: false };
  }

  const t = summary.totals;
  const base = summary.baseCurrency;
  const nothing = t.orders === 0 && t.units === 0 && t.revenue === 0;
  const notes = coverageNotes(summary);
  const issues = notes.filter((n) => n.tone !== 'neutral');
  // Stores still importing a history that reaches into this period.
  const importing = coverage.filter(
    (c) =>
      c.permission !== 'missing' &&
      ['none', 'running'].includes(c.backfill.status) &&
      (!c.historyFrom || summary.to >= c.historyFrom),
  );

  const nodes = [
    issues.length > 0 &&
      banner(
        {
          tone: issues.some((n) => n.tone === 'warning') ? 'warning' : 'info',
          title:
            issues.length === 1
              ? 'One store’s sales may be incomplete'
              : `${issues.length} stores’ sales may be incomplete`,
        },
        h(
          'ul',
          { class: 'report-issues' },
          issues.map((n) => h('li', {}, n.text)),
        ),
      ),
    h(
      'div',
      { class: 'stats report-stats', role: 'group', 'aria-label': 'Totals for the period' },
      statTile({
        label: `Revenue (${base})`,
        value: money(t.revenue, base),
        note: 'After discounts and refunds, before tax',
      }),
      statTile({ label: 'Units sold', value: num(t.units), note: 'Refunded units left out' }),
      statTile({ label: 'Orders', value: num(t.orders), note: 'Test and cancelled ones left out' }),
      statTile({
        label: 'Margin',
        value: percent(t.margin),
        note:
          t.margin === null
            ? nothing
              ? 'No sales in the period'
              : 'Add product costs to see it'
            : t.revenueWithoutCost > 0
              ? `${money(t.revenueWithoutCost, base)} of sales have no cost`
              : 'On every sale in the period',
      }),
    ),
  ];

  if (nothing) {
    nodes.push(
      importing.length > 0
        ? emptyState({
            title: 'Importing your order history',
            message: `Store Sync is reading the orders of ${listNames(importing)} from Shopify. This page fills in when it’s done, usually within a few minutes.`,
            iconName: 'clock',
          })
        : emptyState({
            title: 'No sales in this period',
            message: 'Try a longer period, or other stores.',
            iconName: 'chart',
          }),
      coverageCard(notes, status, actions.onResync),
    );
    return { nodes, withProducts: false };
  }

  nodes.push(
    revenueChartCard(summary, status),
    storesCard(summary, status),
    productsCard(state, actions),
    coverageCard(notes, status, actions.onResync),
    howItWorks(summary, status),
  );
  return { nodes, withProducts: true };
}

function noStores() {
  return emptyState({
    title: 'No stores yet',
    message: 'Reports show your sales once your stores are connected.',
    action: linkButton('Go to stores', '#/stores', { variant: 'primary' }),
    iconName: 'store',
  });
}

function noPermission(coverage) {
  return card(
    {
      title: 'Store Sync can’t read your orders yet',
      description:
        'Reports are worked out from each store’s orders, and Shopify asks for a separate permission to read them. Stock syncing doesn’t need it, so your app may not have it yet.',
    },
    h(
      'ol',
      { class: 'steps' },
      h(
        'li',
        {},
        'In your app’s settings in Shopify, add the ',
        h('code', {}, 'read_orders'),
        ' access scope. Add ',
        h('code', {}, 'read_all_orders'),
        ' too if you want sales older than 60 days (Shopify has to approve it).',
      ),
      h('li', {}, 'Release the new app version and approve it in each store’s Shopify admin.'),
      h(
        'li',
        {},
        'On each store’s page here, click “Test connection”. The order history import starts within a minute.',
      ),
    ),
    h(
      'ul',
      { class: 'inline-links' },
      coverage.map((c) => h('li', {}, h('a', { href: `#/stores/${c.storeId}` }, `Open ${c.name}`))),
    ),
  );
}

/**
 * One line per store: how far back its sales go, and anything missing. `tone` neutral = nothing
 * to worry about; info = filling in; warning = something needs a look.
 */
function coverageNotes(summary) {
  return summary.coverage.stores.map((c) => {
    const name = c.name;
    if (c.permission === 'missing') {
      return {
        store: c,
        tone: 'warning',
        text: `${name}: no sales, because Store Sync doesn’t have permission to read this store’s orders. Open the store’s page to see how to give it.`,
      };
    }
    const b = c.backfill;
    const parts = [];
    let tone = 'neutral';
    if (b.status === 'running') {
      tone = 'info';
      parts.push(
        `${name}: importing the order history` +
          (c.historyFrom ? ` since ${dateOnly(c.historyFrom)}` : '') +
          (b.objects ? ` (${num(b.objects)} records so far)` : '') +
          '. New orders are already counted.',
      );
    } else if (b.status === 'none') {
      tone = b.error ? 'warning' : 'info';
      parts.push(
        b.error
          ? `${name}: the order history can’t be imported yet. ${b.error}`
          : c.permission === 'unknown'
            ? `${name}: the order history import starts once Store Sync has checked this store’s permissions (within 15 minutes, or click “Test connection” on the store’s page).`
            : `${name}: the order history import starts within a minute.`,
      );
    } else if (b.status === 'failed') {
      tone = 'warning';
      parts.push(
        `${name}: the order history import didn’t work (${(b.error ?? 'no reason given').replace(/\.$/, '')}). Store Sync reads the orders page by page instead, which takes longer.`,
      );
    } else {
      const since = c.historyFrom ?? c.firstOrderOn;
      parts.push(since ? `${name}: sales since ${dateOnly(since)}.` : `${name}: no orders yet.`);
      // The period starts before the history does: its first days miss this store's sales.
      if (since && summary.from < since) {
        tone = 'info';
        parts.push('Earlier days of this period have no sales from it.');
      }
    }
    if (c.historyCapped && b.status !== 'none') {
      parts.push(
        'Shopify gives the last 60 days of orders without the “read all orders” permission.',
      );
    }
    if (c.syncError) {
      tone = 'warning';
      parts.push(`The last check for new orders didn’t work: ${c.syncError}`);
    }
    if (c.storeStatus === 'paused')
      parts.push('New sales come in again when the store is resumed.');
    if (c.storeStatus === 'error' || c.storeStatus === 'disconnected') {
      tone = 'warning';
      parts.push(
        'Store Sync can’t reach this store right now, so its newest sales may be missing.',
      );
    }
    return { store: c, tone, text: parts.join(' ') };
  });
}

function coverageCard(notes, status, onResync) {
  return card(
    {
      title: 'Sales history by store',
      description:
        'Store Sync keeps a copy of every store’s orders: live as they change, and checked every 15 minutes.',
    },
    h(
      'ul',
      { class: 'compact-list coverage-list' },
      notes.map((n) => {
        const c = n.store;
        const b = c.backfill.status;
        const retry =
          c.permission !== 'missing' &&
          (b === 'done' || b === 'failed') &&
          button(b === 'failed' ? 'Try again…' : 'Import again…', {
            size: 'small',
            variant: b === 'failed' ? 'secondary' : 'plain',
            attrs: { 'aria-label': `Import the order history of ${c.name} again…` },
            onClick: () => onResync(c),
          });
        return h(
          'li',
          { class: 'coverage-item' },
          h('span', { class: ['swatch', seriesClass(status, c.storeId)], 'aria-hidden': 'true' }),
          h(
            'div',
            { class: 'coverage-text' },
            h('p', {}, n.text),
            c.lastSyncedAt &&
              h('p', { class: 'muted small' }, 'Last checked ', timeAgo(c.lastSyncedAt)),
          ),
          (n.tone === 'warning' || retry) &&
            h(
              'div',
              { class: 'coverage-actions' },
              n.tone === 'warning' && badge('Needs a look', 'warning', 'alert'),
              retry,
            ),
        );
      }),
    ),
  );
}

function howItWorks(summary, status) {
  const base = summary.baseCurrency;
  const rates = summary.byStore.filter((s) => s.currencyCode && s.currencyCode !== base);
  return h(
    'details',
    { class: 'disclosure report-how' },
    h('summary', {}, 'How these numbers are worked out'),
    h(
      'ul',
      { class: 'plain-list' },
      h(
        'li',
        {},
        'Revenue is what customers paid for products after discounts and refunds, before tax and shipping. Units sold leave out units that were refunded or removed from an order.',
      ),
      h('li', {}, 'Test orders, cancelled orders and gift cards are left out.'),
      h(
        'li',
        {},
        `A sale counts on the day its order was placed, in the ${summary.timezone.replace(/_/g, ' ')} time zone (`,
        h('a', { href: '#/settings' }, 'change it in Settings'),
        ').',
      ),
      rates.length > 0 &&
        h(
          'li',
          {},
          `Other currencies are converted to ${base} with each store’s exchange rate as it is now: `,
          rates.map((s, i) => [
            i > 0 && '; ',
            `1 ${base} = ${num(s.exchangeRate)} ${s.currencyCode} for ${s.name}`,
          ]),
          '. Changing a store’s rate changes past reports too.',
        ),
      h(
        'li',
        {},
        'Margin compares revenue with each product’s cost when the sale came in. Sales of products without a cost are left out of it.',
      ),
      h(
        'li',
        {},
        `Per day and days left use the sales of the last ${plural(status.lookbackDays, 'day')} in every store. Sell-through is the share of the units you had (sold in the period plus in stock now) that sold.`,
      ),
    ),
  );
}

// ---- revenue chart ------------------------------------------------------------------------------

function revenueChartCard(summary, status) {
  const buckets = bucketDays(summary.daily, summary.from, summary.to);
  const holder = h('div', { class: 'chart-holder' });
  let drawnAt = 0;
  const draw = (width) => {
    drawnAt = width;
    replace(holder, revenueChart(buckets, summary, status, width));
  };
  draw(640);
  // Drawn for the room it has, so the text stays readable on phones; redrawn when that changes.
  const observer = new ResizeObserver(() => {
    if (!holder.isConnected) {
      observer.disconnect();
      return;
    }
    const width = Math.max(260, Math.min(1100, Math.floor(holder.clientWidth)));
    if (Math.abs(width - drawnAt) >= 8) draw(width);
  });
  observer.observe(holder);
  const selling = summary.byStore.filter((s) => s.revenueBase > 0);
  return card(
    {
      title: `Revenue by ${buckets.unit}`,
      description: `In ${summary.baseCurrency}, ${dateOnly(summary.from)} to ${dateOnly(summary.to)}.`,
    },
    selling.length > 1 &&
      h(
        'ul',
        { class: 'chart-legend', 'aria-label': 'Colours' },
        selling.map((s) =>
          h(
            'li',
            {},
            h('span', { class: ['swatch', seriesClass(status, s.storeId)], 'aria-hidden': 'true' }),
            s.name,
          ),
        ),
      ),
    holder,
    chartTable(buckets, summary),
  );
}

/** Days grouped into what fits a chart: days up to 3 months, then weeks, then months. */
function bucketDays(daily, from, to) {
  const span = daysBetween(from, to);
  const unit = span <= 93 ? 'day' : span <= 731 ? 'week' : 'month';
  const groups = [];
  for (const d of daily) {
    const key = unit === 'day' ? d.date : unit === 'week' ? weekStart(d.date) : d.date.slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, from: d.date, to: d.date, total: 0, byStore: {} };
      groups.push(g);
    }
    g.to = d.date;
    g.total += d.revenue;
    for (const [id, v] of Object.entries(d.byStore)) g.byStore[id] = (g.byStore[id] ?? 0) + v;
  }
  return { unit, groups };
}

function bucketLabel(g, unit) {
  if (unit === 'day') return dateOnly(g.from);
  if (unit === 'week') return `${dateOnly(g.from)} to ${dateOnly(g.to)}`;
  return monthFormat.format(new Date(`${g.from}T00:00:00Z`));
}

const monthFormat = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const tickDay = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const tickMonth = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
});

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c !== null && c !== undefined && c !== false) el.append(c);
  }
  return el;
}

/** Stacked bars, one colour per store; an image to screen readers (the table says it all). */
function revenueChart({ unit, groups }, summary, status, width) {
  const base = summary.baseCurrency;
  const phone = width < 520;
  const height = phone ? 200 : 260;
  const pad = { top: 10, right: 6, bottom: 26, left: phone ? 50 : 66 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const top = niceCeiling(Math.max(0, ...groups.map((g) => g.total)));
  const slot = plotW / Math.max(1, groups.length);
  const barW = Math.max(1, Math.min(40, slot * 0.72));
  const y = (v) => pad.top + plotH - (top ? (v / top) * plotH : 0);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    svg(
      'g',
      {},
      svg('line', {
        class: f === 0 ? 'chart-axis' : 'chart-grid',
        x1: pad.left,
        x2: width - pad.right,
        y1: y(f * top),
        y2: y(f * top),
      }),
      (top > 0 || f === 0) &&
        svg(
          'text',
          { x: pad.left - 6, y: y(f * top) + 4, 'text-anchor': 'end' },
          moneyShort(f * top, base),
        ),
    ),
  );

  const order = summary.byStore.map((s) => s.storeId);
  const bars = groups.map((g, i) => {
    const x = pad.left + i * slot + (slot - barW) / 2;
    let stacked = 0;
    const parts = order.map((id) => {
      const v = g.byStore[id] ?? 0;
      if (v <= 0) return null;
      const y0 = y(stacked);
      stacked += v;
      return svg('rect', {
        class: seriesClass(status, id),
        x: x.toFixed(1),
        y: y(stacked).toFixed(1),
        width: barW.toFixed(1),
        height: Math.max(0.5, y0 - y(stacked)).toFixed(1),
      });
    });
    // A tooltip for mouse users; screen readers get the table after the chart.
    return svg(
      'g',
      {},
      svg('title', {}, `${bucketLabel(g, unit)}: ${money(g.total, base)}`),
      parts,
    );
  });

  // A few date labels, far enough apart never to overlap.
  const every = Math.max(1, Math.ceil(groups.length / (phone ? 4 : 8)));
  const labels = groups.map(
    (g, i) =>
      i % every === 0 &&
      svg(
        'text',
        { x: pad.left + i * slot + slot / 2, y: height - 8, 'text-anchor': 'middle' },
        (unit === 'month' ? tickMonth : tickDay).format(new Date(`${g.from}T00:00:00Z`)),
      ),
  );

  const best = groups.reduce((a, g) => (!a || g.total > a.total ? g : a), null);
  const label =
    `Revenue by ${unit}, ${dateOnly(summary.from)} to ${dateOnly(summary.to)}: ` +
    `${money(summary.totals.revenue, base)} in all` +
    (best && best.total > 0
      ? `; the highest ${unit} is ${bucketLabel(best, unit)} with ${money(best.total, base)}.`
      : '.') +
    ' Every value is in the table after the chart.';
  return svg(
    'svg',
    {
      class: 'chart',
      role: 'img',
      'aria-label': label,
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
    },
    grid,
    bars,
    labels,
  );
}

/** The chart's numbers, for screen readers. */
function chartTable({ unit, groups }, summary) {
  const base = summary.baseCurrency;
  const stores = summary.byStore.length > 1 ? summary.byStore : [];
  // In a hidden box: a table can't be squeezed to 1px itself, and would widen the page.
  return h(
    'div',
    { class: 'sr-only' },
    h(
      'table',
      {},
      h('caption', {}, `Revenue by ${unit} in ${base}`),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, unit === 'day' ? 'Day' : unit === 'week' ? 'Week' : 'Month'),
          stores.map((s) => h('th', { scope: 'col' }, s.name)),
          h('th', { scope: 'col' }, 'Total'),
        ),
      ),
      h(
        'tbody',
        {},
        groups.map((g) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, bucketLabel(g, unit)),
            stores.map((s) => h('td', {}, money(g.byStore[s.storeId] ?? 0, base))),
            h('td', {}, money(g.total, base)),
          ),
        ),
      ),
    ),
  );
}

// ---- stores -------------------------------------------------------------------------------------

function storesCard(summary, status) {
  const base = summary.baseCurrency;
  const t = summary.totals;
  const converted = summary.byStore.some((s) => s.currencyCode && s.currencyCode !== base);
  // Stores whose orders can't be read show dashes, not zeros that look like no sales.
  const unread = new Set(
    summary.coverage.stores.filter((c) => c.permission === 'missing').map((c) => c.storeId),
  );
  const read = (render) => (s) =>
    unread.has(s.storeId) ? h('span', { class: 'muted unread' }, '—') : render(s);
  const columns = [
    {
      label: 'Store',
      render: (s) =>
        h(
          'div',
          { class: 'product-cell' },
          h(
            'span',
            { class: 'brand-cell' },
            h('span', { class: ['swatch', seriesClass(status, s.storeId)], 'aria-hidden': 'true' }),
            s.name,
          ),
          unread.has(s.storeId) && h('span', { class: 'product-meta' }, 'Orders not read'),
        ),
      total: 'All stores',
    },
    { label: 'Orders', align: 'end', render: read((s) => num(s.orders)), total: num(t.orders) },
    { label: 'Units', align: 'end', render: read((s) => num(s.units)), total: num(t.units) },
    {
      label: converted ? 'Revenue' : `Revenue (${base})`,
      align: 'end',
      render: read((s) => money(s.revenue, s.currencyCode ?? base)),
      total: converted ? null : money(t.revenue, base),
    },
    converted && {
      label: `In ${base}`,
      align: 'end',
      render: read((s) => money(s.revenueBase, base)),
      total: money(t.revenue, base),
    },
    {
      label: 'Share',
      align: 'end',
      render: read((s) => (t.revenue > 0 ? percent(s.revenueBase / t.revenue) : '—')),
      total: t.revenue > 0 ? '100%' : '—',
    },
    {
      label: 'Margin',
      align: 'end',
      render: read((s) => percent(s.margin)),
      total: percent(t.margin),
    },
  ].filter(Boolean);
  return card(
    {
      title: 'By store',
      description: converted
        ? `Each store in its own currency, then in ${base}.`
        : 'How the stores compare.',
    },
    table({ columns, rows: summary.byStore, caption: 'Sales by store', totals: true }),
  );
}

/** A table like ui.js dataTable (same markup, same phone layout), with a totals row and header controls. */
function table({ columns, rows, caption, totals, head }) {
  const cell = (col, i, content) =>
    h(
      i === 0 ? 'th' : 'td',
      {
        role: i === 0 ? 'rowheader' : 'cell',
        scope: i === 0 ? 'row' : null,
        'data-label': col.label,
        class: [col.align && `align-${col.align}`, col.className],
      },
      content,
    );
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table', role: 'table' },
      caption && h('caption', { class: 'sr-only' }, caption),
      h(
        'thead',
        { role: 'rowgroup' },
        h(
          'tr',
          { role: 'row' },
          columns.map((col) =>
            h(
              'th',
              {
                scope: 'col',
                role: 'columnheader',
                class: [col.align && `align-${col.align}`, col.className],
                'aria-sort': head?.ariaSort(col) ?? null,
              },
              head ? head.render(col) : col.label,
            ),
          ),
        ),
      ),
      h(
        'tbody',
        { role: 'rowgroup' },
        rows.map((row) =>
          h(
            'tr',
            { role: 'row' },
            columns.map((col, i) => cell(col, i, col.render(row))),
          ),
        ),
        totals &&
          h(
            'tr',
            { role: 'row', class: 'table-totals' },
            columns.map((col, i) => cell(col, i, col.total)),
          ),
      ),
    ),
  );
}

// ---- products -----------------------------------------------------------------------------------

function productsCard(state, { view, onSearch, onSort }) {
  const search = input({
    type: 'search',
    id: uid('search'),
    value: state.search,
    placeholder: 'Search by SKU or name',
    autocomplete: 'off',
  });
  search.addEventListener('input', () => onSearch(search.value));
  // Phones can't see the header buttons: this sorts there (and anywhere).
  const sortSelect = select(SORT_OPTIONS, { id: uid('sort'), value: `${state.sort}:${state.dir}` });
  sortSelect.addEventListener('change', () => {
    const [value, dir] = sortSelect.value.split(':');
    onSort(value, dir);
  });
  view.sortSelect = sortSelect;
  view.csv = h(
    'a',
    {
      class: ['button', 'button-secondary', 'report-csv'],
      href: '/api/reports/products.csv',
      download: '',
    },
    icon('download'),
    h('span', {}, 'Download CSV'),
  );
  return card(
    {
      title: 'By product',
      description: 'What each product sold in the period, with its stock and pace now.',
    },
    h(
      'div',
      { class: 'toolbar report-toolbar' },
      h(
        'div',
        { class: 'search' },
        h('label', { class: 'sr-only', for: search.id }, 'Search products'),
        icon('search', { className: 'search-icon' }),
        search,
      ),
      h(
        'div',
        { class: 'toolbar-select' },
        h('label', { class: 'field-label', for: sortSelect.id }, 'Sort by'),
        sortSelect,
      ),
      view.csv,
    ),
    view.announcer,
    view.products,
  );
}

function productsTable(list, state, status, { onSort, onPage }) {
  if (list.total === 0) {
    return emptyState({
      title: state.search ? 'No products match your search' : 'No products sold or in stock',
      message: state.search ? 'Check the spelling, or search by SKU.' : null,
      iconName: 'search',
    });
  }
  const base = list.baseCurrency;
  const sortOf = new Map(SORTS.map((s) => [s.label, s]));
  const columns = [
    { label: 'Product', className: 'col-product', render: productCell },
    {
      label: 'Units',
      align: 'end',
      render: (r) => [num(r.units), list.stores.length > 1 && storeUnits(r, list, status)],
    },
    { label: 'Revenue', align: 'end', render: (r) => money(r.revenue, base) },
    { label: 'Margin', align: 'end', render: (r) => percent(r.margin) },
    {
      label: 'Stock',
      align: 'end',
      render: (r) => (r.stock === null ? muted('—', 'Not syncing yet') : num(r.stock)),
    },
    {
      label: 'Per day',
      align: 'end',
      render: (r) => (r.velocity ? num(r.velocity) : '—'),
    },
    { label: 'Days left', align: 'end', render: daysLeftCell },
    { label: 'Sell-through', align: 'end', render: (r) => percent(r.sellThrough) },
  ].filter(Boolean);

  const head = {
    ariaSort: (col) => {
      const s = sortOf.get(col.label);
      if (!s || s.value !== state.sort) return null;
      return state.dir === 'asc' ? 'ascending' : 'descending';
    },
    render: (col) => {
      const s = sortOf.get(col.label);
      if (!s) return col.label;
      const active = s.value === state.sort;
      const next = active ? (state.dir === 'asc' ? 'desc' : 'asc') : s.first;
      return h(
        'button',
        {
          type: 'button',
          class: ['sort-button', active && 'is-active'],
          onclick: () => onSort(s.value, next),
        },
        col.label,
        h(
          'span',
          { class: 'sort-arrow', 'aria-hidden': 'true' },
          active ? (state.dir === 'asc' ? '↑' : '↓') : '↕',
        ),
        srOnly(`: sort ${next === 'asc' ? 'lowest' : 'highest'} first`),
      );
    },
  };

  return [
    table({ columns, rows: list.products, caption: 'Sales by product', head }),
    pagination({
      page: list.page,
      pageSize: list.pageSize,
      total: list.total,
      onPage,
      noun: 'products',
    }),
  ];
}

function productCell(r) {
  if (r.itemId === null) {
    return h(
      'div',
      { class: 'product-cell' },
      h('span', { class: 'strong mono' }, r.sku ?? 'No SKU'),
      h('span', { class: 'product-meta' }, 'Not one of your products'),
    );
  }
  return h(
    'div',
    { class: 'product-cell' },
    h('a', { class: 'product-link', href: `#/items/${r.itemId}` }, r.title || r.sku),
    h('span', { class: 'product-meta' }, h('span', { class: 'mono' }, r.sku)),
  );
}

/** Under the units: how many each store sold, when more than one did. */
function storeUnits(r, list, status) {
  if (r.byStore.length < 2) return null;
  const names = new Map(list.stores.map((s) => [s.storeId, s.name]));
  return h(
    'ul',
    { class: 'store-units' },
    r.byStore.map((s) =>
      h(
        'li',
        { title: names.get(s.storeId) },
        h('span', { class: ['swatch', seriesClass(status, s.storeId)], 'aria-hidden': 'true' }),
        srOnly(`${names.get(s.storeId)}: `),
        num(s.units),
      ),
    ),
  );
}

function daysLeftCell(r) {
  if (r.daysLeft === null) return '—';
  const text = r.stock !== null && r.stock <= 0 ? 'Out of stock' : days(r.daysLeft);
  return r.daysLeft < LOW_DAYS ? h('span', { class: 'text-warning strong' }, text) : text;
}

// ---- helpers ------------------------------------------------------------------------------------

/** A store's colour: its place among all stores, so it stays the same whatever is filtered. */
export function seriesClass(status, storeId) {
  const index = status.stores.findIndex((s) => s.storeId === storeId);
  return `series-${(Math.max(0, index) % 6) + 1}`;
}

function listNames(stores) {
  const names = stores.map((s) => s.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

function parseIds(value) {
  if (!value || !/^\d+(,\d+)*$/.test(value)) return null;
  return new Set(value.split(',').map(Number));
}

/** The dates of the chosen period, "today" being today in the report's time zone. */
export function rangeOf(state, timeZone) {
  if (state.period === 'custom') return { from: state.from, to: state.to };
  const today = todayIn(timeZone);
  const firstOfMonth = `${today.slice(0, 8)}01`;
  switch (state.period) {
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '90d':
      return { from: addDays(today, -89), to: today };
    case 'month':
      return { from: firstOfMonth, to: today };
    case 'lastMonth': {
      const end = addDays(firstOfMonth, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
    default:
      return { from: addDays(today, -29), to: today };
  }
}

export function todayIn(timeZone) {
  try {
    // en-CA writes YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/** The Monday of a date's week. */
function weekStart(date) {
  const back = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -back);
}

/** A round number at or above `value` for the top of the axis (1, 2, 2.5 or 5 × 10ⁿ). */
function niceCeiling(value) {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

const shortFormats = new Map();
/** "$1.2K", "COP 41M": axis labels. */
function moneyShort(amount, currencyCode) {
  let format = shortFormats.get(currencyCode);
  if (!format) {
    try {
      format = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currencyCode,
        notation: 'compact',
        maximumFractionDigits: 1,
      });
    } catch {
      format = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
    }
    shortFormats.set(currencyCode, format);
  }
  return format.format(amount);
}
