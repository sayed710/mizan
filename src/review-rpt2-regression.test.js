import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { create, write, read } from './orm.js';
import { depreciationReport } from './models/assets.js';
import { groupBudgetReportEntries } from './models/analyticplus.js';
import { groupTrialBalanceRows } from './models/reports.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('account group boundaries and overlaps are validated and account writes stay local', () => {
  let db = seed();
  assert.throws(() => create(db, 'account.group', { name: 'Bad', code_prefix_start: '10', code_prefix_end: '100', company_id: 1 }), /same length/);
  const g = create(db, 'account.group', { name: 'Range', code_prefix_start: '710', code_prefix_end: '715', company_id: 1 }); db = g.db;
  assert.throws(() => create(db, 'account.group', { name: 'Overlap', code_prefix_start: '712', code_prefix_end: '719', company_id: 1 }), /overlap/);
  const a = create(db, 'account.account', { name: 'Inside', code: '7151', account_type: 'asset_current', company_id: 1 }); db = a.db;
  const b = create(db, 'account.account', { name: 'Outside', code: '7161', account_type: 'asset_current', company_id: 1 }); db = b.db;
  assert.equal(read(db, 'account.account', a.id).group_id, g.id);
  assert.equal(read(db, 'account.account', b.id).group_id ?? null, null);
  db.records['account.account'].find((item) => item.id === b.id).group_id = g.id;
  const other = db.records['account.account'].find((item) => item.id === b.id);
  db = write(db, 'account.account', a.id, { name: 'Renamed' });
  assert.equal(db.records['account.account'].find((item) => item.id === b.id), other);
  assert.equal(db.records['account.account'].find((item) => item.id === b.id).group_id, g.id);
  db = write(db, 'account.account', a.id, { code: '7160' });
  assert.equal(read(db, 'account.account', a.id).group_id, null);
});

test('legacy assets group with their default company', () => {
  const db = seed();
  db.records['account.asset'] = [{ id: 999, name: 'Legacy', state: 'open', original_value: 10 }];
  const group = depreciationReport(db, { to: '2026-12-31' }, 1, { groupBy: 'company_id' }).groups[0];
  assert.equal(group.id, 1); assert.equal(group.name, read(db, 'res.company', 1).name);
});

test('group budget totals do not present partial periods as complete', () => {
  const currency = { id: 1, rounding: 0.01 };
  const entry = (periodLines) => ({ budget: { company_id: 1 }, company: { name: 'Company' }, currency, line: {}, periodLines });
  const groups = groupBudgetReportEntries(seed(), [entry([{ line: { planned: 10 } }]), entry([{ error: 'failed' }])], 'company_id');
  assert.equal(groups[0].periodTotals[0], null);
});

test('grouped budgets display missing-company diagnostics', async () => {
  const db = seed();
  db.records['account.budget'] = [{ id: 999, name: 'Missing company budget', state: 'confirmed', lines: [{ planned: 10 }] }];
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const period = { from: '2026-01-01', to: '2026-12-31' };
  const html = renderToStaticMarkup(React.createElement('table', null, React.createElement(Budget, { db, period, companyId: 'all', groupBy: 'company_id', money: String })));
  assert.match(html, /Missing company budget/);
  assert.match(html, /Select a company on the budget record/);
  assert.match(html, /—/);
});

test('trial balance groups expose ancestors and children', () => {
  const db = seed();
  db.records['account.group'] = [{ id: 1001, name: 'Parent', code_prefix_start: '7' }, { id: 1002, name: 'Child', code_prefix_start: '71', parent_id: 1001 }];
  const account = { id: 9001, code: '710', group_id: 1002, company_id: 1 };
  const groups = groupTrialBalanceRows(db, [account], [new Map()], ['debit'], 'account_group');
  assert.equal(groups[0].hasChildren, true);
  assert.deepEqual(groups[1].ancestors, ['group:1001']);
});

test('account group overlap checks apply to edits and are company scoped', () => {
  let db = seed();
  const first = create(db, 'account.group', { name: 'First', code_prefix_start: '810', code_prefix_end: '815', company_id: 1 }); db = first.db;
  const second = create(db, 'account.group', { name: 'Second', code_prefix_start: '820', code_prefix_end: '825', company_id: 1 }); db = second.db;
  assert.throws(() => write(db, 'account.group', second.id, { code_prefix_start: '815' }), /overlap/);
  const other = create(db, 'account.group', { name: 'Other company', code_prefix_start: '810', code_prefix_end: '815', company_id: 2 });
  assert.equal(read(other.db, 'account.group', other.id).company_id, 2);
});

test('empty end prefix matches the start prefix', () => {
  let db = seed();
  const group = create(db, 'account.group', { name: 'Single', code_prefix_start: '991', code_prefix_end: '', company_id: 1 }); db = group.db;
  const account = create(db, 'account.account', { name: 'Match', code: '9910', account_type: 'asset_current', company_id: 1 });
  assert.equal(read(account.db, 'account.account', account.id).group_id, group.id);
});

test('grouped budgets display calculation errors', async () => {
  const db = seed();
  db.records['res.company'].find((company) => company.id === 1).currency_id = null;
  db.records['account.budget'] = [{ id: 999, name: 'Broken currency budget', company_id: 1, state: 'confirmed', lines: [{ planned: 10 }] }];
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const period = { from: '2026-01-01', to: '2026-12-31' };
  const html = renderToStaticMarkup(React.createElement('table', null, React.createElement(Budget, { db, period, companyId: 'all', groupBy: 'company_id', money: String })));
  assert.match(html, /Broken currency budget/);
  assert.match(html, /role="alert"/);
  assert.match(html, /currency/i);
});
