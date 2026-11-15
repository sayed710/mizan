import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search } from './orm.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { today } from './models/common.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { find, setupDom } from './test-support/dom.js';
import { registerOnlineSyncProvider, syncOnlineConnection } from './models/onlineSync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const LINK_MODEL = 'account.online.link';
const ACCOUNT_MODEL = 'account.online.account';
const LINE_MODEL = 'account.bank.statement.line';

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function makeBankJournal(db, { name = 'Q119H Bank', code = 'QHBN', currency_id = null, company_id = 1 } = {}) {
  let cashAcc = accountId(db, '101401', company_id);
  let nextDb = db;
  if (!cashAcc) {
    const acc = create(nextDb, 'account.account', { code: `1019${code}`, name: `${name} Cash`, account_type: 'asset_cash', company_id });
    nextDb = acc.db;
    cashAcc = acc.id;
  }
  let suspAcc = accountId(nextDb, '101404', company_id);
  if (!suspAcc) {
    const acc = create(nextDb, 'account.account', { code: `1049${code}`, name: `${name} Suspense`, account_type: 'asset_current', company_id });
    nextDb = acc.db;
    suspAcc = acc.id;
  }
  return create(nextDb, 'account.journal', {
    name,
    code,
    type: 'bank',
    company_id,
    default_account_id: cashAcc,
    suspense_account_id: suspAcc,
    ...(currency_id ? { currency_id } : {}),
  });
}

function setupFakeSync(providerName, handler) {
  registerOnlineSyncProvider(providerName, { fetchTransactions: handler }, `Fake ${providerName}`);
  let db = seed();
  const bank1 = makeBankJournal(db, { name: 'Sync Bank 1', code: 'SB1' });
  db = bank1.db;
  const bank2 = makeBankJournal(db, { name: 'Sync Bank 2', code: 'SB2' });
  db = bank2.db;

  const conn = create(db, LINK_MODEL, {
    name: `Conn ${providerName}`,
    provider: providerName,
    last_refresh: '2026-05-01T00:00:00Z',
  });
  db = conn.db;

  const acc1 = create(db, ACCOUNT_MODEL, {
    link_id: conn.id,
    name: 'Checking 1',
    account_number: 'ACC-1',
    journal_id: bank1.id,
    last_sync_cursor: 'cur-1-old',
    balance: 10,
  });
  db = acc1.db;

  const acc2 = create(db, ACCOUNT_MODEL, {
    link_id: conn.id,
    name: 'Checking 2',
    account_number: 'ACC-2',
    journal_id: bank2.id,
    last_sync_cursor: 'cur-2-old',
    balance: 20,
  });
  db = acc2.db;

  return { db, linkId: conn.id, acc1Id: acc1.id, acc2Id: acc2.id, bank1Id: bank1.id, bank2Id: bank2.id };
}

function assertSyncRejected(db, setup, expectedPattern) {
  const beforeLines = search(db, LINE_MODEL).length;
  const res = syncOnlineConnection(db, setup.linkId, { now: '2026-06-01T12:00:00Z' });
  assert.equal(res.count, 0);
  assert.match(res.error, expectedPattern);
  assert.equal(search(res.db, LINE_MODEL).length, beforeLines, 'no statement lines created on validation failure');
  assert.equal(read(res.db, ACCOUNT_MODEL, setup.acc1Id).last_sync_cursor, 'cur-1-old', 'account 1 cursor unchanged');
  assert.equal(read(res.db, ACCOUNT_MODEL, setup.acc2Id).last_sync_cursor, 'cur-2-old', 'account 2 cursor unchanged');
  assert.equal(read(res.db, ACCOUNT_MODEL, setup.acc1Id).balance, 10, 'account 1 balance unchanged');
  assert.equal(read(res.db, ACCOUNT_MODEL, setup.acc2Id).balance, 20, 'account 2 balance unchanged');
  const link = read(res.db, LINK_MODEL, setup.linkId);
  assert.equal(link.state, 'error');
  assert.match(link.error_message, expectedPattern);
  assert.equal(link.last_refresh, '2026-05-01T00:00:00Z');
}

// ---------------------------------------------------------------------------
// 1. Online sync provider contract validation & balance handling
// ---------------------------------------------------------------------------

test('1a: invalid supplied provider balance ("abc", "12.5", "", NaN, Infinity, -Infinity, boolean, object, array) fails staged sync with no writes or cursor advance', () => {
  let acc2Response = null;
  const setup = setupFakeSync('q119h_bad_balance', (account) => {
    if (account.account_number === 'ACC-1') {
      return {
        transactions: [{ unique_import_id: 'OK-ACC1-1', date: '2026-06-01', amount: 150, payment_ref: 'Valid Line' }],
        nextCursor: 'cur-1-new',
        balance: 150,
      };
    }
    return acc2Response;
  });

  for (const badBalance of ['abc', '12.5', '', NaN, Infinity, -Infinity, true, false, {}, []]) {
    acc2Response = {
      transactions: [{ unique_import_id: 'TX-BAD-BAL', date: '2026-06-01', amount: 50, payment_ref: 'Should Rollback' }],
      nextCursor: 'cur-2-new',
      balance: badBalance,
    };
    assertSyncRejected(setup.db, setup, /balance/i);
  }
});

test('1b: absent provider balance (undefined or null) falls back to statement sum; 0 and negative balance are accepted directly', () => {
  let acc1Response = null;
  let acc2Response = null;
  const setup = setupFakeSync('q119h_valid_balance', (account) => (
    account.account_number === 'ACC-1' ? acc1Response : acc2Response
  ));

  // Absent balance (undefined on ACC-1, null on ACC-2) falls back to journal statement line sum.
  acc1Response = {
    transactions: [{ unique_import_id: 'FALLBACK-1', date: '2026-06-01', amount: 250, payment_ref: 'Undef Balance' }],
    nextCursor: 'cur-1-fb',
  };
  acc2Response = {
    transactions: [{ unique_import_id: 'FALLBACK-2', date: '2026-06-01', amount: -40, payment_ref: 'Null Balance' }],
    nextCursor: 'cur-2-fb',
    balance: null,
  };
  const fallbackRes = syncOnlineConnection(setup.db, setup.linkId, { now: '2026-06-01T12:00:00Z' });
  assert.equal(fallbackRes.error, null);
  assert.equal(fallbackRes.count, 2);
  assert.equal(read(fallbackRes.db, ACCOUNT_MODEL, setup.acc1Id).balance, 250);
  assert.equal(read(fallbackRes.db, ACCOUNT_MODEL, setup.acc2Id).balance, -40);
  assert.equal(read(fallbackRes.db, ACCOUNT_MODEL, setup.acc1Id).last_sync_cursor, 'cur-1-fb');
  assert.equal(read(fallbackRes.db, ACCOUNT_MODEL, setup.acc2Id).last_sync_cursor, 'cur-2-fb');
  assert.equal(read(fallbackRes.db, LINK_MODEL, setup.linkId).state, 'connected');

  // Explicit balance 0 and negative balance are valid and override statement sum.
  acc1Response = { transactions: [], nextCursor: 'cur-1-zero', balance: 0 };
  acc2Response = { transactions: [], nextCursor: 'cur-2-neg', balance: -125.75 };
  const explicitRes = syncOnlineConnection(fallbackRes.db, setup.linkId, { now: '2026-06-02T12:00:00Z' });
  assert.equal(explicitRes.error, null);
  assert.equal(explicitRes.count, 0);
  assert.equal(read(explicitRes.db, ACCOUNT_MODEL, setup.acc1Id).balance, 0);
  assert.equal(read(explicitRes.db, ACCOUNT_MODEL, setup.acc2Id).balance, -125.75);
  assert.equal(read(explicitRes.db, ACCOUNT_MODEL, setup.acc1Id).last_sync_cursor, 'cur-1-zero');
  assert.equal(read(explicitRes.db, ACCOUNT_MODEL, setup.acc2Id).last_sync_cursor, 'cur-2-neg');
});

test('1c: duplicate unique_import_id inside one batch is rejected without writing lines or advancing cursors', () => {
  const setup = setupFakeSync('q119h_dup_batch', (account) => {
    if (account.account_number === 'ACC-1') {
      return {
        transactions: [{ unique_import_id: 'OK-1', date: '2026-06-01', amount: 100 }],
        nextCursor: 'cur-1-new',
        balance: 100,
      };
    }
    return {
      transactions: [
        { unique_import_id: 'DUP-TX', date: '2026-06-01', amount: 50, payment_ref: 'First' },
        { unique_import_id: 'DUP-TX', date: '2026-06-02', amount: 75, payment_ref: 'Duplicate' },
      ],
      nextCursor: 'cur-2-new',
    };
  });

  assertSyncRejected(setup.db, setup, /duplicate.*unique_import_id/i);
});

test('1d: invalid transaction partner_id (string, 0, negative, float, NaN, Infinity, empty string, boolean, object) is rejected', () => {
  let badPartnerId = null;
  const setup = setupFakeSync('q119h_bad_partner', (account) => {
    if (account.account_number === 'ACC-1') {
      return { transactions: [], nextCursor: 'cur-1-new' };
    }
    return {
      transactions: [{ unique_import_id: 'P-TX', date: '2026-06-01', amount: 50, partner_id: badPartnerId }],
      nextCursor: 'cur-2-new',
    };
  });

  for (const val of ['1', '', 0, -3, 1.5, NaN, Infinity, -Infinity, true, false, {}, []]) {
    badPartnerId = val;
    assertSyncRejected(setup.db, setup, /partner_id/i);
  }
});

test('1e: invalid transaction narration (non-string) is rejected without writing lines or advancing cursors', () => {
  let badNarration = null;
  const setup = setupFakeSync('q119h_bad_narration', (account) => {
    if (account.account_number === 'ACC-1') {
      return { transactions: [], nextCursor: 'cur-1-new' };
    }
    return {
      transactions: [{ unique_import_id: 'N-TX', date: '2026-06-01', amount: 50, narration: badNarration }],
      nextCursor: 'cur-2-new',
    };
  });

  for (const val of [123, NaN, Infinity, true, false, {}, []]) {
    badNarration = val;
    assertSyncRejected(setup.db, setup, /narration/i);
  }
});

test('1f: invalid transaction ref (non-string) is rejected without writing lines or advancing cursors', () => {
  let badRef = null;
  const setup = setupFakeSync('q119h_bad_ref', (account) => {
    if (account.account_number === 'ACC-1') {
      return { transactions: [], nextCursor: 'cur-1-new' };
    }
    return {
      transactions: [{ unique_import_id: 'R-TX', date: '2026-06-01', amount: 50, ref: badRef }],
      nextCursor: 'cur-2-new',
    };
  });

  for (const val of [456, NaN, Infinity, true, false, {}, []]) {
    badRef = val;
    assertSyncRejected(setup.db, setup, /ref/i);
  }
});

test('1g: malformed dates, zero/NaN/Infinity/string amounts, empty unique_import_id, and non-string nextCursor fail staged sync; empty nextCursor is valid', () => {
  let acc2Response = null;
  const setup = setupFakeSync('q119h_contract_sweep', (account) => {
    if (account.account_number === 'ACC-1') {
      return { transactions: [], nextCursor: '' };
    }
    return acc2Response;
  });

  const invalidCases = [
    [{ transactions: [{ unique_import_id: '', date: '2026-06-01', amount: 10 }], nextCursor: '' }, /unique_import_id/i],
    [{ transactions: [{ unique_import_id: 'D1', date: '2026/06/01', amount: 10 }], nextCursor: '' }, /invalid date/i],
    [{ transactions: [{ unique_import_id: 'D2', date: '2025-02-29', amount: 10 }], nextCursor: '' }, /invalid date/i],
    [{ transactions: [{ unique_import_id: 'D3', date: '', amount: 10 }], nextCursor: '' }, /invalid date/i],
    [{ transactions: [{ unique_import_id: 'A1', date: '2026-06-01', amount: 0 }], nextCursor: '' }, /finite non-zero number/i],
    [{ transactions: [{ unique_import_id: 'A2', date: '2026-06-01', amount: NaN }], nextCursor: '' }, /finite non-zero number/i],
    [{ transactions: [{ unique_import_id: 'A3', date: '2026-06-01', amount: Infinity }], nextCursor: '' }, /finite non-zero number/i],
    [{ transactions: [{ unique_import_id: 'A4', date: '2026-06-01', amount: '' }], nextCursor: '' }, /finite non-zero number/i],
    [{ transactions: [], nextCursor: 42 }, /nextCursor/i],
    [{ transactions: [], nextCursor: null }, /nextCursor/i],
  ];
  for (const [resp, pattern] of invalidCases) {
    acc2Response = resp;
    assertSyncRejected(setup.db, setup, pattern);
  }

  // Empty nextCursor string is explicitly valid per contract, and valid optional partner_id/narration/ref succeed.
  const partner = create(setup.db, 'res.partner', { name: 'Sync Partner' });
  acc2Response = {
    transactions: [{
      unique_import_id: 'ALL-OPT',
      date: '2026-06-01',
      amount: 75,
      payment_ref: '',
      partner_id: partner.id,
      narration: 'Memo text',
      ref: 'REF-01',
    }],
    nextCursor: '',
    balance: 75,
  };
  const ok = syncOnlineConnection(partner.db, setup.linkId, { now: '2026-06-01T12:00:00Z' });
  assert.equal(ok.error, null);
  assert.equal(ok.count, 1);
  const createdLine = search(ok.db, LINE_MODEL).find((l) => l.unique_import_id === 'ALL-OPT');
  assert.equal(createdLine.payment_ref, '/');
  assert.equal(createdLine.partner_id, partner.id);
  assert.equal(createdLine.narration, 'Memo text');
  assert.equal(createdLine.ref, 'REF-01');
});

test('1h: all new onlineSync validation error messages have Arabic translations', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import('./i18n.js?q119h-ar-test');
    const newMessages = [
      'Provider response balance must be a finite number',
      'Provider batch contains duplicate unique_import_id',
      'Provider transaction partner_id must be a positive integer',
      'Provider transaction narration must be a string',
      'Provider transaction ref must be a string',
    ];
    for (const msg of newMessages) {
      assert.notEqual(t(msg), msg, `missing Arabic translation for: ${msg}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

// ---------------------------------------------------------------------------
// 2. BankReconcile foreign currency formatting
// ---------------------------------------------------------------------------

test('2a: BankReconcile formats EUR invoice candidates and EUR outstanding payments in EUR while USD documents and Open Balance stay in USD', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reconcile' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  await initStore();

  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency exists in seed');
  const usdBank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = create(db, 'res.partner', { name: 'Multi-Currency Partner' });
  db = partner.db;

  // Posted EUR customer invoice (amount_residual = 90 EUR) and USD customer invoice (amount_residual = 100 USD).
  const eurInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    company_id: 1,
    currency_id: eur.id,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 90, tax: 0 }],
  });
  db = postMove(eurInv.db, eurInv.id);
  const eurInvName = read(db, 'account.move', eurInv.id).name;

  const usdInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    company_id: 1,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(usdInv.db, usdInv.id);
  const usdInvName = read(db, 'account.move', usdInv.id).name;

  // Posted unmatched EUR inbound payment (90 EUR) and USD inbound payment (100 USD).
  const eurPay = create(db, 'account.payment', {
    partner_id: partner.id,
    company_id: 1,
    journal_id: usdBank.id,
    currency_id: eur.id,
    amount: 90,
    date: today(),
    payment_type: 'inbound',
    partner_type: 'customer',
  });
  db = postPayment(eurPay.db, read(eurPay.db, 'account.payment', eurPay.id), { autoAllocate: false });
  const eurPayName = read(db, 'account.payment', eurPay.id).name;

  const usdPay = create(db, 'account.payment', {
    partner_id: partner.id,
    company_id: 1,
    journal_id: usdBank.id,
    amount: 100,
    date: today(),
    payment_type: 'inbound',
    partner_type: 'customer',
  });
  db = postPayment(usdPay.db, read(usdPay.db, 'account.payment', usdPay.id), { autoAllocate: false });
  const usdPayName = read(db, 'account.payment', usdPay.id).name;

  // Statement line on USD bank journal for $100.00.
  const line = create(db, LINE_MODEL, {
    journal_id: usdBank.id,
    company_id: 1,
    date: today(),
    amount: 100,
    payment_ref: 'USD-STMT-100',
  });
  db = line.db;
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile, { leaf: { key: 'reconcile', type: 'bankReconcile' } })));

    const lineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('USD-STMT-100'));
    assert.ok(lineBtn);
    await React.act(async () => props(lineBtn).onClick());

    // Open balance in left pane and right header stays in USD company currency ($100.00).
    assert.match(lineBtn.textContent, /\$100\.00/);
    const amountsEl = find(host, (n) => n.tagName === 'DIV' && props(n)?.className === 'bank-reconcile-amounts');
    assert.match(amountsEl.textContent, /Statement Amount:\s*\$100\.00/);
    assert.match(amountsEl.textContent, /Open Balance:\s*\$100\.00/);

    // Counterpart Candidates tab: EUR invoice in EUR (90.00 €), USD invoice in USD ($100.00).
    const eurInvRow = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(eurInvName));
    const usdInvRow = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(usdInvName));
    assert.ok(eurInvRow, 'EUR invoice candidate rendered');
    assert.ok(usdInvRow, 'USD invoice candidate rendered');
    assert.ok(eurInvRow.textContent.includes('90.00 €'), `expected 90.00 € in ${eurInvRow.textContent}`);
    assert.equal(eurInvRow.textContent.includes('$90.00'), false, 'EUR invoice must not use USD symbol');
    assert.ok(usdInvRow.textContent.includes('$100.00'), `expected $100.00 in ${usdInvRow.textContent}`);

    // Outstanding Payments tab: EUR payment in EUR (90.00 €), USD payment in USD ($100.00).
    const payTab = find(host, (n) => props(n)?.role === 'tab' && n.textContent.includes('Outstanding Payments'));
    await React.act(async () => props(payTab).onClick());

    const eurPayRow = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(eurPayName));
    const usdPayRow = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(usdPayName));
    assert.ok(eurPayRow, 'EUR payment rendered');
    assert.ok(usdPayRow, 'USD payment rendered');
    assert.ok(eurPayRow.textContent.includes('90.00 €'), `expected 90.00 € in ${eurPayRow.textContent}`);
    assert.equal(eurPayRow.textContent.includes('$90.00'), false, 'EUR payment must not use USD symbol');
    assert.ok(usdPayRow.textContent.includes('$100.00'), `expected $100.00 in ${usdPayRow.textContent}`);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('2b: BankReconcile formats open balance in each statement line own company currency in multi-company view', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reconcile' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  await initStore();

  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Euro Subsidiary', currency_id: eur.id });
  db = co2.db;
  const co2Bank = makeBankJournal(db, { name: 'Euro Co2 Bank', code: 'EUBK', currency_id: eur.id, company_id: co2.id });
  db = co2Bank.db;
  const co2Line = create(db, LINE_MODEL, {
    journal_id: co2Bank.id,
    company_id: co2.id,
    date: today(),
    amount: 75,
    payment_ref: 'CO2-EUR-75',
  });
  db = {
    ...co2Line.db,
    settings: { ...co2Line.db.settings, current_company_id: 1, allowed_company_ids: [1, co2.id] },
  };
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile, { leaf: { key: 'reconcile', type: 'bankReconcile' } })));
    const co2Btn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('CO2-EUR-75'));
    assert.ok(co2Btn);
    await React.act(async () => props(co2Btn).onClick());
    assert.ok(co2Btn.textContent.includes('75.00 €'), `left pane open balance uses company 2 EUR currency: ${co2Btn.textContent}`);
    const amountsEl = find(host, (n) => n.tagName === 'DIV' && props(n)?.className === 'bank-reconcile-amounts');
    assert.match(amountsEl.textContent, /Open Balance:\s*75\.00 €/);
  } finally {
    await React.act(async () => root.unmount());
  }
});
