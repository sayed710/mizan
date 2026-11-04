import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postEntry, balanceSheet } from './models/ledger.js';
import { today } from './models/common.js';
import { pnlAnalyticColumns, balanceAnalyticColumns } from './views/reportCompare.js';
import { closingModels } from './models/closing.js';
import { trialBalance } from './models/reports.js';
import { postMove } from './models/accounting.js';
import { models } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const rendered = async (React, container, text) => {
  for (let i = 0; i < 200 && !container.textContent.includes(text); i++) {
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  }
};

test('multi-ledger selector limits journals to selected ledger on financial reports', async () => {
  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {}, HTMLIFrameElement: class {}, print() {} });
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const jGeneral = search(db, 'account.journal').find((j) => j.code === 'MISC');
  const jBank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const jSale = search(db, 'account.journal').find((j) => j.code === 'INV');

  // Create a multi-ledger group containing only MISC and BNK1 (excluding INV)
  const group = create(db, 'account.journal.group', {
    name: 'Treasury & Operations',
    company_id: 1,
    journal_ids: [jGeneral.id, jBank.id],
  });
  db = group.db;
  await commit(db);

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { label: 'Profit and Loss', report: 'pnl' } })));
    await rendered(React, host, 'Profit and Loss');

    // Find the Ledger select
    const selects = [];
    const collectSelects = (node) => {
      if (node.tagName === 'SELECT') selects.push(node);
      for (const child of node.childNodes ?? []) collectSelects(child);
    };
    collectSelects(host);

    const ledgerSelect = selects.find((s) => props(s)?.['aria-label'] === 'Ledger');
    assert.ok(ledgerSelect, 'Ledger selector exists on financial report');

    // Initially, journal selector (or all journals) includes all journals
    const journalSelect = selects.find((s) => props(s)?.['aria-label'] === 'Journals' || props(s)?.['aria-label'] === 'Journal');
    assert.ok(journalSelect, 'Journal selector exists on financial report');
    const initialJournalOptions = journalSelect.childNodes.map((c) => c.textContent);
    assert.ok(initialJournalOptions.some((o) => o.includes(jSale.name) || o.includes(jSale.code)));

    // Select the multi-ledger group
    await React.act(async () => props(ledgerSelect).onChange({ target: { value: String(group.id) } }));

    // Now the journals dropdown must be limited to only journals in the selected ledger
    const filteredJournalOptions = journalSelect.childNodes.map((c) => c.textContent);
    assert.ok(filteredJournalOptions.some((o) => o.includes('Bank') || o.includes('BNK1')));
    assert.ok(filteredJournalOptions.some((o) => o.includes('Operations') || o.includes('MISC')));
    assert.ok(!filteredJournalOptions.some((o) => o.includes(jSale.name) || o.includes(jSale.code)), 'Excluded journal INV is not in the selector');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('horizontal grouping by analytic group provides comparison columns in financial reports', () => {
  let db = seed();
  const a1 = create(db, 'account.analytic.account', { name: 'Alpha Project' });
  const a2 = create(a1.db, 'account.analytic.account', { name: 'Beta Project' });
  db = a2.db;

  const date = `${today().slice(0, 4)}-05-10`;
  // Post revenue with analytic distribution: 60% Alpha, 40% Beta
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date,
    lines: [
      { account: '101401', debit: 1000 },
      { account: '400000', credit: 1000, analytic_distribution: { [a1.id]: 60, [a2.id]: 40 } },
    ],
  }).db;

  // Post expense with analytic distribution: 100% Alpha
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date,
    lines: [
      { account: '600000', debit: 300, analytic_distribution: { [a1.id]: 100 } },
      { account: '101401', credit: 300 },
    ],
  }).db;

  const hGroup = create(db, 'account.report.horizontal.group', {
    name: 'Projects Analytic Group',
    company_id: 1,
    rule_ids: [{ field: 'analytic', ids: `${a1.id},${a2.id}` }],
  });
  db = hGroup.db;

  const period = { from: `${today().slice(0, 4)}-01-01`, to: `${today().slice(0, 4)}-12-31` };
  const pnlData = pnlAnalyticColumns(db, read(db, 'account.report.horizontal.group', hGroup.id), period);

  assert.ok(pnlData, 'P&L analytic columns data returned');
  assert.deepEqual(pnlData.headers, ['Alpha Project', 'Beta Project', 'Others']);

  // Revenue section: Alpha = 600, Beta = 400, Others = 8400 (from unallocated seed entries)
  const revSection = pnlData.sections.find((s) => s.title === 'Revenue');
  assert.ok(revSection);
  assert.deepEqual(revSection.totals, [600, 400, 8400]);

  // Expenses section: Alpha = 300, Beta = 0, Others = 0
  const expSection = pnlData.sections.find((s) => s.title === 'Expenses');
  assert.ok(expSection);
  assert.deepEqual(expSection.totals, [300, 0, 0]);

  // Net income: Alpha = 300 (600 - 300), Beta = 400 (400 - 0), Others = 8400
  const netTotal = pnlData.totals.find((t) => t.label === 'Net Income');
  assert.ok(netTotal);
  assert.deepEqual(netTotal.values, [300, 400, 8400]);

  // Balance sheet analytic columns
  const bsData = balanceAnalyticColumns(db, read(db, 'account.report.horizontal.group', hGroup.id), period.to);
  assert.ok(bsData, 'Balance Sheet analytic columns data returned');
  assert.deepEqual(bsData.headers, ['Alpha Project', 'Beta Project', 'Others']);
  const whole = balanceSheet(db, period.to);
  const assets = bsData.totals.find((t) => t.label === 'Total Assets').values;
  assert.equal(Math.round(assets.reduce((s, v) => s + v, 0) * 100) / 100, whole.totalAssets, 'Bucket columns add up to the normal balance sheet');
});

test('fiscal year closing locks the year until reopened, carries forward retained earnings, and next year reports start from carried-forward balances', () => {
  let db = seed();
  const yearPeriod = { from: '2024-01-01', to: '2024-12-31' };
  const fy = create(db, 'account.fiscal.year', {
    name: 'FY 2024',
    company_id: 1,
    date_from: yearPeriod.from,
    date_to: yearPeriod.to,
  });
  db = fy.db;

  // Post 2024 income and expenses: Revenue = 1000, Expense = 250 -> Net = 750
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2024-06-15',
    lines: [
      { account: '101401', debit: 750 },
      { account: '400000', credit: 1000 },
      { account: '600000', debit: 250 },
    ],
  }).db;

  // Post entry in next year (2025): Revenue = 500, Bank = 500
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2025-03-10',
    lines: [
      { account: '101401', debit: 500 },
      { account: '400000', credit: 500 },
    ],
  }).db;

  // Close the fiscal year via button / action
  const closedDb = closingModels['account.fiscal.year'].form.buttons
    .find((b) => b.label === 'Close Year')
    .run(db, read(db, 'account.fiscal.year', fy.id)).db;

  // 1. Lock: the closed year rejects postings
  // Attempting to post a move in 2024 must fail due to lock
  assert.throws(() => postEntry(closedDb, {
    journal: 'MISC',
    company: 1,
    date: '2024-11-01',
    lines: [{ account: '101401', debit: 10 }, { account: '400000', credit: 10 }],
  }), /locked/i, 'Posting into the closed year is blocked');

  // 2. Reports for next year (2025) start from carried-forward balances:
  // Trial balance for 2025 (2025-01-01 to 2025-12-31):
  const nextYearTrial = trialBalance(closedDb, { from: '2025-01-01', to: '2025-12-31' });
  const retainedRow = nextYearTrial.rows.find((r) => r.account.code === '302000');
  assert.ok(retainedRow, 'Retained earnings row exists in next year trial balance');
  // Initial credit balance of 750 (credit > debit means credit is negative in initial or initial = -750)
  assert.equal(Math.abs(retainedRow.initial), 750, 'Retained earnings initial balance carries forward 750');

  // P&L account (400000) initial balance in 2025 must be 0 (prior year was closed into retained earnings)
  const revenueRow = nextYearTrial.rows.find((r) => r.account.code === '400000');
  assert.equal(revenueRow.initial, 0, 'Revenue opening balance for new fiscal year is 0');
  assert.equal(revenueRow.credit, 500, 'Revenue movement in 2025 is only 2025 movement');

  // Balance sheet at 2025-12-31:
  const bs2025 = balanceSheet(closedDb, '2025-12-31');
  const bsRetained = bs2025.equity.find((r) => r.account.code === '302000');
  assert.ok(bsRetained);
  assert.equal(bsRetained.balance, 750, 'Balance sheet equity carries forward retained earnings');
  assert.equal(bs2025.earnings, 500, 'Current year earnings is 500 from 2025');
  assert.equal(bs2025.totalAssets, bs2025.totalLiabilities + bs2025.totalEquity, 'Balance sheet balances');

  // 3. Reopening the fiscal year
  const reopenedDb = closingModels['account.fiscal.year'].form.buttons
    .find((b) => b.label === 'Reopen')
    .run(closedDb, read(closedDb, 'account.fiscal.year', fy.id)).db;

  assert.doesNotThrow(() => postEntry(reopenedDb, {
    journal: 'MISC', company: 1, date: '2024-11-01',
    lines: [{ account: '101401', debit: 10 }, { account: '400000', credit: 10 }],
  }), 'Posting into the year is allowed again after reopen');
  assert.equal(read(reopenedDb, 'account.fiscal.year', fy.id).state, 'open');
});

test('Invoiced Not Delivered and Invoices To Be Issued reports exclude cancelled orders, exclude down payments, and show difference amounts', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const prod = create(db, 'product', { name: 'Widget Pro', list_price: 50, type: 'goods', invoice_policy: 'delivery' });
  db = prod.db;

  // 1. Confirmed order with 10 units: 4 delivered, 2 invoiced -> Delivered not invoiced = 2 ($100)
  const o1 = create(db, 'sale.order', {
    name: 'SO-TEST-01',
    partner_id: 1,
    state: 'sale',
    order_line: [{ product_id: prod.id, name: 'Widget Pro', qty: 10, qty_delivered: 4, qty_invoiced: 2, price_unit: 50, tax: 0 }],
  });
  db = o1.db;

  // 2. Draft order with delivered > invoiced -> MUST BE EXCLUDED
  const oDraft = create(db, 'sale.order', {
    name: 'SO-DRAFT-01',
    partner_id: 1,
    state: 'draft',
    order_line: [{ product_id: prod.id, name: 'Widget Pro', qty: 10, qty_delivered: 5, qty_invoiced: 0, price_unit: 50, tax: 0 }],
  });
  db = oDraft.db;

  // 3. Cancelled order -> MUST BE EXCLUDED
  const oCancel = create(db, 'sale.order', {
    name: 'SO-CANCEL-01',
    partner_id: 1,
    state: 'cancel',
    order_line: [{ product_id: prod.id, name: 'Widget Pro', qty: 10, qty_delivered: 5, qty_invoiced: 0, price_unit: 50, tax: 0 }],
  });
  db = oCancel.db;

  // 4. Confirmed order with 10 units: 3 delivered, 7 invoiced -> Invoiced not delivered = 4 ($200)
  const o2 = create(db, 'sale.order', {
    name: 'SO-TEST-02',
    partner_id: 1,
    state: 'sale',
    order_line: [
      { product_id: prod.id, name: 'Widget Pro', qty: 10, qty_delivered: 3, qty_invoiced: 7, price_unit: 50, tax: 0 },
      { name: 'Down Payment', qty: 1, qty_delivered: 0, qty_invoiced: 1, price_unit: 50, down_payment_key: 'dp-123' },
    ],
  });
  db = o2.db;
  await commit(db);

  const { SalesReview } = await import('./views/SalesReview.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);

  try {
    // Render Invoices To Be Issued (delivered not invoiced)
    await React.act(async () => root.render(React.createElement(SalesReview, { leaf: { report: 'invoicesToBeIssued', label: 'Invoices To Be Issued' } })));
    await rendered(React, host, 'SO-TEST-01');

    assert.ok(host.textContent.includes('SO-TEST-01'), 'Confirmed order in Invoices To Be Issued');
    assert.ok(!host.textContent.includes('SO-CANCEL-01'), 'Cancelled order is excluded');
    assert.ok(host.textContent.includes('Unit Price') || host.textContent.includes('Amount'), 'Columns include Unit Price and Amount');

    // Render Invoiced Not Delivered
    await React.act(async () => root.render(React.createElement(SalesReview, { leaf: { report: 'invoicedNotDelivered', label: 'Invoiced Not Delivered' } })));
    await rendered(React, host, 'SO-TEST-02');

    assert.ok(host.textContent.includes('SO-TEST-02'), 'Confirmed order in Invoiced Not Delivered');
    assert.ok(!host.textContent.includes('dp-123') && !host.textContent.includes('Down Payment'), 'Down payment line is excluded');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('partial invoicing with down payments invoices delivered quantities only and deducts down payments', () => {
  let db = seed();
  const prod = create(db, 'product', { name: 'Oak Desk', list_price: 100, type: 'goods', invoice_policy: 'delivery' });
  db = prod.db;

  // Create confirmed sale order for 10 units @ 100 = 1000
  const order = create(db, 'sale.order', {
    name: 'SO-PARTIAL-01',
    partner_id: 1,
    state: 'sale',
    order_line: [{ product_id: prod.id, name: 'Oak Desk', qty: 10, qty_delivered: 0, qty_invoiced: 0, price_unit: 100, tax: 0 }],
  });
  db = order.db;

  // 1. Create a 40% down payment invoice ($400)
  const dpResult = models['sale.order'].form.buttons
    .find((b) => b.label === 'Down Payment')
    .run(db, read(db, 'sale.order', order.id), { method: 'percentage', amount: 40 });
  db = dpResult.db;

  const dpInvoice = search(db, 'account.move').find((m) => m.sale_id === order.id && m.move_type === 'out_invoice');
  assert.ok(dpInvoice, 'Down payment invoice created');
  assert.equal(dpInvoice.amount_total, 400);

  // Post the down payment invoice
  db = postMove(db, dpInvoice.id);
  assert.equal(read(db, 'account.move', dpInvoice.id).state, 'posted');

  // Verify order qty_invoiced is still 0
  const orderAfterDp = read(db, 'sale.order', order.id);
  assert.equal(orderAfterDp.order_line[0].qty_invoiced, 0);

  // 2. First partial delivery: 5 units delivered
  db = write(db, 'sale.order', order.id, {
    order_line: [{ ...orderAfterDp.order_line[0], qty_delivered: 5 }],
  });

  // Create regular invoice: must invoice delivered quantities only (5 units = $500) and deduct down payment ($400)
  const inv1Result = models['sale.order'].form.buttons
    .find((b) => b.label === 'Create Invoice')
    .run(db, read(db, 'sale.order', order.id), { method: 'regular' });
  db = inv1Result.db;

  const inv1 = search(db, 'account.move').find((m) => m.sale_id === order.id && m.id !== dpInvoice.id);
  assert.ok(inv1, 'Regular invoice created for partial delivery');

  // The regular invoice line must have qty = 5 (delivered quantity only)
  const productLine1 = inv1.invoice_line_ids.find((l) => l.product_id === prod.id);
  assert.equal(productLine1.qty, 5, 'Invoiced delivered quantity only (5 units)');

  // Down payment deduction line must exist deducting the $400 advance
  const dpDeductionLine1 = inv1.invoice_line_ids.find((l) => l.down_payment_key && Number(l.qty) < 0);
  assert.ok(dpDeductionLine1, 'Down payment deduction line exists');

  // Invoice total = $500 - $400 = $100
  assert.equal(inv1.amount_total, 100, 'Invoice total after down payment deduction is $100');

  // Post invoice 1
  db = postMove(db, inv1.id);
  assert.equal(read(db, 'account.move', inv1.id).state, 'posted');

  // Now order qty_invoiced is 5
  assert.equal(read(db, 'sale.order', order.id).order_line[0].qty_invoiced, 5);

  // 3. Second delivery: deliver remaining 5 units (total delivered = 10)
  db = write(db, 'sale.order', order.id, {
    order_line: [{ ...read(db, 'sale.order', order.id).order_line[0], qty_delivered: 10 }],
  });

  // Create invoice for second partial delivery
  const inv2Result = models['sale.order'].form.buttons
    .find((b) => b.label === 'Create Invoice')
    .run(db, read(db, 'sale.order', order.id), { method: 'regular' });
  db = inv2Result.db;

  const inv2 = search(db, 'account.move').find((m) => m.sale_id === order.id && m.id !== dpInvoice.id && m.id !== inv1.id);
  assert.ok(inv2, 'Second regular invoice created');

  const productLine2 = inv2.invoice_line_ids.find((l) => l.product_id === prod.id);
  assert.equal(productLine2.qty, 5, 'Invoiced remaining delivered quantity (5 units)');

  // No down payment deduction since $400 was already fully deducted on inv1
  const dpDeductionLine2 = inv2.invoice_line_ids.find((l) => l.down_payment_key && Number(l.qty) < 0);
  assert.ok(!dpDeductionLine2, 'No further down payment deducted');
  assert.equal(inv2.amount_total, 500, 'Second invoice total is $500');

  // Post invoice 2
  db = postMove(db, inv2.id);
  assert.equal(read(db, 'account.move', inv2.id).state, 'posted');
  assert.equal(read(db, 'sale.order', order.id).order_line[0].qty_invoiced, 10);
});

test('cash flow statement classifies accounts by tag activity, builds report sections, and dynamically shows/hides unclassified section', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { CashFlow } = await import('./views/FinanceReports.jsx');
  const { cashFlow, accountCashFlowActivity } = await import('./models/reports.js');
  await initStore();

  let db = seed();

  // Create tags with explicit cash_flow_activity
  const tagOp = create(db, 'account.account.tag', { name: 'Operations Flow', applicability: 'accounts', cash_flow_activity: 'operating' });
  const tagInv = create(tagOp.db, 'account.account.tag', { name: 'Investments Flow', applicability: 'accounts', cash_flow_activity: 'investing' });
  const tagFin = create(tagInv.db, 'account.account.tag', { name: 'Financing Flow', applicability: 'accounts', cash_flow_activity: 'financing' });
  db = tagFin.db;

  // Create accounts classified by tags
  const accRevenue = create(db, 'account.account', { code: '499001', name: 'Consulting Revenue', account_type: 'income', tag_ids: [tagOp.id] });
  const accAsset = create(accRevenue.db, 'account.account', { code: '159001', name: 'Special Machinery', account_type: 'asset_fixed', tag_ids: [tagInv.id] });
  const accLoan = create(accAsset.db, 'account.account', { code: '269001', name: 'Founder Loan', account_type: 'liability_current', tag_ids: [tagFin.id] });
  const accUntagged = create(accLoan.db, 'account.account', { code: '499002', name: 'Miscellaneous Mystery', account_type: 'income_other', tag_ids: [] });
  db = accUntagged.db;

  const cash = search(db, 'account.account').find((a) => a.code === '101401');

  // Verify initial classification
  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', accRevenue.id)), 'operating');
  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', accAsset.id)), 'investing');
  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', accLoan.id)), 'financing');
  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', accUntagged.id)), 'unclassified');

  const period = { from: '2027-05-01', to: '2027-05-31' };

  // Post cash transactions for each
  const post = (lines) => {
    const m = create(db, 'account.move', { move_type: 'entry', invoice_date: '2027-05-15', line_ids: lines });
    db = postMove(m.db, m.id);
  };

  // 1. Operating: Cash debit 500, Consulting Revenue credit 500 (+500 operating)
  post([{ account_id: cash.id, debit: 500, credit: 0 }, { account_id: accRevenue.id, debit: 0, credit: 500 }]);
  // 2. Investing: Cash credit 300, Special Machinery debit 300 (-300 investing)
  post([{ account_id: cash.id, debit: 0, credit: 300 }, { account_id: accAsset.id, debit: 300, credit: 0 }]);
  // 3. Financing: Cash debit 1000, Founder Loan credit 1000 (+1000 financing)
  post([{ account_id: cash.id, debit: 1000, credit: 0 }, { account_id: accLoan.id, debit: 0, credit: 1000 }]);
  // 4. Untagged: Cash debit 200, Mystery credit 200 (+200 unclassified)
  post([{ account_id: cash.id, debit: 200, credit: 0 }, { account_id: accUntagged.id, debit: 0, credit: 200 }]);

  const flowBefore = cashFlow(db, period);
  assert.equal(flowBefore.operating, 500, 'Operating cash flow matches');
  assert.equal(flowBefore.investing, -300, 'Investing cash flow matches');
  assert.equal(flowBefore.financing, 1000, 'Financing cash flow matches');
  assert.equal(flowBefore.unclassified, 200, 'Unclassified cash flow matches');
  assert.equal(flowBefore.net, 1400, 'Net change in cash matches');

  await commit(db);

  const host = makeEl('table');
  host.ownerDocument = document;
  const root = createRoot(host);

  try {
    // Render CashFlow component with unclassified item
    await React.act(async () => root.render(React.createElement(CashFlow, { db, period })));
    await rendered(React, host, 'Consulting Revenue');

    assert.ok(host.textContent.includes('Operating Activities'), 'Shows Operating Activities header');
    assert.ok(host.textContent.includes('Consulting Revenue'), 'Shows Consulting Revenue under Operating');
    assert.ok(host.textContent.includes('Investing Activities'), 'Shows Investing Activities header');
    assert.ok(host.textContent.includes('Special Machinery'), 'Shows Special Machinery under Investing');
    assert.ok(host.textContent.includes('Financing Activities'), 'Shows Financing Activities header');
    assert.ok(host.textContent.includes('Founder Loan'), 'Shows Founder Loan under Financing');
    assert.ok(host.textContent.includes('Unclassified'), 'Shows Unclassified section when untagged account exists');
    assert.ok(host.textContent.includes('Miscellaneous Mystery'), 'Shows untagged account name in Unclassified');

    // Now user classifies the untagged account by assigning the Operating tag
    db = write(db, 'account.account', accUntagged.id, { tag_ids: [tagOp.id] });
    assert.equal(accountCashFlowActivity(db, read(db, 'account.account', accUntagged.id)), 'operating');

    const flowAfter = cashFlow(db, period);
    assert.equal(flowAfter.operating, 700, 'Operating flow now includes 200 from newly tagged account');
    assert.equal(flowAfter.unclassified, 0, 'Unclassified flow is now 0');

    await commit(db);
    // Re-render CashFlow component
    await React.act(async () => root.render(React.createElement(CashFlow, { db, period })));
    await rendered(React, host, '700');

    // Unclassified section MUST NO LONGER APPEAR in the rendered report
    assert.ok(!host.textContent.includes('Unclassified'), 'Unclassified section is hidden when no unclassified flows exist');
    assert.ok(host.textContent.includes('Miscellaneous Mystery'), 'Miscellaneous Mystery is now under Operating');
  } finally {
    await React.act(async () => root.unmount());
  }
});
