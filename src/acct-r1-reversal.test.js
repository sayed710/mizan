import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { today } from './models/common.js';
import { accountId, journalItemIdentity, journalItems, postEntry, reconciledJournalItems } from './models/ledger.js';
import { reconcileLedgerItems } from './models/glReconcile.js';
import { postAutoPostMoves, postMove } from './models/accounting.js';
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

test('scheduling depends only on reversal date regardless of source date, honoring explicit scheduled option', () => {
  const { db, ar, rev, partner, misc } = setup();
  const srcDate = addDays(today(), 5);
  const revDate = addDays(today(), 10);
  const futureSrc = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: srcDate, ref: 'FUT-SRC',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 100 }, { account_id: rev, credit: 100 }],
  });
  const scheduled = button('Reverse Entry').run(futureSrc.db, read(futureSrc.db, 'account.move', futureSrc.id), { date: revDate, mode: 'reverse' });
  const schedRev = read(scheduled.db, 'account.move', scheduled.id);
  assert.equal(schedRev.state, 'draft');
  assert.equal(schedRev.auto_post, 'at_date');

  const unscheduled = button('Reverse Entry').run(futureSrc.db, read(futureSrc.db, 'account.move', futureSrc.id), { date: revDate, scheduled: false, mode: 'reverse' });
  assert.equal(read(unscheduled.db, 'account.move', unscheduled.id).state, 'posted');
});

test('Reset to Draft cancels linked scheduled draft reversals regardless of auto_reverse or source date', () => {
  const { db, ar, rev, partner, misc } = setup();
  const srcDate = addDays(today(), 5);
  const revDate = addDays(today(), 10);

  // Future-dated source entry reversed into a scheduled draft
  const futureSrc = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: srcDate, ref: 'FUT-RESET',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 80 }, { account_id: rev, credit: 80 }],
  });
  const reversedFut = button('Reverse Entry').run(futureSrc.db, read(futureSrc.db, 'account.move', futureSrc.id), { date: revDate, mode: 'reverse' });
  assert.equal(read(reversedFut.db, 'account.move', reversedFut.id).state, 'draft');
  const resetFut = button('Reset to Draft').run(reversedFut.db, read(reversedFut.db, 'account.move', futureSrc.id));
  assert.equal(read(resetFut.db, 'account.move', futureSrc.id).state, 'draft');
  assert.equal(read(resetFut.db, 'account.move', futureSrc.id).reversal_move_id ?? null, null);
  assert.equal(read(resetFut.db, 'account.move', reversedFut.id).state, 'cancel');
  assert.equal(read(resetFut.db, 'account.move', reversedFut.id).auto_post, 'no');
  const replayFut = applyDiff(reversedFut.db, diffDb(reversedFut.db, resetFut.db));
  assert.equal(read(replayFut, 'account.move', reversedFut.id).state, 'cancel');

  // Auto-reversing source entry
  const autoDraft = create(db, 'account.move', {
    move_type: 'entry', journal_id: misc.id, company_id: 1, date: today(), invoice_date: today(),
    auto_reverse: true, reverse_date: revDate,
    line_ids: [{ account_id: ar, partner_id: partner.id, debit: 60 }, { account_id: rev, credit: 60 }],
  });
  const postedAuto = postMove(autoDraft.db, autoDraft.id);
  const autoRevId = read(postedAuto, 'account.move', autoDraft.id).reversal_move_id;
  assert.ok(autoRevId);
  assert.equal(read(postedAuto, 'account.move', autoRevId).state, 'draft');
  const resetAuto = button('Reset to Draft').run(postedAuto, read(postedAuto, 'account.move', autoDraft.id));
  assert.equal(read(resetAuto.db, 'account.move', autoDraft.id).state, 'draft');
  assert.equal(read(resetAuto.db, 'account.move', autoDraft.id).reversal_move_id ?? null, null);
  assert.equal(read(resetAuto.db, 'account.move', autoRevId).state, 'cancel');
  assert.equal(read(resetAuto.db, 'account.move', autoRevId).auto_post, 'no');
  const replayAuto = applyDiff(postedAuto, diffDb(postedAuto, resetAuto.db));
  assert.equal(read(replayAuto, 'account.move', autoRevId).state, 'cancel');
});

test('ordinary Post / postMove reconciles due draft reversal cleanly and respects exclusions', () => {
  const { db, src, ar } = setup();
  const dueDraft = reverseEntry(db, read(db, 'account.move', src), { date: today(), scheduled: true });
  assert.equal(read(dueDraft.db, 'account.move', dueDraft.id).state, 'draft');
  const posted = postMove(dueDraft.db, dueDraft.id);
  assert.equal(read(posted, 'account.move', dueDraft.id).state, 'posted');
  const srcLine = arLine(posted, src, ar);
  const revLine = arLine(posted, dueDraft.id, ar);
  assert.equal(srcLine.reconciled, true);
  assert.equal(revLine.reconciled, true);
  assert.equal(srcLine.matching_number, revLine.matching_number);

  // Ordinary Post button on a due draft reversal reconciles cleanly
  const s1b = setup();
  const dueBtnDraft = reverseEntry(s1b.db, read(s1b.db, 'account.move', s1b.src), { date: today(), scheduled: true });
  const postedBtn = button('Post').run(dueBtnDraft.db, read(dueBtnDraft.db, 'account.move', dueBtnDraft.id)).db;
  assert.equal(arLine(postedBtn, s1b.src, s1b.ar).reconciled, true);
  assert.equal(arLine(postedBtn, dueBtnDraft.id, s1b.ar).reconciled, true);

  // Reconciliation reversal exclusion preserved on draft postMove path
  const s2 = setup();
  const excluded = reverseEntry(s2.db, read(s2.db, 'account.move', s2.src), { date: today(), scheduled: true, reconciliation_reversal: true });
  const postedExcluded = postMove(excluded.db, excluded.id);
  assert.equal(read(postedExcluded, 'account.move', excluded.id).state, 'posted');
  assert.equal(arLine(postedExcluded, excluded.id, s2.ar).reconciled, false);

  // Scheduler posting runs shared postMove reconciliation once (no duplicate partial links)
  const s3 = setup();
  const schedOut = button('Reverse Entry').run(s3.db, read(s3.db, 'account.move', s3.src), { date: addDays(today(), 5), mode: 'reverse' });
  const schedPosted = postAutoPostMoves(schedOut.db, addDays(today(), 5));
  assert.equal(search(schedPosted, 'account.partial.reconcile').length, 1);
  assert.equal(arLine(schedPosted, s3.src, s3.ar).reconciled, true);
  assert.equal(arLine(schedPosted, schedOut.id, s3.ar).reconciled, true);
});

test('future scheduled at_date draft cannot be posted manually before its date, but scheduler posts it when due', () => {
  const { db, src, ar } = setup();
  const future = addDays(today(), 10);
  const out = button('Reverse Entry').run(db, read(db, 'account.move', src), { date: future, mode: 'reverse' });
  const expectedMsg = new RegExp(`This entry is scheduled to post automatically on ${future}`);
  assert.throws(() => postMove(out.db, out.id), expectedMsg);
  assert.throws(() => button('Post').run(out.db, read(out.db, 'account.move', out.id)), expectedMsg);

  const posted = postAutoPostMoves(out.db, future);
  assert.equal(read(posted, 'account.move', out.id).state, 'posted');
  assert.equal(arLine(posted, src, ar).reconciled, true);
  assert.equal(arLine(posted, out.id, ar).reconciled, true);
});

test('transitive partial matching: line A partially matched to B (link 1) and to C (link 2) results in A, B and C all showing the same P number', () => {
  const s = setup();
  // Line A has debit 100 on AR
  const payB = s.post(null, () => [{ account_id: s.ar, partner_id: s.partner.id, credit: 30 }, { account_id: s.rev, debit: 30 }]);
  const payC = s.post(null, () => [{ account_id: s.ar, partner_id: s.partner.id, credit: 40 }, { account_id: s.rev, debit: 40 }]);

  // Link 1: match A with B for 30
  const db1 = reconcileLedgerItems(s.db, [sel(s.db, s.src, s.ar), sel(s.db, payB, s.ar)], { date: '2026-04-02' });
  // Link 2: match A with C for 40
  const db2 = reconcileLedgerItems(db1, [sel(db1, s.src, s.ar), sel(db1, payC, s.ar)], { date: '2026-04-03' });

  const aItem = arItem(db2, s.src, s.ar);
  const bItem = arItem(db2, payB, s.ar);
  const cItem = arItem(db2, payC, s.ar);

  assert.ok(aItem.matching_number?.startsWith('P'), `Expected A to have P matching number, got ${aItem.matching_number}`);
  assert.equal(aItem.matching_number, bItem.matching_number);
  assert.equal(aItem.matching_number, cItem.matching_number);

  assert.equal(reconciledJournalItems(db2, read(db2, 'account.move', s.src), { partialMatching: true })[0].matching_number, aItem.matching_number);
  assert.equal(reconciledJournalItems(db2, read(db2, 'account.move', payB), { partialMatching: true })[0].matching_number, bItem.matching_number);
  assert.equal(reconciledJournalItems(db2, read(db2, 'account.move', payC), { partialMatching: true })[0].matching_number, cItem.matching_number);
});

test('entry with two identical receivable lines reversed: all four lines end reconciled', () => {
  const s = setup();
  const dup = s.post(null, () => [
    { account_id: s.ar, partner_id: s.partner.id, debit: 50 },
    { account_id: s.ar, partner_id: s.partner.id, debit: 50 },
    { account_id: s.rev, credit: 100 },
  ]);
  const out = reverseEntry(s.db, read(s.db, 'account.move', dup), '2026-05-01');
  assert.equal(read(out.db, 'account.move', out.id).state, 'posted');
  const srcLines = reconciledJournalItems(out.db, read(out.db, 'account.move', dup)).filter((l) => l.account_id === s.ar);
  const revLines = reconciledJournalItems(out.db, read(out.db, 'account.move', out.id)).filter((l) => l.account_id === s.ar);
  assert.equal(srcLines.length, 2);
  assert.equal(revLines.length, 2);
  assert.equal(srcLines[0].reconciled, true);
  assert.equal(srcLines[1].reconciled, true);
  assert.equal(revLines[0].reconciled, true);
  assert.equal(revLines[1].reconciled, true);
});

