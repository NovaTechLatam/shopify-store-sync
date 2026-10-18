import { api } from '../api.js';
import { h } from '../dom.js';
import { days, money, num, plural } from '../format.js';
import { card, facts, linkButton, muted } from '../ui.js';
import { seriesClass } from '../views/reports.js';

/**
 * Reports: units and revenue by brand for the last 30 days, days of stock left.
 * A section of the product page (views/item.js), shown after the stock cards. Returns a node
 * (e.g. a card), or null to show nothing. It loads on its own: if it throws, only this section
 * shows an error.
 */
export async function section(item, { signal }) {
  // No dates: the last 30 days in the report's time zone, every store.
  const report = await api(`/api/reports/items/${item.id}`, { signal });
  const open = linkButton('Open in reports', `#/reports?search=${encodeURIComponent(item.sku)}`, {
    variant: 'plain',
    size: 'small',
    iconName: 'chart',
  });
  // Sales read before the permission went still show.
  if (report.readingStores === 0 && report.totals.orders === 0) {
    return card(
      { title: 'Sales', actions: open },
      h(
        'p',
        { class: 'muted' },
        'Sales show here once Store Sync may read your stores’ orders. Reports explains how to allow it.',
      ),
    );
  }
  const base = report.baseCurrency;
  const t = report.totals;
  const status = { stores: report.stores };
  const selling = report.stores.filter((s) => s.units > 0);
  return card(
    {
      title: 'Sales in the last 30 days',
      description: 'Every store, after refunds. Test and cancelled orders are left out.',
      actions: open,
    },
    h(
      'div',
      { class: 'sales-section-body' },
      facts(
        [
          ['Units sold', num(t.units)],
          [`Revenue (${base})`, money(t.revenue, base)],
          ['Per day', report.velocity ? num(report.velocity) : '—'],
          ['Days of stock left', daysLeft(report)],
        ],
        { numbers: true },
      ),
      selling.length === 0
        ? h('p', { class: 'muted' }, 'No sales in the last 30 days.')
        : h(
            'ul',
            { class: 'sales-by-store', 'aria-label': 'By store' },
            selling.map((s) =>
              h(
                'li',
                {},
                h(
                  'span',
                  { class: 'sales-store-name' },
                  h('span', {
                    class: ['swatch', seriesClass(status, s.storeId)],
                    'aria-hidden': 'true',
                  }),
                  s.name,
                ),
                h('span', { class: 'num' }, plural(s.units, 'unit')),
                h('span', { class: 'num' }, money(s.revenue, s.currencyCode ?? base)),
              ),
            ),
          ),
    ),
  );
}

function daysLeft(report) {
  if (report.stock === null) return muted('Not syncing yet');
  if (report.daysLeft === null) return report.velocity ? '—' : muted('No recent sales');
  if (report.stock <= 0) return 'Out of stock';
  return days(report.daysLeft);
}
