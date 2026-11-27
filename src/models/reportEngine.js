import { read } from '../orm.js';
import { balances, fiscalYearStart, journalItems, filterByAnalytic, analyticMoveItems, weighted } from './ledger.js';
import { addDays, today } from './common.js';
import { round } from '../money.js';
import { reportingBookedAmount } from './money.js';

export const REPORT_ENGINES = ['domain', 'tax_tags', 'aggregation', 'account_codes', 'external', 'custom'];
export const REPORT_DATE_SCOPES = ['from_beginning', 'from_fiscalyear', 'to_beginning_of_fiscalyear', 'to_beginning_of_period', 'strict_range', 'previous_return_period'];

/** Resolve an expression's period for one company, using the ledger's fiscal-year boundary. */
export function expressionPeriod(db, scope, period, companyId) {
  const to = period?.to || today();
  const from = period?.from || '';
  switch (scope) {
    case 'from_beginning': return { from: '', to };
    case 'from_fiscalyear': return { from: fiscalYearStart(db, to, companyId), to };
    case 'to_beginning_of_fiscalyear': return { from: '', to: addDays(fiscalYearStart(db, to, companyId), -1) };
    case 'to_beginning_of_period':
      if (!from) throw new Error('A period start is required');
      return { from: '', to: addDays(from, -1) };
    case 'strict_range': return { from, to };
    case 'previous_return_period':
      if (!period?.previous_return_period?.from || !period?.previous_return_period?.to) throw new Error('Previous return period is required');
      return { ...period.previous_return_period };
    default: throw new Error(`Unknown report date scope: ${scope}`);
  }
}

const referencePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
export function aggregationReferences(formula) {
  return [...String(formula ?? '').matchAll(referencePattern)].map((match) => `${match[1]}.${match[2]}`);
}

/** Validate references and cycles against the complete report, including a pending record change. */
export function validateReportExpressions(lines, expressions) {
  const keys = new Map();
  for (const line of lines) {
    if (!line.code) continue;
    if (lines.some((other) => other.id !== line.id && other.code === line.code)) return `Duplicate report line code: ${line.code}`;
    for (const expr of expressions.filter((item) => item.report_line_id === line.id)) {
      const key = `${line.code}.${expr.label}`;
      if (keys.has(key)) return `Duplicate report expression: ${key}`;
      keys.set(key, expr);
    }
  }
  for (const expr of expressions) {
    if (!REPORT_ENGINES.includes(expr.engine)) return `Unknown report engine: ${expr.engine}`;
    if (!REPORT_DATE_SCOPES.includes(expr.date_scope)) return `Unknown report date scope: ${expr.date_scope}`;
    if (!String(expr.label ?? '').trim() || !String(expr.formula ?? '').trim()) return 'Expression label and formula are required';
    if (expr.engine === 'aggregation') {
      const refs = aggregationReferences(expr.formula);
      const remainder = String(expr.formula).replace(referencePattern, '1');
      if (!refs.length || !/^[-\d.\s+*/()]+$/.test(remainder)) return 'Invalid aggregation formula';
      for (const ref of refs) if (!keys.has(ref)) return `Unknown report expression: ${ref}`;
    }
  }
  const done = new Set();
  const visit = (key, path) => {
    if (path.has(key)) return `Report expression cycle involving ${key}`;
    if (done.has(key)) return null;
    const expr = keys.get(key);
    const nextPath = new Set(path).add(key);
    for (const ref of expr.engine === 'aggregation' ? aggregationReferences(expr.formula) : []) {
      const err = visit(ref, nextPath);
      if (err) return err;
    }
    done.add(key);
    return null;
  };
  for (const key of keys.keys()) {
    const err = visit(key, new Set());
    if (err) return err;
  }
  return null;
}

function arithmetic(text) {
  const tokens = text.match(/\d+(?:\.\d+)?|[()+*/-]/g) ?? [];
  if (tokens.join('') !== text.replace(/\s/g, '')) throw new Error('Invalid aggregation formula');
  let index = 0;
  const atom = () => {
    const token = tokens[index++];
    if (token === '-') return -atom();
    if (token === '(') { const value = sum(); if (tokens[index++] !== ')') throw new Error('Invalid aggregation formula'); return value; }
    if (!token || !/^\d/.test(token)) throw new Error('Invalid aggregation formula');
    return Number(token);
  };
  const product = () => { let value = atom(); while (tokens[index] === '*' || tokens[index] === '/') { const op = tokens[index++]; const rhs = atom(); if (op === '/' && rhs === 0) throw new Error('Division by zero'); value = op === '*' ? value * rhs : value / rhs; } return value; };
  const sum = () => { let value = product(); while (tokens[index] === '+' || tokens[index] === '-') { const op = tokens[index++]; const rhs = product(); value = op === '+' ? value + rhs : value - rhs; } return value; };
  const value = sum();
  if (index !== tokens.length || !Number.isFinite(value)) throw new Error('Invalid aggregation formula');
  return value;
}

export function matchesReportAccount(db, account, selectors) {
  if (!account) return false;
  const matches = (raw) => {
    if (/^tag:/i.test(raw)) return (account.tag_ids ?? []).some((id) => read(db, 'account.account.tag', typeof id === 'object' ? id.id : id)?.name === raw.slice(4).trim());
    if (/^type:/i.test(raw)) return account.account_type === raw.slice(5).trim();
    return String(account.code ?? '').startsWith(raw);
  };
  return selectors.some((selector) => !selector.startsWith('-') && matches(selector)) && !selectors.some((selector) => selector.startsWith('-') && matches(selector.slice(1)));
}

function domainPredicate(db, formula) {
  const domain = JSON.parse(formula);
  if (!Array.isArray(domain)) throw new Error('Report domain must be a list');
  const allowed = new Set(['account_id', 'account_type', 'account_selector', 'date', 'journal_id', 'partner_id', 'company_id', 'debit', 'credit']);
  return (item) => domain.every((term) => {
    if (!Array.isArray(term) || term.length !== 3 || !allowed.has(term[0])) throw new Error('Unsupported report domain');
    const [field, operator, expected] = term;
    if (field === 'account_selector' && operator === '=' && typeof expected === 'string') return matchesReportAccount(db, read(db, 'account.account', item.account_id), expected.split(',').map((part) => part.trim()));
    const value = field === 'account_type' ? read(db, 'account.account', item.account_id)?.account_type : item[field];
    if (operator === '=') return value === expected;
    if (operator === '!=') return value !== expected;
    if (operator === 'in' && Array.isArray(expected)) return expected.includes(value);
    if (operator === 'not in' && Array.isArray(expected)) return !expected.includes(value);
    throw new Error(`Unsupported report domain operator: ${operator}`);
  });
}

function accountCodePredicate(formula) {
  const parts = String(formula).split(/\s*([+-])\s*/);
  if (!parts.length || !parts.every((part, i) => i % 2 ? /^[+-]$/.test(part) : /^\d+[A-Za-z0-9_.]*(?:\(\d+(?:,\d+)*\))?[CD]?$/.test(part))) throw new Error('Invalid account code formula');
  return (account, balance) => {
    let matched = 0;
    for (let i = 0; i < parts.length; i += 2) {
      const match = /^(\d+[A-Za-z0-9_.]*?)(?:\(([^)]+)\))?([CD])?$/.exec(parts[i]);
      const code = String(account?.code ?? '');
      if (code.startsWith(match[1]) && !(match[2] ?? '').split(',').filter(Boolean).some((excluded) => code.startsWith(excluded)) && (!match[3] || (match[3] === 'D' ? balance > 0 : balance < 0))) matched += i && parts[i - 1] === '-' ? -1 : 1;
    }
    return matched;
  };
}

/** Evaluate stored expressions using the canonical journal-item and balance helpers. */
export function evaluateStoredReport(db, report, period, options = {}) {
  const lines = (db.records['account.report.line'] ?? []).filter((line) => line.report_id === report.id);
  const lineIds = new Set(lines.map((line) => line.id));
  const expressions = (db.records['account.report.expression'] ?? []).filter((expr) => lineIds.has(expr.report_line_id));
  const error = validateReportExpressions(lines, expressions);
  if (error) throw new Error(error);
  const lookup = new Map(expressions.map((expr) => [`${lines.find((line) => line.id === expr.report_line_id)?.code}.${expr.label}`, expr]));
  const memo = new Map();
  const evaluate = (expr) => {
    if (memo.has(expr.id)) return memo.get(expr.id);
    let value = 0;
    if (expr.engine === 'aggregation') {
      const text = String(expr.formula);
      const unwrapped = options.column && options.column !== 'balance' ? /^-\((.*)\)$/.exec(text) : null;
      value = arithmetic((unwrapped ? unwrapped[1] : text).replace(referencePattern, (_all, code, label) => `(${evaluate(lookup.get(`${code}.${label}`))})`));
    } else {
      if (!['domain', 'account_codes'].includes(expr.engine)) throw new Error(`Unsupported report engine: ${expr.engine}`);
      for (const companyId of options.companyIds ?? [report.company_id ?? 1]) {
        const cacheKey = `${expr.id}:${companyId}`;
        let cached = options.itemCache?.get(cacheKey);
        if (!cached) {
          const range = expressionPeriod(db, expr.date_scope, period, companyId);
          let items = journalItems(db, { ...range, company_id: companyId, reviewMode: options.reviewMode ?? 'posted', includeClosing: !report.exclude_closing });
          if (options.analyticAccountIds?.length) items = report.date_scope === 'cumulative'
            ? analyticMoveItems(items, options.analyticAccountIds)
            : filterByAnalytic(items, options.analyticAccountIds);
          if (options.weight) items = weighted(items, options.weight);
          if (expr.engine === 'domain') items = items.filter(domainPredicate(db, expr.formula));
          const rows = balances(db, items);
          const predicate = expr.engine === 'account_codes' ? accountCodePredicate(expr.formula) : null;
          const factors = predicate ? new Map(rows.map((row) => [row.account.id, predicate(row.account, row.balance)])) : null;
          cached = { items, rows, factors };
          options.itemCache?.set(cacheKey, cached);
        }
        let { items } = cached;
        if (expr.engine === 'domain') {
          if (options.accountId != null) items = items.filter((item) => item.account_id === options.accountId);
          const total = options.column && options.column !== 'balance'
            ? items.reduce((sum, item) => sum + reportingBookedAmount(db, item, Number(item[options.column]) || 0), 0)
            : balances(db, items).reduce((sum, row) => sum + row.balance, 0);
          if (expr.subformula === '-sum') value += options.column && options.column !== 'balance' ? total : -total;
          else if (expr.subformula === 'sum') value += total;
          else throw new Error('Unsupported domain subformula');
        } else {
          const { rows, factors } = cached;
          const total = options.column && options.column !== 'balance'
            ? items.filter((item) => options.accountId == null || item.account_id === options.accountId).reduce((sum, item) => sum + reportingBookedAmount(db, item, Number(item[options.column]) || 0) * (factors.get(item.account_id) ?? 0), 0)
            : rows.filter((row) => options.accountId == null || row.account.id === options.accountId).reduce((sum, row) => sum + row.balance * factors.get(row.account.id), 0);
          if (expr.subformula === '-sum') value += options.column && options.column !== 'balance' ? total : -total;
          else if (!expr.subformula || expr.subformula === 'sum') value += total;
          else throw new Error('Unsupported account code subformula');
        }
      }
    }
    value = round(value);
    memo.set(expr.id, value);
    return value;
  };
  const result = lines.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id).map((line) => ({ ...line, expressions: Object.fromEntries(expressions.filter((expr) => expr.report_line_id === line.id).map((expr) => [expr.label, evaluate(expr)])) }));
  const children = (parentId) => result.filter((line) => line.parent_id === parentId);
  const subtreeIsZero = (line, seen = new Set()) => {
    if (seen.has(line.id)) throw new Error('Report line parent cycle');
    const path = new Set(seen).add(line.id);
    return Object.values(line.expressions).every((value) => value === 0) && children(line.id).every((child) => subtreeIsZero(child, path));
  };
  const hidden = new Set();
  const hideTree = (line) => {
    if (hidden.has(line.id)) return;
    hidden.add(line.id);
    for (const child of children(line.id)) hideTree(child);
  };
  if (!options.deferHideIfZero) for (const line of result) if (line.hide_if_zero && subtreeIsZero(line)) hideTree(line);
  return result.filter((line) => !hidden.has(line.id));
}
