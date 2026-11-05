import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { payMove, postMove } from './models/accounting.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { register } from 'node:module';
import { fromCsv } from './csv.js';
import { approveSheet, createSheet, postSheet, submitSheet } from './models/expenseplus.js';
import { applyDiff, diffDb } from './sync.js';
import { accountingCompany } from './test-support/accounting-company.js';
import { receive } from './models/valuation.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('stock receipt uses a shared category valuation account for another company', () => {
  const branch = accountingCompany(seed());
  const shared = create(branch.db, 'account.account', { name: 'Shared valuation', code: 'TEST-SHARED-STOCK', account_type: 'asset_current', company_id: null });
  const input = create(shared.db, 'account.account', { name: 'Branch stock input', code: 'TEST-BRANCH-INPUT', account_type: 'asset_current', company_id: branch.id });
  const category = create(input.db, 'product.category', { name: 'Shared stock category', company_id: branch.id, property_stock_valuation_account_id: shared.id, property_stock_account_input_categ_id: input.id });
  const product = create(category.db, 'product', { name: 'Stock item', type: 'goods', company_id: branch.id, categ_id: category.id, cost: 10, qty_available: 0, cost_method: 'fifo', valuation: 'real_time' });
  const db = write(product.db, 'res.company', branch.id, { account_stock_valuation_id: null });
  assert.equal(read(db, 'account.account', shared.id).company_id, null);
  const archived = write(db, 'account.account', shared.id, { active: false });
  assert.throws(() => receive(archived, product.id, 2, 10, { date: '2026-06-01', company_id: branch.id }), /archived/);
  const foreign = create(db, 'account.account', { name: 'Other company valuation', code: 'TEST-FOREIGN-STOCK', account_type: 'asset_current', company_id: 1 });
  const foreignCategory = write(foreign.db, 'product.category', category.id, { property_stock_valuation_account_id: foreign.id });
  assert.throws(() => receive(foreignCategory, product.id, 2, 10, { date: '2026-06-01', company_id: branch.id }), /Configure the stock valuation account/);
  const posted = receive(db, product.id, 2, 10, { date: '2026-06-01', company_id: branch.id });
  const layer = search(posted, 'stock.valuation.layer').find((row) => row.product_id === product.id);
  const move = read(posted, 'account.move', layer.move_id);
  assert.ok(move.line_ids.some((line) => line.account_id === shared.id && line.debit === 20));
  assert.ok(move.line_ids.some((line) => line.account_id === input.id && line.credit === 20));
});

test('cash basis payment releases accountless tax rows to each invoice line account', () => {
  let db = seed();
  const transition = create(db, 'account.account', { name: 'Transition', code: 'TEST-TRANS', account_type: 'liability_current', company_id: 1 });
  db = transition.db;
  const income = create(db, 'account.account', { name: 'Income', code: 'TEST-INCOME', account_type: 'income', company_id: 1 });
  db = income.db;
  const tax = create(db, 'account.tax', { name: 'Cash tax', company_id: 1, type_tax_use: 'sale', amount: 10, tax_exigibility: 'on_payment', cash_basis_transition_account_id: transition.id, ...defaultTaxRepartitionLines(null) });
  const draft = create(tax.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: '2037-01-01', invoice_line_ids: [{ account_id: income.id, qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
  db = postMove(draft.db, draft.id);
  assert.equal(read(db, 'account.move', draft.id).line_ids.find((line) => line.account_id === transition.id).credit, 10);
  db = payMove(db, draft.id, 110, '2037-01-02');
  const release = search(db, 'account.move').find((move) => move.cash_basis_origin_move_id === draft.id);
  assert.equal(release.line_ids.find((line) => line.account_id === transition.id).debit, 10);
  assert.equal(release.line_ids.find((line) => line.account_id === income.id).credit, 10);
});

test('employee-paid expense report uses the default general journal without a purchase journal', () => {
  let db = seed();
  const company = read(db, 'res.company', 1);
  const account = create(db, 'account.account', { name: 'Expense account', code: 'TEST-EXPENSE', account_type: 'expense', company_id: 1 });
  db = write(account.db, 'account.journal', company.default_general_journal_id, { default_account_id: account.id });
  db = write(db, 'res.company', 1, { default_purchase_journal_id: null });
  const expense = create(db, 'hr.expense', { name: 'Travel', employee_id: 2, company_id: 1, date: '2026-06-01', total_amount: 100, tax: 0, payment_mode: 'own_account' });
  const report = createSheet(expense.db, [expense.id]);
  const submitted = submitSheet(report.db, report.id);
  const approved = approveSheet(submitted, report.id, read(submitted, 'hr.expense.sheet', report.id).manager_id || 1);
  const posted = postSheet(approved, report.id, '2026-06-01');
  const sheet = read(posted, 'hr.expense.sheet', report.id);
  const move = read(posted, 'account.move', sheet.move_id);
  assert.equal(move.journal_id, company.default_general_journal_id);
  assert.ok(move.line_ids.some((line) => line.account_id === account.id && line.debit === 100));
  assert.equal(sheet.state, 'post');
  assert.doesNotThrow(() => applyDiff(approved, diffDb(approved, posted), { isAdmin: true }));
});

test('list CSV exports negative monetary values as numbers and escapes minus-prefixed text', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { initStore, commit } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_namespace, tag) => makeEl(tag);
  globalThis.document.createElement = (tag) => Object.assign(makeEl(tag), { click() {} });
  await initStore();
  const draft = create(seed(), 'account.move', { name: '-HYPERLINK("evil")', move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_line_ids: [{ qty: 1, price_unit: -250 }] });
  await commit(draft.db);
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);
  let blob;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (value) => { blob = value; return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  try {
    await React.act(async () => root.render(React.createElement(ActionView, { leaf: { model: 'account.move', view: 'list' }, base: '#/test', params: new URLSearchParams() })));
    const button = find(host, (node) => node.tagName === 'BUTTON' && node.textContent.includes('Export'));
    assert.ok(button);
    const props = button[Object.keys(button).find((key) => key.startsWith('__reactProps$'))];
    props.onClick();
    const rows = fromCsv(await blob.text());
    const row = rows.find((cells) => cells[0] === "'-HYPERLINK(\"evil\")");
    assert.ok(row, 'formula-like text remains escaped');
    assert.equal(row[rows[0].indexOf('Total')], '-250');
  } finally {
    await React.act(async () => root.unmount());
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
