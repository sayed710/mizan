import { read } from '../orm.js';
import { balances, fiscalYearStart, journalItems, filterByAnalytic, weighted } from './ledger.js';
import { addDays, today } from './common.js';
import { round } from '../money.js';

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

function domainPredicate(db, formula) {
  const domain = JSON.parse(formula);
  if (!Array.isArray(domain)) throw new Error('Report domain must be a list');
  const allowed = new Set(['account_id', 'account_type', 'date', 'journal_id', 'partner_id', 'company_id', 'debit', 'credit']);
  return (item) => domain.every((term) => {
    if (!Array.isArray(term) || term.length !== 3 || !allowed.has(term[0])) throw new Error('Unsupported report domain');
    const [field, operator, expected] = term;
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
      value = arithmetic(String(expr.formula).replace(referencePattern, (_all, code, label) => `(${evaluate(lookup.get(`${code}.${label}`))})`));
    } else {
      if (!['domain', 'account_codes'].includes(expr.engine)) throw new Error(`Unsupported report engine: ${expr.engine}`);
      for (const companyId of options.companyIds ?? [report.company_id ?? 1]) {
        const range = expressionPeriod(db, expr.date_scope, period, companyId);
        let items = journalItems(db, { ...range, company_id: companyId, reviewMode: options.reviewMode ?? 'posted', includeClosing: !report.exclude_closing });
        if (options.analyticAccountIds?.length) items = filterByAnalytic(items, options.analyticAccountIds);
        if (options.weight) items = weighted(items, options.weight);
        if (expr.engine === 'domain') {
          items = items.filter(domainPredicate(db, expr.formula));
          const rows = balances(db, items);
          const total = rows.reduce((sum, row) => sum + row.balance, 0);
          if (expr.subformula === '-sum') value -= total;
          else if (expr.subformula === 'sum') value += total;
          else throw new Error('Unsupported domain subformula');
        } else {
          const predicate = accountCodePredicate(expr.formula);
          value += balances(db, items).reduce((sum, row) => sum + row.balance * predicate(row.account, row.balance), 0);
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
  for (const line of result) if (line.hide_if_zero && subtreeIsZero(line)) hideTree(line);
  return result.filter((line) => !hidden.has(line.id));
}
/** Translate stored line expressions supported by the legacy row renderer into its definition shape. */
export function storedReportDefinitions(db, report) {
  const lines = (db.records['account.report.line'] ?? []).filter((line) => line.report_id === report.id);
  const ids = new Set(lines.map((line) => line.id));
  const expressions = (db.records['account.report.expression'] ?? []).filter((expr) => ids.has(expr.report_line_id));
  const error = validateReportExpressions(lines, expressions);
  if (error) throw new Error(error);
  const result = lines.map((line) => {
    const expression = expressions.find((item) => item.report_line_id === line.id && item.label === 'balance');
    if (!expression) throw new Error(`Report line ${line.code} needs a balance expression`);
    let formula;
    let sign;
    if (expression.engine === 'aggregation') {
      const text = String(expression.formula).trim();
      const inverted = /^-\((.*)\)$/.exec(text);
      const body = inverted ? inverted[1] : text;
      if (!/^[A-Za-z_][A-Za-z0-9_]*\.balance(?:\s*[+-]\s*[A-Za-z_][A-Za-z0-9_]*\.balance)*$/.test(body)) throw new Error('Unsupported stored aggregation for report rendering');
      formula = body.replace(/\.balance\b/g, '');
      sign = inverted ? -1 : 1;
    } else if (expression.engine === 'domain') {
      const domain = JSON.parse(expression.formula);
      if (!Array.isArray(domain) || domain.length !== 1 || !Array.isArray(domain[0]) || domain[0][0] !== 'account_type') throw new Error('Unsupported stored domain for report rendering');
      const [, operator, types] = domain[0];
      const list = operator === '=' ? [types] : operator === 'in' && Array.isArray(types) ? types : null;
      if (!list?.length || list.some((type) => typeof type !== 'string')) throw new Error('Unsupported stored domain for report rendering');
      if (!['sum', '-sum'].includes(expression.subformula)) throw new Error('Unsupported domain subformula');
      sign = expression.subformula === '-sum' ? -1 : 1;
      const earnings = ['income', 'income_other', 'expense_direct_cost', 'expense', 'expense_depreciation', 'expense_other'];
      const isEarnings = list.length === earnings.length && earnings.every((type) => list.includes(type));
      if (isEarnings && expression.date_scope === 'from_fiscalyear') formula = 'earnings:current_year';
      else if (isEarnings && expression.date_scope === 'to_beginning_of_fiscalyear') formula = 'earnings:prior_years';
      else {
        const expected = report.date_scope === 'cumulative' ? 'from_beginning' : 'strict_range';
        if (expression.date_scope !== expected) throw new Error('Unsupported stored date scope for report rendering');
        formula = list.map((type) => `type:${type}`).join(',');
      }
    } else if (expression.engine === 'account_codes') {
      const expected = report.date_scope === 'cumulative' ? 'from_beginning' : 'strict_range';
      if (expression.date_scope !== expected) throw new Error('Unsupported stored date scope for report rendering');
      formula = String(expression.formula).replace(/\s*\+\s*/g, ',').replace(/\s*-\s*/g, ',-');
      sign = expression.subformula === '-sum' ? -1 : 1;
    } else throw new Error(`Unsupported stored engine for report rendering: ${expression.engine}`);
    const parent = lines.find((candidate) => candidate.id === line.parent_id);
    if (line.parent_id && !parent) throw new Error('Unknown report line parent');
    return { ...line, parent_code: parent?.code ?? '', formula, sign, strong: !!line.strong };
  });
  return result;
}
