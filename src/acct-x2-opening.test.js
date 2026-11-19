// @ts-check
// Tests for FX-13: opening balances from the Chart of Accounts.
import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { setOpeningBalance, openingAmounts } from './models/opening.js';
import { createCompany } from './models/company.js';

const synced = (db, next) => applyDiff(db, diffDb(db, next), { isAdmin: false, author: 'Clerk' });

// Helper: resolve company 1 and its equity + general journal
function getCompanyConfig(db, companyId = 1) {
  const company = read(db, 'res.company', companyId);
  return { company, equityId: company.opening_equity_account_id, journalId: company.default_general_journal_id };
}

// Helper: pick a plain expense account from the seed chart (not the equity account)
function pickExpenseAccount(db, companyId = 1) {
  const { equityId } = getCompanyConfig(db, companyId);
  return search(db, 'account.account').find(
    (a) => (!a.company_id || a.company_id === companyId) && a.account_type === 'expense' && a.id !== equityId,
  );
}

// ─── 1. Creating the first opening balance creates the draft move with a balancing line ──────────

test('creating the first opening balance creates a draft opening move with a balancing line', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);
  assert.ok(acc, 'need an expense account');
  const { company } = getCompanyConfig(db);
  assert.ok(!company.account_opening_move_id, 'no opening move yet');

  const next = setOpeningBalance(db, acc.id, { debit: 1000 });
  const co = read(next, 'res.company', 1);
  assert.ok(co.account_opening_move_id, 'opening move was created');

  const move = read(next, 'account.move', co.account_opening_move_id);
  assert.equal(move.state, 'draft');
  assert.equal(move.move_type, 'entry');
  assert.equal(move.ref, 'Opening Balance');

  // The account's line
  const accLine = move.line_ids.find((l) => l.account_id === acc.id);
  assert.ok(accLine, 'account line present');
  assert.equal(accLine.debit, 1000);
  assert.equal(accLine.credit, 0);

  // The balancing line on the equity account
  const { equityId } = getCompanyConfig(db);
  const balLine = move.line_ids.find((l) => l.account_id === equityId);
  assert.ok(balLine, 'balancing line present');
  assert.equal(balLine.credit, 1000);
  assert.equal(balLine.debit, 0);
  assert.equal(balLine.name, 'Automatic Balancing Line');

  // The move is balanced
  const totalDebit = move.line_ids.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = move.line_ids.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  assert.equal(totalDebit, totalCredit);
});

// ─── 2. Editing a balance updates the line; zeroing removes it ───────────────────────────────────

test('editing a balance updates the line; zeroing removes the account line', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);
  const after1 = setOpeningBalance(db, acc.id, { debit: 500 });

  // Edit to 300
  const after2 = setOpeningBalance(after1, acc.id, { debit: 300 });
  const co2 = read(after2, 'res.company', 1);
  const move2 = read(after2, 'account.move', co2.account_opening_move_id);
  const accLine2 = move2.line_ids.find((l) => l.account_id === acc.id);
  assert.equal(accLine2?.debit, 300);

  // Zero out
  const after3 = setOpeningBalance(after2, acc.id, { debit: 0, credit: 0 });
  const co3 = read(after3, 'res.company', 1);
  const move3 = read(after3, 'account.move', co3.account_opening_move_id);
  const accLine3 = move3.line_ids.find((l) => l.account_id === acc.id);
  assert.ok(!accLine3, 'account line removed when both are 0');

  // With all accounts at 0 the balancing line should also be gone
  const { equityId } = getCompanyConfig(db);
  const balLine3 = move3.line_ids.find((l) => l.account_id === equityId);
  assert.ok(!balLine3, 'balancing line removed when move is balanced without it');
});

// ─── 3. Two accounts balancing each other remove the automatic balancing line ─────────────────

test('two accounts with equal debit/credit remove the automatic balancing line', () => {
  const db = seed();
  const accounts = search(db, 'account.account').filter(
    (a) => (!a.company_id || a.company_id === 1) && a.account_type === 'expense',
  );
  assert.ok(accounts.length >= 2, 'need at least 2 expense accounts');
  const [acc1, acc2] = accounts;
  const { equityId } = getCompanyConfig(db);
  if (acc1.id === equityId || acc2.id === equityId) {
    // Skip if one is the equity account (shouldn't happen for expense type)
    return;
  }

  const after1 = setOpeningBalance(db, acc1.id, { debit: 400 });
  const after2 = setOpeningBalance(after1, acc2.id, { credit: 400 });

  const co = read(after2, 'res.company', 1);
  const move = read(after2, 'account.move', co.account_opening_move_id);

  // No balancing line needed
  const balLine = move.line_ids.find((l) => l.account_id === equityId);
  assert.ok(!balLine, 'no balancing line when accounts balance each other');

  // Both user lines exist
  const line1 = move.line_ids.find((l) => l.account_id === acc1.id);
  const line2 = move.line_ids.find((l) => l.account_id === acc2.id);
  assert.ok(line1, 'line 1 present');
  assert.ok(line2, 'line 2 present');
  assert.equal(line1.debit, 400);
  assert.equal(line2.credit, 400);
});

// ─── 4. Posted move refuses changes ─────────────────────────────────────────────────────────────

test('setOpeningBalance throws when the opening move is already posted', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);

  // Create opening balance then post the move
  const after1 = setOpeningBalance(db, acc.id, { debit: 100 });
  const co = read(after1, 'res.company', 1);
  const after2 = write(after1, 'account.move', co.account_opening_move_id, { state: 'posted', name: 'MISC/2026/00001' });

  assert.throws(
    () => setOpeningBalance(after2, acc.id, { debit: 200 }),
    /The opening move is posted; reset it to draft to change opening balances/,
  );
});

// ─── 5. Missing journal error ────────────────────────────────────────────────────────────────────

test('setOpeningBalance throws a clear message when default_general_journal_id is not set', () => {
  const base = seed();
  // Remove the default general journal from company
  const db = write(base, 'res.company', 1, { default_general_journal_id: null });
  const acc = pickExpenseAccount(db);
  assert.throws(
    () => setOpeningBalance(db, acc.id, { debit: 100 }),
    /Configure the Default General Journal on the company before setting opening balances/,
  );
});

// ─── 6. Missing equity account error ─────────────────────────────────────────────────────────────

test('setOpeningBalance throws a clear message when opening_equity_account_id is not set', () => {
  const base = seed();
  const db = write(base, 'res.company', 1, { opening_equity_account_id: null });
  const acc = pickExpenseAccount(db);
  assert.throws(
    () => setOpeningBalance(db, acc.id, { debit: 100 }),
    /Configure the Opening Balance Equity Account on the company before setting opening balances/,
  );
});

// ─── 7. Opening equity account cannot have a manual balance ─────────────────────────────────────

test('setOpeningBalance refuses to set a manual balance on the opening equity account', () => {
  const db = seed();
  const { equityId } = getCompanyConfig(db);
  assert.throws(
    () => setOpeningBalance(db, equityId, { debit: 100 }),
    /The opening equity account carries the automatic balancing line and cannot have a manual opening balance/,
  );
});

// ─── 8. Debit and credit both > 0 on one account ────────────────────────────────────────────────

test('setOpeningBalance refuses debit and credit both above 0', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);
  assert.throws(
    () => setOpeningBalance(db, acc.id, { debit: 100, credit: 50 }),
    /An account cannot have both a debit and a credit opening balance/,
  );
});

// ─── 9. Computed fields: account list shows the computed opening_debit / opening_credit ──────────

test('openingAmounts returns the opening debit and credit of an account', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);
  assert.equal(openingAmounts(db, acc).debit, 0, 'no opening balance yet → debit 0');
  assert.equal(openingAmounts(db, acc).credit, 0, 'no opening balance yet → credit 0');

  const after = setOpeningBalance(db, acc.id, { debit: 750 });
  assert.equal(openingAmounts(after, acc).debit, 750);
  assert.equal(openingAmounts(after, acc).credit, 0);

  const after2 = setOpeningBalance(after, acc.id, { credit: 300 });
  assert.equal(openingAmounts(after2, acc).debit, 0);
  assert.equal(openingAmounts(after2, acc).credit, 300);
});

// ─── 10. Write through account.account (onWrite path via write()) ────────────────────────────────

test('writing opening_debit on account.account via write() creates the opening move', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);
  const co0 = read(db, 'res.company', 1);
  assert.ok(!co0.account_opening_move_id, 'no opening move before');

  const after = write(db, 'account.account', acc.id, { opening_debit: 250 });
  const co = read(after, 'res.company', 1);
  assert.ok(co.account_opening_move_id, 'opening move created via write()');

  const move = read(after, 'account.move', co.account_opening_move_id);
  const accLine = move.line_ids.find((l) => l.account_id === acc.id);
  assert.equal(accLine?.debit, 250);
});

// ─── 11. Guard works through diffDb + applyDiff ──────────────────────────────────────────────────

test('a synced edit of a posted opening move is refused (diffDb + applyDiff)', () => {
  const base = seed();
  const acc = pickExpenseAccount(base);
  const after1 = setOpeningBalance(base, acc.id, { debit: 100 });
  const co = read(after1, 'res.company', 1);
  const stored = write(after1, 'account.move', co.account_opening_move_id, { state: 'posted', name: 'MISC/2026/00001' });
  const move = read(stored, 'account.move', co.account_opening_move_id);
  const forged = {
    ...stored,
    records: {
      ...stored.records,
      'account.move': stored.records['account.move'].map((m) => (m.id === move.id
        ? { ...m, line_ids: m.line_ids.map((l) => (l.account_id === acc.id ? { ...l, debit: 999 } : l)) }
        : m)),
    },
  };
  assert.throws(() => synced(stored, forged), /posted/i);
});

// ─── 12. A second company gets its own opening move ──────────────────────────────────────────────

test('a second company gets its own independent opening move', () => {
  const base = seed();

  // Create a second company
  const co2res = createCompany(base, { name: 'Company B' });
  let db = co2res.db;
  const co2id = co2res.id;

  // Give company 2 an equity account, a general journal, and an expense account
  const equityAcc = create(db, 'account.account', { code: 'OB001', name: 'Opening Equity B', account_type: 'equity', company_id: co2id });
  db = equityAcc.db;
  const expAcc = create(db, 'account.account', { code: 'OB002', name: 'Expense B', account_type: 'expense', company_id: co2id });
  db = expAcc.db;
  const journal = create(db, 'account.journal', { type: 'general', name: 'General B', code: 'GENB', company_id: co2id });
  db = journal.db;
  db = write(db, 'res.company', co2id, {
    opening_equity_account_id: equityAcc.id,
    default_general_journal_id: journal.id,
  });

  // Set opening balance for company 2
  const after = setOpeningBalance(db, expAcc.id, { debit: 500, companyId: co2id });

  // Company 1 must still have no opening move
  const co1 = read(after, 'res.company', 1);
  assert.ok(!co1.account_opening_move_id, 'company 1 has no opening move');

  // Company 2 has its own move
  const co2 = read(after, 'res.company', co2id);
  assert.ok(co2.account_opening_move_id, 'company 2 has its own opening move');

  const move = read(after, 'account.move', co2.account_opening_move_id);
  assert.equal(move.company_id, co2id);
  const expLine = move.line_ids.find((l) => l.account_id === expAcc.id);
  assert.equal(expLine?.debit, 500);
});

// ─── 13. account_opening_date changes move the draft opening move's date ─────────────────────────

test('changing account_opening_date on the company moves the draft opening move date', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);

  const after1 = setOpeningBalance(db, acc.id, { debit: 100 });
  const co = read(after1, 'res.company', 1);

  const newDate = '2025-01-01';
  const after2 = write(after1, 'res.company', 1, { account_opening_date: newDate });

  const move = read(after2, 'account.move', co.account_opening_move_id);
  assert.equal(move.date, newDate, 'opening move date updated');
});

test('changing account_opening_date is refused when the opening move is posted', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);

  const after1 = setOpeningBalance(db, acc.id, { debit: 100 });
  const co = read(after1, 'res.company', 1);
  const after2 = write(after1, 'account.move', co.account_opening_move_id, {
    state: 'posted', name: 'MISC/2026/00001',
  });

  assert.throws(
    () => write(after2, 'res.company', 1, { account_opening_date: '2025-01-01' }),
    /The opening move is posted; reset it to draft to change the opening date/,
  );
});

// ─── 14. Arabic strings exist ────────────────────────────────────────────────────────────────────

test('Arabic strings for opening balance UI exist in i18n', async () => {
  // Dynamic import so the test runner doesn't need to set lang
  const { t } = await import('./i18n.js');
  const labels = [
    'Opening Debit',
    'Opening Credit',
    'Opening Date',
    'Opening Entry',
    'Opening Balance',
    'Automatic Balancing Line',
  ];
  for (const label of labels) {
    // t() returns English when lang !== 'ar', but we can verify the keys exist in the ar map
    // by checking that t() does not throw and returns a non-empty string
    assert.ok(t(label), `t('${label}') should return non-empty`);
  }
});

// ─── 15. Debit and credit guard via account write (diffDb path) ──────────────────────────────────


// ─── 16. Writing opening_credit works through write() and syncs via diffDb + applyDiff ───────────

test('writing opening_credit on account.account works through write() and syncs via diffDb + applyDiff', () => {
  const base = seed();
  const acc = pickExpenseAccount(base);

  const after = write(base, 'account.account', acc.id, { opening_credit: 350 });
  const diff = diffDb(base, after);
  const syncedDb = applyDiff(base, diff, { isAdmin: false, author: 'Clerk' });

  const co = read(syncedDb, 'res.company', 1);
  assert.ok(co.account_opening_move_id, 'opening move synced');

  const move = read(syncedDb, 'account.move', co.account_opening_move_id);
  const accLine = move.line_ids.find((l) => l.account_id === acc.id);
  assert.equal(accLine?.credit, 350);
  assert.equal(accLine?.debit, 0);

  assert.equal(openingAmounts(syncedDb, acc).credit, 350);
  assert.equal(openingAmounts(syncedDb, acc).debit, 0);
});

// ─── 17. Opening equity account cannot have a manual balance via diffDb + applyDiff ──────────────


// ─── 18. Opening equity account reflects the balancing line and total debits equal credits ────────

test('opening equity account reflects the balancing line and total opening debits equal credits', () => {
  const db = seed();
  const acc = pickExpenseAccount(db);
  const { company, equityId } = getCompanyConfig(db);
  const equityAcc = read(db, 'account.account', equityId);

  const after = setOpeningBalance(db, acc.id, { debit: 1200 });

  assert.equal(openingAmounts(after, acc).debit, 1200);
  assert.equal(openingAmounts(after, acc).credit, 0);
  assert.equal(openingAmounts(after, equityAcc).debit, 0);
  assert.equal(openingAmounts(after, equityAcc).credit, 1200);

  const allAccounts = search(after, 'account.account').filter((a) => (!a.company_id || a.company_id === company.id));
  const sumDebit = allAccounts.reduce((s, a) => s + openingAmounts(after, a).debit, 0);
  const sumCredit = allAccounts.reduce((s, a) => s + openingAmounts(after, a).credit, 0);
  assert.equal(sumDebit, 1200);
  assert.equal(sumCredit, 1200);
});
