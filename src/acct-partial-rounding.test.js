import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment, reversePayment } from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';
import { agedBalance } from './models/finance.js';
import { accountId, journalItems } from './models/ledger.js';

function setup() {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'ROUNDING', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-01-02', rate: 1 }] });
  db = currency.db;
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 0.03, tax: 0 }] });
  return { db: postMove(invoice.db, invoice.id), id: invoice.id };
}

function standalone(db) {
  const payment = create(db, 'account.payment', { partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: 0.01, date: '2026-01-02' });
  return { db: postPayment(payment.db, read(payment.db, 'account.payment', payment.id)), id: payment.id };
}

test('standalone partial payments settle rounded foreign balance after a reversal', () => {
  let { db, id } = setup();
  let first = standalone(db); db = first.db;
  let second = standalone(db); db = second.db;
  assert.deepEqual(read(db, 'account.move', id).payments.map((p) => p.company_amount), [0.01, 0]);
  db = reversePayment(db, read(db, 'account.payment', first.id), '2026-01-03');
  first = standalone(db); db = first.db;
  second = standalone(db); db = second.db;
  const invoice = read(db, 'account.move', id);
  assert.equal(invoice.amount_residual, 0);
  assert.deepEqual(invoice.payments.filter((p) => !p.reversed).map((p) => p.company_amount), [0, 0.01, 0.01]);
});

test('invoice-linked partial payments allocate cumulative rounded company balance', () => {
  let { db, id } = setup();
  for (let i = 0; i < 3; i++) db = payMove(db, id, 0.01, '2026-01-02');
  const invoice = read(db, 'account.move', id);
  assert.equal(invoice.amount_residual, 0);
  assert.deepEqual(invoice.payments.map((p) => p.company_amount), [0.01, 0, 0.01]);
});

test('ORM and sync reject a one-cent forged settlement allocation', () => {
  let db = seed();
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 0.02, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  const original = read(db, 'account.move', invoice.id);
  const paid = payMove(db, invoice.id, 0.02, '2026-01-02');
  const row = read(paid, 'account.move', invoice.id).payments[0];
  db = { ...paid, records: { ...paid.records, 'account.move': paid.records['account.move'].map((m) => m.id === invoice.id ? original : m) } };
  const changes = { amount_paid: 0.02, payment_date: '2026-01-02', payments: [{ ...row, company_amount: 0.01 }] };
  assert.throws(() => write(db, 'account.move', invoice.id, changes), /settlement company amount/i);
  const forged = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === invoice.id ? { ...m, ...changes } : m) } };
  assert.throws(() => applyDiff(db, diffDb(db, forged)), /settlement company amount/i);
});

test('aged foreign partial payments match the ledger at each cutoff, including legacy allocations', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Rounding aging' }); db = partner.db;
  const currency = create(db, 'res.currency', { name: 'AGING ROUNDING', rate_ids: [{ date: '2026-01-01', rate: 2 }] }); db = currency.db;
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 0.03, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  db = payMove(db, invoice.id, 0.01, '2026-01-02');
  db = payMove(db, invoice.id, 0.01, '2026-01-03');
  const account = accountId(db, '121000');
  const ledger = (source, at) => Math.round(journalItems(source, { to: at }).filter((l) => l.partner_id === partner.id && l.account_id === account).reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0) * 100) / 100;
  const aged = (source, at) => agedBalance(source, 'receivable', at).rows.find((row) => row.partner_id === partner.id)?.total ?? 0;
  const legacy = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id !== invoice.id ? m : { ...m, payments: m.payments.map(({ company_amount, ...p }) => p) }) } };
  for (const source of [db, legacy]) for (const date of ['2026-01-01', '2026-01-02', '2026-01-03']) {
    assert.equal(aged(source, date), ledger(source, date), date);
  }
  assert.equal(aged(db, '2026-01-03'), 0.01);
});
