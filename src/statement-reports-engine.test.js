import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write, updateSettings } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { ACCOUNT_TYPES, balanceSheet, postEntry, profitAndLoss } from './models/ledger.js';
import { postMove, payMove } from './models/accounting.js';
import { ensureStatementReports, findStatementReport } from './models/statementReports.js';
import { compareConfigurableReport, configurableReport } from './models/configurableReports.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { periodsFor } from './views/reportCompare.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

function tableRows(host) {
  const table = find(host, (n) => n.tagName === 'TABLE');
  assert.ok(table, 'expected table');
  const rows = [];
  const walk = (node) => {
    if (node.tagName === 'TR') {
      const cells = [];
      for (const c of node.childNodes ?? []) {
        if (c.tagName === 'TH' || c.tagName === 'TD') cells.push(c.textContent.trim());
      }
      if (cells.length) rows.push(cells);
    }
    for (const c of node.childNodes ?? []) walk(c);
  };
  walk(table);
  return rows;
}

function buildProbe5Scenario() {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = new Date().getUTCFullYear();
  const ymd = (m, d) => `${yr}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { company_id: 1, date: ymd(1, 1), rate: 2.0 },
      { company_id: 1, date: ymd(2, 1), rate: 2.5 },
    ],
  });
  const partner = create(db, 'res.partner', { name: 'Probe Cust', customer_rank: 1 });
  db = partner.db;
  const vendor = create(db, 'res.partner', { name: 'Probe Vend', supplier_rank: 1 });
  db = vendor.db;
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const incAcc = search(db, 'account.account').find((a) => a.code === '400000' && (a.company_id ?? 1) === 1);
  const expAcc = search(db, 'account.account').find((a) => a.code === '500000' && (a.company_id ?? 1) === 1);
  const capAcc = search(db, 'account.account').find((a) => a.code === '301000' && (a.company_id ?? 1) === 1);
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401' && (a.company_id ?? 1) === 1);

  db = postEntry(db, {
    journal: 'MISC', company: 1, date: ymd(1, 1), ref: 'Seed Cash',
    lines: [{ account_id: cashAcc.id, debit: 10000 }, { account_id: capAcc.id, credit: 10000 }],
  }).db;

  const postMoveFn = (d, id) => postMove(d, id);
  const payMoveFn = (d, moveId, amount, date) => payMove(d, moveId, amount, date, bnk.id);

  // Sale 1000, refund 200 -> net 800
  const i1 = create(db, 'account.move', {
    move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: ymd(1, 10), invoice_date_due: ymd(1, 10),
    invoice_line_ids: [{ name: 'Prod A', account_id: incAcc.id, qty: 1, price_unit: 1000, tax_ids: [], tax: 0 }],
  });
  db = payMoveFn(postMoveFn(i1.db, i1.id), i1.id, 500, ymd(1, 20));
  const r1 = create(db, 'account.move', {
    move_type: 'out_refund', company_id: 1, partner_id: partner.id, invoice_date: ymd(2, 5), invoice_date_due: ymd(2, 5),
    invoice_line_ids: [{ name: 'Refund A', account_id: incAcc.id, qty: 1, price_unit: 200, tax_ids: [], tax: 0 }],
  });
  db = postMoveFn(r1.db, r1.id);

  // Expense 400
  const b1 = create(db, 'account.move', {
    move_type: 'in_invoice', company_id: 1, partner_id: vendor.id, invoice_date: ymd(1, 15), invoice_date_due: ymd(1, 15),
    invoice_line_ids: [{ name: 'Supp A', account_id: expAcc.id, qty: 1, price_unit: 400, tax_ids: [], tax: 0 }],
  });
  db = payMoveFn(postMoveFn(b1.db, b1.id), b1.id, 400, ymd(2, 15));

  // FX invoice 100 EUR @ 2.0 = 50 USD, partial pay 50 EUR @ 2.5 = 20 USD -> -5 USD FX loss (expense_other)
  const fxInv = create(db, 'account.move', {
    move_type: 'out_invoice', company_id: 1, partner_id: partner.id, currency_id: eur.id, invoice_date: ymd(1, 5), invoice_date_due: ymd(1, 5),
    invoice_line_ids: [{ name: 'FX Sale', account_id: incAcc.id, qty: 1, price_unit: 100, tax_ids: [], tax: 0 }],
  });
  db = payMoveFn(postMoveFn(fxInv.db, fxInv.id), fxInv.id, 50, ymd(2, 1));

  // Additional sale 500 USD -> total net profit = 800 - 400 + 50 - 5 + 500 = 945
  const s2 = create(db, 'account.move', {
    move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: ymd(1, 12), invoice_date_due: ymd(1, 12),
    invoice_line_ids: [{ name: 'Sale B', account_id: incAcc.id, qty: 1, price_unit: 500, tax_ids: [], tax: 0 }],
  });
  db = postMoveFn(s2.db, s2.id);
  return { db, yr, ymd };
}

test('seeded Balance Sheet and Profit and Loss exist per company using Odoo account_type hierarchy', () => {
  let db = seed();
  const bs1 = findStatementReport(db, 'balance', 1);
  const pnl1 = findStatementReport(db, 'pnl', 1);
  assert.ok(bs1 && pnl1, 'seeded company 1 has both statement reports');
  assert.equal(bs1.date_scope, 'cumulative');
  assert.equal(pnl1.date_scope, 'range');
  assert.equal(pnl1.exclude_closing, true);

  const bsNames = bs1.line_ids.map((l) => l.name);
  for (const required of [
    'ASSETS', 'Current Assets', 'Bank and Cash Accounts', 'Receivables', 'Prepayments',
    'Plus Fixed Assets', 'Plus Non-current Assets',
    'LIABILITIES', 'Current Liabilities', 'Payables', 'Credit Cards', 'Plus Non-current Liabilities',
    'EQUITY', 'Unallocated Earnings', 'Current Year Unallocated Earnings',
    'Current Year Earnings', 'Current Year Allocated Earnings', 'Previous Years Unallocated Earnings',
    'Retained Earnings', 'LIABILITIES + EQUITY',
  ]) {
    assert.ok(bsNames.includes(required), `Balance Sheet missing Odoo line: ${required}`);
  }

  const pnlNames = pnl1.line_ids.map((l) => l.name);
  for (const required of ['Revenue', 'Operating Income', 'Cost of Revenue', 'Gross Profit', 'Other Income', 'Expenses', 'Depreciation', 'Net Profit']) {
    assert.ok(pnlNames.includes(required), `P&L missing Odoo line: ${required}`);
  }

  const validTypes = new Set(ACCOUNT_TYPES.map(([code]) => code));
  for (const rep of [bs1, pnl1]) {
    for (const line of rep.line_ids) {
      assert.ok(!/^\d/.test(line.formula), `statement line ${line.code} must not select by account code: ${line.formula}`);
      if (line.formula.startsWith('type:')) {
        assert.ok(validTypes.has(line.formula.slice(5)), `invalid account type selector: ${line.formula}`);
      }
    }
  }

  const co2 = createCompany(db, { name: 'Second Co' });
  db = co2.db;
  assert.ok(findStatementReport(db, 'balance', co2.id), 'new company gets Balance Sheet');
  assert.ok(findStatementReport(db, 'pnl', co2.id), 'new company gets Profit and Loss');
});

test('Probe 5 ledger ties exactly (BS diff 0, Net Profit = Current Year Earnings = 945) through Reports menus', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const { db, yr } = buildProbe5Scenario();
  const bsRep = findStatementReport(db, 'balance', 1);
  const pnlRep = findStatementReport(db, 'pnl', 1);
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31` };

  const bsOut = configurableReport(db, bsRep, period);
  const pnlOut = configurableReport(db, pnlRep, period);
  const byCode = (out, code) => out.rows.find((r) => r.code === code).values[0];
  assert.equal(byCode(pnlOut, 'NET'), 945);
  assert.equal(byCode(bsOut, 'CYE'), 945);
  assert.equal(byCode(bsOut, 'ASSETS'), byCode(bsOut, 'LIAB_EQUITY'));

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'pnl', label: 'Profit and Loss' } })));
    const pnlRows = tableRows(host);
    const netRow = pnlRows.find((r) => r[0] === 'Net Profit');
    assert.ok(netRow, 'Net Profit row rendered in P&L menu');
    assert.equal(netRow[1], '$945.00');

    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'balance', label: 'Balance Sheet' } })));
    const bsRows = tableRows(host);
    const assetsRow = bsRows.find((r) => r[0] === 'ASSETS');
    const leRow = bsRows.find((r) => r[0] === 'LIABILITIES + EQUITY');
    const cyeRow = bsRows.find((r) => r[0] === 'Current Year Earnings');
    assert.equal(cyeRow[1], '$945.00');
    assert.equal(assetsRow[1], leRow[1], 'Balance Sheet Assets tie Liabilities + Equity in UI');

    // Editing seeded Balance Sheet record updates menu output immediately
    const edited = write(db, 'account.report', bsRep.id, {
      line_ids: [...bsRep.line_ids, { name: 'Custom Cash Check', code: 'CUSTOM_CASH', sequence: 220, parent_code: '', formula: 'type:asset_cash', sign: 1, foldable: false, strong: false }],
    });
    await React.act(async () => commit(edited));
    const updatedRows = tableRows(host);
    const customRow = updatedRows.find((r) => r[0] === 'Custom Cash Check');
    assert.ok(customRow, 'Added line on seeded Balance Sheet appears immediately in menu output');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('comparison, horizontal groups, analytic filter, depreciation, and multi-company match ledger.js results', () => {
  let db = seed();
  const yr = new Date().getUTCFullYear();
  const a1 = create(db, 'account.analytic.account', { name: 'Alpha Project', company_id: 1 });
  db = a1.db;
  const depAcc = create(db, 'account.account', { code: '681000', name: 'Depreciation Exp', account_type: 'expense_depreciation', company_id: 1 });
  db = depAcc.db;

  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-02-10`,
    lines: [
      { account: '101401', debit: 1000 },
      { account: '400000', credit: 1000, analytic_distribution: { [a1.id]: 60 } },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-03-10`,
    lines: [
      { account: depAcc.id, debit: 150 },
      { account: '101401', credit: 150 },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr - 1}-05-10`,
    lines: [
      { account: '101401', debit: 200 },
      { account: '400000', credit: 200 },
    ],
  }).db;

  const co2 = createCompany(db, { name: 'Subsidiary Co' });
  db = co2.db;
  const cash2 = create(db, 'account.account', { code: '101402', name: 'Co2 Cash', account_type: 'asset_cash', company_id: co2.id });
  db = cash2.db;
  const inc2 = create(db, 'account.account', { code: '400002', name: 'Co2 Income', account_type: 'income', company_id: co2.id });
  db = inc2.db;
  const gen2 = create(db, 'account.journal', { name: 'Co2 Misc', code: 'C2MJ', type: 'general', company_id: co2.id });
  db = gen2.db;
  db = postEntry(db, {
    journal: gen2.id,
    company: co2.id,
    date: `${yr}-02-20`,
    lines: [{ account_id: cash2.id, debit: 300 }, { account_id: inc2.id, credit: 300 }],
  }).db;
  db = updateSettings(db, { current_company_id: 1, allowed_company_ids: [1, co2.id] });

  const pnlRep = findStatementReport(db, 'pnl', 1);
  const bsRep = findStatementReport(db, 'balance', 1);
  const periods = periodsFor('year', 'lastYear', `${yr}-06-15`);

  // Period comparison matches profitAndLoss & balanceSheet across periods (incl. multi-company)
  const cmpPnl = compareConfigurableReport(db, pnlRep, periods, {}, null, { companyIds: [1, co2.id] });
  const cmpBs = compareConfigurableReport(db, bsRep, periods, {}, null, { companyIds: [1, co2.id] });
  const netCompare = cmpPnl.rows.find((r) => r.code === 'NET').values;
  assert.deepEqual(
    netCompare,
    periods.map((p) => profitAndLoss(db, p).net),
    'Multi-period comparison P&L Net matches profitAndLoss across companies',
  );
  periods.forEach((p, idx) => {
    const expectedBs = balanceSheet(db, p.to);
    assert.equal(cmpBs.rows.find((r) => r.code === 'ASSETS').values[idx], expectedBs.totalAssets);
    assert.equal(cmpBs.rows.find((r) => r.code === 'LIAB_EQUITY').values[idx], expectedBs.totalLiabilities + expectedBs.totalEquity);
  });

  // Analytic filter + Depreciation line
  const analyticPnl = configurableReport(db, pnlRep, { from: `${yr}-01-01`, to: `${yr}-12-31` }, null, { companyIds: [1], analyticAccountIds: [a1.id] });
  assert.equal(analyticPnl.rows.find((r) => r.code === 'OPINC').values[0], 600);
  const depRow = configurableReport(db, pnlRep, { from: `${yr}-01-01`, to: `${yr}-12-31` }, null, { companyIds: [1] }).rows.find((r) => r.code === 'DEP');
  assert.equal(depRow.values[0], 150, 'Depreciation line sums type:expense_depreciation');

  // Horizontal group with empty report_ids scopes to company 1 only
  const group = create(db, 'account.report.horizontal.group', {
    name: 'Project Split', company_id: 1, report_ids: [], rule_ids: [{ field: 'analytic', ids: String(a1.id) }],
  });
  db = group.db;
  const grpOut = configurableReport(db, pnlRep, { from: `${yr}-01-01`, to: `${yr}-12-31` }, read(db, 'account.report.horizontal.group', group.id));
  const co1Rev = profitAndLoss(db, { from: `${yr}-01-01`, to: `${yr}-12-31`, company_id: 1 }).revenue;
  const opIncGrp = grpOut.rows.find((r) => r.code === 'OPINC').values;
  assert.deepEqual(opIncGrp, [600, co1Rev - 600], 'Horizontal group excludes company 2 and splits Alpha Project vs Others');
});

test('migration 50 creates standard statement reports once and is idempotent', () => {
  let db = seed();
  const company2 = createCompany(db, { name: 'Company Two' });
  db = company2.db;
  // Simulate pre-v50 database missing account.report statement records
  const legacyDb = {
    ...db,
    schema_version: 49,
    records: {
      ...db.records,
      'account.report': (db.records['account.report'] ?? []).filter((r) => !['pnl', 'balance'].includes(r.kind)),
    },
  };
  const upgraded = migrate(legacyDb);
  assert.equal(upgraded.schema_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 52);
  for (const cId of [1, company2.id]) {
    assert.ok(findStatementReport(upgraded, 'balance', cId));
    assert.ok(findStatementReport(upgraded, 'pnl', cId));
  }
  const countBefore = upgraded.records['account.report'].length;
  const edited = write(upgraded, 'account.report', findStatementReport(upgraded, 'balance', 1).id, { name: 'My Custom BS' });
  const again = ensureStatementReports(migrate(edited));
  assert.equal(again.records['account.report'].length, countBefore, 'migration is idempotent and does not duplicate seeded reports');
  assert.equal(findStatementReport(again, 'balance', 1).name, 'My Custom BS', 'customized statement report is preserved');
});

test('all new statement line and field labels have distinct Arabic translations', async () => {
  globalThis.localStorage = { getItem: () => 'ar', setItem: () => {} };
  const { t } = await import(`./i18n.js?ar_check=${Date.now()}`);
  const labels = [
    'ASSETS', 'LIABILITIES', 'EQUITY', 'LIABILITIES + EQUITY',
    'Bank and Cash Accounts', 'Plus Fixed Assets', 'Plus Non-current Assets',
    'Credit Cards', 'Plus Non-current Liabilities',
    'Unallocated Earnings', 'Current Year Unallocated Earnings',
    'Current Year Allocated Earnings', 'Previous Years Unallocated Earnings',
    'Operating Income', 'Depreciation', 'Net Profit',
    'Report Kind', 'Date Scope', 'Period Range', 'As of Date',
    'Exclude Closing Entries', 'Foldable', 'Emphasized',
  ];
  for (const label of labels) {
    const tr = t(label);
    assert.notEqual(tr, label, `Arabic translation missing or identical for: ${label}`);
  }
});
