import { api, qs } from '../api.js';
import { h } from '../dom.js';
import { money, percent } from '../format.js';
import { card, dataTable, facts, linkButton, muted } from '../ui.js';
import { noTargetText, shortDateTime, sourceBadge, targetText } from '../views/prices-shared.js';

/**
 * Prices: base price, cost, each brand’s price and margin.
 * A section of the product page (views/item.js), shown after the stock cards. Returns a node
 * (e.g. a card), or null to show nothing. It loads on its own: if it throws, only this section
 * shows an error.
 */
export async function section(item, { signal }) {
  const data = await api(`/api/prices/items/${item.id}`, { signal });
  const p = data.item;
  const base = data.baseCurrency;
  const rows = data.stores
    .map((store, i) => ({ store, cell: p.stores[i] }))
    .filter((r) => r.cell.sold || r.cell.override);
  const amount = (value) => (value === null ? muted('Not set') : money(value, base));
  return card(
    {
      title: 'Prices',
      description: 'The base price, and the price each store charges now and will charge.',
      actions: linkButton('Edit prices', `#/prices${qs({ search: p.sku })}`, {
        variant: 'plain',
        size: 'small',
        iconName: 'tag',
      }),
    },
    h(
      'div',
      { class: 'stack' },
      facts([
        ['Base price', amount(p.basePrice)],
        p.baseCompareAtPrice !== null && ['Compare-at price', amount(p.baseCompareAtPrice)],
        ['Cost', amount(p.cost)],
      ]),
      rows.length === 0
        ? h('p', { class: 'muted' }, 'No store sells this product yet.')
        : dataTable({
            caption: 'Prices in each store',
            rows,
            columns: [
              { label: 'Store', render: (r) => r.store.name },
              {
                label: 'Now',
                align: 'end',
                render: (r) =>
                  r.cell.current
                    ? money(r.cell.current.price, r.store.currencyCode)
                    : muted('Not read yet'),
              },
              {
                label: 'Will be',
                align: 'end',
                render: (r) =>
                  h(
                    'div',
                    { class: 'price-cell' },
                    targetText(r.cell, r.store.currencyCode) ?? noTargetText(r.cell),
                    h(
                      'div',
                      { class: 'price-notes' },
                      sourceBadge(r.cell),
                      r.cell.differs &&
                        h('span', { class: 'text-warning' }, 'Changes at the next update'),
                    ),
                  ),
              },
              {
                label: 'Margin',
                align: 'end',
                render: (r) =>
                  r.cell.margin === null
                    ? muted('—')
                    : h(
                        'span',
                        { class: r.cell.margin < 0 ? 'text-critical' : null },
                        percent(r.cell.margin),
                      ),
              },
            ],
          }),
      data.schedules.length > 0 &&
        h(
          'ul',
          { class: 'plain-list small' },
          data.schedules.map((s) =>
            h(
              'li',
              {},
              s.kind === 'sale'
                ? `${s.status === 'active' ? 'On sale now' : 'Sale planned'}: “${s.name}”, ${s.percentOff}% off, ${shortDateTime(s.startsAt)} to ${shortDateTime(s.endsAt)}.`
                : `New base price planned: “${s.name}”, ${shortDateTime(s.startsAt)}.`,
            ),
          ),
        ),
    ),
  );
}
