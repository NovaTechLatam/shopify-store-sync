import { emptyState, pageHeader } from '../ui.js';

/** #/purchasing: purchase orders, reorder suggestions and suppliers. */
export async function render({ root, setTitle }) {
  setTitle('Purchasing');
  root.append(
    pageHeader({
      title: 'Purchasing',
      subtitle: 'Order stock from your suppliers and receive it into the shared stock.',
    }),
    emptyState({ title: 'Coming soon', message: 'This page isn’t ready yet.', iconName: 'truck' }),
  );
}
