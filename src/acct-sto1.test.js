import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { reverseEntry } from './models/pay.js';
import { accountId, balances, journalItems, postEntry } from './models/ledger.js';
import { trialBalance, partnerLedger } from './models/reports.js';
import { applyDiff, diffDb } from './sync.js';

const admin = { isAdmin: true };
const sync = (a, b) => applyDiff(a, diffDb(a, b), admin);
const credit = models['account.move'].form.buttons.find((b) => b.label === 'Credit Note');
function invoice(storno, type = 'out_invoice') {
  let db = write(seed(), 'res.company', 1, { account_storno: storno });
  const created = create(db, 'account.move', { company_id: 1, move_type: type, partner_id: type === 'out_invoice' ? 2 : 4, invoice_date: '2026-04-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(created.db, created.id);
  const original = read(db, 'account.move', created.id);
  const draft = credit.run(db, original, { refund_method: 'refund', date: '2026-04-02' });
  const posted = postMove(draft.db, draft.id);
  return { base: draft.db, db: posted, original, reversal: read(posted, 'account.move', draft.id) };
}
function signs(original, reversal, storno) {
  assert.equal(Boolean(reversal.is_storno), storno);
  for (const line of original.line_ids) {
    const match = reversal.line_ids.find((x) => x.account_id === line.account_id);
    assert.ok(match);
    assert.equal(match.debit || 0, storno ? -(line.debit || 0) || 0 : line.credit || 0);
    assert.equal(match.credit || 0, storno ? -(line.credit || 0) || 0 : line.debit || 0);
  }
}
test('ST-1 company exposes a protected storno accounting setting', () => {
  assert.equal(models['res.company'].fields.account_storno.type, 'boolean');
  const db = seed();
  const changed = write(db, 'res.company', 1, { account_storno: true });
  assert.equal(read(sync(db, changed), 'res.company', 1).account_storno, true);
  assert.throws(() => applyDiff(db, diffDb(db, changed), { isAdmin: false }), /administrators/);
});
test('ST-2 invoice and bill reversals use the configured side', () => {
  for (const type of ['out_invoice', 'in_invoice']) for (const enabled of [false, true]) {
    const result = invoice(enabled, type);
    signs(result.original, result.reversal, enabled);
    assert.equal(read(sync(result.base, result.db), 'account.move', result.reversal.id).state, 'posted');
  }
});
test('ST-2 and ST-3 journal reversal signs and diff guard', () => {
  for (const enabled of [false, true]) {
    const db = write(seed(), 'res.company', 1, { account_storno: enabled });
    const entry = postEntry(db, { journal: 'MISC', company: 1, date: '2026-04-01', lines: [{ account_id: accountId(db, '121000'), partner_id: 2, debit: 100 }, { account_id: accountId(db, '400000'), credit: 100 }] });
    const original = read(entry.db, 'account.move', entry.id);
    const result = reverseEntry(entry.db, original, '2026-04-02');
    signs(original, read(result.db, 'account.move', result.id), enabled);
    const applied = sync(entry.db, result.db);
    assert.equal(read(applied, 'account.move', result.id).state, 'posted');
    assert.ok((applied.records['account.partial.reconcile'] ?? []).some((r) => r.debit_move_id === original.id || r.credit_move_id === original.id));
    const scheduled = reverseEntry(entry.db, original, { date: '2026-04-02', scheduled: true });
    signs(original, read(scheduled.db, 'account.move', scheduled.id), enabled);
    const posted = postMove(scheduled.db, scheduled.id, { autoPost: true });
    assert.equal(read(sync(scheduled.db, posted), 'account.move', scheduled.id).state, 'posted');
  }
});
test('ST-3 negative lines cannot be forged as a storno move through a diff', () => {
  const db = write(seed(), 'res.company', 1, { account_storno: true });
  const draft = create(db, 'account.move', { move_type: 'entry', company_id: 1, date: '2026-04-01', line_ids: [] });
  const forged = structuredClone(draft.db);
  const move = forged.records['account.move'].find((m) => m.id === draft.id);
  Object.assign(move, { state: 'posted', is_storno: true, line_ids: [{ account_id: accountId(db, '121000'), debit: -100, credit: 0 }, { account_id: accountId(db, '400000'), debit: 0, credit: -100 }] });
  assert.throws(() => sync(draft.db, forged), /negative|storno/i);
  const off = write(draft.db, 'res.company', 1, { account_storno: false });
  const forgedOff = structuredClone(off);
  Object.assign(forgedOff.records['account.move'].find((m) => m.id === draft.id), move);
  assert.throws(() => sync(off, forgedOff), /negative|storno/i);
});
test('ST-4 invoice reversal keeps balances and reports equivalent', () => {
  const normal = invoice(false); const storno = invoice(true);
  const accounts = (db) => balances(db, journalItems(db)).map((x) => [x.account.id, x.balance]);
  assert.deepEqual(accounts(storno.db), accounts(normal.db));
  assert.deepEqual(trialBalance(storno.db).rows.map((x) => [x.account.id, x.end]).filter((x) => x[1]), trialBalance(normal.db).rows.map((x) => [x.account.id, x.end]).filter((x) => x[1]));
  assert.deepEqual(partnerLedger(storno.db).map((x) => [x.partner_id, x.end]), partnerLedger(normal.db).map((x) => [x.partner_id, x.end]));
  assert.ok(storno.reversal.line_ids.some((l) => l.debit < 0 || l.credit < 0));
});
