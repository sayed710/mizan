import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, newIds, prompts, log } from './lib.mjs';
const { create, read, search, write } = orm;
const pos = await import('../src/models/pos.js');
const posplus = await import('../src/models/posplus.js');
let db = seed();
const step = (name, prev, next) => { const s = serverSync(prev, next); log(`[sync ${name}] lost: ${s.lost.length}`, s.lost.slice(0, 3).join(' ; ')); return s.db; };
const L0 = ledger(db);
log('open sessions at seed', search(db, 'pos.session').filter((s) => s.state === 'opened').map((s) => s.name));
// close any seeded open session first
for (const s of search(db, 'pos.session').filter((s) => s.state === 'opened')) db = pos.closeSession(db, s, pos.sessionTotals(db, s).expected);
let r = pos.startSession(db, 100); let prev = db; db = step('open session', prev, r.db); const sess = r.id;
log('second session while one open:', tryIt(() => pos.startSession(db, 0)).error);
// 1. legacy POS screen flow: 2 espresso + 1 chair, cash (what Pos.jsx calls)
const lines = pos.priceLines(db, [{ product_id: 10, qty: 2 }, { product_id: 1, qty: 1 }]);
const e0 = read(db, 'product', 10).qty_available, c0 = read(db, 'product', 1).qty_available;
prev = db; const Ls = ledger(db); r = pos.payOrder(db, { lines, method: 'cash', partner_id: 3 }); db = step('pay', prev, r.db); const o1 = r.id;
log('order', read(db, 'pos.order', o1).name, read(db, 'pos.order', o1).state, 'total', read(db, 'pos.order', o1).amount_total, 'company', read(db, 'pos.order', o1).company_id, '| espresso', e0, '->', read(db, 'product', 10).qty_available, 'chair', c0, '->', read(db, 'product', 1).qty_available);
log('sale GL delta', JSON.stringify(ledgerDelta(Ls, ledger(db))));
// 2. refund (form button)
prev = db; const Lr = ledger(db); let out = btn(db, 'pos.order', o1, 'Refund'); log('Refund visible', out.visible); db = step('refund', prev, out.db);
log('after refund: espresso', read(db, 'product', 10).qty_available, 'chair', read(db, 'product', 1).qty_available, 'refund GL delta', JSON.stringify(ledgerDelta(Lr, ledger(db))));
log('refund twice:', tryIt(() => btn(db, 'pos.order', o1, 'Refund', { force: true })).error);
log('net GL of sale+refund', JSON.stringify(ledgerDelta(Ls, ledger(db))));
// 3. stock_costs is not a declared field: after a server round trip, refunds use today's cost
db = write(db, 'product', 1, { cost_method: 'fifo' });
r = pos.payOrder(db, { lines: pos.priceLines(db, [{ product_id: 1, qty: 1 }]), method: 'card' }); const o2 = r.id;
const clientDb = r.db; const serverDb = serverSync(db, clientDb).db;
log('stock_costs client', JSON.stringify(read(clientDb, 'pos.order', o2).stock_costs), 'server', JSON.stringify(read(serverDb, 'pos.order', o2).stock_costs));
const costChanged = write(serverDb, 'product', 1, { cost: 999 });
const rf = btn(costChanged, 'pos.order', o2, 'Refund').db;
const rfc = btn(write(clientDb, 'product', 1, { cost: 999 }), 'pos.order', o2, 'Refund').db;
log('refund stock value booked: from server copy', JSON.stringify(ledgerDelta(ledger(costChanged), ledger(rf))), '| from client copy', JSON.stringify(ledgerDelta(ledger(write(clientDb, 'product', 1, { cost: 999 })), ledger(rfc))));
// 4. sale with zero stock
const sz = tryIt(() => pos.payOrder(db, { lines: pos.priceLines(db, [{ product_id: 14, qty: 1 }]), method: 'cash' }));
log('POS sale of an item with 0 on hand:', sz.ok ? 'ACCEPTED' : 'REFUSED ' + sz.error);
// 5. close session with counted cash
const tot = pos.sessionTotals(db, read(db, 'pos.session', sess));
log('session totals', JSON.stringify(tot));
prompts.push(String(tot.expected - 5));
prev = db; const Lc = ledger(db); db = btn(db, 'pos.session', sess, 'Close Session').db; db = step('close', prev, db);
log('closed', read(db, 'pos.session', sess).state, 'difference', read(db, 'pos.session', sess).cash_difference, 'GL', JSON.stringify(ledgerDelta(Lc, ledger(db))));
log('close again (hidden):', tryIt(() => btn(db, 'pos.session', sess, 'Close Session', { force: true })).error);
// 6. refund an order of a closed session with no session open
log('refund after session closed, none open:', tryIt(() => btn(db, 'pos.order', o2, 'Refund')).error);
// 7. posplus flow: draft bill + split tender
r = pos.startSession(db, 0); db = r.db;
const cfg = create(db, 'pos.config', { name: 'Shop' }); db = cfg.db;
r = create(db, 'pos.order', { config_id: cfg.id, state: 'draft', lines: pos.priceLines(db, [{ product_id: 11, qty: 3 }]) }); db = r.db; const d = r.id;
const total = read(db, 'pos.order', d).amount_total;
db = write(db, 'pos.order', d, { payment_ids: [{ method: 'cash', amount: 5 }, { method: 'bank', amount: Math.round((total - 5) * 100) / 100 }] });
prev = db; const Lpp = ledger(db); out = btn(db, 'pos.order', d, 'Pay'); db = step('posplus pay', prev, out.db);
const sets = search(db, 'pos.order').filter((o) => o.settlement_of === d);
log('split pay: order', read(db, 'pos.order', d).state, 'session_id', read(db, 'pos.order', d).session_id, '| settlements', JSON.stringify(sets.map((o) => [o.name, o.payment_method, o.amount_total, o.lines.map((l) => l.qty)])), '| croissant', read(prev, 'product', 11).qty_available, '->', read(db, 'product', 11).qty_available, '| GL', JSON.stringify(ledgerDelta(Lpp, ledger(db))));
log('Pay twice:', tryIt(() => btn(db, 'pos.order', d, 'Pay', { force: true })).error);
prev = db; out = btn(db, 'pos.order', d, 'Refund'); db = out.db;
log('refund split bill: state', read(db, 'pos.order', d).state, 'croissant ->', read(db, 'product', 11).qty_available, 'GL net', JSON.stringify(ledgerDelta(Lpp, ledger(db))));
// 8. forged: non-admin edits a paid POS order's lines after the fact
const f = tryIt(() => serverSync(db, write(db, 'pos.order', o1, { lines: [{ product_id: 10, qty: 1, price_unit: 0.01, tax: 0 }] })));
log('server: rewrite lines of a paid POS order (non-admin):', f.ok ? 'ACCEPTED' : f.error);
const f2 = tryIt(() => serverSync(db, { ...db, records: { ...db.records, 'pos.order': db.records['pos.order'].filter((o) => o.refund_of !== o1) } }));
log('server: delete the refund order (non-admin):', f2.ok ? 'ACCEPTED' : f2.error);
if (f2.ok) { const again = tryIt(() => btn(write(f2.value.db, 'pos.order', o1, { state: 'paid' }), 'pos.order', o1, 'Refund')); log('   then set original back to paid and refund again:', again.ok ? 'ACCEPTED (second cash refund)' : again.error); }
