import { seed, orm } from './lib.mjs';
const db = seed();
console.log('boms', JSON.stringify(db.records['mrp.bom']));
console.log('workcenters', JSON.stringify(db.records['mrp.workcenter']?.map(w => [w.id, w.name, w.costs_hour])));
console.log('MOs', JSON.stringify(db.records['mrp.production']?.map(m => [m.id, m.name, m.state, m.product_id, m.product_qty])));
console.log('employees', db.records['hr.employee'].length, 'GL 110100 at seed', db.records['account.move'].flatMap(m=>m.line_ids??[]).filter(l=>l.account_id===db.records['account.account'].find(a=>a.code==='110100').id).reduce((s,l)=>s+l.debit-l.credit,0));
console.log('seed layers', JSON.stringify(db.records['stock.valuation.layer'].map(l=>[l.product_id,l.quantity,l.value,l.opening,l.move_id])));
