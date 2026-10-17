import { emptyState, pageHeader } from '../ui.js';

/** #/catalog/new and #/catalog/:id: the product editor. */
export async function render({ root, params, setTitle }) {
  const isNew = params[0] === undefined;
  const title = isNew ? 'New product' : 'Product';
  setTitle(title);
  root.append(
    pageHeader({ title, back: { href: '#/catalog', label: 'Catalog' } }),
    emptyState({ title: 'Coming soon', message: 'This page isn’t ready yet.', iconName: 'image' }),
  );
}
