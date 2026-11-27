import { seed } from '../src/seed.js';
import { read, search, create } from '../src/orm.js';
import { payMove, postMove } from '../src/models/accounting.js';
import { accountId, invoiceLines } from '../src/models/ledger.js';
import { invariants, r2 } from './lib.mjs';
const base = seed();
const recv = (db, id) => r2(read(db, 'account.move', id).line_ids.concat(
  search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'entry' && (m.ref ?? '').includes(read(db, 'account.move', id).name)).flatMap((m) => m.line_ids))
  .filter((l) => l.account_id === accountId(db, '121000')).reduce((s, l) => s + l.debit - l.credit, 0));
// 1) Two lines on different income accounts, each with half-cent subtotal
const other = accountId(base, '410000'), sales = accountId(base, '400000');
let c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-10-01', invoice_line_ids: [
  { name: 'a', qty: 1, price_unit: 10.005, tax: 14, account_id: sales }, { name: 'b', qty: 1, price_unit: 10.005, tax: 14, account_id: other }] });
let db = postMove(c.db, c.id);
let m = read(db, 'account.move', c.id);
const rl = m.line_ids.find((l) => l.account_id === accountId(db, '121000'));
console.log('1) amount_total', m.amount_total, 'receivable line', rl.debit, '-> mismatch', r2(rl.debit - m.amount_total));
db = payMove(db, c.id, m.amount_total, '2026-10-02');
m = read(db, 'account.move', c.id);
console.log('   after full payment: payment_state', m.payment_state, 'residual', m.amount_residual, 'receivable GL left on this invoice', recv(db, c.id));
// 2) foreign currency (EUR) invoice, full payment same day
const eur = search(base, 'res.currency').find((x) => x.name === 'EUR');
console.log('2) EUR rates', JSON.stringify(eur.rate_ids));
c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, currency_id: eur.id, invoice_date: '2026-10-01', invoice_line_ids: [
  { name: 'a', qty: 3, price_unit: 33.33, tax: 14, account_id: sales }, { name: 'b', qty: 7, price_unit: 1.11, tax: 14, account_id: other }, { name: 'c', qty: 1, price_unit: 0.07, tax: 14, account_id: sales }] });
db = postMove(c.db, c.id);
m = read(db, 'account.move', c.id);
console.log('   EUR total', m.amount_total, 'lines(company ccy)', JSON.stringify(m.line_ids.map((l) => [l.name, l.debit, l.credit])));
db = payMove(db, c.id, m.amount_total, '2026-10-01');
m = read(db, 'account.move', c.id);
console.log('   after same-day full payment: state', m.payment_state, 'receivable GL residue', recv(db, c.id));
// 2b partial payments in 3 parts
c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, currency_id: eur.id, invoice_date: '2026-10-01', invoice_line_ids: [{ name: 'x', qty: 1, price_unit: 100, tax: 14 }] });
db = postMove(c.db, c.id);
for (const amt of [33.33, 33.33, 1000]) db = payMove(db, c.id, amt, '2026-10-01');
m = read(db, 'account.move', c.id);
console.log('2b) EUR 114 paid in 3 parts: state', m.payment_state, 'amount_paid', m.amount_paid, 'receivable GL residue', recv(db, c.id));
// 3) price-included tax rounding: 3 lines of 9.99 incl 14%
c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-10-01', invoice_line_ids: [1, 2, 3].map(() => ({ name: 'i', qty: 1, price_unit: 9.99, tax: 14, tax_include: true }))});
db = postMove(c.db, c.id);
m = read(db, 'account.move', c.id);
console.log('3) tax-included 3x9.99: total', m.amount_total, 'untaxed', m.amount_untaxed, 'tax', m.amount_tax, 'lines', JSON.stringify(m.line_ids.map((l) => [l.name, l.debit, l.credit])));
// 4) negative qty line (discount/return line) in invoice
c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-10-01', invoice_line_ids: [{ name: 'p', qty: 1, price_unit: 100, tax: 14, account_id: sales }, { name: 'disc', qty: -1, price_unit: 150, tax: 14, account_id: other }] });
db = postMove(c.db, c.id);
m = read(db, 'account.move', c.id);
console.log('4) invoice with net-negative account bucket: total', m.amount_total, 'lines', JSON.stringify(m.line_ids.map((l) => [l.account_id, l.debit, l.credit])), 'balanced?', r2(m.line_ids.reduce((s, l) => s + l.debit - l.credit, 0)) === 0);
// 5) whole-invoice negative (total < 0)
c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-10-01', invoice_line_ids: [{ name: 'neg', qty: -2, price_unit: 50, tax: 14 }] });
db = postMove(c.db, c.id);
m = read(db, 'account.move', c.id);
console.log('5) negative-total invoice posted: total', m.amount_total, 'residual', m.amount_residual, 'payment_state', m.payment_state, 'lines', JSON.stringify(m.line_ids.map((l) => [l.account_id, l.debit, l.credit])));
// 6) cash basis release with 3 partial payments
const cb = search(base, 'account.tax').find((t) => t.tax_exigibility === 'on_payment');
c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-10-01', invoice_line_ids: [{ name: 'cb', qty: 1, price_unit: 100.01, tax: 14, tax_cash_basis: true, tax_account_id: cb.account_id }] });
db = postMove(c.db, c.id);
const tot = read(db, 'account.move', c.id).amount_total;
for (const amt of [r2(tot / 3), r2(tot / 3), 1e9]) db = payMove(db, c.id, amt, '2026-10-02');
const trans = accountId(db, '251100');
const tleft = r2(search(db, 'account.move').filter((x) => x.state === 'posted').flatMap((x) => x.line_ids).filter((l) => l.account_id === trans).reduce((s, l) => s + l.debit - l.credit, 0));
console.log('6) cash-basis tax 14.00 paid in 3 parts -> residue on transition account 251100:', tleft);
console.log(JSON.stringify(invariants(db).BS));
