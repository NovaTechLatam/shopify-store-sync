import { emptyState, pageHeader } from '../ui.js';

/** #/reports: sales across all brands. */
export async function render({ root, setTitle }) {
  setTitle('Reports');
  root.append(
    pageHeader({ title: 'Reports', subtitle: 'Sales across all your brands.' }),
    emptyState({ title: 'Coming soon', message: 'This page isn’t ready yet.', iconName: 'chart' }),
  );
}
