/**
 * An option's values as the catalog editor shows them: one per line. Values can contain commas
 * ("Red, matte"), so a comma can't separate them; a line break can't be part of a value (the API
 * refuses one), so it can. Pure, so it is tested on its own (test/catalog-option-values.test.ts).
 */

/** The values typed in the box: one per line, trimmed, without empty lines or repeats. */
export function parseOptionValues(text) {
  const seen = new Set();
  const values = [];
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) {
    const value = line.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

/** The box's text for a list of values. */
export function optionValuesText(values) {
  return values.join('\n');
}
