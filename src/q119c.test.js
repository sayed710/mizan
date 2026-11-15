import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { create, postNote, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { models } from './models/index.js';
import { createCompany } from './models/company.js';
import { accountId } from './models/ledger.js';
import { postMove, registerPayment, residual } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { auditTrailToCsv, collectAuditTrailRows, isAuditTrackingMessage } from './models/auditTrail.js';
import {
  createInvoiceCheckout,
  processPaymentWebhook,
  signWebhookPayload,
  WebhookError,
} from './models/paymentAdapter.js';
const LINK_MODEL = 'account.online.link';
const ACCOUNT_MODEL = 'account.online.account';
import { find, setupDom } from './test-support/dom.js';
import { createPortal } from '../server/portal.js';
const loadArabicT = async () => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {} };
  try {
    return (await import('./i18n.js?ar=q119c')).t;
  } finally {
    globalThis.localStorage = prev;
  }
};

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function makeInvoice(db, { partnerId = 1, price = 250, companyId = 1, date = '2026-04-10' } = {}) {
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    company_id: companyId,
    invoice_date: date,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: price, tax: 0 }],
  });
  return { db: postMove(inv.db, inv.id), id: inv.id };
}

function makeBankJournal(db, { name = 'Second Bank', code = 'BNK2', company_id = 1 } = {}) {
  let next = db;
  const acctCo = company_id ?? 1;
  let cashAcc = accountId(next, '101401', acctCo);
  if (!cashAcc) {
    const c = create(next, 'account.account', { code: `1019${code}`, name: `${name} Cash`, account_type: 'asset_cash', company_id: acctCo });
    next = c.db;
    cashAcc = c.id;
  }
  let suspAcc = accountId(next, '101404', acctCo);
  if (!suspAcc) {
    const s = create(next, 'account.account', { code: `1049${code}`, name: `${name} Suspense`, account_type: 'asset_current', company_id: acctCo });
    next = s.db;
    suspAcc = s.id;
  }
  let outRec = accountId(next, '101402', acctCo);
  if (!outRec) {
    const r = create(next, 'account.account', { code: `1029${code}`, name: `${name} Receipts`, account_type: 'asset_current', company_id: acctCo });
    next = r.db;
    outRec = r.id;
  }
  let outPay = accountId(next, '101403', acctCo);
  if (!outPay) {
    const p = create(next, 'account.account', { code: `1039${code}`, name: `${name} Payments`, account_type: 'liability_current', company_id: acctCo });
    next = p.db;
    outPay = p.id;
  }
  return create(next, 'account.journal', {
    name,
    code,
    type: 'bank',
    company_id,
    default_account_id: cashAcc,
    suspense_account_id: suspAcc,
    outstanding_receipts_account_id: outRec,
    outstanding_payments_account_id: outPay,
  });
}

async function portalFixture(tCtx, dbInit) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  tCtx.after(() => sql.close());
  let db = dbInit;
  const services = {
    sql,
    getDb: () => db,
    commitDb: (next) => { db = next; },
    sessionUser: () => null,
    allowedFor: () => null,
    clientIp: () => 'test',
    tooMany: () => false,
    recordFailure: () => {},
    readRaw: async (req) => Buffer.from(req._body ?? '', 'utf8'),
    env: { MIZAN_DEMO_PAYMENTS: '1', NODE_ENV: 'test' },
    securityHeaders: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'" },
  };
  const portal = createPortal(services);
  const req = async (path, { method = 'GET', headers = {}, body } = {}) => {
    let status = 200;
    let outHeaders = {};
    let outBody = '';
    const res = {
      writeHead(s, h = {}) {
        status = s;
        outHeaders = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
      },
      end(chunk = '') {
        outBody = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      },
    };
    const rawBody = body?.toString() ?? '';
    const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const fakeReq = {
      method,
      url: path,
      headers: {
        ...normalizedHeaders,
        ...(body == null ? {} : { 'content-length': String(Buffer.byteLength(rawBody)) }),
      },
      _body: rawBody,
      resume() {},
    };
    await portal.handle(fakeReq, res);
    return { status, headers: outHeaders, body: outBody };
  };
  return { portal, db: () => db, setDb: (next) => { db = next; }, req, base: 'http://portal.test' };
}

test('1: offline audit trail excludes ordinary chatter notes and keeps only tracking events while sync still protects financial messages', async () => {
  let db = seed();
  const inv = makeInvoice(db, { price: 300 });
  db = inv.db;
  db = postNote(db, 'account.move', inv.id, 'Ordinary internal comment on invoice');

  const moveTracking = db.messages.find((m) => m.model === 'account.move' && m.res_id === inv.id && m.kind === 'tracking');
  const moveNote = db.messages.find((m) => m.model === 'account.move' && m.res_id === inv.id && m.kind === 'note' && m.body.includes('Ordinary internal comment'));
  assert.ok(moveTracking, 'posted invoice has a tracking message');
  assert.ok(moveNote, 'posted invoice has the ordinary chatter note');

  assert.equal(isAuditTrackingMessage(moveTracking), true);
  assert.equal(isAuditTrackingMessage(moveNote), false);
  const legacyNoKind = {
    id: 'legacy-move-no-kind',
    model: 'account.move',
    res_id: inv.id,
    body: 'Legacy tracking entry without kind',
    author: 'Tester',
    date: new Date().toISOString(),
  };
  assert.equal(isAuditTrackingMessage(legacyNoKind), true);
  for (const model of ['account.move', 'account.payment', 'account.account', 'account.tax']) {
    assert.equal(isAuditTrackingMessage({ model, kind: 'note', body: 'Hello' }), false);
    assert.equal(isAuditTrackingMessage({ model, kind: 'tracking', field: 'state' }), true);
    assert.equal(isAuditTrackingMessage({ model, body: 'No kind' }), true);
  }

  const withLegacy = { ...db, messages: [...db.messages, legacyNoKind] };
  const rows = collectAuditTrailRows(withLegacy, withLegacy, {});
  assert.ok(rows.some((r) => r.id === moveTracking.id), 'tracking row appears in offline audit trail');
  assert.ok(rows.some((r) => r.id === legacyNoKind.id), 'message with no kind on account.move IS an audit-trail row');
  assert.ok(!rows.some((r) => r.id === moveNote.id), 'ordinary chatter note is excluded from offline audit trail rows');

  const csv = auditTrailToCsv(rows);
  assert.ok(!csv.includes('Ordinary internal comment on invoice'), 'ordinary chatter note is excluded from offline audit trail CSV');

  // Protected financial messages (including notes on non-admin account.move and on payment/account/tax) remain protected against client deletion.
  const withoutNote = { ...db, messages: db.messages.filter((m) => m.id !== moveNote.id) };
  const afterSync = applyDiff(db, diffDb(db, withoutNote), { company: 1, role: 'accountant' });
  assert.ok(afterSync.messages.some((m) => m.id === moveNote.id), 'client cannot remove note from protected move via sync');
});

test('2a: createInvoiceCheckout reuses matching pending tx, cancels stale on residual/provider change, and keeps cancelled webhook rejected', () => {
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  const wire = search(db, 'payment.provider').find((p) => p.code === 'wire');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const altProvider = create(db, 'payment.provider', {
    name: 'Demo Alt',
    code: 'demo',
    state: 'enabled',
    company_id: 1,
    journal_id: wire.journal_id ?? demo.journal_id,
  });
  db = altProvider.db;

  const inv = makeInvoice(db, { price: 300 });
  db = inv.db;

  // Two checkouts in a row -> one pending tx and identical redirectUrl.
  const first = createInvoiceCheckout(db, inv.id, demo.id, { baseUrl: 'https://p.test', returnUrl: '/ret' });
  const second = createInvoiceCheckout(first.db, inv.id, demo.id, { baseUrl: 'https://p.test', returnUrl: '/ret' });
  const pendingAfterTwo = search(second.db, 'payment.transaction').filter((tx) => tx.move_id === inv.id && tx.state === 'pending');
  assert.equal(pendingAfterTwo.length, 1);
  assert.equal(second.transaction.id, first.transaction.id);
  assert.equal(second.redirectUrl, first.redirectUrl);

  // Residual changed between checkouts -> old cancelled, one new pending for updated residual.
  const bnk1 = search(second.db, 'account.journal').find((j) => j.type === 'bank' && j.code === 'BNK1');
  const partial = registerPayment(second.db, read(second.db, 'account.move', inv.id), { amount: 100, date: '2026-04-11', journal_id: bnk1.id });
  db = partial.db;
  assert.equal(residual(read(db, 'account.move', inv.id), db), 200);
  const third = createInvoiceCheckout(db, inv.id, demo.id, { baseUrl: 'https://p.test', returnUrl: '/ret' });
  assert.notEqual(third.transaction.id, first.transaction.id);
  assert.equal(read(third.db, 'payment.transaction', first.transaction.id).state, 'superseded');
  assert.equal(third.transaction.state, 'pending');
  assert.equal(third.transaction.amount, 200);
  assert.equal(search(third.db, 'payment.transaction').filter((tx) => tx.move_id === inv.id && tx.state === 'pending').length, 1);

  // Different provider -> previous superseded, one new pending.
  const fourth = createInvoiceCheckout(third.db, inv.id, altProvider.id, { baseUrl: 'https://p.test', returnUrl: '/ret' });
  assert.notEqual(fourth.transaction.id, third.transaction.id);
  assert.equal(read(fourth.db, 'payment.transaction', third.transaction.id).state, 'superseded');
  assert.equal(search(fourth.db, 'payment.transaction').filter((tx) => tx.move_id === inv.id && tx.state === 'pending').length, 1);

  // Webhook for cancelled transaction stays rejected without mutating db.
  const cancelledDb = write(fourth.db, 'payment.transaction', fourth.transaction.id, { state: 'cancel' });
  const secret = 'test-secret-q119c';
  const cancelledBody = JSON.stringify({
    reference: fourth.transaction.reference,
    amount: fourth.transaction.amount,
    currency: 'USD',
    status: 'paid',
  });
  assert.throws(
    () => processPaymentWebhook(cancelledDb, { providerCode: 'demo', rawBody: cancelledBody, signature: signWebhookPayload(cancelledBody, secret), secret }),
    (err) => err instanceof WebhookError && err.code === 'INVALID_TRANSACTION_STATE' && err.status === 400,
  );
});

test('2b: ecommerce paymentTransactionGuard rejects forged second pending transaction through applyDiff and has Arabic translation', async () => {
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = makeInvoice(db, { price: 150 });
  const first = createInvoiceCheckout(inv.db, inv.id, demo.id, { baseUrl: 'https://p.test' });
  db = first.db;

  assert.throws(
    () => applyDiff(db, {
      upserts: {
        'payment.transaction': [{
          id: 999001,
          reference: 'FORGED-SECOND-PENDING',
          provider_id: demo.id,
          provider_code: 'demo',
          move_id: inv.id,
          partner_id: 1,
          amount: 150,
          currency_id: read(db, 'res.company', 1).currency_id,
          state: 'pending',
          company_id: 1,
        }],
      },
    }),
    /pending/i,
  );

  const tAr = await loadArabicT();
  const en = 'An active pending payment transaction already exists for this invoice';
  assert.notEqual(tAr(en), en, 'missing Arabic translation for duplicate pending payment transaction');
});

test('2c: portal POST pay twice for the same invoice creates only one pending transaction and returns the same redirect', async (tCtx) => {
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = makeInvoice(db, { price: 180 });
  db = inv.db;

  const p = await portalFixture(tCtx, db);
  const invUrl = p.portal.portalUrl('account.move', read(p.db(), 'account.move', inv.id));
  const token = new URL(invUrl, p.base).searchParams.get('access_token');
  const postPay = (providerId) => p.req(`/my/invoices/${inv.id}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: token, provider_id: String(providerId) }),
  });

  const r1 = await postPay(demo.id);
  const r2 = await postPay(demo.id);
  assert.equal(r1.status, 303);
  assert.equal(r2.status, 303);
  assert.equal(r2.headers.location, r1.headers.location);
  const txs = search(p.db(), 'payment.transaction').filter((tx) => tx.move_id === inv.id && tx.state === 'pending');
  assert.equal(txs.length, 1);
});

test('3: BankReconcile and eligiblePayments include posted payments from another bank journal of the same company and filter wrong company or direction', async () => {
  const { eligiblePayments, matchPayment } = await import('./models/bank.js');

  let db = seed();
  const bnk1 = search(db, 'account.journal').find((j) => j.type === 'bank' && j.code === 'BNK1');
  const bnk2Res = makeBankJournal(db, { name: 'Bank Two', code: 'BNK2', company_id: 1 });
  const bnk2 = read(bnk2Res.db, 'account.journal', bnk2Res.id);
  const co2 = createCompany(bnk2Res.db, { name: 'Company 2', currency: 'USD', coa: 'us' });
  const bnkCo2Res = makeBankJournal(co2.db, { name: 'Bank Co2', code: 'BNKC2', company_id: co2.id });
  const bnkCo2 = read(bnkCo2Res.db, 'account.journal', bnkCo2Res.id);
  db = bnkCo2Res.db;

  const p1 = create(db, 'res.partner', { name: 'Same-Co Partner' }).db;
  const p2 = create(p1, 'res.partner', { name: 'Other-Co Partner', company_id: co2.id }).db;
  const cust = search(p2, 'res.partner').find((r) => r.name === 'Same-Co Partner');
  const otherCust = search(p2, 'res.partner').find((r) => r.name === 'Other-Co Partner');

  const inBnk2 = create(p2, 'account.payment', {
    partner_id: cust.id, company_id: 1, journal_id: bnk2.id, amount: 410, date: '2026-04-02', payment_type: 'inbound', partner_type: 'customer',
  });
  db = postPayment(inBnk2.db, read(inBnk2.db, 'account.payment', inBnk2.id));

  const outBnk2 = create(db, 'account.payment', {
    partner_id: cust.id, company_id: 1, journal_id: bnk2.id, amount: 410, date: '2026-04-02', payment_type: 'outbound', partner_type: 'supplier',
  });
  db = postPayment(outBnk2.db, read(outBnk2.db, 'account.payment', outBnk2.id));

  const otherCoPay = create(db, 'account.payment', {
    partner_id: otherCust.id, company_id: co2.id, journal_id: bnkCo2.id, amount: 410, date: '2026-04-02', payment_type: 'inbound', partner_type: 'customer',
  });
  db = postPayment(otherCoPay.db, read(otherCoPay.db, 'account.payment', otherCoPay.id));

  const stLineRes = create(db, 'account.bank.statement.line', {
    journal_id: bnk1.id, company_id: 1, date: '2026-04-03', amount: 410, payment_ref: 'BNK1-LINE-410',
  });
  db = stLineRes.db;
  const line = read(db, 'account.bank.statement.line', stLineRes.id);

  const list = eligiblePayments(db, line);
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes(inBnk2.id), 'inbound posted payment on BNK2 of same company is eligible for BNK1 line');
  assert.ok(!ids.includes(outBnk2.id), 'wrong-direction payment is excluded');
  assert.ok(!ids.includes(otherCoPay.id), 'other-company payment is excluded');

  // Verify UI renders the BNK2 payment inside BankReconcile Outstanding Payments tab.
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  await initStore();
  await commit(db);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile, { leaf: { key: 'reconcile', type: 'bankReconcile' } })));
    const stBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('BNK1-LINE-410'));
    await React.act(async () => props(stBtn).onClick());
    const payTab = find(host, (n) => props(n)?.role === 'tab' && n.textContent.includes('Outstanding Payments'));
    await React.act(async () => props(payTab).onClick());
    const inName = read(db, 'account.payment', inBnk2.id).name;
    const outName = read(db, 'account.payment', outBnk2.id).name;
    const otherName = read(db, 'account.payment', otherCoPay.id).name;
    assert.ok(host.textContent.includes(inName), 'BankReconcile shows BNK2 inbound payment');
    assert.ok(!host.textContent.includes(outName), 'BankReconcile hides wrong-direction payment');
    assert.ok(!host.textContent.includes(otherName), 'BankReconcile hides other-company payment');
  } finally {
    await React.act(async () => root.unmount());
  }

  // Matching through matchPayment succeeds cleanly.
  const matched = matchPayment(db, { ...line, payment_id: inBnk2.id });
  assert.equal(read(matched.db, 'account.bank.statement.line', line.id).state, 'reconciled');
});

test('4: company-2 online link/account rejects journal without company_id with translated error while company 1 accepts it', async () => {
  let db = seed();
  const co2 = createCompany(db, { name: 'Co Two', currency: 'USD', coa: 'us' });
  db = co2.db;

  const sharedBank = makeBankJournal(db, { name: 'Companyless Bank', code: 'NOCOMP', company_id: null });
  db = sharedBank.db;

  // Company-2 connection + journal without company_id rejected by linkGuard (inline account_ids).
  assert.throws(
    () => create(db, LINK_MODEL, {
      name: 'Co2 Conn',
      provider: 'demo',
      company_id: co2.id,
      account_ids: [{ name: 'Acc', account_number: '111', journal_id: sharedBank.id }],
    }),
    /The linked journal must belong to the same company as the connection/,
  );

  // Company-2 connection without inline accounts created, then account.online.account linked -> rejected by onlineAccountGuard.
  const co2Conn = create(db, LINK_MODEL, { name: 'Co2 Empty', provider: 'demo', company_id: co2.id });
  db = co2Conn.db;
  assert.throws(
    () => create(db, ACCOUNT_MODEL, {
      name: 'Co2 Online Acc',
      link_id: co2Conn.id,
      company_id: co2.id,
      account_number: '222',
      journal_id: sharedBank.id,
    }),
    /The linked journal must belong to the same company as the connection/,
  );

  // Bypass attempt via applyDiff also rejected by onlineAccountGuard.
  assert.throws(
    () => applyDiff(db, {
      upserts: {
        [ACCOUNT_MODEL]: [{
          id: 998001,
          name: 'Diff Co2 Acc',
          link_id: co2Conn.id,
          company_id: co2.id,
          account_number: '333',
          journal_id: sharedBank.id,
        }],
      },
    }),
    /The linked journal must belong to the same company as the connection/,
  );

  // Field domain excludes companyless journal for Company 2 while keeping it for Company 1.
  const jRec = read(db, 'account.journal', sharedBank.id);
  const co2Domain = models[ACCOUNT_MODEL].fields.journal_id.domain;
  const linkDomain = models[LINK_MODEL].fields.account_ids.fields.journal_id.domain;
  assert.equal(co2Domain(jRec, { company_id: co2.id }), false);
  assert.equal(linkDomain(jRec, { company_id: co2.id }), false);
  assert.equal(co2Domain(jRec, { company_id: 1 }), true);

  // Company 1 accepts journal without company_id (since importStatementLines treats it as company 1).
  const co1Conn = create(db, LINK_MODEL, {
    name: 'Co1 Conn',
    provider: 'demo',
    company_id: 1,
    account_ids: [{ name: 'Co1 Acc', account_number: '444', journal_id: sharedBank.id }],
  });
  assert.ok(read(co1Conn.db, LINK_MODEL, co1Conn.id));

  // Verify Arabic translation is present for the error.
  const tAr = await loadArabicT();
  const msg = 'The linked journal must belong to the same company as the connection';
  assert.notEqual(tAr(msg), msg);
});
