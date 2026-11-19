import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { journalAudit } from './models/journal_audit.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

function createAuditDb() {
  const journals = [
    { id: 10, name: 'Customer Invoices', code: 'INV' },
    { id: 20, name: 'Vendor Bills', code: 'BILL' },
    { id: 30, name: 'Miscellaneous', code: 'MISC' },
  ];
  const moves = [
    {
      id: 101,
      name: 'INV/2026/0002',
      journal_id: 10,
      state: 'posted',
      date: '2026-03-15',
      company_id: 1,
      line_ids: [
        { id: 1001, name: 'Product A', account_id: 1, debit: 200, credit: 0 },
        { id: 1002, name: 'Product A', account_id: 2, debit: 0, credit: 200 },
      ],
    },
    {
      id: 102,
      name: 'INV/2026/0001',
      journal_id: 10,
      state: 'posted',
      date: '2026-03-20',
      company_id: 1,
      line_ids: [
        { id: 1003, name: 'Product B', account_id: 1, debit: 150, credit: 0 },
        { id: 1004, name: 'Product B', account_id: 2, debit: 0, credit: 150 },
      ],
    },
    {
      id: 201,
      name: 'BILL/2026/0001',
      journal_id: 20,
      state: 'posted',
      date: '2026-03-10',
      company_id: 1,
      line_ids: [
        { id: 2001, name: 'Expense', account_id: 3, debit: 80, credit: 0 },
        { id: 2002, name: 'Expense', account_id: 4, debit: 0, credit: 80 },
      ],
    },
    {
      id: 301,
      name: 'MISC/2026/0001',
      journal_id: 30,
      state: 'posted',
      date: '2026-03-05',
      company_id: 1,
      line_ids: [
        { id: 3001, name: 'Adj', account_id: 5, debit: 50, credit: 0 },
        { id: 3002, name: 'Adj', account_id: 6, debit: 0, credit: 50 },
      ],
    },
  ];
  return {
    records: {
      'account.journal': journals,
      'account.move': moves,
      'res.company': [{ id: 1, name: 'Test Co' }],
      'res.partner': [],
      'account.account': [
        { id: 1, code: '101000', name: 'Receivable' },
        { id: 2, code: '400000', name: 'Sales' },
        { id: 3, code: '600000', name: 'Expenses' },
        { id: 4, code: '201000', name: 'Payable' },
        { id: 5, code: '100000', name: 'Asset' },
        { id: 6, code: '300000', name: 'Equity' },
      ],
    },
    settings: { current_company_id: 1, allowed_company_ids: [1] },
  };
}

test('journalAudit model: orders entries by Date or by Journal Entry Number', () => {
  const db = createAuditDb();

  // By Date (default behavior):
  // INV has INV/2026/0002 on 2026-03-15 and INV/2026/0001 on 2026-03-20.
  // Sorting by date should put 2026-03-15 (INV/2026/0002) before 2026-03-20 (INV/2026/0001).
  const byDate = journalAudit(db, { sort: 'date' });
  const invMovesDate = byDate.find((g) => g.journal.id === 10).items.map((it) => it.move.name);
  assert.equal(invMovesDate[0], 'INV/2026/0002');
  assert.equal(invMovesDate[1], 'INV/2026/0002');
  assert.equal(invMovesDate[2], 'INV/2026/0001');
  assert.equal(invMovesDate[3], 'INV/2026/0001');

  // By Journal Entry Number:
  // Sorting by number should put INV/2026/0001 before INV/2026/0002.
  const byNumber = journalAudit(db, { sort: 'number' });
  const invMovesNumber = byNumber.find((g) => g.journal.id === 10).items.map((it) => it.move.name);
  assert.equal(invMovesNumber[0], 'INV/2026/0001');
  assert.equal(invMovesNumber[1], 'INV/2026/0001');
  assert.equal(invMovesNumber[2], 'INV/2026/0002');
  assert.equal(invMovesNumber[3], 'INV/2026/0002');
});

test('journalAudit model: date sort keeps plain name order for same-day entries; number sort is numeric', () => {
  const db = createAuditDb();
  const sameDay = (name, id) => ({ id, name, journal_id: 30, state: 'posted', date: '2026-03-01', company_id: 1, line_ids: [{ id: id * 10, name: 'X', account_id: 5, debit: 1, credit: 0 }] });
  db.records['account.move'] = [...db.records['account.move'], sameDay('MISC/9', 901), sameDay('MISC/10', 902)];
  const names = (sort) => journalAudit(db, { sort }).find((g) => g.journal.id === 30).items.map((it) => it.move.name).filter((n) => /^MISC\/\d+$/.test(n));
  assert.deepEqual(names('date'), ['MISC/10', 'MISC/9']);
  assert.deepEqual(names('number'), ['MISC/9', 'MISC/10']);
});

test('JournalAudit view: sort option selector toggles between Date and Journal Entry Number ordering', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  const db = createAuditDb();
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));

    // Filter to Customer Invoices first so we can check order of INV/2026/0001 and INV/2026/0002
    const journalSelect = find(host, (node) => node.tagName === 'SELECT' && props(node)?.['aria-label'] === 'Journals');
    await React.act(async () => props(journalSelect).onChange({ target: { value: '10' } }));

    // Find sort select
    const sortSelect = find(host, (node) => node.tagName === 'SELECT' && (props(node)?.['aria-label'] === 'Sort by' || props(node)?.['aria-label'] === 'الترتيب' || props(node)?.['aria-label'] === 'ترتيب حسب'));
    assert.ok(sortSelect, 'Sort option selector exists');

    // Default is Date order -> INV/2026/0002 (2026-03-15) appears before INV/2026/0001 (2026-03-20)
    const linksDefault = [];
    const walk = (n) => {
      if (n.tagName === 'A' && props(n)?.href?.includes('/open/account.move/')) linksDefault.push(textOf(n));
      for (const child of n.childNodes ?? []) walk(child);
    };
    walk(host);
    assert.equal(linksDefault[0], 'INV/2026/0002');
    assert.equal(linksDefault[2], 'INV/2026/0001');

    // Change sort to Journal Entry Number ('number')
    await React.act(async () => props(sortSelect).onChange({ target: { value: 'number' } }));

    // By entry number -> INV/2026/0001 appears before INV/2026/0002
    const linksNumber = [];
    const walkNumber = (n) => {
      if (n.tagName === 'A' && props(n)?.href?.includes('/open/account.move/')) linksNumber.push(textOf(n));
      for (const child of n.childNodes ?? []) walkNumber(child);
    };
    walkNumber(host);
    assert.equal(linksNumber[0], 'INV/2026/0001');
    assert.equal(linksNumber[2], 'INV/2026/0002');

    // Toggle back to Date -> INV/2026/0002 appears before INV/2026/0001
    await React.act(async () => props(sortSelect).onChange({ target: { value: 'date' } }));
    const linksBack = [];
    const walkBack = (n) => {
      if (n.tagName === 'A' && props(n)?.href?.includes('/open/account.move/')) linksBack.push(textOf(n));
      for (const child of n.childNodes ?? []) walkBack(child);
    };
    walkBack(host);
    assert.equal(linksBack[0], 'INV/2026/0002');
    assert.equal(linksBack[2], 'INV/2026/0001');

    // Clear journal filter ('') -> all three journals are displayed
    await React.act(async () => props(journalSelect).onChange({ target: { value: '' } }));
    const allJournalsText = textOf(host);
    assert.match(allJournalsText, /Customer Invoices/);
    assert.match(allJournalsText, /Vendor Bills/);
    assert.match(allJournalsText, /Miscellaneous/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('i18n: translations for Journal Entry Number', async () => {
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  globalThis.location = { search: '', href: 'http://localhost/' };
  globalThis.document = {};
  const { t: tAr } = await import(`./i18n.js?testAr=${Date.now()}`);
  assert.equal(tAr('Journal Entry Number'), 'رقم قيد اليومية');
});
