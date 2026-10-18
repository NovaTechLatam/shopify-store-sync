import { api } from '../api.js';
import { h } from '../dom.js';
import { button, card, linkButton, muted } from '../ui.js';
import { importDialog, stateBadge } from '../views/catalog-shared.js';

/**
 * Catalog: “In the catalog as <product> · Edit”, or “Not in the catalog · Import…”.
 * A section of the product page (views/item.js), shown after the stock cards. It loads on its
 * own: if it throws, only this section shows an error.
 */
export async function section(item, { signal }) {
  const data = await api(`/api/catalog/items/${item.id}`, { signal });
  if (data.product) {
    const p = data.product;
    const sold = p.stores.filter((s) => s.enabled);
    return card(
      {
        title: 'Catalog',
        actions: linkButton('Edit', `#/catalog/${p.id}`, { size: 'small', iconName: 'edit' }),
      },
      h(
        'div',
        { class: 'stack' },
        h('p', {}, 'In the catalog as ', h('a', { href: `#/catalog/${p.id}` }, p.title), '.'),
        sold.length
          ? h(
              'ul',
              { class: 'brand-states' },
              sold.map((s) =>
                h('li', {}, h('span', { class: 'brand-name' }, s.storeName), stateBadge(s)),
              ),
            )
          : muted('Not sold in any brand yet.'),
      ),
    );
  }
  const sources = data.importable;
  return card(
    {
      title: 'Catalog',
      actions:
        sources.length > 0 &&
        button('Import…', {
          size: 'small',
          iconName: 'download',
          onClick: async () => {
            const stores = await api('/api/stores');
            await importDialog({ stores, storeId: sources[0].storeId, search: item.sku });
          },
        }),
    },
    h(
      'p',
      {},
      'Not in the catalog. ',
      h(
        'span',
        { class: 'muted' },
        sources.length > 0
          ? `Import it from ${sources.map((s) => s.storeName).join(' or ')} to write its texts and images once for every brand.`
          : 'No store sells it yet.',
      ),
    ),
  );
}
