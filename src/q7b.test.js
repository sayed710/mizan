import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write, updateSettings } from './orm.js';
import './models/index.js';
import { seed } from './seed.js';
import { balanceSheet, postEntry } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { today } from './models/common.js';
import { ensureReturnTypes, payReturn, reviewReturn, submitReturn } from './models/taxreturn.js';
import { balanceAnalyticColumns, pnlAnalyticColumns } from './views/reportCompare.js';
import { changeFormValue } from './views/formDefaults.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

test('grouped balance sheets include prior-period opening balances and sum to the ungrouped closing balance', () => {
  let db = seed();
  const a1 = create(db, 'account.analytic.account', { name: 'Alpha', code: 'ALP', plan: 'project' });
  db = a1.db;
  const a2 = create(db, 'account.analytic.account', { name: 'Beta', code: 'BET', plan: 'project' });
  db = a2.db;

  // Prior-period entry before the selected period's start date
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2024-06-15',
    lines: [
      { account: '101401', debit: 500, analytic_distribution: { [a1.id]: 100 } },
      { account: '301000', credit: 500, analytic_distribution: { [a1.id]: 100 } },
    ],
  }).db;

  // Current-period entry inside [from, to]
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-03-10',
    lines: [
      { account: '101401', debit: 200, analytic_distribution: { [a2.id]: 100 } },
      { account: '400000', credit: 200, analytic_distribution: { [a2.id]: 100 } },
    ],
  }).db;

  const group = create(db, 'account.report.horizontal.group', {
    name: 'Project Split',
    company_id: 1,
    rule_ids: [{ field: 'analytic', ids: `${a1.id},${a2.id}` }],
  });
  db = group.db;

  const period = { from: '2026-03-01', to: '2026-03-31' };
  const grouped = balanceAnalyticColumns(db, read(db, 'account.report.horizontal.group', group.id), period);
  const ungrouped = balanceSheet(db, period.to);

  assert.deepEqual(grouped.headers, ['Alpha', 'Beta', 'Others']);
  const alphaAssets = grouped.totals.find((t) => t.label === 'Total Assets').values[0];
  assert.equal(alphaAssets, 500, 'Alpha column retains opening asset balance from prior period');

  for (const [label, expected] of [
    ['Total Assets', ungrouped.totalAssets],
    ['Liabilities + Equity', Math.round((ungrouped.totalLiabilities + ungrouped.totalEquity) * 100) / 100],
  ]) {
    const row = grouped.totals.find((t) => t.label === label);
    const sum = Math.round(row.values.reduce((s, v) => s + v, 0) * 100) / 100;
    assert.equal(sum, expected, `${label} across grouped columns equals ungrouped balance sheet`);
  }
});

test('tax-unit returns settle each member company obligation with its own payment and configured accounts', () => {
  let db = seed();
  const sub = createCompanyWithDefaultInvoiceJournals(db, { name: 'Subsidiary Co' });
  db = sub.db;
  db = create(db, 'res.partner.bank', { partner_id: 1, account_number: 'MAIN-TAX-BANK' }).db;
  const subCompany = read(db, 'res.company', sub.id);
  db = create(db, 'res.partner.bank', { partner_id: subCompany.partner_id, account_number: 'SUB-TAX-BANK' }).db;

  // Give each company distinct configured tax payable/receivable accounts
  const mainPayable = create(db, 'account.account', { code: '251100', name: 'Main Tax Payable', account_type: 'liability_current', company_id: 1 });
  db = mainPayable.db;
  const mainReceivable = create(db, 'account.account', { code: '131100', name: 'Main Tax Receivable', account_type: 'asset_current', company_id: 1 });
  db = mainReceivable.db;
  const subPayable = create(db, 'account.account', { code: '251200', name: 'Sub Tax Payable', account_type: 'liability_current', company_id: sub.id });
  db = subPayable.db;
  const subReceivable = create(db, 'account.account', { code: '131200', name: 'Sub Tax Receivable', account_type: 'asset_current', company_id: sub.id });
  db = subReceivable.db;

  db = ensureReturnTypes(db);
  const mainType = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  const subType = search(db, 'account.return.type').find((t) => t.company_id === sub.id && t.name === 'VAT Return');
  db = write(db, 'account.return.type', mainType.id, {
    tax_payable_account_id: mainPayable.id,
    tax_receivable_account_id: mainReceivable.id,
    payment_partner_id: 1,
  });
  db = write(db, 'account.return.type', subType.id, {
    name: 'Subsidiary VAT Filing',
    tax_payable_account_id: subPayable.id,
    tax_receivable_account_id: subReceivable.id,
    payment_partner_id: subCompany.partner_id,
  });
  // A same-name company type must not override the explicit unit mapping.
  db = create(db, 'account.return.type', { name: mainType.name, company_id: sub.id }).db;

  const unit = create(db, 'account.tax.unit', {
    name: 'Group VAT Unit',
    company_ids: [1, sub.id],
    main_company_id: 1,
    member_return_type_ids: [{ company_id: sub.id, type_id: subType.id }],
  });
  db = unit.db;

  const saleTax = search(db, 'account.tax').find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const purchaseTax = search(db, 'account.tax').find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'purchase');

  // Company 1 has output tax of +28 (sale of 200)
  const inv1 = create(db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2025-05-10',
    invoice_line_ids: [{ qty: 1, price_unit: 200, ...taxSnapshot(saleTax) }],
  });
  db = postMove(inv1.db, inv1.id);

  // Subsidiary has input tax of -14 (purchase of 100 -> opposite-signed refund obligation)
  const bill2 = create(db, 'account.move', {
    company_id: sub.id,
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2025-05-12',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(purchaseTax) }],
  });
  db = postMove(bill2.db, bill2.id);

  const ret = create(db, 'account.return', {
    name: 'Unit VAT May 2025',
    type_id: mainType.id,
    company_id: 1,
    tax_unit_id: unit.id,
    date_from: '2025-05-01',
    date_to: '2025-05-31',
  });
  db = ret.db;

  db = reviewReturn(db, ret.id);
  db = submitReturn(db, ret.id);
  const submitted = read(db, 'account.return', ret.id);
  assert.equal(submitted.total_amount_to_pay, 14);
  assert.equal(submitted.closing_move_ids.length, 2);

  db = payReturn(db, ret.id);
  const paid = read(db, 'account.return', ret.id);
  assert.equal(paid.state, 'paid');
  assert.equal(paid.is_completed, true);
  assert.equal(paid.payment_ids.length, 2);

  const payMain = paid.payment_ids.map((id) => read(db, 'account.payment', id)).find((p) => p.company_id === 1);
  const paySub = paid.payment_ids.map((id) => read(db, 'account.payment', id)).find((p) => p.company_id === sub.id);
  assert.equal(payMain.payment_type, 'outbound');
  assert.equal(payMain.amount, 28);
  assert.equal(payMain.destination_account_id, mainPayable.id);
  assert.equal(payMain.state, 'posted');

  assert.equal(paySub.payment_type, 'inbound');
  assert.equal(paySub.amount, 14);
  assert.equal(paySub.destination_account_id, subReceivable.id);
  assert.equal(paySub.state, 'posted');

  for (const moveId of paid.closing_move_ids) {
    const move = read(db, 'account.move', moveId);
    assert.equal(move.payments?.length, 1);
    assert.equal(move.amount_paid, move.company_id === 1 ? 28 : 14);
  }
});

test('tax-unit submission fails explicitly when a member company is missing its required tax account configuration', () => {
  let db = seed();
  const sub = createCompanyWithDefaultInvoiceJournals(db, { name: 'Unconfigured Sub' });
  db = sub.db;
  db = ensureReturnTypes(db);

  const mainPayable = create(db, 'account.account', { code: '251901', name: 'Main Custom Payable', account_type: 'liability_current', company_id: 1 });
  db = mainPayable.db;
  const mainType = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  const subType = search(db, 'account.return.type').find((t) => t.company_id === sub.id && t.name === 'VAT Return');
  db = write(db, 'account.return.type', mainType.id, { tax_payable_account_id: mainPayable.id });
  // Clear the subsidiary's payable account configuration
  db = write(db, 'account.return.type', subType.id, { tax_payable_account_id: null });

  const unit = create(db, 'account.tax.unit', { name: 'Broken Unit', company_ids: [1, sub.id], main_company_id: 1 });
  db = unit.db;
  const saleTax = search(db, 'account.tax').find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const inv = create(db, 'account.move', {
    company_id: sub.id,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2040-06-10',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(saleTax) }],
  });
  db = postMove(inv.db, inv.id);

  const ret = create(db, 'account.return', {
    name: 'Unit VAT Jun 2040',
    type_id: mainType.id,
    company_id: 1,
    tax_unit_id: unit.id,
    date_from: '2040-06-01',
    date_to: '2040-06-30',
  });
  db = reviewReturn(ret.db, ret.id);
  assert.throws(() => submitReturn(db, ret.id), /Set the tax return type for Unconfigured Sub on the tax unit/);

  const memberAuditType = create(db, 'account.return.type', {
    name: 'Subsidiary Audit Filing',
    category: 'audit',
    company_id: sub.id,
  });
  db = memberAuditType.db;
  assert.throws(() => write(db, 'account.tax.unit', unit.id, {
    member_return_type_ids: [{ company_id: sub.id, type_id: mainType.id }],
  }), /Tax return type must belong to Unconfigured Sub/);
  assert.throws(() => write(db, 'account.tax.unit', unit.id, {
    member_return_type_ids: [{ company_id: sub.id, type_id: memberAuditType.id }],
  }), /must match the main return type category/);
  db = write(db, 'account.tax.unit', unit.id, {
    member_return_type_ids: [{ company_id: sub.id, type_id: subType.id }],
  });
  assert.throws(() => submitReturn(db, ret.id), /Missing tax payable account configuration/);
});

test('horizontal group reports exclude entries from other allowed companies and omit false variance columns', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const other = createCompanyWithDefaultInvoiceJournals(db, { name: 'Sister Firm', currency_id: db.records['res.company'][0].currency_id });
  db = updateSettings(other.db, { current_company_id: 1, allowed_company_ids: [1, other.id] });

  const a1 = create(db, 'account.analytic.account', { name: 'Main Project', code: 'MP', plan: 'project' });
  db = a1.db;
  const date = `${today().slice(0, 4)}-02-15`;
  const period = { from: `${today().slice(0, 4)}-01-01`, to: `${today().slice(0, 4)}-12-31` };

  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date,
    lines: [
      { account: '101401', debit: 400, analytic_distribution: { [a1.id]: 100 } },
      { account: '400000', credit: 400, analytic_distribution: { [a1.id]: 100 } },
    ],
  }).db;

  // Post a large entry in Sister Firm that should not leak into Company 1's horizontal group
  db = postEntry(db, {
    journal: 'MISC',
    company: other.id,
    date,
    lines: [
      { account: '101401', debit: 9000 },
      { account: '400000', credit: 9000 },
    ],
  }).db;

  const group = create(db, 'account.report.horizontal.group', {
    name: 'Main Analytic Group',
    company_id: 1,
    rule_ids: [{ field: 'analytic', ids: String(a1.id) }],
  });
  db = group.db;

  const groupRec = read(db, 'account.report.horizontal.group', group.id);
  const pnl = pnlAnalyticColumns(db, groupRec, period);
  const bs = balanceAnalyticColumns(db, groupRec, period);

  assert.equal(pnl.variance, null);
  assert.equal(bs.variance, null);
  const revOthers = pnl.sections.find((s) => s.title === 'Revenue').totals[1];
  assert.equal(revOthers, 8400, 'Sister Firm revenue of 9000 is excluded from Company 1 horizontal group');

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'pnl', label: 'Profit and Loss' } }));
    });
    const groupSelect = find(host, (node) => node.tagName === 'SELECT' && props(node)?.['aria-label'] === 'Horizontal Group');
    assert.ok(groupSelect, 'Horizontal Group selector is rendered');
    await React.act(async () => {
      props(groupSelect).onChange({ target: { value: String(group.id) } });
    });
    const headers = [];
    const collectTh = (node) => {
      if (node.tagName === 'TH') headers.push(node.textContent);
      for (const child of node.childNodes ?? []) collectTh(child);
    };
    collectTh(host);
    assert.ok(headers.includes('Main Project'));
    assert.ok(!headers.includes('Variance'), 'Horizontal group report omits Variance header');
    assert.ok(!headers.includes('%'), 'Horizontal group report omits % header');

    const revRow = find(host, (node) => node.tagName === 'TR' && node.textContent.includes('Revenue'));
    await React.act(async () => props(revRow).onClick());
    const detailRow = find(host, (node) => node.tagName === 'TR' && props(node)?.className === 'rep-detail');
    assert.ok(detailRow);
    assert.equal(detailRow.childNodes.length, 1 + pnl.headers.length, 'Detail row has no extra variance cells');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('SalesReview computes discounted and tax-included untaxed amounts for both review variants', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  // Order 1: delivered > invoiced (for invoicesToBeIssued), 2 units @ 100 with 10% discount -> 1 unit outstanding = 90.00
  const order1 = create(db, 'sale.order', {
    partner_id: 1,
    state: 'sale',
    order_line: [
      { product_id: 1, name: 'Discounted Widget', qty: 2, qty_delivered: 2, qty_invoiced: 1, price_unit: 100, discount: 10, tax: 14 },
    ],
  });
  db = order1.db;

  // Order 2: invoiced > delivered (for invoicedNotDelivered), 1 unit @ 114 tax-included (14%) with 10% discount -> 90.00 untaxed
  const order2 = create(db, 'sale.order', {
    partner_id: 1,
    state: 'sale',
    order_line: [
      { product_id: 1, name: 'TaxInc Discounted Service', qty: 1, qty_delivered: 0, qty_invoiced: 1, price_unit: 114, discount: 10, tax: 14, tax_include: true },
    ],
  });
  db = order2.db;

  await React.act(async () => commit(db));
  const { SalesReview } = await import('./views/SalesReview.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(SalesReview, { leaf: { report: 'invoicesToBeIssued', label: 'Invoices to be Issued' } }));
    });
    const row1 = find(host, (node) => node.tagName === 'TR' && node.textContent.includes('Discounted Widget'));
    assert.ok(row1, 'Discounted line appears in Invoices to be Issued');
    assert.equal(row1.childNodes[8].textContent, '$90.00');

    await React.act(async () => {
      root.render(React.createElement(SalesReview, { leaf: { report: 'invoicedNotDelivered', label: 'Invoiced Not Delivered' } }));
    });
    const row2 = find(host, (node) => node.tagName === 'TR' && node.textContent.includes('TaxInc Discounted Service'));
    assert.ok(row2, 'Tax-included discounted line appears in Invoiced Not Delivered');
    assert.equal(row2.childNodes[8].textContent, '$90.00');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('changing a draft return company outside its tax unit clears tax_unit_id and does not crash FormView', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const sub = createCompanyWithDefaultInvoiceJournals(db, { name: 'Unit Member' });
  const outsider = createCompanyWithDefaultInvoiceJournals(sub.db, { name: 'Outside Company' });
  db = ensureReturnTypes(outsider.db);
  db = updateSettings(db, { current_company_id: 1, allowed_company_ids: [1, sub.id, outsider.id] });

  const unit = create(db, 'account.tax.unit', { name: 'Pair Unit', company_ids: [1, sub.id], main_company_id: 1 });
  db = unit.db;
  const type = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  const ret = create(db, 'account.return', {
    name: 'Draft Unit Return',
    type_id: type.id,
    company_id: 1,
    tax_unit_id: unit.id,
    date_from: '2040-07-01',
    date_to: '2040-07-31',
  });
  db = ret.db;

  const baseRec = read(db, 'account.return', ret.id);
  const changed = changeFormValue('account.return', baseRec, {}, 'company_id', outsider.id, db);
  assert.equal(changed.tax_unit_id, null, 'onchange clears tax_unit_id when company changes outside the unit');

  await React.act(async () => commit(db));
  const { FormView } = await import('./views/FormView.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(FormView, {
        id: String(ret.id),
        base: '#/accounting/tax-returns',
        params: new URLSearchParams(),
        leaf: { model: 'account.return', label: 'Tax Returns' },
      }));
    });
    const companySelect = find(host, (node) => node.tagName === 'SELECT' && props(node)?.id === 'f-company_id');
    assert.ok(companySelect, 'company_id select is rendered');
    await React.act(async () => {
      props(companySelect).onChange({ target: { value: String(outsider.id) } });
    });
    assert.ok(host.textContent.includes('Tax Report'), 'FormView remains mounted after selecting a company outside the tax unit');
  } finally {
    await React.act(async () => root.unmount());
  }
});
