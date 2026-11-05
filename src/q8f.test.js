import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { balanceSheet, filterByAnalytic, isPaymentMatched, journalItems, postEntry, profitAndLoss } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { analyticActuals } from './models/finance.js';
import { cashFlow } from './models/reports.js';
import { journalAudit } from './models/journal_audit.js';
import { budgetReport } from './models/analyticplus.js';
import { createCompany, setCompanies } from './models/company.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';
import { balanceAnalyticColumns, cashflowColumns, pnlAnalyticColumns, supportsHorizontalGroupComparison } from './views/reportCompare.js';
import { today } from './models/common.js';
import { setupDom } from './test-support/dom.js';

const byType = (db, type) => search(db, 'account.account').find((account) => account.account_type === type);
const replaceRecord = (db, model, id, values) => ({
  ...db,
  records: { ...db.records, [model]: db.records[model].map((record) => record.id === id ? { ...record, ...values } : record) },
});
const appendRecord = (db, model, record) => ({
  ...db,
  records: { ...db.records, [model]: [...(db.records[model] ?? []), record] },
});
const nextId = (db, model) => Math.max(0, ...(db.records[model] ?? []).map((record) => record.id)) + 1;

async function renderReportText(db, report) {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
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
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
    return host.textContent;
  } finally {
    await React.act(async () => root.unmount());
  }
}

test('Qodo 16: analytic report filter scales split allocations', () => {
  let db = seed();
  const first = create(db, 'account.analytic.account', { name: 'Alpha split' }); db = first.db;
  const second = create(db, 'account.analytic.account', { name: 'Beta split' }); db = second.db;
  const line = { account_id: byType(db, 'income').id, debit: 0, credit: 100, analytic_distribution: { [first.id]: 60, [second.id]: 40 } };

  assert.equal(filterByAnalytic([line], [first.id])[0].credit, 60);
  assert.equal(filterByAnalytic([line], [second.id])[0].credit, 40);
  assert.equal(filterByAnalytic([line], [first.id, second.id])[0].credit, 100);

  db = postEntry(db, { journal: 'MISC', date: '2040-01-01', lines: [
    { account_id: byType(db, 'asset_cash').id, debit: 100 },
    { account_id: byType(db, 'income').id, credit: 100, analytic_distribution: { [first.id]: 60, [second.id]: 40 } },
  ] }).db;
  assert.equal(profitAndLoss(db, { from: '2040-01-01', to: '2040-01-01' }, { analyticAccountIds: [first.id] }).revenue, 60);
});

test('Qodo 17: cash flow page has no horizontal balance sheet group path', async () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Cash flow group account' }); db = analytic.db;
  db = create(db, 'account.report.horizontal.group', {
    name: 'Cash flow comparison group', company_id: 1, rule_ids: [{ field: 'analytic', ids: String(analytic.id) }],
  }).db;
  const data = cashflowColumns(db, [{ from: '2040-01-01', to: '2040-01-31', label: 'Jan 2040' }]);

  assert.equal(supportsHorizontalGroupComparison('cashflow'), false);
  assert.equal(supportsHorizontalGroupComparison('pnl'), true);
  assert.ok(data.sections.some((section) => section.title === 'Operating Activities'));
  assert.equal(data.sections.some((section) => section.title === 'Assets'), false);
  const text = await renderReportText(db, 'cashflow');
  assert.match(text, /Cash Flow Statement/);
  assert.doesNotMatch(text, /Horizontal Group|Total Assets|Total Liabilities/);
});

test('Qodo 38: zero analytic actuals skip foreign currency conversion', () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Zero foreign actual' }); db = analytic.db;
  const foreign = create(db, 'res.currency', { name: 'Unrated test currency', rounding: 0.01, rate_ids: [] }); db = foreign.db;
  const company = createCompany(db, { name: 'Unrated foreign branch', ...invoiceJournalDefaults(db), currency_id: foreign.id }); db = company.db;
  db = appendRecord(db, 'account.analytic.line', {
    id: nextId(db, 'account.analytic.line'), account_id: analytic.id,
    date: '2040-03-05', amount: 0, company_id: company.id, currency_id: foreign.id,
  });

  assert.equal(analyticActuals(db, { from: '2040-03-01', to: '2040-03-31', company_id: company.id }).get(analytic.id), 0);
});

test('Qodo 53: account budget preserves thousandth currency actuals', () => {
  let db = seed();
  const currencyId = read(db, 'res.company', 1).currency_id;
  db = replaceRecord(db, 'res.currency', currencyId, { rounding: 0.001 });
  const expense = byType(db, 'expense');
  const cash = byType(db, 'asset_cash');
  const entry = postEntry(db, { journal: 'MISC', date: '2040-04-10', company: 1, lines: [
    { account_id: expense.id, debit: 0.001 },
    { account_id: cash.id, credit: 0.001 },
  ] });
  const budget = create(entry.db, 'account.budget', {
    name: 'Thousandth budget', company_id: 1, date_from: '2040-01-01', date_to: '2040-12-31',
    lines: [{ account_id: expense.id, planned: 0.003 }],
  });
  const [row] = budgetReport(budget.db, budget.id, '2040-12-31');

  assert.equal(row.analytic_lines[0].amount, -0.001);
  assert.equal(row.practical, -0.001);
});

test('Qodo 55: legacy budget requires and accepts an explicit company selection', async () => {
  let db = seed();
  const company = createCompany(db, { name: 'Budget branch', ...invoiceJournalDefaults(db) }); db = company.db;
  db = setCompanies(db, { current: 1, allowed: [1, company.id] });
  const budget = create(db, 'account.budget', {
    name: 'Legacy budget', company_id: 1, state: 'confirmed',
    date_from: `${today().slice(0, 4)}-01-01`, date_to: `${today().slice(0, 4)}-12-31`,
    lines: [{ planned: 100 }],
  });
  db = replaceRecord(budget.db, 'account.budget', budget.id, { company_id: null });

  assert.throws(() => budgetReport(db, budget.id, today()), /Select an existing company for the budget/);
  assert.equal(budgetReport(db, budget.id, today(), { company_id: company.id }).length, 1);
  const text = await renderReportText(db, 'budget');
  assert.match(text, /Legacy budget/);
  assert.match(text, /Budget branch/);
  assert.match(text, /Select a company/);
});

test('Qodo 56: budget commitments resolve explicit purchase distribution models', () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Modelled purchase' }); db = analytic.db;
  const model = create(db, 'account.analytic.distribution.model', {
    product_id: 5, company_id: 1, analytic_distribution: { [analytic.id]: 100 },
  }); db = model.db;
  const order = create(db, 'purchase.order', {
    state: 'purchase', partner_id: 2, company_id: 1, date_order: '2040-05-10',
    order_line: [{ purchase_line_key: 'modelled-line', product_id: 5, qty: 2, price_unit: 25, tax: 0 }],
  });
  const budget = create(order.db, 'account.budget', {
    name: 'Modelled budget', company_id: 1, date_from: '2040-01-01', date_to: '2040-12-31',
    lines: [{ analytic_account_id: analytic.id, planned: -100 }],
  });

  const [row] = budgetReport(budget.db, budget.id, '2040-12-31');
  assert.equal(row.commitment_lines.length, 1);
  assert.equal(row.commitment_lines[0].amount, -50);
});

test('Qodo 57: one unlinked posted bill line does not abort other budget rows', async () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Unlinked purchase' }); db = analytic.db;
  const order = create(db, 'purchase.order', {
    state: 'purchase', partner_id: 2, company_id: 1, date_order: '2026-06-10',
    order_line: [{ purchase_line_key: 'known-line', product_id: 5, qty: 1, price_unit: 100, tax: 0, analytic_distribution: { [analytic.id]: 100 } }],
  });
  const bill = create(order.db, 'account.move', {
    move_type: 'in_invoice', purchase_id: order.id, partner_id: 2, company_id: 1,
    invoice_date: '2026-06-12', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);
  assert.equal(read(db, 'account.move', bill.id).invoice_line_ids[0].purchase_line_key, undefined);
  const affected = create(db, 'account.budget', {
    name: 'Affected budget', company_id: 1, state: 'confirmed', date_from: '2026-01-01', date_to: '2026-12-31',
    lines: [{ analytic_account_id: analytic.id, planned: -100 }],
  });
  assert.throws(() => budgetReport(affected.db, affected.id, '2026-12-31'), /Link each posted bill line/);
  const unaffected = create(affected.db, 'account.budget', {
    name: 'Unaffected budget', company_id: 1, state: 'confirmed', date_from: '2026-01-01', date_to: '2026-12-31',
    lines: [{ planned: 100 }],
  });
  const text = await renderReportText(unaffected.db, 'budget');
  assert.match(text, /Affected budget/);
  assert.match(text, /Unaffected budget/);
  assert.match(text, /Link each posted bill line/);
  assert.match(text, /100\.00/);
});

test('Qodo 58: journal reconciliation finds statement matches through the indexed payment links', () => {
  const base = seed();
  const company = read(base, 'res.company', 1);
  const outstanding = company.outstanding_receipts_account_id;
  const cash = byType(base, 'asset_cash');
  const journal = search(base, 'account.journal').find((item) => item.code === 'MISC');
  const firstMoveId = nextId(base, 'account.move');
  const payments = Array.from({ length: 80 }, (_, index) => ({ id: index + 1, move_id: firstMoveId + index, outstanding_account_id: outstanding }));
  const moves = payments.map((payment, index) => ({
    id: payment.move_id, name: `PAY/2040/${index + 1}`, move_type: 'entry', state: 'posted', company_id: 1,
    journal_id: journal.id, date: '2040-07-01', invoice_date: '2040-07-01',
    line_ids: [{ account_id: outstanding, debit: 10, credit: 0 }, { account_id: cash.id, debit: 0, credit: 10 }],
  }));
  const statementLines = [
    ...Array.from({ length: 300 }, (_, index) => ({ id: index + 1, state: 'draft', allocations: [] })),
    ...payments.map((payment, index) => ({ id: index + 301, state: 'reconciled', payment_move_id: payment.move_id, allocations: [] })),
  ];
  const db = {
    ...base,
    records: {
      ...base.records,
      'account.payment': [...base.records['account.payment'], ...payments],
      'account.move': [...base.records['account.move'], ...moves],
      'account.bank.statement.line': statementLines,
    },
  };
  const rows = journalItems(db, { from: '2040-07-01', to: '2040-07-01' });
  const reconciledOutstanding = rows.filter((line) => line.account_id === outstanding && line.reconciled);

  assert.equal(reconciledOutstanding.length, payments.length);
  assert.equal(isPaymentMatched(db, payments[0]), true);
  assert.equal(isPaymentMatched(db, payments[0], 301), false);
});

test('Qodo 59: analytic cash flow restores an untagged cash counterpart at the allocated share', () => {
  let db = seed();
  const first = create(db, 'account.analytic.account', { name: 'Cash flow alpha' }); db = first.db;
  const second = create(db, 'account.analytic.account', { name: 'Cash flow beta' }); db = second.db;
  const cash = byType(db, 'asset_cash');
  const expense = byType(db, 'expense');
  db = postEntry(db, { journal: 'MISC', date: '2040-07-31', lines: [
    { account_id: expense.id, debit: 50, analytic_distribution: { [first.id]: 60, [second.id]: 40 } },
    { account_id: cash.id, credit: 50 },
  ] }).db;
  db = postEntry(db, { journal: 'MISC', date: '2040-08-10', lines: [
    { account_id: expense.id, debit: 100, analytic_distribution: { [first.id]: 60, [second.id]: 40 } },
    { account_id: cash.id, credit: 100 },
  ] }).db;

  const firstFlow = cashFlow(db, { from: '2040-08-01', to: '2040-08-31', analyticAccountIds: [first.id] });
  const secondFlow = cashFlow(db, { from: '2040-08-01', to: '2040-08-31', analyticAccountIds: [second.id] });
  assert.deepEqual([firstFlow.opening, firstFlow.operating, firstFlow.closing, firstFlow.net], [-30, -60, -90, -60]);
  assert.deepEqual([secondFlow.opening, secondFlow.operating, secondFlow.closing, secondFlow.net], [-20, -40, -60, -40]);
});

test('Qodo 60: horizontal partner columns retain the selected analytic account filter', () => {
  let db = seed();
  const first = create(db, 'account.analytic.account', { name: 'Grouped alpha' }); db = first.db;
  const second = create(db, 'account.analytic.account', { name: 'Grouped beta' }); db = second.db;
  const cash = byType(db, 'asset_cash');
  const income = byType(db, 'income');
  db = postEntry(db, { journal: 'MISC', date: '2040-09-10', lines: [
    { account_id: cash.id, debit: 100, partner_id: 1, analytic_distribution: { [first.id]: 60, [second.id]: 40 } },
    { account_id: income.id, credit: 100, partner_id: 1, analytic_distribution: { [first.id]: 60, [second.id]: 40 } },
  ] }).db;
  db = postEntry(db, { journal: 'MISC', date: '2040-09-11', lines: [
    { account_id: cash.id, debit: 50, partner_id: 2, analytic_distribution: { [second.id]: 100 } },
    { account_id: income.id, credit: 50, partner_id: 2, analytic_distribution: { [second.id]: 100 } },
  ] }).db;
  const group = { company_id: 1, rule_ids: [{ field: 'partner', ids: '' }] };
  const analyticGroup = { company_id: 1, rule_ids: [{ field: 'analytic', ids: '' }] };
  const period = { from: '2040-09-01', to: '2040-09-30' };
  const pnl = pnlAnalyticColumns(db, group, period, { analyticAccountIds: [first.id] });
  const balance = balanceAnalyticColumns(db, group, period, { analyticAccountIds: [first.id] });
  const analyticPnl = pnlAnalyticColumns(db, analyticGroup, period, { analyticAccountIds: [first.id] });
  const analyticBalance = balanceAnalyticColumns(db, analyticGroup, period, { analyticAccountIds: [first.id] });
  const alphaName = read(db, 'res.partner', 1).name;
  const betaName = read(db, 'res.partner', 2).name;
  const pnlRevenue = pnl.sections.find((section) => section.title === 'Revenue');
  const balanceAssets = balance.sections.find((section) => section.title === 'Assets');

  assert.equal(pnlRevenue.totals[pnl.headers.indexOf(alphaName)], 60);
  assert.equal(pnlRevenue.totals[pnl.headers.indexOf(betaName)], 0);
  assert.equal(balanceAssets.totals[balance.headers.indexOf(alphaName)], 60);
  assert.equal(balanceAssets.totals[balance.headers.indexOf(betaName)], 0);
  assert.equal(analyticPnl.headers.includes('Grouped alpha'), true);
  assert.equal(analyticPnl.headers.includes('Grouped beta'), false);
  assert.equal(analyticPnl.sections.find((section) => section.title === 'Revenue').totals[0], 60);
  assert.equal(analyticBalance.sections.find((section) => section.title === 'Assets').totals[0], 60);
});

test('Qodo 61: an advance for another analytic account does not enter filtered cash flow', () => {
  let db = seed();
  const selected = create(db, 'account.analytic.account', { name: 'Selected advance scope' }); db = selected.db;
  const assignedElsewhere = create(db, 'account.analytic.account', { name: 'Other advance scope' }); db = assignedElsewhere.db;
  const journal = search(db, 'account.journal').find((item) => item.code === 'MISC');
  const cash = byType(db, 'asset_cash');
  const payable = byType(db, 'liability_payable');
  const expense = byType(db, 'expense');
  const documentId = nextId(db, 'account.move');
  const paymentMoveId = documentId + 1;
  const document = {
    id: documentId, name: 'INV/2040/ADVANCE', move_type: 'in_invoice', state: 'posted', company_id: 1,
    journal_id: journal.id, invoice_date: '2040-10-01', date: '2040-10-01', partner_id: 2,
    currency_id: read(db, 'res.company', 1).currency_id, amount_total: 100,
    line_ids: [
      { account_id: expense.id, debit: 100, credit: 0, partner_id: 2, analytic_distribution: { [assignedElsewhere.id]: 100 } },
      { account_id: payable.id, debit: 0, credit: 100, partner_id: 2 },
    ],
    payments: [{ move_id: paymentMoveId, date: '2040-10-03', amount: 100, company_amount: 100 }],
  };
  const payment = {
    id: paymentMoveId, name: 'PAY/2040/ADVANCE', move_type: 'entry', state: 'posted', company_id: 1,
    journal_id: journal.id, invoice_date: '2040-10-02', date: '2040-10-02', partner_id: 2,
    line_ids: [
      { account_id: cash.id, debit: 0, credit: 100, partner_id: 2 },
      { account_id: payable.id, debit: 100, credit: 0, partner_id: 2 },
    ],
  };
  db = appendRecord(db, 'account.move', document);
  db = appendRecord(db, 'account.move', payment);

  const flow = cashFlow(db, { from: '2040-10-03', to: '2040-10-03', analyticAccountIds: [selected.id] });
  assert.deepEqual([flow.operating, flow.investing, flow.financing, flow.net, flow.closing], [0, 0, 0, 0, 0]);
});

test('Qodo 50: journal audit separates unidentified taxes by their explicit names', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((item) => item.code === 'MISC');
  const move = {
    id: nextId(db, 'account.move'), name: 'MISC/2040/TAX', move_type: 'out_invoice', state: 'posted',
    company_id: 1, journal_id: journal.id, date: '2040-11-10', invoice_date: '2040-11-10', line_ids: [
      { account_id: byType(db, 'income').id, credit: 7, debit: 0, tax_id: null, tax_name: 'Historical VAT', tax_base: 100 },
      { account_id: byType(db, 'income').id, credit: 0, debit: 0, tax_id: null, tax_name: 'Zero-rated sales', tax_base: 50, tax_zero: true },
      { account_id: byType(db, 'income').id, credit: 5, debit: 0, tax_id: null, tax_name: 'Plain percentage tax', tax_base: 25 },
    ],
  };
  db = appendRecord(db, 'account.move', move);
  const taxes = journalAudit(db, { from: '2040-11-01', to: '2040-11-30' })
    .find((group) => group.journal.id === journal.id).taxes;

  assert.deepEqual(taxes.map((tax) => tax.name).sort(), ['Historical VAT', 'Plain percentage tax', 'Zero-rated sales']);
  assert.equal(taxes.length, 3);
});

test('Qodo 46: balance sheet earnings metadata follows the requested company', () => {
  let db = seed();
  db = { ...db, settings: { ...db.settings, current_company_id: 1 } };
  const company = createCompany(db, { name: 'Report branch', ...invoiceJournalDefaults(db) }); db = company.db;
  const earnings = create(db, 'account.account', {
    name: 'Branch current-year earnings', code: 'BR-EARN', account_type: 'equity', company_id: company.id,
  });
  db = write(earnings.db, 'res.company', company.id, { current_year_earnings_account_id: earnings.id });
  db = setCompanies(db, { current: 1, allowed: [1, company.id] });

  const report = balanceSheet(db, { to: '2040-12-31', company_id: company.id });
  assert.equal(db.settings.current_company_id, 1);
  assert.equal(report.earningsAccount.id, earnings.id);
  assert.equal(report.earningsAccount.company_id, company.id);
});
