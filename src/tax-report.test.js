import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, search } from './orm.js';
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

test('without new documents the return and its rows still reconcile on the seeded data', () => {
  const db = seed();
  const r = taxReport(db, {});
  const rows = taxesByTax(db, {});
  assert.equal(sumRows(rows, 'sale'), r.output);
  assert.equal(sumRows(rows, 'purchase'), r.input);
});
