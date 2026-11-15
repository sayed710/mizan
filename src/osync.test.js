import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { create, read, search, unlink, validate, write } from './orm.js';
import { apps, models, writableModelsForApps } from './models/index.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { createCompany } from './models/company.js';
import { applyDiff } from './sync.js';
import { setupDom, find } from './test-support/dom.js';
import {
  getOnlineSyncProvider,
  registerOnlineSyncProvider,
  syncOnlineAccount,
  syncOnlineConnection,
} from './models/onlineSync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const LINK_MODEL = 'account.online.link';
const ACCOUNT_MODEL = 'account.online.account';
const LINE_MODEL = 'account.bank.statement.line';

const reactProps = (el) => el[Object.keys(el).find((k) => k.startsWith('__reactProps'))];

const memoryStorage = () => {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
};

const makeBankJournal = (db, { name = 'Sync Bank', code = 'SBNK', type = 'bank', company_id = 1 } = {}) => {
  let nextDb = db;
  let cashAcc = accountId(nextDb, '101401', company_id);
  if (!cashAcc) {
    const acc = create(nextDb, 'account.account', { code: `1019${code}`, name: `${name} Account`, account_type: 'asset_cash', company_id });
    nextDb = acc.db;
    cashAcc = acc.id;
  }
  let suspAcc = accountId(nextDb, '101404', company_id);
  if (!suspAcc && ['bank', 'credit'].includes(type)) {
    const acc = create(nextDb, 'account.account', { code: `1049${code}`, name: `${name} Suspense`, account_type: 'asset_current', company_id });
    nextDb = acc.db;
    suspAcc = acc.id;
  }
  return create(nextDb, 'account.journal', {
    name,
    code,
    type,
    company_id,
    default_account_id: cashAcc,
    ...(suspAcc ? { suspense_account_id: suspAcc } : {}),
    bank_statements_source: 'undefined',
  });
};

test('menu and model registration expose Online Synchronization under Accounting > Configuration', () => {
  assert.ok(models[LINK_MODEL], 'account.online.link model is registered');
  assert.ok(models[ACCOUNT_MODEL], 'account.online.account model is registered');
  const accountingMenus = apps.find((a) => a.id === 'accounting')?.menus ?? [];
  const config = accountingMenus.find((m) => m.label === 'Configuration');
  assert.ok(config, 'Configuration menu exists');
  const flatChildren = config.children.flatMap((c) => (c.children ? c.children : [c]));
  const syncMenu = flatChildren.find((m) => m.model === LINK_MODEL);
  assert.ok(syncMenu, 'Online Synchronization menu item is wired under Configuration');
  assert.equal(syncMenu.label, 'Online Synchronization');
  const sourceField = models['account.journal'].fields.bank_statements_source;
  assert.ok(sourceField.options.some(([v]) => v === 'online_sync'), 'account.journal keeps online_sync bank_statements_source');
});

test('all labels, options, buttons, and error messages of onlineSync models have Arabic translations', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import('./i18n.js?osync-ar-test');
    const collectModelStrings = (def) => {
      const out = [];
      if (def.label) out.push(def.label);
      const walkFields = (fields) => {
        for (const f of Object.values(fields ?? {})) {
          if (f.label) out.push(f.label);
          for (const opt of f.options ?? []) if (typeof opt?.[1] === 'string') out.push(opt[1]);
          if (f.fields) walkFields(f.fields);
        }
      };
      walkFields(def.fields);
      for (const group of def.filters ?? []) {
        for (const flt of group) if (flt.label) out.push(flt.label);
      }
      for (const tab of def.form?.tabs ?? []) if (tab.label) out.push(tab.label);
      for (const btn of def.form?.buttons ?? []) if (typeof btn.label === 'string') out.push(btn.label);
      return out;
    };

    const strings = [
      ...collectModelStrings(models[LINK_MODEL]),
      ...collectModelStrings(models[ACCOUNT_MODEL]),
      'Online Synchronization',
      'Synchronization error',
      'Last sync:',
      'Online synchronization disconnected',
      'Online synchronization ready',
      'Online Balance',
      'Provider name is required',
      'Provider adapter must implement fetchTransactions',
      'Demo feed payload must be an object keyed by account number',
      'Demo account feed must be an object keyed by cursor',
      'Demo cursor page must be an object',
      'Provider response must be an object',
      'Provider response must include a transactions array',
      'Provider response is missing nextCursor',
      'Provider transaction must be an object',
      'Provider transaction is missing a non-empty unique_import_id',
      'Provider transaction has an invalid date (expected YYYY-MM-DD)',
      'Provider transaction amount must be a finite non-zero number',
      'Provider transaction payment_ref must be a string',
      'Select an existing online connection',
      'Online account and connection must belong to the same company',
      'Select an existing journal',
      'Only bank or credit card journals can be linked to an online account',
      'The linked journal must belong to the same company as the connection',
      'This journal is already linked to another online account',
      'Unknown online synchronization provider',
      'Cannot change company while online accounts exist on this connection',
      'Reconnect the online connection before fetching transactions',
      'Online synchronization connection not found',
      'Online bank account not found',
      'No online account is linked to this journal',
      'Link an online account to a bank journal first',
      'A journal linked to an online account must remain a bank or credit card journal',
      'Cannot change the company of a journal linked to an online account',
      'A bank transaction with this Import ID already exists on this journal',
    ];
    for (const s of strings) {
      assert.notEqual(t(s), s, `missing Arabic translation for: ${s}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('a: link a bank journal, sync twice with overlapping demo feed payloads without duplicates, advancing cursor and updating running balance', () => {
  let db = seed();
  const journalRes = makeBankJournal(db, { name: 'Main Online Bank', code: 'ONL1' });
  db = journalRes.db;

  // Built-in demo/sandbox provider is registered without network calls.
  assert.ok(getOnlineSyncProvider('demo'), 'built-in demo provider is registered');

  const connRes = create(db, LINK_MODEL, {
    name: 'Sandbox Bank Connection',
    provider: 'demo',
    demo_transactions: {
      'ACC-001': {
        '': {
          transactions: [
            { date: '2026-06-01', amount: 1200, payment_ref: 'Customer Deposit A', unique_import_id: 'DEMO-001' },
            { date: '2026-06-02', amount: -150, payment_ref: 'Bank Wire Fee', unique_import_id: 'DEMO-002' },
          ],
          nextCursor: 'cursor-1',
        },
        'cursor-1': {
          transactions: [
            { date: '2026-06-02', amount: -150, payment_ref: 'Bank Wire Fee', unique_import_id: 'DEMO-002' },
            { date: '2026-06-04', amount: 450, payment_ref: 'Customer Deposit B', unique_import_id: 'DEMO-003' },
          ],
          nextCursor: 'cursor-2',
        },
      },
    },
  });
  db = connRes.db;

  const accRes = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Operating Checking',
    account_number: 'ACC-001',
    journal_id: journalRes.id,
  });
  db = accRes.db;

  assert.equal(read(db, 'account.journal', journalRes.id).bank_statements_source, 'online_sync');

  // First sync: creates 2 statement lines, advances cursor, sets last_refresh & balance.
  const firstSync = syncOnlineConnection(db, connRes.id, { now: '2026-06-03T10:00:00Z' });
  db = firstSync.db;
  assert.equal(firstSync.count, 2);
  assert.equal(firstSync.error, null);

  let lines = search(db, LINE_MODEL).filter((l) => l.journal_id === journalRes.id);
  assert.equal(lines.length, 2);
  assert.equal(read(db, ACCOUNT_MODEL, accRes.id).last_sync_cursor, 'cursor-1');
  assert.equal(read(db, ACCOUNT_MODEL, accRes.id).balance, 1050);
  assert.equal(read(db, LINK_MODEL, connRes.id).state, 'connected');
  assert.equal(read(db, LINK_MODEL, connRes.id).last_refresh, '2026-06-03T10:00:00Z');
  assert.equal(read(db, LINE_MODEL, lines.find((l) => l.unique_import_id === 'DEMO-002').id).running_balance, 1050);

  // Second sync using cursor-1: overlapping DEMO-002 is deduplicated, DEMO-003 is created.
  const secondSync = syncOnlineConnection(db, connRes.id, { now: '2026-06-04T12:30:00Z' });
  db = secondSync.db;
  assert.equal(secondSync.count, 1);

  lines = search(db, LINE_MODEL).filter((l) => l.journal_id === journalRes.id);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.unique_import_id).sort(), ['DEMO-001', 'DEMO-002', 'DEMO-003']);
  assert.equal(read(db, ACCOUNT_MODEL, accRes.id).last_sync_cursor, 'cursor-2');
  assert.equal(read(db, ACCOUNT_MODEL, accRes.id).balance, 1500);
  assert.equal(read(db, LINK_MODEL, connRes.id).last_refresh, '2026-06-04T12:30:00Z');
  assert.equal(read(db, LINE_MODEL, lines.find((l) => l.unique_import_id === 'DEMO-003').id).running_balance, 1500);

  // Third sync when cursor-2 has no page ("nothing new"): creates 0 lines and preserves cursor-2.
  const thirdSync = syncOnlineConnection(db, connRes.id, { now: '2026-06-05T08:00:00Z' });
  db = thirdSync.db;
  assert.equal(thirdSync.count, 0);
  assert.equal(thirdSync.error, null);
  assert.equal(read(db, ACCOUNT_MODEL, accRes.id).last_sync_cursor, 'cursor-2');

  // Direct create with duplicate unique_import_id on same journal is also rejected.
  assert.throws(() => create(db, LINE_MODEL, {
    journal_id: journalRes.id,
    date: '2026-06-04',
    payment_ref: 'Duplicate direct line',
    amount: 450,
    unique_import_id: 'DEMO-003',
  }), /Import ID/);
});

test('b: dashboard bank card shows sync status, error state, and triggers an incremental fetch', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  setupDom();
  globalThis.document.createElementNS ??= (_ns, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Dashboard } = await import('./views/Dashboard.jsx');
  await initStore();

  let db = seed();
  const journalRes = makeBankJournal(db, { name: 'Dashboard Sync Bank', code: 'DSBN' });
  db = journalRes.db;

  const connRes = create(db, LINK_MODEL, {
    name: 'Dashboard Demo Link',
    provider: 'demo',
    demo_transactions: {
      'CHK-88': {
        '': {
          transactions: [
            { date: '2026-06-10', amount: 800, payment_ref: 'Initial Online Deposit', unique_import_id: 'DS-001' },
          ],
          nextCursor: 'page-2',
        },
        'page-2': {
          transactions: [
            { date: '2026-06-11', amount: -100, payment_ref: 'Monthly Maintenance', unique_import_id: 'DS-002' },
          ],
          nextCursor: 'page-3',
        },
      },
    },
  });
  db = connRes.db;

  const accRes = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Dashboard Checking',
    account_number: 'CHK-88',
    journal_id: journalRes.id,
  });
  db = accRes.db;
  db = syncOnlineAccount(db, accRes.id, { now: '2026-06-10T09:15:00Z' }).db;
  await commit(db);

  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Dashboard)));
    const card = find(host, (n) => n.tagName === 'SECTION' && n.textContent.includes('Dashboard Sync Bank'));
    assert.ok(card, 'dashboard renders the linked bank journal card');
    const { display } = await import('./ui.jsx');
    assert.ok(card.textContent.includes(display(null, { type: 'datetime' }, '2026-06-10T09:15:00Z')), 'bank card displays last sync time in the shared local format');
    const fetchBtn = find(card, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Fetch Transactions'));
    assert.ok(fetchBtn, 'bank card shows Fetch Transactions action when linked');

    await React.act(async () => reactProps(fetchBtn).onClick());

    const afterDb = getDb();
    const lines = search(afterDb, LINE_MODEL).filter((l) => l.journal_id === journalRes.id);
    assert.equal(lines.length, 2);
    assert.equal(read(afterDb, ACCOUNT_MODEL, accRes.id).last_sync_cursor, 'page-3');
    assert.equal(read(afterDb, ACCOUNT_MODEL, accRes.id).balance, 700);

    // Put connection into error state and verify dashboard card displays the error message.
    await React.act(async () => commit(write(afterDb, LINK_MODEL, connRes.id, { state: 'error', error_message: 'Bank token expired' })));
    const errCard = find(host, (n) => n.tagName === 'SECTION' && n.textContent.includes('Dashboard Sync Bank'));
    assert.ok(errCard.textContent.includes('Bank token expired'), 'bank card displays sync error message');

    // If the connection is disconnected or unlinked in another tab, clicking Fetch Transactions surfaces the error via alert instead of throwing.
    const staleBtn = find(errCard, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Fetch Transactions'));
    assert.ok(staleBtn);
    const staleClick = reactProps(staleBtn).onClick;
    await React.act(async () => commit(write(getDb(), LINK_MODEL, connRes.id, { state: 'disconnected' })));
    const alerts = [];
    const prevAlert = globalThis.alert;
    globalThis.alert = (msg) => alerts.push(msg);
    try {
      assert.doesNotThrow(() => staleClick());
      assert.equal(alerts.length, 1);
      assert.match(alerts[0], /Reconnect the online connection/);
    } finally {
      globalThis.alert = prevAlert;
    }
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
});

test('c: rejects cross-company link, non-bank journal, second link to same journal, and unknown provider with clear errors and no data change', () => {
  let db = seed();
  const c2Res = createCompany(db, { name: 'Second Company' });
  db = c2Res.db;
  const bank1Res = makeBankJournal(db, { name: 'Co1 Bank', code: 'C1BK', company_id: 1 });
  db = bank1Res.db;
  const bank2Res = makeBankJournal(db, { name: 'Co2 Bank', code: 'C2BK', company_id: c2Res.id });
  db = bank2Res.db;
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash');
  const creditRes = makeBankJournal(db, { name: 'Co1 Credit Card', code: 'C1CC', type: 'credit', company_id: 1 });
  db = creditRes.db;

  // Unknown provider rejected on create/write with no data change.
  const beforeLinks = search(db, LINK_MODEL).length;
  assert.throws(() => create(db, LINK_MODEL, { name: 'Bad Provider', provider: 'nonexistent_bank' }), /provider/i);
  assert.equal(search(db, LINK_MODEL).length, beforeLinks);

  const connRes = create(db, LINK_MODEL, { name: 'Co1 Link', provider: 'demo', company_id: 1 });
  db = connRes.db;
  assert.throws(() => write(db, LINK_MODEL, connRes.id, { provider: 'nonexistent_bank' }), /provider/i);
  assert.equal(read(db, LINK_MODEL, connRes.id).provider, 'demo');

  // Cross-company link rejected with no data change.
  assert.throws(() => create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Wrong Company Acc',
    journal_id: bank2Res.id,
  }), /company/i);
  assert.equal(search(db, ACCOUNT_MODEL).length, 0);
  assert.equal(read(db, 'account.journal', bank2Res.id).bank_statements_source, 'undefined');

  // Non-bank/non-credit journals (sale, cash) rejected with no data change.
  assert.throws(() => create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Sale Journal Acc',
    journal_id: saleJournal.id,
  }), /bank or credit card/i);
  assert.throws(() => create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Cash Journal Acc',
    journal_id: cashJournal.id,
  }), /bank or credit card/i);
  assert.equal(search(db, ACCOUNT_MODEL).length, 0);

  // Credit-card journal is allowed and sets bank_statements_source to 'online_sync'.
  const ccAcc = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Corp Card',
    journal_id: creditRes.id,
  });
  db = ccAcc.db;
  assert.equal(read(db, 'account.journal', creditRes.id).bank_statements_source, 'online_sync');

  // First link on bank1Res succeeds; second link to bank1Res is rejected with no data change.
  const bankAcc1 = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Checking 1',
    journal_id: bank1Res.id,
  });
  db = bankAcc1.db;
  assert.throws(() => create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Duplicate Link Acc',
    journal_id: bank1Res.id,
  }), /already linked/i);
  assert.equal(search(db, ACCOUNT_MODEL).length, 2);

  // Cannot change a linked journal's type away from bank/credit.
  assert.throws(() => write(db, 'account.journal', bank1Res.id, { type: 'general' }), /online account/i);
});

test('d: provider failure mid-sync leaves no partial lines, preserves old cursor, and sets connection error state', () => {
  let db = seed();
  const bankA = makeBankJournal(db, { name: 'Bank A', code: 'BNKA' });
  db = bankA.db;
  const bankB = makeBankJournal(db, { name: 'Bank B', code: 'BNKB' });
  db = bankB.db;

  registerOnlineSyncProvider('flaky_test', {
    fetchTransactions(account) {
      if (account.account_number === 'FAIL-2') {
        throw new Error('Upstream bank gateway timed out');
      }
      return {
        transactions: [
          { date: '2026-06-15', amount: 300, payment_ref: 'Partial batch line', unique_import_id: 'FLAKY-1' },
        ],
        nextCursor: 'new-cursor-should-rollback',
        balance: 300,
      };
    },
  }, 'Flaky Test Provider');

  const connRes = create(db, LINK_MODEL, {
    name: 'Multi Account Connection',
    provider: 'flaky_test',
    last_refresh: '2026-06-14T08:00:00Z',
  });
  db = connRes.db;

  const accA = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'First Account',
    account_number: 'OK-1',
    journal_id: bankA.id,
    last_sync_cursor: 'old-cursor-A',
    balance: 100,
  });
  db = accA.db;

  const accB = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Second Failing Account',
    account_number: 'FAIL-2',
    journal_id: bankB.id,
    last_sync_cursor: 'old-cursor-B',
    balance: 50,
  });
  db = accB.db;

  const beforeLinesCount = search(db, LINE_MODEL).length;
  const failedSync = syncOnlineConnection(db, connRes.id, { now: '2026-06-15T11:00:00Z' });
  db = failedSync.db;

  assert.equal(failedSync.count, 0);
  assert.match(failedSync.error, /Upstream bank gateway timed out/);
  assert.equal(search(db, LINE_MODEL).length, beforeLinesCount, 'no partial statement lines were created');
  assert.equal(read(db, ACCOUNT_MODEL, accA.id).last_sync_cursor, 'old-cursor-A', 'first account keeps old cursor');
  assert.equal(read(db, ACCOUNT_MODEL, accA.id).balance, 100, 'first account keeps old balance');
  assert.equal(read(db, ACCOUNT_MODEL, accB.id).last_sync_cursor, 'old-cursor-B');
  assert.equal(read(db, LINK_MODEL, connRes.id).state, 'error');
  assert.match(read(db, LINK_MODEL, connRes.id).error_message, /Upstream bank gateway timed out/);
  assert.equal(read(db, LINK_MODEL, connRes.id).last_refresh, '2026-06-14T08:00:00Z', 'last_refresh unchanged on failure');
});

test('inline account_ids one2many save, unlink resets bank_statements_source, and records pass schema validation', () => {
  let db = seed();
  const bank = makeBankJournal(db, { name: 'Inline Bank', code: 'INLB' });
  db = bank.db;

  const connRes = create(db, LINK_MODEL, {
    name: 'Inline Form Link',
    provider: 'demo',
    account_ids: [{ name: 'Inline Acc', account_number: 'INL-1', journal_id: bank.id }],
  });
  db = connRes.db;

  const linkRec = read(db, LINK_MODEL, connRes.id);
  assert.equal(linkRec.account_ids.length, 1);
  assert.equal(linkRec.account_ids[0].journal_id, bank.id);
  assert.equal(read(db, 'account.journal', bank.id).bank_statements_source, 'online_sync');
  assert.ok(validate(LINK_MODEL, linkRec, db) == null);

  // Unlinking account resets journal bank_statements_source from online_sync.
  const accId = linkRec.account_ids[0].id;
  db = unlink(db, ACCOUNT_MODEL, [accId]);
  assert.equal(read(db, 'account.journal', bank.id).bank_statements_source, 'undefined');
});

test('connection form renders Fetch Transactions button and online accounts tab, and executes incremental fetch', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  setupDom();
  globalThis.document.createElementNS ??= (_ns, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();

  let db = seed();
  const bank = makeBankJournal(db, { name: 'Form Sync Bank', code: 'FSBK' });
  db = bank.db;
  const connRes = create(db, LINK_MODEL, {
    name: 'Form Connection',
    provider: 'demo',
    demo_transactions: {
      'FRM-ACC': {
        '': {
          transactions: [{ date: '2026-06-20', amount: 640, payment_ref: 'Form Fetch Deposit', unique_import_id: 'FRM-1' }],
          nextCursor: 'frm-1',
        },
      },
    },
  });
  db = create(connRes.db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Form Account 1',
    account_number: 'FRM-ACC',
    journal_id: bank.id,
  }).db;
  await commit(db);

  const leaf = { key: 'online-sync', label: 'Online Synchronization', model: LINK_MODEL };
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf,
      id: connRes.id,
      base: '#/accounting/online-sync',
      params: new URLSearchParams('view=form'),
    })));
    assert.ok(
      host.textContent.includes('Form Account 1') || find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.value === 'Form Account 1'),
      'connection form shows linked online account',
    );
    const fetchBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Fetch Transactions'));
    assert.ok(fetchBtn, 'connection form shows Fetch Transactions button');
    await React.act(async () => reactProps(fetchBtn).onClick());
    const after = getDb();
    assert.equal(search(after, LINE_MODEL).filter((l) => l.journal_id === bank.id).length, 1);
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
});

test('provider contract validation fails whole sync before writing any lines or advancing cursors, and rejects legacy guessed keys', () => {
  let db = seed();
  const bank1 = makeBankJournal(db, { name: 'Val Bank 1', code: 'VB1' });
  db = bank1.db;
  const bank2 = makeBankJournal(db, { name: 'Val Bank 2', code: 'VB2' });
  db = bank2.db;

  let responseForAcc2 = { transactions: [], nextCursor: 'c2-new' };
  registerOnlineSyncProvider('contract_test', {
    fetchTransactions(account) {
      if (account.account_number === 'V1') {
        return {
          transactions: [
            { unique_import_id: 'V1-OK', date: '2026-06-15', amount: 250, label: 'Legacy label ignored', name: 'Legacy name ignored' },
          ],
          nextCursor: 'v1-new',
        };
      }
      return responseForAcc2;
    },
  });

  const connRes = create(db, LINK_MODEL, { name: 'Contract Link', provider: 'contract_test' });
  db = connRes.db;
  const acc1 = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Valid Acc',
    account_number: 'V1',
    journal_id: bank1.id,
    last_sync_cursor: 'v1-old',
  });
  db = acc1.db;
  const acc2 = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Second Acc',
    account_number: 'V2',
    journal_id: bank2.id,
    last_sync_cursor: 'v2-old',
  });
  db = acc2.db;

  const beforeLines = search(db, LINE_MODEL).length;
  const cases = [
    [{ transactions: 'not-array', nextCursor: 'c2' }, /transactions array/],
    [{ transactions: [] }, /missing nextCursor/],
    [{ transactions: [{ id: 'LEGACY-ID', fitid: 'LEGACY-FITID', date: '2026-06-15', amount: 100 }], nextCursor: 'c2' }, /unique_import_id/],
    [{ transactions: [{ unique_import_id: '  ', date: '2026-06-15', amount: 100 }], nextCursor: 'c2' }, /unique_import_id/],
    [{ transactions: [{ unique_import_id: 'BAD-DATE', date: '2026-02-30', amount: 100 }], nextCursor: 'c2' }, /invalid date/i],
    [{ transactions: [{ unique_import_id: 'ZERO-AMT', date: '2026-06-15', amount: 0 }], nextCursor: 'c2' }, /finite non-zero number/],
    [{ transactions: [{ unique_import_id: 'STR-AMT', date: '2026-06-15', amount: '100' }], nextCursor: 'c2' }, /finite non-zero number/],
  ];

  for (const [badResponse, expectedPattern] of cases) {
    responseForAcc2 = badResponse;
    const failed = syncOnlineConnection(db, connRes.id, { now: '2026-06-16T00:00:00Z' });
    assert.equal(failed.count, 0);
    assert.match(failed.error, expectedPattern);
    assert.equal(search(failed.db, LINE_MODEL).length, beforeLines, 'no lines written for any account on validation failure');
    assert.equal(read(failed.db, ACCOUNT_MODEL, acc1.id).last_sync_cursor, 'v1-old', 'first account cursor unchanged');
    assert.equal(read(failed.db, ACCOUNT_MODEL, acc2.id).last_sync_cursor, 'v2-old', 'second account cursor unchanged');
    assert.equal(read(failed.db, LINK_MODEL, connRes.id).state, 'error');
    assert.match(read(failed.db, LINK_MODEL, connRes.id).error_message, expectedPattern);
  }

  // When all accounts return valid contract transactions, key guessing does not apply to payment_ref.
  responseForAcc2 = { transactions: [], nextCursor: 'v2-new' };
  const ok = syncOnlineConnection(db, connRes.id, { now: '2026-06-16T01:00:00Z' });
  assert.equal(ok.count, 1);
  assert.equal(ok.error, null);
  const createdLine = search(ok.db, LINE_MODEL).find((l) => l.unique_import_id === 'V1-OK');
  assert.equal(createdLine.payment_ref, '/');
  assert.equal(read(ok.db, ACCOUNT_MODEL, acc1.id).last_sync_cursor, 'v1-new');
  assert.equal(read(ok.db, ACCOUNT_MODEL, acc2.id).last_sync_cursor, 'v2-new');
});

test('demo provider supports per-account error pages and returns nothing new for missing account keys', () => {
  let db = seed();
  const bank = makeBankJournal(db, { name: 'Demo Error Bank', code: 'DERB' });
  db = bank.db;
  const connRes = create(db, LINK_MODEL, {
    name: 'Demo Error Conn',
    provider: 'demo',
    demo_transactions: {
      'ACC-ERR': {
        '': { error: 'Demo bank maintenance' },
      },
    },
  });
  db = connRes.db;
  const accRes = create(db, ACCOUNT_MODEL, {
    link_id: connRes.id,
    name: 'Missing Key Acc',
    account_number: 'ACC-MISSING',
    journal_id: bank.id,
    last_sync_cursor: 'cur-0',
  });
  db = accRes.db;

  // Missing account key returns nothing new and preserves cursor.
  const noop = syncOnlineConnection(db, connRes.id, { now: '2026-06-17T00:00:00Z' });
  assert.equal(noop.count, 0);
  assert.equal(noop.error, null);
  assert.equal(read(noop.db, ACCOUNT_MODEL, accRes.id).last_sync_cursor, 'cur-0');

  // Matching account key with { error } transitions connection to error state.
  db = write(noop.db, ACCOUNT_MODEL, accRes.id, { account_number: 'ACC-ERR', last_sync_cursor: '' });
  const failed = syncOnlineConnection(db, connRes.id, { now: '2026-06-17T01:00:00Z' });
  assert.equal(failed.count, 0);
  assert.equal(failed.error, 'Demo bank maintenance');
  assert.equal(read(failed.db, LINK_MODEL, connRes.id).state, 'error');
});

test('PROTECTED blocks non-accounting apps from writing account.online.link and account.online.account while accounting can', () => {
  const PROTECTED = [LINK_MODEL, ACCOUNT_MODEL];
  for (const app of ['todo', 'sales', 'appointments', 'pos']) {
    const write = writableModelsForApps([app]);
    for (const m of PROTECTED) assert.equal(write.has(m), false, `${app}: ${m}`);
  }
  const acctWrite = writableModelsForApps(['accounting']);
  for (const m of PROTECTED) assert.ok(acctWrite.has(m), `accounting: ${m}`);

  const db = seed();
  const allowed = writableModelsForApps(['todo']);
  assert.throws(
    () => applyDiff(db, { upserts: { [LINK_MODEL]: [{ id: 999, name: 'Forged Link', provider: 'demo' }] } }, { isAdmin: false, allowed }),
    /No access to account\.online\.link/,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { [ACCOUNT_MODEL]: [{ id: 999, name: 'Forged Acc', link_id: 1 }] } }, { isAdmin: false, allowed }),
    /No access to account\.online\.account/,
  );
});
