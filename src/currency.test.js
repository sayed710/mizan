import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { journalItems, isBalanced, accountId } from './models/ledger.js';
import { payMove } from './models/accounting.js';
import { rateAt, toCompany } from './models/currency.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';

const post = (db, id) => models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.move', id)).db;
const eur = (db) => search(db, 'res.currency').find((c) => c.name === 'EUR').id;

test('rate lookup takes the latest rate on or before the date; company currency is 1', () => {
  const db = seed();
  assert.equal(rateAt(db, eur(db), addDays(today(), -30)), 0.92);
  assert.equal(rateAt(db, eur(db), today()), 0.9);
  assert.equal(rateAt(db, eur(db), addDays(today(), -400)), 0.92);
  assert.equal(rateAt(db, null), 1);
  assert.equal(toCompany(db, eur(db), 90, today()), 100);
});

test('a EUR invoice books company-currency journal items at the invoice-date rate', () => {
  const db0 = seed();
  const { db, id } = create(db0, 'account.move', { move_type: 'out_invoice', partner_id: 3, currency_id: eur(db0), invoice_date: addDays(today(), -30), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 920, tax: 0 }] });
  const lines = read(post(db, id), 'account.move', id).line_ids;
  assert.ok(isBalanced(lines));
  assert.equal(lines.find((l) => l.account_id === accountId(db, '121000')).debit, 1000);
});

test('paying later at a better rate books an exchange gain and clears the receivable', () => {
  const db0 = seed();
  const { db, id } = create(db0, 'account.move', { move_type: 'out_invoice', partner_id: 3, currency_id: eur(db0), invoice_date: addDays(today(), -30), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 920, tax: 0 }] });
  const paid = payMove(post(db, id), id, 920, today());
  const pay = search(paid, 'account.move').filter((m) => m.ref === `Payment ${read(paid, 'account.move', id).name}`)[0];
  assert.ok(isBalanced(pay.line_ids));
  const by = (code) => pay.line_ids.find((l) => l.account_id === accountId(paid, code));
  assert.equal(by('101401').debit, 1022.22);
  assert.equal(by('121000').credit, 1000);
  assert.equal(by('450100').credit, 22.22);
  const recv = journalItems(paid).filter((l) => l.account_id === accountId(paid, '121000') && [id, pay.id].includes(l.move_id));
  assert.equal(recv.reduce((s, l) => s + l.debit - l.credit, 0), 0);
  assert.equal(read(paid, 'account.move', id).amount_residual, 0);
});
