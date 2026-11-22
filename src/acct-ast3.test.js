import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from './orm.js';
import { seed } from './seed.js';
import { depreciationReport, assetModels } from './models/assets.js';

test('asset groups provide report subtotals including ungrouped assets', () => {
  let db = seed();
  const group = create(db, 'account.asset.group', { name: 'Equipment', company_id: 1 });
  db = group.db;
  db = create(db, 'account.asset', { name: 'A', company_id: 1, asset_group_id: group.id, original_value: 100, acquisition_date: '2026-01-01', state: 'open' }).db;
  db = create(db, 'account.asset', { name: 'B', company_id: 1, original_value: 40, acquisition_date: '2026-01-01', state: 'open' }).db;
  const report = depreciationReport(db, { to: '2026-12-31' }, 1, 'asset_group_id');
  assert.equal(report.groups.find((g) => g.id === group.id).totals.original, 100);
  assert.equal(report.groups.find((g) => g.id === null).totals.original, 40);
  assert.ok(assetModels['account.asset'].groupBys.includes('asset_group_id'));
});

test('asset group rejects a group from another company through server diff', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  let db = seed();
  const group = create(db, 'account.asset.group', { name: 'Other', company_id: 2 });
  db = group.db;
  const asset = create(db, 'account.asset', { name: 'A', company_id: 1 });
  const forged = structuredClone(asset.db);
  forged.records['account.asset'].find((a) => a.id === asset.id).asset_group_id = group.id;
  assert.throws(() => applyDiff(asset.db, diffDb(asset.db, forged), { isAdmin: true }), /Asset group must belong/);
});

test('activation transfers book value into a linked running asset', async () => {
  const { activateDepreciation } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read } = await import('./orm.js');
  let db = seed();
  const accounts = assetAccounts(db);
  const asset = create(db, 'account.asset', { ...accounts, name: 'Machine', original_value: 100, acquisition_date: '2026-01-01', state: 'open', method: 'no_depreciation', depreciation_ids: [] });
  db = activateDepreciation(asset.db, read(asset.db, 'account.asset', asset.id), { date: '2026-01-02', accountId: accounts.account_asset_id, method: 'linear', methodNumber: 5 });
  const child = db.records['account.asset'].find((a) => a.parent_id === asset.id);
  assert.equal(child.state, 'open');
  assert.equal(child.original_value, 100);
  assert.equal(read(db, 'account.asset', asset.id).state, 'close');
});

test('selected posted journal item creates an asset draft with source values', async () => {
  const { createAssetsFromJournalItems } = await import('./models/assets.js');
  const { postEntry, journalItems } = await import('./models/ledger.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  let db = seed();
  const account = assetAccounts(db).account_asset_id;
  const other = db.records['account.account'].find((a) => a.id !== account && a.company_id === 1).id;
  const posted = postEntry(db, { journal: 'MISC', date: '2026-01-01', lines: [{ account, debit: 100, name: 'Machine' }, { account: other, credit: 100 }], company: 1 });
  db = posted.db;
  const line = journalItems(db).find((l) => l.move_id === posted.id && l.account_id === account);
  db = createAssetsFromJournalItems(db, [{ move_id: line.move_id, line_identity: line.line_identity }]);
  const asset = db.records['account.asset'].find((a) => a.source_move_id === posted.id);
  assert.equal(asset.original_value, 100);
  assert.equal(asset.account_asset_id, account);
  assert.equal(asset.acquisition_date, '2026-01-01');
  assert.equal(asset.state, 'draft');
});

test('activation and its source links survive server replay and resist forged transfers', async () => {
  const { activateDepreciation } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read } = await import('./orm.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const base = seed();
  const a = create(base, 'account.asset', { ...assetAccounts(base), name: 'Machine', original_value: 100, acquisition_date: '2026-01-01', state: 'open', method: 'no_depreciation', depreciation_ids: [] });
  const next = activateDepreciation(a.db, read(a.db, 'account.asset', a.id), { date: '2026-01-02', accountId: assetAccounts(base).account_asset_id, method: 'linear', methodNumber: 5 });
  const applied = applyDiff(a.db, diffDb(a.db, next), { isAdmin: true });
  assert.equal(read(applied, 'account.asset', a.id).state, 'close');
  const forged = structuredClone(next);
  forged.records['account.asset'].find((r) => r.id === a.id).activation_value = 25;
  assert.throws(() => applyDiff(a.db, diffDb(a.db, forged), { isAdmin: true }), /activation/i);
});

test('journal item source link cannot be forged through server diff', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  const base = seed();
  const { postEntry } = await import('./models/ledger.js');
  const account = base.records['account.account'].find((r) => r.company_id === 1);
  const entry = postEntry(base, { journal: 'MISC', date: '2026-01-01', company: 1, lines: [{ account: account.id, debit: 10 }, { account: account.id, credit: 10 }] });
  const a = create(entry.db, 'account.asset', { name: 'Forged' });
  const forged = structuredClone(a.db);
  Object.assign(forged.records['account.asset'].find((r) => r.id === a.id), { source_move_id: entry.id, source_line_identity: 'fake' });
  assert.throws(() => applyDiff(a.db, diffDb(a.db, forged), { isAdmin: true }), /source journal item/i);
});

test('journal asset drafts replay through server diff and reject repeated selection', async () => {
  const { createAssetsFromJournalItems } = await import('./models/assets.js');
  const { postEntry, journalItems } = await import('./models/ledger.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const base = seed();
  const account = assetAccounts(base).account_asset_id;
  const posted = postEntry(base, { journal: 'MISC', date: '2026-01-01', company: 1, lines: [{ account, debit: 20, partner_id: 2 }, { account, credit: 20 }] });
  const line = journalItems(posted.db).find((l) => l.move_id === posted.id && l.debit === 20);
  const selection = [{ move_id: line.move_id, line_identity: line.line_identity }];
  const next = createAssetsFromJournalItems(posted.db, selection);
  const applied = applyDiff(posted.db, diffDb(posted.db, next), { isAdmin: true });
  const asset = applied.records['account.asset'].find((a) => a.source_move_id === posted.id);
  assert.equal(asset.partner_id, 2);
  assert.throws(() => createAssetsFromJournalItems(applied, selection), /already has an asset/);
});

test('no-depreciation assets confirm without a schedule', async () => {
  const { confirmAsset } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read } = await import('./orm.js');
  const db = seed();
  const a = create(db, 'account.asset', { ...assetAccounts(db), name: 'Land', original_value: 100, acquisition_date: '2026-01-01', method: 'no_depreciation' });
  const confirmed = confirmAsset(a.db, read(a.db, 'account.asset', a.id));
  assert.deepEqual(read(confirmed, 'account.asset', a.id).depreciation_ids, []);
  assert.equal(read(confirmed, 'account.asset', a.id).state, 'open');
});

test('credit journal item keeps its signed balance in a draft asset', async () => {
  const { createAssetsFromJournalItems } = await import('./models/assets.js');
  const { postEntry, journalItems } = await import('./models/ledger.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const base = seed();
  const account = assetAccounts(base).account_asset_id;
  const posted = postEntry(base, { journal: 'MISC', date: '2026-01-01', company: 1, lines: [{ account, debit: 20 }, { account, credit: 20 }] });
  const line = journalItems(posted.db).find((l) => l.move_id === posted.id && l.credit === 20);
  const next = createAssetsFromJournalItems(posted.db, [{ move_id: line.move_id, line_identity: line.line_identity }]);
  assert.equal(next.records['account.asset'].find((a) => a.source_move_id === posted.id).original_value, -20);
});

test('activation metadata cannot close an asset without accounting entries', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  const base = seed();
  const a = create(base, 'account.asset', { name: 'A', state: 'open', original_value: 100 });
  const forged = structuredClone(a.db);
  forged.records['account.asset'].find((r) => r.id === a.id).activation_date = '2026-01-01';
  assert.throws(() => applyDiff(a.db, diffDb(a.db, forged), { isAdmin: true }), /activation/i);
});

test('asset draft helper preserves model rate and prorata settings', async () => {
  const { assetDraftValues } = await import('./models/accounting.js');
  const { write } = await import('./orm.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  let db = seed();
  const account = assetAccounts(db).account_asset_id;
  const model = create(db, 'account.asset.model', { name: 'Rate model', company_id: null, method: 'linear', method_mode: 'rate', method_rate: 0.25, method_number: 4, method_period: '12', prorata_computation_type: 'constant_periods', ...assetAccounts(db) });
  db = write(model.db, 'account.account', account, { asset_model_id: model.id });
  const move = { name: 'Entry', company_id: 1, partner_id: 2 };
  const values = assetDraftValues(db, move, { name: 'Equipment' }, { amount: 100, accountId: account, date: '2026-04-01' });
  assert.equal(values.model_id, model.id);
  assert.equal(values.method_mode, 'rate');
  assert.equal(values.method_rate, 0.25);
  assert.equal(values.prorata_computation_type, 'constant_periods');
  assert.ok(values.prorata_date);
});
