// RFC 4180-style CSV: quoted fields, doubled quotes, CRLF/LF line breaks.

const quote = (v) => `"${String(v ?? '').replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '').replace(/"/g, '""')}"`;

/** @param {Array<Array<unknown>>} rows */
export const toCsv = (rows) => rows.map((r) => r.map(quote).join(',')).join('\r\n');

/** @returns {string[][]} */
export function fromCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
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

/** Extracts 2D array of string cells from a table element or tree. */
export function tableToRows(table) {
  if (!table) return [];
  const rows = [];
  const collect = (node) => {
    if (!node) return;
    const tag = node.tagName?.toUpperCase();
    if (tag === 'TR') {
      const cells = [];
      const extractText = (cellNode) => {
        let txt = '';
        const walk = (c) => {
          if (!c) return;
          if (c.nodeType === 1 && (c.className === 'caret' || (c.tagName?.toUpperCase() === 'BUTTON' && (c.textContent === '▾' || c.textContent === '▸')))) return;
          if (c.nodeType === 3) txt += c.nodeValue;
          else if (c.childNodes && c.childNodes.length) c.childNodes.forEach(walk);
          else if (c.textContent) txt += c.textContent;
        };
        walk(cellNode);
        return txt.trim();
      };
      const findCells = (trChild) => {
        if (!trChild) return;
        const ctag = trChild.tagName?.toUpperCase();
        if (ctag === 'TH' || ctag === 'TD') {
          cells.push(extractText(trChild));
          return;
        }
        for (const child of trChild.childNodes ?? []) findCells(child);
      };
      for (const child of node.childNodes ?? []) findCells(child);
      if (cells.length > 0) rows.push(cells);
      return;
    }
    for (const child of node.childNodes ?? []) collect(child);
  };
  collect(table);
  return rows;
}

/** Downloads RFC 4180 CSV via a dynamic link in browser, returns CSV text. */
export function downloadCsv(filename, rows) {
  const text = typeof rows === 'string' ? rows : toCsv(rows);
  if (typeof document !== 'undefined') {
    const a = document.createElement('a');
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
      a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }));
      a.download = filename;
      a.click?.();
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(a.href);
    } else {
      a.download = filename;
      a.click?.();
    }
  }
  return text;
}
