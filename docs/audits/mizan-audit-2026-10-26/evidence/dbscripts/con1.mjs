// Two clients compute diffs from the same base; the server applies them in sequence with applyDiff.
const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { create, read, write, unlink, search } = await import(W + '/src/orm.js');
const { postMove, payMove } = await import(W + '/src/models/accounting.js');
const { moveStock } = await import(W + '/src/models/sales.js');
const { models } = await import(W + '/src/models/index.js');
const opts = { author: 'x', isAdmin: false };
const both = (base, a, b) => { let s = applyDiff(base, diffDb(base, a), { ...opts, author: 'Alice' }); s = applyDiff(s, diffDb(base, b), { ...opts, author: 'Bob' }); return s; };
const base0 = seed();
console.log('settings: audit_trail', base0.settings.audit_trail, 'lock_date', base0.settings.lock_date ?? null);
console.log('invoices:', search(base0, 'account.move').filter((m) => m.move_type !== 'entry').map((m) => `${m.id}:${m.name}:${m.state}:paid=${m.amount_paid ?? 0}/${m.amount_total}`).join(' | '));

// 1. Lost update on the same record
{
  const base = base0;
  const A = write(base, 'crm.lead', 1, { expected_revenue: 777777 });
  const B = write(base, 'crm.lead', 1, { priority: 3 });
  const s = both(base, A, B);
  const r = read(s, 'crm.lead', 1);
  console.log('\n[1] lost update crm.lead#1: expected_revenue', read(base, 'crm.lead', 1).expected_revenue, '-> A set 777777, B set priority 3 => server has expected_revenue', r.expected_revenue, 'priority', r.priority);
}
// 2. Id collision on concurrent create
{
  const base = base0;
  const A = create(base, 'res.partner', { name: 'Alice Customer Ltd', email: 'a@example.test' });
  const B = create(base, 'res.partner', { name: 'Bob Supplier GmbH', email: 'b@example.test' });
  const s = both(base, A.db, B.db);
  console.log('\n[2] create collision: A id', A.id, 'B id', B.id, '| server partners with id', A.id, '=>', s.records['res.partner'].filter((p) => p.id === A.id).map((p) => p.name),
    '| any "Alice"?', s.records['res.partner'].some((p) => p.name.startsWith('Alice')), '| seq', s.seq['res.partner'],
    '| created msgs for that id', s.messages.filter((m) => m.model === 'res.partner' && m.res_id === A.id).map((m) => m.author));
}
// 3. Duplicate invoice numbers from nextName (two different draft invoices posted concurrently)
{
  let base = base0;
  const partner = base.records['res.partner'][0].id;
  const product = base.records['product'][0].id;
  const mk = (db, n) => create(db, 'account.move', { move_type: 'out_invoice', partner_id: partner, invoice_date: '2026-10-26', invoice_line_ids: [{ product_id: product, qty: n, price_unit: 100, discount: 0, tax: 0 }] });
  const d1 = mk(base, 1); const d2 = mk(d1.db, 2);
  base = applyDiff(base, diffDb(base, d2.db), opts); // both drafts exist on the server
  const A = postMove(base, d1.id); const B = postMove(base, d2.id);
  const s = both(base, A, B);
  console.log('\n[3] concurrent posting: draft ids', d1.id, d2.id, '=> names', read(s, 'account.move', d1.id).name, read(s, 'account.move', d2.id).name, 'states', read(s, 'account.move', d1.id).state, read(s, 'account.move', d2.id).state);
  // 3b. Single user, no concurrency: delete a posted invoice, post a new one
  const names = search(s, 'account.move').filter((m) => m.name?.startsWith('INV/2026/')).map((m) => `${m.id}:${m.name}`);
  console.log('[3b] INV names before:', names.join(' '));
  const firstInv = search(s, 'account.move').find((m) => m.name === 'INV/2026/00001');
  let t = applyDiff(s, diffDb(s, unlink(s, 'account.move', [firstInv.id])), opts);
  const d3 = mk(t, 3); t = applyDiff(t, diffDb(t, d3.db), opts);
  t = applyDiff(t, diffDb(t, postMove(t, d3.id)), opts);
  const counts = {}; for (const m of search(t, 'account.move')) if (m.name?.startsWith('INV/2026/')) counts[m.name] = (counts[m.name] ?? 0) + 1;
  console.log('[3b] after deleting posted', firstInv.name, 'and posting a new invoice: new name', read(t, 'account.move', d3.id).name, '| duplicates:', Object.entries(counts).filter(([, n]) => n > 1));
}
// 4. Two payments on two different invoices, same base => GL corruption
{
  const base = base0;
  const posted = search(base, 'account.move').filter((m) => m.move_type === 'out_invoice' && m.state === 'posted' && (m.amount_paid ?? 0) < m.amount_total);
  const [x, y] = posted;
  if (!x || !y) { console.log('[4] need two unpaid posted invoices; found', posted.length); }
  else {
    const A = payMove(base, x.id, 1e9, '2026-10-26');
    const B = payMove(base, y.id, 1e9, '2026-10-26');
    const s = both(base, A, B);
    const X = read(s, 'account.move', x.id), Y = read(s, 'account.move', y.id);
    const mvX = X.payments.at(-1).move_id, mvY = Y.payments.at(-1).move_id;
    console.log('\n[4] Alice pays', x.name, '(', x.amount_total, '), Bob pays', y.name, '(', y.amount_total, ')');
    console.log('    server: ', X.name, 'amount_paid', X.amount_paid, 'payment move', mvX, '| ', Y.name, 'amount_paid', Y.amount_paid, 'payment move', mvY);
    const mv = read(s, 'account.move', mvX);
    console.log('    move', mvX, 'ref =', JSON.stringify(mv.ref), 'name', mv.name);
    const pays = search(s, 'account.payment').filter((p) => [x.id, y.id].includes(p.invoice_id)).map((p) => `${p.id}:${p.name}:inv${p.invoice_id}:${p.amount}`);
    console.log('    account.payment records for X/Y:', pays.join(' | '));
    // GL: receivable balance for X's partner vs invoice residual
    const recv = s.records['account.account'].find((a) => a.code === '121000').id;
    const bal = (db, partner) => search(db, 'account.move').filter((m) => m.state === 'posted').flatMap((m) => m.line_ids ?? []).filter((l) => l.account_id === recv && l.partner_id === partner).reduce((t, l) => t + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
    console.log('    AR GL balance partner', x.partner_id, 'base', bal(base, x.partner_id).toFixed(2), '-> after', bal(s, x.partner_id).toFixed(2), '| partner', y.partner_id, 'base', bal(base, y.partner_id).toFixed(2), '-> after', bal(s, y.partner_id).toFixed(2));
  }
}
// 5. Double payment of the same invoice by two clients
{
  const base = base0;
  const x = search(base, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && (m.amount_paid ?? 0) < m.amount_total);
  // Bob's client has an unrelated pending create first (so his ids are offset), common in practice
  const bobBase = create(base, 'account.move', { move_type: 'entry', line_ids: [] }).db;
  const A = payMove(base, x.id, 1e9, '2026-10-26');
  const B = payMove(bobBase, x.id, 1e9, '2026-10-26');
  let s = applyDiff(base, diffDb(base, A), opts);
  s = applyDiff(s, diffDb(base, B), opts);
  const X = read(s, 'account.move', x.id);
  const bankMoves = search(s, 'account.move').filter((m) => m.ref === `Payment ${x.name}`).map((m) => m.id);
  console.log('\n[5] same invoice paid twice:', x.name, 'total', X.amount_total, '-> amount_paid', X.amount_paid, '| bank moves', bankMoves, '| payments', search(s, 'account.payment').filter((p) => p.invoice_id === x.id).map((p) => `${p.id}:${p.amount}`));
}
// 6. Stock: two deliveries of the same product validated concurrently (stored qty_available, read-modify-write)
{
  const base = base0;
  const p = search(base, 'product').find((q) => q.type === 'goods' && q.qty_available > 5);
  const A = moveStock(base, [{ product_id: p.id, qty: 2 }], -1);
  const B = moveStock(base, [{ product_id: p.id, qty: 3 }], -1);
  const s = both(base, A, B);
  console.log('\n[6] stock', p.name, 'on hand', p.qty_available, '- 2 (Alice) - 3 (Bob) => server', read(s, 'product', p.id).qty_available, '(expected', p.qty_available - 5, ')');
  // Through the real "Validate" button on two ready deliveries
  const btn = models['stock.picking'].form.buttons.find((b) => b.label === 'Validate');
  const mkPick = (db, q) => create(db, 'stock.picking', { picking_type: 'outgoing', state: 'ready', move_ids: [{ product_id: p.id, qty: q }] });
  const k1 = mkPick(base, 2); const k2 = mkPick(k1.db, 3);
  const b2 = applyDiff(base, diffDb(base, k2.db), opts);
  const vA = btn.run(b2, read(b2, 'stock.picking', k1.id)).db;
  const vB = btn.run(b2, read(b2, 'stock.picking', k2.id)).db;
  const s2 = both(b2, vA, vB);
  const layers = (db) => search(db, 'stock.valuation.layer').filter((l) => l.product_id === p.id).length;
  console.log('[6b] Validate button: pickings', k1.id, k2.id, 'states', read(s2, 'stock.picking', k1.id).state, read(s2, 'stock.picking', k2.id).state,
    '| qty', read(b2, 'product', p.id).qty_available, '->', read(s2, 'product', p.id).qty_available, '(expected', read(b2, 'product', p.id).qty_available - 5, ') | valuation layers for product', layers(b2), '->', layers(s2), '(A alone', layers(vA), ', B alone', layers(vB), ')');
}
