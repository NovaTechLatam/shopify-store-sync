import * as catalog from './item-sections/catalog.js';
import * as pricing from './item-sections/pricing.js';
import * as purchasing from './item-sections/purchasing.js';
import * as sales from './item-sections/sales.js';

/**
 * Sections the features add to the product page, in this order, after the stock cards. Each is
 * `section(item, { signal })` → a node or null; see item-sections/*.js.
 */
export const ITEM_SECTIONS = [
  { name: 'catalog', section: catalog.section },
  { name: 'pricing', section: pricing.section },
  { name: 'sales', section: sales.section },
  { name: 'purchasing', section: purchasing.section },
];
