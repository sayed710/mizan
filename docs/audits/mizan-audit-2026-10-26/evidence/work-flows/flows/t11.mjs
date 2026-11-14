import { seed, orm, btn, tryIt, ledger, newIds, prompts, log } from './lib.mjs';
const { create, read, search } = orm;
let db = seed();
let r = create(db, 'sale.order', { partner_id: 5, order_line: [{ product_id: 6, qty: 10, price_unit: 45, tax: 0 }] });
db = btn(btn(r.db, 'sale.order', r.id, 'Confirm').db, 'sale.order', r.id, 'Create Invoice').db;
const inv = search(db, 'account.move').find((m) => m.sale_id === r.id).id;
db = btn(db, 'account.move', inv, 'Confirm').db;
const ar0 = ledger(db, { partner: 5 })['121000'] ?? 0;
for (let i = 0; i < 2; i++) { const b = db; const out = btn(db, 'account.move', inv, 'Credit Note'); log('Credit Note click', i + 1, 'visible', out.visible); db = out.db; const cn = newIds(b, db, 'account.move')[0]; db = btn(db, 'account.move', cn, 'Confirm').db; }
const I = read(db, 'account.move', inv);
log('invoice total', I.amount_total, 'after 2 posted credit notes: invoice payment_state', I.payment_state, 'residual', I.amount_residual, '| partner receivable', ar0, '->', ledger(db, { partner: 5 })['121000']);
prompts.push(String(I.amount_residual));
const paid = btn(db, 'account.move', inv, 'Register Payment');
log('Register Payment still offered:', paid.visible, '-> partner receivable after paying', ledger(paid.db, { partner: 5 })['121000']);
