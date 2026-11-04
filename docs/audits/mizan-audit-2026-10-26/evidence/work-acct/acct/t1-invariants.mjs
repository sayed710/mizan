import { seed } from '../src/seed.js';
import { read, search, create, write } from '../src/orm.js';
import { invariants, press, r2 } from './lib.mjs';
import { payMove } from '../src/models/accounting.js';
let db = seed();
console.log(JSON.stringify(invariants(db, 'after seed')));
// sale -> invoice -> payment
const so = search(db, 'sale.order').find((s) => s.state === 'draft' || s.state === 'sent');
console.log('using SO', so?.name, so?.state);
db = press(db, 'sale.order', so.id, 'Confirm');
const b = (await import('./lib.mjs')).button('sale.order', 'Create Invoice');
const out = b.run(db, read(db, 'sale.order', so.id));
db = out.db; const invId = Number(out.go.split('/').pop());
db = press(db, 'account.move', invId, 'Confirm');
let inv = read(db, 'account.move', invId);
console.log('invoice', inv.name, 'total', inv.amount_total, 'state', inv.state);
db = payMove(db, invId, r2(inv.amount_total / 3), '2026-10-20');
db = payMove(db, invId, 10000000, '2026-10-21');
inv = read(db, 'account.move', invId);
console.log('after payments: paid', inv.amount_paid, 'residual', inv.amount_residual, inv.payment_state);
// credit note on seeded paid invoice
const paid = search(db, 'account.move').find((m) => m.move_type === 'out_invoice' && m.payment_state === 'paid' && m.id !== invId);
const cn = (await import('./lib.mjs')).button('account.move', 'Credit Note').run(db, read(db, 'account.move', paid.id));
db = cn.db; const cnId = Number(cn.go.split('/').pop());
db = press(db, 'account.move', cnId, 'Confirm');
console.log('credit note', read(db, 'account.move', cnId).name, read(db, 'account.move', cnId).amount_total);
// vendor bill partial payment
const bill = search(db, 'account.move').find((m) => m.move_type === 'in_invoice' && m.state === 'posted');
db = payMove(db, bill.id, 100, '2026-10-22');
console.log(JSON.stringify(invariants(db, 'after sale->invoice->payment, credit note, bill payment')));
