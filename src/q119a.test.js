import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import './models/index.js';
import { create, messagesOf, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { postMove, registerPayment, residual } from './models/accounting.js';
import { applyPaymentCredit, postPayment } from './models/pay.js';
import { partnerFollowUp, runFollowUps } from './models/finance.js';
import { createInvoiceCheckout, processPaymentWebhook, signWebhookPayload, WebhookError } from './models/paymentAdapter.js';
import { createMailTransport } from '../server/mailTransport.js';
import { handlePaymentWebhook } from '../server/paymentWebhook.js';
import { applyDiff } from './sync.js';
import { writableModelsForApps } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const sumBalances = (db) => {
  for (const move of db.records['account.move'] ?? []) {
    if (move.state !== 'posted') continue;
    const debit = (move.line_ids ?? []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const credit = (move.line_ids ?? []).reduce((s, l) => s + (Number(l.credit) || 0), 0);
    assert.ok(Math.abs(debit - credit) < 1e-6, `Move ${move.name} out of balance: ${debit} != ${credit}`);
  }
};

const makeRes = () => {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(body) { out.body = body ?? ''; },
  };
};

test('listAuditAll paginates with models and before against /api/audit', async () => {
  const { listAuditAll } = await import('./store.js');
  const origFetch = globalThis.fetch;
  const requests = [];
  const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: 2000 - i, model: i % 2 === 0 ? 'account.move' : 'account.payment' }));
  const page2 = [{ id: 1000, model: 'account.move' }, { id: 999, model: 'account.payment' }];
  globalThis.fetch = async (url) => {
    requests.push(url);
    const u = new URL(url, 'http://localhost');
    const before = u.searchParams.get('before');
    const data = before ? page2 : page1;
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
      json: async () => data,
    };
  };
  try {
    const all = await listAuditAll(['account.move', 'account.payment']);
    assert.equal(all.length, 1002);
    assert.equal(requests.length, 2);
    const u1 = new URL(requests[0], 'http://localhost');
    assert.equal(u1.searchParams.get('models'), 'account.move,account.payment');
    assert.equal(u1.searchParams.get('before'), null);
    const u2 = new URL(requests[1], 'http://localhost');
    assert.equal(u2.searchParams.get('models'), 'account.move,account.payment');
    assert.equal(u2.searchParams.get('before'), String(page1.at(-1).id));

    requests.length = 0;
    await listAuditAll(['  ', '']);
    assert.equal(new URL(requests[0], 'http://localhost').searchParams.has('models'), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('runFollowUps with outbox-only transport posts at most one note per day, repeats next day, and sends once when working', async () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Outbox Partner', email: 'outbox@example.test', customer_rank: 1 });
  db = partner.db;
  const at = today();
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: addDays(at, -20),
    invoice_date_due: addDays(at, -10),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const existingLevel = search(db, 'account.followup.level')[0];
  db = existingLevel
    ? write(db, 'account.followup.level', existingLevel.id, { delay: 5, send_email: true, create_activity: true, activity_type_id: existingLevel.activity_type_id || 'todo', activity_summary: 'Call customer' })
    : create(db, 'account.followup.level', { name: 'Overdue Notice', delay: 5, send_email: true, create_activity: true, activity_type_id: 'todo', activity_summary: 'Call customer' }).db;

  const outboxTransport = createMailTransport({ env: {} });
  const run1 = await runFollowUps(db, at, outboxTransport);
  const notes1 = messagesOf(run1, 'res.partner', partner.id).filter((m) => m.delivery_state === 'outbox_only');
  assert.equal(notes1.length, 1);
  assert.equal(partnerFollowUp(read(run1, 'res.partner', partner.id), 1)?.followup_delivery_state, 'not_sent');
  assert.equal(partnerFollowUp(read(run1, 'res.partner', partner.id), 1)?.followup_delivery_outcome, 'outbox_only');
  assert.equal(partnerFollowUp(read(run1, 'res.partner', partner.id), 1)?.followup_level_delay, null);
  assert.equal(search(run1, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === partner.id).length, 1);

  // Same-day repeat with outbox-only transport must not post a duplicate note or change db.
  const run2 = await runFollowUps(run1, at, outboxTransport);
  assert.equal(run2, run1);
  assert.equal(messagesOf(run2, 'res.partner', partner.id).filter((m) => m.delivery_state === 'outbox_only').length, 1);

  // Next day with outbox-only transport posts one more note (and does not duplicate the activity).
  const nextDay = addDays(at, 1);
  const run3 = await runFollowUps(run2, nextDay, outboxTransport);
  assert.equal(messagesOf(run3, 'res.partner', partner.id).filter((m) => m.delivery_state === 'outbox_only').length, 2);
  assert.equal(search(run3, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === partner.id).length, 1);
  assert.equal(partnerFollowUp(read(run3, 'res.partner', partner.id), 1)?.followup_delivery_state, 'not_sent');

  // Same day (nextDay) after transport starts working sends exactly once.
  const sent = [];
  const workingTransport = createMailTransport({
    smtp: { host: 'smtp.mock', port: 587, from: 'noreply@example.com' },
    send: async (_cfg, msg) => { sent.push(msg); },
  });
  const run4 = await runFollowUps(run3, nextDay, workingTransport);
  const partnerEmails = sent.filter((m) => m.to === 'outbox@example.test');
  assert.equal(partnerEmails.length, 1);
  assert.equal(partnerFollowUp(read(run4, 'res.partner', partner.id), 1)?.followup_delivery_state, 'sent');
  assert.equal(partnerFollowUp(read(run4, 'res.partner', partner.id), 1)?.followup_delivery_outcome, 'sent');
  assert.equal(partnerFollowUp(read(run4, 'res.partner', partner.id), 1)?.followup_level_delay, 5);

  const run5 = await runFollowUps(run4, nextDay, workingTransport);
  assert.equal(sent.filter((m) => m.to === 'outbox@example.test').length, 1);
  assert.equal(run5, run4);
});

test('payment webhook handles residual >= amount, 0 < residual < amount, and residual === 0 without losing captured payments', async () => {
  const secret = 'q119a-webhook-secret';
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const partner = create(db, 'res.partner', { name: 'Webhook Customer', customer_rank: 1 });
  db = partner.db;

  // Case A: 0 < residual < tx.amount (manual partial payment reduced residual before webhook arrived).
  const invPartial = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 250, tax: 0 }],
  });
  db = postMove(invPartial.db, invPartial.id);
  const coPartial = createInvoiceCheckout(db, invPartial.id, demo.id, { reference: 'TX-PARTIAL-OVER' });
  db = coPartial.db;
  db = registerPayment(db, read(db, 'account.move', invPartial.id), { amount: 100, date: '2026-04-11', journal_id: bankJournal.id }).db;
  assert.equal(residual(read(db, 'account.move', invPartial.id), db), 150);

  const partialBody = JSON.stringify({ reference: 'TX-PARTIAL-OVER', amount: 250, currency: 'USD', status: 'paid', date: '2026-04-12' });
  const partialRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', headers: { 'x-mizan-signature': signWebhookPayload(partialBody, secret) } },
    res: partialRes,
    providerCode: 'demo',
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async () => Buffer.from(partialBody),
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
  });
  assert.equal(partialRes.out.status, 200);
  const partialJson = JSON.parse(partialRes.out.body);
  assert.equal(partialJson.alreadyProcessed, false);
  const partialMove = read(db, 'account.move', invPartial.id);
  assert.equal(residual(partialMove, db), 0);
  assert.equal(partialMove.payment_state, 'paid');
  const txPartial = read(db, 'payment.transaction', coPartial.transaction.id);
  assert.equal(txPartial.state, 'done');
  assert.ok(txPartial.payment_id);
  const payPartial = read(db, 'account.payment', txPartial.payment_id);
  assert.equal(payPartial.amount, 250);
  assert.equal(payPartial.unapplied, 100);
  assert.ok(messagesOf(db, 'account.move', invPartial.id).some((m) => /online payment.*above the open balance/i.test(m.body)));
  sumBalances(db);

  // Replay of Case A must be idempotent.
  const replayPartial = processPaymentWebhook(db, { providerCode: 'demo', rawBody: partialBody, signature: signWebhookPayload(partialBody, secret), secret });
  assert.equal(replayPartial.alreadyProcessed, true);
  assert.equal(replayPartial.db, db);

  // Case B: residual === 0 (invoice already fully paid in between; customer also has another open invoice).
  const otherInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-04-09',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 180, tax: 0 }],
  });
  db = postMove(otherInv.db, otherInv.id);

  const invFull = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 120, tax: 0 }],
  });
  db = postMove(invFull.db, invFull.id);
  const coFull = createInvoiceCheckout(db, invFull.id, demo.id, { reference: 'TX-ZERO-RESIDUAL' });
  db = coFull.db;
  db = registerPayment(db, read(db, 'account.move', invFull.id), { amount: 120, date: '2026-04-11', journal_id: bankJournal.id }).db;
  assert.equal(residual(read(db, 'account.move', invFull.id), db), 0);
  const paymentsBefore = (read(db, 'account.move', invFull.id).payments ?? []).length;

  const fullBody = JSON.stringify({ reference: 'TX-ZERO-RESIDUAL', amount: 120, currency: 'USD', status: 'paid', date: '2026-04-12' });
  const zeroRes = makeRes();
  await handlePaymentWebhook({
    req: { method: 'POST', headers: { 'x-mizan-signature': signWebhookPayload(fullBody, secret) } },
    res: zeroRes,
    providerCode: 'demo',
    getDb: () => db,
    commitDb: (next) => { db = next; },
    readRaw: async () => Buffer.from(fullBody),
    env: { MIZAN_PAYMENT_WEBHOOK_SECRET: secret },
  });
  assert.equal(zeroRes.out.status, 200);
  assert.equal(residual(read(db, 'account.move', invFull.id), db), 0);
  assert.equal((read(db, 'account.move', invFull.id).payments ?? []).length, paymentsBefore);
  // Must not auto-settle unrelated open invoices; the unapplied credit stays on the payment.
  assert.equal(residual(read(db, 'account.move', otherInv.id), db), 180);
  const txZero = read(db, 'payment.transaction', coFull.transaction.id);
  assert.equal(txZero.state, 'done');
  assert.ok(txZero.payment_id);
  const payZero = read(db, 'account.payment', txZero.payment_id);
  assert.equal(payZero.state, 'posted');
  assert.equal(payZero.amount, 120);
  assert.equal(payZero.unapplied, 120);
  assert.ok(messagesOf(db, 'account.move', invFull.id).some((m) => /online payment.*above the open balance/i.test(m.body)));
  sumBalances(db);

  // Unapplied credit from Case B can subsequently settle otherInv via the existing credit path.
  const applied = applyPaymentCredit(db, payZero.id, otherInv.id, '2026-04-13');
  assert.equal(residual(read(applied, 'account.move', otherInv.id), applied), 60);
  assert.equal(read(applied, 'account.payment', payZero.id).unapplied, 0);
  sumBalances(applied);

  // Replay of Case B is idempotent.
  const replayZero = processPaymentWebhook(db, { providerCode: 'demo', rawBody: fullBody, signature: signWebhookPayload(fullBody, secret), secret });
  assert.equal(replayZero.alreadyProcessed, true);
  assert.equal(replayZero.db, db);

  // Case C: residual > amount (e.g. a debit/unapply happened so open residual exceeds tx.amount) still settles tx.amount partially.
  const invBigger = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(invBigger.db, invBigger.id);
  db = registerPayment(db, read(db, 'account.move', invBigger.id), { amount: 100, date: '2026-04-10', journal_id: bankJournal.id }).db;
  const coSmaller = createInvoiceCheckout(db, invBigger.id, demo.id, { reference: 'TX-RESIDUAL-GT-TX' });
  db = coSmaller.db;
  // Reverse the earlier 100 payment so residual becomes 300 > tx.amount (200).
  const firstPay = search(db, 'account.payment').find((p) => p.invoice_id === invBigger.id);
  const { reversePayment } = await import('./models/pay.js');
  db = reversePayment(db, firstPay, '2026-04-11');
  assert.equal(residual(read(db, 'account.move', invBigger.id), db), 300);

  const smallerBody = JSON.stringify({ reference: 'TX-RESIDUAL-GT-TX', amount: 200, currency: 'USD', status: 'paid', date: '2026-04-12' });
  const settledSmaller = processPaymentWebhook(db, { providerCode: 'demo', rawBody: smallerBody, signature: signWebhookPayload(smallerBody, secret), secret });
  assert.equal(settledSmaller.alreadyProcessed, false);
  assert.equal(residual(read(settledSmaller.db, 'account.move', invBigger.id), settledSmaller.db), 100);
  assert.equal(read(settledSmaller.db, 'account.move', invBigger.id).payment_state, 'partial');
  const paySmaller = read(settledSmaller.db, 'account.payment', settledSmaller.transaction.payment_id);
  assert.equal(paySmaller.amount, 200);
  assert.equal(paySmaller.unapplied, 0);
  sumBalances(settledSmaller.db);
});

test('payment webhook rejects mismatched amount/currency, bad signatures, unknown refs, cancelled/errored txs, and guard restricts transitions', async () => {
  const secret = 'q119a-guard-secret';
  let db = seed();
  const demo = search(db, 'payment.provider').find((p) => p.code === 'demo');
  db = write(db, 'payment.provider', demo.id, { state: 'enabled' });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const co = createInvoiceCheckout(db, inv.id, demo.id, { reference: 'TX-GUARD-CHECK' });
  db = co.db;
  const tx = co.transaction;

  // Mismatched amount or currency stays rejected even when residual is 0.
  const bankJournal = search(db, 'account.journal').find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const paidDb = registerPayment(db, read(db, 'account.move', inv.id), { amount: 100, date: '2026-04-11', journal_id: bankJournal.id }).db;
  const badAmt = JSON.stringify({ reference: 'TX-GUARD-CHECK', amount: 90, currency: 'USD', status: 'paid' });
  assert.throws(
    () => processPaymentWebhook(paidDb, { providerCode: 'demo', rawBody: badAmt, signature: signWebhookPayload(badAmt, secret), secret }),
    (e) => e instanceof WebhookError && e.code === 'AMOUNT_MISMATCH',
  );
  const badCur = JSON.stringify({ reference: 'TX-GUARD-CHECK', amount: 100, currency: 'EUR', status: 'paid' });
  assert.throws(
    () => processPaymentWebhook(paidDb, { providerCode: 'demo', rawBody: badCur, signature: signWebhookPayload(badCur, secret), secret }),
    (e) => e instanceof WebhookError && e.code === 'CURRENCY_MISMATCH',
  );

  // Cancelled and errored transactions stay rejected.
  const acctOpts = { allowed: writableModelsForApps(['accounting']) };
  const cancelledDb = applyDiff(db, {
    upserts: { 'payment.transaction': [{ ...tx, state: 'cancel' }] },
    bases: { 'payment.transaction': { [tx.id]: { state: 'pending' } } },
  }, acctOpts);
  const okBody = JSON.stringify({ reference: 'TX-GUARD-CHECK', amount: 100, currency: 'USD', status: 'paid' });
  assert.throws(
    () => processPaymentWebhook(cancelledDb, { providerCode: 'demo', rawBody: okBody, signature: signWebhookPayload(okBody, secret), secret }),
    (e) => e instanceof WebhookError && e.code === 'INVALID_TRANSACTION_STATE',
  );
  const erroredDb = applyDiff(db, {
    upserts: { 'payment.transaction': [{ ...tx, state: 'error' }] },
    bases: { 'payment.transaction': { [tx.id]: { state: 'pending' } } },
  }, acctOpts);
  assert.throws(
    () => processPaymentWebhook(erroredDb, { providerCode: 'demo', rawBody: okBody, signature: signWebhookPayload(okBody, secret), secret }),
    (e) => e instanceof WebhookError && e.code === 'INVALID_TRANSACTION_STATE',
  );

  // Guard rejects transitions out of cancel or error, and rejects payment_id on non-done or mismatched payment on done.
  assert.throws(() => applyDiff(cancelledDb, {
    upserts: { 'payment.transaction': [{ ...read(cancelledDb, 'payment.transaction', tx.id), state: 'done' }] },
    bases: { 'payment.transaction': { [tx.id]: { state: 'cancel' } } },
  }, acctOpts), /transition/i);
  assert.throws(() => applyDiff(erroredDb, {
    upserts: { 'payment.transaction': [{ ...read(erroredDb, 'payment.transaction', tx.id), state: 'pending' }] },
    bases: { 'payment.transaction': { [tx.id]: { state: 'error' } } },
  }, acctOpts), /transition/i);

  // Guard rejects pending -> done linked to a payment with wrong partner or wrong amount.
  const wrongPartner = create(db, 'res.partner', { name: 'Other Partner', customer_rank: 1 });
  const wrongPayDraft = create(wrongPartner.db, 'account.payment', {
    partner_id: wrongPartner.id, partner_type: 'customer', payment_type: 'inbound', amount: 100, date: '2026-04-11', journal_id: bankJournal.id, company_id: 1,
  });
  const wrongPayDb = postPayment(wrongPayDraft.db, read(wrongPayDraft.db, 'account.payment', wrongPayDraft.id), { autoAllocate: false });
  assert.throws(() => applyDiff(wrongPayDb, {
    upserts: { 'payment.transaction': [{ ...tx, state: 'done', payment_id: wrongPayDraft.id }] },
    bases: { 'payment.transaction': { [tx.id]: { state: 'pending', payment_id: null } } },
  }, acctOpts), /partner/i);
});

test('all new q119a labels, options and error strings have non-identical Arabic translations', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'ar', setItem: () => {} };
  try {
    const { t } = await import(`./i18n.js?q119a_ar=${Date.now()}`);
    const strings = [
      'Delivery Outcome',
      'Sent',
      'Outbox Only',
      'Failed',
      'Payment amount does not match the transaction amount',
      'Only completed payment transactions can link a payment',
      'Completed payment transactions require an inbound customer payment',
      'Completed payment transaction payment must belong to the invoice partner',
      'Completed payment transaction payment cannot belong to another invoice',
      'Payment is already linked to another payment transaction',
      'Completed payment transaction payment must match the transaction currency and amount',
    ];
    for (const s of strings) {
      assert.notEqual(t(s), s, `Missing Arabic translation in src/i18n.js for: ${s}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
