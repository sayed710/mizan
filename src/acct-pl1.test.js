import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { partnerLedger } from './models/reports.js';
import { today, addDays } from './models/common.js';
import { apps, leavesOf } from './models/index.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('PL-1 combines partner receivable and payable balances and filters the report', async () => {
  let db = seed();
  const date = today();
  const prior = addDays(date, -1);
  db = postEntry(db, { journal: 'MISC', date: prior, ref: 'PL1 opening', lines: [
    { account: '121000', debit: 100, partner_id: 3 }, { account: '211000', credit: 40, partner_id: 3 }, { account: '301000', credit: 60 },
  ] }).db;
  db = postEntry(db, { journal: 'MISC', date, ref: 'PL1 activity', lines: [
    { account: '121000', debit: 30, partner_id: 3 }, { account: '211000', credit: 20, partner_id: 3 }, { account: '301000', credit: 10 },
  ] }).db;
  const period = { from: date, to: date, partnerIds: [3] };
  const both = partnerLedger(db, period, 'both')[0];
  const ar = partnerLedger(db, period, 'receivable')[0];
  const ap = partnerLedger(db, period, 'payable')[0];
  for (const key of ['initial', 'debit', 'credit', 'end']) assert.equal(both[key], ar[key] + ap[key]);
  let balance = both.initial;
  for (const line of both.lines) { balance += line.debit - line.credit; assert.equal(line.balance, balance); }
  const app = apps.find((a) => a.id === 'accounting');
  assert.ok(leavesOf(app).some((l) => l.key === 'partner-ledger'));
  assert.ok(!leavesOf(app).some((l) => l.key === 'partner-ledger-payable'));
  const { initStore, commit } = await import('./store.js');
  await initStore(); await commit(db);
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');
  const html = renderToStaticMarkup(React.createElement(Reports, { leaf: { report: 'partnerReceivable' } }));
  assert.match(html, /aria-label="Account Type"/);
  assert.match(html, /value="both" selected/);
  const redirected = renderToStaticMarkup(React.createElement(Reports, { leaf: { report: 'partnerReceivable' }, params: new URLSearchParams('accountType=payable') }));
  assert.match(redirected, /value="payable" selected/);
});
