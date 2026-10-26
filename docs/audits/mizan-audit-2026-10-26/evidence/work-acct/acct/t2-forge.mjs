import { seed } from '../src/seed.js';
import { read, search } from '../src/orm.js';
import { applyDiff } from '../src/sync.js';
import { modelsForApps } from '../src/models/index.js';
import { invariants } from './lib.mjs';
const base = seed();
const allowedAcct = modelsForApps(['accounting']);
const allowedSales = modelsForApps(['sales']);
const allowedInv = modelsForApps(['inventory']);
const inv = search(base, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual > 0);
const raw = (db, id) => db.records['account.move'].find((m) => m.id === id);
console.log('target', inv.name, 'date', inv.invoice_date, 'total', inv.amount_total, 'paid', inv.amount_paid, 'residual', inv.amount_residual);
const tryDiff = (label, db, diff, opts) => {
  try { const next = applyDiff(db, { upserts: {}, deletes: {}, messages: [], removedMessages: [], seq: db.seq, settings: null, ...diff }, opts); console.log('ACCEPTED', label); return next; }
  catch (e) { console.log('REJECTED', label, '->', e.message); return null; }
};
const nonAdmin = { isAdmin: false, allowed: allowedAcct, author: 'mallory' };
const rec = raw(base, inv.id);
// 1. set amount_paid = total (mark paid without any payment entry)
let n = tryDiff('1 set amount_paid=total on posted invoice', base, { upserts: { 'account.move': [{ ...rec, amount_paid: inv.amount_total }] } }, nonAdmin);
if (n) { const m = read(n, 'account.move', inv.id); console.log('   -> residual', m.amount_residual, m.payment_state, '| recv gap', JSON.stringify(invariants(n).receivable)); }
// 2. change posted journal item amounts (unbalance)
const lines2 = rec.line_ids.map((l, i) => (i === 0 ? { ...l, debit: 1 } : l));
n = tryDiff('2 unbalance posted line_ids', base, { upserts: { 'account.move': [{ ...rec, line_ids: lines2 }] } }, nonAdmin);
if (n) { const v = invariants(n); console.log('   -> debit-credit diff', v.diff, 'unbalanced', v.unbalancedMoves, 'BS gap', v.BS.gap, 'TB end total', v.trialBalanceTotals.end); }
// 3. posted -> draft / cancel with lines kept
n = tryDiff('3a state posted->cancel', base, { upserts: { 'account.move': [{ ...rec, state: 'cancel' }] } }, nonAdmin);
n = tryDiff('3b state posted->draft', base, { upserts: { 'account.move': [{ ...rec, state: 'draft' }] } }, nonAdmin);
// 4. change date of posted invoice
n = tryDiff('4 move posted invoice to 2019-01-01', base, { upserts: { 'account.move': [{ ...rec, invoice_date: '2019-01-01' }] } }, nonAdmin);
// 5. new unbalanced posted entry
const maxId = Math.max(...base.records['account.move'].map((m) => m.id));
const cashAcc = base.records['account.account'].find((a) => a.code === '101401').id;
const forged = { id: maxId + 1, name: 'MISC/2026/99999', move_type: 'entry', state: 'posted', invoice_date: '2026-10-01', line_ids: [{ account_id: cashAcc, debit: 1000000, credit: 0 }] };
n = tryDiff('5 create posted one-sided entry (+1,000,000 bank)', base, { upserts: { 'account.move': [forged] } }, nonAdmin);
if (n) { const v = invariants(n); console.log('   -> sumD-sumC', v.diff, 'BS gap', v.BS.gap, 'TB', JSON.stringify(v.trialBalanceTotals)); }
// 6. a Sales-only / Inventory-only user
n = tryDiff('6a sales-only user sets amount_paid', base, { upserts: { 'account.move': [{ ...rec, amount_paid: inv.amount_total }] } }, { isAdmin: false, allowed: allowedSales });
n = tryDiff('6b inventory-only user sets amount_paid', base, { upserts: { 'account.move': [{ ...rec, amount_paid: inv.amount_total }] } }, { isAdmin: false, allowed: allowedInv });
const acc121 = base.records['account.account'].find((a) => a.code === '121000');
n = tryDiff('6c sales-only user retypes 121000 Receivable as income', base, { upserts: { 'account.account': [{ ...acc121, account_type: 'income' }] } }, { isAdmin: false, allowed: allowedSales });
if (n) { const v = invariants(n); console.log('   -> BS gap', v.BS.gap, 'P&L/BS earnings', v.BS.earnings); }
const tax = base.records['account.tax'].find((t) => t.amount === 14 && t.type_tax_use === 'sale');
n = tryDiff('6d sales-only user changes VAT 14% to 0%', base, { upserts: { 'account.tax': [{ ...tax, amount: 0 }] } }, { isAdmin: false, allowed: allowedSales });
// 7. archive a posted move (active:false) -> vanishes from reports
n = tryDiff('7 archive posted invoice (active:false)', base, { upserts: { 'account.move': [{ ...rec, active: false }] } }, nonAdmin);
if (n) { const v = invariants(n); console.log('   -> postedMoves visible', v.postedMoves, 'TB debit', v.trialBalanceTotals.debit, 'vs before', invariants(base).trialBalanceTotals.debit); }
// 8. delete a posted invoice
n = tryDiff('8 delete posted invoice (no lock, audit trail off)', base, { deletes: { 'account.move': [inv.id] } }, nonAdmin);
// 9. with lock date covering the invoice
const locked = { ...base, settings: { ...base.settings, lock_date: '2026-12-31', hard_lock_date: '2026-12-31' } };
n = tryDiff('9a [hard lock 2026-12-31] change line_ids', locked, { upserts: { 'account.move': [{ ...rec, line_ids: lines2 }] } }, nonAdmin);
n = tryDiff('9b [hard lock] set amount_paid=total', locked, { upserts: { 'account.move': [{ ...rec, amount_paid: inv.amount_total }] } }, nonAdmin);
n = tryDiff('9c [hard lock] archive active:false', locked, { upserts: { 'account.move': [{ ...rec, active: false }] } }, nonAdmin);
n = tryDiff('9d [hard lock] change company_id to 2', locked, { upserts: { 'account.move': [{ ...rec, company_id: 2 }] } }, nonAdmin);
n = tryDiff('9e [hard lock] change journal_id/fiscal_position_id/ref', locked, { upserts: { 'account.move': [{ ...rec, journal_id: 5, ref: 'x' }] } }, nonAdmin);
n = tryDiff('9f [hard lock] delete', locked, { deletes: { 'account.move': [inv.id] } }, nonAdmin);
n = tryDiff('9g [hard lock] non-admin clears hard_lock_date & lock_date via settings', locked, { settings: { ...locked.settings, lock_date: null, hard_lock_date: null } }, nonAdmin);
if (n) console.log('   -> lock_date', n.settings.lock_date, 'hard', n.settings.hard_lock_date);
n = tryDiff('9h [hard lock] ADMIN clears lock_date & hard_lock_date', locked, { settings: { ...locked.settings, lock_date: null, hard_lock_date: null } }, { isAdmin: true });
if (n) console.log('   -> lock_date', n.settings.lock_date, 'hard', n.settings.hard_lock_date);
// 9i: post into locked period through a NEW record dated after lock? and dated inside lock
n = tryDiff('9i [hard lock] create posted entry dated 2026-06-30', locked, { upserts: { 'account.move': [{ ...forged, invoice_date: '2026-06-30' }] } }, nonAdmin);
n = tryDiff('9j [hard lock] create posted unbalanced entry dated 2027-01-02', locked, { upserts: { 'account.move': [{ ...forged, invoice_date: '2027-01-02' }] } }, nonAdmin);
// 9k: field omission: diff omits invoice_date -> moveDate falls back to today
const { invoice_date, ...noDate } = rec;
n = tryDiff('9k [hard lock] upsert posted invoice WITHOUT invoice_date (and changed lines)', locked, { upserts: { 'account.move': [{ ...noDate, line_ids: lines2 }] } }, nonAdmin);
// 10. audit trail on
const audited = { ...base, settings: { ...base.settings, audit_trail: true } };
n = tryDiff('10a [audit trail] renumber posted', audited, { upserts: { 'account.move': [{ ...rec, name: 'INV/2026/77777' }] } }, nonAdmin);
n = tryDiff('10b [audit trail] change line amounts', audited, { upserts: { 'account.move': [{ ...rec, line_ids: lines2 }] } }, nonAdmin);
n = tryDiff('10c [audit trail] delete numbered', audited, { deletes: { 'account.move': [inv.id] } }, nonAdmin);
const msgs = audited.messages.filter((m) => m.model === 'account.move' && m.res_id === inv.id).map((m) => m.id);
n = tryDiff('10d [audit trail] remove audit messages', audited, { removedMessages: msgs }, nonAdmin);
if (n) console.log('   -> messages kept', n.messages.filter((m) => m.model === 'account.move' && m.res_id === inv.id).length, 'of', msgs.length);
n = tryDiff('10e [audit trail] inject backdated fake audit message', audited, { messages: [{ id: 'fake-1', model: 'account.move', res_id: inv.id, body: 'Status: Draft → Posted (approved by CFO)', kind: 'tracking', author: 'CFO', date: '2020-01-01T00:00:00Z' }] }, nonAdmin);
if (n) { const m = n.messages.find((x) => x.id === 'fake-1'); console.log('   -> stored', JSON.stringify({ author: m.author, date: m.date, body: m.body })); }
