import { seed, models, orm, btn, tryIt, ledger, ledgerDelta, newIds, log } from './lib.mjs';
const { create, read, search, write } = orm;
let db = seed();
log('product 6 purchase_method', read(db, 'product', 6).purchase_method, 'type', read(db, 'product', 6).type);
const pline = (pid, qty, price) => ({ ...models['purchase.order'].fields.order_line.onchange({ product_id: pid, qty, price_unit: 0, discount: 0 }, 'product_id', db, {}), qty, price_unit: price });
const s2 = create(db, 'purchase.order', { partner_id: 2, order_line: [pline(8, 2, 120)] });
let d2 = btn(s2.db, 'purchase.order', s2.id, 'Confirm Order').db;
const rp = search(d2, 'stock.picking').find((p) => p.purchase_id === s2.id);
d2 = btn(d2, 'stock.picking', rp.id, 'Validate').db;
const ob = btn(d2, 'purchase.order', s2.id, 'Create Bill');
const b3 = newIds(d2, ob.db, 'account.move')[0];
log('bill', b3, 'is' , read(ob.db,'account.move',b3).move_type, read(ob.db,'account.move',b3).state);
for (const [label, vals] of [['qty 20', { qty: 20 }], ['price 999', { price_unit: 999 }]]) {
  const x = write(ob.db, 'account.move', b3, { invoice_line_ids: read(ob.db, 'account.move', b3).invoice_line_ids.map((l) => ({ ...l, ...vals })) });
  const p = tryIt(() => btn(x, 'account.move', b3, 'Confirm'));
  if (!p.ok) { log(label, 'REFUSED', p.error); continue; }
  const m = read(p.value.db, 'account.move', b3);
  log(label, 'visible', p.value.visible, 'state', m.state, 'lines', JSON.stringify(m.line_ids.map(l => [read(p.value.db,'account.account',l.account_id)?.code, l.debit, l.credit])), 'delta', JSON.stringify(ledgerDelta(ledger(x), ledger(p.value.db))));
}
// service on PO
const s3 = create(db, 'purchase.order', { partner_id: 2, order_line: [pline(6, 3, 50)] });
let d3 = btn(s3.db, 'purchase.order', s3.id, 'Confirm Order').db;
log('service-only PO: pickings', search(d3, 'stock.picking').filter(p=>p.purchase_id===s3.id).length, 'invoice_status', read(d3,'purchase.order',s3.id).invoice_status, 'Create Bill:', tryIt(() => btn(d3, 'purchase.order', s3.id, 'Create Bill', {force:true})).error ?? 'ok');
