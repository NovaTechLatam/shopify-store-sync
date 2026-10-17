import { emptyState, pageHeader } from '../ui.js';

/** #/prices: base prices, each brand's price rule, sales and price changes. */
export async function render({ root, setTitle }) {
  setTitle('Prices');
  root.append(
    pageHeader({
      title: 'Prices',
      subtitle: 'Set base prices once; each brand’s prices follow its own rule.',
    }),
    emptyState({ title: 'Coming soon', message: 'This page isn’t ready yet.', iconName: 'tag' }),
  );
}
