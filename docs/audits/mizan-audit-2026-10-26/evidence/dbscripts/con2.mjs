const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { create, read, unlink, search } = await import(W + '/src/orm.js');
const { postMove, payMove } = await import(W + '/src/models/accounting.js');
const opts = { author: 'x', isAdmin: false };
const base0 = seed();
const acct = (db, code) => db.records['account.account'].find((a) => a.code === code).id;
const bal = (db, code, partner) => search(db, 'account.move').filter((m) => m.state === 'posted').flatMap((m) => m.line_ids ?? [])
  .filter((l) => l.account_id === acct(db, code) && (partner == null || l.partner_id === partner)).reduce((t, l) => t + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
const tb = (db) => search(db, 'account.move').filter((m) => m.state === 'posted').flatMap((m) => m.line_ids ?? []).reduce((t, l) => t + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);

// 3b. Single user, no concurrency: delete a posted invoice, then post a new one
{
  let t = base0;
  const del = search(t, 'account.move').find((m) => m.name === 'INV/2026/00001');
  try { t = applyDiff(t, diffDb(t, unlink(t, 'account.move', [del.id])), opts); console.log('[3b] deleted posted', del.name, '(paid', del.amount_paid, ') accepted'); } catch (e) { console.log('[3b] delete refused:', e.message); }
  const d = create(t, 'account.move', { move_type: 'out_invoice', partner_id: t.records['res.partner'][0].id, invoice_date: '2026-10-26', invoice_line_ids: [{ product_id: t.records.product[0].id, qty: 1, price_unit: 10, discount: 0, tax: 0 }] });
  t = applyDiff(t, diffDb(t, d.db), opts);
  t = applyDiff(t, diffDb(t, postMove(t, d.id)), opts);
  console.log('[3b] new invoice name', read(t, 'account.move', d.id).name, '| INV names now:', search(t, 'account.move').filter((m) => m.name?.startsWith('INV/')).map((m) => `${m.id}:${m.name}`).join(' '));
  // dangling refs left by the delete
  const refs = search(t, 'account.payment').filter((p) => p.invoice_id === del.id).map((p) => `payment ${p.id} -> invoice_id ${p.invoice_id}`);
  console.log('[3b] references to deleted move', del.id, ':', refs.join('; '), '| sale orders with invoice ref:', search(t, 'sale.order').filter((o) => JSON.stringify(o).includes(del.name)).map((o) => o.name));
}
// 4. Payments on two different documents from the same base
{
  const base = base0;
  const x = search(base, 'account.move').find((m) => m.name === 'INV/2026/00002');
  const y = search(base, 'account.move').find((m) => m.name === 'BILL/2026/00001');
  const A = payMove(base, x.id, 1e9, '2026-10-26');
  const B = payMove(base, y.id, 1e9, '2026-10-26');
  let s = applyDiff(base, diffDb(base, A), { ...opts, author: 'Alice' });
  s = applyDiff(s, diffDb(base, B), { ...opts, author: 'Bob' });
  const X = read(s, 'account.move', x.id), Y = read(s, 'account.move', y.id);
  const mvX = X.payments.at(-1).move_id;
  console.log('\n[4] Alice pays', x.name, 'residual', x.amount_total - x.amount_paid, '; Bob pays', y.name, 'residual', y.amount_total - (y.amount_paid ?? 0));
  console.log('    server:', X.name, 'amount_paid', X.amount_paid, 'its payment move_id', mvX, '-> that move ref', JSON.stringify(read(s, 'account.move', mvX).ref));
  console.log('    ', Y.name, 'amount_paid', Y.amount_paid, 'payment move_id', Y.payments.at(-1).move_id);
  console.log('    account.payment for', x.name, ':', search(s, 'account.payment').filter((p) => p.invoice_id === x.id).map((p) => `${p.id}:${p.amount}`), '| for', y.name, ':', search(s, 'account.payment').filter((p) => p.invoice_id === y.id).map((p) => `${p.id}:${p.amount}`));
  console.log('    AR(121000) partner', x.partner_id, ': base', bal(base, '121000', x.partner_id).toFixed(2), '| Alice alone', bal(applyDiff(base, diffDb(base, A), opts), '121000', x.partner_id).toFixed(2), '| server after both', bal(s, '121000', x.partner_id).toFixed(2), '(invoice says residual', (X.amount_total - X.amount_paid).toFixed(2), ')');
}
// 5. Stale client double-pays an invoice; ids partially offset
{
  let S = base0;
  const x = search(S, 'account.move').find((m) => m.name === 'INV/2026/00002');
  const aliceBase = S; // Alice's client last polled here
  const bobDraft = create(S, 'account.move', { move_type: 'entry', ref: 'Bob draft accrual', line_ids: [] });
  S = applyDiff(S, diffDb(S, bobDraft.db), { ...opts, author: 'Bob' }); // Bob's draft entry is saved first
  const bobBase = S;
  const A = payMove(aliceBase, x.id, 1e9, '2026-10-26');
  S = applyDiff(S, diffDb(aliceBase, A), { ...opts, author: 'Alice' });
  const B = payMove(bobBase, x.id, 1e9, '2026-10-26');
  S = applyDiff(S, diffDb(bobBase, B), { ...opts, author: 'Bob' });
  const X = read(S, 'account.move', x.id);
  console.log('\n[5] Bob draft id', bobDraft.id, '-> now', JSON.stringify(read(S, 'account.move', bobDraft.id).ref), read(S, 'account.move', bobDraft.id).state, '(Bob\'s draft overwritten)');
  console.log('    posted bank moves for', x.name, ':', search(S, 'account.move').filter((m) => m.ref === `Payment ${x.name}` && m.state === 'posted').map((m) => `${m.id}:${(m.line_ids ?? []).reduce((t, l) => t + (Number(l.debit) || 0), 0)}`),
    '| invoice amount_paid', X.amount_paid, 'of', X.amount_total, '| payment records', search(S, 'account.payment').filter((p) => p.invoice_id === x.id).map((p) => `${p.id}:${p.amount}`));
  console.log('    AR partner', x.partner_id, 'base', bal(base0, '121000', x.partner_id).toFixed(2), '-> after', bal(S, '121000', x.partner_id).toFixed(2), '| trial balance sum(debit-credit) posted', tb(S).toFixed(2));
}
