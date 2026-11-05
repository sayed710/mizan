import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { accountId, balanceSheet } from './models/ledger.js';
import { total } from './models/common.js';
import { confirmAsset, depreciationReport, disposeAsset, postDepreciation } from './models/assets.js';
import { confirmLoan, loanModels } from './models/loans.js';
import { createCompany } from './models/company.js';
import { companyViewDb } from './companyView.js';
import { deliver, receive } from './models/valuation.js';
import { salesModels } from './models/sales.js';
import { executiveSummary } from './models/reports.js';
import { assetAccounts } from './test-support/asset-accounts.js';

const action = (db, model, id, label) => salesModels[model].form.buttons.find((button) => button.label === label).run(db, read(db, model, id)).db;
const force = (db, model, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => (r.id === id ? { ...r, ...vals } : r)) } });

test('Qodo 7: branch invoices preserve legacy company-1 payment term in restricted views for totals and installments', () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Branch 2', parent_id: 1, currency_id: read(db, 'res.company', 1).currency_id });
  db = branch.db;
  const income = create(db, 'account.account', { name: 'Branch Sales Inc', code: '400099', account_type: 'income', company_id: branch.id });
  db = income.db;
  const journal = create(db, 'account.journal', {
    name: 'Branch Sales',
    code: 'BSALE',
    type: 'sale',
    company_id: branch.id,
    default_account_id: income.id,
    invoice_sequence_prefix: 'BSALE/INV/',
    invoice_sequence_next_number: 1,
  });
  db = journal.db;
  const term = create(db, 'account.payment.term', {
    name: 'Company 1 Mixed Term',
    company_id: 1,
    discount_percentage: 2,
    discount_days: 10,
    line_ids: [{ value: 'balance', days: 30 }],
  });
  db = term.db;
  const invoice = create(db, 'account.move', {
    company_id: branch.id,
    journal_id: journal.id,
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invoice.db, invoice.id);
  // Simulate a legacy branch invoice referencing company-1 term before company validation
  db = force(db, 'account.move', invoice.id, { invoice_payment_term_id: term.id });
  const posted = read(db, 'account.move', invoice.id);
  const view = companyViewDb({ ...db, settings: { ...db.settings, current_company_id: branch.id, allowed_company_ids: [branch.id] } });

  assert.ok(read(view, 'account.payment.term', term.id), 'term is kept in companyViewDb');
  assert.equal(total(posted, view), total(posted, db), 'totals match between full and restricted views');
  assert.equal(total(posted, view), posted.amount_total);
});

test('Qodo 21: configured stock output account is used for delivery and return entries', () => {
  let db = seed();
  const outputAcc = create(db, 'account.account', { code: '110299', name: 'Custom Output Interim', account_type: 'asset_current', company_id: 1 });
  db = outputAcc.db;
  const cogsAcc = create(db, 'account.account', { code: '500099', name: 'Custom COGS', account_type: 'expense_direct_cost', company_id: 1 });
  db = cogsAcc.db;
  const categ = create(db, 'product.category', {
    name: 'Output Categ',
    property_stock_account_output_categ_id: outputAcc.id,
    property_account_expense_categ_id: cogsAcc.id,
  });
  db = categ.db;
  const product = create(db, 'product', {
    name: 'Output Goods',
    type: 'goods',
    categ_id: categ.id,
    cost: 15,
    cost_method: 'fifo',
    valuation: 'real_time',
    qty_available: 0,
  });
  db = product.db;
  db = receive(db, product.id, 5, 15, { date: '2026-04-01' });

  // 1. Direct delivery routes to output interim account
  const delivered = deliver(db, product.id, 2, { date: '2026-04-02' });
  db = delivered.db;
  const delivLayer = db.records['stock.valuation.layer'].find((l) => l.product_id === product.id && l.kind === 'out');
  const delivMove = read(db, 'account.move', delivLayer.move_id);
  assert.ok(delivMove.line_ids.some((l) => l.account_id === outputAcc.id && l.debit === 30), 'delivery debited output interim');
  assert.ok(!delivMove.line_ids.some((l) => l.account_id === cogsAcc.id), 'delivery did not debit cogs');

  // 2. Sale order delivery and customer return
  const sale = create(db, 'sale.order', { partner_id: 1, order_line: [{ product_id: product.id, qty: 1, price_unit: 50, tax: 0 }] });
  db = action(sale.db, 'sale.order', sale.id, 'Confirm');
  const pick = search(db, 'stock.picking').find((p) => p.sale_id === sale.id);
  db = action(db, 'stock.picking', pick.id, 'Validate');

  const beforeRet = db;
  db = action(db, 'stock.picking', pick.id, 'Return');
  const retPick = search(db, 'stock.picking').find((p) => p.return_of === pick.id);
  db = action(db, 'stock.picking', retPick.id, 'Validate');

  const newMoveIds = (db.records['account.move'] ?? []).filter((m) => !(beforeRet.records['account.move'] ?? []).some((old) => old.id === m.id)).map((m) => m.id);
  const retLines = (db.records['account.move'] ?? []).filter((m) => newMoveIds.includes(m.id)).flatMap((m) => m.line_ids ?? []);
  assert.ok(retLines.some((l) => l.account_id === outputAcc.id && l.credit === 15), 'return credited output interim');
});

test('Qodo 27: loan accounts cannot change once money is booked and fields are readonly when running', () => {
  let db = seed();
  const fields = {
    journal_id: search(db, 'account.journal').find((j) => j.code === 'BNK1').id,
    bank_account_id: accountId(db, '101401'),
    principal_account_id: accountId(db, '260000'),
    interest_account_id: accountId(db, '690400'),
  };
  const otherAcc = create(db, 'account.account', { code: '260999', name: 'Other liability', account_type: 'liability_current', company_id: 1 });
  db = otherAcc.db;

  const loan = create(db, 'account.loan', {
    name: 'Lock Test Loan',
    lender_id: 2,
    amount: 1000,
    start_date: '2026-01-01',
    duration: 6,
    interest_rate: 5,
    method: 'annuity',
    ...fields,
  });
  db = confirmLoan(loan.db, read(loan.db, 'account.loan', loan.id));
  const running = read(db, 'account.loan', loan.id);
  assert.equal(running.state, 'running');
  assert.ok(running.receipt_move_id);

  // Field definitions are readonly when state !== 'draft'
  const modelDef = loanModels['account.loan'];
  for (const f of ['journal_id', 'bank_account_id', 'principal_account_id', 'interest_account_id']) {
    assert.equal(modelDef.fields[f].readonly(running), true, `${f} is readonly when running`);
    assert.equal(modelDef.fields[f].readonly({ state: 'draft' }), false, `${f} is editable in draft`);
  }

  // Model guard rejects account/journal changes after money is booked
  assert.throws(
    () => write(db, 'account.loan', loan.id, { principal_account_id: otherAcc.id }),
    /Cannot change loan accounts or journal once money is booked/
  );
  assert.throws(
    () => write(db, 'account.loan', loan.id, { journal_id: search(db, 'account.journal').find((j) => j.code === 'MISC').id }),
    /Cannot change loan accounts or journal once money is booked/
  );
});

test('Qodo 28: depreciation report retains assets disposed within the reported period', () => {
  const base = seed();
  const created = create(base, 'account.asset', {
    ...assetAccounts(base),
    name: 'Disposed in period',
    acquisition_date: '2026-01-01',
    original_value: 1200,
    salvage_value: 0,
    method_number: 12,
    method_period: '1',
  });
  let db = confirmAsset(created.db, read(created.db, 'account.asset', created.id));
  db = postDepreciation(db, read(db, 'account.asset', created.id), '2026-02-28');
  db = disposeAsset(db, read(db, 'account.asset', created.id), { date: '2026-03-15' });

  const report = depreciationReport(db, { from: '2026-01-01', to: '2026-12-31' }, '1');
  const row = report.rows.find((r) => r.a.id === created.id);
  assert.ok(row, 'asset disposed in period is retained in the report');
  assert.ok(row.inPeriod > 0, 'inPeriod reflects depreciation posted in the period');
  assert.equal(row.book, 0, 'book value of disposed asset as of period end is 0');
  assert.equal(report.totals.inPeriod, report.rows.reduce((s, r) => s + r.inPeriod, 0));
});

test('Qodo 32: intercompany bill rejects purchase tax group containing another company tax', () => {
  let db = seed();
  const buyer = createCompany(db, { name: 'Buyer Co', currency_id: read(db, 'res.company', 1).currency_id, intercompany_rule: 'invoice_bill' });
  db = buyer.db;
  const buyerExpense = create(db, 'account.account', { name: 'Buyer exp', code: 'BEXP', account_type: 'expense', company_id: buyer.id });
  db = buyerExpense.db;
  const buyerJournal = create(db, 'account.journal', { name: 'Buyer pur', code: 'BPUR', type: 'purchase', company_id: buyer.id, default_account_id: buyerExpense.id });
  db = write(buyerJournal.db, 'res.company', buyer.id, { intercompany_journal_id: buyerJournal.id });

  // Company 1 child tax
  const comp1Tax = create(db, 'account.tax', { name: 'Comp1 Child Tax', type_tax_use: 'purchase', amount: 5, company_id: 1 });
  db = comp1Tax.db;
  // Group tax owned by buyer or unassigned, but containing comp1 child
  const groupTax = create(db, 'account.tax', {
    name: 'Buyer Group Tax with Foreign Child',
    type_tax_use: 'purchase',
    amount_type: 'group',
    company_id: buyer.id,
    children_tax_ids: [comp1Tax.id],
  });
  db = groupTax.db;

  const product = create(db, 'product', { name: 'Group Tax Goods', type: 'goods', supplier_tax_id: groupTax.id, property_account_expense_id: buyerExpense.id });
  db = product.db;

  const invoice = create(db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: read(db, 'res.company', buyer.id).partner_id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100, tax: 0 }],
  });

  assert.throws(
    () => postMove(invoice.db, invoice.id),
    /Configure purchase taxes for Buyer Co/
  );
});

test('Qodo 44: analytic balance sheet and executive summary balance with tagged income and untagged receivable', () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Project Alpha' });
  db = analytic.db;

  const invoice = create(db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 500, tax: 0, analytic_distribution: { [analytic.id]: 100 } }],
  });
  db = postMove(invoice.db, invoice.id);

  const bs = balanceSheet(db, '2026-05-31', { analyticAccountIds: [analytic.id] });
  assert.equal(bs.totalAssets, bs.totalLiabilities + bs.totalEquity, 'balance sheet balances Assets = Liabilities + Equity');
  assert.equal(bs.totalAssets, 500, 'assets include the receivable counterpart');
  assert.equal(bs.earnings, 500, 'earnings reflect tagged income');

  const exec = executiveSummary(db, { from: '2026-05-01', to: '2026-05-31', analyticAccountIds: [analytic.id] });
  assert.equal(exec.revenue, 500);
  assert.equal(exec.receivables, 500);
  assert.notEqual(exec.dso, null);
});

test('Qodo 49: changing locked tax unit main company gives distinct error from member return types', () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Branch 3', parent_id: 1, currency_id: read(db, 'res.company', 1).currency_id });
  db = branch.db;
  const unit = create(db, 'account.tax.unit', {
    name: 'Group Unit',
    main_company_id: 1,
    company_ids: [1, branch.id],
    country: 'US',
  });
  db = unit.db;
  const retType = search(db, 'account.return.type')[0];
  const ret = create(db, 'account.return', {
    name: 'Submitted Ret',
    type_id: retType.id,
    tax_unit_id: unit.id,
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-03-31',
  });
  db = force(ret.db, 'account.return', ret.id, { state: 'submitted' });

  assert.throws(
    () => write(db, 'account.tax.unit', unit.id, { main_company_id: branch.id }),
    /Cannot change main company of a tax unit with submitted returns/
  );
  assert.throws(
    () => write(db, 'account.tax.unit', unit.id, { member_return_type_ids: [{ company_id: branch.id, return_type_id: 1 }] }),
    /Cannot change member return types of a tax unit with submitted returns/
  );
});
