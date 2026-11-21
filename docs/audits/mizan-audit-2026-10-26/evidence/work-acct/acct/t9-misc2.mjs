import { seed } from '../src/seed.js';
import { read, search, create } from '../src/orm.js';
import { applyDiff } from '../src/sync.js';
import { modelsForApps } from '../src/models/index.js';
import { postMove, payMove } from '../src/models/accounting.js';
import { startSession, payOrder, priceLines } from '../src/models/pos.js';
import { invariants, button, r2 } from './lib.mjs';
const base = seed();
// (a) manual entry, one line without account, negative debit
const bank = base.records['account.account'].find((a) => a.code === '101401').id;
let c = create(base, 'account.move', { move_type: 'entry', invoice_date: '2026-10-10', line_ids: [{ account_id: bank, debit: 700, credit: 0 }, { account_id: null, debit: 0, credit: 700 }] });
let db = postMove(c.db, c.id);
console.log('(a) entry with account-less line posted:', read(db, 'account.move', c.id).state, '| TB', JSON.stringify(invariants(db).trialBalanceTotals), 'BS gap', invariants(db).BS.gap);
c = create(base, 'account.move', { move_type: 'entry', invoice_date: '2026-10-10', line_ids: [{ account_id: bank, debit: -50, credit: 0 }, { account_id: base.records['account.account'].find((a) => a.code === '600000').id, debit: 0, credit: -50 }] });
db = postMove(c.db, c.id);
console.log('(a2) entry with negative debit/credit posted:', read(db, 'account.move', c.id).state);
// (b) three credit notes for one invoice
const inv = search(base, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted');
db = base;
for (let i = 0; i < 3; i++) { const o = button('account.move', 'Credit Note').run(db, read(db, 'account.move', inv.id)); db = postMove(o.db, Number(o.go.split('/').pop())); }
const cns = search(db, 'account.move').filter((m) => m.move_type === 'out_refund' && m.invoice_origin === inv.name);
console.log('(b) invoice', inv.name, 'total', inv.amount_total, '-> posted credit notes', cns.length, 'credited total', r2(cns.reduce((s, m) => s + m.amount_total, 0)));
// (c) sales-only user deletes the Product Sales income account that carries posted lines
const acc400 = base.records['account.account'].find((a) => a.code === '400000');
try {
  const n = applyDiff(base, { upserts: {}, deletes: { 'account.account': [acc400.id] }, messages: [], removedMessages: [], seq: base.seq, settings: null }, { isAdmin: false, allowed: modelsForApps(['sales']) });
  const v = invariants(n); console.log('(c) ACCEPTED sales user deletes 400000 -> TB', JSON.stringify(v.trialBalanceTotals), 'BS gap', v.BS.gap, 'orphan lines', v.linesWithUnknownAccount);
} catch (e) { console.log('(c) REJECTED', e.message); }
// (c2) duplicate account code
try {
  const n = applyDiff(base, { upserts: { 'account.account': [{ id: 999, code: '121000', name: 'Dup receivable', account_type: 'asset_receivable' }] }, deletes: {}, messages: [], removedMessages: [], seq: base.seq, settings: null }, { isAdmin: false, allowed: modelsForApps(['sales']) });
  console.log('(c2) ACCEPTED duplicate account code 121000 created by sales user; accounts with code 121000:', n.records['account.account'].filter((a) => a.code === '121000').length);
} catch (e) { console.log('(c2) REJECTED', e.message); }
// (d) overpayment
const open = search(base, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual > 0);
db = payMove(base, open.id, open.amount_residual + 500, '2026-10-25');
const pm = search(db, 'account.move').filter((m) => m.ref === `Payment ${open.name}`).at(-1);
console.log('(d) pay', open.amount_residual + 500, 'on residual', open.amount_residual, '-> bank debit', pm.line_ids[0].debit, '| payment record amount', db.records['account.payment'].at(-1).amount, '| excess recorded anywhere?', db.records['account.payment'].at(-1).unapplied ?? 'no');
// (e) POS with a price-included tax product
const inclTax = search(base, 'account.tax').find((t) => t.price_include);
const p = create(base, 'product', { name: 'Incl', list_price: 114, sale_tax: 14, tax_id: inclTax.id, type: 'service', available_in_pos: true });
db = startSession(p.db, 0).db;
const lines = priceLines(db, [{ product_id: p.id, qty: 1 }]);
const sold = payOrder(db, { lines, method: 'cash' }).db;
const posm = sold.records['account.move'].at(-1);
console.log('(e) POS sale of product priced 114 incl. 14% VAT -> cash debit', posm.line_ids[0].debit, 'revenue', posm.line_ids[1].credit, 'VAT', posm.line_ids[2]?.credit);
