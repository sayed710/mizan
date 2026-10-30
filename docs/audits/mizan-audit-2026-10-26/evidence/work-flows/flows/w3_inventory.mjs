import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, newIds, prompts, log, applyDiff, diffDb } from './lib.mjs';
const { create, read, search, write } = orm;
const { freeQty, pickingAvailability } = await import('../src/models/picking.js');
const { valuationReport } = await import('../src/models/valuation.js');
const { locationStock } = await import('../src/models/routes.js');
let db = seed();
const L0 = ledger(db);
const step = (name, prev, next) => { const s = serverSync(prev, next); if (s.lost.length) log(`[sync ${name}] lost: ${s.lost.length}`, s.lost.slice(0, 4).join(' ; ')); return s.db; };
let r = create(db, 'product', { name: 'Flow Widget', type: 'goods', cost: 10, list_price: 30, cost_method: 'fifo', qty_available: 0 });
let prev = db; db = step('product', prev, r.db); const P = r.id;
const wh = read(db, 'stock.warehouse', 1);
const receipt = (qty) => { const c = create(db, 'stock.picking', { picking_type: 'incoming', partner_id: 2, origin: 'manual', state: 'draft', location_id: null, location_dest_id: wh.lot_stock_id, move_ids: [{ product_id: P, qty }] }); return c; };
// 1. receipt of 10 at cost 10
r = receipt(10); prev = db; db = r.db;
db = btn(db, 'stock.picking', r.id, 'Mark as Todo').db; log('receipt after Mark as Todo:', read(db, 'stock.picking', r.id).state);
db = btn(db, 'stock.picking', r.id, 'Validate').db; db = step('receipt1', prev, db);
log('after receipt 10@10: on hand', read(db, 'product', P).qty_available, 'GL', JSON.stringify(ledgerDelta(L0, ledger(db))));
// 2. second receipt at cost 12 (FIFO)
db = write(db, 'product', P, { cost: 12 });
r = receipt(10); prev = db; db = btn(btn(r.db, 'stock.picking', r.id, 'Mark as Todo').db, 'stock.picking', r.id, 'Validate').db; db = step('receipt2', prev, db);
log('after receipt 10@12: on hand', read(db, 'product', P).qty_available, 'layers', JSON.stringify(search(db, 'stock.valuation.layer').filter((l) => l.product_id === P).map((l) => [l.quantity, l.value, l.remaining_qty])));
// 3. two sales orders of 15 each against 20 on hand
const so = (qty) => { const c = create(db, 'sale.order', { partner_id: 3, order_line: [{ product_id: P, qty, price_unit: 30, tax: 0 }] }); db = btn(c.db, 'sale.order', c.id, 'Confirm').db; return search(db, 'stock.picking').find((p) => p.sale_id === c.id); };
const d1 = so(15); const d2 = so(15);
log('two deliveries of 15 vs 20 on hand: states', read(db, 'stock.picking', d1.id).state, read(db, 'stock.picking', d2.id).state, '| availability d1', pickingAvailability(db, read(db, 'stock.picking', d1.id)), 'd2', pickingAvailability(db, read(db, 'stock.picking', d2.id)), '| freeQty excluding nothing', freeQty(db, P));
log('Check Availability visible on d2?', models['stock.picking'].form.buttons.find((b) => b.label === 'Check Availability').when(read(db, 'stock.picking', d2.id)));
// a third manual delivery of 1 now: reserve
const m3 = create(db, 'stock.picking', { picking_type: 'outgoing', partner_id: 3, state: 'draft', move_ids: [{ product_id: P, qty: 1 }] });
const m3r = btn(m3.db, 'stock.picking', m3.id, 'Mark as Todo').db;
log('manual delivery of 1 after Mark as Todo:', read(m3r, 'stock.picking', m3.id).state, '(stock 20, reserved 30 by ready deliveries)');
const m3v = tryIt(() => btn(m3r, 'stock.picking', m3.id, 'Validate').db);
log('validate that WAITING delivery anyway (Validate is shown for waiting):', m3v.ok ? `ACCEPTED on hand ${read(m3v.value, 'product', P).qty_available}` : m3v.error);
// 4. validate d2 then d1
prev = db; const Lb = ledger(db); { const x = tryIt(() => btn(db, 'stock.picking', d2.id, 'Validate').db); if (!x.ok) log('deliver d2 error', x.error); else db = step('deliver d2', prev, x.value); }
log('deliver 15: on hand', read(db, 'product', P).qty_available, 'COGS/stock delta', JSON.stringify(ledgerDelta(Lb, ledger(db))), '(FIFO expected 10*10+5*12=160)');
const v1 = tryIt(() => btn(db, 'stock.picking', d1.id, 'Validate').db);
log('validate d1 (15) with 5 left:', v1.ok ? `ACCEPTED on hand ${read(v1.value, 'product', P).qty_available}` : 'REFUSED ' + v1.error);
// partial 5 with backorder
const part = write(db, 'stock.picking', d1.id, { move_ids: read(db, 'stock.picking', d1.id).move_ids.map((l) => ({ ...l, quantity: 5 })) });
prev = db; db = btn(part, 'stock.picking', d1.id, 'Validate').db; db = step('partial d1', prev, db);
const bo = search(db, 'stock.picking').find((p) => p.backorder_id === d1.id);
log('partial 5: on hand', read(db, 'product', P).qty_available, 'backorder', bo?.name, bo?.state, JSON.stringify(bo?.move_ids?.map((l) => l.qty)));
// 5. valuation reconciliation
const rep = valuationReport(db)[P];
log('valuationReport', JSON.stringify(rep), 'GL 110100 delta whole flow', ledgerDelta(L0, ledger(db))['110100'], 'interim 110200 delta', ledgerDelta(L0, ledger(db))['110200']);
const all = valuationReport(db); const sumVal = Object.values(all).reduce((s, x) => s + x.value, 0);
log('ALL products: valuation report total', Math.round(sumVal * 100) / 100, 'vs GL 110100 balance', ledger(db)['110100']);
log('locationStock of widget', JSON.stringify(locationStock(db, P)));
// 6. periodic product goes negative
let pdb = write(db, 'product', P, { valuation: 'manual_periodic' });
const s9 = create(pdb, 'sale.order', { partner_id: 3, order_line: [{ product_id: P, qty: 50, price_unit: 30, tax: 0 }] });
pdb = btn(s9.db, 'sale.order', s9.id, 'Confirm').db;
const p9 = search(pdb, 'stock.picking').find((p) => p.sale_id === s9.id);
const n9 = tryIt(() => btn(pdb, 'stock.picking', p9.id, 'Validate').db);
log('periodic product: deliver 50 with 0 on hand ->', n9.ok ? `ACCEPTED on hand ${read(n9.value, 'product', P).qty_available}` : n9.error);
// 7. concurrency: two users validate two deliveries of the same 10 units from the same snapshot
let base = seed();
const c = create(base, 'product', { name: 'Race Item', type: 'goods', cost: 5, qty_available: 0 }); base = c.db; const Q = c.id;
const rr = create(base, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: Q, qty: 10 }] }); base = btn(rr.db, 'stock.picking', rr.id, 'Validate').db;
const mk = (b) => { const x = create(b, 'sale.order', { partner_id: 3, order_line: [{ product_id: Q, qty: 10, price_unit: 9, tax: 0 }] }); const y = btn(x.db, 'sale.order', x.id, 'Confirm').db; return y; };
base = mk(mk(base));
const [pa, pb] = search(base, 'stock.picking').filter((p) => p.picking_type === 'outgoing' && p.move_ids.some((m) => m.product_id === Q));
const A = btn(base, 'stock.picking', pa.id, 'Validate').db; // user A
const B = btn(base, 'stock.picking', pb.id, 'Validate').db; // user B, same snapshot (poll every 15 s)
let server = applyDiff(base, diffDb(base, A), { isAdmin: false });
const resB = tryIt(() => applyDiff(server, diffDb(base, B), { isAdmin: false }));
log('\nconcurrent deliveries of the same 10 units: second diff', resB.ok ? 'ACCEPTED' : 'REFUSED ' + resB.error);
if (resB.ok) { server = resB.value;
  log('  pickings', search(server, 'stock.picking').filter((p) => [pa.id, pb.id].includes(p.id)).map((p) => p.state).join(','), '| on hand', read(server, 'product', Q).qty_available, '(20 units shipped from 10)');
  const lA = newIds(base, A, 'stock.valuation.layer'), lB = newIds(base, B, 'stock.valuation.layer');
  log('  layer ids created by A', lA, 'by B', lB, '| server layers for item', JSON.stringify(search(server, 'stock.valuation.layer').filter((l) => l.product_id === Q).map((l) => [l.id, l.quantity, l.picking_id])));
  const mA = newIds(base, A, 'account.move'), mB = newIds(base, B, 'account.move');
  log('  journal entry ids A', mA, 'B', mB, '| server entry', mA.map((id) => read(server, 'account.move', id)?.ref).join(','), '| A\'s entry survived?', mA.every((id) => read(server, 'account.move', id)?.ref === read(A, 'account.move', id)?.ref));
}
