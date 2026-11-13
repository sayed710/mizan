// RFC 4180-style CSV: quoted fields, doubled quotes, CRLF/LF line breaks.
import { models } from './models/index.js';
import { create, search } from './orm.js';
import { fieldReadonly } from './field-metadata.js';
import { t } from './i18n.js';

const sanitizeFormula = (s) => {
  const trimmed = s.trimStart();
  if (/^[=+\-@\t\r]/.test(trimmed)) {
    const isNumber = /^[-+]?(?:\d+(?:,\d+)*(?:\.\d+)?|\.\d+)$/.test(trimmed);
    if (!isNumber) return `'${s}`;
  }
  return s;
};

const quote = (v) => {
  const cleaned = String(v ?? '').replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '');
  return `"${(typeof v === 'number' && Number.isFinite(v) ? cleaned : sanitizeFormula(cleaned)).replace(/"/g, '""')}"`;
};

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

/** Import rows whose headers match field labels (or technical names); many2one cells hold explicit record IDs. */
export function importCsvRows(db, model, defaults, rows, listLabels = null) {
  const fields = models[model].fields;
  // A menu's own column labels (what export writes, e.g. Customer / Invoice Date) are accepted next to the model labels.
  const labelsOf = (key) => [fields[key].label, listLabels?.[key]].filter(Boolean).flatMap((label) => [label, t(label)]).map((label) => label.toLowerCase());
  const keyOf = (header) => Object.keys(fields).find((key) => key === header || labelsOf(key).includes(header.trim().toLowerCase()));
  const [header, ...body] = rows;
  const keys = header.map(keyOf);
  let next = db;
  let count = 0;
  for (const row of body.filter((cells) => cells.some((cell) => cell.trim()))) {
    const vals = { ...defaults };
    keys.forEach((key, index) => {
      const field = fields[key];
      if (!key || fieldReadonly(field, vals, next)) return;
      const raw = (row[index] ?? '').trim();
      if (field.type === 'many2one') {
        if (!raw) {
          vals[key] = null;
          return;
        }
        const id = Number(raw);
        if (!Number.isSafeInteger(id) || id <= 0 || !search(next, field.relation).some((record) => record.id === id)) {
          throw new Error(`Enter an existing record ID for ${field.label}`);
        }
        vals[key] = id;
      }
      else if (['monetary', 'float', 'integer', 'priority'].includes(field.type)) vals[key] = raw === '' ? null : Number(raw);
      else if (field.type === 'boolean') vals[key] = /^(1|true|yes|نعم)$/i.test(raw);
      else if (field.type === 'tags') vals[key] = raw ? raw.split(/[;,]/).map((value) => value.trim()).filter(Boolean) : [];
      else if (field.type === 'selection') vals[key] = field.options.find((option) => option[0] === raw || option[1].toLowerCase() === raw.toLowerCase())?.[0] ?? undefined;
      else vals[key] = raw;
    });
    next = create(next, model, vals).db;
    count += 1;
  }
  return { db: next, count };
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
