import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment, reversePayment } from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';

test('unrelated FX entries cannot be linked to no-difference or invoice-linked payments through ORM or sync', () => {
 for (const invoiceLinked of [false, true]) {
  let db = seed();
  const make = (amount) => { const m=create(db,'account.move',{move_type:'out_invoice',partner_id:1,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:amount,tax:0}]}); db=postMove(m.db,m.id); return m.id; };
  let paymentId;
  if (invoiceLinked) { const first=make(10); db=payMove(db,first,20,'2026-01-02'); paymentId=db.records['account.payment'].find((p)=>p.invoice_id===first).id; }
  else { const p=create(db,'account.payment',{partner_id:1,partner_type:'customer',payment_type:'inbound',amount:20,date:'2026-01-02'}); db=postPayment(p.db,read(p.db,'account.payment',p.id)); paymentId=p.id; }
  const payment=read(db,'account.payment',paymentId); const inv=make(10);
  const unrelated=postEntry(db,{journal:'MISC',date:'2026-01-02',ref:'Unrelated',lines:[{account:'600000',debit:7},{account:'101401',credit:7}]}); db=unrelated.db;
  const changes={amount_paid:10,payment_date:'2026-01-02',payments:[{date:'2026-01-02',amount:10,move_id:payment.move_id,company_amount:10,payment_fx_move_id:unrelated.id}]};
  assert.throws(()=>write(db,'account.move',inv,changes),/exchange|fx/i);
  const forged={...db,records:{...db.records,'account.move':db.records['account.move'].map((m)=>m.id===inv?{...m,...changes}:m)}};
  assert.throws(()=>applyDiff(db,diffDb(db,forged)),/exchange|fx/i);
  // An already-stored invalid link is also refused before reversal can post anything.
  assert.throws(()=>reversePayment(forged,read(forged,'account.payment',paymentId),'2026-01-03'),/exchange|fx/i);
  db=reversePayment(db,read(db,'account.payment',paymentId),'2026-01-03');
  assert.equal(db.records['account.move'].some((m)=>m.reversed_entry_id===unrelated.id),false);
 }
});

test('a matching but unrelated exchange entry cannot substitute for the dedicated settlement entry', () => {
 let db=seed(); const fx=create(db,'res.currency',{name:'FXPROVENANCE',rate_ids:[{date:'2026-01-01',rate:2},{date:'2026-01-02',rate:1}]}); db=fx.db;
 const p=create(db,'account.payment',{partner_id:1,partner_type:'customer',payment_type:'inbound',amount:20,date:'2026-01-02'}); db=postPayment(p.db,read(p.db,'account.payment',p.id));
 const inv=create(db,'account.move',{move_type:'out_invoice',partner_id:1,currency_id:fx.id,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:20,tax:0}]}); db=postMove(inv.db,inv.id);
 const unrelated=postEntry(db,{journal:'MISC',date:'2026-01-02',ref:'Unrelated',lines:[{account:'121000',debit:10,partner_id:1},{account:'450100',credit:10}]}); db=unrelated.db;
 const change={amount_paid:20,payment_date:'2026-01-02',payments:[{date:'2026-01-02',amount:20,move_id:read(db,'account.payment',p.id).move_id,company_amount:10,payment_company_amount:20,payment_fx_move_id:unrelated.id}]};
 assert.throws(()=>write(db,'account.move',inv.id,change),/exchange/i);
 const forged={...db,records:{...db.records,'account.move':db.records['account.move'].map((m)=>m.id===inv.id?{...m,...change}:m)}};
 assert.throws(()=>applyDiff(db,diffDb(db,forged)),/exchange/i);
});

test('ORM cannot forge exchange provenance on a draft before posting and settlement', () => {
 let db=seed();
 const fx=create(db,'res.currency',{name:'DRAFTFX',rate_ids:[{date:'2026-01-01',rate:2},{date:'2026-01-02',rate:1}]}); db=fx.db;
 const p=create(db,'account.payment',{partner_id:1,partner_type:'customer',payment_type:'inbound',amount:20,date:'2026-01-02'}); db=postPayment(p.db,read(p.db,'account.payment',p.id));
 const inv=create(db,'account.move',{move_type:'out_invoice',partner_id:1,currency_id:fx.id,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:20,tax:0}]}); db=postMove(inv.db,inv.id);
 const entry=create(db,'account.move',{move_type:'entry',invoice_date:'2026-01-02',line_ids:[{account_id:db.records['account.account'].find((a)=>a.code==='121000').id,partner_id:1,debit:10,credit:0},{account_id:db.records['account.account'].find((a)=>a.code==='450100').id,debit:0,credit:10}]}); db=entry.db;
 assert.throws(()=>write(db,'account.move',entry.id,{fx_payment_move_id:read(db,'account.payment',p.id).move_id,fx_invoice_id:inv.id}),/exchange|provenance/i);
});
