import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, newIds, prompts, log } from './lib.mjs';
const { create, read, search, write } = orm;
let db = seed();
const L0 = ledger(db);
const step = (name, prev, next) => { const s = serverSync(prev, next); log(`[sync ${name}] lost fields: ${s.lost.length}`, s.lost.slice(0, 6).join(' ; ')); return s.db; };

// 1. customer
let r = create(db, 'res.partner', { name: 'Flow Customer', email: 'c@x.example' });
let prev = db; db = r.db; const cust = r.id; step('customer', prev, db);
// 2. quotation: 5 chairs (goods, 210, tax 14%) + 2h installation (service)
const line = (pid, qty) => ({ ...models['sale.order'].fields.order_line.onchange({ product_id: pid, qty, price_unit: 0, discount: 0 }, 'product_id', db, {}), qty });
r = create(db, 'sale.order', { partner_id: cust, order_line: [line(1, 5), line(6, 2)] });
prev = db; db = r.db; const so = r.id; step('quotation', prev, db);
log('SO', read(db, 'sale.order', so).name, 'total', read(db, 'sale.order', so).amount_total, 'company', read(db, 'sale.order', so).company_id);
const chair0 = read(db, 'product', 1).qty_available;
// 3. confirm
prev = db; db = btn(db, 'sale.order', so, 'Confirm').db; db = step('confirm', prev, db);
let picks = search(db, 'stock.picking').filter((p) => p.sale_id === so);
log('after Confirm: state', read(db, 'sale.order', so).state, 'pickings', picks.map((p) => `${p.name}:${p.state}:${p.picking_type}:route=${p.warehouse_route}`).join(','));
// 3b. confirm again (button hidden in UI; run() itself has no state check)
const again = btn(db, 'sale.order', so, 'Confirm', { force: true });
log('Confirm again: visible=', again.visible, 'pickings now', search(again.db, 'stock.picking').filter((p) => p.sale_id === so).length);
// 4. delivery validate
const pk = picks[0];
log('free qty / availability before validate', read(db, 'product', 1).qty_available);
prev = db; const Lb = ledger(db); db = btn(db, 'stock.picking', pk.id, 'Validate').db; db = step('validate delivery', prev, db);
log('after Validate: picking', read(db, 'stock.picking', pk.id).state, 'chair on hand', chair0, '->', read(db, 'product', 1).qty_available, 'qty_delivered', read(db, 'sale.order', so).order_line.map((l) => l.qty_delivered));
log('ledger delta of delivery', JSON.stringify(ledgerDelta(Lb, ledger(db))));
// 5. invoice
prev = db; let out = btn(db, 'sale.order', so, 'Create Invoice'); db = step('create invoice', prev, out.db);
const inv = newIds(prev, db, 'account.move')[0];
log('invoice', inv, read(db, 'account.move', inv).state, 'total', read(db, 'account.move', inv).amount_total, 'company', read(db, 'account.move', inv).company_id, 'SO invoice_status', read(db, 'sale.order', so).invoice_status);
log('Create Invoice again ->', tryIt(() => btn(db, 'sale.order', so, 'Create Invoice', { force: true })).error);
// 6. post
prev = db; const Lp = ledger(db); db = btn(db, 'account.move', inv, 'Confirm').db; db = step('post invoice', prev, db);
log('posted', read(db, 'account.move', inv).name, 'ledger delta', JSON.stringify(ledgerDelta(Lp, ledger(db))));
// 7. payment
const total = read(db, 'account.move', inv).amount_total;
prompts.push(String(total));
prev = db; const Lpay = ledger(db); db = btn(db, 'account.move', inv, 'Register Payment').db; db = step('register payment', prev, db);
const m = read(db, 'account.move', inv);
log('after payment: payment_state', m.payment_state, 'residual', m.amount_residual, 'ledger delta', JSON.stringify(ledgerDelta(Lpay, ledger(db))));
log('customer receivable (121000) balance for partner', ledger(db, { partner: cust })['121000'] ?? 0, 'payments', search(db, 'account.payment').filter((p) => p.invoice_id === inv).map((p) => `${p.name}:${p.amount}:${p.state}`).join(','));
log('total ledger delta whole flow', JSON.stringify(ledgerDelta(L0, ledger(db))));
const final = db;

// ---- incorrect transitions via the button run() functions (UI hides them, run() does not check) ----
log('\n-- transitions --');
const t1 = btn(final, 'account.move', inv, 'Cancel', { force: true });
log('Cancel paid+posted invoice via run(): visible=', t1.visible, 'state', read(t1.db, 'account.move', inv).state, 'receivable for partner after', ledger(t1.db, { partner: cust })['121000'] ?? 0, 'SO invoice_status', read(t1.db, 'sale.order', so).invoice_status);
const t2 = btn(final, 'account.move', inv, 'Reset to Draft', { force: true });
log('Reset paid invoice to draft via run(): visible=', t2.visible, 'state', read(t2.db, 'account.move', inv).state, 'partner 121000', ledger(t2.db, { partner: cust })['121000']);
// Create Invoice after the paid invoice is cancelled -> invoice twice?
const t3 = tryIt(() => btn(t1.db, 'sale.order', so, 'Create Invoice', { force: true }));
log('Create Invoice after cancelling the paid invoice:', t3.ok ? `new invoice ${newIds(t1.db, t3.value.db, 'account.move')}` : t3.error);
// Credit note twice
let c1 = btn(final, 'account.move', inv, 'Credit Note').db; let c2 = btn(c1, 'account.move', inv, 'Credit Note').db;
log('Credit notes created for one invoice (2 clicks):', search(c2, 'account.move').filter((x) => x.move_type === 'out_refund' && x.invoice_origin === read(final, 'account.move', inv).name).length);
// Register payment on a draft invoice via payMove
const { payMove } = await import('../src/models/accounting.js');
const s2 = create(final, 'sale.order', { partner_id: cust, order_line: [line(6, 1)] });
let d2 = btn(s2.db, 'sale.order', s2.id, 'Confirm').db; d2 = btn(d2, 'sale.order', s2.id, 'Create Invoice').db;
const inv2 = newIds(s2.db, d2, 'account.move')[0];
const pd = btn(d2, 'account.move', inv2, 'Register Payment', { force: true });
log('Register Payment on DRAFT invoice via run(): visible=', pd.visible, 'invoice state', read(pd.db, 'account.move', inv2).state, 'amount_paid', read(pd.db, 'account.move', inv2).amount_paid, 'bank delta', JSON.stringify(ledgerDelta(ledger(d2), ledger(pd.db))));
// Cancel a confirmed SO
const cs = btn(final, 'sale.order', so, 'Cancel', { force: true });
log('Cancel confirmed+invoiced SO via run(): visible=', cs.visible, 'state', read(cs.db, 'sale.order', so).state, 'done pickings untouched', search(cs.db, 'stock.picking').filter((p) => p.sale_id === so).map((p) => p.state));

// ---- over-delivery ----
log('\n-- over-delivery --');
const s3 = create(final, 'sale.order', { partner_id: cust, order_line: [line(4, 2)] });
let d3 = btn(s3.db, 'sale.order', s3.id, 'Confirm').db;
const p3 = search(d3, 'stock.picking').find((p) => p.sale_id === s3.id);
const over = write(d3, 'stock.picking', p3.id, { move_ids: p3.move_ids.map((l) => ({ ...l, quantity: 10 })) });
log('routed delivery qty 2, done 10:', tryIt(() => btn(over, 'stock.picking', p3.id, 'Validate')).error ?? 'ACCEPTED');
// a manual delivery linked to the SO without warehouse_route
const man = create(d3, 'stock.picking', { picking_type: 'outgoing', partner_id: cust, sale_id: s3.id, origin: 'manual', state: 'ready', move_ids: [{ product_id: 4, qty: 2, quantity: 10 }] });
const lamp0 = read(man.db, 'product', 4).qty_available;
const mv = tryIt(() => btn(man.db, 'stock.picking', man.id, 'Validate').db);
log('manual delivery qty 2 done 10:', mv.ok ? `ACCEPTED lamp on hand ${lamp0} -> ${read(mv.value, 'product', 4).qty_available}, SO qty_delivered ${read(mv.value, 'sale.order', s3.id).order_line[0].qty_delivered}` : mv.error);
// validate both the routed and manual picking for the same SO -> delivered twice
if (mv.ok) { const both = tryIt(() => btn(mv.value, 'stock.picking', p3.id, 'Validate').db); log('then validate the routed delivery too:', both.ok ? `ACCEPTED lamp on hand -> ${read(both.value, 'product', 4).qty_available}, SO qty_delivered ${read(both.value, 'sale.order', s3.id).order_line[0].qty_delivered}` : both.error); }
