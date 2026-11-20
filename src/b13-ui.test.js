import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { fieldReadonly } from './field-metadata.js';
import { journalCards } from './models/finance.js';
import {
  syncOnlineConnection,
  syncOnlineJournal,
} from './models/onlineSync.js';
import {
  formatTaxReturnName,
  generateReturns,
} from './models/taxreturn.js';
import { SCHEMA_VERSION, migrate } from './migrations.js';
import { find, setupDom } from './test-support/dom.js';

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

test('1. Online Synchronization account_ids one2many is editable on form and wires to journal cards', async () => {
  const linkModel = models['account.online.link'];
  const accountIdsField = linkModel.fields.account_ids;

  // 1a. account_ids has editable: true so fieldReadonly does not lock the table
  assert.equal(accountIdsField.editable, true, 'account_ids must specify editable: true');
  assert.equal(fieldReadonly(accountIdsField, {}, {}), false, 'fieldReadonly must be false for account_ids');

  // Subfields balance and last_sync_cursor must remain readonly
  assert.equal(accountIdsField.fields.balance.readonly, true, 'balance must remain readonly');
  assert.equal(accountIdsField.fields.last_sync_cursor.readonly, true, 'last_sync_cursor must remain readonly');
  assert.equal(fieldReadonly(accountIdsField.fields.balance, {}, {}), true);
  assert.equal(fieldReadonly(accountIdsField.fields.last_sync_cursor, {}, {}), true);

  // 1b. Create connection through ORM write/create path with inline account_ids
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  assert.ok(bankJournal, 'bank journal exists');

  const demoPayload = {
    'ACC-B13-01': {
      '': {
        transactions: [
          { date: '2026-07-01', amount: 500, payment_ref: 'Client wire', unique_import_id: 'TX-B13-001' },
          { date: '2026-07-02', amount: -50, payment_ref: 'Service charge', unique_import_id: 'TX-B13-002' },
        ],
        nextCursor: 'cur-1',
        balance: 450,
      },
    },
  };

  const createRes = create(db, 'account.online.link', {
    name: 'B13 Test Bank',
    provider: 'demo',
    demo_transactions: demoPayload,
    account_ids: [
      {
        name: 'Operating Account',
        account_number: 'ACC-B13-01',
        journal_id: bankJournal.id,
      },
    ],
  });
  db = createRes.db;
  const linkId = createRes.id;

  // Verify child online account was created
  const createdAccounts = search(db, 'account.online.account').filter((a) => a.link_id === linkId);
  assert.equal(createdAccounts.length, 1);
  assert.equal(createdAccounts[0].name, 'Operating Account');
  assert.equal(createdAccounts[0].account_number, 'ACC-B13-01');
  assert.equal(createdAccounts[0].journal_id, bankJournal.id);

  // Journal bank_statements_source is updated to online_sync
  assert.equal(read(db, 'account.journal', bankJournal.id).bank_statements_source, 'online_sync');

  // 1c. syncOnlineJournal imports demo feed into that journal
  const syncRes = syncOnlineJournal(db, bankJournal.id);
  db = syncRes.db;
  assert.equal(syncRes.count, 2);

  // 1d. Dashboard card data function shows Fetch Transactions action (onlineSync object present)
  const cards = journalCards(db);
  const bankCard = cards.find((c) => c.journal.id === bankJournal.id);
  assert.ok(bankCard, 'bank journal card exists');
  assert.ok(bankCard.onlineSync, 'bank card has onlineSync object');
  assert.equal(bankCard.onlineSync.state, 'connected');
  assert.equal(bankCard.onlineSync.balance, 450);
  assert.notEqual(bankCard.onlineSync.state, 'disconnected');

  // 1e. Edit lines inline (add another account, update name, remove line)
  const updatedRes = write(db, 'account.online.link', linkId, {
    account_ids: [
      {
        id: createdAccounts[0].id,
        name: 'Operating Account Renamed',
        account_number: 'ACC-B13-01',
        journal_id: bankJournal.id,
      },
      {
        name: 'Savings Account',
        account_number: 'ACC-B13-02',
        journal_id: null,
      },
    ],
  });
  db = updatedRes;
  const reloaded = search(db, 'account.online.account').filter((a) => a.link_id === linkId);
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded.find((a) => a.id === createdAccounts[0].id).name, 'Operating Account Renamed');
  assert.ok(reloaded.some((a) => a.name === 'Savings Account'));

  // 1f. FormView UI path: clicking "Add a line" renders an editable row, setting name & linked journal,
  // saving via saveFormRecord persists the account, and reopening the connection form shows the line.
  const { FormView } = await import('./views/FormView.jsx');
  const { initStore, commit, getDb } = await import('./store.js');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const memoryStorage = () => {
    const data = new Map();
    return {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => data.set(k, String(v)),
      removeItem: (k) => data.delete(k),
    };
  };
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  setupDom();
  globalThis.document.createElementNS ??= (_ns, tag) => globalThis.document.createElement(tag);
  await initStore();

  // Create a clean bank journal and connection with no accounts
  const uiBankRes = create(db, 'account.journal', {
    name: 'UI Test Bank Journal',
    code: 'UITB',
    type: 'bank',
    company_id: 1,
    default_account_id: bankJournal.default_account_id,
    suspense_account_id: bankJournal.suspense_account_id,
  });
  db = uiBankRes.db;

  const uiConnRes = create(db, 'account.online.link', {
    name: 'UI Editable Connection',
    provider: 'demo',
  });
  db = uiConnRes.db;
  await commit(db);

  const formLeaf = { key: 'online-sync', label: 'Online Synchronization', model: 'account.online.link' };
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // 1. Initial render of connection form
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf: formLeaf,
      id: uiConnRes.id,
      base: '#/accounting/online-sync',
      params: new URLSearchParams('view=form'),
    })));

    // 2. Click "Add a line" under Online Accounts tab
    const addLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Add a line'));
    assert.ok(addLineBtn, 'Add a line button exists');
    await React.act(async () => props(addLineBtn).onClick());

    // 3. Row appears in the table with editable inputs
    const nameInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label']?.includes('Account Name'));
    assert.ok(nameInput, 'Account Name input row appears in table after clicking Add a line');
    await React.act(async () => props(nameInput).onChange({ target: { value: 'UI Created Account' } }));

    const journalSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label']?.includes('Linked Journal'));
    assert.ok(journalSelect, 'Linked Journal select exists in the added row');
    await React.act(async () => props(journalSelect).onChange({ target: { value: String(uiBankRes.id) } }));

    // 4. Click Save
    const saveBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Save'));
    assert.ok(saveBtn, 'Save button exists on dirty form');
    await React.act(async () => props(saveBtn).onClick());

    // 5. Exactly one account.online.account linked to that journal exists
    const savedUiAccounts = search(getDb(), 'account.online.account').filter((a) => a.link_id === uiConnRes.id);
    assert.equal(savedUiAccounts.length, 1, 'exactly one account.online.account linked to connection exists');
    assert.equal(savedUiAccounts[0].name, 'UI Created Account');
    assert.equal(savedUiAccounts[0].journal_id, uiBankRes.id);

    // 6. Reopen connection form -> the line shows
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf: formLeaf,
      id: uiConnRes.id,
      base: '#/accounting/online-sync',
      params: new URLSearchParams('view=form'),
    })));

    const reopenedNameInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.value === 'UI Created Account');
    assert.ok(reopenedNameInput, 'reopening connection form displays the saved account line');
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
});

test('2. Brand-new connection default state is not_synchronized, reflects provider result, and fails empty sync', () => {
  let db = seed();
  const linkModel = models['account.online.link'];

  // State options must contain not_synchronized
  const stateField = linkModel.fields.state;
  const hasNotSyncedOption = stateField.options.some(([k]) => k === 'not_synchronized');
  assert.ok(hasNotSyncedOption, 'state options must include not_synchronized');

  // Default state on new connection is not_synchronized
  const defaults = linkModel.defaults();
  assert.equal(defaults.state, 'not_synchronized', 'defaults() state must be not_synchronized');

  const newLinkRes = create(db, 'account.online.link', {
    name: 'Empty Bank Connection',
    provider: 'demo',
  });
  db = newLinkRes.db;
  const newLink = read(db, 'account.online.link', newLinkRes.id);
  assert.equal(newLink.state, 'not_synchronized', 'brand-new connection state must be not_synchronized');

  // Fetch button when function on unsaved draft record vs saved record
  const fetchBtn = linkModel.form.buttons.find((b) => b.label === 'Fetch Transactions');
  assert.ok(fetchBtn, 'Fetch Transactions button exists');
  assert.equal(Boolean(fetchBtn.when({ state: 'not_synchronized' }, db)), false, 'Fetch button hidden on unsaved draft');
  assert.equal(Boolean(fetchBtn.when({ id: 99, state: 'not_synchronized' }, db)), true, 'Fetch button shown on saved record');
  assert.equal(Boolean(fetchBtn.when({ id: 99, state: 'disconnected' }, db)), false, 'Fetch button hidden when disconnected');

  // Fetch Transactions on connection with no linked account raises error
  assert.throws(
    () => syncOnlineConnection(db, newLinkRes.id),
    /Link an online account to a bank journal first/i,
  );

  // Link account and sync: state transitions to connected on success
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const withAccountRes = write(db, 'account.online.link', newLinkRes.id, {
    demo_transactions: {
      'ACC-OK': {
        '': {
          transactions: [{ date: '2026-07-01', amount: 100, payment_ref: 'Deposit', unique_import_id: 'TX-OK-1' }],
          nextCursor: 'c1',
        },
      },
    },
    account_ids: [{ name: 'Test Acc', account_number: 'ACC-OK', journal_id: bankJournal.id }],
  });
  db = withAccountRes;

  const successSync = syncOnlineConnection(db, newLinkRes.id);
  db = successSync.db;
  assert.equal(read(db, 'account.online.link', newLinkRes.id).state, 'connected');

  // Provider error transitions state to error
  const withErrorRes = write(db, 'account.online.link', newLinkRes.id, {
    demo_transactions: {
      'ACC-OK': {
        c1: { error: 'Bank API timeout' },
      },
    },
  });
  db = withErrorRes;
  const failSync = syncOnlineConnection(db, newLinkRes.id);
  db = failSync.db;
  assert.equal(read(db, 'account.online.link', newLinkRes.id).state, 'error');
  assert.equal(read(db, 'account.online.link', newLinkRes.id).error_message, 'Bank API timeout');

  // Reconnect action: sets state 'connected' only when the link has last_refresh; never synchronized link goes to 'not_synchronized'
  const reconnectBtn = linkModel.form.buttons.find((b) => b.label === 'Reconnect');
  assert.ok(reconnectBtn, 'Reconnect button exists');

  // Case 1: link never synchronized (last_refresh is null) disconnected -> reconnects to not_synchronized
  const unsyncedLink = create(db, 'account.online.link', { name: 'Never Synced', state: 'disconnected', last_refresh: null, error_message: 'old error' });
  db = unsyncedLink.db;
  const unsyncedRec = read(db, 'account.online.link', unsyncedLink.id);
  const reconnectedUnsynced = reconnectBtn.run(db, unsyncedRec);
  db = reconnectedUnsynced.db;
  assert.equal(read(db, 'account.online.link', unsyncedLink.id).state, 'not_synchronized');
  assert.equal(read(db, 'account.online.link', unsyncedLink.id).error_message, '');

  // Case 2: link previously synchronized (last_refresh is set) disconnected -> reconnects to connected
  const syncedLink = create(db, 'account.online.link', { name: 'Previously Synced', state: 'disconnected', last_refresh: '2026-06-01T12:00:00Z', error_message: 'network error' });
  db = syncedLink.db;
  const syncedRec = read(db, 'account.online.link', syncedLink.id);
  const reconnectedSynced = reconnectBtn.run(db, syncedRec);
  db = reconnectedSynced.db;
  assert.equal(read(db, 'account.online.link', syncedLink.id).state, 'connected');
  assert.equal(read(db, 'account.online.link', syncedLink.id).error_message, '');

  // Migration 55: updates legacy connection with connected state but no last_refresh to not_synchronized
  const legacyDb = {
    schema_version: 54,
    records: {
      'account.online.link': [
        { id: 101, name: 'Legacy Unsynced', state: 'connected', last_refresh: null },
        { id: 102, name: 'Legacy Synced', state: 'connected', last_refresh: '2026-01-01T00:00:00Z' },
      ],
    },
  };
  const migrated = migrate(legacyDb);
  assert.equal(migrated.records['account.online.link'].find((r) => r.id === 101).state, 'not_synchronized');
  assert.equal(migrated.records['account.online.link'].find((r) => r.id === 102).state, 'connected');
  assert.equal(SCHEMA_VERSION, 61);
});

test('3. Tax returns: name defaults canonically, write/onchange enforces name rules, duplicate preserves copy name, and empty dates tab is clean', async () => {
  let db = seed();
  const { FormView } = await import('./views/FormView.jsx');

  // 3b. formatTaxReturnName helper extracted and canonical format
  assert.equal(formatTaxReturnName('VAT Return', '2026-01-01', '2026-01-31'), 'VAT Return (2026-01-01 - 2026-01-31)');

  // account.return.fields.name has function-valued required
  const returnModel = models['account.return'];
  assert.equal(typeof returnModel.fields.name.required, 'function', 'account.return name.required must be a function');

  const { saveFormRecord } = await import('./views/formSave.js');
  const { fieldRequired } = await import('./field-metadata.js');

  const vatType = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.category !== 'audit');
  assert.ok(vatType, 'VAT Return type found');

  // 3a. generateReturns sets name_auto true on generated returns
  const { created: generatedList } = generateReturns(db, vatType.id);
  assert.ok(generatedList.length > 0, 'generateReturns created returns');
  assert.ok(generatedList.every((r) => r.name_auto === true), 'all generated returns are name_auto');

  // Name requirement: false for tax return with type & dates, true without dates, true for audit working file
  assert.equal(fieldRequired(returnModel.fields.name, { type_id: vatType.id, date_from: '2026-04-01', date_to: '2026-04-30' }, db, true), false);
  assert.equal(fieldRequired(returnModel.fields.name, { type_id: vatType.id }, db, true), true);
  assert.equal(fieldRequired(returnModel.fields.name, { audit_status: 'ongoing', date_from: '2026-01-01', date_to: '2026-12-31' }, db, true), true);

  // Form save: tax return saves with auto name when name is empty
  const savedTaxReturn = saveFormRecord(db, 'account.return', null, {
    name: '',
    type_id: vatType.id,
    date_from: '2026-07-01',
    date_to: '2026-07-31',
    company_id: 1,
  });
  const loadedTaxReturn = read(savedTaxReturn.db, 'account.return', savedTaxReturn.id);
  assert.equal(loadedTaxReturn.name, 'VAT Return (2026-07-01 - 2026-07-31)');
  assert.equal(loadedTaxReturn.name_auto, true);

  // Form save: working file without name is refused
  assert.throws(
    () => saveFormRecord(db, 'account.return', null, {
      name: '',
      audit_status: 'ongoing',
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      company_id: 1,
    }),
    /Return is required/,
  );

  // Creating return without typing name defaults from type and dates

  const createdRetRes = create(db, 'account.return', {
    type_id: vatType.id,
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    company_id: 1,
  });
  db = createdRetRes.db;
  const createdRet = read(db, 'account.return', createdRetRes.id);
  assert.equal(createdRet.name, `VAT Return (2026-04-01 - 2026-04-30)`);

  // Explicit name is respected when provided
  const customRetRes = create(db, 'account.return', {
    name: 'Custom Q2 Filing',
    type_id: vatType.id,
    date_from: '2026-04-01',
    date_to: '2026-06-30',
    company_id: 1,
  });
  assert.equal(read(customRetRes.db, 'account.return', customRetRes.id).name, 'Custom Q2 Filing');

  // name_auto field: generated and defaulted returns are name_auto; typed returns are not
  assert.equal(returnModel.fields.name_auto?.type, 'boolean', 'name_auto field exists on account.return');
  assert.equal(returnModel.fields.name_auto?.hidden, true, 'name_auto is hidden');
  assert.equal(createdRet.name_auto, true, 'defaulted return has name_auto === true');
  assert.equal(read(customRetRes.db, 'account.return', customRetRes.id).name_auto, false, 'explicitly named return has name_auto === false');

  // onchange behavior: typed name survives a date change; auto name follows a date change
  const onchange = returnModel.onchange;
  // 1. User edits name: non-empty name sets name_auto to false
  const userEdited = onchange({ ...createdRet, name: 'VAT Return (2026-04-01 - 2026-04-30)' }, 'name', db);
  assert.equal(userEdited.name_auto, false, 'editing name sets name_auto to false');

  // Clearing the name (onchange) means automatic again: regenerates formatTaxReturnName(type, dates) and sets name_auto true
  const clearedOnchange = onchange({ ...createdRet, name: '' }, 'name', db);
  assert.equal(clearedOnchange.name, 'VAT Return (2026-04-01 - 2026-04-30)', 'clearing name in onchange regenerates name');
  assert.equal(clearedOnchange.name_auto, true, 'clearing name in onchange sets name_auto true');

  // 2. Typed name survives date change
  const typedRecord = { ...createdRet, name: 'Custom Name', name_auto: false };
  const afterDateChangeTyped = onchange({ ...typedRecord, date_to: '2026-05-31' }, 'date_to', db);
  assert.equal(afterDateChangeTyped.name, undefined, 'typed name must not be overwritten on date change');

  // Even if user typed a name matching the date pattern, it survives because name_auto is false
  const typedPatternRecord = { ...createdRet, name: 'VAT Return (2026-04-01 - 2026-04-30)', name_auto: false };
  const afterDateChangeTypedPattern = onchange({ ...typedPatternRecord, date_to: '2026-05-31' }, 'date_to', db);
  assert.equal(afterDateChangeTypedPattern.name, undefined, 'user-typed name in date pattern survives date change when name_auto is false');

  // 3. Auto name follows date change
  const autoRecord = { ...createdRet, name_auto: true };
  const afterDateChangeAuto = onchange({ ...autoRecord, date_to: '2026-05-31' }, 'date_to', db);
  assert.equal(afterDateChangeAuto.name, 'VAT Return (2026-04-01 - 2026-05-31)', 'auto name updates on date change');
  assert.equal(afterDateChangeAuto.name_auto, true, 'name_auto remains true after auto update');

  // 4. Clear the suggested name on a new return then change dates and save -> generated name, name_auto true
  const { changeFormValue } = await import('./views/formDefaults.js');
  const newReturnInitial = {
    type_id: vatType.id,
    date_from: '2026-08-01',
    date_to: '2026-08-31',
    company_id: 1,
    name: 'VAT Return (2026-08-01 - 2026-08-31)',
    name_auto: true,
  };
  let formChanges = changeFormValue('account.return', newReturnInitial, {}, 'name', '', db);
  formChanges = changeFormValue('account.return', newReturnInitial, formChanges, 'date_to', '2026-09-30', db);
  const savedClearedForm = saveFormRecord(db, 'account.return', null, { ...newReturnInitial, ...formChanges });
  db = savedClearedForm.db;
  const savedClearedRec = read(db, 'account.return', savedClearedForm.id);
  assert.equal(savedClearedRec.name, 'VAT Return (2026-08-01 - 2026-09-30)', 'new return with cleared name and changed dates gets generated name');
  assert.equal(savedClearedRec.name_auto, true, 'new return with cleared name has name_auto true');

  // 5. Clear the name of a saved return via write -> generated name, name_auto true
  const customSavedRet = create(db, 'account.return', {
    name: 'Manual Tax Return Name',
    name_auto: false,
    type_id: vatType.id,
    date_from: '2026-10-01',
    date_to: '2026-10-31',
    company_id: 1,
  });
  db = customSavedRet.db;
  const writtenClearedDb = write(db, 'account.return', customSavedRet.id, { name: '' });
  db = writtenClearedDb;
  const writtenClearedRec = read(db, 'account.return', customSavedRet.id);
  assert.equal(writtenClearedRec.name, 'VAT Return (2026-10-01 - 2026-10-31)', 'clearing name via write regenerates name');
  assert.equal(writtenClearedRec.name_auto, true, 'clearing name via write sets name_auto true');

  // Round 6 tests:
  // (a) write(db, 'account.return', id, { name: rec.name, name_auto: true }) keeps name_auto true
  const retA = create(db, 'account.return', {
    type_id: vatType.id,
    date_from: '2026-11-01',
    date_to: '2026-11-30',
    company_id: 1,
  });
  db = retA.db;
  const recA = read(db, 'account.return', retA.id);
  assert.equal(recA.name_auto, true);
  const writeExplicitAutoDb = write(db, 'account.return', recA.id, { name: recA.name, name_auto: true });
  db = writeExplicitAutoDb;
  assert.equal(read(db, 'account.return', recA.id).name_auto, true, 'writing { name: rec.name, name_auto: true } preserves name_auto true');

  // (b) write with the full record (as saveFormRecord does) and a changed date_to regenerates the name when name_auto was true
  const retB = create(db, 'account.return', {
    type_id: vatType.id,
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    company_id: 1,
  });
  db = retB.db;
  const recB = read(db, 'account.return', retB.id);
  assert.equal(recB.name_auto, true);
  const fullSaveDb = write(db, 'account.return', recB.id, { ...recB, date_to: '2026-06-30' });
  db = fullSaveDb;
  const fullSaveRec = read(db, 'account.return', recB.id);
  assert.equal(fullSaveRec.name, 'VAT Return (2026-04-01 - 2026-06-30)', 'full record write with changed date_to regenerates automatic name');
  assert.equal(fullSaveRec.name_auto, true, 'full record write with changed date_to retains name_auto true');

  // (c) write { name: 'My name' } with no name_auto -> false
  const retC = create(db, 'account.return', {
    type_id: vatType.id,
    date_from: '2026-05-01',
    date_to: '2026-05-31',
    company_id: 1,
  });
  db = retC.db;
  const recC = read(db, 'account.return', retC.id);
  assert.equal(recC.name_auto, true);
  const writeCustomNameDb = write(db, 'account.return', recC.id, { name: 'My name' });
  db = writeCustomNameDb;
  const writeCustomNameRec = read(db, 'account.return', recC.id);
  assert.equal(writeCustomNameRec.name, 'My name');
  assert.equal(writeCustomNameRec.name_auto, false, 'write { name: "My name" } with no name_auto sets name_auto false');

  // Saved return without type/dates or audit return cannot persist empty name
  const auditRetRes = create(db, 'account.return', {
    name: 'Audit 2026',
    audit_status: 'ongoing',
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    company_id: 1,
  });
  db = auditRetRes.db;
  assert.throws(
    () => write(db, 'account.return', auditRetRes.id, { name: '' }),
    /Return is required/,
    'write setting empty name on audit return throws validation error',
  );

  // 6. Duplicate a return then change its dates -> copy name kept
  const { duplicateValues } = await import('./duplicate.js');
  const returnToDuplicate = read(db, 'account.return', createdRetRes.id);
  assert.equal(returnToDuplicate.name_auto, true);
  const dupVals = duplicateValues('account.return', returnToDuplicate);
  assert.equal(dupVals.name, `${returnToDuplicate.name} (copy)`);
  assert.equal(dupVals.name_auto, undefined, 'copy: false excludes name_auto from duplicateValues');
  const dupCreateRes = create(db, 'account.return', dupVals);
  db = dupCreateRes.db;
  const dupCreatedRec = read(db, 'account.return', dupCreateRes.id);
  assert.equal(dupCreatedRec.name, `${returnToDuplicate.name} (copy)`);
  assert.equal(dupCreatedRec.name_auto, false, 'duplicate copy gets name_auto false so edits preserve copy name');

  // Changing dates on duplicate copy preserves copy name (onchange and write)
  const dupDateOnchange = onchange({ ...dupCreatedRec, date_to: '2026-05-31' }, 'date_to', db);
  assert.equal(dupDateOnchange.name, undefined, 'onchange on duplicated copy does not overwrite name');
  const dupWrittenDb = write(db, 'account.return', dupCreatedRec.id, { date_to: '2026-05-31' });
  db = dupWrittenDb;
  assert.equal(read(db, 'account.return', dupCreatedRec.id).name, `${returnToDuplicate.name} (copy)`, 'write on duplicated copy preserves copy name');

  // 7. Migration 55 sets name_auto true only where name === formatTaxReturnName(type name, date_from, date_to)
  const legacyReturnDb = {
    schema_version: 54,
    records: {
      'account.return.type': [{ id: 10, name: 'VAT Return', company_id: 1 }],
      'account.return': [
        { id: 1, type_id: 10, name: 'VAT Return (2026-01-01 - 2026-01-31)', date_from: '2026-01-01', date_to: '2026-01-31' },
        { id: 2, type_id: 10, name: 'Manual Return Name', date_from: '2026-01-01', date_to: '2026-01-31' },
        { id: 3, type_id: 10, name: 'VAT Return (2026-01-01 - 2026-01-31)', date_from: '2026-02-01', date_to: '2026-02-28' }, // mismatch
      ],
    },
  };
  const migratedReturns = migrate(legacyReturnDb);
  assert.equal(migratedReturns.records['account.return'].find((r) => r.id === 1).name_auto, true);
  assert.equal(migratedReturns.records['account.return'].find((r) => r.id === 2).name_auto, false);
  assert.equal(migratedReturns.records['account.return'].find((r) => r.id === 3).name_auto, false);

  // 3c. FormView on account.return without dates shows explanatory empty state instead of all-time totals
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(db);

  const { makeEl } = setupDom();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // Render form for a new return (draft without dates)
    await React.act(async () => {
      root.render(React.createElement(FormView, {
        leaf: { key: 'tax-returns', label: 'Tax Returns', model: 'account.return' },
        id: 'new',
        base: '#/accounting/tax-returns',
        params: new URLSearchParams(),
      }));
    });
    // Should display empty state explaining dates needed, and NOT the report table
    const emptyMsg = host.textContent;
    assert.ok(
      emptyMsg.includes('dates') || emptyMsg.includes('Dates') || emptyMsg.includes('Set start and end dates'),
      'FormView must explain dates are required before tax report can be shown',
    );
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('4. Bank reconciliation shows signed balances, accessible button names, htmlFor label, and inline-select spacing', async () => {
  let db = seed();
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  // Create a negative statement line (-12.50)
  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    partner_id: partner.id,
    date: '2026-08-01',
    amount: -12.5,
    payment_ref: 'ATM Withdrawal Fee',
  });
  db = lineRes.db;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { makeEl } = setupDom();
  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));

    // 4a. Left list and Open Balance show signed amount (-12.50), not positive 12.50
    const stLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('ATM Withdrawal Fee'));
    assert.ok(stLineBtn, 'statement line button rendered');
    assert.ok(stLineBtn.textContent.includes('-12.50') || stLineBtn.textContent.includes('-$12.50') || stLineBtn.textContent.includes('(12.50)'), 'left list shows signed amount for negative line');

    // Select the line to inspect header and tabs
    await React.act(async () => props(stLineBtn).onClick());

    const summaryEl = find(host, (n) => props(n)?.className === 'bank-reconcile-amounts');
    assert.ok(summaryEl, 'summary amounts element found');
    assert.ok(
      summaryEl.textContent.includes('-12.50') || summaryEl.textContent.includes('-$12.50'),
      'Open Balance in summary header shows signed amount',
    );

    // 4b. Accessibility: aria-label on transaction row and counterpart rows
    const stBtnProps = props(stLineBtn);
    assert.ok(stBtnProps['aria-label'], 'statement line button must have aria-label');
    assert.ok(stBtnProps['aria-label'].includes('ATM Withdrawal Fee'), 'aria-label includes label');
    assert.ok(stBtnProps['aria-label'].includes(partner.name), 'aria-label includes partner');
    assert.ok(stBtnProps['aria-label'].includes('12.50'), 'aria-label includes amount');

    // Check Journal select label has inline-select spacing class
    const journalSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journal');
    assert.ok(journalSelect, 'Journal select found');
    const journalLabel = journalSelect.parentNode;
    assert.equal(journalLabel.tagName, 'LABEL');
    assert.ok(props(journalLabel)?.className?.includes('inline-select'), 'Journal label must have inline-select class for spacing');

    // Check Write-off Account select has an associated real label (htmlFor matches select id)
    // First ensure Candidates tab is active
    const writeoffSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Write-off Account');
    if (writeoffSelect) {
      const selectId = props(writeoffSelect)?.id;
      assert.ok(selectId, 'Write-off Account select has an id');
      const associatedLabel = find(host, (n) => n.tagName === 'LABEL' && props(n)?.htmlFor === selectId);
      assert.ok(associatedLabel, 'Write-off Account has an associated label with htmlFor matching select id');
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});
