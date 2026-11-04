import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { payMove } from './models/accounting.js';
import { accountId, isBalanced, journalItems } from './models/ledger.js';
import { seed } from './seed.js';

const confirm = (db, id) => models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.move', id)).db;
const balance = (db, code, partner) => Math.round(journalItems(db).filter((l) => l.account_id === accountId(db, code) && (!partner || l.partner_id === partner))
  .reduce((s, l) => s + l.debit - l.credit, 0) * 100) / 100 || 0;
const newPartner = (db) => create(db, 'res.partner', { name: 'Rounding Customer' });

test('the receivable equals the document total even when each account rounds up', () => {
  const p = newPartner(seed());
  const made = create(p.db, 'account.move', { move_type: 'out_invoice', partner_id: p.id, invoice_line_ids: [
    { product_id: 1, qty: 1, price_unit: 0.335, tax: 0 }, { product_id: 1, qty: 1, price_unit: 0.335, tax: 0, account_id: accountId(p.db, '450000') },
  ] });
  const db = confirm(made.db, made.id);
  const inv = read(db, 'account.move', made.id);
  assert.equal(inv.amount_total, 0.67);
  assert.ok(isBalanced(inv.line_ids));
  assert.equal(inv.line_ids.find((l) => l.account_id === accountId(db, '121000')).debit, 0.67);
  assert.equal(balance(payMove(db, made.id, 0.67), '121000', p.id), 0);
});

test('a foreign invoice paid in parts leaves nothing on the receivable', () => {
  const p = newPartner(seed());
  const eur = search(p.db, 'res.currency').find((c) => c.name === 'EUR').id;
  const made = create(p.db, 'account.move', { move_type: 'out_invoice', partner_id: p.id, currency_id: eur, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 414.39, tax: 0 }] });
  let db = confirm(made.db, made.id);
  for (const part of [100, 100, 214.39]) db = payMove(db, made.id, part);
  assert.equal(read(db, 'account.move', made.id).payment_state, 'paid');
  assert.equal(balance(db, '121000', p.id), 0);
  assert.equal(read(db, 'account.move', made.id).amount_paid, 414.39);
});

test('cash-basis tax paid in three parts ends at zero on the transition account', () => {
  const base = seed();
  const tax = create(base, 'account.tax', { name: 'VAT 14% on payment', amount: 14, amount_type: 'percent', type_tax_use: 'sale', tax_exigibility: 'on_payment' });
  const p = newPartner(tax.db);
  const made = create(p.db, 'account.move', { move_type: 'out_invoice', partner_id: p.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 14, tax_cash_basis: true }] });
  let db = confirm(made.db, made.id);
  assert.equal(balance(db, '251100'), -14);
  for (const part of [38, 38, 38]) db = payMove(db, made.id, part);
  assert.equal(read(db, 'account.move', made.id).payment_state, 'paid');
  assert.equal(balance(db, '251100'), 0);
  assert.equal(balance(db, '251000') - balance(made.db, '251000'), -14);
});
