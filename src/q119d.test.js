import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { create, messagesOf, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff } from './sync.js';
import { models, writableModelsForApps } from './models/index.js';
import { createCompany } from './models/company.js';
import { accountId } from './models/ledger.js';
import { postMove, registerPayment, residual } from './models/accounting.js';
import {
  createInvoiceCheckout,
  PAYMENT_ADAPTERS,
  processPaymentWebhook,
  providerPaymentJournal,
  signWebhookPayload,
  WebhookError,
} from './models/paymentAdapter.js';
import { createPortal } from '../server/portal.js';
import { handlePaymentWebhook, routePaymentWebhook } from '../server/paymentWebhook.js';

const loadArabicT = async () => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {} };
  try {
    return (await import(`./i18n.js?ar_q119d=${Date.now()}`)).t;
  } finally {
    globalThis.localStorage = prev;
  }
};

function makeInvoice(db, { partnerId = 1, price = 250, companyId = 1, date = '2026-04-10', journalId = null } = {}) {
  const income = search(db, 'account.account').find((a) => a.account_type === 'income' && (a.company_id ?? 1) === companyId);
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    company_id: companyId,
    ...(journalId ? { journal_id: journalId } : {}),
    invoice_date: date,
    invoice_line_ids: [{ product_id: 5, ...(income ? { account_id: income.id } : {}), qty: 1, price_unit: price, tax: 0 }],
  });
  return { db: postMove(inv.db, inv.id), id: inv.id };
}

function makeSaleJournal(db, companyId, code = `SAL${companyId}`) {
  let next = db;
  let income = search(next, 'account.account').find((a) => a.account_type === 'income' && (a.company_id ?? 1) === companyId);
  if (!income) {
    const inc = create(next, 'account.account', { code: `400${companyId}`, name: `Sales Income ${companyId}`, account_type: 'income', company_id: companyId });
    next = inc.db;
    income = read(next, 'account.account', inc.id);
  }
  return create(next, 'account.journal', {
    name: `Sales ${companyId}`,
    code,
    type: 'sale',
    company_id: companyId,
    default_account_id: income.id,
    default_for_invoices: true,
    invoice_sequence_prefix: `INV${companyId}/`,
    invoice_sequence_next_number: 1,
  });
}

function makeBankJournal(db, { name = 'Second Bank', code = 'BNK2', company_id = 1, defaultForPayments = false, active = true } = {}) {
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
    active,
    default_for_payments: defaultForPayments,
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
  const portal = createPortal({
    sql,
    getDb: () => db,
    commitDb: (next) => { db = next; },
    sessionUser: () => null,
    allowedFor: () => null,
    clientIp: () => '127.0.0.1',
    tooMany: () => false,
    recordFailure: () => {},
    readRaw: async (req) => Buffer.from(req._body ?? '', 'utf8'),
    env: { MIZAN_DEMO_PAYMENTS: '1', NODE_ENV: 'test', MIZAN_PUBLIC_URL: 'https://portal.test' },
    securityHeaders: { 'X-Frame-Options': 'DENY' },
  });
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
    await portal.handle({
      method,
      url: path,
      headers: {
        host: 'portal.test',
        ...normalizedHeaders,
        ...(body == null ? {} : { 'content-length': String(Buffer.byteLength(rawBody)) }),
      },
      _body: rawBody,
      resume() {},
    }, res);
    return { status, headers: outHeaders, body: outBody };
  };
  return { portal, db: () => db, setDb: (next) => { db = next; }, req, base: 'https://portal.test' };
}

const makeRes = () => {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    writeHead(status, headers = {}) { out.status = status; out.headers = headers; },
    end(body = '') { out.body = typeof body === 'string' ? body : Buffer.from(body).toString('utf8'); },
  };
};

test('1a: createInvoiceCheckout resolves payment journal with same helper and rejects unconfigured providers without creating or superseding transactions', () => {
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });

  // Valid default journal resolves identically for checkout and webhook helper.
  const resolved = providerPaymentJournal(db, read(db, 'payment.provider', demo.id), 1);
  assert.ok(resolved?.id);

  // Company 2 with no default payment journal and provider with journal_id=null cannot settle.
  const co2 = createCompany(db, { name: 'Company 2', currency: 'USD', coa: 'us' });
  const co2Sale = makeSaleJournal(co2.db, co2.id);
  db = co2Sale.db;
  const pCo2 = create(db, 'res.partner', { name: 'Co2 Customer', company_id: co2.id, customer_rank: 1 });
  db = pCo2.db;
  const co2Inv = makeInvoice(db, { partnerId: pCo2.id, price: 120, companyId: co2.id, journalId: co2Sale.id });
  db = co2Inv.db;
  const co2Demo = create(db, 'payment.provider', { name: 'Co2 Demo No Journal', code: 'demo', state: 'enabled', company_id: co2.id, journal_id: null });
  db = co2Demo.db;

  const txCountBefore = search(db, 'payment.transaction').length;
  assert.throws(
    () => createInvoiceCheckout(db, co2Inv.id, co2Demo.id),
    /payment journal/i,
  );
  assert.equal(search(db, 'payment.transaction').length, txCountBefore);

  // Company 1 invoice with a valid pending transaction, then checkout with provider pointing to archived/non-liquidity/other-company journal -> fails and does NOT supersede existing pending tx.
  const inv1 = makeInvoice(db, { price: 150 });
  db = inv1.db;
  const goodCo = createInvoiceCheckout(db, inv1.id, demo.id, { reference: 'TX-KEEP-PENDING' });
  db = goodCo.db;

  const archivedBank = makeBankJournal(db, { name: 'Archived Bank', code: 'ARCH', company_id: 1, active: false });
  db = archivedBank.db;
  const badArchProvider = create(db, 'payment.provider', { name: 'Demo Archived Journal', code: 'demo', state: 'enabled', company_id: 1, journal_id: archivedBank.id });
  db = badArchProvider.db;

  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const badSaleProvider = create(db, 'payment.provider', { name: 'Demo Sale Journal', code: 'demo', state: 'enabled', company_id: 1, journal_id: saleJournal.id });
  db = badSaleProvider.db;

  const co2Bank = makeBankJournal(db, { name: 'Co2 Bank', code: 'C2BK', company_id: co2.id });
  db = co2Bank.db;
  const badOtherCoProvider = create(db, 'payment.provider', { name: 'Demo Other Co Journal', code: 'demo', state: 'enabled', company_id: 1, journal_id: co2Bank.id });
  db = badOtherCoProvider.db;

  for (const badId of [badArchProvider.id, badSaleProvider.id, badOtherCoProvider.id]) {
    assert.throws(() => createInvoiceCheckout(db, inv1.id, badId), /payment journal/i);
    assert.equal(read(db, 'payment.transaction', goodCo.transaction.id).state, 'pending');
    assert.equal(search(db, 'payment.transaction').length, txCountBefore + 1);
  }
});

test('1b: portal hides providers that cannot settle and rejects direct POST for an unsettleable provider without creating a transaction', async (tCtx) => {
  let db = seed();
  const co2 = createCompany(db, { name: 'Company 2', currency: 'USD', coa: 'us' });
  const co2Sale = makeSaleJournal(co2.db, co2.id);
  db = co2Sale.db;
  const pCo2 = create(db, 'res.partner', { name: 'Portal Co2 Customer', company_id: co2.id, customer_rank: 1 });
  db = pCo2.db;
  const co2Inv = makeInvoice(db, { partnerId: pCo2.id, price: 180, companyId: co2.id, journalId: co2Sale.id });
  db = co2Inv.db;

  // One enabled demo provider with no journal (cannot settle on Co2) and one with an archived Co2 journal (cannot settle).
  const noJournalProvider = create(db, 'payment.provider', { name: 'Broken Demo No Journal', code: 'demo', state: 'enabled', company_id: co2.id, journal_id: null });
  db = noJournalProvider.db;
  const archCo2Journal = makeBankJournal(db, { name: 'Co2 Archived', code: 'C2AR', company_id: co2.id, active: false });
  db = archCo2Journal.db;
  const archProvider = create(db, 'payment.provider', { name: 'Broken Demo Archived', code: 'demo', state: 'enabled', company_id: co2.id, journal_id: archCo2Journal.id });
  db = archProvider.db;

  const p = await portalFixture(tCtx, db);
  const invUrl = p.portal.portalUrl('account.move', read(p.db(), 'account.move', co2Inv.id));
  const token = new URL(invUrl, p.base).searchParams.get('access_token');

  // Neither broken provider is offered on the portal page.
  const pageRes = await p.req(invUrl);
  assert.equal(pageRes.status, 200);
  assert.ok(!pageRes.body.includes('Broken Demo No Journal'));
  assert.ok(!pageRes.body.includes('Broken Demo Archived'));
  assert.ok(!pageRes.body.includes('Pay online'));

  // Direct POST for broken provider is rejected and creates no transaction.
  const postBroken = await p.req(`/my/invoices/${co2Inv.id}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: token, provider_id: String(noJournalProvider.id) }),
  });
  assert.equal(postBroken.status, 303);
  assert.ok(postBroken.headers.location.includes('message='));
  assert.equal(search(p.db(), 'payment.transaction').length, 0);

  // Add a valid Co2 journal + enabled provider: ONLY that provider is offered and checkout works.
  const validCo2Bank = makeBankJournal(p.db(), { name: 'Co2 Valid Bank', code: 'C2OK', company_id: co2.id });
  let nextDb = validCo2Bank.db;
  const validProvider = create(nextDb, 'payment.provider', { name: 'Working Demo Co2', code: 'demo', state: 'enabled', company_id: co2.id, journal_id: validCo2Bank.id });
  nextDb = validProvider.db;
  p.setDb(nextDb);

  const pageWithValid = await p.req(invUrl);
  assert.equal(pageWithValid.status, 200);
  assert.ok(pageWithValid.body.includes('Working Demo Co2'));
  assert.ok(!pageWithValid.body.includes('Broken Demo No Journal'));
  assert.ok(!pageWithValid.body.includes('Broken Demo Archived'));

  const postValid = await p.req(`/my/invoices/${co2Inv.id}/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: token, provider_id: String(validProvider.id) }),
  });
  assert.equal(postValid.status, 303);
  assert.ok(postValid.headers.location.includes(`/my/invoices/${co2Inv.id}/pay/demo`));
  assert.equal(search(p.db(), 'payment.transaction').length, 1);
});

test('2a: superseded checkout A settles on paid webhook, checkout B books excess as unapplied credit, and replay of both is a no-op', () => {
  const secret = 'q119d-superseded-secret';
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);

  const inv = makeInvoice(db, { price: 300 });
  db = inv.db;

  // Checkout A for full 300.
  const checkoutA = createInvoiceCheckout(db, inv.id, demo.id, { reference: 'TX-SUPER-A' });
  db = checkoutA.db;
  assert.equal(checkoutA.transaction.amount, 300);
  assert.equal(checkoutA.transaction.state, 'pending');

  // Residual changes via partial payment of 100 -> residual becomes 200.
  db = registerPayment(db, read(db, 'account.move', inv.id), { amount: 100, date: '2026-04-11', journal_id: bankJournal.id }).db;
  assert.equal(residual(read(db, 'account.move', inv.id), db), 200);

  // Checkout B for 200 supersedes A.
  const checkoutB = createInvoiceCheckout(db, inv.id, demo.id, { reference: 'TX-SUPER-B' });
  db = checkoutB.db;
  assert.equal(read(db, 'payment.transaction', checkoutA.transaction.id).state, 'superseded');
  assert.equal(read(db, 'payment.transaction', checkoutB.transaction.id).state, 'pending');
  assert.equal(checkoutB.transaction.amount, 200);

  // Paid webhook for superseded checkout A (300) arrives -> payment booked, invoice residual reduced to 0, A becomes done, excess 100 is unapplied credit, chatter note mentions superseded checkout.
  const bodyA = JSON.stringify({ reference: 'TX-SUPER-A', amount: 300, currency: 'USD', status: 'paid', date: '2026-04-12' });
  const sigA = signWebhookPayload(bodyA, secret);
  const resA = processPaymentWebhook(db, { providerCode: 'demo', rawBody: bodyA, signature: sigA, secret });
  assert.equal(resA.alreadyProcessed, false);
  db = resA.db;

  assert.equal(residual(read(db, 'account.move', inv.id), db), 0);
  assert.equal(read(db, 'account.move', inv.id).payment_state, 'paid');
  const txA = read(db, 'payment.transaction', checkoutA.transaction.id);
  assert.equal(txA.state, 'done');
  assert.ok(txA.payment_id);
  const payA = read(db, 'account.payment', txA.payment_id);
  assert.equal(payA.state, 'posted');
  assert.equal(payA.amount, 300);
  assert.equal(payA.unapplied, 100);
  assert.ok(messagesOf(db, 'account.move', inv.id).some((m) => /superseded checkout/i.test(m.body)));

  // Paid webhook for checkout B (200) arrives -> booked as unapplied credit (200), invoice residual stays 0.
  const bodyB = JSON.stringify({ reference: 'TX-SUPER-B', amount: 200, currency: 'USD', status: 'paid', date: '2026-04-12' });
  const sigB = signWebhookPayload(bodyB, secret);
  const resB = processPaymentWebhook(db, { providerCode: 'demo', rawBody: bodyB, signature: sigB, secret });
  assert.equal(resB.alreadyProcessed, false);
  assert.equal(resB.status, 'unapplied_credit');
  db = resB.db;

  assert.equal(residual(read(db, 'account.move', inv.id), db), 0);
  const txB = read(db, 'payment.transaction', checkoutB.transaction.id);
  assert.equal(txB.state, 'done');
  assert.ok(txB.payment_id);
  const payB = read(db, 'account.payment', txB.payment_id);
  assert.equal(payB.state, 'posted');
  assert.equal(payB.amount, 200);
  assert.equal(payB.unapplied, 200);

  // Replay of both webhooks is an idempotent no-op.
  const replayA = processPaymentWebhook(db, { providerCode: 'demo', rawBody: bodyA, signature: sigA, secret });
  assert.equal(replayA.alreadyProcessed, true);
  assert.equal(replayA.db, db);
  const replayB = processPaymentWebhook(db, { providerCode: 'demo', rawBody: bodyB, signature: sigB, secret });
  assert.equal(replayB.alreadyProcessed, true);
  assert.equal(replayB.db, db);
});

test('2b: superseded settlement with open residual reduces residual without excess and rejects invalid transitions via applyDiff', async () => {
  const secret = 'q119d-guard-secret';
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  const alt = create(db, 'payment.provider', { name: 'Demo 2', code: 'demo', state: 'enabled', company_id: 1 });
  db = write(alt.db, 'payment.provider', demo.id, { state: 'enabled' });

  const inv = makeInvoice(db, { price: 250 });
  db = inv.db;
  const coA = createInvoiceCheckout(db, inv.id, demo.id, { reference: 'TX-SUP-OPEN-A' });
  const coB = createInvoiceCheckout(coA.db, inv.id, alt.id, { reference: 'TX-SUP-OPEN-B' });
  db = coB.db;

  const supTx = read(db, 'payment.transaction', coA.transaction.id);
  assert.equal(supTx.state, 'superseded');

  // Forged transitions via applyDiff: superseded -> pending, superseded -> cancel, superseded -> error, cancel -> done, error -> done, direct create in superseded.
  const acctOpts = { allowed: writableModelsForApps(['accounting']) };
  for (const target of ['pending', 'cancel', 'error']) {
    assert.throws(() => applyDiff(db, {
      upserts: { 'payment.transaction': [{ ...supTx, state: target }] },
      bases: { 'payment.transaction': { [supTx.id]: { state: 'superseded' } } },
    }, acctOpts), /transition/i);
  }

  const invC = makeInvoice(db, { price: 90 });
  const coC = createInvoiceCheckout(invC.db, invC.id, demo.id, { reference: 'TX-CANCEL-TEST' });
  db = coC.db;
  const cancelledDb = write(db, 'payment.transaction', coC.transaction.id, { state: 'cancel' });
  const cancelledTx = read(cancelledDb, 'payment.transaction', coC.transaction.id);
  assert.throws(() => applyDiff(cancelledDb, {
    upserts: { 'payment.transaction': [{ ...cancelledTx, state: 'done' }] },
    bases: { 'payment.transaction': { [cancelledTx.id]: { state: 'cancel' } } },
  }, acctOpts), /transition/i);

  assert.throws(() => applyDiff(db, {
    upserts: {
      'payment.transaction': [{
        id: 999888,
        reference: 'FORGED-DIRECT-SUPERSEDED',
        move_id: inv.id,
        provider_id: demo.id,
        provider_code: 'demo',
        amount: 250,
        currency_id: read(db, 'res.company', 1).currency_id,
        state: 'superseded',
        company_id: 1,
      }],
    },
  }, acctOpts), /Pending/i);

  // Settle superseded checkout A when residual is still 250 -> settles cleanly with chatter note mentioning superseded checkout.
  const bodyA = JSON.stringify({ reference: 'TX-SUP-OPEN-A', amount: 250, currency: 'USD', status: 'paid', date: '2026-04-12' });
  const settled = processPaymentWebhook(db, { providerCode: 'demo', rawBody: bodyA, signature: signWebhookPayload(bodyA, secret), secret });
  assert.equal(settled.status, 'settled');
  assert.equal(residual(read(settled.db, 'account.move', inv.id), settled.db), 0);
  assert.equal(read(settled.db, 'payment.transaction', coA.transaction.id).state, 'done');
  assert.ok(messagesOf(settled.db, 'account.move', inv.id).some((m) => /superseded checkout/i.test(m.body)));

  // Cancelled tx remains rejected by processPaymentWebhook.
  const cancelBody = JSON.stringify({ reference: 'TX-CANCEL-TEST', amount: 90, currency: 'USD', status: 'paid' });
  assert.throws(
    () => processPaymentWebhook(cancelledDb, { providerCode: 'demo', rawBody: cancelBody, signature: signWebhookPayload(cancelBody, secret), secret }),
    (e) => e instanceof WebhookError && e.code === 'INVALID_TRANSACTION_STATE' && e.signatureVerified === true,
  );
});

test('3a: signed non-paid webhook returns 200 with no db change, parseWebhook returns explicit paid/status, and missing status stays 400', async () => {
  const secret = 'q119d-nonpaid-secret';
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = makeInvoice(db, { price: 140 });
  const co = createInvoiceCheckout(inv.db, inv.id, demo.id, { reference: 'TX-NONPAID-1' });
  db = co.db;

  // parseWebhook returns explicit paid: true/false plus raw status.
  assert.deepEqual(
    PAYMENT_ADAPTERS.demo.parseWebhook({ reference: 'TX-NONPAID-1', status: 'pending', amount: 140, currency: 'usd' }),
    { reference: 'TX-NONPAID-1', paid: false, status: 'pending', amount: 140, currency: 'USD', providerReference: null, date: null },
  );
  assert.throws(
    () => PAYMENT_ADAPTERS.demo.parseWebhook({ reference: 'TX-NONPAID-1', amount: 140, currency: 'USD' }),
    (e) => e instanceof WebhookError && e.status === 400,
  );

  // Signed non-paid webhook returns HTTP 200, explains why it was ignored, leaves db unchanged, and does not call onRejected.
  let commits = 0;
  let rejected = 0;
  for (const status of ['pending', 'failed', 'cancelled']) {
    const raw = JSON.stringify({ reference: 'TX-NONPAID-1', status, amount: 140, currency: 'USD' });
    const res = makeRes();
    await handlePaymentWebhook({
      req: { method: 'POST', headers: { 'x-mizan-signature': signWebhookPayload(raw, secret) } },
      res,
      providerCode: 'demo',
      getDb: () => db,
      commitDb: () => { commits += 1; },
      readRaw: async () => Buffer.from(raw),
      env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
      onRejected: () => { rejected += 1; },
    });
    assert.equal(res.out.status, 200);
    const body = JSON.parse(res.out.body);
    assert.equal(body.ok, true);
    assert.equal(body.ignored, true);
    assert.equal(body.status, 'ignored');
    assert.equal(body.providerStatus, status);
    assert.match(body.reason, new RegExp(status));
    assert.equal(commits, 0);
    assert.equal(rejected, 0);
    assert.equal(read(db, 'payment.transaction', co.transaction.id).state, 'pending');
    assert.equal(residual(read(db, 'account.move', inv.id), db), 140);
  }

  // Signed payload with MISSING status returns 400, carries signatureVerified: true, and does NOT call onRejected.
  assert.throws(
    () => processPaymentWebhook(db, { providerCode: 'demo', rawBody: JSON.stringify({ reference: 'TX-NONPAID-1', amount: 140, currency: 'USD' }), signature: signWebhookPayload(JSON.stringify({ reference: 'TX-NONPAID-1', amount: 140, currency: 'USD' }), secret), secret }),
    (e) => e instanceof WebhookError && e.status === 400 && e.signatureVerified === true,
  );
  assert.throws(
    () => processPaymentWebhook(db, { providerCode: 'demo', rawBody: JSON.stringify({ reference: 'TX-NONPAID-1', status: 'paid', amount: 140, currency: 'USD' }), signature: 'bad-sig', secret }),
    (e) => e instanceof WebhookError && e.status === 401 && e.signatureVerified === false,
  );
  const missingStatusRaw = JSON.stringify({ reference: 'TX-NONPAID-1', amount: 140, currency: 'USD' });
  const missingRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', headers: { 'x-mizan-signature': signWebhookPayload(missingStatusRaw, secret) } },
    res: missingRes,
    providerCode: 'demo',
    getDb: () => db,
    commitDb: () => { commits += 1; },
    readRaw: async () => Buffer.from(missingStatusRaw),
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
    onRejected: () => { rejected += 1; },
  });
  assert.equal(missingRes.out.status, 400);
  assert.equal(rejected, 0);
});

test('3b: routePaymentWebhook limits pre-signature failures at 10 while allowing 15 signed non-paid + signed business rejections then valid paid webhook from one IP', async () => {
  const secret = 'q119d-ratelimit-secret';
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = makeInvoice(db, { price: 210 });
  const co = createInvoiceCheckout(inv.db, inv.id, demo.id, { reference: 'TX-RL-1' });
  db = co.db;

  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE rate_events (key TEXT NOT NULL, at INTEGER NOT NULL)');
  const WINDOW = 15 * 60 * 1000;
  const hits = (k) => sql.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND at > ?').get(k, Date.now() - WINDOW).n;
  const tooMany = (k) => hits(k) >= 10;
  const recordFailure = (k) => sql.prepare('INSERT INTO rate_events (key, at) VALUES (?, ?)').run(k, Date.now());
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
  };

  const callRoute = async (ip, { method = 'POST', providerCode = 'demo', rawBody = '', signature = '' } = {}) => {
    const res = makeRes();
    await routePaymentWebhook({
      req: { method, headers: { 'x-mizan-signature': signature } },
      res,
      providerCode,
      ip,
      hits,
      tooMany,
      recordFailure,
      send,
      getDb: () => db,
      commitDb: (next) => { db = next; },
      readRaw: async () => Buffer.from(rawBody),
      env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
    });
    return res.out;
  };

  // 15 correctly signed non-paid notifications from 10.0.0.5 -> all 200, no 429.
  for (let i = 0; i < 15; i += 1) {
    const raw = JSON.stringify({ reference: 'TX-RL-1', status: 'pending', amount: 210, currency: 'USD' });
    const out = await callRoute('10.0.0.5', { rawBody: raw, signature: signWebhookPayload(raw, secret) });
    assert.equal(out.status, 200);
  }
  assert.equal(hits('payhook:10.0.0.5'), 0);

  // Also 5 correctly signed business rejections (e.g. unknown ref / wrong amount) -> 400, still no pre-signature failure recorded.
  for (let i = 0; i < 5; i += 1) {
    const raw = JSON.stringify({ reference: `UNKNOWN-${i}`, status: 'paid', amount: 210, currency: 'USD' });
    const out = await callRoute('10.0.0.5', { rawBody: raw, signature: signWebhookPayload(raw, secret) });
    assert.equal(out.status, 400);
  }
  assert.equal(hits('payhook:10.0.0.5'), 0);

  // Then a signed paid notification from the same IP -> 200 and invoice settled!
  const paidRaw = JSON.stringify({ reference: 'TX-RL-1', status: 'paid', amount: 210, currency: 'USD', date: '2026-04-12' });
  const paidOut = await callRoute('10.0.0.5', { rawBody: paidRaw, signature: signWebhookPayload(paidRaw, secret) });
  assert.equal(paidOut.status, 200);
  assert.equal(residual(read(db, 'account.move', inv.id), db), 0);
  assert.equal(read(db, 'payment.transaction', co.transaction.id).state, 'done');

  // 11 bad signatures from 10.0.0.9 -> first 10 return 401, 11th returns 429!
  for (let i = 0; i < 10; i += 1) {
    const out = await callRoute('10.0.0.9', { rawBody: paidRaw, signature: 'bad-sig' });
    assert.equal(out.status, 401);
  }
  const blockedOut = await callRoute('10.0.0.9', { rawBody: paidRaw, signature: signWebhookPayload(paidRaw, secret) });
  assert.equal(blockedOut.status, 429);

  // Per-window total traffic budget also enforces maxPerWindow cap (independent of pre-signature failures).
  for (let i = 0; i < 3; i += 1) {
    const raw = JSON.stringify({ reference: 'TX-RL-1', status: 'pending', amount: 210, currency: 'USD' });
    const res = makeRes();
    await routePaymentWebhook({
      req: { method: 'POST', headers: { 'x-mizan-signature': signWebhookPayload(raw, secret) } },
      res,
      providerCode: 'demo',
      ip: '10.0.0.12',
      hits,
      tooMany,
      recordFailure,
      maxPerWindow: 3,
      send,
      getDb: () => db,
      commitDb: (next) => { db = next; },
      readRaw: async () => Buffer.from(raw),
      env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
    });
    assert.equal(res.out.status, 200);
  }
  const budgetRes = makeRes();
  await routePaymentWebhook({
    req: { method: 'POST', headers: { 'x-mizan-signature': signWebhookPayload(paidRaw, secret) } },
    res: budgetRes,
    providerCode: 'demo',
    ip: '10.0.0.12',
    hits,
    tooMany,
    recordFailure,
    maxPerWindow: 3,
    send,
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async () => Buffer.from(paidRaw),
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
  });
  assert.equal(budgetRes.out.status, 429);

  // server/index.js declares PAYMENT_WEBHOOKS_PER_WINDOW alongside WHATSAPP_HOOKS_PER_WINDOW and uses routePaymentWebhook.
  const indexSrc = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(indexSrc, /const PAYMENT_WEBHOOKS_PER_WINDOW\s*=\s*\d+/);
  assert.match(indexSrc, /routePaymentWebhook\(/);

  sql.close();
});

test('4: all new q119d options and error messages have non-identical Arabic translations', async () => {
  const tAr = await loadArabicT();
  const stateOptions = models['payment.transaction'].fields.state.options;
  assert.ok(stateOptions.some(([k, label]) => k === 'superseded' && label === 'Superseded'));
  for (const s of [
    'Superseded',
    'Selected payment provider does not have a valid payment journal configured',
    'Missing payment status in webhook',
  ]) {
    assert.notEqual(tAr(s), s, `Missing Arabic translation in src/i18n.js for: ${s}`);
  }
});
