import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postEntry, accountId } from './models/ledger.js';
import { postMove, payMove } from './models/accounting.js';
import { cashFlow } from './models/reports.js';
import { applyDiff, diffDb } from './sync.js';

test('public FX provenance fields cannot be forged through posting, ORM creation, write or sync', () => {
 const db=seed(); const spec={journal:'MISC',date:'2026-01-02',fx_payment_move_id:1,fx_invoice_id:2,lines:[{account:'600000',debit:10},{account:'450100',credit:10}]};
 assert.throws(()=>postEntry(db,spec),/exchange|provenance|fx/i);
 const posted=postEntry(db,{...spec,fx_payment_move_id:null,fx_invoice_id:null}); const original=read(posted.db,'account.move',posted.id);
 assert.throws(()=>create(db,'account.move',{...original,id:undefined,fx_payment_move_id:1,fx_invoice_id:2}),/exchange|provenance|fx/i);
 assert.throws(()=>write(posted.db,'account.move',posted.id,{fx_payment_move_id:1,fx_invoice_id:2}),/exchange|provenance|linkage|fx/i);
 const forged={...posted.db,records:{...posted.db.records,'account.move':posted.db.records['account.move'].map((m)=>m.id===posted.id?{...m,fx_payment_move_id:1,fx_invoice_id:2}:m)}};
 assert.throws(()=>applyDiff(posted.db,diffDb(posted.db,forged)),/exchange|provenance|fx/i);
 const newEntry=postEntry(db,{journal:'MISC',date:'2026-01-02',lines:[{account:'600000',debit:10},{account:'450100',credit:10}]});
 const injected={...newEntry.db,records:{...newEntry.db.records,'account.move':newEntry.db.records['account.move'].map((m)=>m.id===newEntry.id?{...m,fx_payment_move_id:1,fx_invoice_id:2}:m)}};
 const synced=applyDiff(db,diffDb(db,injected));
 assert.equal(read(synced,'account.move',newEntry.id).fx_payment_move_id,undefined);
 assert.equal(read(synced,'account.move',newEntry.id).fx_invoice_id,undefined);
});

test('foreign asset bill cash flow classifies payment-date cash as investing', () => {
 let db=seed(); const fx=create(db,'res.currency',{name:'CASHFX',rate_ids:[{date:'2026-01-01',rate:2},{date:'2026-01-02',rate:1}]}); db=fx.db;
 const bill=create(db,'account.move',{move_type:'in_invoice',partner_id:1,currency_id:fx.id,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:100,tax:0,account_id:accountId(db,'151000')}]});
 db=payMove(postMove(bill.db,bill.id),bill.id,100,'2026-01-02');
 const flow=cashFlow(db,{from:'2026-01-02',to:'2026-01-02'}); assert.deepEqual([flow.investing,flow.operating,flow.net],[-100,0,-100]);
});

test('a one-cent exchange difference cannot be satisfied by an entry without the counterpart', async () => {
 const { postPayment } = await import('./models/pay.js'); const { write } = await import('./orm.js');
 let db=seed(); const fx=create(db,'res.currency',{name:'CENTFX',rate_ids:[{date:'2026-01-01',rate:2},{date:'2026-01-02',rate:1}]}); db=fx.db;
 const p=create(db,'account.payment',{partner_id:1,partner_type:'customer',payment_type:'inbound',amount:0.02,date:'2026-01-02'}); db=postPayment(p.db,read(p.db,'account.payment',p.id));
 const inv=create(db,'account.move',{move_type:'out_invoice',partner_id:1,currency_id:fx.id,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:0.02,tax:0}]}); db=postMove(inv.db,inv.id);
 const source=read(db,'account.payment',p.id).move_id;
 const entry=postEntry(db,{journal:'MISC',date:'2026-01-02',lines:[{account:'600000',debit:0.01},{account:'450100',credit:0.01}]});
 const changes={amount_paid:0.02,payment_date:'2026-01-02',payments:[{date:'2026-01-02',amount:0.02,move_id:source,company_amount:0.01,payment_company_amount:0.02,payment_fx_move_id:entry.id}]};
 const staged={...entry.db,records:{...entry.db.records,'account.move':entry.db.records['account.move'].map((m)=>m.id===entry.id?{...m,fx_payment_move_id:source,fx_invoice_id:inv.id}:m)}};
 assert.throws(()=>write(staged,'account.move',inv.id,changes),/exchange/i);
 const submitted={...staged,records:{...staged.records,'account.move':staged.records['account.move'].map((m)=>m.id===inv.id?{...m,...changes}:m)}};
 assert.throws(()=>applyDiff(db,diffDb(db,submitted)),/exchange/i);
});

test('standalone foreign asset bill payment and reversal classify actual cash as investing', async () => {
 const { postPayment, reversePayment } = await import('./models/pay.js');
 let db=seed(); const fx=create(db,'res.currency',{name:'CASHSTANDALONE',rate_ids:[{date:'2026-01-01',rate:2},{date:'2026-01-02',rate:1}]}); db=fx.db;
 const bill=create(db,'account.move',{move_type:'in_invoice',partner_id:1,currency_id:fx.id,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:100,tax:0,account_id:accountId(db,'151000')}]}); db=postMove(bill.db,bill.id);
 const payment=create(db,'account.payment',{partner_id:1,partner_type:'supplier',payment_type:'outbound',amount:100,date:'2026-01-02'}); db=postPayment(payment.db,read(payment.db,'account.payment',payment.id));
 let flow=cashFlow(db,{from:'2026-01-02',to:'2026-01-02'}); assert.deepEqual([flow.investing,flow.operating,flow.net],[-100,0,-100]);
 db=reversePayment(db,read(db,'account.payment',payment.id),'2026-01-03');
 flow=cashFlow(db,{from:'2026-01-03',to:'2026-01-03'}); assert.deepEqual([flow.investing,flow.operating,flow.net],[100,0,100]);
});

test('a generated one-cent exchange entry clears the receivable and settles the invoice', async () => {
 const { postPayment } = await import('./models/pay.js');
 let db=seed(); const fx=create(db,'res.currency',{name:'VALIDCENTFX',rate_ids:[{date:'2026-01-01',rate:2},{date:'2026-01-02',rate:1}]}); db=fx.db;
 const inv=create(db,'account.move',{move_type:'out_invoice',partner_id:1,currency_id:fx.id,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:0.02,tax:0}]}); db=postMove(inv.db,inv.id);
 const p=create(db,'account.payment',{partner_id:1,partner_type:'customer',payment_type:'inbound',amount:0.02,date:'2026-01-02'}); db=postPayment(p.db,read(p.db,'account.payment',p.id));
 const invoice=read(db,'account.move',inv.id); const payment=read(db,'account.payment',p.id); const entry=read(db,'account.move',invoice.payments[0].payment_fx_move_id);
 const receivable=accountId(db,'121000');
 const net=[invoice,read(db,'account.move',payment.move_id),entry].flatMap((m)=>m.line_ids).filter((l)=>l.account_id===receivable && l.partner_id===1).reduce((sum,l)=>sum+(l.debit||0)-(l.credit||0),0);
 assert.equal(Math.round(net*100),0); assert.equal(invoice.amount_residual,0);
});

test('legitimate generated exchange entry synchronizes with its settlement', async () => {
 const { postPayment } = await import('./models/pay.js');
 let db=seed(); const fx=create(db,'res.currency',{name:'SYNCFX',rate_ids:[{date:'2026-01-01',rate:2},{date:'2026-01-02',rate:1}]}); db=fx.db;
 const inv=create(db,'account.move',{move_type:'out_invoice',partner_id:1,currency_id:fx.id,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:100,tax:0}]}); db=postMove(inv.db,inv.id);
 const p=create(db,'account.payment',{partner_id:1,partner_type:'customer',payment_type:'inbound',amount:25,date:'2026-01-02'}); db=p.db;
 const booked=postPayment(db,read(db,'account.payment',p.id));
 const synced=applyDiff(db,diffDb(db,booked)); assert.equal(read(synced,'account.move',inv.id).amount_residual,75);
});

test('foreign asset invoice receipt and its reversal classify the full cash movement', async () => {
 const { reversePayment }=await import('./models/pay.js'); let db=seed(); const fx=create(db,'res.currency',{name:'SELLFX',rate_ids:[{date:'2026-01-01',rate:2},{date:'2026-01-02',rate:1}]}); db=fx.db;
 const inv=create(db,'account.move',{move_type:'out_invoice',partner_id:1,currency_id:fx.id,invoice_date:'2026-01-01',invoice_line_ids:[{product_id:5,qty:1,price_unit:100,tax:0,account_id:accountId(db,'151000')}]}); db=payMove(postMove(inv.db,inv.id),inv.id,100,'2026-01-02');
 const p=db.records['account.payment'].find((r)=>r.invoice_id===inv.id); db=reversePayment(db,p,'2026-01-03');
 const original=cashFlow(db,{from:'2026-01-02',to:'2026-01-02'}); assert.deepEqual([original.investing,original.operating],[100,0]);
 const reversal=cashFlow(db,{from:'2026-01-03',to:'2026-01-03'}); assert.deepEqual([reversal.investing,reversal.operating],[-100,0]);
});
