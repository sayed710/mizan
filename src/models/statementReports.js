import { create, read } from '../orm.js';

/** Default Odoo 20 Profit and Loss line hierarchy selecting accounts by account_type. */
export const STANDARD_PNL_LINES = [
  { name: 'Revenue', code: 'REV', sequence: 10, parent_code: '', formula: 'OPINC', sign: 1, foldable: true, strong: true },
  { name: 'Operating Income', code: 'OPINC', sequence: 20, parent_code: 'REV', formula: 'type:income', sign: -1, foldable: true, strong: false },
  { name: 'Cost of Revenue', code: 'COR', sequence: 30, parent_code: 'REV', formula: 'type:expense_direct_cost', sign: 1, foldable: true, strong: false },
  { name: 'Gross Profit', code: 'GROSS', sequence: 40, parent_code: '', formula: 'OPINC - COR', sign: 1, foldable: false, strong: true },
  { name: 'Other Income', code: 'INC_GRP', sequence: 50, parent_code: '', formula: 'type:income_other', sign: -1, foldable: true, strong: false },
  { name: 'Expenses', code: 'EXP_GRP', sequence: 60, parent_code: '', formula: 'EXP + DEP + EXO', sign: 1, foldable: true, strong: true },
  { name: 'Expenses', code: 'EXP', sequence: 70, parent_code: 'EXP_GRP', formula: 'type:expense', sign: 1, foldable: true, strong: false },
  { name: 'Depreciation', code: 'DEP', sequence: 80, parent_code: 'EXP_GRP', formula: 'type:expense_depreciation', sign: 1, foldable: true, strong: false },
  { name: 'Other Expenses', code: 'EXO', sequence: 90, parent_code: 'EXP_GRP', formula: 'type:expense_other', sign: 1, foldable: true, strong: false },
  { name: 'Net Profit', code: 'NET', sequence: 100, parent_code: '', formula: 'GROSS + INC_GRP - EXP_GRP', sign: 1, foldable: false, strong: true },
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
  { name: 'Current Year Earnings', code: 'CYE', sequence: 170, parent_code: 'CUR_UNALLOC', formula: 'earnings:current_year', sign: -1, foldable: false, strong: false },
  { name: 'Current Year Allocated Earnings', code: 'CYA', sequence: 180, parent_code: 'CUR_UNALLOC', formula: 'type:equity_unaffected', sign: -1, foldable: true, strong: false },
  { name: 'Previous Years Unallocated Earnings', code: 'PYE', sequence: 190, parent_code: 'UNALLOC', formula: 'earnings:prior_years', sign: -1, foldable: false, strong: false },
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

/** Find a company's configured financial statement report by its explicit kind ('pnl' or 'balance'). */
export function findStatementReport(db, kind, companyId = null) {
  const target = companyId ?? db?.settings?.current_company_id ?? 1;
  const reports = (db?.records?.['account.report'] ?? []).filter(
    (r) => r.kind === kind && (r.company_id ?? 1) === target,
  );
  return reports.find((r) => r.active !== false) ?? reports[0] ?? null;
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
  return next;
}
