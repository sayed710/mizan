import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { payMove, postMove } from './models/accounting.js';
import { reverseEntry } from './models/pay.js';
import { accountId, balances, journalItems, postEntry } from './models/ledger.js';
import { trialBalance, partnerLedger } from './models/reports.js';
import { applyDiff, diffDb } from './sync.js';

const admin = { isAdmin: true };
const sync = (a, b) => applyDiff(a, diffDb(a, b), admin);
const credit = {
  run: (db, r, ...args) => (
    models['account.move'].form.buttons.find((b) => b.label === (r?.move_type === 'in_invoice' ? 'Refund' : 'Credit Note'))
    ?? models['account.move'].form.buttons.find((b) => b.label === 'Credit Note')
  ).run(db, r, ...args),
};
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

test('ST-5 regression: clients cannot post forged negative entries linked to a posted source, and provenance is protected', () => {
  const db = write(seed(), 'res.company', 1, { account_storno: true });
  const entry = postEntry(db, { journal: 'MISC', company: 1, date: '2026-04-01', lines: [{ account_id: accountId(db, '121000'), partner_id: 2, debit: 100 }, { account_id: accountId(db, '400000'), credit: 100 }] });
  const original = read(entry.db, 'account.move', entry.id);

  // Forged negative lines with arbitrary accounts linked to a posted entry must be rejected
  const draft = create(entry.db, 'account.move', { move_type: 'entry', company_id: 1, date: '2026-04-01', line_ids: [] });
  const forged = structuredClone(draft.db);
  const move = forged.records['account.move'].find((m) => m.id === draft.id);
  Object.assign(move, {
    state: 'posted',
    name: 'MISC/2026/0099',
    is_storno: true,
    reversed_entry_id: original.id,
    line_ids: [
      { account_id: accountId(db, '600000'), debit: -500, credit: 0 },
      { account_id: accountId(db, '101401'), debit: 0, credit: -500 },
    ],
  });
  assert.throws(() => sync(draft.db, forged), /negative|storno/i);

  // Forged negative lines with inflated amounts on the same accounts must also be rejected
  const forged2 = structuredClone(draft.db);
  const move2 = forged2.records['account.move'].find((m) => m.id === draft.id);
  Object.assign(move2, {
    state: 'posted',
    name: 'MISC/2026/0098',
    is_storno: true,
    reversed_entry_id: original.id,
    line_ids: [
      { account_id: accountId(db, '121000'), partner_id: 2, debit: -500, credit: 0 },
      { account_id: accountId(db, '400000'), debit: 0, credit: -500 },
    ],
  });
  assert.throws(() => sync(draft.db, forged2), /negative|storno/i);

  // Modifying is_storno or reversed_entry_id on an already posted move must be rejected
  const legitimate = reverseEntry(entry.db, original, '2026-04-02');
  const postedRev = read(legitimate.db, 'account.move', legitimate.id);
  const tampered = structuredClone(legitimate.db);
  const tamperedMove = tampered.records['account.move'].find((m) => m.id === postedRev.id);
  tamperedMove.is_storno = false;
  assert.throws(() => sync(legitimate.db, tampered), /Posted entries cannot be edited/i);

  const tampered2 = structuredClone(legitimate.db);
  const tamperedMove2 = tampered2.records['account.move'].find((m) => m.id === postedRev.id);
  tamperedMove2.reversed_entry_id = null;
  assert.throws(() => sync(legitimate.db, tampered2), /Posted entries cannot be edited/i);
});

test('ST-6 regression: rounded storno credits can be posted without negative total rejection', () => {
  let db = write(seed(), 'res.company', 1, { account_storno: true });
  const cashRounding = create(db, 'account.cash.rounding', {
    name: '0.05 cash rounding',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'add_invoice_line',
    profit_account_id: accountId(db, '450300'),
    loss_account_id: accountId(db, '690300'),
  });
  db = cashRounding.db;
  const created = create(db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-04-01',
    invoice_cash_rounding_id: cashRounding.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100.03, tax: 0 }],
  });
  db = postMove(created.db, created.id);
  const original = read(db, 'account.move', created.id);
  const draft = credit.run(db, original, { refund_method: 'refund', date: '2026-04-02' });
  const posted = postMove(draft.db, draft.id);
  const reversal = read(posted, 'account.move', draft.id);
  assert.equal(reversal.state, 'posted');
  assert.ok(reversal.is_storno);
});

test('ST-7 regression: disabling company storno does not strand already-created pending reversals or reset moves', () => {
  let db = write(seed(), 'res.company', 1, { account_storno: true });
  const inv = create(db, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-04-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = payMove(postMove(inv.db, inv.id), inv.id, 100, '2026-04-01');
  const origInv = read(db, 'account.move', inv.id);
  const draftCredit = credit.run(db, origInv, { refund_method: 'refund', date: '2026-04-02' });
  db = draftCredit.db;

  const entry = postEntry(db, { journal: 'MISC', company: 1, date: '2026-04-01', lines: [{ account_id: accountId(db, '121000'), partner_id: 2, debit: 100 }, { account_id: accountId(db, '400000'), credit: 100 }] });
  const origEntry = read(entry.db, 'account.move', entry.id);
  const scheduled = reverseEntry(entry.db, origEntry, { date: '2026-04-02', scheduled: true });
  db = scheduled.db;

  // Administrator disables storno before drafts are posted
  db = write(db, 'res.company', 1, { account_storno: false });

  // Draft credit note and scheduled reversal must still post successfully
  const postedCreditDb = postMove(db, draftCredit.id);
  assert.equal(read(postedCreditDb, 'account.move', draftCredit.id).state, 'posted');

  const postedScheduledDb = postMove(db, scheduled.id, { autoPost: true });
  assert.equal(read(postedScheduledDb, 'account.move', scheduled.id).state, 'posted');

  // Resetting a posted storno credit note to draft and posting again must also succeed
  const resetBtn = models['account.move'].form.buttons.find((b) => b.label === 'Reset to Draft');
  const resetDb = resetBtn.run(postedCreditDb, read(postedCreditDb, 'account.move', draftCredit.id)).db;
  const repostedDb = postMove(resetDb, draftCredit.id);
  assert.equal(read(repostedDb, 'account.move', draftCredit.id).state, 'posted');
});

test('ST-8 regression: recurring storno credits post next occurrences without stranding', () => {
  let db = write(seed(), 'res.company', 1, { account_storno: true });
  const inv = create(db, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-04-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  const origInv = read(db, 'account.move', inv.id);
  const draftCredit = credit.run(db, origInv, { refund_method: 'refund', date: '2026-04-02' });
  db = write(draftCredit.db, 'account.move', draftCredit.id, { auto_post: 'monthly' });
  const postedCreditDb = postMove(db, draftCredit.id);
  const postedCredit = read(postedCreditDb, 'account.move', draftCredit.id);
  assert.equal(postedCredit.state, 'posted');

  // Next draft was spawned
  const nextDraft = (postedCreditDb.records['account.move'] ?? []).find((m) => m.auto_post_origin_id === draftCredit.id);
  assert.ok(nextDraft);
  assert.equal(nextDraft.state, 'draft');

  // Auto-posting or posting the next occurrence must succeed
  const nextPostedDb = postMove(postedCreditDb, nextDraft.id, { autoPost: true });
  assert.equal(read(nextPostedDb, 'account.move', nextDraft.id).state, 'posted');
});
