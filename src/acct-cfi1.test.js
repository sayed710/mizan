import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { applyDiff, diffDb } from './sync.js';
import { cleanRecord } from './validate.js';
import { accountId, balanceSheet, journalId, postEntry } from './models/ledger.js';
import { addDays, today } from './models/common.js';
import { payMove, postMove } from './models/accounting.js';
import { confirmAsset, disposeAsset, postDepreciation } from './models/assets.js';
import { bookBankMovement } from './models/bank.js';
import { taxSnapshot } from './models/taxes.js';
import { cashFlowIndirect, INDIRECT_CASH_FLOW_TAGS } from './models/cashFlowIndirect.js';
import { accountCashFlowActivity, cashFlow } from './models/reports.js';
import { setupDom, find } from './test-support/dom.js';
import { tableToRows } from './csv.js';

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => node?.textContent ?? '';

const tagByName = (db, name) => search(db, 'account.account.tag').find((tag) => tag.name === name && tag.applicability === 'accounts');

test('CFI-1: seed creates Indirect Cash Flow tags 4-35 and migration adds them idempotently', () => {
  const db = seed();
  assert.equal(INDIRECT_CASH_FLOW_TAGS.length, 32);
  INDIRECT_CASH_FLOW_TAGS.forEach((name, idx) => {
    const tag = tagByName(db, name);
    assert.ok(tag, `Seeded tag missing: ${name}`);
    assert.equal(tag.id, idx + 4, `Seeded tag ${name} should have id ${idx + 4}`);
    assert.equal(tag.applicability, 'accounts');
  });

  // Legacy DB at schema 82 without tags 4..35
  const legacy = {
    ...db,
    schema_version: 82,
    records: {
      ...db.records,
      'account.account.tag': (db.records['account.account.tag'] ?? []).filter((tag) => tag.id <= 3),
    },
    seq: { ...db.seq, 'account.account.tag': 3 },
  };
  const upgraded = migrate(legacy);
  assert.equal(upgraded.schema_version, SCHEMA_VERSION);
  for (const name of INDIRECT_CASH_FLOW_TAGS) {
    const matches = search(upgraded, 'account.account.tag').filter((tag) => tag.name === name && tag.applicability === 'accounts');
    assert.equal(matches.length, 1, `Migrated DB must contain tag ${name} exactly once`);
    assert.doesNotThrow(() => applyDiff(upgraded, diffDb(upgraded, { ...upgraded }), { isAdmin: true }));
    assert.deepEqual(Object.keys(matches[0]).filter((k) => !(k in cleanRecord('account.account.tag', matches[0]))), []);
  }
  assert.strictEqual(migrate(upgraded), upgraded, 'Migration is idempotent');
});

function buildIndirectFixture() {
  let db = seed();
  // Clear demo transactions so the fixed-date 2041 ledger is deterministic (2041 is non-leap, so Feb ends 02-28).
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': [],
      'account.payment': [],
      'account.asset': [],
      'account.bank.statement.line': [],
      'account.deferral': [],
    },
  };

  const tagId = (name) => tagByName(db, name).id;
  const assignTag = (code, tagName) => {
    db = write(db, 'account.account', accountId(db, code), { tag_ids: [tagId(tagName)] });
  };

  assignTag('680000', 'Adjustment - Depreciation and amortization');
  assignTag('450300', 'Adjustment - PPE Sale');
  assignTag('121000', 'Working Capital - Trade Receivable');
  assignTag('211000', 'Working Capital - Trade Payable');
  assignTag('110100', 'Working Capital - Inventory');
  assignTag('151000', 'Investment - PPE Purchase');
  assignTag('301000', 'Financing - Share Issuance');
  assignTag('260000', 'Financing - Borrowings Short Term');

  const saleClearing = create(db, 'account.account', {
    code: '450900',
    name: 'Asset Sale Clearing',
    account_type: 'income_other',
    tag_ids: [tagId('Investment - PPE Sale')],
  });
  db = saleClearing.db;

  const partner1 = search(db, 'res.partner')[0].id;
  const bnk1 = journalId(db, 'BNK1');
  const vatSale = search(db, 'account.tax').find((tax) => tax.name === 'VAT 14%' && tax.type_tax_use === 'sale');

  // 1. Opening cash before period (2041-01-15) -> CF_CASH_BOP = 50,000
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-01-15',
    ref: 'Opening bank balance',
    lines: [
      { account: '101401', debit: 50000 },
      { account: '301000', credit: 50000 },
    ],
  }).db;

  // 2. Customer invoice with VAT 14% (2041-02-05): 10,000 sales + 1,400 VAT = 11,400 AR; partial payment 7,400 (2041-02-10)
  const invRes = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner1,
    invoice_date: '2041-02-05',
    invoice_line_ids: [
      {
        name: 'Consulting',
        account_id: accountId(db, '400000'),
        qty: 1,
        price_unit: 10000,
        tax_id: vatSale.id,
        tax_ids: [vatSale.id],
        tax: 14,
        tax_breakdown: [taxSnapshot(vatSale, db)],
      },
    ],
  });
  db = postMove(invRes.db, invRes.id);
  db = payMove(db, invRes.id, 7400, '2041-02-10', { directBank: true });

  // 3. Vendor bill (2041-02-06): 3,000 expense on AP; partial payment 1,000 (2041-02-12)
  const billRes = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner1,
    invoice_date: '2041-02-06',
    invoice_line_ids: [
      { name: 'Office Rent', account_id: accountId(db, '600000'), qty: 1, price_unit: 3000, tax: 0 },
    ],
  });
  db = postMove(billRes.db, billRes.id);
  db = payMove(db, billRes.id, 1000, '2041-02-12', { directBank: true });

  // 4. Inventory purchase paid via bank (2041-02-07): 1,500
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-02-07',
    ref: 'Stock purchase',
    lines: [
      { account: '110100', debit: 1500 },
      { account: '101401', credit: 1500 },
    ],
  }).db;

  // 5. Asset purchase (2041-02-02): 6,000 paid from bank, 1,000 depreciation (2041-02-28), then sold for 5,500 (2041-02-20)
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-02-02',
    ref: 'Equipment purchase',
    lines: [
      { account: '151000', debit: 6000 },
      { account: '101401', credit: 6000 },
    ],
  }).db;

  const assetRes = create(db, 'account.asset', {
    name: 'Server Rack',
    original_value: 6000,
    salvage_value: 0,
    acquisition_date: '2041-02-01',
    method: 'linear',
    method_number: 6,
    method_period: '1',
    company_id: 1,
    account_asset_id: accountId(db, '151000'),
    account_depreciation_id: accountId(db, '152000'),
    account_depreciation_expense_id: accountId(db, '680000'),
    state: 'draft',
  });
  db = confirmAsset(assetRes.db, read(assetRes.db, 'account.asset', assetRes.id));
  db = postDepreciation(db, read(db, 'account.asset', assetRes.id), '2041-02-28');

  const saleInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner1,
    invoice_date: '2041-02-20',
    invoice_line_ids: [
      { name: 'Server Rack Sale', account_id: saleClearing.id, qty: 1, price_unit: 5500, tax: 0 },
    ],
  });
  db = postMove(saleInv.db, saleInv.id);
  db = payMove(db, saleInv.id, 5500, '2041-02-22', { directBank: true });
  db = disposeAsset(db, read(db, 'account.asset', assetRes.id), {
    date: '2041-02-28',
    saleValue: 5500,
    invoiceId: saleInv.id,
    gainAccountId: accountId(db, '450300'),
  });

  // 6. Borrowing (8,000) and repayment (2,000)
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-02-08',
    ref: 'Short-term loan drawdown',
    lines: [
      { account: '101401', debit: 8000 },
      { account: '260000', credit: 8000 },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-02-18',
    ref: 'Short-term loan repayment',
    lines: [
      { account: '260000', debit: 2000 },
      { account: '101401', credit: 2000 },
    ],
  }).db;

  // 7. Share issuance (12,000)
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-02-03',
    ref: 'Share issuance',
    lines: [
      { account: '101401', debit: 12000 },
      { account: '301000', credit: 12000 },
    ],
  }).db;

  // 8. Unreconciled bank statement line (+350) booked to suspense
  const stLine = create(db, 'account.bank.statement.line', {
    journal_id: bnk1,
    company_id: 1,
    date: '2041-02-25',
    payment_ref: 'Unmatched customer wire',
    amount: 350,
    state: 'to_check',
  });
  db = bookBankMovement(stLine.db, read(stLine.db, 'account.bank.statement.line', stLine.id), 1, {
    date: '2041-02-25',
    openAmount: 350,
  }).db;

  return db;
}

test('CFI-1: cashFlowIndirect computes every line accurately and beginning cash + CASH FLOW = ending cash', () => {
  const db = buildIndirectFixture();
  const report = cashFlowIndirect(db, { from: '2041-02-01', to: '2041-02-28', company_id: 1 });
  const c = report.byCode;

  assert.equal(c.CF_OP_EBIT, 6500); // 10,000 sales - 3,000 expense - 1,000 depreciation + 500 gain on PPE sale
  assert.equal(c.CF_OP_ADJ_DEP_AND_AMORT, 1000);
  assert.equal(c.CF_OP_ADJ_PROV, 0);
  assert.equal(c.CF_OP_ADJ_SALE_INT_ASS, 0);
  assert.equal(c.CF_OP_ADJ_SALE_PPE, -500);
  assert.equal(c.CF_OP_ADJ_SALE_ROU, 0);
  assert.equal(c.CF_OP_ADJ_SALE_FIN_INSTR, 0);
  assert.equal(c.CF_OP_ADJ_FOREX, 0);
  assert.equal(c.CF_OP_ADJ_NET_FIN_RESULT, 0);
  assert.equal(c.CF_OP_ADJ, 500);

  assert.equal(c.CF_OP_WCAP_TRA_REC, -4000);
  assert.equal(c.CF_OP_WCAP_OTH_REC, 0);
  assert.equal(c.CF_OP_WCAP_TRA_PAY, 2000);
  assert.equal(c.CF_OP_WCAP_OTH_PAY, 1400); // VAT Output (251000) linked to VAT 14% tax repartition line
  assert.equal(c.CF_OP_WCAP_INV, -1500);
  assert.equal(c.CF_OP_WCAP_DEF_REV, 0);
  assert.equal(c.CF_OP_WCAP, -2100);
  assert.equal(c.CF_OP_INC_TAX, 0);
  assert.equal(c.CF_OP_INT, 0);
  assert.equal(c.CF_OP, 4900);

  assert.equal(c.CF_INV_INT_ASS_SALE, 0);
  assert.equal(c.CF_INV_INT_ASS_PURCH, 0);
  assert.equal(c.CF_INV_INT_ASS, 0);
  assert.equal(c.CF_INV_PPE_SALE, 5500);
  assert.equal(c.CF_INV_PPE_PURCH, -6000);
  assert.equal(c.CF_INV_PPE, -500);
  assert.equal(c.CF_INV_ROU, 0);
  assert.equal(c.CF_INV_FIN_INSTR, 0);
  assert.equal(c.CF_INV_RECEP_RECOV_CASH_ADV, 0);
  assert.equal(c.CF_INV_REPAY_RECOV_CASH_ADV, 0);
  assert.equal(c.CF_INV_INT_PAID, 0);
  assert.equal(c.CF_INV, -500);

  assert.equal(c.CF_FIN_PROC_SHARE_ISS, 12000);
  assert.equal(c.CF_FIN_INT_DIV_PAID, 0);
  assert.equal(c.CF_FIN_PROC_BORR, 8000);
  assert.equal(c.CF_FIN_REPAY_BORR, -2000);
  assert.equal(c.CF_FIN_LEASE_REPAY, 0);
  assert.equal(c.CF_FIN_PROC_RECOV_ADV, 0);
  assert.equal(c.CF_FIN_REPAY_RECOV_ADV, 0);
  assert.equal(c.CF_FIN, 18000);

  assert.equal(c.CF_NOT_RECON, 350);
  assert.equal(c.CF_CASH, 22750);
  assert.equal(c.CF_CASH_BOP, 50000);
  assert.equal(c.CF_CASH_VAR, 22750);
  assert.equal(c.CF_CASH_VAR_CASH, 0);
  assert.equal(c.CF_CASH_VAR_NON_CASH, 22750);
  assert.equal(c.CF_CASH_EOP, 72750);
  assert.equal(c.CF_CASH_BOP + c.CF_CASH, c.CF_CASH_EOP);
});

test('CFI-1: Cash Flow Statement variant selector switches between direct and indirect with folding and exports', async () => {
  const db = buildIndirectFixture();
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/cash-flow' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'cashflow', key: 'cash-flow' } })));

    // Direct report renders by default
    assert.ok(textOf(host).includes('Cash Flow Statement'));
    assert.ok(textOf(host).includes('Cash at the beginning of the period'));

    // Set custom period 2041-02-01..2041-02-28
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    assert.ok(periodSelect);
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'From');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'To');
    await React.act(async () => props(fromInput).onChange({ target: { value: '2041-02-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2041-02-28' } }));

    // Switch variant selector to Indirect Cash Flow Statement
    const variantSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Variant');
    assert.ok(variantSelect, 'Variant selector should be rendered on Cash Flow Statement page');
    await React.act(async () => props(variantSelect).onChange({ target: { value: 'indirect' } }));

    const indirectText = textOf(host);
    assert.ok(indirectText.includes('Indirect Cash Flow Statement'));
    assert.ok(indirectText.includes('Cash Flows from operating activities'));
    assert.ok(indirectText.includes('Depreciation and amortisation'));
    assert.ok(indirectText.includes('Not reconciled yet'));
    assert.ok(indirectText.includes('Cash and cash equivalents at beginning'));
    assert.ok(indirectText.includes('Cash and cash equivalents at end'));

    // Fold / unfold controls work
    const collapseBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Collapse All');
    assert.ok(collapseBtn, 'Collapse All button should render when unfolded');
    await React.act(async () => props(collapseBtn).onClick());
    assert.ok(find(host, (n) => n.className?.includes('report-folded-row')), 'Collapsed rows carry report-folded-row');
    assert.equal(collapseBtn.textContent, 'Unfold All');
    await React.act(async () => props(collapseBtn).onClick());
    assert.equal(collapseBtn.textContent, 'Collapse All');

    // CSV/XLSX export table extraction includes the indirect lines
    const table = find(host, (n) => n.tagName === 'TABLE');
    const exportedRows = tableToRows(table);
    assert.ok(exportedRows.some((row) => row[0] === 'CASH FLOW' && row[1].includes('22,750.00')));
    assert.ok(exportedRows.some((row) => row[0] === 'Not reconciled yet' && row[1].includes('350.00')));

    // Switch back to direct
    await React.act(async () => props(variantSelect).onChange({ target: { value: 'direct' } }));
    assert.ok(textOf(host).includes('Cash at the beginning of the period'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('CFI-1: all Indirect Cash Flow labels have formal Arabic translations', async () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => (key === 'mizan-lang' ? 'ar' : null) };
  try {
    const { lang, t } = await import(`./i18n.js?cfi1-ar-${Date.now()}`);
    assert.equal(lang, 'ar');
    const db = seed();
    const { lines } = cashFlowIndirect(db, { from: '2040-01-01', to: '2040-12-31', company_id: 1 });
    for (const label of ['Indirect Cash Flow Statement', ...lines.map((l) => l.name)]) {
      const translated = t(label);
      assert.notEqual(translated, label, `Missing Arabic translation for: ${label}`);
      assert.match(translated, /[\u0600-\u06FF]/, `Expected Arabic script for: ${label}`);
    }
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('CFI-1 regression (Finding 3): analytic filter keeps unallocated bank and working-capital counterparts', () => {
  let db = seed();
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': [],
      'account.payment': [],
      'account.asset': [],
      'account.bank.statement.line': [],
      'account.deferral': [],
    },
  };
  const plan = create(db, 'account.analytic.plan', { name: 'Projects', default_applicability: 'optional' });
  db = plan.db;
  const office = create(db, 'account.analytic.account', { name: 'Office Fitout', code: 'PRJ-1', plan_id: plan.id });
  db = office.db;

  // Unpaid vendor bill: analytic expense with unallocated trade payable counterpart
  const billRes = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: search(db, 'res.partner')[0].id,
    invoice_date: '2041-03-05',
    invoice_line_ids: [
      { name: 'Analytic Service', account_id: accountId(db, '600000'), qty: 1, price_unit: 1000, tax: 0, analytic_distribution: { [office.id]: 100 } },
    ],
  });
  db = postMove(billRes.db, billRes.id);

  // Analytic expense paid directly from unallocated bank line + bank/cash transfer with unallocated cash counterpart
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-03-10',
    ref: 'Direct analytic expense',
    lines: [
      { account: '600000', debit: 400, analytic_distribution: { [office.id]: 100 } },
      { account: '101401', credit: 400 },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-03-12',
    ref: 'Analytic cash deposit',
    lines: [
      { account: '101401', debit: 250, analytic_distribution: { [office.id]: 100 } },
      { account: '101501', credit: 250 },
    ],
  }).db;

  const report = cashFlowIndirect(db, { from: '2041-03-01', to: '2041-03-31', company_id: 1, analyticAccountIds: [office.id] });
  const c = report.byCode;
  assert.equal(c.CF_OP_EBIT, -1400);
  assert.equal(c.CF_OP_WCAP_TRA_PAY, 1000, 'Unallocated payable counterpart of analytic bill is retained');
  assert.equal(c.CF_OP, -400);
  assert.equal(c.CF_CASH_VAR_NON_CASH, -400);
  assert.equal(c.CF_CASH_VAR_CASH, 250, 'Unallocated cash counterpart of analytic bank line is retained');
  assert.equal(c.CF_CASH_EOP, -150);
  assert.equal(c.CF_CASH_BOP + c.CF_CASH, c.CF_CASH_EOP);
});

test('CFI-1 regression (Finding 9): archived matching tag satisfies migration and still classifies accounts', () => {
  let db = seed();
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': [],
      'account.payment': [],
      'account.asset': [],
      'account.bank.statement.line': [],
      'account.deferral': [],
    },
  };
  const archivedBorrowingId = 9901;
  const legacy = {
    ...db,
    schema_version: 82,
    records: {
      ...db.records,
      'account.account.tag': [
        ...(db.records['account.account.tag'] ?? []).filter((tag) => tag.id <= 3),
        { id: archivedBorrowingId, name: 'Financing - Borrowings Short Term', applicability: 'accounts', active: false },
      ],
    },
    seq: { ...db.seq, 'account.account.tag': archivedBorrowingId },
  };
  let upgraded = migrate(legacy);
  const matching = (upgraded.records['account.account.tag'] ?? []).filter(
    (tag) => tag.name === 'Financing - Borrowings Short Term' && tag.applicability === 'accounts' && !tag.country_id,
  );
  assert.equal(matching.length, 1, 'Migration preserves existing archived matching tag without duplicating it');
  assert.equal(matching[0].id, archivedBorrowingId);

  upgraded = write(upgraded, 'account.account', accountId(upgraded, '260000'), { tag_ids: [archivedBorrowingId] });
  upgraded = postEntry(upgraded, {
    journal: 'BNK1',
    date: '2041-04-05',
    ref: 'Loan drawdown',
    lines: [
      { account: '101401', debit: 5000 },
      { account: '260000', credit: 5000 },
    ],
  }).db;
  upgraded = postEntry(upgraded, {
    journal: 'BNK1',
    date: '2041-04-15',
    ref: 'Loan repayment',
    lines: [
      { account: '260000', debit: 1500 },
      { account: '101401', credit: 1500 },
    ],
  }).db;

  const { byCode } = cashFlowIndirect(upgraded, { from: '2041-04-01', to: '2041-04-30', company_id: 1 });
  assert.equal(byCode.CF_FIN_PROC_BORR, 5000);
  assert.equal(byCode.CF_FIN_REPAY_BORR, -1500);
});

test('CFI-1 regression (Finding 10): country-specific tag sharing a standard name is ignored by indirect cash flow', () => {
  let db = seed();
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': [],
      'account.payment': [],
      'account.asset': [],
      'account.bank.statement.line': [],
      'account.deferral': [],
    },
  };
  const saId = db.records['res.country'].find((c) => c.code === 'SA').id;
  const countryTag = create(db, 'account.account.tag', {
    name: 'Financing - Borrowings Short Term',
    applicability: 'accounts',
    country_id: saId,
  });
  db = countryTag.db;
  const countryLoanAcc = create(db, 'account.account', {
    code: '269900',
    name: 'Local Borrowing',
    account_type: 'liability_current',
    tag_ids: [countryTag.id],
  });
  db = countryLoanAcc.db;
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-05-05',
    ref: 'Local loan',
    lines: [
      { account: '101401', debit: 3000 },
      { account: '269900', credit: 3000 },
    ],
  }).db;

  const { byCode } = cashFlowIndirect(db, { from: '2041-05-01', to: '2041-05-31', company_id: 1 });
  assert.equal(byCode.CF_FIN_PROC_BORR, 0, 'Country-specific tag must not match global indirect tag');
  assert.equal(byCode.CF_NOT_RECON, 3000);
});

test('CFI-1 regression (Finding 12): fold toggles in CashFlowIndirect do not recompute the report', async () => {
  const baseDb = buildIndirectFixture();
  let moveReads = 0;
  const trackedRecords = { ...baseDb.records };
  const moves = baseDb.records['account.move'];
  Object.defineProperty(trackedRecords, 'account.move', {
    enumerable: true,
    get() {
      moveReads += 1;
      return moves;
    },
  });
  const trackedDb = { ...baseDb, records: trackedRecords };

  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { CashFlowIndirect } = await import('./views/CashFlowIndirect.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const period = { from: '2041-02-01', to: '2041-02-28', company_id: 1 };
  try {
    await React.act(async () => root.render(
      React.createElement('table', null, React.createElement(CashFlowIndirect, { db: trackedDb, period, companyId: 1 })),
    ));
    const readsAfterMount = moveReads;
    assert.ok(readsAfterMount > 0, 'Initial render should compute the indirect cash flow report');

    const collapseBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Collapse All');
    assert.ok(collapseBtn);
    await React.act(async () => props(collapseBtn).onClick());
    assert.equal(moveReads, readsAfterMount, 'Collapse All must not recompute cashFlowIndirect');

    const sectionBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Cash Flows from operating activities'));
    assert.ok(sectionBtn);
    await React.act(async () => props(sectionBtn).onClick());
    assert.equal(moveReads, readsAfterMount, 'Toggling a section fold must not recompute cashFlowIndirect');

    await React.act(async () => root.render(
      React.createElement('table', null, React.createElement(CashFlowIndirect, {
        db: trackedDb,
        period: { from: '2041-03-01', to: '2041-03-31', company_id: 1 },
        companyId: 1,
      })),
    ));
    assert.ok(moveReads > readsAfterMount, 'Changing the period must recompute cashFlowIndirect');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('CFI-1 regression (Finding 13): seeded database populates indirect cash flow detail without manual retagging', () => {
  const db = seed();
  // Seeded invoices, vendor bill, and valued stock moves span addDays(today(), -45)..today(), which crosses Jan 1 in early January.
  const { byCode } = cashFlowIndirect(db, { from: addDays(today(), -60), to: today(), company_id: 1 });
  assert.notEqual(byCode.CF_OP_WCAP_TRA_REC, 0, 'Seeded invoices and payments should populate Trade receivables');
  assert.notEqual(byCode.CF_OP_WCAP_TRA_PAY, 0, 'Seeded vendor bill should populate Trade payables');
  assert.notEqual(byCode.CF_OP_WCAP_INV, 0, 'Seeded stock valuation should populate Inventory');
  assert.equal(byCode.CF_CASH_BOP + byCode.CF_CASH, byCode.CF_CASH_EOP);

  // Direct cash-flow activity classification on seeded accounts remains intact
  const loanAcc = read(db, 'account.account', accountId(db, '260000'));
  const fixedAcc = read(db, 'account.account', accountId(db, '151000'));
  assert.equal(accountCashFlowActivity(db, loanAcc), 'financing');
  assert.equal(accountCashFlowActivity(db, fixedAcc), 'investing');
});

test('CFI-1 regression (review Finding 2): analytic cash excludes unrelated unallocated P&L lines in the same paid entry', () => {
  let db = seed();
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': [],
      'account.payment': [],
      'account.asset': [],
      'account.bank.statement.line': [],
      'account.deferral': [],
    },
  };
  const plan = create(db, 'account.analytic.plan', { name: 'Projects', default_applicability: 'optional' });
  db = plan.db;
  const alpha = create(db, 'account.analytic.account', { name: 'Project Alpha', code: 'PRJ-A', plan_id: plan.id });
  db = alpha.db;

  // One paid bank entry combining a selected project expense (400) and an unrelated unallocated expense (100).
  db = postEntry(db, {
    journal: 'BNK1',
    date: '2041-03-15',
    ref: 'Mixed project and general expense',
    lines: [
      { account: '600000', debit: 400, analytic_distribution: { [alpha.id]: 100 } },
      { account: '630000', debit: 100 },
      { account: '101401', credit: 500 },
    ],
  }).db;

  const period = { from: '2041-03-01', to: '2041-03-31', company_id: 1, analyticAccountIds: [alpha.id] };
  const { byCode } = cashFlowIndirect(db, period);
  assert.equal(byCode.CF_OP_EBIT, -400);
  assert.equal(byCode.CF_OP, -400);
  assert.equal(byCode.CF_CASH_VAR_NON_CASH, -400);
  assert.equal(byCode.CF_CASH_EOP, -400, 'Cash endpoint must reflect only the selected project expense');
  assert.equal(byCode.CF_CASH, -400);
  assert.equal(byCode.CF_NOT_RECON, 0, 'Unallocated expense must not create a reconciliation residual');

  const direct = cashFlow(db, period);
  assert.equal(direct.operating, -400);
  assert.equal(direct.closing, -400);
  assert.equal(direct.net, -400);

  const bs = balanceSheet(db, { to: '2041-03-31', company_id: 1 }, { analyticAccountIds: [alpha.id] });
  assert.equal(bs.totalAssets, -400);
  assert.equal(bs.totalAssets, bs.totalLiabilities + bs.totalEquity);
});
