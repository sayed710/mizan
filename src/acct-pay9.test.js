import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { applyFilters, create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { duplicateValues } from './duplicate.js';
import { applyDiff, diffDb } from './sync.js';
import { today } from './models/common.js';
import { postMove, payMove } from './models/accounting.js';
import {
  cancelPayment,
  customerPaymentView,
  isPaymentReconciled,
  markAsSent,
  paymentMethodCode,
  paymentReceiptTitle,
  postPayment,
  printPaymentReceipts,
  rejectPayment,
  resetPaymentToDraft,
  unmarkAsSent,
  vendorPaymentView,
} from './models/pay.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => String(classOf(node)).split(/\s+/).includes(cls);
const allFind = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) allFind(child, pred, acc);
  return acc;
};
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

const leafFor = (sectionLabel, key) => menusFor('accounting').find((m) => m.label === sectionLabel).children.find((c) => c.key === key);
const btn = (label) => models['account.payment'].form.buttons.find((b) => b.label === label);

test('Mark as Sent / Unmark as Sent visibility, is_sent field semantics, Cancel on sent, and sync guards', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partner = search(db, 'res.partner')[0];
  const d0 = today();

  const manualLine = bank.inbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'manual',
  );
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing',
  );

  // 1. Draft manual payment: is_sent defaults false, copy: false, Mark/Unmark hidden, Cancel visible on saved record
  const draftRes = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 100,
    date: d0,
    journal_id: bank.id,
    payment_method_line_id: manualLine.id,
    company_id: 1,
  });
  db = draftRes.db;
  const draftPay = read(db, 'account.payment', draftRes.id);
  assert.equal(draftPay.is_sent, false);
  assert.equal(models['account.payment'].fields.is_sent.readonly, true);
  assert.equal(models['account.payment'].fields.is_sent.copy, false);
  assert.equal(paymentMethodCode(db, draftPay), 'manual');
  assert.equal(btn('Mark as Sent').when(draftPay, db), false);
  assert.equal(btn('Unmark as Sent').when(draftPay, db), false);
  assert.equal(btn('Reject').when(draftPay, db), false);
  assert.equal(btn('Cancel').when(draftPay, db), true);
  assert.equal(btn('Cancel').when({ state: 'draft' }, db), false, 'Cancel hidden on unsaved draft');

  // Cannot mark draft as sent directly or via diff
  assert.throws(() => markAsSent(db, draftPay.id), /Only paid/);
  assert.throws(() => create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 50,
    date: d0,
    journal_id: bank.id,
    payment_method_line_id: manualLine.id,
    is_sent: true,
    company_id: 1,
  }), /Only paid/);
  const forgedCreateDb = {
    ...db,
    records: {
      ...db.records,
      'account.payment': [...db.records['account.payment'], { ...draftPay, id: draftPay.id + 100, is_sent: true }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedCreateDb), { isAdmin: true }), /Only paid/);

  // 2. Post payment: Mark as Sent visible; Unmark, Reject, Cancel hidden
  db = postPayment(db, read(db, 'account.payment', draftPay.id));
  const paid = read(db, 'account.payment', draftPay.id);
  assert.equal(btn('Mark as Sent').when(paid, db), true);
  assert.equal(btn('Unmark as Sent').when(paid, db), false);
  assert.equal(btn('Reject').when(paid, db), false);
  assert.equal(btn('Cancel').when(paid, db), false);

  // Mark as Sent -> is_sent = true; copy: false drops is_sent on duplicateValues
  const sentDb = markAsSent(db, paid.id);
  const sentPay = read(sentDb, 'account.payment', paid.id);
  assert.equal(sentPay.is_sent, true);
  assert.equal(duplicateValues('account.payment', sentPay, sentDb).is_sent, undefined);
  assert.equal(btn('Mark as Sent').when(sentPay, sentDb), false);
  assert.equal(btn('Unmark as Sent').when(sentPay, sentDb), true);
  assert.equal(btn('Reject').when(sentPay, sentDb), true);
  assert.equal(btn('Cancel').when(sentPay, sentDb), true);

  // Diff-verifiable via applyDiff
  const syncedSent = applyDiff(db, diffDb(db, sentDb), { isAdmin: true });
  assert.equal(read(syncedSent, 'account.payment', paid.id).is_sent, true);

  // Unmark as Sent -> is_sent = false, diff-verifiable
  const unmarkedDb = unmarkAsSent(syncedSent, paid.id);
  assert.equal(read(unmarkedDb, 'account.payment', paid.id).is_sent, false);
  const syncedUnmarked = applyDiff(syncedSent, diffDb(syncedSent, unmarkedDb), { isAdmin: true });
  assert.equal(read(syncedUnmarked, 'account.payment', paid.id).is_sent, false);

  // Cancel a sent paid payment -> state: 'cancel', move unlinked/cancelled
  const cancelledDb = cancelPayment(syncedSent, paid.id);
  const cancelledPay = read(cancelledDb, 'account.payment', paid.id);
  assert.equal(cancelledPay.state, 'cancel');
  assert.equal(cancelledPay.move_id, null);
  assert.equal(read(cancelledDb, 'account.move', paid.move_id), undefined);

  // Under audit_trail, two-step sync (move->draft + payment->cancel, then move->cancel) passes applyDiff
  const auditedSent = write(syncedSent, 'res.company', 1, { audit_trail: true });
  const step1 = write(
    write(auditedSent, 'account.move', paid.move_id, { state: 'draft' }),
    'account.payment',
    paid.id,
    { state: 'cancel', move_id: null, unapplied: 0 },
  );
  const syncedStep1 = applyDiff(auditedSent, diffDb(auditedSent, step1), { isAdmin: true });
  const step2 = write(syncedStep1, 'account.move', paid.move_id, { state: 'cancel' });
  const syncedCancelled = applyDiff(syncedStep1, diffDb(syncedStep1, step2), { isAdmin: true });
  assert.equal(read(syncedCancelled, 'account.payment', paid.id).state, 'cancel');
  assert.equal(read(syncedCancelled, 'account.move', paid.move_id).state, 'cancel');

  // Forged diff cancelling posted payment while keeping move_id posted is rejected
  const forgedCancel = {
    ...syncedSent,
    records: {
      ...syncedSent.records,
      'account.payment': syncedSent.records['account.payment'].map((p) => (p.id === paid.id ? { ...p, state: 'cancel' } : p)),
    },
  };
  assert.throws(() => applyDiff(syncedSent, diffDb(syncedSent, forgedCancel), { isAdmin: true }), /posted journal entry/);

  // 3. Non-manual payment (check_printing): Mark as Sent hidden and refused
  const checkRes = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 75,
    date: d0,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    company_id: 1,
  });
  db = postPayment(checkRes.db, read(checkRes.db, 'account.payment', checkRes.id));
  const checkPay = read(db, 'account.payment', checkRes.id);
  assert.equal(paymentMethodCode(db, checkPay), 'check_printing');
  assert.equal(btn('Mark as Sent').when(checkPay, db), false);
  assert.throws(() => markAsSent(db, checkPay.id), /manual payments/i);
  assert.throws(() => write(db, 'account.payment', checkPay.id, { is_sent: true }), /manual/i);
  const forgedCheckSent = {
    ...db,
    records: {
      ...db.records,
      'account.payment': db.records['account.payment'].map((p) => (p.id === checkPay.id ? { ...p, is_sent: true } : p)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedCheckSent), { isAdmin: true }), /manual/i);

  // 4. Bank-matched (reconciled) payment: Mark as Sent / Unmark as Sent / Reject / Cancel hidden and refused
  const stmt = create(syncedSent, 'account.bank.statement.line', {
    journal_id: bank.id,
    date: d0,
    payment_ref: 'MATCH-SENT',
    partner_id: partner.id,
    amount: 100,
    payment_id: paid.id,
    company_id: 1,
  });
  const matchedDb = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment')
    .run(stmt.db, read(stmt.db, 'account.bank.statement.line', stmt.id)).db;
  const matchedPay = read(matchedDb, 'account.payment', paid.id);
  assert.equal(matchedPay.display_state, 'reconciled');
  assert.equal(btn('Mark as Sent').when(matchedPay, matchedDb), false);
  assert.equal(btn('Unmark as Sent').when(matchedPay, matchedDb), false);
  assert.equal(btn('Reject').when(matchedPay, matchedDb), false);
  assert.equal(btn('Cancel').when(matchedPay, matchedDb), false);
  assert.throws(() => unmarkAsSent(matchedDb, paid.id), /unreconciled/i);
  assert.throws(() => rejectPayment(matchedDb, paid.id), /unreconciled/i);
});

test('Reject action, rejected state, statusbar visibility, Reset to Draft from rejected, and Rejected filter', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partner = search(db, 'res.partner')[0];
  const d0 = today();

  const p1 = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 200,
    date: d0,
    journal_id: bank.id,
    company_id: 1,
  });
  db = postPayment(p1.db, read(p1.db, 'account.payment', p1.id));

  // Unsent posted payment cannot be rejected
  assert.throws(() => rejectPayment(db, p1.id), /sent/i);
  assert.throws(() => write(db, 'account.payment', p1.id, { state: 'rejected' }), /sent/i);
  const forgedReject = {
    ...db,
    records: {
      ...db.records,
      'account.payment': db.records['account.payment'].map((p) => (p.id === p1.id ? { ...p, state: 'rejected' } : p)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedReject), { isAdmin: true }), /sent/i);

  // Mark as sent, then reject
  const sentDb = markAsSent(db, p1.id);
  const rejDb = rejectPayment(sentDb, p1.id);
  const rejPay = read(rejDb, 'account.payment', p1.id);
  assert.equal(rejPay.state, 'rejected');
  assert.equal(rejPay.display_state, 'rejected');

  // Diff-verifiable
  const syncedRej = applyDiff(sentDb, diffDb(sentDb, rejDb), { isAdmin: true });
  assert.equal(read(syncedRej, 'account.payment', p1.id).state, 'rejected');

  // Cannot create directly in rejected state
  assert.throws(() => create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 50,
    date: d0,
    journal_id: bank.id,
    state: 'rejected',
    company_id: 1,
  }), /rejected/i);
  const forgedNewRejDb = {
    ...db,
    records: {
      ...db.records,
      'account.payment': [...db.records['account.payment'], { ...read(db, 'account.payment', p1.id), id: p1.id + 100, state: 'rejected' }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedNewRejDb), { isAdmin: true }), /rejected/i);

  // Rejected filter matches only rejected payments
  const p2 = create(syncedRej, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 80,
    date: d0,
    journal_id: bank.id,
    company_id: 1,
  });
  const all = [read(p2.db, 'account.payment', p1.id), read(p2.db, 'account.payment', p2.id)];
  assert.deepEqual(applyFilters('account.payment', all, ['rejected'], p2.db, vendorPaymentView.filters).map((r) => r.id), [p1.id]);
  assert.deepEqual(applyFilters('account.payment', all, ['rejected'], p2.db, customerPaymentView.filters).map((r) => r.id), [p1.id]);

  // Reset to Draft from rejected works and is diff-verifiable (move->draft step then payment reset)
  assert.equal(btn('Reset to Draft').when(rejPay, syncedRej), true);
  assert.equal(btn('Reject').when(rejPay, syncedRej), false);
  const resetDb = resetPaymentToDraft(syncedRej, p1.id);
  const resetPay = read(resetDb, 'account.payment', p1.id);
  assert.equal(resetPay.state, 'draft');
  assert.equal(resetPay.move_id, null);
  const moveDrafted = write(syncedRej, 'account.move', rejPay.move_id, { state: 'draft' });
  const syncedMoveDrafted = applyDiff(syncedRej, diffDb(syncedRej, moveDrafted), { isAdmin: true });
  const resetFromRej = resetPaymentToDraft(syncedMoveDrafted, p1.id);
  const syncedReset = applyDiff(syncedMoveDrafted, diffDb(syncedMoveDrafted, resetFromRej), { isAdmin: true });
  assert.equal(read(syncedReset, 'account.payment', p1.id).state, 'draft');
  assert.equal(read(syncedReset, 'account.payment', p1.id).move_id, null);

  // Statusbar hides 'rejected' on draft/posted and shows it when state === 'rejected'
  assert.ok(models['account.payment'].form.statusbarHide.includes('rejected'));
});

test('Payment Receipt print: form menuActions, listAction, titles, settled invoice partials, and PrintDoc rendering', async () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 0.5 }] });

  // Form menuAction & listActions
  const menuPrint = models['account.payment'].menuActions.find((a) => a.label === 'Payment Receipt');
  assert.ok(menuPrint, 'account.payment exposes Payment Receipt in form menuActions');
  assert.equal(menuPrint.when({}), false);
  assert.equal(menuPrint.when({ id: 5 }), true);
  assert.deepEqual(menuPrint.run(db, { id: 5 }), { db, go: '#/print/account.payment/5?report=receipt' });

  for (const target of [customerPaymentView, vendorPaymentView, models['account.payment']]) {
    const la = target.listActions.find((a) => a.label === 'Print Payment Receipt');
    assert.ok(la, 'listActions includes Print Payment Receipt');
    assert.equal(la.requiresSelection, true);
  }
  assert.throws(() => printPaymentReceipts(db, []), /Select at least one payment/);
  assert.throws(() => printPaymentReceipts(db, [999999]), /Payment not found/);

  // Titles match Odoo 20 _compute_payment_receipt_title
  assert.equal(paymentReceiptTitle({ payment_type: 'inbound', partner_type: 'customer' }), 'Payment Receipt');
  assert.equal(paymentReceiptTitle({ payment_type: 'outbound', partner_type: 'supplier' }), 'Remittance Advice');
  assert.equal(paymentReceiptTitle({ payment_type: 'outbound', partner_type: 'customer' }), 'Refund Confirmation');
  assert.equal(paymentReceiptTitle({ payment_type: 'inbound', partner_type: 'supplier' }), 'Refund Confirmation');

  // Create customer invoice in USD, pay partially in EUR (tests multi-currency column + Due Amount)
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    currency_id: usd.id,
    invoice_date: '2026-02-01',
    ref: 'PO-REC-1',
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  db = payMove(db, inv.id, 100, '2026-02-02', { journalId: bank.id, currencyId: eur.id, paymentAmount: 50, memo: 'WIRE-EUR' });
  const custPay = db.records['account.payment'].at(-1);

  // Also create an outbound vendor check payment to verify ?report=receipt prints receipt (not check) while default prints check
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing',
  );
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ name: 'Supplies', qty: 1, price_unit: 120, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);
  const vendDraft = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 120,
    date: '2026-02-03',
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
  });
  db = payMove(vendDraft.db, bill.id, 120, '2026-02-03', { paymentId: vendDraft.id, journalId: bank.id, checkNumber: 777 });
  const vendPay = read(db, 'account.payment', vendDraft.id);

  assert.deepEqual(printPaymentReceipts(db, [custPay.id, vendPay.id]), {
    db,
    go: `#/print/account.payment/${custPay.id},${vendPay.id}?report=receipt`,
  });

  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  await initStore();
  await React.act(async () => commit(db));

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    // 1. Single customer receipt (without ?report=receipt because non-check, and with ?report=receipt)
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: custPay.id, report: 'receipt' })));
    const text1 = textOf(host);
    assert.match(text1, new RegExp(`Payment Receipt: ${custPay.name}`));
    assert.match(text1, /Customer:/);
    assert.match(text1, /WIRE-EUR/);
    assert.match(text1, /Amount In Currency/);
    assert.match(text1, /50\.00\s*€|€\s*50\.00/);
    assert.match(text1, new RegExp(`Due Amount for ${read(db, 'account.move', inv.id).name}`));
    assert.match(text1, /\$200\.00/);

    // 2. Multi-payment receipt (including outbound check payment with report='receipt' -> Remittance Advice, NOT Check)
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: `${custPay.id},${vendPay.id}`, report: 'receipt' })));
    const articles = allFind(host, (n) => n.tagName === 'ARTICLE');
    assert.equal(articles.length, 2);
    const text2 = textOf(host);
    assert.match(text2, new RegExp(`Remittance Advice: ${vendPay.name}`));
    assert.match(text2, /Vendor:/);
    assert.doesNotMatch(text2, /Check #777/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('List decoration-warning renders on paid unreconciled payments and clears when reconciled', async () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partner = search(db, 'res.partner')[0];
  const d0 = today();

  // 1. Paid & unreconciled (unapplied) -> warning row + badge-warning
  const pUnrec = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 55,
    date: d0,
    journal_id: bank.id,
    company_id: 1,
  });
  db = postPayment(pUnrec.db, read(pUnrec.db, 'account.payment', pUnrec.id));
  assert.equal(isPaymentReconciled(db, read(db, 'account.payment', pUnrec.id)), false);
  assert.equal(customerPaymentView.listDecoration(read(db, 'account.payment', pUnrec.id), db), 'warning');

  // 2. Paid & invoice-reconciled -> is_reconciled true, NO warning row, badge-success
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: d0,
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 65, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  db = payMove(db, inv.id, 65, d0, { journalId: bank.id });
  const pInvRec = db.records['account.payment'].at(-1);
  assert.equal(isPaymentReconciled(db, pInvRec), true);
  assert.equal(customerPaymentView.listDecoration(pInvRec, db), null);

  // 3. Rejected payment -> no warning row
  const pRej = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 75,
    date: d0,
    journal_id: bank.id,
    company_id: 1,
  });
  db = postPayment(pRej.db, read(pRej.db, 'account.payment', pRej.id));
  db = markAsSent(db, pRej.id);
  db = rejectPayment(db, pRej.id);
  assert.equal(customerPaymentView.listDecoration(read(db, 'account.payment', pRej.id), db), null);

  // Mount ActionView list and check rendered classes
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS ??= (_, tag) => makeEl(tag);
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { commit } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  commit(db);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    const custLeaf = leafFor('Customers', 'payments');
    await React.act(async () => root.render(React.createElement(ActionView, { leaf: custLeaf, base: '#/accounting/payments', params: new URLSearchParams('view=list') })));
    const rows = allFind(find(host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');
    const rowFor = (name) => rows.find((tr) => textOf(tr).includes(name));
    const unrecRow = rowFor(read(db, 'account.payment', pUnrec.id).name);
    const invRecRow = rowFor(pInvRec.name);
    const rejRow = rowFor(read(db, 'account.payment', pRej.id).name);
    assert.ok(hasClass(unrecRow, 'warning'), 'paid unreconciled row has warning class');
    assert.ok(find(unrecRow, (n) => hasClass(n, 'badge-warning')), 'paid unreconciled badge has badge-warning');
    assert.ok(!hasClass(invRecRow, 'warning'), 'paid invoice-reconciled row has no warning class');
    assert.ok(find(invRecRow, (n) => hasClass(n, 'badge-success')), 'paid invoice-reconciled badge has badge-success');
    assert.ok(!hasClass(rejRow, 'warning'), 'rejected row has no warning class');
    assert.ok(find(rejRow, (n) => hasClass(n, 'badge-muted')), 'rejected badge has badge-muted');
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
});

test('Arabic translations cover all new payment action, state, receipt, and error strings', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {}, removeItem() {} };
  try {
    const { t } = await import(`./i18n.js?lang_ar_pay9=${Date.now()}`);
    for (const key of [
      'Mark as Sent', 'Unmark as Sent', 'Is Sent', 'Is Reconciled',
      'Reject', 'Rejected', 'Payment Receipt', 'Print Payment Receipt',
      'Remittance Advice', 'Refund Confirmation', 'Customer:', 'Vendor:',
      'Amount In Currency', 'Due Amount for {name}',
      'Only paid, unreconciled payments can be marked as sent',
      'Only sent payments can be rejected',
    ]) {
      assert.notEqual(t(key), key, `Missing Arabic translation for ${key}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
