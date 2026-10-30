import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment, reversePayment } from './models/pay.js';
import { agedBalance } from './models/finance.js';
import { cashFlow } from './models/reports.js';
const invoice = (db, date, currency, account) => { const m = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: date, invoice_date_due: date, currency_id: currency, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, account_id: account }] }); return { id: m.id, db: postMove(m.db, m.id) }; };
const apply = (db, id, payment, date, amount, companyAmount) => write(db, 'account.move', id, { amount_paid: amount, payment_date: date, payments: [{ date, amount, move_id: payment.move_id, company_amount: companyAmount }] });
const advance = (db) => { const p = create(db, 'account.payment', { partner_id: 1, partner_type: 'customer', payment_type: 'inbound', date: '2026-01-01', amount: 100 }); const next = postPayment(p.db, read(p.db, 'account.payment', p.id)); return { db: next, id: p.id }; };

test('reversal and application actions reject inconsistent chronology in either order', () => {
  let a = advance(seed()); let inv = invoice(a.db, '2026-01-02', null, accountId(a.db, '151000'));
  let db = apply(inv.db, inv.id, read(inv.db, 'account.payment', a.id), '2026-01-10', 50, 50);
  assert.throws(() => reversePayment(db, read(db, 'account.payment', a.id), '2026-01-05'), /date|before/i);
  a = advance(seed()); db = reversePayment(a.db, read(a.db, 'account.payment', a.id), '2026-01-05'); inv = invoice(db, '2026-01-02', null, accountId(db, '151000'));
  assert.throws(() => apply(inv.db, inv.id, read(inv.db, 'account.payment', a.id), '2026-01-10', 50, 50), /revers|date/i);
  assert.deepEqual([cashFlow(inv.db, { from: '2026-01-01', to: '2026-01-10' }).investing, cashFlow(inv.db, { from: '2026-01-01', to: '2026-01-10' }).operating], [0, 0]);
  // Legacy data may contain a later application despite the reversal; reporting must not reclassify it.
  const payment = read(inv.db, 'account.payment', a.id);
  const reversal = search(inv.db, 'account.move').find((m) => m.reversed_entry_id === payment.move_id);
  const legacy = { ...inv.db, records: { ...inv.db.records, 'account.move': inv.db.records['account.move'].map((m) => m.id === inv.id ? { ...m, payments: [{ date: '2026-01-10', amount: 50, company_amount: 50, move_id: payment.move_id, reversed: true, reversal_move_id: reversal.id }] } : m) } };
  const report = cashFlow(legacy, { from: '2026-01-01', to: '2026-01-10' });
  assert.deepEqual([report.investing, report.operating], [0, 0]);
});

test('aging uses booked company currency for foreign overpayment and later application', () => {
  let db = seed(); const fx = create(db, 'res.currency', { name: 'AGINGFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-01-02', rate: 1 }] }); db = fx.db;
  const first = invoice(db, '2026-01-01', fx.id); db = payMove(first.db, first.id, 150, '2026-01-02');
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === first.id);
  const total = (date) => agedBalance(db, 'receivable', date).rows.find((r) => r.partner_id === 1)?.total ?? 0;
  assert.equal(total('2026-01-01'), 50);
  assert.equal(total('2026-01-02'), -50);
  const second = invoice(db, '2026-01-03', fx.id); db = second.db;
  assert.equal(total('2026-01-03'), 50);
  db = apply(db, second.id, payment, '2026-01-04', 50, 50);
  assert.equal(total('2026-01-04'), 50);
});
