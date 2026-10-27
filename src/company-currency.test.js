import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { createCompany, ensureMainCompany } from './models/company.js';
import { accountId } from './models/ledger.js';
import { payMove } from './models/accounting.js';
import { rateAt } from './models/currency.js';

const confirm = (db, id) => models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.move', id)).db;
const currency = (db, name) => search(db, 'res.currency').find((c) => c.name === name)?.id;
const setup = () => {
  const base = ensureMainCompany(seed());
  const db = createCompany(base, { name: 'Euro GmbH', currency_id: currency(base, 'EUR') }).db;
  return { db, company: search(db, 'res.company').at(-1).id };
};
const invoice = (db, company, currencyId, price) => {
  const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, company_id: company, currency_id: currencyId, invoice_date: addDays(today(), -30), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: price, tax: 0 }] });
  return { db: confirm(made.db, made.id), id: made.id };
};
const receivable = (db, id) => read(db, 'account.move', id).line_ids.find((l) => l.account_id === accountId(db, '121000'));

test('a EUR company books a EUR invoice in EUR, not converted to the base currency', () => {
  const { db: base, company } = setup();
  const { db, id } = invoice(base, company, currency(base, 'EUR'), 100);
  const line = receivable(db, id);
  assert.equal(line.debit, 100);
  assert.equal(line.amount_currency, undefined);
});

test('a USD invoice in a EUR company is converted at the cross rate and keeps its USD amount', () => {
  const { db: base, company } = setup();
  const usd = currency(base, 'USD');
  const { db, id } = invoice(base, company, usd, 100);
  const line = receivable(db, id);
  assert.equal(line.debit, 92);
  assert.equal(line.currency_id, usd);
  assert.equal(line.amount_currency, 100);
  // Paid today at 0.90 EUR per USD: 90 EUR reach the bank, 2 EUR are an exchange loss.
  const paid = payMove(db, id, 100, today());
  const entry = read(paid, 'account.move', read(paid, 'account.move', id).payments[0].move_id);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(paid, '101401')).debit, 90);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(paid, '690100')).debit, 2);
});

test('the group conversion of the EUR books is applied once', () => {
  const { db: base, company } = setup();
  const { db, id } = invoice(base, company, currency(base, 'EUR'), 100);
  const date = addDays(today(), -30);
  // Consolidation converts company → group currency with rate(group) / rate(company).
  const toGroup = rateAt(db, currency(db, 'USD'), date) / rateAt(db, currency(db, 'EUR'), date);
  assert.equal(Math.round(receivable(db, id).debit * toGroup * 100) / 100, 108.7);
});
