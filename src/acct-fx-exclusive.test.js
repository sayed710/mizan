import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write, unlink } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';

test('exchange entries cannot be reused by another settlement through ORM or sync', () => {
 let db = seed();
 const fx = create(db, 'res.currency', { name: 'FXEXCLUSIVE', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-01-02', rate: 1 }] }); db = fx.db;
 const makeInvoice = () => { const m = create(db, 'account.move', { move_type:'out_invoice', partner_id:1, currency_id:fx.id, invoice_date:'2026-01-01', invoice_line_ids:[{ product_id:5, qty:1, price_unit:50, tax:0 }] }); db = postMove(m.db,m.id); return m.id; };
 const first = makeInvoice();
 const p = create(db, 'account.payment', { partner_id:1, partner_type:'customer', payment_type:'inbound', amount:100, date:'2026-01-02' }); db = postPayment(p.db,read(p.db,'account.payment',p.id));
 const row = read(db,'account.move',first).payments[0]; assert.ok(row.payment_fx_move_id);
 assert.throws(() => write(db, 'account.move', row.payment_fx_move_id, { state:'draft' }), /payment|settle/i);
 assert.throws(() => unlink(db, 'account.move', [row.payment_fx_move_id]), /payment|settle|posted/i);
 const second = makeInvoice();
 const change = { amount_paid:50, payment_date:'2026-01-02', payments:[{...row}] };
 assert.throws(() => write(db,'account.move',second,change), /exchange|used|settlement/i);
 const forged = { ...db, records: { ...db.records, 'account.move':db.records['account.move'].map((m) => m.id === second ? {...m,...change} : m) } };
 assert.throws(() => applyDiff(db,diffDb(db,forged)), /exchange|used|settlement/i);
});
