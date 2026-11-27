import { create, read } from '../orm.js';
import { aggregationReferences, validateReportExpressions } from './reportEngine.js';

/** Default Odoo 20 Profit and Loss line hierarchy selecting accounts by account_type. */
export const STANDARD_PNL_LINES = [
  { name: 'Revenue', code: 'REV', sequence: 10, parent_code: '', formula: 'OPINC', sign: 1, foldable: true, strong: true },
  { name: 'Sales', code: 'OPINC', sequence: 20, parent_code: 'REV', formula: 'type:income', sign: -1, foldable: true, strong: false },
  { name: 'Less Costs of Revenue', code: 'COR', sequence: 30, parent_code: '', formula: 'type:expense_direct_cost', sign: 1, foldable: true, strong: false },
  { name: 'Gross Profit', code: 'GROSS', sequence: 40, parent_code: '', formula: 'OPINC - COR', sign: 1, foldable: false, strong: true },
  { name: 'Less Operating Expenses', code: 'EXP_GRP', sequence: 50, parent_code: '', formula: 'EXP + DEP', sign: 1, foldable: true, strong: true },
  { name: 'Expenses', code: 'EXP', sequence: 60, parent_code: 'EXP_GRP', formula: 'type:expense', sign: 1, foldable: true, strong: false },
  { name: 'Depreciation', code: 'DEP', sequence: 70, parent_code: 'EXP_GRP', formula: 'type:expense_depreciation', sign: 1, foldable: true, strong: false },
  { name: 'Operating Income', code: 'OPERATING', sequence: 80, parent_code: '', formula: 'GROSS - EXP_GRP', sign: 1, foldable: false, strong: true },
  { name: 'Plus Other Income', code: 'INC_GRP', sequence: 90, parent_code: '', formula: 'type:income_other', sign: -1, foldable: true, strong: false },
  { name: 'Less Other Expenses', code: 'EXO', sequence: 100, parent_code: '', formula: 'type:expense_other', sign: 1, foldable: true, strong: false },
  { name: 'Net Profit', code: 'NET', sequence: 110, parent_code: '', formula: 'OPERATING + INC_GRP - EXO', sign: 1, foldable: false, strong: true },
];

/** Default Odoo 20 Balance Sheet line hierarchy selecting accounts by account_type and earnings expressions. */
export const STANDARD_BALANCE_LINES = [
  { name: 'ASSETS', code: 'ASSETS', sequence: 10, parent_code: '', formula: 'CUR_ASSETS + FA + NCA', sign: 1, foldable: false, strong: true },
  { name: 'Current Assets', code: 'CUR_ASSETS', sequence: 20, parent_code: 'ASSETS', formula: 'CASH + REC + CA + PREP', sign: 1, foldable: true, strong: false },
  { name: 'Bank and Cash Accounts', code: 'CASH', sequence: 30, parent_code: 'CUR_ASSETS', formula: 'type:asset_cash', sign: 1, foldable: true, strong: false },
  { name: 'Receivables', code: 'REC', sequence: 40, parent_code: 'CUR_ASSETS', formula: 'type:asset_receivable', sign: 1, foldable: true, strong: false },
  { name: 'Current Assets', code: 'CA', sequence: 50, parent_code: 'CUR_ASSETS', formula: 'type:asset_current', sign: 1, foldable: true, strong: false },
  { name: 'Prepayments', code: 'PREP', sequence: 60, parent_code: 'CUR_ASSETS', formula: 'type:asset_prepayments', sign: 1, foldable: true, strong: false },
  { name: 'Plus Fixed Assets', code: 'FA', sequence: 70, parent_code: 'ASSETS', formula: 'type:asset_fixed', sign: 1, foldable: true, strong: false },
  { name: 'Plus Non-current Assets', code: 'NCA', sequence: 80, parent_code: 'ASSETS', formula: 'type:asset_non_current', sign: 1, foldable: true, strong: false },
  { name: 'LIABILITIES', code: 'LIAB', sequence: 90, parent_code: '', formula: 'CUR_LIAB + NCL', sign: 1, foldable: false, strong: true },
  { name: 'Current Liabilities', code: 'CUR_LIAB', sequence: 100, parent_code: 'LIAB', formula: 'CL + PAY + CC', sign: 1, foldable: true, strong: false },
  { name: 'Current Liabilities', code: 'CL', sequence: 110, parent_code: 'CUR_LIAB', formula: 'type:liability_current', sign: -1, foldable: true, strong: false },
  { name: 'Payables', code: 'PAY', sequence: 120, parent_code: 'CUR_LIAB', formula: 'type:liability_payable', sign: -1, foldable: true, strong: false },
  { name: 'Credit Cards', code: 'CC', sequence: 125, parent_code: 'CUR_LIAB', formula: 'type:liability_credit_card', sign: -1, foldable: true, strong: false },
  { name: 'Plus Non-current Liabilities', code: 'NCL', sequence: 130, parent_code: 'LIAB', formula: 'type:liability_non_current', sign: -1, foldable: true, strong: false },
  { name: 'EQUITY', code: 'EQUITY', sequence: 140, parent_code: '', formula: 'UNALLOC + RET', sign: 1, foldable: false, strong: true },
  { name: 'Unallocated Earnings', code: 'UNALLOC', sequence: 150, parent_code: 'EQUITY', formula: 'CUR_UNALLOC + PYE', sign: 1, foldable: false, strong: false },
  { name: 'Current Year Unallocated Earnings', code: 'CUR_UNALLOC', sequence: 160, parent_code: 'UNALLOC', formula: 'CYE + CYA', sign: 1, foldable: false, strong: false },
  { name: 'Current Year Earnings', code: 'CYE', sequence: 170, parent_code: 'CUR_UNALLOC', formula: 'earnings:current_year', sign: -1, foldable: true, strong: false },
  { name: 'Current Year Allocated Earnings', code: 'CYA', sequence: 180, parent_code: 'CUR_UNALLOC', formula: 'type:equity_unaffected', sign: -1, foldable: true, strong: false },
  { name: 'Previous Years Unallocated Earnings', code: 'PYE', sequence: 190, parent_code: 'UNALLOC', formula: 'earnings:prior_years', sign: -1, foldable: true, strong: false },
  { name: 'Retained Earnings', code: 'RET', sequence: 200, parent_code: 'EQUITY', formula: 'type:equity', sign: -1, foldable: true, strong: false },
  { name: 'LIABILITIES + EQUITY', code: 'LIAB_EQUITY', sequence: 210, parent_code: '', formula: 'LIAB + EQUITY', sign: 1, foldable: false, strong: true },
];

/** Canonical seeded configurations for Balance Sheet and Profit and Loss per company. */
export const STATEMENT_REPORT_SPECS = [
  {
    name: 'Balance Sheet',
    kind: 'balance',
    date_scope: 'cumulative',
    exclude_closing: false,
    sequence: 1,
    active: true,
    show_debit: false,
    show_credit: false,
    line_ids: STANDARD_BALANCE_LINES,
  },
  {
    name: 'Profit and Loss',
    kind: 'pnl',
    date_scope: 'range',
    exclude_closing: true,
    sequence: 2,
    active: true,
    show_debit: false,
    show_credit: false,
    line_ids: STANDARD_PNL_LINES,
  },
];

/** Whether an account.report record is a standard financial statement identified by its explicit kind marker. */
export function isStandardStatementReport(report) {
  return Boolean(report && STATEMENT_REPORT_SPECS.some((spec) => spec.kind === report.kind));
}

/** Find a company's active financial statement report by its explicit kind ('pnl' or 'balance'). */
export function findStatementReport(db, kind, companyId = null) {
  const target = companyId ?? db?.settings?.current_company_id ?? 1;
  return (db?.records?.['account.report'] ?? []).find(
    (r) => r.kind === kind && (r.company_id ?? 1) === target && r.active !== false,
  ) ?? null;
}

/**
 * Return an error message when removing `before` (or updating it to `after`) would leave
 * its `(company_id, kind)` without any active standard financial statement report.
 */
export function statementReportGuard(db, before, after = null) {
  if (!isStandardStatementReport(before) || before.active === false) return null;
  const companyId = before.company_id ?? 1;
  if (after && after.kind === before.kind && (after.company_id ?? 1) === companyId && after.active !== false) return null;
  const remaining = (db?.records?.['account.report'] ?? []).filter((r) => r.id !== before.id);
  if (findStatementReport({ ...db, records: { ...db?.records, 'account.report': remaining } }, before.kind, companyId)) {
    return null;
  }
  return 'Each company must keep at least one report for each standard financial statement kind';
}

/** Ensure standard Balance Sheet and Profit and Loss account.report records exist for a company or all companies. */
export function ensureStatementReports(db, companyId = null) {
  const companies = companyId != null
    ? (read(db, 'res.company', companyId) ? [{ id: companyId }] : [])
    : (db?.records?.['res.company'] ?? []);
  let next = db;
  for (const company of companies) {
    for (const spec of STATEMENT_REPORT_SPECS) {
      if (findStatementReport(next, spec.kind, company.id)) continue;
      if (!next.seq) next = { ...next, seq: {} };
      next = create(next, 'account.report', {
        ...spec,
        company_id: company.id,
        line_ids: spec.line_ids.map((line) => ({ ...line })),
      }).db;
    }
  }
  return ensureStoredStatementLines(next, companyId);
}

const EARNINGS_TYPES = ['income', 'income_other', 'expense_direct_cost', 'expense', 'expense_depreciation', 'expense_other'];

/** Convert the existing statement configuration to independently editable report records. */
export function storedExpression(line, report) {
  const formula = String(line.formula ?? '').trim();
  const base = { label: 'balance', green_on_positive: true, blank_if_zero: false, figure_type: 'monetary' };
  const date_scope = (typeof report === 'string' ? report === 'balance' : report.date_scope === 'cumulative') ? 'from_beginning' : 'strict_range';
  if (/^\d+[A-Za-z0-9_.]*$/.test(formula)) return { ...base, engine: 'account_codes', formula, subformula: line.sign === -1 ? '-sum' : 'sum', date_scope };
  if (/^type:[a-z_]+$/.test(formula)) return { ...base, engine: 'domain', formula: JSON.stringify([['account_type', '=', formula.slice(5)]]), subformula: line.sign === -1 ? '-sum' : 'sum', date_scope };
  if (/^type:[a-z_]+(?:\s*,\s*type:[a-z_]+)+$/.test(formula)) return { ...base, engine: 'domain', formula: JSON.stringify([['account_type', 'in', formula.split(',').map((part) => part.trim().slice(5))]]), subformula: line.sign === -1 ? '-sum' : 'sum', date_scope };
  if (/^(?:-?\d|tag:|-?type:)/i.test(formula)) return { ...base, engine: 'domain', formula: JSON.stringify([['account_selector', '=', formula]]), subformula: line.sign === -1 ? '-sum' : 'sum', date_scope };
  if (formula === 'earnings:current_year' || formula === 'earnings:prior_years') return { ...base, engine: 'domain', formula: JSON.stringify([['account_type', 'in', EARNINGS_TYPES]]), subformula: line.sign === -1 ? '-sum' : 'sum', date_scope: formula.endsWith('current_year') ? 'from_fiscalyear' : 'to_beginning_of_fiscalyear' };
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\s*[+-]\s*[A-Za-z_][A-Za-z0-9_]*)*$/.test(formula)) {
    const refs = formula.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (code) => `${code}.balance`);
    return { ...base, engine: 'aggregation', formula: line.sign === -1 ? `-(${refs})` : refs, date_scope };
  }
  return null;
}

/** Add stored lines only for statements whose complete inline configuration can be represented. */
export function ensureStoredStatementLines(db, companyId = null) {
  const existing = db.records['account.report.line'] ?? [];
  const expressions = db.records['account.report.expression'] ?? [];
  let nextLines = existing;
  let nextExpressions = expressions;
  let lineId = Math.max(db.seq?.['account.report.line'] ?? 0, ...existing.map((line) => line.id), 0);
  let expressionId = Math.max(db.seq?.['account.report.expression'] ?? 0, ...expressions.map((expr) => expr.id), 0);
  for (const report of db.records['account.report'] ?? []) {
    if (!isStandardStatementReport(report) || (companyId != null && (report.company_id ?? 1) !== companyId) || nextLines.some((line) => line.report_id === report.id)) continue;
    const inline = report.line_ids ?? [];
    const converted = inline.map((line) => storedExpression(line, report));
    if (!inline.length || converted.some((item) => !item)) continue;
    const ids = new Map(inline.map((line) => [line.code, ++lineId]));
    const createdLines = inline.map((line) => ({ id: ids.get(line.code), report_id: report.id, company_id: report.company_id ?? 1, name: line.name, code: line.code, inline_code: line.code, sequence: line.sequence, parent_id: line.parent_code ? ids.get(line.parent_code) : null, hierarchy_level: 0, foldable: !!line.foldable, hide_if_zero: false, print_on_new_page: false, strong: !!line.strong }));
    const createdExpressions = inline.map((line, index) => ({ id: ++expressionId, report_line_id: ids.get(line.code), company_id: report.company_id ?? 1, ...converted[index] }));
    nextLines = [...nextLines, ...createdLines];
    nextExpressions = [...nextExpressions, ...createdExpressions];
  }
  if (nextLines === existing) return db;
  return { ...db, seq: { ...db.seq, 'account.report.line': lineId, 'account.report.expression': expressionId }, records: { ...db.records, 'account.report.line': nextLines, 'account.report.expression': nextExpressions } };
}

/** Keep legacy edits to embedded standard lines reflected in their stored counterparts. */
export function syncInlineStatementLines(db, before, after) {
  if (!before || (before.line_ids === after.line_ids && before.date_scope === after.date_scope) || !isStandardStatementReport(after)) return db;
  const allLines = db.records['account.report.line'] ?? [];
  const allExpressions = db.records['account.report.expression'] ?? [];
  const oldLines = allLines.filter((line) => line.report_id === after.id);
  if (!oldLines.length) return db;
  const oldInline = new Map((before.line_ids ?? []).map((line) => [line.code, line]));
  const inline = after.line_ids ?? [];
  let lineId = Math.max(db.seq?.['account.report.line'] ?? 0, ...allLines.map((line) => line.id), 0);
  let expressionId = Math.max(db.seq?.['account.report.expression'] ?? 0, ...allExpressions.map((item) => item.id), 0);
  const counterpart = (code) => oldLines.find((item) => (item.inline_code ?? item.code) === code);
  const ids = new Map(inline.map((line) => [line.code, counterpart(line.code)?.id ?? ++lineId]));
  const updated = inline.map((line) => {
    const old = counterpart(line.code);
    const prior = oldInline.get(line.code);
    if (old && JSON.stringify(prior) === JSON.stringify(line)) return old;
    return { ...(old ?? {}), id: ids.get(line.code), report_id: after.id, company_id: after.company_id ?? 1, name: line.name, code: old?.code ?? line.code, inline_code: line.code, sequence: line.sequence, parent_id: line.parent_code ? ids.get(line.parent_code) : null, foldable: !!line.foldable, strong: !!line.strong };
  });
  const removedIds = new Set(oldLines.filter((line) => oldInline.has(line.inline_code ?? line.code) && !ids.has(line.inline_code ?? line.code)).map((line) => line.id));
  const oldById = new Map(oldLines.map((line) => [line.id, line]));
  const survivingParentId = (parentId) => {
    let current = parentId ?? null;
    const seen = new Set();
    while (current != null && removedIds.has(current)) {
      if (seen.has(current)) return null;
      seen.add(current);
      current = oldById.get(current)?.parent_id ?? null;
    }
    return current;
  };
  let nextExpressions = allExpressions.filter((item) => !removedIds.has(item.report_line_id));
  for (const line of inline) {
    const previous = oldInline.get(line.code);
    if (previous && previous.formula === line.formula && previous.sign === line.sign && before.date_scope === after.date_scope) continue;
    const converted = storedExpression(line, after);
    if (!converted) throw new Error('Legacy report line cannot be converted to a stored expression');
    if (converted.engine === 'aggregation') converted.formula = converted.formula.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\.balance\b/g, (match, code) => `${counterpart(code)?.code ?? code}.balance`);
    const id = ids.get(line.code);
    const old = nextExpressions.find((item) => item.report_line_id === id && item.label === 'balance');
    const replacement = { ...old, ...converted, id: old?.id ?? ++expressionId, report_line_id: id, company_id: after.company_id ?? 1 };
    nextExpressions = [...nextExpressions.filter((item) => item !== old), replacement];
  }
  const retained = oldLines
    .filter((line) => !oldInline.has(line.inline_code ?? line.code) && !ids.has(line.inline_code ?? line.code))
    .map((line) => (removedIds.has(line.parent_id) ? { ...line, parent_id: survivingParentId(line.parent_id) } : line));
  const nextReportLines = [...retained, ...updated];
  const nextReportLineById = new Map(nextReportLines.map((line) => [line.id, line]));
  const nextReportExpressions = nextExpressions.filter((item) => nextReportLineById.has(item.report_line_id));
  if (removedIds.size) {
    const removedCodes = new Set(
      oldLines
        .filter((line) => removedIds.has(line.id))
        .flatMap((line) => [line.code, line.inline_code])
        .filter(Boolean),
    );
    const survivingKeys = new Set();
    for (const expr of nextReportExpressions) {
      const code = nextReportLineById.get(expr.report_line_id)?.code;
      if (code) survivingKeys.add(`${code}.${expr.label}`);
    }
    for (const expr of nextReportExpressions) {
      if (expr.engine !== 'aggregation') continue;
      for (const ref of aggregationReferences(expr.formula)) {
        const [refCode] = ref.split('.');
        if (removedCodes.has(refCode) && !survivingKeys.has(ref)) {
          const owner = nextReportLineById.get(expr.report_line_id);
          throw new Error(`Cannot delete report line ${refCode}: still referenced by ${owner?.code || owner?.name || `line:${expr.report_line_id}`}`);
        }
      }
    }
  }
  const validationError = validateReportExpressions(nextReportLines, nextReportExpressions);
  if (validationError) throw new Error(validationError);
  return { ...db, seq: { ...db.seq, 'account.report.line': lineId, 'account.report.expression': expressionId }, records: { ...db.records, 'account.report.line': [...allLines.filter((line) => line.report_id !== after.id), ...nextReportLines], 'account.report.expression': nextExpressions } };
}
