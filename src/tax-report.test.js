import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, search, read, write } from './orm.js';
import { postMove, payMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { taxReport, taxesByTax } from './models/finance.js';
import { payOrder, startSession } from './models/pos.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';

const taxNamed = (db, name) => search(db, 'account.tax').find((t) => t.name === name && t.type_tax_use === 'sale');
const line = (db, name, vals) => ({ product_id: 1, qty: 1, price_unit: 100, discount: 0, ...taxSnapshot(taxNamed(db, name)), ...vals });
const invoice = (db, lines, vals = {}) => {
  const { db: next, id } = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: today(), invoice_line_ids: lines, ...vals });
  return { db: postMove(next, id), id };
};
const row = (rows, name) => rows.find((r) => r.side === 'sale' && r.name === name);
const period = { from: addDays(today(), -60), to: today() };
const delta = (before, after) => ({ output: Math.round((after.output - before.output) * 100) / 100, input: Math.round((after.input - before.input) * 100) / 100 });
const sumRows = (rows, side) => Math.round(rows.filter((r) => r.side === side).reduce((s, r) => s + r.tax, 0) * 100) / 100;

test('the per-tax rows add up to the return totals: foreign invoices, cash basis, POS', () => {
  let db = seed();
  const before = taxReport(db, period);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR').id;
  // 920 EUR at 0.92 → 1000 base and 140 tax in company currency, not 128.8 in invoice currency.
  db = invoice(db, [line(db, 'VAT 14%', { price_unit: 920 })], { currency_id: eur, invoice_date: addDays(today(), -30) }).db;
  // Unpaid cash-basis tax is not due yet; half paid releases half the tax and half the base.
  const cash = invoice(db, [line(db, 'VAT 14% (Cash Basis)', { price_unit: 1000 })]);
  db = invoice(cash.db, [line(cash.db, 'VAT 14% (Cash Basis)', { price_unit: 500 })]).db;
  db = payMove(db, cash.id, 570, today());
  // POS sales book their tax per tax too.
  db = startSession(db, 0).db;
  db = payOrder(db, { lines: [line(db, 'VAT 14%', { price_unit: 50 })], method: 'cash' }).db;

  const totals = delta(before, taxReport(db, period));
  const rows = taxesByTax(db, period);
  assert.equal(totals.output, Math.round((140 + 70 + 7) * 100) / 100);
  assert.equal(sumRows(rows, 'sale'), taxReport(db, period).output);
  assert.equal(sumRows(rows, 'purchase'), taxReport(db, period).input);
  const cashRow = row(rows, 'VAT 14% (Cash Basis)');
  assert.deepEqual([cashRow.base, cashRow.tax], [500, 70]);
});

test('historical tax items retain their side after editing and archiving the tax', () => {
  const db = seed();
  const custom = create(db, 'account.account', { code: '259999', name: 'Custom VAT', account_type: 'liability_current' });
  const tax = create(custom.db, 'account.tax', { name: 'Custom historical tax', amount: 10, type_tax_use: 'sale', account_id: custom.id });
  const posted = invoice(tax.db, [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }]);
  const before = taxReport(tax.db, {});
  const changed = write(posted.db, 'account.tax', tax.id, { account_id: null, active: false });
  assert.equal(taxReport(changed, {}).output - before.output, 10);
  assert.deepEqual(row(taxesByTax(changed), 'Custom historical tax'), { side: 'sale', name: 'Custom historical tax', base: 100, tax: 10 });
});

test('sales and purchases using the same tax account remain on their own sides', () => {
  const db = seed();
  const account = db.records['account.account'].find((a) => a.code === '251000').id;
  const tax = create(db, 'account.tax', { name: 'Shared input', amount: 10, type_tax_use: 'purchase', account_id: account });
  const posted = invoice(tax.db, [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }], { move_type: 'in_invoice' });
  const before = taxReport(tax.db, {});
  const after = taxReport(posted.db, {});
  assert.equal(after.input - before.input, 10);
  assert.equal(after.output, before.output);
});

test('the final cash-basis release clears the taxable base rounding remainder', () => {
  const db = seed();
  const posted = invoice(db, [line(db, 'VAT 14% (Cash Basis)', { price_unit: 100 })]);
  let paid = posted.db;
  for (let i = 0; i < 3; i++) paid = payMove(paid, posted.id, 38, today());
  assert.deepEqual(row(taxesByTax(paid), 'VAT 14% (Cash Basis)'), { side: 'sale', name: 'VAT 14% (Cash Basis)', base: 100, tax: 14 });
});

test('zero-rated exports keep a durable taxable base without changing return totals', () => {
  const db = seed();
  const tax = create(db, 'account.tax', { name: 'Zero export', amount: 0, type_tax_use: 'sale' });
  const posted = invoice(tax.db, [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }]);
  assert.deepEqual(taxReport(posted.db, {}), taxReport(tax.db, {}));
  assert.deepEqual(row(taxesByTax(posted.db), 'Zero export'), { side: 'sale', name: 'Zero export', base: 100, tax: 0 });
});

test('without new documents the return and its rows still reconcile on the seeded data', () => {
  const db = seed();
  const r = taxReport(db, {});
  const rows = taxesByTax(db, {});
  assert.equal(sumRows(rows, 'sale'), r.output);
  assert.equal(sumRows(rows, 'purchase'), r.input);
});
