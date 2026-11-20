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

// ---------------------------------------------------------------------------
// Follow-up Regression Tests for Code Review Findings
// ---------------------------------------------------------------------------

test('Finding 1 / JE-11 regression: Reset to Draft never cancels an ordinary draft credit note (auto_post no)', () => {
  const { db: initDb, misc, expAccount, cashAccount } = setupDb();

  const posted = postEntry(initDb, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: today(),
    ref: 'ORIG-FOR-REFUND',
    lines: [
      { account_id: expAccount, debit: 500 },
      { account_id: cashAccount, credit: 500 },
    ],
  });
  let db = posted.db;
  const origMove = read(db, 'account.move', posted.id);

  // 1. Create ordinary draft credit note (auto_post 'no' from refund flow)
  const cn = create(db, 'account.move', {
    move_type: 'out_refund',
    journal_id: misc.id,
    company_id: 1,
    reversed_entry_id: origMove.id,
    auto_post: 'no',
    state: 'draft',
    line_ids: [
      { account_id: cashAccount, debit: 500, credit: 0 },
      { account_id: expAccount, debit: 0, credit: 500 },
    ],
  });
  db = cn.db;

  // 2. Create scheduled auto-post reversal (auto_post 'at_date')
  const schedRev = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: misc.id,
    company_id: 1,
    reversed_entry_id: origMove.id,
    auto_post: 'at_date',
    date: addDays(today(), 5),
    state: 'draft',
    line_ids: [
      { account_id: cashAccount, debit: 500, credit: 0 },
      { account_id: expAccount, debit: 0, credit: 500 },
    ],
  });
  db = schedRev.db;

  // Reset original move to draft
  const resetBtn = button('Reset to Draft');
  const res = resetBtn.run(db, origMove);

  const updatedCn = read(res.db, 'account.move', cn.id);
  const updatedSched = read(res.db, 'account.move', schedRev.id);

  assert.equal(updatedCn.state, 'draft', 'ordinary draft credit note (auto_post no) must remain draft');
  assert.equal(updatedSched.state, 'cancel', 'scheduled reversal (auto_post at_date) must be cancelled');
});

test('Finding 2 / FX-10 regression: Editing amount_currency on a tagged foreign-currency manual tax line preserves tax_tag_ids', () => {
  let { db, eur, misc, expAccount } = setupDb();
  const taxTag = create(db, 'account.account.tag', { name: 'Purchase Tax Grid', applicability: 'taxes' });
  db = taxTag.db;
  const taxAcc = accountId(db, '251000') ?? expAccount;

  const tax = create(db, 'account.tax', {
    name: 'Manual Tax 15%',
    type_tax_use: 'purchase',
    amount: 15,
    amount_type: 'percent',
  });
  db = tax.db;

  const lineItemField = models['account.move'].fields.line_ids;
  const manualTaxLine = {
    account_id: taxAcc,
    debit: 0,
    credit: 80,
    currency_id: eur.id,
    amount_currency: -100,
    tax_id: tax.id,
    tax_tag_ids: [taxTag.id],
    tax_ids: [],
  };

  // Editing amount_currency on the manual tax line
  const updated = lineItemField.onchange(
    { ...manualTaxLine, amount_currency: -125 },
    'amount_currency',
    db,
    { move_type: 'entry', company_id: 1, date: '2026-01-01' },
  );

  assert.deepEqual(updated.tax_tag_ids, [taxTag.id], 'tax_tag_ids must remain intact on manual tax line');
  assert.equal(updated.credit, 100, 'credit is recomputed from amount_currency (-125 / 1.25 = 100)');

  // Saving in a move preserves tags
  const moveRes = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: misc.id,
    company_id: 1,
    date: '2026-01-01',
    line_ids: [
      { account_id: expAccount, debit: 100, credit: 0 },
      updated,
    ],
  });
  const savedMove = read(moveRes.db, 'account.move', moveRes.id);
  const savedTaxLine = savedMove.line_ids.find((l) => l.account_id === taxAcc);
  assert.deepEqual(savedTaxLine.tax_tag_ids, [taxTag.id], 'saved tax line keeps tax_tag_ids');
});

test('Finding 3 / FX-10 regression: Changing currency_id reconverts, keeps amount_currency as truth when non-zero, and clears amount_currency on company currency', () => {
  let { db, eur, expAccount } = setupDb();
  let gbp = search(db, 'res.currency').find((c) => c.name === 'GBP');
  if (!gbp) {
    const created = create(db, 'res.currency', { name: 'GBP', symbol: '£', rounding: 0.01, active: true });
    db = created.db;
    gbp = read(db, 'res.currency', created.id);
  } else if (!gbp.active) {
    db = write(db, 'res.currency', gbp.id, { active: true });
    gbp = read(db, 'res.currency', gbp.id);
  }
  db = upsertCurrencyRate(db, gbp.id, { date: '2026-01-01', rate: 2.0, companyId: 1 });

  const lineItemField = models['account.move'].fields.line_ids;
  const moveCtx = { move_type: 'entry', company_id: 1, date: '2026-01-01' };

  // Case A: Line has amount_currency 0, debit 100 -> change currency_id to EUR (rate 1.25)
  // Computes amount_currency from debit (100 * 1.25 = 125)
  const lineA = { account_id: expAccount, debit: 100, credit: 0, amount_currency: 0, currency_id: eur.id };
  const updatedA = lineItemField.onchange(lineA, 'currency_id', db, moveCtx);
  assert.equal(updatedA.amount_currency, 125, 'computed amount_currency from debit when amount_currency was 0');
  assert.equal(updatedA.debit, 100, 'debit remains 100');

  // Case B: Line has amount_currency 125 non-zero -> change currency_id from EUR to GBP (rate 2.0)
  // amount_currency stays source of truth, debit recomputed (125 / 2.0 = 62.5)
  const lineB = { account_id: expAccount, debit: 100, credit: 0, amount_currency: 125, currency_id: gbp.id };
  const updatedB = lineItemField.onchange(lineB, 'currency_id', db, moveCtx);
  assert.equal(updatedB.amount_currency, 125, 'amount_currency stays 125 as source of truth');
  assert.equal(updatedB.debit, 62.5, 'debit recomputed in company currency at new rate');

  // Case C: Switching back to company currency clears amount_currency
  const lineC = { account_id: expAccount, debit: 62.5, credit: 0, amount_currency: 125, currency_id: null };
  const updatedC = lineItemField.onchange(lineC, 'currency_id', db, moveCtx);
  assert.equal(updatedC.amount_currency, 0, 'switching to company currency clears amount_currency');
  assert.equal(updatedC.debit, 62.5, 'debit is preserved');
});

test('Finding 4 / FX-10 regression: Manual entry uses move.date before move.invoice_date for currency conversion', () => {
  let { db, eur, expAccount } = setupDb();
  // Rate at 2026-01-01 is 1.25 (toCompany: 100 / 1.25 = 80)
  // Rate at 2026-06-01 is 2.00 (toCompany: 100 / 2.0 = 50)
  db = upsertCurrencyRate(db, eur.id, { date: '2026-06-01', rate: 2.0, companyId: 1 });

  const lineItemField = models['account.move'].fields.line_ids;
  // Move has date: '2026-06-01' and invoice_date: '2026-01-01'
  const moveCtx = { move_type: 'entry', company_id: 1, date: '2026-06-01', invoice_date: '2026-01-01' };

  const line = {
    account_id: expAccount,
    currency_id: eur.id,
    amount_currency: 100,
    debit: 0,
    credit: 0,
  };
  const updated = lineItemField.onchange(line, 'amount_currency', db, moveCtx);

  // If move.date is used first, rate is 2.0 -> debit is 50. If invoice_date was used, rate would be 1.25 -> debit 80.
  assert.equal(updated.debit, 50, 'manual entry uses move.date first for foreign currency conversion');
});

test('Finding 5 / FX-10 regression: Changing entry accounting date revalues foreign lines and dependent tax lines across rates', () => {
  let { db, eur, misc, expAccount, cashAccount } = setupDb();
  // Rate at 2026-01-01 is 1.25
  // Rate at 2026-06-01 is 2.00
  db = upsertCurrencyRate(db, eur.id, { date: '2026-06-01', rate: 2.0, companyId: 1 });
  const taxAcc = accountId(db, '251000') ?? cashAccount;

  const tax = create(db, 'account.tax', {
    name: 'VAT 10%',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 201, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 202, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = tax.db;

  // On 2026-01-01 (rate 1.25):
  // Base line: 125 EUR -> 100 company currency (debit: 100)
  // Tax line: 12.5 EUR -> 10 company currency (debit: 10)
  // Counterpart: -137.5 EUR -> 110 company currency (credit: 110)
  const initialMove = {
    move_type: 'entry',
    journal_id: misc.id,
    company_id: 1,
    date: '2026-01-01',
    line_ids: [
      { account_id: expAccount, debit: 100, credit: 0, currency_id: eur.id, amount_currency: 125, tax_ids: [tax.id] },
      { account_id: cashAccount, debit: 0, credit: 110, currency_id: eur.id, amount_currency: -137.5 },
    ],
  };

  // Synchronize tax lines on initial date
  const syncd = models['account.move'].onchange(initialMove, 'line_ids', db);
  const moveWithTaxes = { ...initialMove, line_ids: syncd.line_ids };

  const initialTaxLine = moveWithTaxes.line_ids.find((l) => l.tax_repartition_line_id === 202);
  assert.ok(initialTaxLine, 'initial tax line generated');
  assert.equal(initialTaxLine.debit, 10, 'initial tax line debit is 10 at rate 1.25');

  // Now change entry date to 2026-06-01 (rate 2.0)
  const changed = models['account.move'].onchange({ ...moveWithTaxes, date: '2026-06-01' }, 'date', db);

  const revaluedBase = changed.line_ids.find((l) => l.account_id === expAccount);
  const revaluedCash = changed.line_ids.find((l) => l.account_id === cashAccount);
  const revaluedTax = changed.line_ids.find((l) => l.tax_repartition_line_id === 202);

  assert.ok(revaluedBase, 'revalued base line found');
  assert.ok(revaluedCash, 'revalued cash line found');
  assert.ok(revaluedTax, 'revalued tax line found');

  // At rate 2.0:
  // Base: 125 EUR / 2.0 = 62.5
  // Cash: 137.5 EUR / 2.0 = 68.75
  // Tax: 12.5 EUR / 2.0 = 6.25
  assert.equal(revaluedBase.debit, 62.5, 'base line revalued at new rate 2.0');
  assert.equal(revaluedCash.credit, 68.75, 'cash line revalued at new rate 2.0');
  assert.equal(revaluedTax.debit, 6.25, 'dependent tax line revalued at new rate 2.0');
});

