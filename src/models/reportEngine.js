import { read } from '../orm.js';
import { balances, fiscalYearStart, journalItems, filterByAnalytic, analyticMoveItems, weighted } from './ledger.js';
import { addDays, today } from './common.js';
import { cents, round } from '../money.js';
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
  const seenCodes = new Set();
  const lineExprLabels = new Set();
  const exprsByLine = new Map();
  for (const expr of expressions) {
    const list = exprsByLine.get(expr.report_line_id);
    if (list) list.push(expr);
    else exprsByLine.set(expr.report_line_id, [expr]);
  }
  for (const line of lines) {
    const lineExprs = exprsByLine.get(line.id) ?? [];
    for (const expr of lineExprs) {
      const lineLabelKey = `${line.id}:${expr.label}`;
      if (lineExprLabels.has(lineLabelKey)) return `Duplicate report expression: ${line.code || `line:${line.id}`}.${expr.label}`;
      lineExprLabels.add(lineLabelKey);
    }
    if (!line.code) continue;
    if (seenCodes.has(line.code)) return `Duplicate report line code: ${line.code}`;
    seenCodes.add(line.code);
    for (const expr of lineExprs) {
      keys.set(`${line.code}.${expr.label}`, expr);
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

const aggregationTokenPattern = /[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[()+*/-]/g;

const scaleLinear = (linear, factor) => {
  if (!linear) return null;
  if (factor === 0) return { constVal: 0, terms: new Map() };
  return {
    constVal: linear.constVal * factor,
    terms: new Map([...linear.terms].map(([id, coeff]) => [id, coeff * factor])),
  };
};

const combineLinear = (lhs, rhs, sign) => {
  if (!lhs || !rhs) return null;
  const terms = new Map(lhs.terms);
  for (const [id, coeff] of rhs.terms) {
    const next = (terms.get(id) ?? 0) + sign * coeff;
    if (next === 0) terms.delete(id);
    else terms.set(id, next);
  }
  return { constVal: lhs.constVal + sign * rhs.constVal, terms };
};

/** Reconcile rounded per-account amounts to the rounded expression total via largest rounding residual. */
function reconcileAccountBreakdown(accValues, total) {
  const reconciled = new Map(accValues);
  if (!reconciled.size) return reconciled;
  const entries = [...reconciled].map(([accId, raw]) => {
    const rounded = round(raw);
    return { accId, rawCents: raw * 100, roundedCents: cents(rounded), rounded };
  });
  const diff = cents(total) - entries.reduce((sum, entry) => sum + entry.roundedCents, 0);
  if (!diff) {
    for (const entry of entries) reconciled.set(entry.accId, entry.rounded);
    return reconciled;
  }
  const step = Math.sign(diff);
  const steps = Math.abs(diff);
  const ranked = entries
    .map((entry) => ({ ...entry, priority: step * (entry.rawCents - entry.roundedCents) }))
    .sort((a, b) => (Math.abs(b.priority - a.priority) > 1e-9 ? b.priority - a.priority : a.accId - b.accId));
  for (let i = 0; i < steps; i++) ranked[i % ranked.length].roundedCents += step;
  for (const entry of ranked) reconciled.set(entry.accId, round(entry.roundedCents / 100));
  return reconciled;
}

/** Evaluate an aggregation formula and, when purely linear in its references, its per-account attribution. */
function evaluateAggregation(text, resolveReference, trackLinear) {
  const tokens = String(text ?? '').match(aggregationTokenPattern) ?? [];
  if (tokens.join('') !== String(text ?? '').replace(/\s/g, '')) throw new Error('Invalid aggregation formula');
  let index = 0;
  const atom = () => {
    const token = tokens[index++];
    if (token === '-') {
      const inner = atom();
      return { value: -inner.value, linear: scaleLinear(inner.linear, -1) };
    }
    if (token === '(') {
      const inner = sum();
      if (tokens[index++] !== ')') throw new Error('Invalid aggregation formula');
      return inner;
    }
    if (!token) throw new Error('Invalid aggregation formula');
    if (/^\d/.test(token)) {
      const value = Number(token);
      return { value, linear: trackLinear ? { constVal: value, terms: new Map() } : null };
    }
    if (/^[A-Za-z_]/.test(token)) return resolveReference(token);
    throw new Error('Invalid aggregation formula');
  };
  const product = () => {
    let lhs = atom();
    while (tokens[index] === '*' || tokens[index] === '/') {
      const op = tokens[index++];
      const rhs = atom();
      if (op === '/' && rhs.value === 0) throw new Error('Division by zero');
      let linear = null;
      if (lhs.linear && rhs.linear) {
        if (op === '*') {
          if (lhs.linear.terms.size === 0) linear = scaleLinear(rhs.linear, lhs.linear.constVal);
          else if (rhs.linear.terms.size === 0) linear = scaleLinear(lhs.linear, rhs.linear.constVal);
        } else if (rhs.linear.terms.size === 0 && rhs.linear.constVal !== 0) {
          linear = scaleLinear(lhs.linear, 1 / rhs.linear.constVal);
        }
      }
      lhs = { value: op === '*' ? lhs.value * rhs.value : lhs.value / rhs.value, linear };
    }
    return lhs;
  };
  const sum = () => {
    let lhs = product();
    while (tokens[index] === '+' || tokens[index] === '-') {
      const op = tokens[index++];
      const rhs = product();
      lhs = {
        value: op === '+' ? lhs.value + rhs.value : lhs.value - rhs.value,
        linear: combineLinear(lhs.linear, rhs.linear, op === '+' ? 1 : -1),
      };
    }
    return lhs;
  };
  const result = sum();
  if (index !== tokens.length || !Number.isFinite(result.value)) throw new Error('Invalid aggregation formula');
  return result;
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
  if (!options.skipValidation) {
    const error = validateReportExpressions(lines, expressions);
    if (error) throw new Error(error);
  }
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const exprsByLine = new Map();
  const lookup = new Map();
  for (const expr of expressions) {
    const list = exprsByLine.get(expr.report_line_id);
    if (list) list.push(expr);
    else exprsByLine.set(expr.report_line_id, [expr]);
    const line = lineById.get(expr.report_line_id);
    if (line) lookup.set(`${line.code}.${expr.label}`, expr);
  }
  const breakdownExprIds = new Set();
  if (options.includeAccountBreakdown) {
    const queue = [];
    for (const line of lines) {
      if (!line.foldable) continue;
      for (const expr of exprsByLine.get(line.id) ?? []) queue.push(expr);
    }
    while (queue.length) {
      const expr = queue.pop();
      if (!expr || breakdownExprIds.has(expr.id)) continue;
      breakdownExprIds.add(expr.id);
      if (expr.engine === 'aggregation') {
        for (const ref of aggregationReferences(expr.formula)) queue.push(lookup.get(ref));
      }
    }
  }
  const col = options.column && options.column !== 'balance' ? options.column : 'balance';
  const isNonBalanceCol = col !== 'balance';
  const memo = new Map();
  const accountMemo = new Map();
  const rawAccountMemo = new Map();
  const evaluate = (expr) => {
    if (memo.has(expr.id)) return memo.get(expr.id);
    const needAccounts = breakdownExprIds.has(expr.id);
    let accValues = needAccounts ? new Map() : null;
    let value = 0;
    if (expr.engine === 'aggregation') {
      const text = String(expr.formula);
      const unwrapped = isNonBalanceCol ? /^-\((.*)\)$/.exec(text) : null;
      const exprText = unwrapped ? unwrapped[1] : text;
      const { value: evaluatedValue, linear } = evaluateAggregation(
        exprText,
        (ref) => {
          const refExpr = lookup.get(ref);
          if (!refExpr) throw new Error(`Unknown report expression: ${ref}`);
          const refValue = evaluate(refExpr);
          const refLinear = needAccounts && rawAccountMemo.has(refExpr.id)
            ? { constVal: 0, terms: new Map([[refExpr.id, 1]]) }
            : null;
          return { value: refValue, linear: refLinear };
        },
        needAccounts,
      );
      value = evaluatedValue;
      if (needAccounts) {
        if (!linear || Math.abs(linear.constVal) >= 1e-12) {
          accValues = null;
        } else {
          for (const [refExprId, coeff] of linear.terms) {
            const refMap = rawAccountMemo.get(refExprId);
            if (!refMap) continue;
            for (const [accId, amt] of refMap) {
              accValues.set(accId, (accValues.get(accId) ?? 0) + coeff * amt);
            }
          }
        }
      }
    } else {
      if (!['domain', 'account_codes'].includes(expr.engine)) throw new Error(`Unsupported report engine: ${expr.engine}`);
      for (const companyId of options.companyIds ?? [report.company_id ?? 1]) {
        const cacheKey = `${expr.id}:${companyId}`;
        let cached = options.itemCache?.get(cacheKey);
        if (!cached) {
          const range = expressionPeriod(db, expr.date_scope, period, companyId);
          let items = journalItems(db, { ...range, company_id: companyId, reviewMode: options.reviewMode ?? 'posted', includeClosing: !report.exclude_closing });
          if (options.analyticAccountIds?.length) items = report.date_scope === 'cumulative'
            ? analyticMoveItems(items, options.analyticAccountIds, db)
            : filterByAnalytic(items, options.analyticAccountIds);
          if (options.weight) items = weighted(items, options.weight);
          if (expr.engine === 'domain') items = items.filter(domainPredicate(db, expr.formula));
          const rows = balances(db, items);
          const predicate = expr.engine === 'account_codes' ? accountCodePredicate(expr.formula) : null;
          const factors = predicate ? new Map(rows.map((row) => [row.account.id, predicate(row.account, row.balance)])) : null;
          const byAccount = new Map();
          for (const row of rows) {
            const factor = factors ? (factors.get(row.account.id) ?? 0) : 1;
            if (!factor) continue;
            byAccount.set(row.account.id, { account: row.account, balance: row.balance * factor, debit: 0, credit: 0 });
          }
          for (const item of items) {
            const factor = factors ? (factors.get(item.account_id) ?? 0) : 1;
            if (!factor) continue;
            let entry = byAccount.get(item.account_id);
            if (!entry) {
              entry = { account: read(db, 'account.account', item.account_id), balance: 0, debit: 0, credit: 0 };
              byAccount.set(item.account_id, entry);
            }
            entry.debit += reportingBookedAmount(db, item, Number(item.debit) || 0) * factor;
            entry.credit += reportingBookedAmount(db, item, Number(item.credit) || 0) * factor;
          }
          const totals = { balance: 0, debit: 0, credit: 0 };
          for (const entry of byAccount.values()) {
            totals.balance += entry.balance;
            totals.debit += entry.debit;
            totals.credit += entry.credit;
          }
          cached = { items, rows, factors, byAccount, totals };
          options.itemCache?.set(cacheKey, cached);
        }
        if (expr.engine === 'domain') {
          if (expr.subformula !== '-sum' && expr.subformula !== 'sum') throw new Error('Unsupported domain subformula');
        } else if (expr.subformula && expr.subformula !== '-sum' && expr.subformula !== 'sum') {
          throw new Error('Unsupported account code subformula');
        }
        const sign = expr.subformula === '-sum' && !isNonBalanceCol ? -1 : 1;
        const total = options.accountId != null
          ? (cached.byAccount.get(options.accountId)?.[col] ?? 0)
          : cached.totals[col];
        value += sign * total;
        if (needAccounts) {
          for (const [accId, entry] of cached.byAccount) {
            if (options.accountId != null && accId !== options.accountId) continue;
            accValues.set(accId, (accValues.get(accId) ?? 0) + sign * entry[col]);
          }
        }
      }
    }
    value = round(value);
    memo.set(expr.id, value);
    if (needAccounts && accValues) {
      rawAccountMemo.set(expr.id, accValues);
      accountMemo.set(expr.id, reconcileAccountBreakdown(accValues, value));
    }
    return value;
  };
  const result = lines
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id)
    .map((line) => {
      const lineExprs = exprsByLine.get(line.id) ?? [];
      const exprValues = Object.fromEntries(lineExprs.map((expr) => [expr.label, evaluate(expr)]));
      if (!options.includeAccountBreakdown) return { ...line, expressions: exprValues };
      const accountExpressions = Object.fromEntries(
        lineExprs.map((expr) => [expr.label, accountMemo.get(expr.id) ?? new Map()]),
      );
      return { ...line, expressions: exprValues, accountExpressions };
    });
  const childrenByParent = new Map();
  for (const line of result) {
    const pid = line.parent_id ?? null;
    const list = childrenByParent.get(pid);
    if (list) list.push(line);
    else childrenByParent.set(pid, [line]);
  }
  const subtreeIsZero = (line, seen = new Set()) => {
    if (seen.has(line.id)) throw new Error('Report line parent cycle');
    const path = new Set(seen).add(line.id);
    return Object.values(line.expressions).every((value) => value === 0) && (childrenByParent.get(line.id) ?? []).every((child) => subtreeIsZero(child, path));
  };
  const hidden = new Set();
  const hideTree = (line) => {
    if (hidden.has(line.id)) return;
    hidden.add(line.id);
    for (const child of childrenByParent.get(line.id) ?? []) hideTree(child);
  };
  if (!options.deferHideIfZero) for (const line of result) if (line.hide_if_zero && subtreeIsZero(line)) hideTree(line);
  return result.filter((line) => !hidden.has(line.id));
}
