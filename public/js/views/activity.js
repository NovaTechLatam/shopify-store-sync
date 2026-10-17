import { api, latestOnly, qs } from '../api.js';
import { h, uid } from '../dom.js';
import { EVENT_KINDS } from '../labels.js';
import { timeline, timelineEntry } from '../timeline.js';
import { button, emptyState, loadInto, muted, pageHeader, select, withBusy } from '../ui.js';

const PAGE_SIZE = 50;

export async function render({ root, query, signal, setTitle }) {
  setTitle('Activity');
  const state = {
    storeId: query.get('storeId') ?? '',
    kind: query.get('kind') ?? '',
    itemId: query.get('itemId') ?? '',
  };
  const storeSelect = select([{ value: '', label: 'All stores' }], { id: uid('store') });
  const kindSelect = select(
    [
      { value: '', label: 'All kinds' },
      ...Object.entries(EVENT_KINDS).map(([value, label]) => ({ value, label })),
    ],
    { id: uid('kind'), value: state.kind },
  );
  const itemFilter = h('div');
  const results = h('div', { class: 'results' });
  root.append(
    pageHeader({
      title: 'Activity',
      subtitle: 'Every stock change we saw or made, newest first.',
    }),
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'toolbar-select' },
        h('label', { class: 'field-label', for: storeSelect.id }, 'Store'),
        storeSelect,
      ),
      h(
        'div',
        { class: 'toolbar-select' },
        h('label', { class: 'field-label', for: kindSelect.id }, 'Kind'),
        kindSelect,
      ),
      itemFilter,
    ),
    results,
  );

  api('/api/stores', { signal })
    .then((stores) => {
      for (const s of stores) storeSelect.append(h('option', { value: String(s.id) }, s.name));
      storeSelect.value = state.storeId;
    })
    .catch(() => {
      // Filtering by store is optional; the log itself reports connection problems.
    });

  const update = latestOnly(signal, async (reqSignal) => {
    history.replaceState(null, '', `#/activity${qs(state)}`);
    renderItemFilter();
    await loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: () => api(`/api/events${qs({ ...state, limit: PAGE_SIZE })}`, { signal: reqSignal }),
      render: (page) => eventLog(page, state, reqSignal),
    });
  });

  function renderItemFilter() {
    itemFilter.replaceChildren();
    if (!state.itemId) return;
    itemFilter.append(
      h(
        'div',
        { class: 'filter-tag' },
        h('span', {}, `One product only`),
        button('Show all products', {
          size: 'small',
          variant: 'plain',
          onClick: () => {
            state.itemId = '';
            update();
          },
        }),
      ),
    );
  }

  storeSelect.addEventListener('change', () => {
    state.storeId = storeSelect.value;
    update();
  });
  kindSelect.addEventListener('change', () => {
    state.kind = kindSelect.value;
    update();
  });
  await update();
}

function eventLog(page, state, signal) {
  if (page.events.length === 0) {
    const filtered = state.storeId || state.kind || state.itemId;
    return emptyState({
      title: filtered ? 'No activity matches these filters' : 'No activity yet',
      message: filtered ? null : 'Stock changes appear here as soon as syncing starts.',
      iconName: 'pulse',
    });
  }
  const list = timeline(page.events, { showItem: true });
  const footer = h('div', { class: 'load-more' });
  let before = page.nextBefore;

  const renderFooter = () => {
    footer.replaceChildren();
    if (before === null) {
      footer.append(muted('That’s everything.'));
      return;
    }
    const more = button('Load more', {
      onClick: () =>
        withBusy(more, async () => {
          const next = await api(`/api/events${qs({ ...state, before, limit: PAGE_SIZE })}`, {
            signal,
            toastErrors: true,
          });
          const entries = next.events.map((e) => timelineEntry(e, { showItem: true }));
          list.append(...entries);
          before = next.nextBefore;
          if (before === null) {
            // The button goes away: keep keyboard focus in the list, on the first new entry.
            renderFooter();
            entries[0]?.focus();
          }
        }).catch(() => {}),
    });
    footer.append(more);
  };
  renderFooter();
  return [list, footer];
}
