import { seed, models, orm, serverSync } from './lib.mjs';
const { create, read } = orm;
const db = seed();
const l = models['sale.order'].fields.order_line.onchange({ product_id: 1, qty: 5, price_unit: 0, discount: 0 }, 'product_id', db, {});
console.log('client line keys', Object.keys(l).join(','));
const r = create(db, 'sale.order', { partner_id: 1, order_line: [l] });
const s = serverSync(db, r.db);
console.log('server line keys', Object.keys(s.db.records['sale.order'].find(x=>x.id===r.id).order_line[0]).join(','));
console.log('declared line subfields', Object.keys(models['sale.order'].fields.order_line.fields).join(','));
