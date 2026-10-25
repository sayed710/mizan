// Spreadsheets: a small formula engine (cells, ranges, arithmetic, common functions) with ERP data functions.
import { search } from '../orm.js';

const COL = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
export const colName = (i) => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
const parseRef = (ref) => {
  const m = /^([A-Z]{1,3})(\d{1,5})$/.exec(ref);
  return m ? { col: COL(m[1]), row: Number(m[2]) - 1 } : null;
};

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|("(?:[^"]|"")*")|([A-Z]{1,3}\d{1,5}(?::[A-Z]{1,3}\d{1,5})?)|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|<>|[-+*/^(),:<>=&%]))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s+$/.test(src.slice(pos))) break;
      throw new Error(`Unexpected "${src[pos]}"`);
    }
    pos = re.lastIndex;
    if (m[1]) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) tokens.push({ t: 'str', v: m[2].slice(1, -1).replace(/""/g, '"') });
    else if (m[3]) tokens.push({ t: 'ref', v: m[3] });
    else if (m[4]) tokens.push({ t: 'name', v: m[4].toUpperCase() });
    else tokens.push({ t: 'op', v: m[5] });
  }
  return tokens;
}

/** Recursive-descent parser: comparison < concatenation < additive < multiplicative < power < unary < primary. */
function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const eat = (v) => (peek()?.v === v ? tokens[i++] : null);
  const expect = (v) => { if (!eat(v)) throw new Error(`Expected "${v}"`); };
  const binary = (next, ops) => () => {
    let left = next();
    while (peek()?.t === 'op' && ops.includes(peek().v)) left = { op: tokens[i++].v, left, right: next() };
    return left;
  };
  const primary = () => {
    const tok = tokens[i++];
    if (!tok) throw new Error('Unexpected end of formula');
    if (tok.t === 'num' || tok.t === 'str') return { lit: tok.v };
    if (tok.t === 'ref') return tok.v.includes(':') ? { range: tok.v } : { ref: tok.v };
    if (tok.t === 'name') {
      if (tok.v === 'TRUE' || tok.v === 'FALSE') return { lit: tok.v === 'TRUE' };
      expect('(');
      const args = [];
      if (!eat(')')) {
        do args.push(comparison()); while (eat(','));
        expect(')');
      }
      return { fn: tok.v, args };
    }
    if (tok.v === '(') { const e = comparison(); expect(')'); return e; }
    throw new Error(`Unexpected "${tok.v}"`);
  };
  const unary = () => (eat('-') ? { op: 'neg', arg: unary() } : eat('+') ? unary() : primary());
  const power = binary(unary, ['^']);
  const mult = binary(power, ['*', '/']);
  const add = binary(mult, ['+', '-']);
  const concat = binary(add, ['&']);
  const comparison = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);
  const ast = comparison();
  if (i < tokens.length) throw new Error(`Unexpected "${tokens[i].v}"`);
  return ast;
}

const num = (v) => {
  if (typeof v === 'number') return v;
  if (v === '' || v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error('#VALUE!');
  return n;
};
const flat = (args) => args.flat(Infinity);
const numbers = (args) => flat(args).filter((v) => typeof v === 'number');

/** ERP data in formulas: MIZAN.COUNT("model"), MIZAN.SUM("model", "field"), each with an optional "field=value" filter. */
function erp(db, kind, [model, field, filter]) {
  const [fk, fv] = typeof filter === 'string' && filter.includes('=') ? filter.split('=') : [];
  const recs = search(db, String(model)).filter((r) => !fk || String(r[fk.trim()] ?? '') === fv.trim());
  if (kind === 'COUNT') return recs.length;
  const values = recs.map((r) => Number(r[field]) || 0);
  return kind === 'SUM' ? values.reduce((s, v) => s + v, 0) : values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

const FUNCS = {
  SUM: (a) => numbers(a).reduce((s, v) => s + v, 0),
  AVERAGE: (a) => { const n = numbers(a); if (!n.length) throw new Error('#DIV/0!'); return n.reduce((s, v) => s + v, 0) / n.length; },
  MIN: (a) => (numbers(a).length ? Math.min(...numbers(a)) : 0),
  MAX: (a) => (numbers(a).length ? Math.max(...numbers(a)) : 0),
  COUNT: (a) => numbers(a).length,
  COUNTA: (a) => flat(a).filter((v) => v !== '' && v != null).length,
  ROUND: ([v, d = 0]) => { const f = 10 ** num(d); return Math.round(num(v) * f) / f; },
  ABS: ([v]) => Math.abs(num(v)),
  IF: ([c, a = true, b = false]) => (c && c !== 0 ? a : b),
  AND: (a) => flat(a).every(Boolean),
  OR: (a) => flat(a).some(Boolean),
  NOT: ([v]) => !v,
  CONCAT: (a) => flat(a).map((v) => String(v ?? '')).join(''),
  LEN: ([v]) => String(v ?? '').length,
  UPPER: ([v]) => String(v ?? '').toUpperCase(),
  LOWER: ([v]) => String(v ?? '').toLowerCase(),
};

/**
 * Evaluate every cell of a sheet. `cells` maps "A1" to raw input; a value starting with "=" is a formula.
 * Errors show as "#ERROR: message"; circular references as "#CYCLE!".
 * @returns {Record<string, string|number|boolean>}
 */
export function evaluateSheet(cells = {}, db = null) {
  const values = {};
  const visiting = new Set();
  const cellValue = (ref) => {
    if (ref in values) return values[ref];
    const raw = cells[ref];
    if (raw == null || raw === '') return '';
    if (typeof raw !== 'string' || !raw.startsWith('=')) {
      const n = Number(raw);
      return (values[ref] = raw !== '' && !Number.isNaN(n) && typeof raw === 'string' && raw.trim() !== '' ? n : raw);
    }
    if (visiting.has(ref)) throw new Error('#CYCLE!');
    visiting.add(ref);
    try {
      values[ref] = evalNode(parse(tokenize(raw.slice(1))));
    } catch (e) {
      values[ref] = e.message === '#CYCLE!' ? '#CYCLE!' : String(e.message).startsWith('#') ? e.message : `#ERROR: ${e.message}`;
    }
    visiting.delete(ref);
    return values[ref];
  };
  const deref = (ref) => {
    const v = cellValue(ref);
    if (typeof v === 'string' && v.startsWith('#')) throw new Error(v.startsWith('#ERROR') ? '#REF!' : v);
    return v;
  };
  const rangeValues = (range) => {
    const [a, b] = range.split(':').map(parseRef);
    const out = [];
    for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r += 1) {
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c += 1) out.push(deref(`${colName(c)}${r + 1}`));
    }
    return out;
  };
  const evalNode = (n) => {
    if ('lit' in n) return n.lit;
    if (n.ref) return deref(n.ref);
    if (n.range) return rangeValues(n.range);
    if (n.op === 'neg') return -num(evalNode(n.arg));
    if (n.fn) {
      const args = n.args.map(evalNode);
      if (n.fn.startsWith('MIZAN.')) {
        if (!db) throw new Error('ERP data is not available here');
        return erp(db, n.fn.slice(6), args);
      }
      if (!FUNCS[n.fn]) throw new Error(`Unknown function ${n.fn}`);
      return FUNCS[n.fn](args);
    }
    const l = evalNode(n.left);
    const r = evalNode(n.right);
    switch (n.op) {
      case '+': return num(l) + num(r);
      case '-': return num(l) - num(r);
      case '*': return num(l) * num(r);
      case '/': if (num(r) === 0) throw new Error('#DIV/0!'); return num(l) / num(r);
      case '^': return num(l) ** num(r);
      case '&': return `${l ?? ''}${r ?? ''}`;
      case '=': return l === r;
      case '<>': return l !== r;
      case '<': return l < r;
      case '>': return l > r;
      case '<=': return l <= r;
      case '>=': return l >= r;
      default: throw new Error(`Unknown operator ${n.op}`);
    }
  };
  for (const ref of Object.keys(cells)) cellValue(ref);
  return values;
}

export const spreadsheetModels = {
  'spreadsheet.document': {
    label: 'Spreadsheets',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      cells: { type: 'text', label: 'Cells (JSON)', hidden: true },
      rows: { type: 'integer', label: 'Rows' },
      cols: { type: 'integer', label: 'Columns' },
      folder: { type: 'char', label: 'Folder' },
    },
    defaults: () => ({ cells: '{}', rows: 30, cols: 10 }),
    kanban: { title: 'name', lines: ['folder'] },
    list: ['name', 'folder'],
    form: {
      title: 'name',
      buttons: [{ label: 'Open Spreadsheet', primary: true, run: (db, r) => ({ db, go: `#/spreadsheet/sheet?id=${r.id}` }) }],
      groups: [['folder'], ['rows', 'cols']],
    },
  },
};
