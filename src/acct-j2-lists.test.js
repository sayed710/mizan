import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { journalEntriesView } from './models/accounting.js';
import { postEntry } from './models/ledger.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node && node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classNameOf = (node) => props(node)?.className ?? node?.className ?? '';

function findAll(node, predicate, out = []) {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) {
    findAll(child, predicate, out);
  }
  return out;
}

function miscJournal(db, companyId = 1) {
  return search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === companyId));
}

function arAccount(db, companyId = 1) {
  return read(db, 'res.company', companyId)?.account_default_receivable_id ?? search(db, 'account.account').find((a) => a.account_type === 'asset_receivable')?.id;
}

function revAccount(db) {
  return search(db, 'account.account').find((a) => a.account_type === 'income')?.id;
}

test('to_check boolean on account.move, form layout, server guards, and list filters', async () => {
  // 1. Field definition
  const field = models['account.move'].fields.to_check;
  assert.ok(field, 'account.move.fields.to_check must exist');
  assert.equal(field.type, 'boolean');
  assert.equal(field.label, 'To Check');

  // 2. Form layout for journal entry (move_type: entry)
  const entryFormTabs = models['account.move'].form.tabs({ move_type: 'entry' });
  const otherInfoTab = entryFormTabs.find((tab) => tab.label === 'Other Info');
  assert.ok(otherInfoTab, 'Entry form must have an Other Info tab');
  const allFieldNames = otherInfoTab.groups.flatMap((g) => (Array.isArray(g) ? g : (g.fields ?? []))).map((f) => (typeof f === 'string' ? f : f.field));
  assert.ok(allFieldNames.includes('to_check'), 'to_check must be in entry form Other Info tab');

  // 3. Persistence and server diff guard
  let db = seed();
  const misc = miscJournal(db, 1);
  const ar = arAccount(db, 1);
  const rev = revAccount(db);
  const moveRes = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: misc.id,
    date: '2026-05-01',
    to_check: true,
    line_ids: [
      { account_id: ar, debit: 100 },
      { account_id: rev, credit: 100 },
    ],
  });
  db = moveRes.db;
  const moveId = moveRes.id;
  assert.equal(read(db, 'account.move', moveId).to_check, true);

  // Server diff roundtrip
  const modDb = write(db, 'account.move', moveId, { to_check: false });
  const diff = diffDb(db, modDb);
  const syncedDb = applyDiff(db, diff);
  assert.equal(read(syncedDb, 'account.move', moveId).to_check, false);

  // 4. Journal Entries list filter
  const entryFilterGroup = journalEntriesView.filters.find((g) => g.some((f) => f.id === 'to_check'));
  assert.ok(entryFilterGroup, 'journalEntriesView must have a filter group with to_check');
  const entryToCheck = entryFilterGroup.find((f) => f.id === 'to_check');
  assert.equal(entryToCheck.label, 'To Check');
  assert.equal(entryToCheck.fn({ to_check: true }), true);
  assert.equal(entryToCheck.fn({ to_check: false }), false);
  assert.equal(entryToCheck.fn({}), false);

  // 5. Journal Items list filter via UI
  const { makeEl } = setupDom();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();

  // Post entry 1 with to_check: true
  const posted1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-05-01', ref: 'CHECK-YES',
    lines: [{ account_id: ar, debit: 50 }, { account_id: rev, credit: 50 }],
  });
  db = write(posted1.db, 'account.move', posted1.id, { to_check: true });

  // Post entry 2 with to_check: false
  const posted2 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-05-01', ref: 'CHECK-NO',
    lines: [{ account_id: ar, debit: 75 }, { account_id: rev, credit: 75 }],
  });
  db = posted2.db;

  const root = createRoot(host);
  try {
    await React.act(async () => {
      await commit(db);
      root.render(React.createElement(JournalItems));
    });

    // Check filter button exists
    const toCheckBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'To Check');
    assert.ok(toCheckBtn, 'JournalItems must render To Check filter button');
    assert.equal(props(toCheckBtn)['aria-pressed'], false);

    // Initial rows show all posted items (4 items: 2 from move1, 2 from move2)
    const getVisibleRefs = () => findAll(host, (n) => n.tagName === 'TR' && !n.className?.includes('group-row'))
      .map((tr) => tr.textContent)
      .filter((txt) => txt.includes('CHECK-'));
    assert.equal(getVisibleRefs().length, 4);

    // Click To Check filter button
    await React.act(async () => props(toCheckBtn).onClick());
    assert.equal(props(toCheckBtn)['aria-pressed'], true);

    // After filtering: only lines from CHECK-YES are visible
    const filteredRefs = getVisibleRefs();
    assert.equal(filteredRefs.length, 2);
    assert.ok(filteredRefs.every((txt) => txt.includes('CHECK-YES')));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Journal Entries list positive Recurring filter next to Manual filter', async () => {
  // Find group containing 'manual'
  const manualGroup = journalEntriesView.filters.find((g) => g.some((f) => f.id === 'manual'));
  assert.ok(manualGroup, 'journalEntriesView must have a filter group containing manual');

  const manualIdx = manualGroup.findIndex((f) => f.id === 'manual');
  const recurringIdx = manualGroup.findIndex((f) => f.id === 'recurring');
  assert.ok(recurringIdx >= 0, 'Recurring filter must exist in the same group as manual');
  assert.ok(Math.abs(recurringIdx - manualIdx) === 1, 'Recurring filter must be next to manual');

  const recurring = manualGroup[recurringIdx];
  const manual = manualGroup[manualIdx];
  assert.equal(recurring.label, 'Recurring');

  // Verify Arabic translation for Recurring
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t: tAr } = await import(`./i18n.js?lang=ar-j2=${Date.now()}`);
    assert.equal(tAr('Recurring'), 'متكرر', 'Recurring must translate to Arabic متكرر');
  } finally {
    globalThis.localStorage = prevStorage;
  }

  // Test active recurrence frequencies
  for (const freq of ['monthly', 'quarterly', 'yearly']) {
    const move = { auto_post: freq };
    assert.equal(recurring.fn(move), true, `${freq} must match Recurring`);
    assert.equal(manual.fn(move), false, `${freq} must NOT match Manual`);
  }

  // Test generated from recurrence (auto_post_origin_id)
  const generatedMove = { auto_post: 'no', auto_post_origin_id: 100 };
  assert.equal(recurring.fn(generatedMove), true, 'Move with auto_post_origin_id must match Recurring');
  assert.equal(manual.fn(generatedMove), false, 'Move with auto_post_origin_id must NOT match Manual');

  // Test one-off auto_post at_date (not recurring)
  const atDateMove = { auto_post: 'at_date' };
  assert.equal(recurring.fn(atDateMove), false, 'at_date must NOT match Recurring');
  assert.equal(manual.fn(atDateMove), false, 'at_date is auto_post so not manual');

  // Test standard manual move
  const manualMove = { auto_post: 'no' };
  assert.equal(recurring.fn(manualMove), false, 'Manual move must NOT match Recurring');
  assert.equal(manual.fn(manualMove), true, 'Manual move must match Manual');

  const defaultMove = {};
  assert.equal(recurring.fn(defaultMove), false, 'Default move must NOT match Recurring');
  assert.equal(manual.fn(defaultMove), true, 'Default move must match Manual');
});

test('Journal Items Status column, Group By, and header Select-all checkbox', async () => {
  const { makeEl } = setupDom();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();

  let db = seed();
  const misc = miscJournal(db, 1);
  const ar = arAccount(db, 1);
  const rev = revAccount(db);

  // Posted entry
  const p = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-06-01', ref: 'P1',
    lines: [{ account_id: ar, debit: 120 }, { account_id: rev, credit: 120 }],
  });
  db = p.db;

  // Enable optional 'status' column in localStorage
  globalThis.localStorage = {
    _data: { 'mizan-report-cols:journalItems': JSON.stringify({ status: true }) },
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); },
  };

  const root = createRoot(host);
  try {
    await React.act(async () => {
      await commit(db);
      root.render(React.createElement(JournalItems));
    });

    // 1. Status Column and Badges
    const statusTh = find(host, (n) => n.tagName === 'TH' && n.textContent === 'Status');
    assert.ok(statusTh, 'Status column header must be visible when enabled');

    const badges = findAll(host, (n) => n.tagName === 'SPAN' && classNameOf(n).includes('badge') && n.textContent === 'Posted');
    assert.ok(badges.length >= 2, 'Visible rows must display Posted status badge');
    assert.ok(classNameOf(badges[0]).includes('badge-success'), 'Posted status badge must have badge-success class');

    // 2. Group By Options
    const groupBySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Group By');
    assert.ok(groupBySelect, 'Group By select must exist');
    const optionValues = groupBySelect.options.map((opt) => opt.value || props(opt)?.value);
    assert.ok(optionValues.includes('company'), 'Group By must include company');
    assert.ok(optionValues.includes('status'), 'Group By must include status');

    // Test grouping by company
    await React.act(async () => props(groupBySelect).onChange({ target: { value: 'company' } }));
    const companyGroupRows = findAll(host, (n) => n.tagName === 'TR' && classNameOf(n).includes('group-row'));
    assert.ok(companyGroupRows.length >= 1, 'Grouping by company must create group rows');
    const mainCoName = read(db, 'res.company', 1)?.name ?? 'Mizan Demo Co';
    assert.ok(companyGroupRows[0].textContent.includes(mainCoName), `Group row must display company name (${mainCoName})`);

    // Test grouping by status
    await React.act(async () => props(groupBySelect).onChange({ target: { value: 'status' } }));
    const statusGroupRows = findAll(host, (n) => n.tagName === 'TR' && classNameOf(n).includes('group-row'));
    assert.ok(statusGroupRows.length >= 1, 'Grouping by status must create group rows');
    assert.ok(statusGroupRows[0].textContent.includes('Posted'), 'Group row must display status title');

    // Reset Group By
    await React.act(async () => props(groupBySelect).onChange({ target: { value: '' } }));

    // 3. Header Select-all checkbox
    const theadTh = find(host, (n) => n.tagName === 'THEAD');
    const headerCb = find(theadTh, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === 'Select all');
    assert.ok(headerCb, 'Header must have a Select all checkbox input');
    assert.equal(props(headerCb).checked, false, 'Initial select-all state must be false');

    const countSpan = () => find(host, (n) => n.tagName === 'SPAN' && n.textContent?.includes('selected'));
    assert.equal(countSpan().textContent, '0 selected');

    const selectableRowCbs = findAll(host, (n) => n.tagName === 'TBODY')
      .flatMap((tbody) => findAll(tbody, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && !props(n)?.disabled));
    assert.ok(selectableRowCbs.length >= 2, 'There must be selectable rows in the table');

    // Click select-all checkbox
    await React.act(async () => props(headerCb).onChange({ target: { checked: true } }));
    assert.equal(countSpan().textContent, `${selectableRowCbs.length} selected`);
    assert.equal(props(headerCb).checked, true, 'Header checkbox must be checked when all visible rows are selected');

    // Check all selectable row checkboxes are checked
    assert.ok(selectableRowCbs.every((cb) => props(cb).checked === true), 'All selectable row checkboxes must be checked');

    // Uncheck select-all checkbox
    await React.act(async () => props(headerCb).onChange({ target: { checked: false } }));
    assert.equal(countSpan().textContent, '0 selected');
    assert.equal(props(headerCb).checked, false, 'Header checkbox must be unchecked after unselecting');
    assert.ok(selectableRowCbs.every((cb) => props(cb).checked === false), 'All row checkboxes must be unchecked');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('a posted entry can be flagged and cleared To Check by a non-admin, and the flag is never copied', async () => {
  const { duplicateValues } = await import('./duplicate.js');
  const { postAutoPostMoves } = await import('./models/accounting.js');
  const base = seed();
  const posted = postEntry(base, { journal: 'MISC', company: 1, date: '2026-01-15', lines: [{ account: '101401', debit: 10 }, { account: '400000', credit: 10 }] });
  assert.ok(models['account.move'].form.unlockedFields.includes('to_check'));

  const flagged = write(posted.db, 'account.move', posted.id, { to_check: true });
  const synced = applyDiff(posted.db, diffDb(posted.db, flagged));
  assert.equal(read(synced, 'account.move', posted.id).to_check, true);
  const cleared = write(synced, 'account.move', posted.id, { to_check: false });
  assert.equal(read(applyDiff(synced, diffDb(synced, cleared)), 'account.move', posted.id).to_check, false);

  assert.equal(duplicateValues('account.move', read(flagged, 'account.move', posted.id), flagged).to_check, undefined);

  const draft = create(base, 'account.move', { move_type: 'entry', date: '2026-01-15', auto_post: 'monthly', to_check: true, line_ids: [{ account_id: search(base, 'account.account').find((a) => a.code === '101401').id, debit: 10 }, { account_id: search(base, 'account.account').find((a) => a.code === '400000').id, credit: 10 }] });
  const ran = postAutoPostMoves(draft.db, '2026-01-15');
  const next = search(ran, 'account.move').find((m) => m.auto_post_origin_id === draft.id && m.id !== draft.id);
  assert.ok(next, 'the next recurring draft is generated');
  assert.ok(!next.to_check, 'the next recurring draft starts without the review flag');
});
