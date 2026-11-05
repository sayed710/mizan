import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import './models/index.js';
import { seed } from './seed.js';
import { postOperationCost } from './models/workorder.js';
import { closeSession, payOrder, priceLines, startSession } from './models/pos.js';
import { createSheet, submitSheet, approveSheet, postSheet } from './models/expenseplus.js';
import { receive, deliver } from './models/valuation.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';
import { models } from './models/index.js';

test('Qodo 20: branch operation costs capitalize stock in the order company', () => {
  let db = seed();
  const company2 = create(db, 'res.company', { name: 'Branch 2' });
  db = company2.db;
  const c2Id = company2.id;

  // Configure stock accounts on company 2
  const valuation = create(db, 'account.account', { code: '110199', name: 'Branch 2 Stock', account_type: 'asset_current', company_id: c2Id });
  const inputAcc = create(valuation.db, 'account.account', { code: '110299', name: 'Branch 2 Input', account_type: 'asset_current', company_id: c2Id });
  const production = create(inputAcc.db, 'account.account', { code: '600199', name: 'Branch 2 Production', account_type: 'expense', company_id: c2Id });
  const miscJournal = create(production.db, 'account.journal', { name: 'Branch 2 Misc', code: 'MISC2', type: 'general', company_id: c2Id });
  db = write(miscJournal.db, 'res.company', c2Id, {
    account_stock_valuation_id: valuation.id,
    account_stock_input_id: inputAcc.id,
    account_production_id: production.id,
    default_general_journal_id: miscJournal.id,
  });

  // Create finished product with stock received in company 2 only (company 1 has 0 stock)
  const finished = create(db, 'product', { name: 'Branch Finished', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  const bom = create(finished.db, 'mrp.bom', { name: 'Branch BOM', product_id: finished.id, product_qty: 1, components: [] });
  db = receive(bom.db, finished.id, 5, 10, { company_id: c2Id, date: '2026-10-01' });

  // Manufacturing order in company 2, already done
  const wc = create(db, 'mrp.workcenter', { name: 'Branch Assembly', costs_hour: 40 });
  const mo = create(wc.db, 'mrp.production', {
    name: 'MO/BRANCH/001',
    product_id: finished.id,
    bom_id: bom.id,
    product_qty: 1,
    state: 'done',
    company_id: c2Id,
  });
  const wo = create(mo.db, 'mrp.workorder', {
    name: 'Assembly op',
    production_id: mo.id,
    workcenter_id: wc.id,
    state: 'done',
    time_ids: [{ minutes: 60, date_start: '2026-10-25T08:00:00Z', date_end: '2026-10-25T09:00:00Z' }],
  });

  // Post operation cost while active company is 1 (default)
  db = postOperationCost(wo.db, mo.id);

  // The landed valuation layer must belong to company 2
  const landedLayer = search(db, 'stock.valuation.layer').find((l) => l.product_id === finished.id && l.kind === 'landed');
  assert.ok(landedLayer, 'Landed valuation layer was created');
  assert.equal(landedLayer.company_id, c2Id, 'Valuation layer must belong to the order company');
  assert.equal(landedLayer.value, 40);
});

test('Qodo 63: POS cash difference uses journal from used payment method even if archived', () => {
  let db = seed();
  const profit = create(db, 'account.account', { name: 'Cash Profit', code: '918001', account_type: 'income_other', company_id: 1 });
  const loss = create(profit.db, 'account.account', { name: 'Cash Loss', code: '918002', account_type: 'expense_other', company_id: 1 });
  const j1Acc = create(loss.db, 'account.account', { name: 'Drawer 1', code: '101411', account_type: 'asset_cash', company_id: 1 });
  const j2Acc = create(j1Acc.db, 'account.account', { name: 'Drawer 2', code: '101412', account_type: 'asset_cash', company_id: 1 });

  const j1 = create(j2Acc.db, 'account.journal', { name: 'Cash Register 1', code: 'CSH1', type: 'cash', company_id: 1, default_account_id: j1Acc.id, profit_account_id: profit.id, loss_account_id: loss.id });
  const j2 = create(j1.db, 'account.journal', { name: 'Cash Register 2', code: 'CSH2', type: 'cash', company_id: 1, default_account_id: j2Acc.id, profit_account_id: profit.id, loss_account_id: loss.id });

  const m1 = create(j2.db, 'pos.payment.method', { name: 'Cash 1', type: 'cash', journal_id: j1.id, company_id: 1 });
  const m2 = create(m1.db, 'pos.payment.method', { name: 'Cash 2', type: 'cash', journal_id: j2.id, company_id: 1 });

  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const config = create(m2.db, 'pos.config', { name: 'Multi Cash Register', company_id: 1, journal_id: saleJournal.id, payment_method_ids: [m1.id, m2.id] });
  const started = startSession(config.db, 0, config.id);
  db = started.db;

  const product = search(db, 'product').find((p) => p.type === 'goods' && (Number(p.list_price) || 0) > 0) || search(db, 'product')[0];

  // Pay order using method m1
  const orderOut = payOrder(db, {
    lines: priceLines(db, [{ product_id: product.id, qty: 1 }]),
    method: m1.id,
    config_id: config.id,
  });
  db = orderOut.db;

  // Archive method m1 before closing session; method m2 remains active and configured
  db = write(db, 'pos.payment.method', m1.id, { active: false });

  // Close session with cash difference
  const session = read(db, 'pos.session', started.id);
  const closed = closeSession(db, session, 5);

  const diffEntry = search(closed, 'account.move').find((m) => m.ref === `${session.name} cash difference`);
  assert.ok(diffEntry, 'Cash difference move was posted');
  assert.equal(diffEntry.journal_id, j1.id, 'Cash difference must adjust the journal of the method used in the session');
});

test('Qodo 64: NOT A BUG - standalone expenses honor selected tax_id and configured tax accounts', () => {
  let db = seed();
  const expenseAcc = create(db, 'account.account', { name: 'Claim Expense', code: '618001', account_type: 'expense', company_id: 1 });
  const taxAcc = create(expenseAcc.db, 'account.account', { name: 'Claim Input Tax', code: '131801', account_type: 'asset_current', company_id: 1 });
  const tax = create(taxAcc.db, 'account.tax', { name: '10% Purchase Tax', company_id: 1, type_tax_use: 'purchase', amount: 10, amount_type: 'percent', ...defaultTaxRepartitionLines(taxAcc.id) });
  const product = create(tax.db, 'product', { name: 'Claim Item', type: 'service', property_account_expense_id: expenseAcc.id });

  const claim = create(product.db, 'hr.expense', {
    name: 'Taxi Ride',
    employee_id: 2,
    product_id: product.id,
    tax_id: tax.id,
    tax: 10,
    total_amount: 110,
    state: 'approved',
    date: '2026-10-01',
  });

  const postBtn = models['hr.expense'].form.buttons.find((b) => b.label === 'Post Journal Entries');
  db = postBtn.run(claim.db, read(claim.db, 'hr.expense', claim.id)).db;

  const moveId = read(db, 'hr.expense', claim.id).move_id;
  const move = read(db, 'account.move', moveId);
  assert.ok(move.line_ids.some((l) => l.account_id === expenseAcc.id && l.debit === 100));
  assert.ok(move.line_ids.some((l) => l.account_id === taxAcc.id && l.debit === 10));
});

test('Qodo 65: employee-paid expense report posts to selected expense_journal_id', () => {
  let db = seed();
  const expenseAcc = create(db, 'account.account', { name: 'Report Expense', code: '618002', account_type: 'expense', company_id: 1 });
  const taxAcc = create(expenseAcc.db, 'account.account', { name: 'Report Tax', code: '131802', account_type: 'asset_current', company_id: 1 });
  const tax = create(taxAcc.db, 'account.tax', { name: '10% Tax', company_id: 1, type_tax_use: 'purchase', amount: 10, amount_type: 'percent', ...defaultTaxRepartitionLines(taxAcc.id) });
  const customJournal = create(tax.db, 'account.journal', { name: 'Travel Expenses', code: 'TRV', type: 'purchase', company_id: 1, default_account_id: expenseAcc.id });

  const expense = create(customJournal.db, 'hr.expense', {
    name: 'Conference ticket',
    employee_id: 2,
    total_amount: 110,
    tax: 10,
    tax_id: tax.id,
  });

  const report = createSheet(expense.db, [expense.id], { name: 'Conference Sheet' });
  db = write(report.db, 'hr.expense.sheet', report.id, { expense_journal_id: customJournal.id });
  db = submitSheet(db, report.id);
  db = approveSheet(db, report.id, read(db, 'hr.expense.sheet', report.id).manager_id || 1);
  db = postSheet(db, report.id, '2026-10-01');

  const moveId = read(db, 'hr.expense.sheet', report.id).move_id;
  const move = read(db, 'account.move', moveId);
  assert.equal(move.journal_id, customJournal.id, 'Move must be posted to the sheet expense_journal_id');
});

test('Qodo 66: NOT A BUG - stock delivery posts to configured COGS account', () => {
  let db = seed();
  const cogs = create(db, 'account.account', { code: '500199', name: 'Dedicated COGS', account_type: 'expense_direct_cost', company_id: 1 });
  const category = create(cogs.db, 'product.category', { name: 'Delivery Category', property_account_expense_categ_id: cogs.id });
  const product = create(category.db, 'product', { name: 'Delivery Item', type: 'goods', categ_id: category.id, cost: 25, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });

  db = receive(product.db, product.id, 2, 25, { date: '2026-10-01' });
  db = deliver(db, product.id, 1, { date: '2026-10-01' }).db;

  const deliveryLayer = search(db, 'stock.valuation.layer').find((l) => l.product_id === product.id && l.kind === 'out');
  const move = read(db, 'account.move', deliveryLayer.move_id);
  assert.ok(move.line_ids.some((line) => line.account_id === cogs.id && line.debit === 25));
});

test('Qodo 67: product-level property_stock_valuation_account_id is used for valuation entries', () => {
  let db = seed();
  const categValuation = create(db, 'account.account', { code: '110191', name: 'Category Stock', account_type: 'asset_current', company_id: 1 });
  const productValuation = create(categValuation.db, 'account.account', { code: '110192', name: 'Product Stock', account_type: 'asset_current', company_id: 1 });
  const inputAcc = create(productValuation.db, 'account.account', { code: '110291', name: 'Custom Input', account_type: 'asset_current', company_id: 1 });

  const category = create(inputAcc.db, 'product.category', {
    name: 'Widgets',
    property_stock_valuation_account_id: categValuation.id,
    property_stock_account_input_categ_id: inputAcc.id,
  });

  const product = create(category.db, 'product', {
    name: 'Special Widget',
    type: 'goods',
    categ_id: category.id,
    cost: 15,
    cost_method: 'fifo',
    valuation: 'real_time',
    qty_available: 0,
    property_stock_valuation_account_id: productValuation.id,
  });

  db = receive(product.db, product.id, 2, 15, { date: '2026-10-01' });

  const layer = search(db, 'stock.valuation.layer').find((l) => l.product_id === product.id && l.kind === 'in');
  const move = read(db, 'account.move', layer.move_id);
  assert.ok(move.line_ids.some((line) => line.account_id === productValuation.id && line.debit === 30),
    'Valuation entry must use product-level valuation account, not category valuation account');
});

test('Qodo 68: NOT A BUG - POS stock return uses configured company COGS account with custom code', () => {
  let db = seed();
  const customCogs = create(db, 'account.account', { name: 'Nonstandard COGS', code: '998877', account_type: 'expense_direct_cost', company_id: 1 });
  db = write(customCogs.db, 'res.company', 1, { account_cogs_id: customCogs.id });

  const product = create(db, 'product', { name: 'POS Item', type: 'goods', valuation: 'real_time', cost: 20, list_price: 35, qty_available: 0 });
  const preset = create(product.db, 'pos.preset', { name: 'Refunds', is_return: true, identification: 'none' });
  const config = search(preset.db, 'pos.config')[0];
  db = write(preset.db, 'pos.config', config.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
  db = startSession(db, 0).db;

  const sale = payOrder(db, { lines: priceLines(db, [{ product_id: product.id, qty: -1 }]), method: 'cash', preset_id: preset.id });
  const layer = search(sale.db, 'stock.valuation.layer').find((l) => l.product_id === product.id && !l.opening);
  assert.ok(layer);
  const move = read(sale.db, 'account.move', layer.move_id);
  assert.ok(move.line_ids.some((l) => l.account_id === customCogs.id && l.credit === 20));
});
