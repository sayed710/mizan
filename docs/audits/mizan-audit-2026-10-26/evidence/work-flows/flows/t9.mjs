import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, log } from './lib.mjs';
const { create, read, search, write } = orm;
let db = seed();
let r = create(db, 'sale.order', { partner_id: 3, order_line: [{ product_id: 4, qty: 2, price_unit: 35, tax: 0 }] }); db = btn(r.db, 'sale.order', r.id, 'Confirm').db;
const pk = search(db, 'stock.picking').find((p) => p.sale_id === r.id);
log('picking form locked while ready?', models['stock.picking'].form.lockedWhen(pk), '| move_ids readonly?', !!models['stock.picking'].fields.move_ids.readonly);
const big = write(db, 'stock.picking', pk.id, { move_ids: pk.move_ids.map((l) => ({ ...l, qty: 10 })) });
const v = tryIt(() => btn(big, 'stock.picking', pk.id, 'Validate').db);
log('SO for 2, user edits delivery demand to 10 and validates:', v.ok ? `ACCEPTED lamp ${read(db, 'product', 4).qty_available} -> ${read(v.value, 'product', 4).qty_available}, qty_delivered ${read(v.value, 'sale.order', r.id).order_line[0].qty_delivered}` : v.error);
// return of a normal delivery
db = btn(db, 'stock.picking', pk.id, 'Validate').db;
const L = ledger(db);
const ret = btn(db, 'stock.picking', pk.id, 'Return'); const rid = Number(ret.go.split('/').at(-1));
log('return picking', read(ret.db, 'stock.picking', rid).name, read(ret.db, 'stock.picking', rid).state, 'sale_id', read(ret.db, 'stock.picking', rid).sale_id);
const back = btn(ret.db, 'stock.picking', rid, 'Validate').db;
log('after return validated: lamp', read(back, 'product', 4).qty_available, 'SO qty_delivered', read(back, 'sale.order', r.id).order_line[0].qty_delivered, 'GL', JSON.stringify(ledgerDelta(L, ledger(back))));
log('Return the same delivery twice:', (() => { const a = btn(back, 'stock.picking', pk.id, 'Return'); const id2 = Number(a.go.split('/').at(-1)); const b2 = tryIt(() => btn(a.db, 'stock.picking', id2, 'Validate').db); return b2.ok ? `ACCEPTED lamp -> ${read(b2.value, 'product', 4).qty_available} (2 delivered, 4 returned)` : b2.error; })());
