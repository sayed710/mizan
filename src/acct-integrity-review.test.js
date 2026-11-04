import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { createCompany } from './models/company.js';
import { applyDiff, diffDb } from './sync.js';
const invoice = (db, company_id = 1, type = 'out_invoice') => { const m = create(db, 'account.move', { company_id, move_type:type, partner_id:1, invoice_date:'2026-01-01', invoice_line_ids:[{ product_id:5, qty:1, price_unit:100, tax:0 }] }); return {db:postMove(m.db,m.id), id:m.id}; };
const payment = (db, company_id = 1, side = 'customer', direction = 'inbound') => { const p = create(db, 'account.payment', { company_id, partner_id:1, partner_type:side, payment_type:direction, amount:10, date:'2026-01-10' }); return { id:p.id, db:postPayment(p.db,read(p.db,'account.payment',p.id)) }; };
test('public application cannot forge company amount to exceed payment capacity', () => {
 let p=payment(seed()); let m=invoice(p.db); const move=read(m.db,'account.payment',p.id).move_id;
 assert.throws(() => write(m.db,'account.move',m.id,{amount_paid:100,payment_date:'2026-01-11',payments:[{date:'2026-01-11',amount:100,move_id:move,payment_company_amount:0,company_amount:0}]}),/amount|capacity|settle/i);
});
test('public application requires a date on or after its payment', () => {
 let p=payment(seed()); let m=invoice(p.db); const move=read(m.db,'account.payment',p.id).move_id;
 for (const date of [null,'2026-01-09']) assert.throws(() => write(m.db,'account.move',m.id,{amount_paid:5,payment_date:date,payments:[{date,amount:5,move_id:move}]}),/date/i);
});
test('payment and settlement use company-owned receivable and payable accounts', () => {
 let db=seed(); const co=createCompany(db,{name:'Scoped accounts'}); db=co.db;
 for(const [code,name,type] of [['121000','Scoped AR','asset_receivable'],['211000','Scoped AP','liability_payable'],['101401','Scoped Bank','asset_cash']]) db=create(db,'account.account',{company_id:co.id,code,name,account_type:type}).db;
 for(const [type,side,direction,code] of [['out_invoice','customer','inbound','121000'],['in_invoice','supplier','outbound','211000']]) {
  const m=invoice(db,co.id,type); db=m.db; const account=db.records['account.account'].find(a=>a.company_id===co.id && a.code===code);
  assert.ok(read(db,'account.move',m.id).line_ids.some(l=>l.account_id===account.id));
  const before = db; const p=payment(db,co.id,side,direction); db=p.db; assert.equal(read(db,'account.move',m.id).amount_residual,90);
  const synced = applyDiff(before, diffDb(before, db));
  assert.equal(read(synced, 'account.move', m.id).amount_residual, 90);
 }
});
