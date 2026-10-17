import { emptyState, pageHeader } from '../ui.js';

/** #/catalog: master products and their state in each brand. */
export async function render({ root, setTitle }) {
  setTitle('Catalog');
  root.append(
    pageHeader({
      title: 'Catalog',
      subtitle: 'Write a product once and publish it to every brand.',
    }),
    emptyState({ title: 'Coming soon', message: 'This page isn’t ready yet.', iconName: 'image' }),
  );
}
