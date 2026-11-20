import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { today } from './models/common.js';
import { accountId, postEntry } from './models/ledger.js';
import { postAutoPostMoves, postMove } from './models/accounting.js';
import { upsertCurrencyRate } from './models/currency.js';
import { applyDiff, diffDb } from './sync.js';

const button = (label) => models['account.move'].form.buttons.find((b) => b.label === label);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function setupDb() {
  let db = seed();
  let eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  if (!eur) {
    const created = create(db, 'res.currency', { name: 'EUR', symbol: '€', rounding: 0.01, active: true });
    db = created.db;
    eur = read(db, 'res.currency', created.id);
  } else if (!eur.active) {
    db = write(db, 'res.currency', eur.id, { active: true });
    eur = read(db, 'res.currency', eur.id);
  }
  db = upsertCurrencyRate(db, eur.id, { date: '2026-01-01', rate: 1.25, companyId: 1 });
  const misc = search(db, 'account.journal').find((j) => j.type === 'general');
  const expAccount = accountId(db, '600000', 1);
  const cashAccount = accountId(db, '101401', 1) ?? accountId(db, '101000', 1);
  return { db, eur, misc, expAccount, cashAccount };
}

// ---------------------------------------------------------------------------
// JE-11 Tests: Reset to draft cancels unposted scheduled auto-reversal
// ---------------------------------------------------------------------------

test('JE-11: Reset to Draft cancels a scheduled draft reversal with auto_post at_date', () => {
  const { db: initDb, misc, expAccount, cashAccount } = setupDb();
  const future = addDays(today(), 5);

  const posted = postEntry(initDb, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: today(),
    ref: 'SRC-REV-1',
    lines: [
      { account_id: expAccount, debit: 100 },
      { account_id: cashAccount, credit: 100 },
    ],
  });

  const revOut = button('Reverse Entry').run(posted.db, read(posted.db, 'account.move', posted.id), {
    date: future,
    mode: 'reverse',
  });
  const revMove = read(revOut.db, 'account.move', revOut.id);
  assert.equal(revMove.state, 'draft');
  assert.equal(revMove.auto_post, 'at_date');

  const reset = button('Reset to Draft').run(revOut.db, read(revOut.db, 'account.move', posted.id));
  assert.equal(read(reset.db, 'account.move', posted.id).state, 'draft');
  assert.equal(read(reset.db, 'account.move', revOut.id).state, 'cancel');
  assert.equal(read(reset.db, 'account.move', revOut.id).auto_post, 'no');
  assert.equal(read(reset.db, 'account.move', posted.id).reversal_move_id ?? null, null);

  const replayed = applyDiff(revOut.db, diffDb(revOut.db, reset.db));
  assert.equal(read(replayed, 'account.move', revOut.id).state, 'cancel');

  const autoPosted = postAutoPostMoves(reset.db, addDays(today(), 30));
  const stillCancelled = read(autoPosted, 'account.move', revOut.id);
  assert.equal(stillCancelled.state, 'cancel');
});

test('JE-11: Reset to Draft cancels a draft reversal with recurring auto_post (e.g. monthly)', () => {
  const { db: initDb, misc, expAccount, cashAccount } = setupDb();
  const future = addDays(today(), 5);

  const posted = postEntry(initDb, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: today(),
    ref: 'SRC-REV-MONTHLY',
    lines: [
      { account_id: expAccount, debit: 100 },
      { account_id: cashAccount, credit: 100 },
    ],
  });

  // Create a draft reversal with auto_post = 'monthly'
  const draftRev = create(posted.db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    name: '/',
    auto_post: 'monthly',
    journal_id: misc.id,
    company_id: 1,
    date: future,
    invoice_date: future,
    reversed_entry_id: posted.id,
    ref: `Reversal of ${read(posted.db, 'account.move', posted.id).name}`,
    line_ids: [
      { account_id: expAccount, credit: 100, debit: 0 },
      { account_id: cashAccount, debit: 100, credit: 0 },
    ],
  });

  const withRevLink = write(draftRev.db, 'account.move', posted.id, { reversal_move_id: draftRev.id });

  // Reset source entry to draft
  const reset = button('Reset to Draft').run(withRevLink, read(withRevLink, 'account.move', posted.id));
  assert.equal(read(reset.db, 'account.move', posted.id).state, 'draft');
  assert.equal(read(reset.db, 'account.move', draftRev.id).state, 'cancel');
  assert.equal(read(reset.db, 'account.move', draftRev.id).auto_post, 'no');
  assert.equal(read(reset.db, 'account.move', posted.id).reversal_move_id ?? null, null);

  // Scheduled auto-post job runs without error and never tries to post the cancelled reversal
  const autoPosted = postAutoPostMoves(reset.db, addDays(today(), 40));
  assert.equal(read(autoPosted, 'account.move', draftRev.id).state, 'cancel');
});

test('JE-11: A reversal that is already posted is not cancelled or touched when resetting to draft', () => {
  const { db: initDb, misc, expAccount, cashAccount } = setupDb();

  const posted = postEntry(initDb, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: today(),
    ref: 'SRC-REV-POSTED',
    lines: [
      { account_id: expAccount, debit: 100 },
      { account_id: cashAccount, credit: 100 },
    ],
  });

  // Reversal posted immediately (today or earlier)
  const revOut = button('Reverse Entry').run(posted.db, read(posted.db, 'account.move', posted.id), {
    date: today(),
    mode: 'reverse',
  });
  const revMove = read(revOut.db, 'account.move', revOut.id);
  assert.equal(revMove.state, 'posted');

  // Attempting reset on posted source entry
  const reset = button('Reset to Draft').run(revOut.db, read(revOut.db, 'account.move', posted.id));
  // Posted reversal move remains posted and is not touched
  assert.equal(read(reset.db, 'account.move', revOut.id).state, 'posted');
});

// ---------------------------------------------------------------------------
// FX-10 Tests: Journal item currency conversion and sign checks
// ---------------------------------------------------------------------------

test('FX-10: On manual JE line with foreign currency, editing amount_currency computes debit/credit in company currency at entry date rate', () => {
  const { db, eur } = setupDb();
  const lineItem = models['account.move'].fields.line_ids;
  const move = { move_type: 'entry', date: '2026-04-01', company_id: 1 };

  // Rate is 1.25 EUR per 1 USD (company currency USD)
  // Positive amount_currency (125 EUR) -> debit: 100 USD, credit: 0
  const updatedPositive = lineItem.onchange(
    { currency_id: eur.id, amount_currency: 125, debit: 0, credit: 0 },
    'amount_currency',
    db,
    move,
  );
  assert.equal(updatedPositive.debit, 100);
  assert.equal(updatedPositive.credit, 0);

  // Negative amount_currency (-125 EUR) -> debit: 0, credit: 100 USD
  const updatedNegative = lineItem.onchange(
    { currency_id: eur.id, amount_currency: -125, debit: 0, credit: 0 },
    'amount_currency',
    db,
    move,
  );
  assert.equal(updatedNegative.debit, 0);
  assert.equal(updatedNegative.credit, 100);

  // Zero amount_currency -> debit: 0, credit: 0
  const updatedZero = lineItem.onchange(
    { currency_id: eur.id, amount_currency: 0, debit: 50, credit: 0 },
    'amount_currency',
    db,
    move,
  );
  assert.equal(updatedZero.debit, 0);
  assert.equal(updatedZero.credit, 0);
});

test('FX-10: Editing debit/credit with an amount_currency of 0 computes amount_currency', () => {
  const { db, eur } = setupDb();
  const lineItem = models['account.move'].fields.line_ids;
  const move = { move_type: 'entry', date: '2026-04-01', company_id: 1 };

  // Editing debit with amount_currency of 0 computes positive amount_currency (100 USD * 1.25 = 125 EUR)
  const debitLine = lineItem.onchange(
    { currency_id: eur.id, debit: 100, credit: 0, amount_currency: 0 },
    'debit',
    db,
    move,
  );
  assert.equal(debitLine.amount_currency, 125);

  // Editing credit with amount_currency of 0 computes negative amount_currency (100 USD * 1.25 = -125 EUR)
  const creditLine = lineItem.onchange(
    { currency_id: eur.id, debit: 0, credit: 100, amount_currency: 0 },
    'credit',
    db,
    move,
  );
  assert.equal(creditLine.amount_currency, -125);

  // Editing debit when amount_currency is already non-zero does NOT overwrite amount_currency
  const existingLine = lineItem.onchange(
    { currency_id: eur.id, debit: 100, credit: 0, amount_currency: 120 },
    'debit',
    db,
    move,
  );
  assert.equal(existingLine.amount_currency, 120);
});

test('FX-10: Posting refuses a line whose amount_currency sign does not match its balance', () => {
  const { db: initDb, eur, misc, expAccount, cashAccount } = setupDb();

  // Negative amount_currency with debit balance: postMove throws
  const draftBadDebit = create(initDb, 'account.move', {
    move_type: 'entry',
    journal_id: misc.id,
    company_id: 1,
    date: '2026-04-01',
    line_ids: [
      { account_id: expAccount, debit: 100, credit: 0, currency_id: eur.id, amount_currency: -125 },
      { account_id: cashAccount, debit: 0, credit: 100 },
    ],
  });
  assert.throws(
    () => postMove(draftBadDebit.db, draftBadDebit.id),
    /The currency amount sign must match the debit\/credit balance/,
  );

  // Positive amount_currency with credit balance: postMove throws
  const draftBadCredit = create(initDb, 'account.move', {
    move_type: 'entry',
    journal_id: misc.id,
    company_id: 1,
    date: '2026-04-01',
    line_ids: [
      { account_id: expAccount, debit: 100, credit: 0 },
      { account_id: cashAccount, debit: 0, credit: 100, currency_id: eur.id, amount_currency: 125 },
    ],
  });
  assert.throws(
    () => postMove(draftBadCredit.db, draftBadCredit.id),
    /The currency amount sign must match the debit\/credit balance/,
  );

  // postEntry in ledger.js also refuses mismatched sign
  assert.throws(
    () => postEntry(initDb, {
      journal: misc.code,
      journal_id: misc.id,
      company: 1,
      date: '2026-04-01',
      ref: 'MISMATCH-SIGN',
      lines: [
        { account_id: expAccount, debit: 100, credit: 0, currency_id: eur.id, amount_currency: -125 },
        { account_id: cashAccount, debit: 0, credit: 100 },
      ],
    }),
    /The currency amount sign must match the debit\/credit balance/,
  );
});

test('FX-10: Posting sign mismatch is also refused when saved through diffDb + applyDiff', () => {
  const { db, eur, misc, expAccount, cashAccount } = setupDb();

  const draft = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: misc.id,
    company_id: 1,
    date: '2026-04-01',
    line_ids: [
      { account_id: expAccount, debit: 100, credit: 0, currency_id: eur.id, amount_currency: -125 },
      { account_id: cashAccount, debit: 0, credit: 100 },
    ],
  });

  const forged = diffDb(db, draft.db);
  forged.upserts['account.move'] = forged.upserts['account.move'].map((m) => (
    m.id === draft.id ? { ...m, state: 'posted', name: 'MISC/2026/04/0001' } : m
  ));

  assert.throws(
    () => applyDiff(db, forged, { isAdmin: false, author: 'Clerk' }),
    /The currency amount sign must match the debit\/credit balance/,
  );
});
