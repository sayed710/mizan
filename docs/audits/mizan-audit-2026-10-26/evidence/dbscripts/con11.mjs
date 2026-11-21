const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { create, read, search } = await import(W + '/src/orm.js');
const { models } = await import(W + '/src/models/index.js');
const { deliver, postValuation, receive } = await import(W + '/src/models/valuation.js');
let s = seed();
const p = search(s, 'product').find((q) => q.type === 'goods' && q.qty_available > 5);
// rental pickup then a valued receipt
const r = create(s, 'sale.rental', { product_id: p.id, qty: 2, state: 'reserved', partner_id: s.records['res.partner'][0].id });
s = applyDiff(s, diffDb(s, r.db));
const pickup = models['sale.rental'].form.buttons.find((b) => b.label === 'Pickup');
const client = pickup.run(s, read(s, 'sale.rental', r.id)).db;
const server = applyDiff(s, diffDb(s, client));
console.log('after Pickup: client qty_rented', read(client, 'product', p.id).qty_rented, '| server qty_rented', read(server, 'product', p.id).qty_rented, '| qty_available', read(server, 'product', p.id).qty_available);
for (const [label, db] of [['client state', client], ['server state', server]]) {
  try { receive(db, p.id, 1, 10, { date: '2026-10-26' }); console.log(`  receive() on ${label}: ok`); } catch (e) { console.log(`  receive() on ${label}: ${e.message}`); }
}
// valuation layer counterpart
let t = seed();
const q = search(t, 'product').find((x) => x.type === 'goods' && x.qty_available > 5);
const dOut = deliver(t, q.id, 1, { date: '2026-10-26', reference: 'Scrap test', counterpart: '600000' }); const d = dOut.db ?? dOut;
const layerC = search(d, 'stock.valuation.layer').at(-1);
const t2 = applyDiff(t, diffDb(t, d));
const layerS = read(t2, 'stock.valuation.layer', layerC.id);
console.log('\nlayer', layerC.id, 'client counterpart', layerC.counterpart, 'move_id', layerC.move_id ?? null, '| server counterpart', layerS.counterpart, 'move_id', layerS.move_id ?? null);
if (!layerS.move_id) {
  const acc = (db, id) => db.records['account.account'].find((a) => a.id === id)?.code;
  for (const [label, db] of [['client', d], ['server', t2]]) {
    try { const posted = postValuation(db, layerC.id); const mv = read(posted, 'account.move', read(posted, 'stock.valuation.layer', layerC.id).move_id); console.log(`  postValuation on ${label} state -> accounts`, mv.line_ids.map((l) => acc(posted, l.account_id)).join(',')); } catch (e) { console.log(`  postValuation on ${label}: ${e.message}`); }
  }
}
