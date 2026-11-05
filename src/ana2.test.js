import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { create, write } from './orm.js';
import { seed } from './seed.js';
import { accountingCompany } from './test-support/accounting-company.js';
import { analyticActuals } from './models/finance.js';
import { postEntry } from './models/ledger.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const textOf = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join('');

/** A second company keeping its books in the seeded EUR currency at a clean 0.8 EUR-per-USD rate. */
function euroCompany(db) {
  const branch = accountingCompany(db);
  const eurId = db.records['res.currency'].find((currency) => currency.name === 'EUR').id;
  const withRate = write(branch.db, 'res.currency', eurId, { rate_ids: [{ date: '2020-01-01', rate: 0.8, company_id: null }] });
  return { db: write(withRate, 'res.company', branch.id, { currency_id: eurId }), id: branch.id };
}

/** Allow both companies and report in company 1's currency. */
const reportingView = (db, companyId) => ({
  ...db,
  settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1, companyId] },
});

/** A seed whose demo analytic records are replaced so only the fixture lines are reported. */
function analyticBase(db) {
  return { ...db, records: { ...db.records, 'account.analytic.account': [], 'account.analytic.line': [] } };
}

test('analytic report shows foreign-company analytic lines in the reporting company currency', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  const euro = euroCompany(seed());
  const year = new Date().getFullYear();
  const account = create(analyticBase(euro.db), 'account.analytic.account', { name: 'Shared project', company_id: 1 });
  let db = account.db;
  for (const [amount, companyId, date] of [[123, 1, `${year}-06-15`], [100, euro.id, `${year}-06-16`]]) {
    db = create(db, 'account.analytic.line', { name: `Line ${amount}`, account_id: account.id, amount, company_id: companyId, date }).db;
  }
  db = reportingView(db, euro.id);
  assert.equal(analyticActuals(db).get(account.id), 248);

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'analytic' } })));
    const text = textOf(host);
    assert.match(text, /Shared project/);
    assert.match(text, /123\.00/);
    assert.match(text, /125\.00/);
    assert.match(text, /248\.00/);
    assert.doesNotMatch(text, /100\.00/);
    assert.doesNotMatch(text, /223\.00/);
  } finally { await React.act(async () => root.unmount()); }
});

test('general ledger translates a foreign-company entry into the reporting company currency', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  const euro = euroCompany(seed());
  const year = new Date().getFullYear();
  const cleared = { ...euro.db, records: { ...euro.db.records, 'account.move': [] } };
  const entry = postEntry(cleared, {
    journal: 'MISC', company: euro.id, date: `${year}-06-15`,
    lines: [{ account: '101401', debit: 100 }, { account: '450000', credit: 100 }],
  });
  const db = reportingView(entry.db, euro.id);

  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'ledger' } })));
    const text = textOf(host);
    assert.match(text, /125\.00/);
    assert.doesNotMatch(text, /100\.00/);
  } finally { await React.act(async () => root.unmount()); }
});
