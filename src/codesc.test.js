import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { confirmAsset, postDepreciation, disposeAsset } from './models/assets.js';
import { exchangeAccount } from './models/exchange-account.js';
import { payWithDiscount, postMove } from './models/accounting.js';
import { addDays, today } from './models/common.js';
import { applyRule } from './models/reconcile.js';
import { holdDeposit, settleDeposit } from './models/rentalplus.js';
import { models } from './models/index.js';

test('asset accounts are copied from the model and disposal uses company configuration', () => {
  let db = seed();
  const ids = [];
  for (const [code, account_type] of [['A001', 'asset_fixed'], ['A002', 'asset_fixed'], ['A003', 'expense'], ['A004', 'expense']]) {
    const result = create(db, 'account.account', { code, name: code, account_type, company_id: 1 });
    db = result.db; ids.push(result.id);
  }
  db = write(db, 'res.company', 1, { loss_account_id: ids[3] });
  const model = create(db, 'account.asset.model', { name: 'Explicit asset model', account_asset_id: ids[0], account_depreciation_id: ids[1], account_depreciation_expense_id: ids[2] });
  const asset = create(model.db, 'account.asset', { name: 'Explicit asset', model_id: model.id, original_value: 100, acquisition_date: '2025-01-01', method_number: 2 });
  assert.equal(read(asset.db, 'account.asset', asset.id).account_depreciation_expense_id, ids[2]);
  db = confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id));
  db = postDepreciation(db, read(db, 'account.asset', asset.id), '2025-12-31');
  db = disposeAsset(db, read(db, 'account.asset', asset.id), { date: '2026-01-01' });
  const move = db.records['account.move'].find((entry) => entry.ref === 'Explicit asset disposal');
  assert.ok(move.line_ids.some((line) => line.account_id === ids[3]));
});

test('exchange gains and losses require company configured accounts', () => {
  let db = seed();
  const gain = create(db, 'account.account', { code: 'EX001', name: 'Exchange gain', account_type: 'income_other', company_id: 1 });
  const loss = create(gain.db, 'account.account', { code: 'EX002', name: 'Exchange loss', account_type: 'expense_other', company_id: 1 });
  db = write(loss.db, 'res.company', 1, { income_currency_exchange_account_id: gain.id, expense_currency_exchange_account_id: loss.id });
  assert.equal(exchangeAccount(db, 1, 1), gain.id);
  assert.equal(exchangeAccount(db, 1, -1), loss.id);
  db = write(db, 'res.company', 1, { income_currency_exchange_account_id: null });
  assert.throws(() => exchangeAccount(db, 1, 1), /Configure the exchange gain account on company/);
});

test('early payment discount requires the configured company expense account', () => {
  let db = seed();
  const account = create(db, 'account.account', { code: 'EPD01', name: 'Discount expense', account_type: 'expense', company_id: 1 });
  db = write(account.db, 'res.company', 1, { expense_early_payment_discount_account_id: account.id });
  const term = search(db, 'account.payment.term').find((item) => item.name === '2/7 Net 30');
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: addDays(today(), -3), invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  const missing = write(db, 'res.company', 1, { expense_early_payment_discount_account_id: null });
  assert.throws(() => payWithDiscount(missing, invoice.id, 980), /Configure the early payment discount expense account/);
  const paid = payWithDiscount(db, invoice.id, 980);
  assert.ok(search(paid, 'account.move').find((move) => move.ref?.startsWith('Early payment discount')).line_ids.some((line) => line.account_id === account.id));
});

test('reconciliation rules post the explicitly configured account id', () => {
  const account = create(seed(), 'account.account', { code: 'RULE01', name: 'Bank fees', account_type: 'expense', company_id: 1 });
  const rule = create(account.db, 'account.reconcile.model', { name: 'Explicit fee', company_id: 1, rule_type: 'writeoff_button', line_ids: [{ account_id: account.id, amount_type: 'percentage', amount: 100 }] });
  const bankJournal = search(rule.db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const line = create(rule.db, 'account.bank.statement.line', { journal_id: bankJournal.id, date: '2026-10-01', state: 'to_check', payment_ref: 'Fee', amount: -100 });
  const db = applyRule(line.db, read(line.db, 'account.reconcile.model', rule.id), read(line.db, 'account.bank.statement.line', line.id));
  const move = read(db, 'account.move', read(db, 'account.bank.statement.line', line.id).move_id);
  assert.ok(move.line_ids.some((item) => item.account_id === account.id));
});

test('rental deposit and withholding use company configured accounts', () => {
  const liability = create(seed(), 'account.account', { code: 'RENT01', name: 'Rental liability', account_type: 'liability_current', company_id: 1 });
  const income = create(liability.db, 'account.account', { code: 'RENT02', name: 'Withholding', account_type: 'income', company_id: 1 });
  const db = write(income.db, 'res.company', 1, { rental_deposit_account_id: liability.id, rental_withheld_deposit_account_id: income.id });
  const rental = create(db, 'sale.rental', { partner_id: 1, product_id: 4, qty: 1, pickup_date: '2035-01-10', return_date: '2035-01-15' });
  const held = holdDeposit(rental.db, rental.id, 100);
  assert.ok(read(held.db, 'account.move', read(held.db, 'rental.deposit', held.id).move_id).line_ids.some((line) => line.account_id === liability.id));
  const settled = settleDeposit(held.db, held.id, { damage: 20 });
  assert.ok(read(settled, 'account.move', read(settled, 'rental.deposit', held.id).settlement_move_id).line_ids.some((line) => line.account_id === income.id));
});

test('sales advances require the configured down payment account even when the old code exists', () => {
  let db = seed();
  const account = create(db, 'account.account', { code: 'ADV01', name: 'Customer advances', account_type: 'liability_current', company_id: 1 });
  db = write(account.db, 'res.company', 1, { down_payment_account_id: account.id });
  const order = create(db, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 1, price_unit: 100, tax: 0 }] });
  db = models['sale.order'].form.buttons.find((button) => button.label === 'Confirm').run(order.db, read(order.db, 'sale.order', order.id)).db;
  const button = models['sale.order'].form.buttons.find((item) => item.label === 'Create Invoice');
  const missing = write(db, 'res.company', 1, { down_payment_account_id: null });
  assert.throws(() => button.run(missing, read(missing, 'sale.order', order.id), { method: 'fixed', amount: 30 }), /Configure the down payment account/);
  db = button.run(db, read(db, 'sale.order', order.id), { method: 'fixed', amount: 30 }).db;
  assert.equal(search(db, 'account.move').find((move) => move.sale_id === order.id).invoice_line_ids[0].account_id, account.id);
});
