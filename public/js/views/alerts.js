import { api, latestOnly } from '../api.js';
import { h } from '../dom.js';
import { absoluteTime, timeAgo } from '../format.js';
import { alertBadge, alertLink } from '../labels.js';
import { refreshStatus } from '../shell.js';
import { toast } from '../toast.js';
import { button, emptyState, filterBar, loadInto, pageHeader, withBusy } from '../ui.js';

export async function render({ root, query, signal, setTitle }) {
  setTitle('Alerts');
  let status = query.get('status') === 'all' ? 'all' : 'open';
  const results = h('div', { class: 'results' });
  root.append(
    pageHeader({
      title: 'Alerts',
      subtitle:
        'Things that need your attention. They are also sent to Slack or your webhook if you set one up in Settings.',
    }),
    filterBar({
      label: 'Alerts to show',
      value: status,
      options: [
        { value: 'open', label: 'Open' },
        { value: 'all', label: 'All, including resolved' },
      ],
      onChange: (value) => {
        status = value;
        update();
      },
    }),
    results,
  );

  const update = latestOnly(signal, async (reqSignal) => {
    history.replaceState(null, '', status === 'all' ? '#/alerts?status=all' : '#/alerts');
    await loadInto(results, {
      signal: reqSignal,
      keepContent: true,
      load: () => api(`/api/alerts?status=${status}`, { signal: reqSignal }),
      render: (alerts) => alertList(alerts, status, update),
    });
  });
  await update();
}

function alertList(alerts, status, update) {
  if (alerts.length === 0) {
    return emptyState({
      title: status === 'open' ? 'No open alerts' : 'No alerts yet',
      message: status === 'open' ? 'You’re all set.' : null,
      iconName: 'check',
    });
  }
  return h(
    'ul',
    { class: 'alert-list' },
    alerts.map((a) => {
      const resolve =
        !a.resolvedAt &&
        button('Resolve', {
          size: 'small',
          onClick: () =>
            withBusy(resolve, async () => {
              await api(`/api/alerts/${a.id}/resolve`, { method: 'POST' });
              toast('Alert resolved. It comes back if the problem is still there.');
              refreshStatus();
              await update();
            }).catch(() => {}),
        });
      return h(
        'li',
        { class: ['alert-item', a.resolvedAt && 'is-resolved'] },
        h(
          'div',
          { class: 'alert-main' },
          h(
            'div',
            { class: 'alert-head' },
            alertBadge(a.kind),
            a.resolvedAt && h('span', { class: 'badge badge-neutral' }, 'Resolved'),
          ),
          h('p', { class: 'alert-message' }, a.message),
          h(
            'p',
            { class: 'alert-meta' },
            h('span', {}, 'Raised ', timeAgo(a.createdAt)),
            alertLink(a) && h('a', { href: alertLink(a).href }, alertLink(a).label),
            a.itemId && h('a', { href: `#/items/${a.itemId}`, class: 'mono' }, a.sku ?? 'Product'),
            a.storeId && h('a', { href: `#/stores/${a.storeId}` }, a.storeName ?? 'Store'),
            a.notifiedAt
              ? h('span', { title: absoluteTime(a.notifiedAt) }, 'Notification sent')
              : !a.resolvedAt && h('span', {}, 'Not sent yet'),
            a.resolvedAt && h('span', {}, 'Resolved ', timeAgo(a.resolvedAt)),
          ),
        ),
        resolve,
      );
    }),
  );
}
