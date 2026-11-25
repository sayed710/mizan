import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { seed } from './seed.js';
import { applyFilters, create, groupRecords, matches, read, search } from './orm.js';
import { models } from './models/index.js';
import { shiftMonth, today } from './models/common.js';
import { ensureBankSuspense } from './models/ledger.js';
import { statementListDecoration } from './models/bankstatement.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const { List } = await import('./views/List.jsx');

const STMT = 'account.bank.statement';

function makeCashJournal(db, { code = 'CSHBST3', name = 'BST3 Cash' } = {}) {
  const acc = create(db, 'account.account', {
    code: '101588',
    name: `${name} Account`,
    account_type: 'asset_cash',
    company_id: 1,
  });
  const suspense = ensureBankSuspense(acc.db, 1);
  const j = create(suspense.db, 'account.journal', {
    name,
    code,
    type: 'cash',
    default_account_id: acc.id,
    suspense_account_id: suspense.id,
    company_id: 1,
  });
  return { db: j.db, journalId: j.id };
}

function setupStatements() {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const cash = makeCashJournal(db);
  db = cash.db;

  const now = today();
  const lastYearDate = shiftMonth(now, -14);

  // 1. Empty statement (no lines) in this month
  const emptyStmt = create(db, STMT, {
    name: 'BST3/EMPTY',
    journal_id: bankJournal.id,
    date: now,
    balance_start: 0,
    balance_end_real: 0,
  });
  db = emptyStmt.db;

  // 2. Complete & valid statement in this month (first on cash journal)
  const completeStmt = create(db, STMT, {
    name: 'BST3/COMPLETE',
    journal_id: cash.journalId,
    date: lastYearDate,
    balance_start: 0,
    balance_end_real: 100,
    line_ids: [{ date: lastYearDate, payment_ref: 'Opening receipt', amount: 100 }],
  });
  db = completeStmt.db;

  // 3. Invalid statement: balance_start (250) does not match previous statement's balance_end_real (100), though complete on lines
  const invalidGapStmt = create(db, STMT, {
    name: 'BST3/INVALID-GAP',
    journal_id: cash.journalId,
    date: now,
    balance_start: 250,
    balance_end_real: 300,
    line_ids: [{ date: now, payment_ref: 'Gap deposit', amount: 50 }],
  });
  db = invalidGapStmt.db;

  // 4. Incomplete statement: has lines, valid balance_start (300), but balance_end (340) !== balance_end_real (400)
  const incompleteStmt = create(db, STMT, {
    name: 'BST3/INCOMPLETE',
    journal_id: cash.journalId,
    date: now,
    balance_start: 300,
    balance_end_real: 400,
    line_ids: [{ date: now, payment_ref: 'Partial line', amount: 40 }],
  });
  db = incompleteStmt.db;

  const ids = [emptyStmt.id, completeStmt.id, invalidGapStmt.id, incompleteStmt.id];
  return {
    db,
    bankJournal,
    cashJournalId: cash.journalId,
    ids: {
      empty: emptyStmt.id,
      complete: completeStmt.id,
      invalidGap: invalidGapStmt.id,
      incomplete: incompleteStmt.id,
    },
    records: ids.map((id) => read(db, STMT, id)),
    rawRecords: (db.records[STMT] ?? []).filter((r) => ids.includes(r.id)),
  };
}

test('acct-bst3: Empty filter matches only statements without lines', () => {
  const { db, ids, records, rawRecords } = setupStatements();

  assert.deepEqual(
    applyFilters(STMT, records, ['empty'], db).map((r) => r.id),
    [ids.empty],
  );
  assert.deepEqual(
    applyFilters(STMT, rawRecords, ['empty'], db).map((r) => r.id),
    [ids.empty],
  );
});

test('acct-bst3: Invalid filter matches balance_start mismatch and incomplete statements', () => {
  const { db, ids, records, rawRecords } = setupStatements();

  assert.deepEqual(
    applyFilters(STMT, records, ['invalid'], db).map((r) => r.id),
    [ids.empty, ids.invalidGap, ids.incomplete],
  );
  assert.deepEqual(
    applyFilters(STMT, rawRecords, ['invalid'], db).map((r) => r.id),
    [ids.empty, ids.invalidGap, ids.incomplete],
  );
});

test('acct-bst3: statementListDecoration returns danger for invalid/incomplete, null for complete, and muted without journal', () => {
  const { db, ids, records, rawRecords } = setupStatements();
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  const rawById = Object.fromEntries(rawRecords.map((r) => [r.id, r]));

  assert.equal(statementListDecoration(byId[ids.complete], db), null);
  assert.equal(statementListDecoration(byId[ids.invalidGap], db), 'danger');
  assert.equal(statementListDecoration(byId[ids.incomplete], db), 'danger');
  assert.equal(statementListDecoration(byId[ids.empty], db), 'danger');

  // Also computes accurately from db when given raw (uncomputed) records
  assert.equal(statementListDecoration(rawById[ids.complete], db), null);
  assert.equal(statementListDecoration(rawById[ids.invalidGap], db), 'danger');
  assert.equal(statementListDecoration(rawById[ids.incomplete], db), 'danger');

  // Odoo 20 decoration-muted="not journal_id", while decoration-danger="... or not is_valid" still wins if invalid
  assert.equal(statementListDecoration({ id: 901, journal_id: null, is_complete: false, is_valid: true }, db), 'muted');
  assert.equal(statementListDecoration({ id: 902, journal_id: null, is_complete: true, is_valid: false }, db), 'danger');
});

test('acct-bst3: group-bys (Journal, Date) and Date filter exist and work', () => {
  const { db, ids, records } = setupStatements();
  const def = models[STMT];

  assert.deepEqual(def.groupBys, ['journal_id', 'date']);
  assert.deepEqual(def.searchFields, ['name', 'journal_id', 'date']);
  assert.deepEqual(
    def.filters.map((group) => group.map((f) => ({ id: f.id, label: f.label }))),
    [
      [
        { id: 'empty', label: 'Empty' },
        { id: 'invalid', label: 'Invalid' },
      ],
      [
        { id: 'date_month', label: 'Date: This Month' },
        { id: 'date_year', label: 'Date: This Year' },
      ],
    ],
  );

  // Date filters narrow by current month / year
  assert.deepEqual(
    applyFilters(STMT, records, ['date_month'], db).map((r) => r.id),
    [ids.empty, ids.invalidGap, ids.incomplete],
  );
  assert.deepEqual(
    applyFilters(STMT, records, ['date_year'], db).map((r) => r.id),
    [ids.empty, ids.invalidGap, ids.incomplete],
  );

  // Group by Journal and by Date
  const byJournal = groupRecords(db, STMT, records, 'journal_id');
  assert.equal(byJournal.length, 2);
  const byDate = groupRecords(db, STMT, records, 'date');
  assert.equal(byDate.length, 2);
});

test('acct-bst3: List view renders row decoration classes using db', () => {
  const { db, ids, rawRecords } = setupStatements();
  const rawById = Object.fromEntries(rawRecords.map((r) => [r.id, r]));

  // Raw records lack precomputed is_complete / is_valid, so List must pass db to listDecoration
  assert.equal(rawById[ids.complete].is_complete, undefined);
  assert.equal(rawById[ids.invalidGap].is_valid, undefined);

  const orderedRows = [
    rawById[ids.complete],
    rawById[ids.invalidGap],
    rawById[ids.incomplete],
    { id: 999, name: 'BST3/NO-JOURNAL', date: today(), journal_id: null, balance_start: 0, balance_end_real: 0, state: 'open' },
  ];

  const html = renderToStaticMarkup(createElement(List, {
    db,
    model: STMT,
    records: orderedRows,
    open: () => {},
    selected: new Set(),
    setSelected: () => {},
    groupBy: [],
  }));

  const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/)?.[0] ?? '';
  const rowClasses = [...tbody.matchAll(/<tr[^>]*class="([^"]*)"/g)]
    .map((m) => m[1].trim());
  assert.deepEqual(rowClasses, ['', 'danger', 'danger', 'muted']);
});

test('acct-bst3: searching statements by date or year-month matches the statement date', () => {
  const db = seed();
  const rec = { id: 99001, name: 'BNK1 Statement', date: '2026-03-14', journal_id: null };
  assert.ok(matches(db, 'account.bank.statement', rec, ['2026-03-14']));
  assert.ok(matches(db, 'account.bank.statement', rec, ['2026-03']));
  assert.ok(!matches(db, 'account.bank.statement', rec, ['2026-04']));
});
