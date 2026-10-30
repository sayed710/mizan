import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, newIds, prompts, log } from './lib.mjs';
const { create, read, search, write } = orm;
const wo = await import('../src/models/workorder.js');
const { valuationReport } = await import('../src/models/valuation.js');
let db = seed();
const step = (name, prev, next) => { const s = serverSync(prev, next); log(`[sync ${name}] lost: ${s.lost.length}`, s.lost.slice(0, 3).join(' ; ')); return s.db; };
const qty = (id) => read(db, 'product', id).qty_available;
const L0 = ledger(db); const V0 = valuationReport(db);
log('start: desk', qty(2), 'oak', qty(7), 'frame', qty(8), 'screws', qty(9), '| desk cost', read(db, 'product', 2).cost, 'method', read(db, 'product', 2).cost_method);
let r = create(db, 'mrp.production', { product_id: 2, bom_id: 1, product_qty: 2 });
let prev = db; db = step('create MO', prev, r.db); const mo = r.id;
prev = db; db = btn(db, 'mrp.production', mo, 'Confirm').db; db = step('confirm', prev, db);
log('confirmed', read(db, 'mrp.production', mo).state, 'move_raw', JSON.stringify(read(db, 'mrp.production', mo).move_raw), 'avail', read(db, 'mrp.production', mo).components_availability);
// another MO that wants all the frames: availability is not a reservation
const r2 = create(db, 'mrp.production', { product_id: 2, bom_id: 1, product_qty: 25 }); let d2 = btn(r2.db, 'mrp.production', r2.id, 'Confirm').db;
log('2nd MO for 25 (frames on hand 25): avail', read(d2, 'mrp.production', r2.id).components_availability, '| 1st MO still', read(d2, 'mrp.production', mo).components_availability);
prev = db; db = btn(db, 'mrp.production', mo, 'Plan Work Orders').db; db = step('plan WOs', prev, db);
const wos = search(db, 'mrp.workorder').filter((w) => w.production_id === mo);
log('workorders', JSON.stringify(wos.map((w) => [w.id, w.name, w.state, w.duration_expected])));
log('Produce before WOs done:', tryIt(() => btn(db, 'mrp.production', mo, 'Produce')).error);
// UI path: Start button (default time = now) then send to server
{ const pre = write(db, 'mrp.workorder', wos[0].id, { employee_id: 1 }); log('Start without operator:', tryIt(() => btn(db, 'mrp.workorder', wos[0].id, 'Start')).error); const st = btn(pre, 'mrp.workorder', wos[0].id, 'Start'); log('WO Start (button) client state', read(st.db, 'mrp.workorder', wos[0].id).state, 'date_start', read(st.db, 'mrp.workorder', wos[0].id).date_start);
  const sv = tryIt(() => serverSync(pre, st.db)); log('server applyDiff of WO Start:', sv.ok ? 'ACCEPTED' : 'REFUSED -> ' + sv.error); }
const syncOff = true;
// run the work orders with explicit times: 90 + 20 minutes at 25/h (client-only from here on for WOs)
db = wo.startWorkorder(db, wos[0].id, { employeeId: 1, at: '2026-10-26T08:00:00.000Z' });
db = wo.finishWorkorder(db, wos[0].id, { at: '2026-10-26T09:30:00.000Z' });
db = wo.startWorkorder(db, wos[1].id, { employeeId: 1, at: '2026-10-26T09:30:00.000Z' });
db = wo.finishWorkorder(db, wos[1].id, { at: '2026-10-26T09:50:00.000Z' });
log('production cost estimate', JSON.stringify(wo.productionCost(db, mo)));
prev = db; const Lp = ledger(db);
const out = btn(db, 'mrp.production', mo, 'Produce'); db = out.db; { const x = tryIt(() => serverSync(prev, db)); log('[sync produce]', x.ok ? 'lost ' + x.value.lost.length + ' ' + x.value.lost.slice(0,3).join(' ; ') : 'REFUSED -> ' + x.error); }
log('after produce: state', read(db, 'mrp.production', mo).state, 'desk', qty(2), 'oak', qty(7), 'frame', qty(8), 'screws', qty(9));
log('produce GL delta', JSON.stringify(ledgerDelta(Lp, ledger(db))));
const deskLayers = search(db, 'stock.valuation.layer').filter((l) => l.product_id === 2).slice(-2);
log('desk layers (last 2)', JSON.stringify(deskLayers.map((l) => [l.kind, l.quantity, l.unit_cost, l.value, l.move_id])), 'desk cost now', read(db, 'product', 2).cost, '(standard)');
log('Produce again:', tryIt(() => btn(db, 'mrp.production', mo, 'Produce', { force: true })).error);
log('Confirm again (hidden) on done MO:', (() => { const x = tryIt(() => btn(db, 'mrp.production', mo, 'Confirm', { force: true })); return x.ok ? 'ACCEPTED state ' + read(x.value.db, 'mrp.production', mo).state : x.error; })());
log('Cancel done MO (hidden):', (() => { const x = btn(db, 'mrp.production', mo, 'Cancel', { force: true }); return 'state ' + read(x.db, 'mrp.production', mo).state + ', desk on hand still ' + read(x.db, 'product', 2).qty_available; })());
// consumed = 0 by hand: finished goods without consuming components
let z = create(db, 'mrp.production', { product_id: 2, bom_id: 1, product_qty: 3 }); let zd = btn(z.db, 'mrp.production', z.id, 'Confirm').db;
zd = write(zd, 'mrp.production', z.id, { move_raw: read(zd, 'mrp.production', z.id).move_raw.map((m) => ({ ...m, consumed: 0 })) });
const zp = btn(zd, 'mrp.production', z.id, 'Produce').db;
log('MO of 3 with consumed=0 typed on every component: desk', read(zd, 'product', 2).qty_available, '->', read(zp, 'product', 2).qty_available, 'oak', read(zd, 'product', 7).qty_available, '->', read(zp, 'product', 7).qty_available, '| GL', JSON.stringify(ledgerDelta(ledger(zd), ledger(zp))));
// over-consumption beyond stock
let o = create(db, 'mrp.production', { product_id: 2, bom_id: 1, product_qty: 100 }); let od = btn(o.db, 'mrp.production', o.id, 'Confirm').db;
log('MO of 100 (components short):', tryIt(() => btn(od, 'mrp.production', o.id, 'Produce')).error);
// partial production -> backorder
let p = create(db, 'mrp.production', { product_id: 2, bom_id: 1, product_qty: 4 }); let pd = btn(p.db, 'mrp.production', p.id, 'Confirm').db;
pd = write(pd, 'mrp.production', p.id, { qty_producing: 1 });
const pp = btn(pd, 'mrp.production', p.id, 'Produce');
log('produce 1 of 4: MO', read(pp.db, 'mrp.production', p.id).state, read(pp.db, 'mrp.production', p.id).product_qty, '| backorder', JSON.stringify(search(pp.db, 'mrp.production').filter((m) => m.backorder_of === p.id).map((m) => [m.name, m.state, m.product_qty])));
// valuation vs GL after MRP
const V = valuationReport(db);
log('valuation report change (all products)', Math.round((Object.values(V).reduce((s, x) => s + x.value, 0) - Object.values(V0).reduce((s, x) => s + x.value, 0)) * 100) / 100, 'vs GL 110100 change', ledgerDelta(L0, ledger(db))['110100']);
