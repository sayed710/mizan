import './models/index.js';
import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { diffDb, applyDiff } from './sync.js';
import { journalItems, postEntry } from './models/ledger.js';
import { canChangePeriod, canMoveToAccount, canPostJournalItems, changePeriod, moveToAccount, postJournalItems } from './models/automaticEntry.js';

function optionalAccount(db, filter) {
  return (db.records['account.account'] ?? []).find((a) => a.active !== false && !a.deprecated && filter(a)) ?? null;
}

function findAccount(db, filter) {
  const acc = optionalAccount(db, filter);
  assert.ok(acc, 'expected matching account in seed');
  return acc;
}

function findJournal(db, companyId, type = 'general') {
  const j = (db.records['account.journal'] ?? []).find((x) => x.active !== false && x.type === type && (x.company_id ?? 1) === companyId);
  assert.ok(j, `expected ${type} journal for company ${companyId}`);
  return j;
}

test('ji3 item 1: postJournalItems posts draft parent entries uniquely with entry validations and diffDb/applyDiff guard', () => {
  let db = seed();
  const expense = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const cash = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_cash');

  const d1 = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-03-05',
    state: 'draft',
    ref: 'Draft One',
    lines: [
      { account_id: expense.id, debit: 120, name: 'Rent March' },
      { account_id: cash.id, credit: 120, name: 'Cash Rent' },
    ],
  });
  db = d1.db;

  const d2 = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-03-06',
    state: 'draft',
    ref: 'Draft Two',
    lines: [
      { account_id: expense.id, debit: 80, name: 'Utilities' },
      { account_id: cash.id, credit: 80, name: 'Cash Utilities' },
    ],
  });
  db = d2.db;

  const dUnbalanced = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    company_id: 1,
    journal_id: findJournal(db, 1, 'general').id,
    date: '2026-03-07',
    invoice_date: '2026-03-07',
    name: '/',
    line_ids: [
      { account_id: expense.id, debit: 50, credit: 0, name: 'Bad Debit' },
      { account_id: cash.id, debit: 0, credit: 40, name: 'Bad Credit' },
    ],
  });
  db = dUnbalanced.db;

  const draftRows = journalItems(db, { reviewMode: 'draft' });
  const m1Lines = draftRows.filter((l) => l.move_id === d1.id);
  const m2Lines = draftRows.filter((l) => l.move_id === d2.id);
  const badLine = draftRows.find((l) => l.move_id === dUnbalanced.id);

  assert.equal(canPostJournalItems([m1Lines[0], m1Lines[1], m2Lines[0]]), true);
  assert.throws(() => postJournalItems(db, []), /Select journal items first/);
  assert.throws(
    () => postJournalItems(db, [{ move_id: badLine.move_id, line_identity: badLine.line_identity }]),
    /not balanced/,
  );

  // Select BOTH lines of d1 plus 1 line of d2 -> posts both parent moves cleanly once each.
  const posted = postJournalItems(db, [
    { move_id: d1.id, line_identity: m1Lines[0].line_identity },
    { move_id: d1.id, line_identity: m1Lines[1].line_identity },
    { move_id: d2.id, line_identity: m2Lines[0].line_identity },
  ]);
  const applied = applyDiff(db, diffDb(db, posted), { isAdmin: true });
  assert.equal(read(applied, 'account.move', d1.id).state, 'posted');
  assert.notEqual(read(applied, 'account.move', d1.id).name, '/');
  assert.equal(read(applied, 'account.move', d2.id).state, 'posted');
  assert.equal(read(applied, 'account.move', dUnbalanced.id).state, 'draft');

  // Cannot post already-posted items.
  const postedRows = journalItems(applied).filter((l) => l.move_id === d1.id);
  assert.equal(canPostJournalItems(postedRows), false);
  assert.throws(
    () => postJournalItems(applied, [{ move_id: d1.id, line_identity: postedRows[0].line_identity }]),
    /Only draft entries can be posted/,
  );

  // Lock date validation on postJournalItems & applyDiff.
  const d3 = postEntry(applied, {
    journal: 'MISC',
    company: 1,
    date: '2026-01-15',
    state: 'draft',
    ref: 'Locked Draft',
    lines: [
      { account_id: expense.id, debit: 30, name: 'Locked Line' },
      { account_id: cash.id, credit: 30, name: 'Locked Cash' },
    ],
  });
  const lockedDb = write(d3.db, 'res.company', 1, { lock_date: '2026-01-31' });
  const d3Line = journalItems(lockedDb, { reviewMode: 'draft' }).find((l) => l.move_id === d3.id);
  assert.throws(
    () => postJournalItems(lockedDb, [{ move_id: d3.id, line_identity: d3Line.line_identity }]),
    /locked/i,
  );
});

test('ji3 item 2: moveToAccount groups by (account, partner, currency), reconciles reconcilable lines, links source moves, and enforces locks/company isolation via diffDb+applyDiff', () => {
  let db = seed();
  const ar = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_receivable');
  const suspense = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_current' && a.id !== ar.id);
  const prepaid = findAccount(db, (a) => (a.company_id ?? 1) === 1 && ['asset_prepayments', 'asset_current'].includes(a.account_type) && a.id !== ar.id && a.id !== suspense.id)
    ?? read(db, 'account.account', read(db, 'res.company', 1).deferred_expense_account_id);
  const otherExpense = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const cash = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_cash');
  const partners = search(db, 'res.partner');
  const partnerA = partners[0].id;
  const partnerB = partners[1]?.id ?? partnerA;
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  let eurId = eur?.id;
  if (!eurId) {
    const madeEur = create(db, 'res.currency', { name: 'TST', symbol: 'T', rounding: 0.01, rate: 0.5 });
    db = madeEur.db;
    eurId = madeEur.id;
  }

  // Entry 1: two receivable lines for partnerA (Company Currency) + foreign currency line + suspense line
  const e1 = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-02-10',
    ref: 'SRC-1',
    lines: [
      { account_id: ar.id, partner_id: partnerA, debit: 100, name: 'AR A1' },
      { account_id: ar.id, partner_id: partnerA, debit: 50, name: 'AR A2' },
      { account_id: suspense.id, partner_id: partnerB, debit: 200, currency_id: eurId, amount_currency: 100, name: 'Suspense FX B' },
      { account_id: cash.id, credit: 350, name: 'Cash offset' },
    ],
  });
  db = e1.db;

  // Draft entry for validation check
  const eDraft = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-02-11',
    state: 'draft',
    ref: 'DRAFT-SRC',
    lines: [
      { account_id: otherExpense.id, debit: 25, name: 'Draft Item' },
      { account_id: cash.id, credit: 25, name: 'Draft Cash' },
    ],
  });
  db = eDraft.db;

  const items1 = journalItems(db).filter((l) => l.move_id === e1.id);
  const arItems = items1.filter((l) => l.account_id === ar.id);
  const fxItem = items1.find((l) => l.account_id === suspense.id);
  const draftItem = journalItems(db, { reviewMode: 'draft' }).find((l) => l.move_id === eDraft.id);

  assert.equal(canMoveToAccount([draftItem], db), false);
  assert.throws(
    () => moveToAccount(db, [{ move_id: draftItem.move_id, line_identity: draftItem.line_identity }], { destinationAccountId: prepaid.id, date: '2026-02-20' }),
    /posted journal items/,
  );

  // Move AR (partnerA, USD 100+50 grouped -> 150) and Suspense (partnerB, EUR 100/200) to Prepaid
  const sel = [...arItems, fxItem].map((l) => ({ move_id: l.move_id, line_identity: l.line_identity }));
  assert.equal(canMoveToAccount([...arItems, fxItem], db), true);
  const movedDb = moveToAccount(db, sel, { destinationAccountId: prepaid.id, date: '2026-02-20' });
  const applied = applyDiff(db, diffDb(db, movedDb), { isAdmin: true });

  const newMoves = (applied.records['account.move'] ?? []).filter((m) => !db.records['account.move'].some((o) => o.id === m.id));
  assert.equal(newMoves.length, 1, 'creates exactly one transfer entry');
  const transfer = newMoves[0];
  assert.equal(transfer.state, 'posted');
  assert.equal(transfer.date, '2026-02-20');
  assert.deepEqual(transfer.automatic_entry_source_move_ids, [e1.id]);

  // Grouped per (account, partner, currency): 1 AR counter-line (-150), 1 Suspense FX counter-line (-200 / -100 EUR), plus 2 destination lines on prepaid
  const arCounter = transfer.line_ids.filter((l) => l.account_id === ar.id);
  assert.equal(arCounter.length, 1);
  assert.equal(arCounter[0].credit, 150);
  assert.equal(arCounter[0].partner_id, partnerA);

  const fxCounter = transfer.line_ids.filter((l) => l.account_id === suspense.id);
  assert.equal(fxCounter.length, 1);
  assert.equal(fxCounter[0].credit, 200);
  assert.equal(fxCounter[0].currency_id, eurId);
  assert.equal(fxCounter[0].amount_currency, -100);
  assert.equal(fxCounter[0].partner_id, partnerB);

  const destLines = transfer.line_ids.filter((l) => l.account_id === prepaid.id);
  assert.equal(destLines.length, 2);
  assert.equal(destLines.find((l) => l.partner_id === partnerA).debit, 150);
  const fxDest = destLines.find((l) => l.partner_id === partnerB);
  assert.equal(fxDest.debit, 200);
  assert.equal(fxDest.currency_id, eurId);
  assert.equal(fxDest.amount_currency, 100);

  // Source AR items must now be reconciled & cannot be moved again.
  const refreshedAr = journalItems(applied).filter((l) => l.move_id === e1.id && l.account_id === ar.id);
  assert.ok(refreshedAr.every((l) => l.reconciled === true && l.amount_residual === 0));
  assert.equal(canMoveToAccount([refreshedAr[0]], applied), false);
  assert.throws(
    () => moveToAccount(applied, [{ move_id: refreshedAr[0].move_id, line_identity: refreshedAr[0].line_identity }], { destinationAccountId: prepaid.id, date: '2026-02-25' }),
    /reconciled journal items/,
  );

  // Smart buttons + chatter notes link both directions.
  const smartSrc = models['account.move'].form.smart.filter((b) => b.when(read(applied, 'account.move', e1.id), applied)).map((b) => b.label);
  const smartTrf = models['account.move'].form.smart.filter((b) => b.when(transfer, applied)).map((b) => b.label);
  assert.ok(smartSrc.includes('Automatic Entries'));
  assert.ok(smartTrf.includes('Origin Entries'));
  assert.ok(applied.messages.some((m) => m.res_id === e1.id && /transferred/i.test(m.body)));
  assert.ok(applied.messages.some((m) => m.res_id === transfer.id && /Transfer entry created/i.test(m.body)));

  // Guard checks via diffDb + applyDiff:
  // 1) Lock date blocks forged transfer entry inside lock period.
  const withLock = write(db, 'res.company', 1, { lock_date: '2026-02-28' });
  assert.throws(() => applyDiff(withLock, diffDb(db, movedDb), { isAdmin: true }), /locked/i);

  // 2) Multi-company & cross-company destination/source guards.
  const comp2 = db.records['res.company'].find((c) => c.id === 2) ? db : create(db, 'res.company', { name: 'Branch 2', currency_id: read(db, 'res.company', 1).currency_id }).db;
  let dbWithC2 = comp2;
  let c2Acc = optionalAccount(dbWithC2, (a) => a.company_id === 2);
  if (!c2Acc) {
    const madeC2Acc = create(dbWithC2, 'account.account', { code: '991000', name: 'C2 Acc', account_type: 'expense', company_id: 2 });
    dbWithC2 = madeC2Acc.db;
    c2Acc = read(dbWithC2, 'account.account', madeC2Acc.id);
  }
  const c2AccId = c2Acc.id;
  let c2Cash = optionalAccount(dbWithC2, (a) => a.company_id === 2 && a.account_type === 'asset_cash');
  if (!c2Cash) {
    const madeC2Cash = create(dbWithC2, 'account.account', { code: '991010', name: 'C2 Cash', account_type: 'asset_cash', company_id: 2 });
    dbWithC2 = madeC2Cash.db;
    c2Cash = read(dbWithC2, 'account.account', madeC2Cash.id);
  }
  const c2CashId = c2Cash.id;
  let j2 = (dbWithC2.records['account.journal'] ?? []).find((j) => j.type === 'general' && j.company_id === 2);
  if (!j2) {
    const madeJ2 = create(dbWithC2, 'account.journal', { name: 'Misc C2', code: 'MC2', type: 'general', company_id: 2 });
    dbWithC2 = madeJ2.db;
    j2 = read(dbWithC2, 'account.journal', madeJ2.id);
  }
  const c2Move = postEntry(dbWithC2, {
    journal_id: j2.id,
    company: 2,
    date: '2026-02-12',
    lines: [
      { account_id: c2AccId, debit: 40 },
      { account_id: c2CashId, credit: 40 },
    ],
  });
  dbWithC2 = c2Move.db;
  const c2Line = journalItems(dbWithC2).find((l) => l.move_id === c2Move.id && l.account_id === c2AccId);
  assert.equal(canMoveToAccount([fxItem, c2Line], dbWithC2), false);
  assert.throws(
    () => moveToAccount(dbWithC2, [fxItem, c2Line], { destinationAccountId: prepaid.id, date: '2026-02-20' }),
    /different companies/,
  );

  // Forged diff referencing cross-company source move rejected by applyDiff:
  const movedOnC2 = moveToAccount(dbWithC2, sel, { destinationAccountId: prepaid.id, date: '2026-02-20' });
  const c2Transfer = movedOnC2.records['account.move'].find((m) => !dbWithC2.records['account.move'].some((o) => o.id === m.id));
  const forgedMoved = {
    ...movedOnC2,
    records: {
      ...movedOnC2.records,
      'account.move': movedOnC2.records['account.move'].map((m) => (m.id === c2Transfer.id ? { ...m, automatic_entry_source_move_ids: [c2Move.id] } : m)),
    },
  };
  assert.throws(() => applyDiff(dbWithC2, diffDb(dbWithC2, forgedMoved), { isAdmin: true }), /different companies/);
});

test('ji3 item 3: changePeriod creates two linked entries with percentage & accrual account, validates P&L/locks/companies via diffDb+applyDiff', () => {
  let db = seed();
  const expense = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const income = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'income');
  const cash = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_cash');
  const company = read(db, 'res.company', 1);
  const defExpAcc = read(db, 'res.account' in models ? 'res.account' : 'account.account', company.deferred_expense_account_id);
  assert.ok(defExpAcc, 'company seeded with deferred_expense_account_id');
  const defRevAcc = read(db, 'account.account', company.deferred_revenue_account_id);
  assert.ok(defRevAcc, 'company seeded with deferred_revenue_account_id');

  const analyticPlan = create(db, 'account.analytic.plan', { name: 'Dept' });
  db = analyticPlan.db;
  const analyticAcc = create(db, 'account.analytic.account', { name: 'Eng', plan_id: analyticPlan.id, company_id: 1 });
  db = analyticAcc.db;

  const billEntry = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-01-10',
    ref: 'Insurance 2026',
    lines: [
      { account_id: expense.id, debit: 1000, analytic_distribution: { [analyticAcc.id]: 100 }, name: 'Annual Insurance' },
      { account_id: cash.id, credit: 1000, name: 'Cash Paid' },
    ],
  });
  db = billEntry.db;

  const revEntry = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-01-12',
    ref: 'Retainer',
    lines: [
      { account_id: cash.id, debit: 500, name: 'Cash In' },
      { account_id: income.id, credit: 500, name: 'Service Revenue' },
    ],
  });
  db = revEntry.db;

  const expRow = journalItems(db).find((l) => l.move_id === billEntry.id && l.account_id === expense.id);
  const cashRow = journalItems(db).find((l) => l.move_id === billEntry.id && l.account_id === cash.id);
  const revRow = journalItems(db).find((l) => l.move_id === revEntry.id && l.account_id === income.id);

  // Eligibility checks: balance sheet accounts or mixed income+expense disallowed.
  assert.equal(canChangePeriod([cashRow], db), false);
  assert.equal(canChangePeriod([expRow, revRow], db), false);
  assert.equal(canChangePeriod([expRow], db), true);
  assert.equal(canChangePeriod([revRow], db), true);

  assert.throws(
    () => changePeriod(db, [cashRow], { date: '2026-02-01', percentage: 50 }),
    /income and expense accounts/,
  );
  assert.throws(
    () => changePeriod(db, [expRow, revRow], { date: '2026-02-01', percentage: 50 }),
    /mix income and expense/,
  );
  assert.throws(
    () => changePeriod(db, [expRow], { date: '2026-02-01', percentage: 150 }),
    /Percentage must be greater than 0 and at most 100/,
  );

  // Expense 60% shifted from 2026-01-10 to 2026-02-01 -> two entries: deferral on 2026-01-10 + reversal on 2026-02-01
  const expShifted = changePeriod(db, [{ move_id: expRow.move_id, line_identity: expRow.line_identity }], {
    date: '2026-02-01',
    percentage: 60,
  });
  const applied = applyDiff(db, diffDb(db, expShifted), { isAdmin: true });
  const created = (applied.records['account.move'] ?? []).filter((m) => !db.records['account.move'].some((o) => o.id === m.id));
  assert.equal(created.length, 2, 'changePeriod creates two entries');

  const adjEntry = created.find((m) => m.date === '2026-01-10');
  const recEntry = created.find((m) => m.date === '2026-02-01');
  assert.ok(adjEntry && recEntry);
  assert.equal(recEntry.reversed_entry_id, adjEntry.id);
  assert.equal(adjEntry.reversal_move_id, recEntry.id);
  assert.deepEqual(adjEntry.automatic_entry_source_move_ids, [billEntry.id]);
  assert.deepEqual(recEntry.automatic_entry_source_move_ids, [billEntry.id]);

  // Verify amounts (60% of 1000 = 600), accrual account, and preserved analytic distribution
  const adjExp = adjEntry.line_ids.find((l) => l.account_id === expense.id);
  const adjDef = adjEntry.line_ids.find((l) => l.account_id === defExpAcc.id);
  assert.equal(adjExp.credit, 600);
  assert.deepEqual(adjExp.analytic_distribution, { [analyticAcc.id]: 100 });
  assert.equal(adjDef.debit, 600);

  const recExp = recEntry.line_ids.find((l) => l.account_id === expense.id);
  const recDef = recEntry.line_ids.find((l) => l.account_id === defExpAcc.id);
  assert.equal(recExp.debit, 600);
  assert.deepEqual(recExp.analytic_distribution, { [analyticAcc.id]: 100 });
  assert.equal(recDef.credit, 600);

  // Income 100% shifted uses deferred_revenue_account_id and creates its two entries too.
  const revShifted = changePeriod(applied, [{ move_id: revRow.move_id, line_identity: revRow.line_identity }], {
    date: '2026-03-01',
    percentage: 100,
  });
  const appliedRev = applyDiff(applied, diffDb(applied, revShifted), { isAdmin: true });
  const revCreated = (appliedRev.records['account.move'] ?? []).filter((m) => !applied.records['account.move'].some((o) => o.id === m.id));
  assert.equal(revCreated.length, 2);
  assert.ok(revCreated.some((m) => m.date === '2026-01-12' && m.line_ids.some((l) => l.account_id === defRevAcc.id && l.credit === 500)));
  assert.ok(revCreated.some((m) => m.date === '2026-03-01' && m.line_ids.some((l) => l.account_id === income.id && l.credit === 500)));

  // Lock date enforcement through diffDb + applyDiff (both D1 and D2 checked!)
  const lockedD1 = write(db, 'res.company', 1, { lock_date: '2026-01-15' });
  assert.throws(() => applyDiff(lockedD1, diffDb(db, expShifted), { isAdmin: true }), /locked/i);
  const lockedD2 = write(db, 'res.company', 1, { lock_date: '2026-02-05' });
  assert.throws(() => applyDiff(lockedD2, diffDb(db, expShifted), { isAdmin: true }), /locked/i);
});

test('ji3 UI + i18n: JournalItems shows Post, Move to Account, and Change Period only when eligible, runs workflows, and translates strings to Arabic', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  const { makeEl } = setupDom();
  await initStore();

  let db = seed();
  const expense = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const prepaid = read(db, 'account.account', read(db, 'res.company', 1).deferred_expense_account_id);
  const cash = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_cash');

  const draftMove = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-04-01',
    state: 'draft',
    ref: 'UI-DRAFT',
    lines: [
      { account_id: expense.id, debit: 90, name: 'UI Draft Expense' },
      { account_id: cash.id, credit: 90, name: 'UI Draft Cash' },
    ],
  });
  db = draftMove.db;

  const postedMove = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-04-02',
    ref: 'UI-POSTED',
    lines: [
      { account_id: expense.id, debit: 200, name: 'UI Posted Expense' },
      { account_id: cash.id, credit: 200, name: 'UI Posted Cash' },
    ],
  });
  db = postedMove.db;

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  const button = (label) => find(host, (node) => node.tagName === 'BUTTON' && node.textContent === label);
  const checkboxForLabel = (label) => {
    const row = find(host, (node) => node.tagName === 'TR' && node.textContent.includes(label));
    return find(row, (node) => node.tagName === 'INPUT' && props(node)?.type === 'checkbox');
  };

  try {
    // 1. Draft mode shows Draft items and enables Post (while keeping Move to Account / Change Period disabled)
    await React.act(async () => { await commit(db); root.render(React.createElement(JournalItems, { leaf: { reviewMode: 'draft' } })); });
    await React.act(async () => props(checkboxForLabel('UI Draft Expense')).onChange({ target: { checked: true } }));
    assert.equal(props(button('Post')).disabled, false);
    assert.equal(props(button('Move to Account')).disabled, true);
    assert.equal(props(button('Change Period')).disabled, true);
    await React.act(async () => props(button('Post')).onClick());
    assert.equal(read(getDb(), 'account.move', draftMove.id).state, 'posted');

    // 2. Default Journal Items (posted): cash item allows Move to Account but NOT Change Period; expense item allows BOTH!
    await React.act(async () => { root.render(React.createElement(JournalItems, { key: 'posted' })); });
    await React.act(async () => props(checkboxForLabel('UI Posted Cash')).onChange({ target: { checked: true } }));
    assert.equal(props(button('Post')).disabled, true);
    assert.equal(props(button('Move to Account')).disabled, false);
    assert.equal(props(button('Change Period')).disabled, true);

    await React.act(async () => props(checkboxForLabel('UI Posted Cash')).onChange({ target: { checked: false } }));
    await React.act(async () => props(checkboxForLabel('UI Posted Expense')).onChange({ target: { checked: true } }));
    assert.equal(props(button('Change Period')).disabled, false);
    await React.act(async () => props(button('Change Period')).onClick());

    const form = find(host, (node) => node.tagName === 'FORM');
    assert.ok(form, 'Change Period wizard opens when eligible');
    const pctInput = find(form, (n) => n.tagName === 'INPUT' && props(n)?.type === 'number');
    const dateInput = find(form, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    await React.act(async () => props(pctInput).onChange({ target: { value: '50' } }));
    await React.act(async () => props(dateInput).onChange({ target: { value: '2026-05-01' } }));
    await React.act(async () => props(form).onSubmit({ preventDefault() {} }));

    const periodMoves = (getDb().records['account.move'] ?? []).filter((m) => (m.automatic_entry_source_move_ids ?? []).includes(postedMove.id));
    assert.equal(periodMoves.length, 2);

    // 3. Move to Account wizard flow from UI
    await React.act(async () => props(checkboxForLabel('UI Draft Cash')).onChange({ target: { checked: true } }));
    await React.act(async () => props(button('Move to Account')).onClick());
    const moveForm = find(host, (node) => node.tagName === 'FORM');
    const accountSelect = find(moveForm, (n) => n.tagName === 'SELECT');
    await React.act(async () => props(accountSelect).onChange({ target: { value: String(prepaid.id) } }));
    await React.act(async () => props(moveForm).onSubmit({ preventDefault() {} }));
    const transferMoves = (getDb().records['account.move'] ?? []).filter((m) => (m.automatic_entry_source_move_ids ?? []).includes(draftMove.id));
    assert.equal(transferMoves.length, 1);
  } finally {
    await React.act(async () => root.unmount());
  }

  // Arabic translation checks
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t: tAr } = await import('./i18n.js?lang=ar-ji3');
    for (const label of [
      'Post', 'Move to Account', 'Change Period', 'Destination Account', 'Accrual Account', 'Percentage',
      'Automatic Entries', 'Origin Entries', 'Only draft entries can be posted',
      'You can only use this wizard on posted journal items.',
      'You cannot create automatic entries for items from different companies.',
      'You cannot use this wizard on reconciled journal items.',
      'This wizard is only meant for income and expense accounts.',
      'Select only draft journal items',
      'Select unreconciled posted journal items from a single company',
      'Select posted income or expense journal items from a single company',
    ]) {
      assert.notEqual(tAr(label), label, `expected non-identity Arabic translation for "${label}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

const syncDb = (base, next) => applyDiff(base, diffDb(base, next), { isAdmin: true });
const itemsOf = (db, moveId, accountId) => journalItems(db).filter((l) => l.move_id === moveId && l.account_id === accountId)
  .map((l) => ({ move_id: l.move_id, line_identity: l.line_identity }));
function expenseSource() {
  let db = seed();
  const expense = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const cash = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_cash');
  const prepaid = findAccount(db, (a) => (a.company_id ?? 1) === 1 && ['asset_prepayments', 'asset_current'].includes(a.account_type));
  const src = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-10', ref: 'SRC', lines: [
    { account_id: expense.id, debit: 100, name: 'Rent' }, { account_id: cash.id, credit: 100, name: 'Cash' }] });
  db = src.db;
  return { db, src: src.id, expense, cash, prepaid };
}

test('ji3 Qodo: resetting a source keeps its automatic entries editable, and posted entries never gain origins', () => {
  const s = expenseSource();
  let db = syncDb(s.db, moveToAccount(s.db, itemsOf(s.db, s.src, s.expense.id), { destinationAccountId: s.prepaid.id, date: '2026-02-20' }));
  const auto = db.records['account.move'].find((m) => (m.automatic_entry_source_move_ids ?? []).includes(s.src));
  db = syncDb(db, write(db, 'account.move', s.src, { state: 'draft' }));
  assert.doesNotThrow(() => syncDb(db, write(db, 'account.move', auto.id, { state: 'draft' })));
  const other = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-11', ref: 'OTHER', lines: [
    { account_id: s.expense.id, debit: 5, name: 'x' }, { account_id: s.cash.id, credit: 5, name: 'y' }] });
  db = syncDb(db, other.db);
  const posted = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-12', ref: 'PLAIN', lines: [
    { account_id: s.expense.id, debit: 7, name: 'x' }, { account_id: s.cash.id, credit: 7, name: 'y' }] });
  db = syncDb(db, posted.db);
  assert.throws(() => syncDb(db, write(db, 'account.move', posted.id, { automatic_entry_source_move_ids: [other.id] })), /cannot be edited/);
});

test('ji3 Qodo: both wizards process items whose account was archived since posting', () => {
  const s = expenseSource();
  const sel = itemsOf(s.db, s.src, s.expense.id);
  const archived = syncDb(s.db, write(s.db, 'account.account', s.expense.id, { active: false }));
  assert.doesNotThrow(() => syncDb(archived, moveToAccount(archived, sel, { destinationAccountId: s.prepaid.id, date: '2026-02-20' })));
  assert.doesNotThrow(() => syncDb(archived, changePeriod(archived, sel, { date: '2026-03-31', accountId: s.prepaid.id })));
});

test('ji3 Qodo: Change Period rejects an income or expense account as the accrual account', () => {
  const s = expenseSource();
  const otherPl = findAccount(s.db, (a) => (a.company_id ?? 1) === 1 && ['expense', 'income'].includes(a.account_type) && a.id !== s.expense.id);
  assert.throws(() => changePeriod(s.db, itemsOf(s.db, s.src, s.expense.id), { date: '2026-03-31', accountId: otherPl.id }), /balance sheet account/);
});

test('ji3 Qodo: a foreign group netting to zero in company currency transfers without reconciling a zero line', () => {
  let db = seed();
  const ar = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_receivable');
  const income = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'income');
  const cash = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_cash');
  const prepaid = findAccount(db, (a) => (a.company_id ?? 1) === 1 && ['asset_prepayments', 'asset_current'].includes(a.account_type) && a.id !== ar.id);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const partner = search(db, 'res.partner')[0].id;
  const a = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-01', ref: 'A', lines: [
    { account_id: ar.id, partner_id: partner, debit: 100, currency_id: eur.id, amount_currency: 90, name: 'a' }, { account_id: income.id, credit: 100, name: 'i' }] });
  db = a.db;
  const b = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-02', ref: 'B', lines: [
    { account_id: cash.id, debit: 100, name: 'c' }, { account_id: ar.id, partner_id: partner, credit: 100, currency_id: eur.id, amount_currency: -80, name: 'b' }] });
  db = b.db;
  const sel = [...itemsOf(db, a.id, ar.id), ...itemsOf(db, b.id, ar.id)];
  assert.doesNotThrow(() => syncDb(db, moveToAccount(db, sel, { destinationAccountId: prepaid.id, date: '2026-02-20' })));
});

test('ji3 Qodo: forged automatic entries cannot repeat source IDs or bypass workflow checks for archived accounts', () => {
  const s = expenseSource();
  const ar = findAccount(s.db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_receivable');
  const partner = search(s.db, 'res.partner')[0].id;
  const arSrc = postEntry(s.db, {
    journal: 'MISC',
    company: 1,
    date: '2026-02-12',
    ref: 'AR-SRC',
    lines: [
      { account_id: ar.id, partner_id: partner, debit: 80, name: 'AR' },
      { account_id: s.cash.id, credit: 80, name: 'Cash' },
    ],
  });
  let db = syncDb(s.db, arSrc.db);
  const src2 = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-02-15',
    ref: 'SRC-2',
    lines: [
      { account_id: s.expense.id, debit: 40, name: 'Rent 2' },
      { account_id: s.cash.id, credit: 40, name: 'Cash 2' },
    ],
  });
  db = syncDb(db, src2.db);

  // Archive the expense and AR accounts after posting.
  const multiDateSel = [...itemsOf(db, s.src, s.expense.id), ...itemsOf(db, src2.id, s.expense.id)];
  db = syncDb(db, write(db, 'account.account', s.expense.id, { active: false }));
  db = syncDb(db, write(db, 'account.account', ar.id, { active: false }));

  // Legitimate multi-date Change Period on archived P&L accounts (no reversed_entry_id on recognition) succeeds.
  assert.doesNotThrow(() => syncDb(db, changePeriod(db, multiDateSel, { date: '2026-03-31', accountId: s.prepaid.id })));

  const miscJournal = findJournal(db, 1, 'general');
  const nextMoveId = Math.max(0, ...(db.records['account.move'] ?? []).map((m) => m.id)) + 1;
  const forgedDiff = (overrides) => ({
    upserts: {
      'account.move': [{
        id: nextMoveId,
        move_type: 'entry',
        state: 'posted',
        company_id: 1,
        journal_id: miscJournal.id,
        date: '2026-02-20',
        invoice_date: '2026-02-20',
        name: `MISC/2026/${nextMoveId}`,
        ref: 'Forged',
        automatic_entry_source_move_ids: [s.src],
        line_ids: [
          { account_id: s.expense.id, debit: 0, credit: 100, name: 'Reversed' },
          { account_id: s.cash.id, debit: 100, credit: 0, name: 'Cash' },
        ],
        ...overrides,
      }],
    },
    created: { 'account.move': [nextMoveId] },
    deletes: {},
    bases: {},
    messages: [],
    removedMessages: [],
  });

  // 1) Forged sync entry repeating a posted same-company source ID to inflate archived-account posting is rejected.
  assert.throws(
    () => applyDiff(db, forgedDiff({
      automatic_entry_source_move_ids: [s.src, s.src],
      line_ids: [
        { account_id: s.expense.id, debit: 0, credit: 100, name: 'Half' },
        { account_id: s.expense.id, debit: 0, credit: 100, name: 'Inflated' },
        { account_id: s.cash.id, debit: 200, credit: 0, name: 'Cash' },
      ],
    }), { isAdmin: true }),
    /Invalid value for account\.move\.automatic_entry_source_move_ids|Archived accounts cannot be selected/,
  );

  // Duplicate source IDs are also rejected directly on model create / postEntry even with active accounts.
  assert.throws(
    () => postEntry(db, {
      journal: 'MISC',
      company: 1,
      date: '2026-02-20',
      ref: 'Active dup',
      automatic_entry_source_move_ids: [s.src, s.src],
      lines: [
        { account_id: s.prepaid.id, debit: 20, name: 'Prepaid' },
        { account_id: s.cash.id, credit: 20, name: 'Cash' },
      ],
    }),
    /same origin entry more than once/,
  );

  // 2) Forged entry posting on the SAME side as the source (without a paired Change Period adjustment) is rejected.
  assert.throws(
    () => applyDiff(db, forgedDiff({
      line_ids: [
        { account_id: s.expense.id, debit: 100, credit: 0, name: 'Same side' },
        { account_id: s.cash.id, debit: 0, credit: 100, name: 'Cash' },
      ],
    }), { isAdmin: true }),
    /Archived accounts cannot be selected/,
  );

  // 3) Forged draft entry or non-general journal entry claiming automatic_entry_source_move_ids is rejected.
  assert.throws(
    () => applyDiff(db, forgedDiff({ state: 'draft', name: '/' }), { isAdmin: true }),
    /Archived accounts cannot be selected/,
  );
  const saleJournal = findJournal(db, 1, 'sale');
  assert.throws(
    () => applyDiff(db, forgedDiff({ journal_id: saleJournal.id }), { isAdmin: true }),
    /Archived accounts cannot be selected/,
  );

  // 4) Forged Move-to-Account entry on an archived reconcilable account without reconciling it is rejected.
  assert.throws(
    () => applyDiff(db, forgedDiff({
      automatic_entry_source_move_ids: [arSrc.id],
      line_ids: [
        { account_id: ar.id, partner_id: partner, debit: 0, credit: 80, name: 'Unreconciled AR' },
        { account_id: s.prepaid.id, partner_id: partner, debit: 80, credit: 0, name: 'Prepaid' },
      ],
    }), { isAdmin: true }),
    /Archived accounts cannot be selected/,
  );
});

function archivedArTransfer(lines) {
  let db = seed();
  const ar = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_receivable');
  const income = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'income');
  const prepaid = findAccount(db, (a) => (a.company_id ?? 1) === 1 && ['asset_prepayments', 'asset_current'].includes(a.account_type) && a.id !== ar.id);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const partner = search(db, 'res.partner')[0].id;
  const ids = [];
  for (const [i, spec] of lines.entries()) {
    const posted = postEntry(db, { journal: 'MISC', company: 1, date: `2026-02-0${i + 1}`, ref: `AR-${i}`, lines: [
      { account_id: ar.id, partner_id: partner, ...(spec.eur === undefined ? {} : { currency_id: eur.id, amount_currency: spec.eur }), ...spec.ar, name: 'ar' },
      { account_id: income.id, ...(spec.ar.debit ? { credit: spec.ar.debit } : { debit: spec.ar.credit }), name: 'i' }] });
    db = posted.db;
    ids.push(posted.id);
  }
  db = syncDb(db, write(db, 'account.account', ar.id, { active: false }));
  return { db, ar, prepaid, ids, sel: ids.flatMap((id) => itemsOf(db, id, ar.id)) };
}

test('ji3 Qodo: an archived reconcilable transfer line must be cleared by its source partials, not just touched by one', () => {
  const s = archivedArTransfer([{ ar: { debit: 80 } }]);
  const moved = moveToAccount(s.db, s.sel, { destinationAccountId: s.prepaid.id, date: '2026-02-20' });
  const diff = diffDb(s.db, moved);
  assert.doesNotThrow(() => applyDiff(s.db, diff, { isAdmin: true }), 'the genuine transfer clears the archived line in full');
  const partials = diff.upserts['account.partial.reconcile'];
  assert.equal(partials.length, 1);
  assert.equal(partials[0].amount, 80);
  const forged = { ...diff, upserts: { ...diff.upserts, 'account.partial.reconcile': [{ ...partials[0], amount: 1 }] } };
  assert.throws(() => applyDiff(s.db, forged, { isAdmin: true }), /Archived accounts cannot be selected/);
});

test('ji3 Qodo: a foreign-currency transfer with exchange differences stays authorized', () => {
  for (const spec of [
    [{ ar: { debit: 100 }, eur: 90 }, { ar: { credit: 50 }, eur: -30 }],
    // Counter-line itself carries the overvalued rate, so its own gap partial is needed to cover its company balance.
    [{ ar: { debit: 100 }, eur: 90 }, { ar: { credit: 10 }, eur: -30 }],
  ]) {
    const s = archivedArTransfer(spec);
    const moved = moveToAccount(s.db, s.sel, { destinationAccountId: s.prepaid.id, date: '2026-02-20' });
    const diff = diffDb(s.db, moved);
    assert.ok(diff.upserts['account.partial.reconcile'].some((p) => p.exchange_move_id != null), 'the rates differ, so an exchange difference is booked');
    assert.doesNotThrow(() => applyDiff(s.db, diff, { isAdmin: true }));
  }

  // A forged partial that only reconciles 1 EUR of a 90 EUR archived transfer line is rejected.
  const single = archivedArTransfer([{ ar: { debit: 100 }, eur: 90 }]);
  const movedSingle = moveToAccount(single.db, single.sel, { destinationAccountId: single.prepaid.id, date: '2026-02-20' });
  const singleDiff = diffDb(single.db, movedSingle);
  const p0 = singleDiff.upserts['account.partial.reconcile'][0];
  const shortForeign = {
    ...singleDiff,
    upserts: { ...singleDiff.upserts, 'account.partial.reconcile': [{ ...p0, amount: 100, debit_amount_currency: 1, credit_amount_currency: 1 }] },
  };
  assert.throws(() => applyDiff(single.db, shortForeign, { isAdmin: true }), /Archived accounts cannot be selected/);
});

test('ji3 Qodo: a paired Change Period must keep the foreign amounts of its archived source lines', () => {
  let db = seed();
  const expense = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'expense');
  const cash = findAccount(db, (a) => (a.company_id ?? 1) === 1 && a.account_type === 'asset_cash');
  const prepaid = findAccount(db, (a) => (a.company_id ?? 1) === 1 && ['asset_prepayments', 'asset_current'].includes(a.account_type));
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const src = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-10', ref: 'FX-SRC', lines: [
    { account_id: expense.id, debit: 100, currency_id: eur.id, amount_currency: 90, name: 'Rent' }, { account_id: cash.id, credit: 100, name: 'Cash' }] });
  db = syncDb(db, src.db);
  db = syncDb(db, write(db, 'account.account', expense.id, { active: false }));
  const sel = itemsOf(db, src.id, expense.id);
  const diff = diffDb(db, changePeriod(db, sel, { date: '2026-03-31', accountId: prepaid.id }));
  assert.doesNotThrow(() => applyDiff(db, diff, { isAdmin: true }), 'the genuine 100% pair is authorized');
  const partialDiff = diffDb(db, changePeriod(db, sel, { date: '2026-03-31', accountId: prepaid.id, percentage: 50 }));
  assert.doesNotThrow(() => applyDiff(db, partialDiff, { isAdmin: true }), 'a genuine partial-percentage pair is authorized');

  const scaleForeign = (factor) => (move) => ({ ...move, line_ids: move.line_ids.map((l) => (l.currency_id ? { ...l, amount_currency: l.amount_currency * factor } : l)) });
  const inflated = { ...diff, upserts: { ...diff.upserts, 'account.move': diff.upserts['account.move'].map(scaleForeign(10)) } };
  assert.ok(inflated.upserts['account.move'].some((m) => m.line_ids.some((l) => Math.abs(l.amount_currency) === 900)));
  assert.throws(() => applyDiff(db, inflated, { isAdmin: true }), /Archived accounts cannot be selected/);

  const deflated = { ...diff, upserts: { ...diff.upserts, 'account.move': diff.upserts['account.move'].map(scaleForeign(0.1)) } };
  assert.ok(deflated.upserts['account.move'].some((m) => m.line_ids.some((l) => Math.abs(l.amount_currency) === 9)));
  assert.throws(() => applyDiff(db, deflated, { isAdmin: true }), /Archived accounts cannot be selected/);
});
