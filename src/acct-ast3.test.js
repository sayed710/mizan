import './models/index.js';
import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
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

test('credit and zero-balance journal items cannot create asset drafts', async () => {
  const { createAssetsFromJournalItems } = await import('./models/assets.js');
  const { postEntry, journalItems } = await import('./models/ledger.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const base = seed();
  const account = assetAccounts(base).account_asset_id;
  const posted = postEntry(base, { journal: 'MISC', date: '2026-01-01', company: 1, lines: [{ account, debit: 20 }, { account, credit: 20 }, { account, debit: 0, credit: 0 }] });
  const creditLine = journalItems(posted.db).find((l) => l.move_id === posted.id && l.credit === 20);
  const zeroLine = journalItems(posted.db).find((l) => l.move_id === posted.id && l.debit === 0 && l.credit === 0);
  assert.throws(() => createAssetsFromJournalItems(posted.db, [{ move_id: creditLine.move_id, line_identity: creditLine.line_identity }]), /positive balance/i);
  if (zeroLine) {
    assert.throws(() => createAssetsFromJournalItems(posted.db, [{ move_id: zeroLine.move_id, line_identity: zeroLine.line_identity }]), /positive balance/i);
  }
  const forged = create(posted.db, 'account.asset', { name: 'Forged credit', account_asset_id: account, original_value: -20, acquisition_date: '2026-01-01' });
  const bad = structuredClone(forged.db);
  Object.assign(bad.records['account.asset'].find((r) => r.id === forged.id), { source_move_id: creditLine.move_id, source_line_identity: creditLine.line_identity });
  assert.throws(() => applyDiff(posted.db, diffDb(posted.db, bad), { isAdmin: true }), /source journal item/i);
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

test('Finding 1: posted bill journal item rejects duplicate asset creation (including via sync)', async () => {
  const { createAssetsFromJournalItems } = await import('./models/assets.js');
  const { postMove } = await import('./models/accounting.js');
  const { journalItems } = await import('./models/ledger.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const { write } = await import('./orm.js');
  let db = seed();
  const { account_asset_id } = assetAccounts(db);
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Server', qty: 1, price_unit: 1200, tax: 0, account_id: account_asset_id }],
  });
  db = postMove(bill.db, bill.id);
  const billAsset = db.records['account.asset'].find((a) => a.bill_id === bill.id);
  assert.ok(billAsset);
  const item = journalItems(db).find((l) => l.move_id === bill.id && l.account_id === account_asset_id);
  assert.ok(item);
  assert.throws(() => createAssetsFromJournalItems(db, [{ move_id: item.move_id, line_identity: item.line_identity }]), /already has an asset/);
  const forged = create(db, 'account.asset', { name: 'Dup', company_id: 1, account_asset_id, original_value: 1200, acquisition_date: '2026-01-01' });
  const forgedDup = structuredClone(forged.db);
  Object.assign(forgedDup.records['account.asset'].find((a) => a.id === forged.id), { source_move_id: item.move_id, source_line_identity: item.line_identity });
  assert.throws(() => applyDiff(db, diffDb(db, forgedDup), { isAdmin: true }), /already has an asset/);

  // Cancelled bill asset allows manual creation from the journal item
  const cancelled = write(db, 'account.asset', billAsset.id, { state: 'cancel' });
  const manual = createAssetsFromJournalItems(cancelled, [{ move_id: item.move_id, line_identity: item.line_identity }]);
  assert.equal(manual.records['account.asset'].filter((a) => a.state !== 'cancel').length, 1);
});

test('Finding 2: activateDepreciation preserves salvage value on child and validates salvage < book', async () => {
  const { activateDepreciation } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read } = await import('./orm.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const base = seed();
  const accounts = assetAccounts(base);
  const parent = create(base, 'account.asset', {
    ...accounts,
    name: 'Salvage Machine',
    original_value: 1000,
    salvage_value: 200,
    already_depreciated: 300,
    acquisition_date: '2026-01-01',
    state: 'open',
    method: 'no_depreciation',
    depreciation_ids: [],
  });
  const next = activateDepreciation(parent.db, read(parent.db, 'account.asset', parent.id), {
    date: '2026-02-01',
    accountId: accounts.account_asset_id,
    method: 'linear',
    methodNumber: 5,
  });
  const child = next.records['account.asset'].find((a) => a.parent_id === parent.id);
  assert.equal(child.original_value, 700);
  assert.equal(child.salvage_value, 200);
  assert.equal(child.depreciation_ids.reduce((s, l) => s + l.amount, 0), 500);
  assert.equal(child.depreciation_ids.at(-1).remaining, 200);
  const synced = applyDiff(parent.db, diffDb(parent.db, next), { isAdmin: true });
  assert.equal(synced.records['account.asset'].find((a) => a.parent_id === parent.id).salvage_value, 200);

  // When already depreciated right down to salvage value (book === salvage), activation must reject
  const depleted = create(base, 'account.asset', {
    ...accounts,
    name: 'Depleted',
    original_value: 1000,
    salvage_value: 200,
    already_depreciated: 800,
    acquisition_date: '2026-01-01',
    state: 'open',
    method: 'no_depreciation',
    depreciation_ids: [],
  });
  assert.throws(() => activateDepreciation(depleted.db, read(depleted.db, 'account.asset', depleted.id), {
    date: '2026-02-01',
    accountId: accounts.account_asset_id,
    method: 'linear',
    methodNumber: 2,
  }), /not depreciable value must be lower/i);
});

test('Finding 3: activateDepreciation rejects activation date earlier than existing revaluation', async () => {
  const { activateDepreciation, modifyAsset } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { accountId } = await import('./models/ledger.js');
  const { read } = await import('./orm.js');
  const base = seed();
  const accounts = assetAccounts(base);
  const a = create(base, 'account.asset', {
    ...accounts,
    name: 'Revalued Asset',
    original_value: 1000,
    acquisition_date: '2026-01-01',
    state: 'open',
    method: 'no_depreciation',
    depreciation_ids: [],
  });
  const modified = modifyAsset(a.db, read(a.db, 'account.asset', a.id), {
    date: '2026-03-01',
    valueChange: 200,
    accountId: accountId(a.db, '301000'),
  });
  assert.throws(() => activateDepreciation(modified, read(modified, 'account.asset', a.id), {
    date: '2026-02-01',
    accountId: accounts.account_asset_id,
    method: 'linear',
    methodNumber: 4,
  }), /precede an existing revaluation/i);
});

test('Finding 4 & 10: source-linked asset lifecycle across reset/cancel/repost and single-move validation', async () => {
  const { confirmAsset, createAssetsFromJournalItems, modifyAsset, postDepreciation } = await import('./models/assets.js');
  const { postMove } = await import('./models/accounting.js');
  const { accountId, journalItems, postEntry } = await import('./models/ledger.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const { read, unlink, write } = await import('./orm.js');
  let db = seed();
  const accounts = assetAccounts(db);
  const other = db.records['account.account'].find((a) => a.id !== accounts.account_asset_id && a.company_id === 1).id;

  // Draft asset from posted entry -> resetting move cancels draft asset and allows editing & reposting
  const entry = postEntry(db, {
    journal: 'MISC',
    date: '2026-01-01',
    company: 1,
    lines: [{ account: accounts.account_asset_id, debit: 500, name: 'Lathe' }, { account: other, credit: 500 }],
  });
  db = entry.db;
  const line = journalItems(db).find((l) => l.move_id === entry.id && l.debit === 500);
  db = createAssetsFromJournalItems(db, [{ move_id: line.move_id, line_identity: line.line_identity }]);
  let draftAsset = db.records['account.asset'].find((a) => a.source_move_id === entry.id);
  assert.equal(draftAsset.state, 'draft');

  // Uncoordinated reset via applyDiff without cancelling draft asset is rejected
  const uncoordinated = structuredClone(db);
  uncoordinated.records['account.move'].find((m) => m.id === entry.id).state = 'draft';
  assert.throws(() => applyDiff(db, diffDb(db, uncoordinated), { isAdmin: true }), /draft assets/i);

  // Coordinated reset cancels draft asset and replays via applyDiff
  let resetDb = write(db, 'account.move', entry.id, { state: 'draft' });
  assert.equal(read(resetDb, 'account.asset', draftAsset.id).state, 'cancel');
  resetDb = applyDiff(db, diffDb(db, resetDb), { isAdmin: true });
  assert.equal(read(resetDb, 'account.asset', draftAsset.id).state, 'cancel');

  // Even if a draft asset is somehow still linked to a non-posted move, cancelling the asset succeeds
  const staleDb = structuredClone(db);
  staleDb.records['account.move'].find((m) => m.id === entry.id).state = 'draft';
  const cancelledStale = write(staleDb, 'account.asset', draftAsset.id, { state: 'cancel' });
  assert.equal(read(cancelledStale, 'account.asset', draftAsset.id).state, 'cancel');

  // Edit & repost the reset move, then create a new asset from the updated line, confirm, modify, and depreciate
  resetDb = write(resetDb, 'account.move', entry.id, {
    line_ids: [{ account_id: accounts.account_asset_id, debit: 800, credit: 0, name: 'Lathe v2' }, { account_id: other, debit: 0, credit: 800 }],
  });
  resetDb = postMove(resetDb, entry.id);
  const newLine = journalItems(resetDb).find((l) => l.move_id === entry.id && l.debit === 800);
  resetDb = createAssetsFromJournalItems(resetDb, [{ move_id: newLine.move_id, line_identity: newLine.line_identity }]);
  let asset2 = resetDb.records['account.asset'].find((a) => a.source_move_id === entry.id && a.state !== 'cancel');
  resetDb = write(resetDb, 'account.asset', asset2.id, {
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
    method: 'linear',
    method_number: 4,
    method_period: '12',
  });
  resetDb = confirmAsset(resetDb, read(resetDb, 'account.asset', asset2.id));
  resetDb = modifyAsset(resetDb, read(resetDb, 'account.asset', asset2.id), { date: '2026-06-01', valueChange: 200, accountId: accountId(resetDb, '301000') });
  resetDb = postDepreciation(resetDb, read(resetDb, 'account.asset', asset2.id), '2026-12-31');
  assert.equal(read(resetDb, 'account.asset', asset2.id).depreciation_ids.filter((l) => l.posted).length, 1);

  // Resetting/deleting a move with a running asset is blocked
  assert.throws(() => write(resetDb, 'account.move', entry.id, { state: 'draft' }), /running or depreciated assets/i);
  assert.throws(() => unlink(resetDb, 'account.move', [entry.id]), /Posted entries cannot be deleted/i);
});

test('Finding 5 UI: JournalItems blocks Create Asset on credit/already-linked items', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  const { postEntry } = await import('./models/ledger.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { makeEl } = setupDom();
  await initStore();
  const base = seed();
  const account = assetAccounts(base).account_asset_id;
  const posted = postEntry(base, {
    journal: 'MISC',
    date: '2026-01-01',
    company: 1,
    lines: [
      { account, debit: 150, name: 'Debit Item' },
      { account, credit: 150, name: 'Credit Item' },
    ],
  });
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  const button = (label) => find(host, (node) => node.tagName === 'BUTTON' && node.textContent === label);
  const checkboxForLabel = (label) => {
    const row = find(host, (node) => node.tagName === 'TR' && node.textContent.includes(label));
    return find(row, (node) => node.tagName === 'INPUT' && props(node)?.type === 'checkbox');
  };
  try {
    await React.act(async () => { await commit(posted.db); root.render(React.createElement(JournalItems)); });
    // Selecting credit item disables Create Asset button
    await React.act(async () => props(checkboxForLabel('Credit Item')).onChange({ target: { checked: true } }));
    assert.equal(props(button('Create Asset')).disabled, true);
    // Uncheck credit, select debit -> Create Asset enabled; opening it disables credit checkbox
    await React.act(async () => props(checkboxForLabel('Credit Item')).onChange({ target: { checked: false } }));
    await React.act(async () => props(checkboxForLabel('Debit Item')).onChange({ target: { checked: true } }));
    assert.equal(props(button('Create Asset')).disabled, false);
    await React.act(async () => props(button('Create Asset')).onClick());
    assert.equal(props(checkboxForLabel('Credit Item')).disabled, true);
    await React.act(async () => props(find(host, (node) => node.tagName === 'FORM')).onSubmit({ preventDefault() {} }));
    assert.equal(getDb().records['account.asset'].filter((a) => a.source_move_id === posted.id).length, 1);

    // Stale selection: open Create Asset on a valid item, then create the asset in store before submitting
    const posted2 = postEntry(getDb(), {
      journal: 'MISC',
      date: '2026-01-02',
      company: 1,
      lines: [{ account, debit: 90, name: 'Stale Debit Item' }, { account, credit: 90, name: 'Stale Credit Item' }],
    });
    await React.act(async () => { await commit(posted2.db); });
    await React.act(async () => props(checkboxForLabel('Stale Debit Item')).onChange({ target: { checked: true } }));
    await React.act(async () => props(button('Create Asset')).onClick());
    const { createAssetsFromJournalItems } = await import('./models/assets.js');
    const { journalItems } = await import('./models/ledger.js');
    const staleLine = journalItems(getDb()).find((l) => l.move_id === posted2.id && l.debit === 90);
    await React.act(async () => { await commit(createAssetsFromJournalItems(getDb(), [{ move_id: staleLine.move_id, line_identity: staleLine.line_identity }])); });
    await React.act(async () => props(find(host, (node) => node.tagName === 'FORM')).onSubmit({ preventDefault() {} }));
    const alert = find(host, (node) => props(node)?.role === 'alert');
    assert.ok(alert && /already has an asset/i.test(alert.textContent));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Finding 6: depreciationReport treats activation as an internal transfer without inflating totals', async () => {
  const { activateDepreciation, confirmAsset, postDepreciation } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read } = await import('./orm.js');
  const base = seed();
  const accounts = assetAccounts(base);
  const parent = create(base, 'account.asset', {
    ...accounts,
    name: 'Parent CIP',
    original_value: 100,
    acquisition_date: '2026-01-01',
    method: 'linear',
    method_number: 2,
    method_period: '1',
  });
  let db = confirmAsset(parent.db, read(parent.db, 'account.asset', parent.id));
  db = postDepreciation(db, read(db, 'account.asset', parent.id), '2026-01-31');
  db = activateDepreciation(db, read(db, 'account.asset', parent.id), {
    date: '2026-02-01',
    accountId: accounts.account_asset_id,
    method: 'linear',
    methodNumber: 5,
  });
  const child = db.records['account.asset'].find((a) => a.parent_id === parent.id);
  db = postDepreciation(db, child, '2026-12-31');
  const report = depreciationReport(db, { from: '2026-01-01', to: '2026-12-31' }, 1);
  const pRow = report.rows.find((r) => r.a.id === parent.id);
  const cRow = report.rows.find((r) => r.a.id === child.id);
  assert.equal(pRow.original, 0);
  assert.equal(pRow.accumulated, 0);
  assert.equal(pRow.inPeriod, 50);
  assert.equal(pRow.book, 0);
  assert.equal(cRow.original, 50);
  assert.equal(cRow.inPeriod, 10);
  assert.equal(cRow.accumulated, 10);
  assert.equal(cRow.book, 40);
  assert.equal(report.totals.original, 50);
  assert.equal(report.totals.inPeriod, 60);
  assert.equal(report.totals.accumulated, 10);
  assert.equal(report.totals.book, 40);
});

test('Finding 7: activating no_depreciation asset with prior depreciation requires source depreciation account', async () => {
  const { activateDepreciation } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read } = await import('./orm.js');
  const base = seed();
  const accounts = assetAccounts(base);
  const missingDepAcc = create(base, 'account.asset', {
    name: 'Imported CIP',
    company_id: 1,
    original_value: 100,
    already_depreciated: 20,
    acquisition_date: '2026-01-01',
    state: 'open',
    method: 'no_depreciation',
    account_asset_id: accounts.account_asset_id,
    depreciation_ids: [],
  });
  assert.throws(() => activateDepreciation(missingDepAcc.db, read(missingDepAcc.db, 'account.asset', missingDepAcc.id), {
    date: '2026-02-01',
    accountId: accounts.account_asset_id,
    depreciationAccountId: accounts.account_depreciation_id,
    expenseAccountId: accounts.account_depreciation_expense_id,
    method: 'linear',
    methodNumber: 4,
  }), /Configure the depreciation account on asset Imported CIP/);

  const withDepAcc = create(base, 'account.asset', {
    ...accounts,
    name: 'Imported CIP Complete',
    company_id: 1,
    original_value: 100,
    already_depreciated: 20,
    acquisition_date: '2026-01-01',
    state: 'open',
    method: 'no_depreciation',
    depreciation_ids: [],
  });
  const activated = activateDepreciation(withDepAcc.db, read(withDepAcc.db, 'account.asset', withDepAcc.id), {
    date: '2026-02-01',
    accountId: accounts.account_asset_id,
    method: 'linear',
    methodNumber: 4,
  });
  assert.equal(activated.records['account.asset'].find((a) => a.parent_id === withDepAcc.id).original_value, 80);
});

test('Finding 8: activateDepreciation and wizard domain reject non-fixed-asset destination accounts', async () => {
  const { activateDepreciation } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { accountId } = await import('./models/ledger.js');
  const { read } = await import('./orm.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const base = seed();
  const accounts = assetAccounts(base);
  const expenseAcc = read(base, 'account.account', accountId(base, '600000'));
  const fixedAcc = read(base, 'account.account', accounts.account_asset_id);
  const a = create(base, 'account.asset', { ...accounts, name: 'CIP', original_value: 100, acquisition_date: '2026-01-01', state: 'open', method: 'no_depreciation', depreciation_ids: [] });
  assert.throws(() => activateDepreciation(a.db, read(a.db, 'account.asset', a.id), {
    date: '2026-02-01',
    accountId: expenseAcc.id,
    method: 'linear',
    methodNumber: 5,
  }), /Select a valid fixed asset account/);

  const wizard = assetModels['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation').wizard(a.db, read(a.db, 'account.asset', a.id));
  const field = wizard.fields.find((f) => f.name === 'asset_account_id');
  assert.equal(field.domain(expenseAcc), false);
  assert.equal(field.domain(fixedAcc), true);

  // Server guard rejects forged non-asset child
  const validNext = activateDepreciation(a.db, read(a.db, 'account.asset', a.id), {
    date: '2026-02-01',
    accountId: fixedAcc.id,
    method: 'linear',
    methodNumber: 5,
  });
  const forged = structuredClone(validNext);
  forged.records['account.asset'].find((r) => r.parent_id === a.id).account_asset_id = expenseAcc.id;
  forged.records['account.move'].find((m) => m.id === read(validNext, 'account.asset', a.id).activation_opening_move_id).line_ids[1].account_id = expenseAcc.id;
  assert.throws(() => applyDiff(a.db, diffDb(a.db, forged), { isAdmin: true }), /activation parent/i);
});

test('Finding 9: activation parent cannot acquire a second non-cancelled child', async () => {
  const { activateDepreciation } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read } = await import('./orm.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const base = seed();
  const accounts = assetAccounts(base);
  const parent = create(base, 'account.asset', { ...accounts, name: 'Single Parent', original_value: 100, acquisition_date: '2026-01-01', state: 'open', method: 'no_depreciation', depreciation_ids: [] });
  const activated = activateDepreciation(parent.db, read(parent.db, 'account.asset', parent.id), {
    date: '2026-02-01',
    accountId: accounts.account_asset_id,
    method: 'linear',
    methodNumber: 5,
  });
  assert.throws(() => create(activated, 'account.asset', {
    ...accounts,
    name: 'Second Child',
    parent_id: parent.id,
    original_value: 100,
    acquisition_date: '2026-02-01',
  }), /already has a child asset/i);
  const second = structuredClone(activated);
  const child1 = second.records['account.asset'].find((a) => a.parent_id === parent.id);
  second.records['account.asset'].push({ ...child1, id: child1.id + 1, name: 'Forged Second Child' });
  second.seq['account.asset'] = child1.id + 1;
  assert.throws(() => applyDiff(activated, diffDb(activated, second), { isAdmin: true }), /already has a child asset/i);
});

test('Finding 11: activateDepreciation preserves earlier cancelled_depreciation_ids history', async () => {
  const { activateDepreciation } = await import('./models/assets.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read } = await import('./orm.js');
  const base = seed();
  const accounts = assetAccounts(base);
  const priorCancelled = [{ date: '2025-12-31', amount: 25, cumulated: 25, remaining: 75, posted: false, move_id: null, cancelled: true }];
  const a = create(base, 'account.asset', {
    ...accounts,
    name: 'Refunded then Activated',
    original_value: 100,
    acquisition_date: '2026-01-01',
    state: 'open',
    method: 'linear',
    method_number: 2,
    method_period: '12',
    depreciation_ids: [{ date: '2026-12-31', amount: 50, cumulated: 50, remaining: 50, posted: false, move_id: null }, { date: '2027-12-31', amount: 50, cumulated: 100, remaining: 0, posted: false, move_id: null }],
    cancelled_depreciation_ids: priorCancelled,
  });
  const next = activateDepreciation(a.db, read(a.db, 'account.asset', a.id), {
    date: '2026-02-01',
    accountId: accounts.account_asset_id,
    method: 'linear',
    methodNumber: 4,
  });
  const closed = read(next, 'account.asset', a.id);
  assert.equal(closed.cancelled_depreciation_ids.length, 3);
  assert.equal(closed.cancelled_depreciation_ids[0].date, '2025-12-31');
});

test('Finding 10: asset writes validate single source move without scanning unrelated moves', async () => {
  const { confirmAsset, createAssetsFromJournalItems, postDepreciation } = await import('./models/assets.js');
  const { journalItems, postEntry } = await import('./models/ledger.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { read, write } = await import('./orm.js');
  let db = seed();
  const accounts = assetAccounts(db);
  const other = db.records['account.account'].find((a) => a.id !== accounts.account_asset_id && a.company_id === 1).id;
  const entry = postEntry(db, {
    journal: 'MISC',
    date: '2026-01-01',
    company: 1,
    lines: [{ account: accounts.account_asset_id, debit: 200, name: 'Single Move Item' }, { account: other, credit: 200 }],
  });
  db = entry.db;
  const line = journalItems(db).find((l) => l.move_id === entry.id && l.debit === 200);
  db = createAssetsFromJournalItems(db, [{ move_id: line.move_id, line_identity: line.line_identity }]);
  const asset = db.records['account.asset'].find((a) => a.source_move_id === entry.id);
  db = write(db, 'account.asset', asset.id, {
    account_depreciation_id: accounts.account_depreciation_id,
    account_depreciation_expense_id: accounts.account_depreciation_expense_id,
    method: 'linear',
    method_number: 2,
    method_period: '12',
  });
  db = confirmAsset(db, read(db, 'account.asset', asset.id));
  db = postDepreciation(db, read(db, 'account.asset', asset.id), '2026-12-31');
  assert.equal(read(db, 'account.asset', asset.id).depreciation_ids.filter((l) => l.posted).length, 1);
});

test('Finding 12: Depreciation report puts Group By control outside the exportable table body', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { Reports } = await import('./views/Reports.jsx');
  const { tableToRows } = await import('./csv.js');
  const { assetAccounts } = await import('./test-support/asset-accounts.js');
  const { makeEl } = setupDom();
  await initStore();
  let db = seed();
  const group = create(db, 'account.asset.group', { name: 'Machinery', company_id: 1 });
  db = create(group.db, 'account.asset', { ...assetAccounts(group.db), name: 'Lathe', company_id: 1, asset_group_id: group.id, original_value: 500, acquisition_date: '2026-01-01', state: 'open' }).db;
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  try {
    await React.act(async () => {
      await commit(db);
      root.render(React.createElement(Reports, { leaf: { report: 'depreciation' } }));
    });
    const table = find(host, (node) => node.tagName === 'TABLE');
    assert.equal(find(table, (node) => node.tagName === 'SELECT'), null);
    const groupSelect = find(host, (node) => node.tagName === 'SELECT' && props(node)?.['aria-label'] === 'Group By');
    assert.ok(groupSelect);
    const rowsBefore = tableToRows(table);
    assert.equal(rowsBefore[1][0], 'Lathe');
    await React.act(async () => props(groupSelect).onChange({ target: { value: 'asset_group_id' } }));
    const rowsGrouped = tableToRows(table);
    assert.ok(rowsGrouped.some((r) => r[0] === 'Machinery'));
    assert.ok(rowsGrouped.some((r) => r[0] === 'Subtotal'));
  } finally {
    await React.act(async () => root.unmount());
  }
});
