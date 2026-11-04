import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { duplicateValues } from './duplicate.js';
import { discountAvailable } from './models/accounting.js';
import { today } from './models/common.js';

const confirm = (db, id) => models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.move', id)).db;

test('duplicated vendor bills remain draft bills and post purchase and payable lines', () => {
  const made = create(seed(), 'account.move', { move_type: 'in_invoice', partner_id: 3, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = confirm(made.db, made.id);
  const copy = create(posted, 'account.move', duplicateValues('account.move', read(posted, 'account.move', made.id)));
  assert.equal(read(copy.db, 'account.move', copy.id).move_type, 'in_invoice');
  assert.equal(read(copy.db, 'account.move', copy.id).state, 'draft');
  const done = confirm(copy.db, copy.id);
  const bill = read(done, 'account.move', copy.id);
  assert.equal(read(done, 'account.journal', bill.journal_id).type, 'purchase');
  assert.ok(bill.line_ids.some((l) => read(done, 'account.account', l.account_id)?.account_type === 'liability_payable' && l.credit > 0));
});

test('changing invoice partner replaces or clears payment terms and due dates', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', { name: 'Discount', early_discount: true, discount_percent: 2, discount_days: 10, line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }] });
  const partner = create(term.db, 'res.partner', { name: 'Termed', property_payment_term_id: term.id });
  const noTerm = create(partner.db, 'res.partner', { name: 'No term' });
  const inv = create(noTerm.db, 'account.move', { move_type: 'out_invoice', invoice_date: today(), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = write(inv.db, 'account.move', inv.id, { partner_id: partner.id });
  assert.equal(read(db, 'account.move', inv.id).invoice_payment_term_id, term.id);
  assert.ok(read(db, 'account.move', inv.id).invoice_date_due);
  db = write(db, 'account.move', inv.id, { partner_id: noTerm.id });
  assert.equal(read(db, 'account.move', inv.id).invoice_payment_term_id, null);
  assert.equal(read(db, 'account.move', inv.id).invoice_date_due, null);
  db = confirm(db, inv.id);
  assert.equal(discountAvailable(db, read(db, 'account.move', inv.id)), 0);
});
