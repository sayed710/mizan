import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment, reversePayment } from './models/pay.js';
import { agedBalance } from './models/finance.js';
import { cashFlow } from './models/reports.js';
const doc = (db, type, date, currency) => { const m = create(db, 'account.move', { move_type: type, partner_id: 1, invoice_date: date, invoice_date_due: date, currency_id: currency, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] }); return { db: postMove(m.db, m.id), id: m.id }; };
const payment = (db, side, direction, amount, date) => { const p = create(db, 'account.payment', { partner_id: 1, partner_type: side, payment_type: direction, amount, date }); return { id: p.id, db: postPayment(p.db, read(p.db, 'account.payment', p.id)) }; };
test('public write rejects application before its source payment date', () => {
 let db = seed(); const inv = doc(db, 'out_invoice', '2026-01-01'); const p = payment(inv.db, 'customer', 'inbound', 10, '2026-01-10'); db = p.db;
 const second = doc(db, 'out_invoice', '2026-01-01'); db = second.db;
 assert.throws(() => write(db, 'account.move', second.id, { amount_paid: 1, payment_date: '2026-01-09', payments: [{ date: '2026-01-09', amount: 1, move_id: read(db, 'account.payment', p.id).move_id, company_amount: 1 }] }), /date/i);
});
test('standalone partial and full foreign settlements use booked company currency', () => {
 let db = seed(); const fx = create(db, 'res.currency', { name: 'SWEEPFX', rate_ids: [{ date: '2026-01-01', rate: 2 }] }); db = fx.db;
 const inv = doc(db, 'out_invoice', '2026-01-01', fx.id); db = inv.db;
 let p = payment(db, 'customer', 'inbound', 25, '2026-01-02'); db = p.db;
 let m = read(db, 'account.move', inv.id); assert.equal(m.amount_residual, 50); assert.equal(m.payments[0].amount, 50); assert.equal(m.payments[0].company_amount, 25);
 assert.equal(agedBalance(db, 'receivable', '2026-01-02').rows.find((r) => r.partner_id === 1).total, 25);
 p = payment(db, 'customer', 'inbound', 25, '2026-01-03'); db = p.db; m = read(db, 'account.move', inv.id);
 assert.equal(m.amount_residual, 0); assert.equal(m.payments[1].company_amount, 25);
});
test('unapplied outgoing customer and incoming vendor refund payments age as positive balances', () => {
 for (const [type, kind] of [['out_refund','receivable'], ['in_refund','payable']]) {
  let db = seed(); const refund = doc(db, type, '2026-01-01'); db = payMove(refund.db, refund.id, 150, '2026-01-10');
  const total = (date) => agedBalance(db, kind, date).rows.find((r) => r.partner_id === 1)?.total ?? 0;
  assert.equal(total('2026-01-05'), -100); assert.equal(total('2026-01-10'), 50);
 }
});

test('analytic split allocates a rounded cent only once within a plan', () => {
 let db = seed(); const a = create(db, 'account.analytic.account', { name: 'Cent A' }); const b = create(a.db, 'account.analytic.account', { name: 'Cent B' }); db = b.db;
 const m = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 0.01, tax: 0, analytic_distribution: { [a.id]: 50, [b.id]: 50 } }] }); db = postMove(m.db, m.id);
 const lines = db.records['account.analytic.line'].filter((l) => l.move_id === m.id);
 assert.equal(lines.reduce((sum, l) => sum + l.amount, 0), 0.01);
});

test('posted foreign analytic items use company currency', () => {
 let db = seed(); const fx = create(db, 'res.currency', { name: 'ANALYTICFX', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
 const a = create(fx.db, 'account.analytic.account', { name: 'Foreign plan' });
 const m = create(a.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', currency_id: fx.id, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, analytic_distribution: { [a.id]: 100 } }] }); db = postMove(m.db, m.id);
 assert.equal(db.records['account.analytic.line'].find((l) => l.move_id === m.id).amount, 50);
});

test('posted foreign analytic lines share the ledger group rounded cent', () => {
 const fx = create(seed(), 'res.currency', { name: 'ANALYTICCENTS', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
 const a = create(fx.db, 'account.analytic.account', { name: 'First cent' });
 const b = create(a.db, 'account.analytic.account', { name: 'Second cent' });
 const m = create(b.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', currency_id: fx.id, invoice_line_ids: [a.id, b.id].map((id) => ({ product_id: 5, qty: 1, price_unit: 0.01, tax: 0, analytic_distribution: { [id]: 100 } })) });
 const db = postMove(m.db, m.id);
 const posted = read(db, 'account.move', m.id);
 const booked = posted.line_ids.filter((line) => line.name === 'Sales').reduce((sum, line) => sum + line.credit - line.debit, 0);
 const analytics = db.records['account.analytic.line'].filter((line) => line.move_id === m.id);
 assert.equal(booked, 0.01);
 assert.equal(analytics.reduce((sum, line) => sum + line.amount, 0), booked);
});

test('standalone payment never applies another company invoice for same partner', async () => {
 const { createCompany } = await import('./models/company.js'); let db = seed(); const co = createCompany(db, { name: 'Sweep Company' }); db = co.db;
 const inv = doc(db, 'out_invoice', '2026-01-01'); db = inv.db;
 const p = create(db, 'account.payment', { partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: 25, date: '2026-01-02', company_id: co.id }); db = postPayment(p.db, read(p.db, 'account.payment', p.id));
 assert.equal(read(db, 'account.move', inv.id).amount_residual, 100);
 assert.equal(read(db, 'account.payment', p.id).unapplied, 25);
});

test('standalone payment rejects non-finite amounts before posting', () => {
 let db = seed(); const p = create(db, 'account.payment', { partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: Infinity, date: '2026-01-01' });
 assert.throws(() => postPayment(p.db, read(p.db, 'account.payment', p.id)), /amount/i);
});

test('standalone foreign settlement books payment-date conversion and exchange difference', () => {
 let db = seed(); const fx = create(db, 'res.currency', { name: 'FXVAR', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-01-02', rate: 1 }] });
 const inv = doc(fx.db, 'out_invoice', '2026-01-01', fx.id); const paid = payment(inv.db, 'customer', 'inbound', 25, '2026-01-02'); db = paid.db;
 const m = read(db, 'account.move', inv.id); assert.equal(m.amount_residual, 75); assert.equal(m.payments[0].company_amount, 12.5);
 assert.equal(agedBalance(db, 'receivable', '2026-01-02').rows.find((r) => r.partner_id === 1).total, 37.5);
 const fxEntry = read(db, 'account.move', m.payments[0].payment_fx_move_id);
 assert.ok(fxEntry && fxEntry.line_ids.some((l) => l.credit === 12.5));
 const second = payment(db, 'customer', 'inbound', 75, '2026-01-03'); db = second.db;
 assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
 db = reversePayment(db, read(db, 'account.payment', second.id), '2026-01-04');
 assert.equal(read(db, 'account.move', inv.id).amount_residual, 75);
 const fx2 = read(db, 'account.move', inv.id).payments[1].payment_fx_move_id;
 assert.ok(db.records['account.move'].some((entry) => entry.reversed_entry_id === fx2 && entry.state === 'posted'));
});

test('invoice payment entries belong to the invoice company', async () => {
 const { createCompany } = await import('./models/company.js'); let db = seed(); const co = createCompany(db, { name: 'Invoice Company' });
 const inv = create(co.db, 'account.move', { company_id: co.id, move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
 db = payMove(postMove(inv.db, inv.id), inv.id, 100, '2026-01-02');
 const payment = db.records['account.payment'].find((p) => p.invoice_id === inv.id);
 assert.equal(payment.company_id, co.id); assert.equal(read(db, 'account.move', payment.move_id).company_id, co.id);
});

test('payment application rejects invalid date and non-finite company amounts', () => {
 let db = seed(); const inv = doc(db, 'out_invoice', '2026-01-01'); const p = payment(inv.db, 'customer', 'inbound', 10, '2026-01-10'); const second = doc(p.db, 'out_invoice', '2026-01-01'); db = second.db;
 for (const [date, companyAmount] of [['2026-99-99', 1], ['2026-01-10', Infinity]]) {
  assert.throws(() => write(db, 'account.move', second.id, { amount_paid: 1, payment_date: date, payments: [{ date, amount: 1, move_id: read(db, 'account.payment', p.id).move_id, company_amount: companyAmount }] }), /date|amount/i);
 }
});

test('historical cash flow retains standalone foreign payment conversion after reversal', () => {
 let db = seed(); const fx = create(db, 'res.currency', { name: 'FXHIST', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-01-02', rate: 1 }] });
 const fixed = fx.db.records['account.account'].find((a) => a.code === '151000').id;
 const m = create(fx.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', currency_id: fx.id, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, account_id: fixed }] });
 db = postMove(m.db, m.id); const p = payment(db, 'customer', 'inbound', 25, '2026-01-02'); db = reversePayment(p.db, read(p.db, 'account.payment', p.id), '2026-01-03');
 const report = cashFlow(db, { from: '2026-01-02', to: '2026-01-02' });
 assert.equal(report.investing, 25); assert.equal(report.operating, 0);
});
