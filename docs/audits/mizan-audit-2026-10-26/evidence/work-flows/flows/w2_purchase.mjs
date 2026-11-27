import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, newIds, prompts, log } from './lib.mjs';
const { create, read, search, write } = orm;
let db = seed();
const L0 = ledger(db);
const step = (name, prev, next) => { const s = serverSync(prev, next); log(`[sync ${name}] lost: ${s.lost.length}`, s.lost.slice(0, 4).join(' ; ')); return s.db; };
let r = create(db, 'res.partner', { name: 'Flow Vendor' });
let prev = db; db = step('vendor', prev, r.db); const ven = r.id;
const pline = (pid, qty, price) => ({ ...models['purchase.order'].fields.order_line.onchange({ product_id: pid, qty, price_unit: 0, discount: 0 }, 'product_id', db, {}), qty, ...(price != null ? { price_unit: price } : {}) });
// RFQ: 10 oak desk tops at 100 (product cost 90, standard costing) + 1 service
r = create(db, 'purchase.order', { partner_id: ven, order_line: [pline(7, 10, 100), pline(6, 1, 50)] });
prev = db; db = step('rfq', prev, r.db); const po = r.id;
log('PO', read(db, 'purchase.order', po).name, 'total', read(db, 'purchase.order', po).amount_total, 'lines', JSON.stringify(read(db, 'purchase.order', po).order_line.map(l => [l.product_id, l.qty, l.price_unit, l.tax])));
prev = db; db = btn(db, 'purchase.order', po, 'Confirm Order').db; db = step('confirm', prev, db);
let picks = search(db, 'stock.picking').filter((p) => p.purchase_id === po);
log('after confirm: state', read(db, 'purchase.order', po).state, 'receipts', picks.map((p) => `${p.name}:${p.state}:${p.picking_type}`).join(','), 'invoice_status', read(db, 'purchase.order', po).invoice_status);
{ const a = tryIt(() => btn(db, 'purchase.order', po, 'Confirm Order', { force: true })); log('Confirm Order again (run, hidden):', a.ok ? search(a.value.db, 'stock.picking').filter((p) => p.purchase_id === po).length + ' receipts' : 'REFUSED ' + a.error); }
// bill before receipt?
const early = tryIt(() => btn(db, 'purchase.order', po, 'Create Bill'));
log('Create Bill before receipt: visible=', early.ok && early.value.visible, early.ok ? `lines ${JSON.stringify(read(early.value.db, 'account.move', newIds(db, early.value.db, 'account.move')[0])?.invoice_line_ids?.map(l => [l.product_id, l.qty]))}` : early.error);
// receipt: partial 6 of 10 -> backorder
const rc = picks[0];
const oak0 = read(db, 'product', 7).qty_available;
let partial = write(db, 'stock.picking', rc.id, { move_ids: rc.move_ids.map((l) => ({ ...l, quantity: 6 })) });
prev = db; const Lr = ledger(partial); db = btn(partial, 'stock.picking', rc.id, 'Validate').db; db = step('receipt partial', prev, db);
const bo = search(db, 'stock.picking').find((p) => p.backorder_id === rc.id);
log('after receipt 6/10: oak', oak0, '->', read(db, 'product', 7).qty_available, 'backorder', bo ? `${bo.name}:${bo.state}:${JSON.stringify(bo.move_ids.map(l=>l.qty))}` : 'none', 'qty_delivered', JSON.stringify(read(db, 'purchase.order', po).order_line.map((l) => l.qty_delivered)), 'receipt_done', read(db, 'purchase.order', po).receipt_done);
log('receipt ledger delta', JSON.stringify(ledgerDelta(Lr, ledger(db))), 'product cost now', read(db, 'product', 7).cost);
// bill
prev = db; let out = btn(db, 'purchase.order', po, 'Create Bill'); db = step('create bill', prev, out.db);
const bill = newIds(prev, db, 'account.move').find((id) => read(db, 'account.move', id).move_type === 'in_invoice');
log('bill lines', JSON.stringify(read(db, 'account.move', bill).invoice_line_ids.map((l) => [l.product_id, l.qty, l.price_unit])), 'total', read(db, 'account.move', bill).amount_total, 'PO invoice_status', read(db, 'purchase.order', po).invoice_status);
prev = db; const Lb = ledger(db); const posted = tryIt(() => btn(db, 'account.move', bill, 'Confirm').db);
if (!posted.ok) log('post bill error:', posted.error); else { db = step('post bill', prev, posted.value); log('bill posted', read(db, 'account.move', bill).name, 'ledger delta', JSON.stringify(ledgerDelta(Lb, ledger(db)))); }
// payment
prompts.push(String(read(db, 'account.move', bill).amount_total));
prev = db; const Lp = ledger(db); db = btn(db, 'account.move', bill, 'Register Payment').db; db = step('pay bill', prev, db);
log('after payment: payment_state', read(db, 'account.move', bill).payment_state, 'ledger delta', JSON.stringify(ledgerDelta(Lp, ledger(db))), 'vendor 211000 balance', ledger(db, { partner: ven })['211000'] ?? 0);
// receive the rest and bill it
prev = db; db = btn(db, 'stock.picking', bo.id, 'Validate').db; db = step('backorder receipt', prev, db);
log('after backorder: oak', read(db, 'product', 7).qty_available, 'receipt_done', read(db, 'purchase.order', po).receipt_done, 'invoice_status', read(db, 'purchase.order', po).invoice_status);
out = btn(db, 'purchase.order', po, 'Create Bill'); const bill2 = newIds(db, out.db, 'account.move').find((id) => read(out.db, 'account.move', id).move_type === 'in_invoice'); db = out.db;
db = btn(db, 'account.move', bill2, 'Confirm').db;
log('second bill lines', JSON.stringify(read(db, 'account.move', bill2).invoice_line_ids.map((l) => [l.product_id, l.qty])), 'PO invoice_status', read(db, 'purchase.order', po).invoice_status);
log('Create Bill third time:', tryIt(() => btn(db, 'purchase.order', po, 'Create Bill', { force: true })).error ?? 'ACCEPTED');
log('whole-flow ledger delta', JSON.stringify(ledgerDelta(L0, ledger(db))));
log('interim 110200 balance (should be 0 after receipt+bill at same price):', ledger(db)['110200']);
// over-receipt via manual quantity on routed receipt
const s2 = create(db, 'purchase.order', { partner_id: ven, order_line: [pline(8, 2, 120)] });
let d2 = btn(s2.db, 'purchase.order', s2.id, 'Confirm Order').db;
const rp = search(d2, 'stock.picking').find((p) => p.purchase_id === s2.id);
log('receive 50 on a PO for 2:', tryIt(() => btn(write(d2, 'stock.picking', rp.id, { move_ids: rp.move_ids.map((l) => ({ ...l, quantity: 50 })) }), 'stock.picking', rp.id, 'Validate')).error ?? 'ACCEPTED');
// bill edits: change bill qty above received before posting
const ob = btn(btn(write(d2, 'stock.picking', rp.id, {}), 'stock.picking', rp.id, 'Validate').db, 'purchase.order', s2.id, 'Create Bill');
const b3 = newIds(d2, ob.db, 'account.move').find((id) => read(ob.db, 'account.move', id).move_type === 'in_invoice');
const inflated = write(ob.db, 'account.move', b3, { invoice_line_ids: read(ob.db, 'account.move', b3).invoice_line_ids.map((l) => ({ ...l, qty: 20 })) });
log('post a bill for 20 when 2 were received:', tryIt(() => btn(inflated, 'account.move', b3, 'Confirm')).error ?? 'ACCEPTED');
const pricey = write(ob.db, 'account.move', b3, { invoice_line_ids: read(ob.db, 'account.move', b3).invoice_line_ids.map((l) => ({ ...l, price_unit: 999 })) });
const pp = tryIt(() => btn(pricey, 'account.move', b3, 'Confirm').db);
log('post a bill at price 999 vs PO 120:', pp.ok ? `ACCEPTED ledger ${JSON.stringify(ledgerDelta(ledger(pricey), ledger(pp.value)))}` : pp.error);
