/**
 * CSV for spreadsheets (RFC 4180: comma separated, CRLF line ends, fields with commas, quotes or
 * line breaks quoted, quotes doubled). Text that starts like a formula (= + - @, tab, CR) gets a
 * leading ' so a spreadsheet shows it instead of running it. Numbers are written as they are.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
