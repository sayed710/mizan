import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { journalEntriesView, reverseEntries } from './models/accounting.js';
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

// ---------------------------------------------------------------------------
// JE-19: Journal Entries recurring filter domain and Arabic translation
// ---------------------------------------------------------------------------
test('JE-19: journalEntriesView recurring filter domain matches recurring templates and generated entries', async () => {
  const manualGroup = journalEntriesView.filters.find((g) => g.some((f) => f.id === 'manual'));
  assert.ok(manualGroup, 'journalEntriesView must have a filter group containing manual');

  const manualIdx = manualGroup.findIndex((f) => f.id === 'manual');
  const recurringIdx = manualGroup.findIndex((f) => f.id === 'recurring');
  assert.ok(recurringIdx >= 0, 'Recurring filter must exist in the same group as manual');
  assert.equal(Math.abs(recurringIdx - manualIdx), 1, 'Recurring filter must be next to manual');

  const recurring = manualGroup[recurringIdx];
  const manual = manualGroup[manualIdx];
  assert.equal(recurring.label, 'Recurring');

  // Verify explicit fields for recurring templates
  for (const freq of ['monthly', 'quarterly', 'yearly']) {
    const templateMove = { auto_post: freq };
    assert.equal(recurring.fn(templateMove), true, `${freq} template must match Recurring filter`);
    assert.equal(manual.fn(templateMove), false, `${freq} template must NOT match Manual filter`);
  }

  // Verify explicit fields for generated entries from a recurring schedule
  const generatedMove = { auto_post: 'no', auto_post_origin_id: 42 };
  assert.equal(recurring.fn(generatedMove), true, 'Move with auto_post_origin_id must match Recurring filter');
  assert.equal(manual.fn(generatedMove), false, 'Move with auto_post_origin_id must NOT match Manual filter');

  // One-off auto_post at_date is not recurring
  const atDateMove = { auto_post: 'at_date' };
  assert.equal(recurring.fn(atDateMove), false, 'at_date move must NOT match Recurring filter');

  // Standard manual moves are not recurring
  const manualMove = { auto_post: 'no' };
  assert.equal(recurring.fn(manualMove), false, 'Manual move must NOT match Recurring filter');
  assert.equal(manual.fn(manualMove), true, 'Manual move must match Manual filter');

  const defaultMove = {};
  assert.equal(recurring.fn(defaultMove), false, 'Default move must NOT match Recurring filter');
  assert.equal(manual.fn(defaultMove), true, 'Default move must match Manual filter');

  // Verify Arabic translation for Recurring
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t: tAr } = await import(`./i18n.js?lang=ar-u1-rec=${Date.now()}`);
    assert.equal(tAr('Recurring'), 'متكرر', 'Recurring must translate to Arabic متكرر');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

// ---------------------------------------------------------------------------
// JE-20: Batch reversal action on journalEntriesView and reverseEntries helper
// ---------------------------------------------------------------------------
test('JE-20: journalEntriesView defines Reverse Entries listAction with wizard and runner', () => {
  assert.ok(journalEntriesView.listActions, 'journalEntriesView must define listActions');
  const action = journalEntriesView.listActions.find((a) => a.label === 'Reverse Entries');
  assert.ok(action, 'journalEntriesView must have a Reverse Entries listAction');
  assert.equal(typeof action.wizard, 'function', 'Reverse Entries action must expose a wizard function');
  assert.equal(typeof action.run, 'function', 'Reverse Entries action must expose a run function');

  const db = seed();
  const spec = action.wizard(db, [1, 2]);
  assert.equal(spec.title, 'Reverse Entries', 'Wizard title must be Reverse Entries');
  const fieldNames = spec.fields.map((f) => f.name);
  assert.ok(fieldNames.includes('date'), 'Wizard must include date field');
  assert.ok(fieldNames.includes('journal_id'), 'Wizard must include journal_id field');
  assert.ok(fieldNames.includes('mode'), 'Wizard must include mode field');
  assert.ok(fieldNames.includes('reason'), 'Wizard must include reason field');
});

test('JE-20: reverseEntries helper batch reverses selected posted entries and creates one reversal per entry', () => {
  let db = seed();
  const misc = miscJournal(db, 1);
  const ar = arAccount(db, 1);
  const rev = revAccount(db);

  // Create three posted entries
  const p1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-05-01', ref: 'BATCH-1',
    lines: [{ account_id: ar, debit: 100 }, { account_id: rev, credit: 100 }],
  });
  const p2 = postEntry(p1.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-05-02', ref: 'BATCH-2',
    lines: [{ account_id: ar, debit: 200 }, { account_id: rev, credit: 200 }],
  });
  const p3 = postEntry(p2.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-05-03', ref: 'BATCH-3',
    lines: [{ account_id: ar, debit: 300 }, { account_id: rev, credit: 300 }],
  });
  db = p3.db;

  // Batch reverse only p1 and p2
  const res = reverseEntries(db, [p1.id, p2.id], { date: '2026-05-10', reason: 'Batch reversal correction' });
  const updatedDb = res.db;

  // Verify p1 has its reversal
  const rev1 = search(updatedDb, 'account.move').find((m) => m.reversed_entry_id === p1.id);
  assert.ok(rev1, 'Reversal entry for p1 must exist');
  assert.equal(rev1.state, 'posted');
  assert.equal(rev1.invoice_date, '2026-05-10');
  assert.ok(rev1.ref.includes('Batch reversal correction'), 'Reversal ref must include reason');
  assert.equal(read(updatedDb, 'account.move', p1.id).reversal_move_id, rev1.id);

  // Verify p2 has its reversal
  const rev2 = search(updatedDb, 'account.move').find((m) => m.reversed_entry_id === p2.id);
  assert.ok(rev2, 'Reversal entry for p2 must exist');
  assert.equal(rev2.state, 'posted');
  assert.equal(rev2.invoice_date, '2026-05-10');
  assert.ok(rev2.ref.includes('Batch reversal correction'), 'Reversal ref must include reason');
  assert.equal(read(updatedDb, 'account.move', p2.id).reversal_move_id, rev2.id);

  // Verify p3 was NOT reversed
  const rev3 = search(updatedDb, 'account.move').find((m) => m.reversed_entry_id === p3.id);
  assert.equal(rev3, undefined, 'Unselected entry p3 must NOT be reversed');

  // Verify returned ids
  assert.equal(res.ids.length, 2);
  assert.ok(res.ids.includes(rev1.id));
  assert.ok(res.ids.includes(rev2.id));
});

test('JE-20: reverseEntries refuses drafts and already reversed entries through existing reversal guards', () => {
  let db = seed();
  const misc = miscJournal(db, 1);
  const ar = arAccount(db, 1);
  const rev = revAccount(db);

  // 1. Posted entry
  const posted = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-05-01', ref: 'POSTED',
    lines: [{ account_id: ar, debit: 50 }, { account_id: rev, credit: 50 }],
  });
  db = posted.db;

  // 2. Draft entry
  const draftRes = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: misc.id,
    date: '2026-05-01',
    line_ids: [{ account_id: ar, debit: 60 }, { account_id: rev, credit: 60 }],
  });
  db = draftRes.db;
  const draftId = draftRes.id;

  // Refusal: selecting a draft entry must throw the standard guard message
  assert.throws(
    () => reverseEntries(db, [posted.id, draftId], { date: '2026-05-10' }),
    /A posted entry and valid reversal date are required/,
    'Selecting draft entry must be refused with single-reversal guard message'
  );

  // Reverse the posted entry once
  const singleReversed = reverseEntries(db, [posted.id], { date: '2026-05-10' });
  db = singleReversed.db;

  // Refusal: selecting an already reversed entry must throw the standard guard message
  assert.throws(
    () => reverseEntries(db, [posted.id], { date: '2026-05-11' }),
    /This entry has already been reversed/,
    'Selecting already reversed entry must be refused with single-reversal guard message'
  );
});

test('JE-20: Reverse Entries UI wizard via ActionView and Arabic translation', async () => {
  const { makeEl } = setupDom();
  const makeDocEl = (tag) => {
    const el = makeEl(tag);
    el.ownerDocument = globalThis.document;
    return el;
  };
  globalThis.document.createElement = makeDocEl;
  globalThis.document.createElementNS = (_ns, tag) => makeDocEl(tag);
  const host = makeDocEl('div');
  host.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  await initStore();

  let db = seed();
  const misc = miscJournal(db, 1);
  const ar = arAccount(db, 1);
  const rev = revAccount(db);

  const p1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-05-01', ref: 'UI-REV-1',
    lines: [{ account_id: ar, debit: 80 }, { account_id: rev, credit: 80 }],
  });
  const p2 = postEntry(p1.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-05-02', ref: 'UI-REV-2',
    lines: [{ account_id: ar, debit: 90 }, { account_id: rev, credit: 90 }],
  });
  db = p2.db;

  const m1 = read(db, 'account.move', p1.id);
  const m2 = read(db, 'account.move', p2.id);

  const root = createRoot(host);
  try {
    await React.act(async () => {
      await commit(db);
      root.render(React.createElement(ActionView, {
        leaf: { key: 'entries', label: 'Journal Entries', model: 'account.move', ...journalEntriesView },
        base: '#/accounting/entries',
        params: new URLSearchParams('view=list'),
      }));
    });

    // Find Reverse Entries button
    const revBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Reverse Entries');
    assert.ok(revBtn, 'ActionView must render Reverse Entries action button');

    // Select row checkboxes specifically for p1 and p2
    const tbody = find(host, (n) => n.tagName === 'TBODY');
    const p1Cb = find(tbody, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === m1.name);
    const p2Cb = find(tbody, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === m2.name);
    assert.ok(p1Cb, 'Checkbox for p1 must exist in list view');
    assert.ok(p2Cb, 'Checkbox for p2 must exist in list view');

    await React.act(async () => props(p1Cb).onChange({ target: { checked: true } }));
    await React.act(async () => props(p2Cb).onChange({ target: { checked: true } }));

    // Click Reverse Entries button -> opens Wizard
    await React.act(async () => props(revBtn).onClick());

    const wizardForm = find(host, (n) => n.tagName === 'FORM' && classNameOf(n).includes('wizard'));
    assert.ok(wizardForm, 'Clicking Reverse Entries must open the reversal wizard dialog');
    assert.ok(wizardForm.textContent.includes('Reverse Entries'), 'Reversal wizard must display Reverse Entries title');

    // Confirm wizard
    await React.act(async () => props(wizardForm).onSubmit({ preventDefault: () => {} }));

    // Verify wizard closed and entries were reversed
    const openWizardAfter = find(host, (n) => n.tagName === 'FORM' && classNameOf(n).includes('wizard'));
    assert.equal(Boolean(openWizardAfter), false, 'Wizard must close upon successful reversal');

    const revEntries = search(getDb(), 'account.move').filter((m) => m.reversed_entry_id === p1.id || m.reversed_entry_id === p2.id);
    assert.ok(revEntries.length >= 2, 'Batch reversal via ActionView wizard must create reversal entries');
  } finally {
    await React.act(async () => root.unmount());
  }

  // Verify Arabic translation for Reverse Entries
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t: tAr } = await import(`./i18n.js?lang=ar-u1-rev=${Date.now()}`);
    assert.equal(tAr('Reverse Entries'), 'عكس القيود', 'Reverse Entries must translate to Arabic عكس القيود');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

// ---------------------------------------------------------------------------
// JE-21: Journal Items list header select-all checkbox (already present; covered here)
// ---------------------------------------------------------------------------
test('JE-21: Journal Items header select-all checkbox selects every visible row and stays in sync', async () => {
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

  const p = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-06-01', ref: 'JI-P1',
    lines: [{ account_id: ar, debit: 150 }, { account_id: rev, credit: 150 }],
  });
  db = p.db;

  const root = createRoot(host);
  try {
    await React.act(async () => {
      await commit(db);
      root.render(React.createElement(JournalItems));
    });

    // 1. The first <th> in thead must contain the checkbox and must NOT have static text "Select"
    const thead = find(host, (n) => n.tagName === 'THEAD');
    const firstTh = find(thead, (n) => n.tagName === 'TH');
    assert.ok(firstTh, 'First <th> in thead must exist');

    const headerCb = find(firstTh, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === 'Select all');
    assert.ok(headerCb, 'Header must have a Select all checkbox');

    // Replacing static "Select" header text:

    // 2. Row checkboxes
    const tbody = find(host, (n) => n.tagName === 'TBODY');
    const rowCbs = findAll(tbody, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && !props(n)?.disabled);
    assert.ok(rowCbs.length >= 2, 'There must be selectable rows in the table');

    // Initially header checkbox is unchecked
    assert.equal(props(headerCb).checked, false);

    // Select row by row
    for (let i = 0; i < rowCbs.length; i++) {
      await React.act(async () => props(rowCbs[i]).onChange({ target: { checked: true } }));
      if (i < rowCbs.length - 1) {
        assert.equal(props(headerCb).checked, false, 'Header checkbox must remain unchecked until all rows are selected');
      }
    }
    // Now all rows are selected -> header checkbox must be checked
    assert.equal(props(headerCb).checked, true, 'Header checkbox must be checked when all visible rows are selected one by one');

    // Deselect one row -> header checkbox must become unchecked
    await React.act(async () => props(rowCbs[0]).onChange({ target: { checked: false } }));
    assert.equal(props(headerCb).checked, false, 'Header checkbox must become unchecked when a row is deselected');

    // Header checkbox selects all
    await React.act(async () => props(headerCb).onChange({ target: { checked: true } }));
    assert.equal(props(headerCb).checked, true);
    assert.ok(rowCbs.every((cb) => props(cb).checked === true), 'All row checkboxes must be checked');

    // Header checkbox deselects all
    await React.act(async () => props(headerCb).onChange({ target: { checked: false } }));
    assert.equal(props(headerCb).checked, false);
    assert.ok(rowCbs.every((cb) => props(cb).checked === false), 'All row checkboxes must be unchecked');
  } finally {
    await React.act(async () => root.unmount());
  }
});
