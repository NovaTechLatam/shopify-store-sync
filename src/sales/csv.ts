/**
 * CSV for spreadsheets (RFC 4180: comma separated, CRLF line ends, fields with a comma, quote or
 * line break wrapped in double quotes, quotes doubled). Shared by every export (Reports, purchase
 * orders).
 */

/** Cells starting with these are read as formulas by Excel, Sheets and LibreOffice. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell. Text (SKUs, product and store names: anything a person or Shopify typed) that starts
 * like a formula gets a leading apostrophe, so opening the file can never run it. Text with a
 * semicolon is quoted too: Excel in countries whose list separator is ';' splits on it, and
 * "Tee;=HYPERLINK(…)" would become a cell starting with '='. A quoted field stays whole whatever
 * the separator. Numbers are ours and written as numbers (a negative stock stays a number). null
 * is an empty cell.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",;\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A whole file. It starts with a byte order mark: without it Excel reads UTF-8 as another
 * encoding and garbles accents ("Café" in a product name).
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
