import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { seed } from './seed.js';
import { applyFilters, create, groupRecords, matches, read, search } from './orm.js';
import { menusFor, models } from './models/index.js';
import { addDays, shiftMonth, today } from './models/common.js';
import { ensureBankSuspense } from './models/ledger.js';
import { createCompany } from './models/company.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const { List, visibleListColumns } = await import('./views/List.jsx');

const STMT = 'account.bank.statement';

const allFind = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) allFind(child, pred, acc);
  return acc;
};
const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, name) => String(classOf(node)).split(/\s+/).includes(name);

function statementsLeaf() {
  const accounting = menusFor('accounting').find((m) => m.label === 'Accounting');
  const tx = accounting.children.find((c) => c.label === 'Transactions');
  return tx.children.find((c) => c.key === 'statements');
}

function makeCashJournal(db, { code = 'CSH2', name = 'Petty Cash 2' } = {}) {
  const acc = create(db, 'account.account', { code: '101599', name: `${name} Account`, account_type: 'asset_cash', company_id: 1 });
  const suspense = ensureBankSuspense(acc.db, 1);
  const j = create(suspense.db, 'account.journal', { name, code, type: 'cash', default_account_id: acc.id, suspense_account_id: suspense.id, company_id: 1 });
  return { db: j.db, journalId: j.id };
}

test('account.bank.statement list decorations match Odoo 20 (danger when incomplete/invalid, muted without journal)', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const cash = makeCashJournal(db);
  db = cash.db;

  // 1. Complete & valid statement -> no decoration
  const okStmt = create(db, STMT, {
    name: 'STMT/OK',
    journal_id: bankJournal.id,
    date: today(),
    balance_start: 100,
    balance_end_real: 150,
    line_ids: [{ date: today(), payment_ref: 'Receipt', amount: 50 }],
  });
  db = okStmt.db;

  // 2. Incomplete statement (ending balance mismatch) -> danger
  const incompleteStmt = create(db, STMT, {
    name: 'STMT/INCOMPLETE',
    journal_id: bankJournal.id,
    date: addDays(today(), 1),
    balance_start: 150,
    balance_end_real: 300,
    line_ids: [{ date: addDays(today(), 1), payment_ref: 'Partial', amount: 50 }],
  });
  db = incompleteStmt.db;

  // 3. Invalid statement (opening balance does not match previous ending balance) -> danger even when complete
  const invalidStmt = create(db, STMT, {
    name: 'STMT/INVALID',
    journal_id: cash.journalId,
    date: addDays(today(), -5),
    balance_start: 0,
    balance_end_real: 40,
    line_ids: [{ date: addDays(today(), -5), payment_ref: 'Seed', amount: 40 }],
  });
  db = invalidStmt.db;
  const invalidNext = create(db, STMT, {
    name: 'STMT/INVALID-GAP',
    journal_id: cash.journalId,
    date: addDays(today(), -4),
    balance_start: 99,
    balance_end_real: 119,
    line_ids: [{ date: addDays(today(), -4), payment_ref: 'Gap', amount: 20 }],
  });
  db = invalidNext.db;

  const def = models[STMT];
  assert.equal(def.listDecoration(read(db, STMT, okStmt.id), db), null);
  assert.equal(def.listDecoration(read(db, STMT, incompleteStmt.id), db), 'danger');
  assert.equal(def.listDecoration(read(db, STMT, invalidStmt.id), db), null);
  assert.equal(def.listDecoration(read(db, STMT, invalidNext.id), db), 'danger');

  // Statement without journal_id (legacy/unlinked row) -> muted, unless invalid
  assert.equal(def.listDecoration({ id: 999, journal_id: null, is_complete: false, is_valid: true }, db), 'muted');
  assert.equal(def.listDecoration({ id: 999, journal_id: null, is_complete: false, is_valid: false }, db), 'danger');

  const renderedRows = [
    read(db, STMT, okStmt.id),
    read(db, STMT, incompleteStmt.id),
    read(db, STMT, invalidNext.id),
    { id: 999, name: 'STMT/NO-JOURNAL', date: today(), journal_id: null, balance_start: 0, balance_end: 0, balance_end_real: 0, state: 'open', is_complete: false, is_valid: true },
  ];
  const html = renderToStaticMarkup(createElement(List, {
    db, model: STMT, records: renderedRows, open: () => {}, selected: new Set(), setSelected: () => {}, groupBy: [],
  }));
  const rowClasses = [...html.matchAll(/<tr[^>]*class="([^"]*)"/g)].map((m) => m[1].trim());
  assert.deepEqual(rowClasses, ['', 'danger', 'danger', 'muted']);
});

test('account.bank.statement searchFields, Empty/Invalid filters, Date filters, and Journal/Date groupBys match Odoo 20', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const cash = makeCashJournal(db, { code: 'CSH3', name: 'Register Cash' });
  db = cash.db;

  const def = models[STMT];
  assert.deepEqual(def.searchFields, ['name', 'journal_id', 'date']);
  assert.deepEqual(def.groupBys, ['journal_id', 'date']);
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

  const now = today();
  const lastYearDate = shiftMonth(now, -14);

  // Empty & incomplete (no lines) in this month
  const emptyStmt = create(db, STMT, {
    name: 'STMT/EMPTY',
    journal_id: bankJournal.id,
    date: now,
    balance_start: 0,
    balance_end_real: 0,
  });
  db = emptyStmt.db;

  // Complete & valid statement in this month
  const validStmt = create(db, STMT, {
    name: 'STMT/VALID',
    journal_id: bankJournal.id,
    date: now,
    balance_start: 0,
    balance_end_real: 100,
    line_ids: [{ date: now, payment_ref: 'Deposit', amount: 100 }],
  });
  db = validStmt.db;

  // Invalid (balance_start mismatch) & complete, in a prior year on another journal
  const oldCashBase = create(db, STMT, {
    name: 'STMT/CASH-BASE',
    journal_id: cash.journalId,
    date: shiftMonth(lastYearDate, -1),
    balance_start: 0,
    balance_end_real: 50,
    line_ids: [{ date: shiftMonth(lastYearDate, -1), payment_ref: 'Base', amount: 50 }],
  });
  db = oldCashBase.db;

  const invalidOldStmt = create(db, STMT, {
    name: 'STMT/CASH-BAD',
    journal_id: cash.journalId,
    date: lastYearDate,
    balance_start: 10, // mismatch vs 50
    balance_end_real: 30,
    line_ids: [{ date: lastYearDate, payment_ref: 'Adj', amount: 20 }],
  });
  db = invalidOldStmt.db;

  // Incomplete (balance_end !== balance_end_real) with lines, in this month
  const incompleteStmt = create(db, STMT, {
    name: 'STMT/MISMATCH',
    journal_id: cash.journalId,
    date: now,
    balance_start: 30,
    balance_end_real: 999,
    line_ids: [{ date: now, payment_ref: 'Cash in', amount: 15 }],
  });
  db = incompleteStmt.db;

  const allStmts = [emptyStmt.id, validStmt.id, oldCashBase.id, invalidOldStmt.id, incompleteStmt.id].map((id) => read(db, STMT, id));

  // Search by statement name and journal name
  assert.deepEqual(allStmts.filter((r) => matches(db, STMT, r, ['STMT/VALID'])).map((r) => r.id), [validStmt.id]);
  assert.deepEqual(allStmts.filter((r) => matches(db, STMT, r, ['Register Cash'])).map((r) => r.id), [oldCashBase.id, invalidOldStmt.id, incompleteStmt.id]);

  // Empty filter: only statements with no lines (works on computed and raw records)
  assert.deepEqual(applyFilters(STMT, allStmts, ['empty'], db).map((r) => r.id), [emptyStmt.id]);
  const rawStmts = allStmts.map(({ line_ids: _l, is_complete: _c, is_valid: _v, ...raw }) => raw);
  assert.deepEqual(applyFilters(STMT, rawStmts, ['empty'], db).map((r) => r.id), [emptyStmt.id]);

  // Invalid filter: !is_valid || !is_complete
  assert.deepEqual(
    applyFilters(STMT, allStmts, ['invalid'], db).map((r) => r.id),
    [emptyStmt.id, invalidOldStmt.id, incompleteStmt.id],
  );
  assert.deepEqual(
    applyFilters(STMT, rawStmts, ['invalid'], db).map((r) => r.id),
    [emptyStmt.id, invalidOldStmt.id, incompleteStmt.id],
  );

  // Empty OR Invalid (same group), ANDed with Date: This Month / This Year (separate group)
  assert.deepEqual(
    applyFilters(STMT, allStmts, ['empty', 'invalid'], db).map((r) => r.id),
    [emptyStmt.id, invalidOldStmt.id, incompleteStmt.id],
  );
  assert.deepEqual(
    applyFilters(STMT, allStmts, ['empty', 'date_month'], db).map((r) => r.id),
    [emptyStmt.id],
  );
  assert.deepEqual(
    applyFilters(STMT, allStmts, ['invalid', 'date_year'], db).map((r) => r.id),
    [emptyStmt.id, incompleteStmt.id],
  );

  // Group by Journal and Date
  const byJournal = groupRecords(db, STMT, allStmts, 'journal_id');
  assert.equal(byJournal.length, 2);
  const byDate = groupRecords(db, STMT, allStmts, 'date');
  assert.ok(byDate.length >= 2);
});

test('Bank Statements ActionView UI renders SearchPanel filters, group-bys, and row decorations', async () => {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS ??= (_, tag) => makeEl(tag);
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');

  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const sOk = create(db, STMT, {
    name: 'UI-OK',
    journal_id: bankJournal.id,
    date: today(),
    balance_start: 0,
    balance_end_real: 100,
    line_ids: [{ date: today(), payment_ref: 'Good', amount: 100 }],
  });
  db = sOk.db;
  const sEmpty = create(db, STMT, {
    name: 'UI-EMPTY',
    journal_id: bankJournal.id,
    date: today(),
    balance_start: 100,
    balance_end_real: 100,
  });
  db = sEmpty.db;

  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(React.createElement(ActionView, {
        leaf: statementsLeaf(),
        base: '#/accounting/statements',
        params: new URLSearchParams('view=list'),
      }));
    });

    const toggleBtn = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    assert.ok(toggleBtn);
    await act(async () => props(toggleBtn).onClick());

    const panelButtons = allFind(host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-pressed'] !== undefined);
    const labels = panelButtons.map((b) => b.textContent.trim());
    for (const expected of ['Empty', 'Invalid', 'Date: This Month', 'Date: This Year', 'Journal', 'Date']) {
      assert.ok(labels.includes(expected), `SearchPanel shows ${expected}`);
    }

    // Empty row is decorated danger (incomplete) and filtering by Empty narrows to UI-EMPTY
    const rowsBefore = allFind(find(host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');
    assert.equal(rowsBefore.length, 2);
    assert.ok(rowsBefore.some((tr) => hasClass(tr, 'danger') && tr.textContent.includes('UI-EMPTY')));

    const emptyBtn = panelButtons.find((b) => b.textContent.trim() === 'Empty');
    await act(async () => props(emptyBtn).onClick());
    const rowsAfter = allFind(find(host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');
    assert.equal(rowsAfter.length, 1);
    assert.ok(rowsAfter[0].textContent.includes('UI-EMPTY'));

    // Toggle Journal group-by
    const journalGroupBtn = allFind(host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Journal')[0];
    await act(async () => props(journalGroupBtn).onClick());
    const groupRows = allFind(find(host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR' && hasClass(n, 'group-row'));
    assert.equal(groupRows.length, 1);
    assert.ok(groupRows[0].textContent.includes(bankJournal.name));
  } finally {
    await act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
});

test('Bank Statements search/filter/group labels have Arabic translations and no duplicate i18n keys', async () => {
  const prevLang = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  try {
    const { t } = await import(`./i18n.js?bank-stmt-ar=${Date.now()}`);
    for (const key of ['Empty', 'Invalid', 'Date: This Month', 'Date: This Year', 'Journal', 'Date', 'Problem Description', 'Initial balance ({amount}) does not match previous statement', 'Incorrect ending balance, expected {amount}']) {
      assert.notEqual(t(key), key, `Arabic translation exists for "${key}"`);
    }
  } finally {
    globalThis.localStorage = prevLang;
  }

  const content = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  const arBlock = content.match(/const ar = \{([\s\S]*?)\n\};/);
  assert.ok(arBlock);
  const keyMatches = [...arBlock[1].matchAll(/(?:^|[,{])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))\s*:/gm)];
  const seen = new Set();
  const dups = [];
  for (const m of keyMatches) {
    const k = m[1] ?? m[2] ?? m[3];
    if (seen.has(k)) dups.push(k);
    seen.add(k);
  }
  assert.deepEqual(dups, [], 'No duplicate keys in src/i18n.js');
});

test('account.bank.statement list columns match Odoo 20 view_bank_statement_tree (single-company vs multi-company)', () => {
  const db = seed();
  const def = models[STMT];

  assert.deepEqual(def.list, ['name', 'date', 'journal_id', 'company_id', 'balance_start', 'balance_end_real']);
  assert.equal(def.fields.company_id.multiCompanyOnly, true);

  // Single-company hides company_id (Odoo groups="base.group_multi_company"), and omits column_invisible balance_end / state
  const single = visibleListColumns(def, db, {});
  assert.deepEqual(single.cols, ['name', 'date', 'journal_id', 'balance_start', 'balance_end_real']);
  assert.deepEqual(single.optionalCols, []);

  const singleHtml = renderToStaticMarkup(createElement(List, {
    db, model: STMT, records: [], open: () => {}, selected: new Set(), setSelected: () => {}, groupBy: [],
  }));
  const singleHeaders = [...singleHtml.matchAll(/<th[^>]*>(?:<button[^>]*>)?([^<]+)/g)].map((m) => m[1].trim()).filter(Boolean);
  assert.deepEqual(singleHeaders, ['Reference', 'Date', 'Journal', 'Starting Balance', 'Ending Balance']);

  // Multi-company includes company_id between journal_id and balance_start
  const multiDb = createCompany(db, { name: 'Branch Co', currency_code: 'USD' }).db;
  const multi = visibleListColumns(def, multiDb, {});
  assert.deepEqual(multi.cols, ['name', 'date', 'journal_id', 'company_id', 'balance_start', 'balance_end_real']);
  assert.deepEqual(multi.optionalCols, []);

  const multiHtml = renderToStaticMarkup(createElement(List, {
    db: multiDb, model: STMT, records: [], open: () => {}, selected: new Set(), setSelected: () => {}, groupBy: [],
  }));
  const multiHeaders = [...multiHtml.matchAll(/<th[^>]*>(?:<button[^>]*>)?([^<]+)/g)].map((m) => m[1].trim()).filter(Boolean);
  assert.deepEqual(multiHeaders, ['Reference', 'Date', 'Journal', 'Company', 'Starting Balance', 'Ending Balance']);
});

test('account.bank.statement problem_description matches Odoo 20 _compute_problem_description', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  const firstOk = create(db, STMT, {
    name: 'PD/001',
    journal_id: bankJournal.id,
    date: '2026-04-01',
    balance_start: 100,
    balance_end_real: 150,
    line_ids: [{ date: '2026-04-01', payment_ref: 'Inflow', amount: 50 }],
  });
  db = firstOk.db;
  assert.equal(read(db, STMT, firstOk.id).problem_description, null);

  // Invalid (initial balance 200 !== 150) AND incomplete (200 + 25 = 225 !== 300): invalid wins per Odoo elif
  const bothBad = create(db, STMT, {
    name: 'PD/002',
    journal_id: bankJournal.id,
    date: '2026-04-02',
    balance_start: 200,
    balance_end_real: 300,
    line_ids: [{ date: '2026-04-02', payment_ref: 'Part', amount: 25 }],
  });
  db = bothBad.db;
  assert.match(
    read(db, STMT, bothBad.id).problem_description ?? '',
    /^Initial balance \(.*200\.00\) does not match previous statement$/,
  );

  // Valid initial balance (300 === previous 300), but incomplete (300 + 40 = 340 !== 400)
  const incompleteOnly = create(db, STMT, {
    name: 'PD/003',
    journal_id: bankJournal.id,
    date: '2026-04-03',
    balance_start: 300,
    balance_end_real: 400,
    line_ids: [{ date: '2026-04-03', payment_ref: 'Deposit', amount: 40 }],
  });
  db = incompleteOnly.db;
  assert.match(
    read(db, STMT, incompleteOnly.id).problem_description ?? '',
    /^Incorrect ending balance, expected .*340\.00$/,
  );
});

test('account.bank.statement read and search do not repeat validity scans for problem_description', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  const s1 = create(db, STMT, {
    name: 'SCAN/001',
    journal_id: bankJournal.id,
    date: '2026-04-01',
    balance_start: 100,
    balance_end_real: 150,
    line_ids: [{ date: '2026-04-01', payment_ref: 'Inflow', amount: 50 }],
  });
  db = s1.db;

  const s2 = create(db, STMT, {
    name: 'SCAN/002',
    journal_id: bankJournal.id,
    date: '2026-04-02',
    balance_start: 200,
    balance_end_real: 300,
    line_ids: [{ date: '2026-04-02', payment_ref: 'Part', amount: 25 }],
  });
  db = s2.db;

  const s3 = create(db, STMT, {
    name: 'SCAN/003',
    journal_id: bankJournal.id,
    date: '2026-04-03',
    balance_start: 300,
    balance_end_real: 400,
    line_ids: [{ date: '2026-04-03', payment_ref: 'Deposit', amount: 40 }],
  });
  db = s3.db;

  let statementScans = 0;
  const countedDb = {
    ...db,
    records: new Proxy(db.records, {
      get(target, prop, receiver) {
        if (prop === STMT) statementScans += 1;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };

  statementScans = 0;
  const readInvalid = read(countedDb, STMT, s2.id);
  // 1 lookup + 1 linesByStatement/computeRunningBalance cache population + 1 computeIsValid scan (not 2)
  assert.equal(statementScans, 3, 'cold read() should not run a second validity scan for problem_description');
  assert.equal(readInvalid.is_valid, false);
  assert.equal(readInvalid.is_complete, false);
  assert.match(readInvalid.problem_description ?? '', /^Initial balance \(.*200\.00\) does not match previous statement$/);

  statementScans = 0;
  const readIncomplete = read(countedDb, STMT, s3.id);
  // With linesByStatement cached on countedDb: 1 lookup + 1 computeIsValid scan (not 2)
  assert.equal(statementScans, 2, 'read() on valid-but-incomplete statement should not repeat validity scan');
  assert.equal(readIncomplete.is_valid, true);
  assert.equal(readIncomplete.is_complete, false);
  assert.match(readIncomplete.problem_description ?? '', /^Incorrect ending balance, expected .*340\.00$/);

  const totalStatements = db.records[STMT].length;
  statementScans = 0;
  const all = search(countedDb, STMT);
  assert.equal(statementScans, 1 + totalStatements, 'search() should scan once per statement for is_valid, not twice');
  const byId = Object.fromEntries(all.map((s) => [s.id, s]));
  assert.equal(byId[s1.id].is_valid, true);
  assert.equal(byId[s1.id].is_complete, true);
  assert.equal(byId[s1.id].problem_description, null);
  assert.equal(byId[s2.id].is_valid, false);
  assert.equal(byId[s2.id].is_complete, false);
  assert.match(byId[s2.id].problem_description ?? '', /^Initial balance/);
  assert.equal(byId[s3.id].is_valid, true);
  assert.equal(byId[s3.id].is_complete, false);
  assert.match(byId[s3.id].problem_description ?? '', /^Incorrect ending balance/);

  // Materialized is_valid / is_complete prevents any statement table scan inside computeProblemDescription
  const computePD = models[STMT].fields.problem_description.compute;
  const noStatementScanDb = {
    ...countedDb,
    records: new Proxy(db.records, {
      get(target, prop, receiver) {
        if (prop === STMT) throw new Error('Unexpected statement scan in computeProblemDescription');
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
  assert.match(
    computePD({ ...byId[s2.id] }, noStatementScanDb) ?? '',
    /^Initial balance \(.*200\.00\) does not match previous statement$/,
  );
  assert.match(
    computePD({ ...byId[s3.id] }, noStatementScanDb) ?? '',
    /^Incorrect ending balance, expected .*340\.00$/,
  );

  // Fallback for raw saved records and unsaved draft records without precomputed is_valid / is_complete
  const rawS2 = db.records[STMT].find((s) => s.id === s2.id);
  assert.equal(rawS2.is_valid, undefined);
  assert.match(computePD(rawS2, db) ?? '', /^Initial balance \(.*200\.00\) does not match previous statement$/);
  const unsavedInvalid = {
    journal_id: bankJournal.id,
    date: '2026-04-04',
    balance_start: 999,
    balance_end_real: 1000,
    line_ids: [{ date: '2026-04-04', payment_ref: 'Draft', amount: 1 }],
  };
  assert.match(computePD(unsavedInvalid, db) ?? '', /^Initial balance \(.*999\.00\) does not match previous statement$/);
  const unsavedIncomplete = {
    journal_id: bankJournal.id,
    date: '2026-04-04',
    balance_start: 400,
    balance_end_real: 500,
    line_ids: [{ date: '2026-04-04', payment_ref: 'Draft', amount: 25 }],
  };
  assert.match(computePD(unsavedIncomplete, db) ?? '', /^Incorrect ending balance, expected .*425\.00$/);
});
