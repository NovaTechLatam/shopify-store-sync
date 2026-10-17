/**
 * Catalog: “In catalog: <product> · Edit”, or “Not in the catalog · Import…”.
 * A section of the product page (views/item.js), shown after the stock cards. Returns a node
 * (e.g. a card), or null to show nothing. It loads on its own: if it throws, only this section
 * shows an error.
 */
export async function section(_item, { signal: _signal }) {
  return null;
}
