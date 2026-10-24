// RFC 4180-style CSV: quoted fields, doubled quotes, CRLF/LF line breaks.

const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** @param {Array<Array<unknown>>} rows */
export const toCsv = (rows) => rows.map((r) => r.map(quote).join(',')).join('\r\n');

/** @returns {string[][]} */
export function fromCsv(text) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) throw new Error('Empty file');
  return rows;
}
