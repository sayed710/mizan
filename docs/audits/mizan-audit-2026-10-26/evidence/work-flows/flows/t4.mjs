import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, log } from './lib.mjs';
const { create, read, search, write } = orm;
let db = seed();
let r = create(db, 'mrp.production', { product_id: 2, bom_id: 1, product_qty: 2 }); db = btn(r.db, 'mrp.production', r.id, 'Confirm').db;
const before = db;
db = btn(db, 'mrp.production', r.id, 'Produce').db;
const s = serverSync(before, db); log('lost on produce sync:', s.lost.map((x) => x.split(':')[0]).join(' | '));
log('desk cost after 1 MO', read(db, 'product', 2).cost, 'qty', read(db, 'product', 2).qty_available);
// re-confirm the done MO via run() (UI hides it) then produce again
const again = btn(db, 'mrp.production', r.id, 'Confirm', { force: true }).db;
const twice = tryIt(() => btn(again, 'mrp.production', r.id, 'Produce').db);
log('re-confirm done MO then Produce:', twice.ok ? `ACCEPTED desk ${read(db, 'product', 2).qty_available} -> ${read(twice.value, 'product', 2).qty_available}, oak ${read(db, 'product', 7).qty_available} -> ${read(twice.value, 'product', 7).qty_available}` : twice.error);
// server: forge MO done -> confirmed as non-admin
const forged = tryIt(() => serverSync(db, write(db, 'mrp.production', r.id, { state: 'confirmed' })));
log('server accepts done -> confirmed MO forged by non-admin:', forged.ok ? 'ACCEPTED' : forged.error);
// consumed 0 dilutes standard cost
let z = create(db, 'mrp.production', { product_id: 2, bom_id: 1, product_qty: 20 }); let zd = btn(z.db, 'mrp.production', z.id, 'Confirm').db;
zd = write(zd, 'mrp.production', z.id, { move_raw: read(zd, 'mrp.production', z.id).move_raw.map((m) => ({ ...m, consumed: 0 })) });
const zp = btn(zd, 'mrp.production', z.id, 'Produce').db;
log('MO 20 desks consuming nothing: desk cost', read(zd, 'product', 2).cost, '->', read(zp, 'product', 2).cost, 'stock value of desks', search(zp, 'stock.valuation.layer').filter((l) => l.product_id === 2).reduce((s, l) => s + (l.remaining_value || 0), 0));
