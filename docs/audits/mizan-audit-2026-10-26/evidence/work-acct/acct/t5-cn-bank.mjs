import { seed } from '../src/seed.js';
import { read, search, create, write } from '../src/orm.js';
import { postMove, payMove } from '../src/models/accounting.js';
import { agedBalance, followUps, receivableOf } from '../src/models/finance.js';
import { customerStatement } from '../src/models/reports.js';
import { reconcileWith, candidates } from '../src/models/bank.js';
import { invariants, button, r2 } from './lib.mjs';
const base = seed();
// Credit note fully reversing an UNPAID overdue invoice
let c = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-08-01', invoice_date_due: '2026-08-31', invoice_line_ids: [{ name: 'x', qty: 1, price_unit: 1000, tax: 14 }] });
let db = postMove(c.db, c.id);
const out = button('account.move', 'Credit Note').run(db, read(db, 'account.move', c.id));
db = postMove(out.db, Number(out.go.split('/').pop()));
const cn = read(db, 'account.move', Number(out.go.split('/').pop()));
const inv = read(db, 'account.move', c.id);
console.log('CN', cn.name, 'residual', cn.amount_residual, '| invoice', inv.name, 'residual', inv.amount_residual, inv.payment_state);
console.log('customer statement closing (GL, partner 5):', customerStatement(db, 5).closing);
console.log('aged receivable row partner 5:', JSON.stringify(agedBalance(db, 'receivable', '2026-10-26').rows.find((r) => r.partner_id === 5)));
console.log('follow-ups partner 5:', JSON.stringify(followUps(db, '2026-10-26').find((f) => f.partner_id === 5)?.invoices.map((m) => m.name)));
console.log('credit-limit exposure partner 5 (receivableOf):', receivableOf(db, 5));
const cnPay = button('account.move', 'Register Payment');
console.log('CN has Register Payment button?', cnPay.when(cn), '| any button to apply CN to invoice?', (await import('../src/models/index.js')).models['account.move'].form.buttons.map((b) => b.label).join(', '));
// Bank: statement line larger than residual
const sara = search(base, 'account.move').find((m) => m.move_type === 'out_invoice' && m.partner_id === 3 && m.amount_residual > 0);
let s = create(base, 'account.bank.statement.line', { date: '2026-10-25', payment_ref: 'big', partner_id: 3, amount: 5000 });
let db2 = reconcileWith(s.db, read(s.db, 'account.bank.statement.line', s.id), sara.id);
const bankAcc = db2.records['account.account'].find((a) => a.code === '101401').id;
const bankMove = search(db2, 'account.move').filter((m) => m.ref === `Payment ${sara.name}`).at(-1);
console.log('Bank line 5000 matched to invoice residual', sara.amount_residual, '-> line state', read(db2, 'account.bank.statement.line', s.id).state, '| bank debit booked', bankMove.line_ids.find((l) => l.account_id === bankAcc).debit);
// Outgoing bank line matched to a customer invoice via "Match"
s = create(base, 'account.bank.statement.line', { date: '2026-10-25', payment_ref: 'out', amount: -300, move_id: sara.id });
db2 = button('account.bank.statement.line', 'Match').run(s.db, read(s.db, 'account.bank.statement.line', s.id)).db;
const bm = search(db2, 'account.move').filter((m) => m.ref === `Payment ${sara.name}`).at(-1);
console.log('Outgoing line -300 matched to customer invoice -> bank line', JSON.stringify(bm.line_ids.find((l) => l.account_id === bankAcc)), 'state', read(db2, 'account.bank.statement.line', s.id).state);
// Already-paid invoice match
const paid = search(base, 'account.move').find((m) => m.move_type === 'out_invoice' && m.payment_state === 'paid');
s = create(base, 'account.bank.statement.line', { date: '2026-10-25', payment_ref: 'dup', amount: 999, move_id: paid.id });
db2 = button('account.bank.statement.line', 'Match').run(s.db, read(s.db, 'account.bank.statement.line', s.id)).db;
console.log('Line 999 matched to already-paid invoice -> state', read(db2, 'account.bank.statement.line', s.id).state, '| new moves', db2.records['account.move'].length - s.db.records['account.move'].length);
// Payment entry reset to draft through the UI button
let p = payMove(base, sara.id, 100, '2026-10-25');
const pm = search(p, 'account.move').filter((m) => m.ref === `Payment ${sara.name}`).at(-1);
const reset = button('account.move', 'Reset to Draft');
console.log('Reset to Draft offered on payment entry?', reset.when(read(p, 'account.move', pm.id)));
p = reset.run(p, read(p, 'account.move', pm.id)).db;
const cancel = button('account.move', 'Cancel');
p = cancel.run(p, read(p, 'account.move', pm.id)).db;
console.log('After reset+cancel of payment entry: invoice amount_paid', read(p, 'account.move', sara.id).amount_paid, '| receivable', JSON.stringify(invariants(p).receivable));
