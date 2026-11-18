import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { createCompany } from './models/company.js';
import { accountId, journalItemIdentity, journalItems, postEntry, reconciledJournalItems } from './models/ledger.js';
import { reconcileLedgerItems, unreconcileLedgerItems } from './models/glReconcile.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function itemSelection(db, moveId, account, predicate = () => true) {
  const rows = journalItems(db).filter((l) => l.move_id === moveId && l.account_id === account && predicate(l));
  assert.equal(rows.length, 1, `Expected 1 journal item on move ${moveId} account ${account}, got ${rows.length}`);
  return { move_id: moveId, line_identity: rows[0].line_identity };
}

function miscJournal(db, companyId = 1) {
  return search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === companyId));
}

function arAccount(db, companyId = 1) {
  return read(db, 'res.company', companyId)?.account_default_receivable_id ?? accountId(db, '121000', companyId);
}

test('Case 1: Multi-item matching: multiple debits and credits matched oldest first, partial residual, full match shared matching number', async () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Multi Customer Co' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const misc = miscJournal(db, 1);

  // 2 debits on AR:
  // d1: date 2026-04-01, debit 100
  // d2: date 2026-04-02, debit 200
  const d1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'Debit 1',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 100 }, { account_id: rev, credit: 100 }],
  });
  const d2 = postEntry(d1.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-02', ref: 'Debit 2',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 200 }, { account_id: rev, credit: 200 }],
  });

  // 2 credits on AR:
  // c1: date 2026-04-01, credit 150
  // c2: date 2026-04-03, credit 100
  const c1 = postEntry(d2.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'Credit 1',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 150 }, { account_id: rev, debit: 150 }],
  });
  const c2 = postEntry(c1.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-03', ref: 'Credit 2',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 100 }, { account_id: rev, debit: 100 }],
  });
  db = c2.db;

  // Reconcile all 4 items together
  const sel = [
    itemSelection(db, d1.id, ar),
    itemSelection(db, d2.id, ar),
    itemSelection(db, c1.id, ar),
    itemSelection(db, c2.id, ar),
  ];
  const partialDb = reconcileLedgerItems(db, sel, { date: '2026-04-04' });

  // Debits total 300, credits total 250:
  // d1 (100) vs c1 (150) -> d1 closed (0), c1 has 50 left
  // d2 (200) vs c1 (50)  -> c1 closed (0), d2 has 150 left
  // d2 (150) vs c2 (100) -> c2 closed (0), d2 has 50 left (partial reconciliation)
  const d1Line = reconciledJournalItems(partialDb, read(partialDb, 'account.move', d1.id)).find((l) => l.account_id === ar);
  const d2Line = reconciledJournalItems(partialDb, read(partialDb, 'account.move', d2.id)).find((l) => l.account_id === ar);
  const c1Line = reconciledJournalItems(partialDb, read(partialDb, 'account.move', c1.id)).find((l) => l.account_id === ar);
  const c2Line = reconciledJournalItems(partialDb, read(partialDb, 'account.move', c2.id)).find((l) => l.account_id === ar);

  assert.equal(d1Line.reconciled, true);
  assert.equal(d1Line.amount_residual, 0);
  assert.equal(c1Line.reconciled, true);
  assert.equal(c1Line.amount_residual, 0);
  assert.equal(c2Line.reconciled, true);
  assert.equal(c2Line.amount_residual, 0);

  // d2 still has 50 residual open
  assert.equal(d2Line.reconciled, false);
  assert.equal(d2Line.amount_residual, 50);

  // Partial group does not assign matching number to unclosed d2
  assert.equal(d2Line.matching_number ?? null, null);

  // Now create c3 for the remaining 50 on 2026-04-05 and reconcile with d2
  const c3 = postEntry(partialDb, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-05', ref: 'Credit 3',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 50 }, { account_id: rev, debit: 50 }],
  });
  const fullDb = reconcileLedgerItems(c3.db, [itemSelection(c3.db, d2.id, ar), itemSelection(c3.db, c3.id, ar)], { date: '2026-04-05' });

  const d1Full = reconciledJournalItems(fullDb, read(fullDb, 'account.move', d1.id)).find((l) => l.account_id === ar);
  const d2Full = reconciledJournalItems(fullDb, read(fullDb, 'account.move', d2.id)).find((l) => l.account_id === ar);
  const c1Full = reconciledJournalItems(fullDb, read(fullDb, 'account.move', c1.id)).find((l) => l.account_id === ar);
  const c2Full = reconciledJournalItems(fullDb, read(fullDb, 'account.move', c2.id)).find((l) => l.account_id === ar);
  const c3Full = reconciledJournalItems(fullDb, read(fullDb, 'account.move', c3.id)).find((l) => l.account_id === ar);

  assert.equal(d2Full.reconciled, true);
  assert.equal(d2Full.amount_residual, 0);
  assert.equal(c3Full.reconciled, true);
  assert.equal(c3Full.amount_residual, 0);

  // All 5 items are in the same matching group and share the identical matching number
  assert.ok(d1Full.matching_number, 'matching number assigned');
  assert.equal(d1Full.matching_number, d2Full.matching_number);
  assert.equal(d1Full.matching_number, c1Full.matching_number);
  assert.equal(d1Full.matching_number, c2Full.matching_number);
  assert.equal(d1Full.matching_number, c3Full.matching_number);

  // Unreconciling an item reopens it with its full residual and clears its matching number.
  const reopened = unreconcileLedgerItems(fullDb, [itemSelection(fullDb, d1.id, ar)], { date: '2026-04-06' });
  const d1Open = reconciledJournalItems(reopened, read(reopened, 'account.move', d1.id)).find((l) => l.account_id === ar);
  assert.equal(d1Open.reconciled, false);
  assert.equal(d1Open.amount_residual, 100);
  assert.equal(d1Open.matching_number ?? null, null);
});

test('Case 2: Guards: cross-company, different accounts, non-reconcilable, draft/cancelled, mixed currency; held through diffDb+applyDiff', async () => {
  let db = seed();
  const co2 = createCompany(db, { name: 'Company 2', currency_id: 1 });
  db = co2.db;

  const partner1 = create(db, 'res.partner', { name: 'Guard Partner 1' });
  db = partner1.db;
  const ar = arAccount(db, 1);
  const arCo2 = arAccount(db, co2.id);
  const ap = accountId(db, '211000', 1);
  const nonRec = accountId(db, '400000', 1); // Revenue, non-reconcilable
  const revCo2 = accountId(db, '400000', co2.id);
  const misc = miscJournal(db, 1);
  const misc2 = miscJournal(db, co2.id);

  const eur = create(db, 'res.currency', {
    name: 'EUR_GUARD', symbol: '€', rounding: 0.01,
    rate_ids: [{ date: '2026-04-01', rate: 0.5 }],
  });
  db = eur.db;

  // Posted valid move 1 in Co 1
  const move1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'Move 1',
    lines: [{ account_id: ar, partner_id: partner1.id, debit: 100 }, { account_id: nonRec, credit: 100 }],
  });
  // Posted move in Co 2
  const moveCo2 = postEntry(move1.db, {
    journal: misc2.code, journal_id: misc2.id, company: co2.id, date: '2026-04-01', ref: 'Move Co 2',
    lines: [{ account_id: arCo2, partner_id: partner1.id, credit: 100 }, { account_id: revCo2, debit: 100 }],
  });
  // Posted move on AP account
  const moveAp = postEntry(moveCo2.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'Move AP',
    lines: [{ account_id: ap, partner_id: partner1.id, credit: 100 }, { account_id: nonRec, debit: 100 }],
  });
  // Posted moves on non-reconcilable account
  const moveNonRecDeb = postEntry(moveAp.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'NonRec Debit',
    lines: [{ account_id: nonRec, partner_id: partner1.id, debit: 100 }, { account_id: ar, credit: 100 }],
  });
  const moveNonRecCred = postEntry(moveNonRecDeb.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'NonRec Credit',
    lines: [{ account_id: nonRec, partner_id: partner1.id, credit: 100 }, { account_id: ar, debit: 100 }],
  });
  // Draft move
  const draftCreated = create(moveNonRecCred.db, 'account.move', {
    name: 'DRAFT/01', state: 'draft', move_type: 'entry', company_id: 1, journal_id: misc.id, date: '2026-04-01',
    line_ids: [{ account_id: ar, partner_id: partner1.id, credit: 100 }, { account_id: nonRec, debit: 100 }],
  });
  // Foreign currency move (EUR)
  const eurMove = postEntry(draftCreated.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'EUR Move',
    lines: [
      { account_id: ar, partner_id: partner1.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: nonRec, debit: 200 },
    ],
  });
  db = eurMove.db;
  const draftMove = read(db, 'account.move', draftCreated.id);

  const validCreditMove = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'Valid Credit',
    lines: [{ account_id: ar, partner_id: partner1.id, credit: 100 }, { account_id: nonRec, debit: 100 }],
  });
  db = validCreditMove.db;

  const baseTemplate = {
    id: 99991,
    debit_move_id: move1.id,
    debit_line_index: 0,
    credit_move_id: validCreditMove.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 100,
    date: '2026-04-01',
    active: true,
    reversed: false,
  };

  const forged = (patch) => ({
    ...db,
    records: {
      ...db.records,
      'account.partial.reconcile': [
        ...(db.records['account.partial.reconcile'] ?? []),
        { ...baseTemplate, ...patch },
      ],
    },
  });

  // 4a. Cross-company
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, move1.id, ar), itemSelection(db, moveCo2.id, arCo2)], { date: '2026-04-01' }),
    /same company/i,
  );
  assert.throws(
    () => applyDiff(db, diffDb(db, forged({ credit_move_id: moveCo2.id })), { isAdmin: true }),
    /company/i,
  );

  // 4b. Different accounts
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, move1.id, ar), itemSelection(db, moveAp.id, ap)], { date: '2026-04-01' }),
    /same account/i,
  );
  assert.throws(
    () => applyDiff(db, diffDb(db, forged({ credit_move_id: moveAp.id })), { isAdmin: true }),
    /match the link account/i,
  );

  // 4c. Non-reconcilable account
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, moveNonRecDeb.id, nonRec), itemSelection(db, moveNonRecCred.id, nonRec)], { date: '2026-04-01' }),
    /reconcilable account/i,
  );
  assert.throws(
    () => applyDiff(db, diffDb(db, forged({
      debit_move_id: moveNonRecDeb.id,
      credit_move_id: moveNonRecCred.id,
      account_id: nonRec,
    })), { isAdmin: true }),
    /reconcilable account/i,
  );

  // 4d. Draft or cancelled items
  assert.throws(
    () => reconcileLedgerItems(db, [{ move_id: draftMove.id, line_identity: journalItemIdentity(draftMove.line_ids[0]) }, itemSelection(db, move1.id, ar)], { date: '2026-04-01' }),
    /posted/i,
  );
  assert.throws(
    () => applyDiff(db, diffDb(db, forged({ credit_move_id: draftMove.id })), { isAdmin: true }),
    /posted/i,
  );

  // 4e. Mixed currency (USD vs EUR)
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, move1.id, ar), itemSelection(db, eurMove.id, ar)], { date: '2026-04-01' }),
    /company currency/i,
  );
  assert.throws(
    () => applyDiff(db, diffDb(db, forged({ credit_move_id: eurMove.id })), { isAdmin: true }),
    /company currency/i,
  );
});

test('Case 3: Journal Items reconcile action reconciles through the ledger model', async () => {
  // UI parity: render JournalItems and verify action buttons trigger reconcileLedgerItems
  const { makeEl } = setupDom();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();

  let db = seed();
  const partner = create(db, 'res.partner', { name: 'UI Parity Customer' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const misc = miscJournal(db, 1);

  const d = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'UI Debit',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 100 }, { account_id: rev, credit: 100 }],
  });
  const c = postEntry(d.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'UI Credit',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 100 }, { account_id: rev, debit: 100 }],
  });
  db = c.db;

  const root = createRoot(host);
  const arName = read(db, 'account.account', ar).name;
  const selectRow = async (moveId) => {
    const row = find(host, (n) => n.tagName === 'TR' && find(n, (a) => a.tagName === 'A' && props(a)?.href === `#/accounting/entries/${moveId}`) && n.textContent.includes(arName));
    assert.ok(row, `Row for move ${moveId} must exist`);
    const cb = find(row, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    await React.act(async () => props(cb).onChange({ target: { checked: true } }));
  };

  await React.act(async () => {
    await commit(db);
    root.render(React.createElement(JournalItems, { leaf: { reviewMode: 'unreconciled' } }));
  });

  await selectRow(d.id);
  await selectRow(c.id);

  const reconcileBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Reconcile');
  assert.ok(reconcileBtn, 'Reconcile button exists');
  await React.act(async () => props(reconcileBtn).onClick());

  const dateInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && !props(n)?.['aria-label']);
  await React.act(async () => props(dateInput).onChange({ target: { value: '2026-04-01' } }));
  await React.act(async () => props(find(host, (n) => n.tagName === 'FORM')).onSubmit({ preventDefault() {} }));

  const reconciledDb = getDb();
  const dLine = reconciledJournalItems(reconciledDb, read(reconciledDb, 'account.move', d.id)).find((l) => l.account_id === ar);
  const cLine = reconciledJournalItems(reconciledDb, read(reconciledDb, 'account.move', c.id)).find((l) => l.account_id === ar);
  assert.equal(dLine.reconciled, true);
  assert.equal(cLine.reconciled, true);
  assert.equal(dLine.matching_number, cLine.matching_number);
});
