// Indirect Cash Flow Statement (Odoo 20 specification).
import { create, search } from '../orm.js';
import { round } from '../money.js';
import { assetMoveKinds } from './assets.js';
import { analyticMoveItems, isLiquidityAccount, isLiquidityJournal, journalItems, profitAndLoss, weighted } from './ledger.js';
import { reportingBookedAmount } from './money.js';
import { reportReviewMode } from './reports.js';
import { taxRepartitionLines } from './taxes.js';

/** Standard Indirect Cash Flow account tags (Odoo 20 ids 4..35, applicability 'accounts'). */
export const INDIRECT_CASH_FLOW_TAGS = [
  'Adjustment - Depreciation and amortization', // 4
  'Adjustment - Provisions', // 5
  'Adjustment - Intangible Assets', // 6
  'Adjustment - PPE Sale', // 7
  'Adjustment - Right of Use Sale', // 8
  'Adjustment - Financial Instruments', // 9
  'Adjustment - Unrealized Forex', // 10
  'Adjustment - Net Financial Result', // 11
  'Working Capital - Trade Receivable', // 12
  'Working Capital - Other Receivable', // 13
  'Working Capital - Trade Payable', // 14
  'Working Capital - Other Payable', // 15
  'Working Capital - Inventory', // 16
  'Working Capital - Deferred Revenue', // 17
  'Operating - Income Tax Paid Received', // 18
  'Operating - Interest Paid', // 19
  'Investment - Intangible Assets Sale', // 20
  'Investment - Intangible Assets Purchase', // 21
  'Investment - PPE Sale', // 22
  'Investment - PPE Purchase', // 23
  'Investment - Right of Use Sale', // 24
  'Investment - Financial Instruments Sale', // 25
  'Investment - Financial Instruments Purchase', // 26
  'Investment - Cash Advances', // 27
  'Investment - Interest Received', // 28
  'Financing - Share Issuance', // 29
  'Financing - Dividends', // 30
  'Financing - Borrowings Long Term', // 31
  'Financing - Borrowings Short Term', // 32
  'Financing - Lease', // 33
  'Financing - Recoverable Advances', // 34
  'not applicable', // 35
];

/** Whether `tag` is the global standard Indirect Cash Flow tag for `name`. */
export const isStandardIndirectTag = (tag, name) => (
  tag.name === name && (!tag.applicability || tag.applicability === 'accounts') && !tag.country_id
);

/** Map each standard Indirect Cash Flow tag name to its IDs (including archived global tags). */
export function indirectTagIdsByName(db) {
  const candidateTags = search(db, 'account.account.tag', { includeArchived: true });
  return new Map(
    INDIRECT_CASH_FLOW_TAGS.map((name) => [
      name,
      candidateTags.filter((tag) => isStandardIndirectTag(tag, name)).map((tag) => tag.id),
    ]),
  );
}

/** Ensure all 32 Indirect Cash Flow account tags exist (applicability 'accounts'), preserving existing records. */
export function ensureIndirectCashFlowTags(db) {
  if (!db?.records) return db;
  const existing = db.records['account.account.tag'] ?? [];
  const missing = INDIRECT_CASH_FLOW_TAGS.filter((name) => !existing.some((tag) => isStandardIndirectTag(tag, name)));
  if (!missing.length) return db;
  const maxId = Math.max(db.seq?.['account.account.tag'] ?? 0, 0, ...existing.map((r) => Number(r?.id) || 0));
  let next = {
    ...db,
    seq: maxId > (db.seq?.['account.account.tag'] ?? 0) ? { ...(db.seq ?? {}), 'account.account.tag': maxId } : (db.seq ?? {}),
    messages: db.messages ?? [],
  };
  for (const name of missing) {
    next = create(next, 'account.account.tag', { name, applicability: 'accounts' }).db;
  }
  return next;
}

const LINE_DEFS = [
  { code: 'CF_OP', name: 'Cash Flows from operating activities', parentCode: '', depth: 0, ancestors: [], hasChildren: true },
  { code: 'CF_OP_EBIT', name: 'Net Profit', parentCode: 'CF_OP', depth: 1, ancestors: ['CF_OP'], hasChildren: false },
  { code: 'CF_OP_ADJ', name: 'Adjustments to reconcile net profit/(loss) to net cash flows:', parentCode: 'CF_OP', depth: 1, ancestors: ['CF_OP'], hasChildren: true },
  { code: 'CF_OP_ADJ_DEP_AND_AMORT', name: 'Depreciation and amortisation', parentCode: 'CF_OP_ADJ', depth: 2, ancestors: ['CF_OP', 'CF_OP_ADJ'], hasChildren: false },
  { code: 'CF_OP_ADJ_PROV', name: 'Provisions', parentCode: 'CF_OP_ADJ', depth: 2, ancestors: ['CF_OP', 'CF_OP_ADJ'], hasChildren: false },
  { code: 'CF_OP_ADJ_SALE_INT_ASS', name: 'Gain (-)/Loss (+) on sale of intangible assets', parentCode: 'CF_OP_ADJ', depth: 2, ancestors: ['CF_OP', 'CF_OP_ADJ'], hasChildren: false },
  { code: 'CF_OP_ADJ_SALE_PPE', name: 'Gain (-)/Loss (+) on sale of property, plant and equipment', parentCode: 'CF_OP_ADJ', depth: 2, ancestors: ['CF_OP', 'CF_OP_ADJ'], hasChildren: false },
  { code: 'CF_OP_ADJ_SALE_ROU', name: 'Gain (-)/Loss (+) on sale of right-of-use assets', parentCode: 'CF_OP_ADJ', depth: 2, ancestors: ['CF_OP', 'CF_OP_ADJ'], hasChildren: false },
  { code: 'CF_OP_ADJ_SALE_FIN_INSTR', name: 'Gain (-)/Loss (+) on sale of financial instruments', parentCode: 'CF_OP_ADJ', depth: 2, ancestors: ['CF_OP', 'CF_OP_ADJ'], hasChildren: false },
  { code: 'CF_OP_ADJ_FOREX', name: 'Unrealized FX Gain (-)/Loss (+)', parentCode: 'CF_OP_ADJ', depth: 2, ancestors: ['CF_OP', 'CF_OP_ADJ'], hasChildren: false },
  { code: 'CF_OP_ADJ_NET_FIN_RESULT', name: 'Net financial result : income (-)/cost (+)', parentCode: 'CF_OP_ADJ', depth: 2, ancestors: ['CF_OP', 'CF_OP_ADJ'], hasChildren: false },
  { code: 'CF_OP_WCAP', name: 'Working capital adjustments', parentCode: 'CF_OP', depth: 1, ancestors: ['CF_OP'], hasChildren: true },
  { code: 'CF_OP_WCAP_TRA_REC', name: 'Trade receivables', parentCode: 'CF_OP_WCAP', depth: 2, ancestors: ['CF_OP', 'CF_OP_WCAP'], hasChildren: false },
  { code: 'CF_OP_WCAP_OTH_REC', name: 'Other receivables', parentCode: 'CF_OP_WCAP', depth: 2, ancestors: ['CF_OP', 'CF_OP_WCAP'], hasChildren: false },
  { code: 'CF_OP_WCAP_TRA_PAY', name: 'Trade payables', parentCode: 'CF_OP_WCAP', depth: 2, ancestors: ['CF_OP', 'CF_OP_WCAP'], hasChildren: false },
  { code: 'CF_OP_WCAP_OTH_PAY', name: 'Other payables', parentCode: 'CF_OP_WCAP', depth: 2, ancestors: ['CF_OP', 'CF_OP_WCAP'], hasChildren: false },
  { code: 'CF_OP_WCAP_INV', name: 'Inventory', parentCode: 'CF_OP_WCAP', depth: 2, ancestors: ['CF_OP', 'CF_OP_WCAP'], hasChildren: false },
  { code: 'CF_OP_WCAP_DEF_REV', name: 'Deferred revenue', parentCode: 'CF_OP_WCAP', depth: 2, ancestors: ['CF_OP', 'CF_OP_WCAP'], hasChildren: false },
  { code: 'CF_OP_INC_TAX', name: 'Income tax paid (-)/received (+)', parentCode: 'CF_OP', depth: 1, ancestors: ['CF_OP'], hasChildren: false },
  { code: 'CF_OP_INT', name: 'Interest paid', parentCode: 'CF_OP', depth: 1, ancestors: ['CF_OP'], hasChildren: false },
  { code: 'CF_INV', name: 'Cash Flows from investing activities', parentCode: '', depth: 0, ancestors: [], hasChildren: true },
  { code: 'CF_INV_INT_ASS', name: 'Intangible assets', parentCode: 'CF_INV', depth: 1, ancestors: ['CF_INV'], hasChildren: true },
  { code: 'CF_INV_INT_ASS_SALE', name: 'Proceeds from sale of intangible assets', parentCode: 'CF_INV_INT_ASS', depth: 2, ancestors: ['CF_INV', 'CF_INV_INT_ASS'], hasChildren: false },
  { code: 'CF_INV_INT_ASS_PURCH', name: 'Purchase of intangible assets', parentCode: 'CF_INV_INT_ASS', depth: 2, ancestors: ['CF_INV', 'CF_INV_INT_ASS'], hasChildren: false },
  { code: 'CF_INV_PPE', name: 'Property plant and equipment', parentCode: 'CF_INV', depth: 1, ancestors: ['CF_INV'], hasChildren: true },
  { code: 'CF_INV_PPE_SALE', name: 'Proceeds from sale of property, plant and equipment', parentCode: 'CF_INV_PPE', depth: 2, ancestors: ['CF_INV', 'CF_INV_PPE'], hasChildren: false },
  { code: 'CF_INV_PPE_PURCH', name: 'Purchase of property, plant and equipment', parentCode: 'CF_INV_PPE', depth: 2, ancestors: ['CF_INV', 'CF_INV_PPE'], hasChildren: false },
  { code: 'CF_INV_ROU', name: 'Proceeds from sale of right-of-use assets', parentCode: 'CF_INV', depth: 1, ancestors: ['CF_INV'], hasChildren: false },
  { code: 'CF_INV_FIN_INSTR', name: 'Financial instruments', parentCode: 'CF_INV', depth: 1, ancestors: ['CF_INV'], hasChildren: true },
  { code: 'CF_INV_FIN_INSTR_SALE', name: 'Proceeds from financial instruments', parentCode: 'CF_INV_FIN_INSTR', depth: 2, ancestors: ['CF_INV', 'CF_INV_FIN_INSTR'], hasChildren: false },
  { code: 'CF_INV_FIN_INSTR_PURCH', name: 'Purchase of financial instruments', parentCode: 'CF_INV_FIN_INSTR', depth: 2, ancestors: ['CF_INV', 'CF_INV_FIN_INSTR'], hasChildren: false },
  { code: 'CF_INV_RECEP_RECOV_CASH_ADV', name: 'Receipt of recoverable cash advances', parentCode: 'CF_INV', depth: 1, ancestors: ['CF_INV'], hasChildren: false },
  { code: 'CF_INV_REPAY_RECOV_CASH_ADV', name: 'Cash advances made to third parties', parentCode: 'CF_INV', depth: 1, ancestors: ['CF_INV'], hasChildren: false },
  { code: 'CF_INV_INT_PAID', name: 'Interest received', parentCode: 'CF_INV', depth: 1, ancestors: ['CF_INV'], hasChildren: false },
  { code: 'CF_FIN', name: 'Cash Flows from financing activities', parentCode: '', depth: 0, ancestors: [], hasChildren: true },
  { code: 'CF_FIN_PROC_SHARE_ISS', name: 'Proceeds from share issuance', parentCode: 'CF_FIN', depth: 1, ancestors: ['CF_FIN'], hasChildren: false },
  { code: 'CF_FIN_INT_DIV_PAID', name: 'Interests/Dividends paid', parentCode: 'CF_FIN', depth: 1, ancestors: ['CF_FIN'], hasChildren: false },
  { code: 'CF_FIN_PROC_BORR', name: 'Proceeds from borrowings', parentCode: 'CF_FIN', depth: 1, ancestors: ['CF_FIN'], hasChildren: false },
  { code: 'CF_FIN_REPAY_BORR', name: 'Repayment of borrowings', parentCode: 'CF_FIN', depth: 1, ancestors: ['CF_FIN'], hasChildren: false },
  { code: 'CF_FIN_LEASE_REPAY', name: 'Repayment of lease', parentCode: 'CF_FIN', depth: 1, ancestors: ['CF_FIN'], hasChildren: false },
  { code: 'CF_FIN_PROC_RECOV_ADV', name: 'Proceeds from recoverable advances', parentCode: 'CF_FIN', depth: 1, ancestors: ['CF_FIN'], hasChildren: false },
  { code: 'CF_FIN_REPAY_RECOV_ADV', name: 'Repayment of recoverable advances', parentCode: 'CF_FIN', depth: 1, ancestors: ['CF_FIN'], hasChildren: false },
  { code: 'CF_NOT_RECON', name: 'Not reconciled yet', parentCode: '', depth: 0, ancestors: [], hasChildren: false },
  { code: 'CF_CASH', name: 'CASH FLOW', parentCode: '', depth: 0, ancestors: [], hasChildren: false, strong: true },
  { code: 'CF_CASH_BOP', name: 'Cash and cash equivalents at beginning', parentCode: '', depth: 0, ancestors: [], hasChildren: false, isTotal: true },
  { code: 'CF_CASH_VAR', name: 'Variation', parentCode: '', depth: 0, ancestors: [], hasChildren: true },
  { code: 'CF_CASH_VAR_CASH', name: 'Variation of Cash', parentCode: 'CF_CASH_VAR', depth: 1, ancestors: ['CF_CASH_VAR'], hasChildren: false },
  { code: 'CF_CASH_VAR_NON_CASH', name: 'Variation of NON Cash', parentCode: 'CF_CASH_VAR', depth: 1, ancestors: ['CF_CASH_VAR'], hasChildren: false },
  { code: 'CF_CASH_EOP', name: 'Cash and cash equivalents at end', parentCode: '', depth: 0, ancestors: [], hasChildren: false, strong: true },
];

export const INDIRECT_FOLDABLE_CODES = LINE_DEFS.filter((line) => line.hasChildren).map((line) => line.code);

/**
 * Compute the Odoo 20 Indirect Cash Flow Statement for a period.
 *
 * Custom-engine lines:
 * - CF_NOT_RECON ("Not reconciled yet"): computed as the unexplained cash movement
 *   `(CF_CASH_EOP - CF_CASH_BOP) - (CF_OP + CF_INV + CF_FIN)`, so that
 *   `CF_CASH = CF_OP + CF_INV + CF_FIN + CF_NOT_RECON` always equals the actual
 *   change in cash and cash equivalents (`CF_CASH_EOP - CF_CASH_BOP`) even when
 *   bank statement movements remain unreconciled on suspense/unclassified accounts.
 * - CF_CASH_VAR_CASH ("Variation of Cash"): `-sum` of period journal items in bank
 *   journals (excluding the journal's bank/default line) whose account is a liquidity
 *   account (`asset_cash` or `liability_credit_card`).
 * - CF_CASH_VAR_NON_CASH ("Variation of NON Cash"): `-sum` of period journal items in
 *   bank journals (excluding the journal's bank/default line) whose account is not a
 *   liquidity account, so `CF_CASH_VAR_CASH + CF_CASH_VAR_NON_CASH === CF_CASH_VAR`.
 */
export function cashFlowIndirect(db, { from, to, company_id, analyticAccountIds, includeUnposted, reviewMode, weight } = {}) {
  const mode = reportReviewMode({ reviewMode, includeUnposted });
  const documentsDb = db.unfilteredDb ?? db;

  const accountsById = new Map((documentsDb.records?.['account.account'] ?? db.records?.['account.account'] ?? []).map((a) => [a.id, a]));
  const journalsById = new Map((documentsDb.records?.['account.journal'] ?? db.records?.['account.journal'] ?? []).map((j) => [j.id, j]));

  // Map reference tag index (4..35) -> matching standard global account.account.tag IDs (including archived).
  const byName = indirectTagIdsByName(documentsDb);
  const tagIdsByRef = new Map(
    INDIRECT_CASH_FLOW_TAGS.map((name, idx) => [idx + 4, new Set(byName.get(name) ?? [])]),
  );
  const hasTag = (account, refNum) => {
    const ids = tagIdsByRef.get(refNum);
    if (!ids?.size || !account?.tag_ids?.length) return false;
    return account.tag_ids.some((tag) => ids.has(typeof tag === 'object' ? tag?.id : tag));
  };

  // Accounts linked to at least one tax via invoice/refund tax repartition lines.
  const taxLinkedAccountIds = new Set();
  for (const tax of search(documentsDb, 'account.tax', { includeArchived: true })) {
    if (company_id && tax.company_id && tax.company_id !== company_id) continue;
    for (const row of [...taxRepartitionLines(tax, 'invoice'), ...taxRepartitionLines(tax, 'refund')]) {
      if (row?.account_id) taxLinkedAccountIds.add(row.account_id);
    }
  }

  const { saleMoveIds, disposalMoveIds, depreciationMoveIds } = assetMoveKinds(documentsDb);

  const periodItems = weighted(
    analyticMoveItems(journalItems(db, { from, to, company_id, reviewMode: mode, includeClosing: false }), analyticAccountIds),
    weight,
  );
  const bopItems = from
    ? weighted(
        analyticMoveItems(
          journalItems(db, { company_id, reviewMode: mode, includeClosing: true }).filter((l) => l.date < from),
          analyticAccountIds,
        ),
        weight,
      )
    : [];
  const eopItems = weighted(
    analyticMoveItems(journalItems(db, { to, company_id, reviewMode: mode, includeClosing: true }), analyticAccountIds),
    weight,
  );

  const itemBalance = (item) => reportingBookedAmount(db, item, (Number(item.debit) || 0) - (Number(item.credit) || 0));
  const sumItems = (items, predicate, sign = 1) => round(
    items.reduce((sum, item) => (predicate(item) ? sum + sign * itemBalance(item) : sum), 0),
  );
  const tagBalance = (refNum, sign = 1) => sumItems(periodItems, (l) => hasTag(accountsById.get(l.account_id), refNum), sign);

  const isBankOrCashJournal = (item) => {
    const type = journalsById.get(item.journal_id)?.type;
    return type === 'bank' || type === 'cash';
  };
  const isNotBankLine = (item) => {
    const journal = journalsById.get(item.journal_id);
    if (!journal) return false;
    return journal.default_account_id != null
      ? item.account_id !== journal.default_account_id
      : !isLiquidityAccount(accountsById.get(item.account_id));
  };
  const isNonAssetDisposalOrDep = (item) => !disposalMoveIds.has(item.move_id) && !depreciationMoveIds.has(item.move_id);

  const CF_OP_EBIT = round(profitAndLoss(db, { from, to, company_id, reviewMode: mode }, { includeClosing: false, analyticAccountIds, weight }).net);
  const CF_OP_ADJ_DEP_AND_AMORT = sumItems(
    periodItems,
    (l) => {
      const acc = accountsById.get(l.account_id);
      return acc?.account_type === 'expense_depreciation' || hasTag(acc, 4);
    },
    1,
  );
  const CF_OP_ADJ_PROV = tagBalance(5, 1);
  const CF_OP_ADJ_SALE_INT_ASS = tagBalance(6, 1);
  const CF_OP_ADJ_SALE_PPE = tagBalance(7, 1);
  const CF_OP_ADJ_SALE_ROU = tagBalance(8, 1);
  const CF_OP_ADJ_SALE_FIN_INSTR = tagBalance(9, 1);
  const CF_OP_ADJ_FOREX = tagBalance(10, 1);
  const CF_OP_ADJ_NET_FIN_RESULT = tagBalance(11, 1);
  const CF_OP_ADJ = round(
    CF_OP_ADJ_DEP_AND_AMORT
    + CF_OP_ADJ_PROV
    + CF_OP_ADJ_SALE_INT_ASS
    + CF_OP_ADJ_SALE_PPE
    + CF_OP_ADJ_SALE_ROU
    + CF_OP_ADJ_SALE_FIN_INSTR
    + CF_OP_ADJ_FOREX
    + CF_OP_ADJ_NET_FIN_RESULT,
  );

  const CF_OP_WCAP_TRA_REC = tagBalance(12, -1);
  const CF_OP_WCAP_OTH_REC = sumItems(
    periodItems,
    (l) => {
      const acc = accountsById.get(l.account_id);
      return hasTag(acc, 13) || (taxLinkedAccountIds.has(l.account_id) && acc?.account_type === 'asset_current');
    },
    -1,
  );
  const CF_OP_WCAP_TRA_PAY = tagBalance(14, -1);
  const CF_OP_WCAP_OTH_PAY = sumItems(
    periodItems,
    (l) => {
      const acc = accountsById.get(l.account_id);
      return hasTag(acc, 15) || (taxLinkedAccountIds.has(l.account_id) && acc?.account_type === 'liability_current');
    },
    -1,
  );
  const CF_OP_WCAP_INV = tagBalance(16, -1);
  const CF_OP_WCAP_DEF_REV = tagBalance(17, -1);
  const CF_OP_WCAP = round(
    CF_OP_WCAP_TRA_REC
    + CF_OP_WCAP_OTH_REC
    + CF_OP_WCAP_TRA_PAY
    + CF_OP_WCAP_OTH_PAY
    + CF_OP_WCAP_INV
    + CF_OP_WCAP_DEF_REV,
  );
  const CF_OP_INC_TAX = tagBalance(18, -1);
  const CF_OP_INT = tagBalance(19, -1);
  const CF_OP = round(CF_OP_EBIT + CF_OP_ADJ + CF_OP_WCAP + CF_OP_INC_TAX + CF_OP_INT);

  const CF_INV_INT_ASS_SALE = sumItems(periodItems, (l) => hasTag(accountsById.get(l.account_id), 20) && saleMoveIds.has(l.move_id), 1);
  const CF_INV_INT_ASS_PURCH = sumItems(periodItems, (l) => hasTag(accountsById.get(l.account_id), 21) && isNonAssetDisposalOrDep(l), -1);
  const CF_INV_INT_ASS = round(CF_INV_INT_ASS_SALE + CF_INV_INT_ASS_PURCH);
  const CF_INV_PPE_SALE = sumItems(periodItems, (l) => hasTag(accountsById.get(l.account_id), 22) && saleMoveIds.has(l.move_id), 1);
  const CF_INV_PPE_PURCH = sumItems(periodItems, (l) => hasTag(accountsById.get(l.account_id), 23) && isNonAssetDisposalOrDep(l), -1);
  const CF_INV_PPE = round(CF_INV_PPE_SALE + CF_INV_PPE_PURCH);
  const CF_INV_ROU = sumItems(periodItems, (l) => hasTag(accountsById.get(l.account_id), 24) && saleMoveIds.has(l.move_id), 1);
  const CF_INV_FIN_INSTR_SALE = sumItems(periodItems, (l) => hasTag(accountsById.get(l.account_id), 25) && saleMoveIds.has(l.move_id), 1);
  const CF_INV_FIN_INSTR_PURCH = sumItems(periodItems, (l) => hasTag(accountsById.get(l.account_id), 26) && isNonAssetDisposalOrDep(l), -1);
  const CF_INV_FIN_INSTR = round(CF_INV_FIN_INSTR_SALE + CF_INV_FIN_INSTR_PURCH);
  const CF_INV_RECEP_RECOV_CASH_ADV = sumItems(
    periodItems,
    (l) => hasTag(accountsById.get(l.account_id), 27) && isBankOrCashJournal(l) && (Number(l.credit) || 0) > 0,
    -1,
  );
  const CF_INV_REPAY_RECOV_CASH_ADV = sumItems(
    periodItems,
    (l) => hasTag(accountsById.get(l.account_id), 27) && isBankOrCashJournal(l) && (Number(l.debit) || 0) > 0,
    -1,
  );
  const CF_INV_INT_PAID = tagBalance(28, -1);
  const CF_INV = round(
    CF_INV_INT_ASS
    + CF_INV_PPE
    + CF_INV_ROU
    + CF_INV_FIN_INSTR
    + CF_INV_RECEP_RECOV_CASH_ADV
    + CF_INV_REPAY_RECOV_CASH_ADV
    + CF_INV_INT_PAID,
  );

  const CF_FIN_PROC_SHARE_ISS = sumItems(
    periodItems,
    (l) => hasTag(accountsById.get(l.account_id), 29) && isBankOrCashJournal(l) && (Number(l.credit) || 0) > 0,
    -1,
  );
  const CF_FIN_INT_DIV_PAID = sumItems(
    periodItems,
    (l) => hasTag(accountsById.get(l.account_id), 30) && isBankOrCashJournal(l) && (Number(l.debit) || 0) > 0,
    -1,
  );
  const CF_FIN_PROC_BORR = sumItems(
    periodItems,
    (l) => {
      const acc = accountsById.get(l.account_id);
      return (hasTag(acc, 31) || hasTag(acc, 32)) && (Number(l.credit) || 0) > 0;
    },
    -1,
  );
  const CF_FIN_REPAY_BORR = sumItems(
    periodItems,
    (l) => hasTag(accountsById.get(l.account_id), 32) && (Number(l.debit) || 0) > 0,
    -1,
  );
  const CF_FIN_LEASE_REPAY = sumItems(
    periodItems,
    (l) => hasTag(accountsById.get(l.account_id), 33) && (Number(l.debit) || 0) > 0,
    -1,
  );
  const CF_FIN_PROC_RECOV_ADV = sumItems(
    periodItems,
    (l) => hasTag(accountsById.get(l.account_id), 34) && (Number(l.credit) || 0) > 0,
    -1,
  );
  const CF_FIN_REPAY_RECOV_ADV = sumItems(
    periodItems,
    (l) => hasTag(accountsById.get(l.account_id), 34) && (Number(l.debit) || 0) > 0,
    -1,
  );
  const CF_FIN = round(
    CF_FIN_PROC_SHARE_ISS
    + CF_FIN_INT_DIV_PAID
    + CF_FIN_PROC_BORR
    + CF_FIN_REPAY_BORR
    + CF_FIN_LEASE_REPAY
    + CF_FIN_PROC_RECOV_ADV
    + CF_FIN_REPAY_RECOV_ADV,
  );

  const CF_CASH_BOP = sumItems(bopItems, (l) => isLiquidityJournal(journalsById.get(l.journal_id)) && isNotBankLine(l), -1);
  const CF_CASH_EOP = sumItems(eopItems, (l) => isLiquidityJournal(journalsById.get(l.journal_id)) && isNotBankLine(l), -1);
  const CF_CASH_VAR_CASH = sumItems(
    periodItems,
    (l) => journalsById.get(l.journal_id)?.type === 'bank' && isNotBankLine(l) && isLiquidityAccount(accountsById.get(l.account_id)),
    -1,
  );
  const CF_CASH_VAR_NON_CASH = sumItems(
    periodItems,
    (l) => journalsById.get(l.journal_id)?.type === 'bank' && isNotBankLine(l) && !isLiquidityAccount(accountsById.get(l.account_id)),
    -1,
  );
  const CF_CASH_VAR = round(CF_CASH_VAR_CASH + CF_CASH_VAR_NON_CASH);

  // Unexplained cash movement (e.g. unreconciled bank statement lines booked to suspense) so CASH FLOW === EOP - BOP.
  const CF_NOT_RECON = round((CF_CASH_EOP - CF_CASH_BOP) - (CF_OP + CF_INV + CF_FIN));
  const CF_CASH = round(CF_OP + CF_INV + CF_FIN + CF_NOT_RECON);

  const byCode = {
    CF_OP,
    CF_OP_EBIT,
    CF_OP_ADJ,
    CF_OP_ADJ_DEP_AND_AMORT,
    CF_OP_ADJ_PROV,
    CF_OP_ADJ_SALE_INT_ASS,
    CF_OP_ADJ_SALE_PPE,
    CF_OP_ADJ_SALE_ROU,
    CF_OP_ADJ_SALE_FIN_INSTR,
    CF_OP_ADJ_FOREX,
    CF_OP_ADJ_NET_FIN_RESULT,
    CF_OP_WCAP,
    CF_OP_WCAP_TRA_REC,
    CF_OP_WCAP_OTH_REC,
    CF_OP_WCAP_TRA_PAY,
    CF_OP_WCAP_OTH_PAY,
    CF_OP_WCAP_INV,
    CF_OP_WCAP_DEF_REV,
    CF_OP_INC_TAX,
    CF_OP_INT,
    CF_INV,
    CF_INV_INT_ASS,
    CF_INV_INT_ASS_SALE,
    CF_INV_INT_ASS_PURCH,
    CF_INV_PPE,
    CF_INV_PPE_SALE,
    CF_INV_PPE_PURCH,
    CF_INV_ROU,
    CF_INV_FIN_INSTR,
    CF_INV_FIN_INSTR_SALE,
    CF_INV_FIN_INSTR_PURCH,
    CF_INV_RECEP_RECOV_CASH_ADV,
    CF_INV_REPAY_RECOV_CASH_ADV,
    CF_INV_INT_PAID,
    CF_FIN,
    CF_FIN_PROC_SHARE_ISS,
    CF_FIN_INT_DIV_PAID,
    CF_FIN_PROC_BORR,
    CF_FIN_REPAY_BORR,
    CF_FIN_LEASE_REPAY,
    CF_FIN_PROC_RECOV_ADV,
    CF_FIN_REPAY_RECOV_ADV,
    CF_NOT_RECON,
    CF_CASH,
    CF_CASH_BOP,
    CF_CASH_VAR,
    CF_CASH_VAR_CASH,
    CF_CASH_VAR_NON_CASH,
    CF_CASH_EOP,
  };

  const lines = LINE_DEFS.map((def) => ({ ...def, amount: byCode[def.code] }));
  return { lines, byCode };
}
