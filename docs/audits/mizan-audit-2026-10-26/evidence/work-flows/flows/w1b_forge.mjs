// Sales/accounting: which transitions does the SERVER (applyDiff, isAdmin:false) refuse?
import { seed, models, orm, btn, tryIt, serverSync, ledger, ledgerDelta, newIds, prompts, log, applyDiff, diffDb } from './lib.mjs';
const { create, read, search, write } = orm;
let db = seed();
const line = (pid, qty) => ({ ...models['sale.order'].fields.order_line.onchange({ product_id: pid, qty, price_unit: 0, discount: 0 }, 'product_id', db, {}), qty });
let r = create(db, 'sale.order', { partner_id: 3, order_line: [line(1, 2)] });
db = btn(r.db, 'sale.order', r.id, 'Confirm').db; const so = r.id;
const pk = search(db, 'stock.picking').find((p) => p.sale_id === so);
db = btn(db, 'stock.picking', pk.id, 'Validate').db;
let b = db; db = btn(db, 'sale.order', so, 'Create Invoice').db; const inv = newIds(b, db, 'account.move')[0];
db = btn(db, 'account.move', inv, 'Confirm').db;
const base = db; const I = read(base, 'account.move', inv);
log('posted invoice', I.name, I.amount_total, 'state', I.state);
// each forged change = a record-level upsert a logged-in non-admin can POST to /api/diff
const forge = (label, model, vals, opts = {}) => {
  const rec = { ...base.records[model].find((x) => x.id === vals.id), ...vals };
  const diff = { upserts: { [model]: [rec] }, deletes: {}, messages: [], removedMessages: [], seq: base.seq, settings: null };
  const res = tryIt(() => applyDiff(base, JSON.parse(JSON.stringify(diff)), { isAdmin: false, author: 'clerk', ...opts }));
  log(`${res.ok ? 'ACCEPTED' : 'REFUSED '} | ${label}${res.ok ? '' : ' -> ' + res.error}`);
  return res.ok ? res.value : null;
};
const forgeNew = (label, model, rec) => {
  const id = (base.seq[model] ?? 0) + 1;
  const diff = { upserts: { [model]: [{ ...rec, id }] }, deletes: {}, messages: [], removedMessages: [], seq: { ...base.seq, [model]: id }, settings: null };
  const res = tryIt(() => applyDiff(base, JSON.parse(JSON.stringify(diff)), { isAdmin: false, author: 'clerk' }));
  log(`${res.ok ? 'ACCEPTED' : 'REFUSED '} | ${label}${res.ok ? '' : ' -> ' + res.error}`);
  return res.ok ? res.value : null;
};
let s;
s = forge('posted invoice -> state cancel', 'account.move', { id: inv, state: 'cancel' });
if (s) log('   receivable(partner 3) before/after', ledger(base, { partner: 3 })['121000'], ledger(s, { partner: 3 })['121000']);
s = forge('mark posted invoice paid: amount_paid = total, no payment entry', 'account.move', { id: inv, amount_paid: I.amount_total });
if (s) log('   payment_state now', read(s, 'account.move', inv).payment_state, '; 121000 for partner still', ledger(s, { partner: 3 })['121000']);
s = forge('change price on posted invoice lines (line_ids untouched)', 'account.move', { id: inv, invoice_line_ids: I.invoice_line_ids.map((l) => ({ ...l, price_unit: 1 })) });
if (s) log('   amount_total now', read(s, 'account.move', inv).amount_total, 'but journal 121000 debit', read(s, 'account.move', inv).line_ids[0].debit);
s = forge('rewrite posted journal items (debit/credit) of the invoice, unbalanced', 'account.move', { id: inv, line_ids: I.line_ids.map((l, i) => (i === 0 ? { ...l, debit: 1 } : l)) });
if (s) log('   balanced?', read(s, 'account.move', inv).line_ids.reduce((t, l) => t + l.debit - l.credit, 0));
s = forgeNew('create a POSTED unbalanced manual entry (Dr Bank 1,000,000)', 'account.move', { move_type: 'entry', state: 'posted', name: 'MISC/2026/99999', invoice_date: '2026-10-26', line_ids: [{ account_id: read(base, 'account.account', 1).id, debit: 1000000, credit: 0 }], invoice_line_ids: [] });
if (s) log('   bank 101401 before/after', ledger(base)['101401'], ledger(s)['101401']);
s = forge('re-number a posted invoice (audit trail off)', 'account.move', { id: inv, name: 'INV/2026/00001' });
s = forge('SO: reset qty_invoiced to 0 so it can be invoiced again', 'sale.order', { id: so, order_line: read(base, 'sale.order', so).order_line.map((l) => ({ ...l, qty_invoiced: 0 })) });
if (s) { const again = tryIt(() => btn(s, 'sale.order', so, 'Create Invoice')); log('   Create Invoice now visible+works:', again.ok && again.value.visible, 'new invoices', again.ok ? newIds(s, again.value.db, 'account.move') : again.error); }
s = forge('SO: draft -> sale state directly (no picking, no procurement)', 'sale.order', { id: 1, state: 'sale' });
s = forge('done delivery picking back to ready (stock already moved)', 'stock.picking', { id: pk.id, state: 'ready' });
if (s) { const v = tryIt(() => btn(s, 'stock.picking', pk.id, 'Validate').db); log('   re-validate:', v.ok ? `ACCEPTED chair on hand ${read(s, 'product', 1).qty_available} -> ${read(v.value, 'product', 1).qty_available}` : v.error); }
s = forge('product qty_available 135 -> 1e6 (readonly field)', 'product', { id: 1, qty_available: 1000000 });
s = forge('product cost 120 -> 0.01', 'product', { id: 1, cost: 0.01 });
s = forge('account.payment: set amount on posted payment', 'account.payment', { id: search(base, 'account.payment')[0].id, amount: 999999 });
// deletes
const del = (label, model, id) => { const res = tryIt(() => applyDiff(base, { upserts: {}, deletes: { [model]: [id] }, messages: [], removedMessages: [], seq: base.seq, settings: null }, { isAdmin: false })); log(`${res.ok ? 'ACCEPTED' : 'REFUSED '} | delete ${label}${res.ok ? '' : ' -> ' + res.error}`); return res.ok ? res.value : null; };
s = del('posted invoice (audit trail off, no lock)', 'account.move', inv);
if (s) log('   SO invoice_status after server delete', read(s, 'sale.order', so).invoice_status, '(onUnlink hook not run by applyDiff); qty_invoiced', read(s, 'sale.order', so).order_line[0].qty_invoiced);
s = del('done delivery picking', 'stock.picking', pk.id);
s = del('stock valuation layer', 'stock.valuation.layer', search(base, 'stock.valuation.layer').at(-1).id);
s = del('confirmed sale order', 'sale.order', so);
// with audit trail + lock date (admin settings) do guards hold?
const locked = { ...base, settings: { ...base.settings, audit_trail: true, lock_date: '2026-12-31' } };
const res = tryIt(() => applyDiff(locked, { upserts: { 'account.move': [{ ...read(locked, 'account.move', inv), state: 'cancel' }] }, deletes: {}, messages: [], removedMessages: [], seq: base.seq, settings: null }, { isAdmin: false }));
log('with lock_date+audit_trail: cancel posted invoice ->', res.ok ? 'ACCEPTED' : 'REFUSED ' + res.error);
