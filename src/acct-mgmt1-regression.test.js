import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { seed } from './seed.js';
import { tableToRows } from './csv.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

test('merged pivot and loan cells retain their CSV column positions', () => {
  const cell = (text, colSpan = 1) => ({ tagName: 'TH', textContent: text, colSpan });
  const row = (...cells) => ({ tagName: 'TR', children: cells });
  const table = { children: [row(cell('Month'), cell('Bank', 3), cell('Cash', 3)), row(cell('Total', 2), cell('10'), cell('2'), cell('1'), cell('8')), row(cell('Loan'), cell('Lender'), cell('Historical entry links unavailable', 4))] };
  assert.deepEqual(tableToRows(table), [['Month', 'Bank', '', '', 'Cash', '', ''], ['Total', '', '10', '2', '1', '8'], ['Loan', 'Lender', 'Historical entry links unavailable', '', '', '']]);
});

test('loan totals respect currency and unavailable history, and selected rows use their company currency', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  const db = seed();
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const company = db.records['res.company'][0];
  db.records['res.company'].push({ ...company, id: 99, name: 'Other', currency_id: eur.id });
  db.settings.allowed_company_ids = [company.id, 99];
  db.records['account.move'].push({ id: 99001, company_id: company.id, state: 'posted', date: '2020-01-01', line_ids: [{ account_id: 999, credit: 100, debit: 0 }] }, { id: 99002, company_id: 99, state: 'posted', date: '2020-01-01', line_ids: [{ account_id: 999, credit: 200, debit: 0 }] });
  db.records['account.loan'] = [{ id: 99001, name: 'First', company_id: company.id, receipt_move_id: 99001, principal_account_id: 999 }, { id: 99002, name: 'Second', company_id: 99, receipt_move_id: 99002, principal_account_id: 999 }];
  await React.act(async () => store.commit(db));
  const { LoansAnalysis } = await import('./views/LoansAnalysis.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(LoansAnalysis)));
    assert.match(find(host, (n) => n.tagName === 'TFOOT').textContent, /Unavailable/);
    const select = find(host, (n) => n.tagName === 'SELECT');
    await React.act(async () => props(select).onChange({ target: { value: '99' } }));
    assert.match(find(host, (n) => n.tagName === 'TBODY').textContent, /€/);
    assert.doesNotMatch(find(host, (n) => n.tagName === 'TFOOT').textContent, /Unavailable/);
    db.records['account.loan'].push({ id: 99003, name: 'Missing', company_id: 99, state: 'running' });
    await React.act(async () => store.commit({ ...db }));
    assert.match(find(host, (n) => n.tagName === 'TBODY').textContent, /Historical entry links unavailable/);
    assert.match(find(host, (n) => n.tagName === 'TFOOT').textContent, /Unavailable/);
  } finally { await React.act(async () => root.unmount()); }
});

test('loan totals format in company 1 currency for legacy company-less loans when another company is active', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();
  const db = seed();
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const company = db.records['res.company'][0];
  db.records['res.company'].push({ ...company, id: 99, name: 'Other', currency_id: eur.id });
  db.settings.allowed_company_ids = [company.id, 99];
  db.settings.current_company_id = 99;
  db.records['account.move'].push(
    {
      id: 99010,
      company_id: company.id,
      state: 'posted',
      date: '2020-01-01',
      line_ids: [{ account_id: 999, credit: 500, debit: 0 }],
    },
    {
      id: 99011,
      company_id: company.id,
      state: 'posted',
      date: '2020-02-01',
      line_ids: [
        { account_id: 999, debit: 100, credit: 0 },
        { account_id: 888, debit: 20, credit: 0 },
      ],
    },
  );
  db.records['account.loan'] = [
    {
      id: 99010,
      name: 'Legacy Loan',
      receipt_move_id: 99010,
      principal_account_id: 999,
      interest_account_id: 888,
      line_ids: [{ move_id: 99011 }],
    },
  ];
  await React.act(async () => store.commit(db));
  const { LoansAnalysis } = await import('./views/LoansAnalysis.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(LoansAnalysis)));
    const tbody = find(host, (n) => n.tagName === 'TBODY');
    const tfoot = find(host, (n) => n.tagName === 'TFOOT');
    assert.match(tbody.textContent, /\$500\.00/);
    assert.match(tbody.textContent, /\$100\.00/);
    assert.match(tbody.textContent, /\$20\.00/);
    assert.match(tbody.textContent, /\$400\.00/);
    assert.doesNotMatch(tfoot.textContent, /€/);
    const footCells = find(tfoot, (n) => n.tagName === 'TR').childNodes.map((c) => c.textContent);
    assert.deepEqual(footCells, ['Total', '$500.00', '$100.00', '$20.00', '$400.00']);
  } finally { await React.act(async () => root.unmount()); }
});

