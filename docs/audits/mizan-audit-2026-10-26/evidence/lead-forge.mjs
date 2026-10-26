import { seed } from './src/seed.js';
import { applyDiff } from './src/sync.js';
import { models, modelsForApps } from './src/models/index.js';
const db = seed();
const allowed = modelsForApps ? modelsForApps(['sales']) : null;
console.log('allowed sales has account.move?', allowed?.has?.('account.move'), 'size', allowed?.size);
const posted = (db.records['account.move']||[]).find(m=>m.state==='posted' && m.move_type==='out_invoice');
console.log('posted invoice', posted?.id, posted?.name, 'amount_paid', posted?.amount_paid);
const nextId = Math.max(...db.records['account.move'].map(m=>m.id))+1;
const forged = { id: nextId, name: 'MISC/2026/9999', move_type: 'entry', state: 'posted', date: '2026-10-01',
  line_ids: [{ account_id: db.records['account.account'][0].id, debit: 1000000, credit: 0 }] };
for (const [label, opts] of [['nonadmin-all-models', { isAdmin:false, allowed:null }], ['nonadmin-sales-app', { isAdmin:false, allowed }]]) {
  try { const n = applyDiff(db, { upserts: { 'account.move': [forged] } }, { author:'eve', ...opts }); console.log(label,'unbalanced posted entry ACCEPTED', !!n.records['account.move'].find(m=>m.id===nextId)); }
  catch(e){ console.log(label,'rejected:', e.message); }
  if (posted) try { const n = applyDiff(db, { upserts: { 'account.move': [{ ...posted, amount_paid: 999999, invoice_line_ids: (posted.invoice_line_ids||[]).map(l=>({...l, price_unit: 1})) }] } }, { author:'eve', ...opts }); const r=n.records['account.move'].find(m=>m.id===posted.id); console.log(label,'edit posted invoice ACCEPTED amount_paid=',r.amount_paid); }
  catch(e){ console.log(label,'edit posted rejected:', e.message); }
}
