import { seed, orm, ledger } from './lib.mjs';
const db = seed();
console.log(Object.keys(db.records).length, 'models seeded; accounts', db.records['account.account'].length);
console.log('partners', db.records['res.partner'].map(p=>p.id+':'+p.name).join(' | '));
console.log('products', db.records.product.map(p=>p.id+':'+p.name+':'+p.qty_available+':'+(p.cost_method??'-')+':'+(p.valuation??'-')).join(' | '));
console.log('companies', JSON.stringify(db.records['res.company']));
console.log('warehouses', JSON.stringify(db.records['stock.warehouse']));
console.log('layers', (db.records['stock.valuation.layer']??[]).length, 'moves', db.records['account.move'].length);
console.log('settings', JSON.stringify(db.settings).slice(0,300));
