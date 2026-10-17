import { emptyState, pageHeader } from '../ui.js';

/** #/purchasing/orders/new and #/purchasing/orders/:id: a purchase order. */
export async function render({ root, params, setTitle }) {
  const isNew = params[0] === undefined;
  const title = isNew ? 'New purchase order' : 'Purchase order';
  setTitle(title);
  root.append(
    pageHeader({ title, back: { href: '#/purchasing', label: 'Purchasing' } }),
    emptyState({ title: 'Coming soon', message: 'This page isn’t ready yet.', iconName: 'truck' }),
  );
}
