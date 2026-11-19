import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { today } from './models/common.js';
import { accountId, journalItemIdentity, journalItems, postEntry, reconciledJournalItems } from './models/ledger.js';
import { reconcileLedgerItems } from './models/glReconcile.js';
import { postAutoPostMoves } from './models/accounting.js';
import { reverseEntry } from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';

const button = (label) => models['account.move'].form.buttons.find((b) => b.label === label);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function setup() {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Reversal Customer' });
  db = partner.db;
  const ar = read(db, 'res.company', 1)?.account_default_receivable_id ?? accountId(db, '121000', 1);
  const rev = accountId(db, '400000', 1);
  const misc = search(db, 'account.journal').find((j) => j.type === 'general');
  const post = (d, lines) => {
    const targetDb = d ?? db;
    const lineList = typeof lines === 'function' ? lines(targetDb) : lines;
    const made = postEntry(targetDb, { journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'R1', lines: lineList });
    db = made.db;
    return made.id;
  };
  const src = post(db, () => [{ account_id: ar, partner_id: partner.id, debit: 100 }, { account_id: rev, credit: 100 }]);
  return { get db() { return db; }, set db(v) { db = v; }, src, ar, rev, partner, misc, post };
}

const arLine = (db, moveId, ar) => reconciledJournalItems(db, read(db, 'account.move', moveId)).find((l) => l.account_id === ar);
const arItem = (db, moveId, ar) => journalItems(db).find((l) => l.move_id === moveId && l.account_id === ar);
const sel = (db, moveId, ar) => ({ move_id: moveId, line_identity: journalItemIdentity(read(db, 'account.move', moveId).line_ids.find((l) => l.account_id === ar)) });

test('reversing a posted entry reconciles reconcilable lines with the reversal', () => {
  const { db, src, ar, rev } = setup();
  const out = reverseEntry(db, read(db, 'account.move', src), '2026-05-01');
  const a = arLine(out.db, src, ar);
  const b = arLine(out.db, out.id, ar);
  assert.equal(a.account_id, b.account_id);
  assert.equal(Number(a.debit) || 0, Number(b.credit) || 0);
  assert.equal(Number(a.credit) || 0, Number(b.debit) || 0);
  assert.equal(a.reconciled, true);
  assert.equal(b.reconciled, true);
  assert.ok(a.matching_number?.startsWith('A'));
  assert.equal(a.matching_number, b.matching_number);
  assert.equal(reconciledJournalItems(out.db, read(out.db, 'account.move', src)).find((l) => l.account_id === rev).reconciled, false);
  const replay = applyDiff(db, diffDb(db, out.db));
  assert.equal(arLine(replay, src, ar).reconciled, true);
});

test('a line already fully reconciled is skipped; a partly reconciled line is matched for its remainder', () => {
  const s = setup();
  const pay = s.post(null, () => [{ account_id: s.ar, partner_id: s.partner.id, credit: 100 }, { account_id: s.rev, debit: 100 }]);
  const full = reconcileLedgerItems(s.db, [sel(s.db, s.src, s.ar), sel(s.db, pay, s.ar)], { date: '2026-04-02' });
  const n = (search(full, 'account.partial.reconcile') ?? []).length;
  const out = reverseEntry(full, read(full, 'account.move', s.src), '2026-05-01');
  assert.equal(search(out.db, 'account.partial.reconcile').length, n);
  assert.equal(arLine(out.db, out.id, s.ar).reconciled, false);

  const s2 = setup();
  const payPart = s2.post(null, () => [{ account_id: s2.ar, partner_id: s2.partner.id, credit: 40 }, { account_id: s2.rev, debit: 40 }]);
  const part = reconcileLedgerItems(s2.db, [sel(s2.db, s2.src, s2.ar), sel(s2.db, payPart, s2.ar)], { date: '2026-04-02' });
  const outPart = reverseEntry(part, read(part, 'account.move', s2.src), '2026-05-01');
  const srcAfter = arLine(outPart.db, s2.src, s2.ar);
  const revAfter = arLine(outPart.db, outPart.id, s2.ar);
  assert.equal(srcAfter.reconciled, true);
  assert.equal(revAfter.reconciled, false);
  assert.equal(revAfter.amount_residual, -40);
  assert.match(arItem(outPart.db, outPart.id, s2.ar).matching_number, /^P\d+$/);
});

test('exchange-entry reversal path is untouched (reconciliation reversal does not auto-reconcile)', () => {
  const { db, src, ar } = setup();
  const out = reverseEntry(db, read(db, 'account.move', src), { date: '2026-05-01', reconciliation_reversal: true });
  assert.equal(arLine(out.db, out.id, ar).reconciled, false);
});

test('future-dated reversal wizard creates a scheduled draft; today or earlier posts now', () => {
  const { db, src } = setup();
  const future = addDays(today(), 10);
  const out = button('Reverse Entry').run(db, read(db, 'account.move', src), { date: future, mode: 'reverse' });
  const rev = read(out.db, 'account.move', out.id);
  assert.equal(rev.state, 'draft');
  assert.equal(rev.auto_post, 'at_date');
  assert.equal(rev.date, future);
  assert.equal(journalItems(out.db).some((l) => l.move_id === out.id), false);
  const replay = applyDiff(db, diffDb(db, out.db));
  assert.equal(read(replay, 'account.move', out.id).auto_post, 'at_date');
  const posted = postAutoPostMoves(out.db, future);
  assert.equal(read(posted, 'account.move', out.id).state, 'posted');
  const now = button('Reverse Entry').run(db, read(db, 'account.move', src), { date: today(), mode: 'reverse' });
  assert.equal(read(now.db, 'account.move', now.id).state, 'posted');
});

test('Reset to Draft cancels a scheduled draft reversal', () => {
  const { db, src } = setup();
  const out = button('Reverse Entry').run(db, read(db, 'account.move', src), { date: addDays(today(), 5), mode: 'reverse' });
  const reset = button('Reset to Draft').run(out.db, read(out.db, 'account.move', src));
  assert.equal(read(reset.db, 'account.move', src).state, 'draft');
  assert.equal(read(reset.db, 'account.move', out.id).state, 'cancel');
  assert.equal(read(reset.db, 'account.move', src).reversal_move_id ?? null, null);
  const replay = applyDiff(out.db, diffDb(out.db, reset.db));
  assert.equal(read(replay, 'account.move', out.id).state, 'cancel');
  assert.equal(postAutoPostMoves(reset.db, addDays(today(), 30)).records['account.move'].filter((m) => m.state === 'posted' && m.reversed_entry_id === src).length, 0);
});

test('partially reconciled line shows P + matching number; full match keeps A numbering', () => {
  const s = setup();
  const pay1 = s.post(null, () => [{ account_id: s.ar, partner_id: s.partner.id, credit: 40 }, { account_id: s.rev, debit: 40 }]);
  const part = reconcileLedgerItems(s.db, [sel(s.db, s.src, s.ar), sel(s.db, pay1, s.ar)], { date: '2026-04-02' });
  const open = arItem(part, s.src, s.ar);
  assert.equal(open.reconciled, false);
  assert.match(open.matching_number, /^P\d+$/);

  const replayPart = applyDiff(s.db, diffDb(s.db, part));
  assert.equal(arItem(replayPart, s.src, s.ar).matching_number, open.matching_number);

  const pay2 = s.post(part, () => [{ account_id: s.ar, partner_id: s.partner.id, credit: 60 }, { account_id: s.rev, debit: 60 }]);
  const full = reconcileLedgerItems(s.db, [sel(s.db, s.src, s.ar), sel(s.db, pay2, s.ar)], { date: '2026-04-04' });
  const fullLine = arItem(full, s.src, s.ar);
  assert.equal(fullLine.reconciled, true);
  assert.match(fullLine.matching_number, /^A\d+$/);
});

test('scheduled reversal posted later reconciles source and reversal lines; paired lines have matching accounts and opposite amounts', () => {
  const { db, src, ar } = setup();
  const future = addDays(today(), 10);
  const out = button('Reverse Entry').run(db, read(db, 'account.move', src), { date: future, mode: 'reverse' });
  const posted = postAutoPostMoves(out.db, future);
  assert.equal(read(posted, 'account.move', out.id).state, 'posted');
  const a = arLine(posted, src, ar);
  const b = arLine(posted, out.id, ar);
  assert.equal(a.account_id, b.account_id);
  assert.equal(Number(a.debit) || 0, Number(b.credit) || 0);
  assert.equal(Number(a.credit) || 0, Number(b.debit) || 0);
  assert.equal(a.reconciled, true);
  assert.equal(b.reconciled, true);
  assert.ok(a.matching_number?.startsWith('A'));
  assert.equal(a.matching_number, b.matching_number);
});
