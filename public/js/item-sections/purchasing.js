import { api } from '../api.js';
import { formDialog } from '../dialog.js';
import { h, replace, uid } from '../dom.js';
import { dateOnly, days, money, num, plural, timeAgo } from '../format.js';
import {
  leadTimeText,
  orderStatusBadge,
  perDay,
  readWholeNumber,
  wholeNumberInput,
} from '../purchasing-common.js';
import { toast } from '../toast.js';
import { badge, button, card, facts, field, linkButton, muted, select } from '../ui.js';

/**
 * Purchasing: on order, preferred supplier, lead time, suggested reorder.
 * A section of the product page (views/item.js), shown after the stock cards. Returns a node
 * (e.g. a card), or null to show nothing. It loads on its own: if it throws, only this section
 * shows an error.
 */
export async function section(item, { signal }) {
  const holder = h('div', {});
  const load = async () => {
    const data = await api(`/api/purchasing/items/${item.id}`, { signal });
    replace(holder, purchasingCard(data, load));
  };
  await load();
  return holder;
}

function purchasingCard(data, reload) {
  const r = data.reorder;
  const base = data.baseCurrency;
  const preferred = data.suppliers.find((s) => s.preferred);
  const orderQty = r?.suggested || 1;
  const orderHref = `#/purchasing/orders/new${
    data.supplier
      ? `?supplierId=${data.supplier.id}&items=${data.itemId}:${orderQty}`
      : `?items=${data.itemId}:${orderQty}`
  }`;
  return card(
    {
      title: 'Purchasing',
      description: 'What it costs, who you buy it from, and when to order more.',
      actions: [
        button('Reorder settings…', {
          size: 'small',
          onClick: () =>
            settingsDialog(data, reload).catch((err) => toast(err.message, { tone: 'error' })),
        }),
        linkButton('Order more', orderHref, { size: 'small', iconName: 'plus' }),
      ],
    },
    r?.needsReorder &&
      h(
        'p',
        { class: 'po-section-callout' },
        badge('Time to reorder', 'warning', 'alert'),
        ` Order about ${plural(r.suggested, 'unit')}${r.supplier ? ` from ${r.supplier.name}` : ''}: at ${perDay(r.velocity)}, the stock lasts ${
          r.daysLeft !== null && r.daysLeft < 1 ? 'less than a day' : `about ${days(r.daysLeft)}`
        } and a delivery takes ${plural(r.leadTimeDays, 'day')}.`,
      ),
    facts([
      [
        'Cost',
        data.cost === null
          ? muted('Not set yet: it is set when a delivery with a price is received')
          : h(
              'span',
              {},
              money(data.cost, base),
              data.costUpdatedAt &&
                h('span', { class: 'muted' }, ' · updated ', timeAgo(data.costUpdatedAt)),
            ),
      ],
      [
        'Supplier',
        data.supplier
          ? h(
              'span',
              {},
              h(
                'a',
                { href: `#/purchasing?tab=suppliers&supplier=${data.supplier.id}` },
                data.supplier.name,
              ),
              preferred?.unitCost !== null && preferred?.unitCost !== undefined
                ? muted(` · ${money(preferred.unitCost, preferred.currencyCode)} a unit`)
                : null,
            )
          : muted('None chosen'),
      ],
      r && ['Lead time', leadTimeText(r.leadTimeDays, r.leadTimeSource, r.supplier?.name)],
      r && [
        'Sells',
        r.velocity > 0
          ? `${perDay(r.velocity)} (last ${plural(data.defaults.lookbackDays, 'day')})`
          : muted('No sales recorded lately'),
      ],
      r &&
        r.stockKnown &&
        r.velocity > 0 && [
          'Stock lasts',
          r.daysLeft < 1
            ? 'Less than a day'
            : `About ${days(r.daysLeft)}${r.stockoutOn ? ` (until ${dateOnly(r.stockoutOn)})` : ''}`,
        ],
      ['On order', r?.onOrder ? plural(r.onOrder, 'unit') : muted('Nothing')],
      [
        'Suggested order',
        !data.reorderEnabled
          ? muted('Reordering is off for this product')
          : !data.syncEnabled
            ? muted('Paused while the product isn’t syncing')
            : r?.needsReorder
              ? h('strong', {}, plural(r.suggested, 'unit'))
              : muted('Nothing to order now'),
      ],
    ]),
    data.orders.length > 0 &&
      h(
        'div',
        { class: 'po-section-orders' },
        h('h3', { class: 'subheading' }, 'Open purchase orders'),
        h(
          'ul',
          { class: 'compact-list' },
          data.orders.map((o) =>
            h(
              'li',
              { class: 'variant-row' },
              h(
                'div',
                {},
                h('a', { href: `#/purchasing/orders/${o.id}`, class: 'strong' }, o.number),
                h(
                  'p',
                  { class: 'muted small' },
                  `${o.supplierName} · ${num(o.remaining)} of ${num(o.quantityOrdered)} to come`,
                  o.expectedOn ? ` · expected ${dateOnly(o.expectedOn)}` : '',
                ),
              ),
              orderStatusBadge(o.status),
            ),
          ),
        ),
      ),
  );
}

async function settingsDialog(data, reload) {
  const suppliers = await api('/api/purchasing/suppliers');
  const supplier = select(
    [
      { value: '', label: 'No supplier' },
      ...suppliers.map((s) => ({ value: String(s.id), label: s.name })),
    ],
    { value: data.supplier ? String(data.supplier.id) : '', name: 'supplierId' },
  );
  const leadTime = wholeNumberInput({
    name: 'leadTimeDays',
    max: 365,
    value: data.leadTimeDays ?? '',
    placeholder: 'Supplier’s',
  });
  const cover = wholeNumberInput({
    name: 'reorderCoverDays',
    min: 1,
    max: 365,
    value: data.reorderCoverDays ?? '',
    placeholder: String(data.defaults.coverDays),
  });
  const enabled = h('input', {
    type: 'checkbox',
    checked: data.reorderEnabled,
    id: uid('reorder'),
  });
  const saved = await formDialog({
    title: `Reorder settings for ${data.sku}`,
    content: [
      field({
        label: 'Order from',
        control: supplier,
        hint: 'Suggestions and draft orders for this product go to this supplier.',
      }),
      h(
        'div',
        { class: 'po-fields' },
        field({
          label: 'Lead time (days)',
          control: leadTime,
          optional: true,
          hint: `Empty: the supplier’s, or ${plural(data.defaults.leadTimeDays, 'day')}.`,
        }),
        field({
          label: 'Order enough for (days)',
          control: cover,
          optional: true,
          hint: `Empty: ${plural(data.defaults.coverDays, 'day')}, as in Settings.`,
        }),
      ),
      h(
        'label',
        { class: 'checkbox', for: enabled.id },
        enabled,
        h(
          'span',
          {},
          'Suggest reorders for this product',
          h('span', { class: 'field-hint block' }, 'Turn this off for products you no longer buy.'),
        ),
      ),
    ],
    submitLabel: 'Save',
    onSubmit: () =>
      api(`/api/purchasing/items/${data.itemId}`, {
        method: 'PATCH',
        body: {
          supplierId: supplier.value ? Number(supplier.value) : null,
          leadTimeDays: readWholeNumber(leadTime, {
            max: 365,
            message: 'Enter the lead time as a whole number of days (0 to 365), or leave it empty.',
          }),
          reorderCoverDays: readWholeNumber(cover, {
            min: 1,
            max: 365,
            message: 'Enter the days to order for as a whole number (1 to 365), or leave it empty.',
          }),
          reorderEnabled: enabled.checked,
        },
        toastErrors: false,
      }),
  });
  if (saved) {
    toast('Reorder settings saved.');
    await reload();
  }
}
