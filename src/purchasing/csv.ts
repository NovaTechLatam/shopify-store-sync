import { csvCell } from '../sales/csv.js';

/**
 * CSV for spreadsheets, cell by cell like Reports' export (src/sales/csv.ts: formulas
 * neutralised, text with a comma, semicolon, quote or line break quoted). No byte order mark: the
 * purchase order file goes to suppliers' own systems as much as to spreadsheets.
 */
export { csvCell };

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
