import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { applyFilters, create, groupRecords, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models, menusFor } from './models/index.js';
import { duplicateValues } from './duplicate.js';
import { applyDiff, diffDb } from './sync.js';
import { today } from './models/common.js';
import { postMove, payMove } from './models/accounting.js';
import { agedBalance } from './models/finance.js';
import { partnerLedger } from './models/reports.js';
import {
  cancelPayment,
  customerPaymentView,
  isPaymentReconciled,
  markAsSent,
  paymentMethodCode,
  paymentReceiptData,
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

  // Form menuAction & listActions: Payment Receipt requires state === 'posted'
  const menuPrint = models['account.payment'].menuActions.find((a) => a.label === 'Payment Receipt');
  assert.ok(menuPrint, 'account.payment exposes Payment Receipt in form menuActions');
  assert.equal(menuPrint.when({}), false);
  assert.equal(menuPrint.when({ id: 5, state: 'draft' }), false);
  assert.equal(menuPrint.when({ id: 5, state: 'cancel' }), false);
  assert.equal(menuPrint.when({ id: 5, state: 'rejected' }), false);
  assert.equal(menuPrint.when({ id: 5, state: 'posted' }), true);

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
  assert.deepEqual(menuPrint.run(db, custPay), {
    db,
    go: `#/print/account.payment/${custPay.id}?report=receipt`,
  });

  // Draft, cancelled, and mixed selections are rejected by printPaymentReceipts
  const draftForPrint = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 45,
    date: '2026-02-04',
    journal_id: bank.id,
    company_id: 1,
  });
  db = draftForPrint.db;
  const cancRes = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 35,
    date: '2026-02-04',
    journal_id: bank.id,
    company_id: 1,
  });
  db = cancelPayment(cancRes.db, cancRes.id);
  assert.throws(() => printPaymentReceipts(db, [draftForPrint.id]), /posted payments/i);
  assert.throws(() => printPaymentReceipts(db, [cancRes.id]), /posted payments/i);
  assert.throws(() => printPaymentReceipts(db, [custPay.id, draftForPrint.id]), /posted payments/i);

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

    // 3. Direct URL visit to draft, cancelled, or mixed receipt selection shows alert instead of printing
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: draftForPrint.id, report: 'receipt' })));
    assert.equal(allFind(host, (n) => n.tagName === 'ARTICLE').length, 0);
    assert.match(textOf(host), /posted payments/i);

    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: `${custPay.id},${draftForPrint.id}`, report: 'receipt' })));
    assert.equal(allFind(host, (n) => n.tagName === 'ARTICLE').length, 0);
    assert.match(textOf(host), /posted payments/i);

    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: `${custPay.id},999999`, report: 'receipt' })));
    assert.equal(allFind(host, (n) => n.tagName === 'ARTICLE').length, 0);
    assert.match(textOf(host), /Record not found/i);
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

  // 2. Paid & invoice-reconciled -> is_reconciled true, NO warning row; display_state & badge remain Paid (warning) until bank-matched
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
  assert.equal(read(db, 'account.payment', pInvRec.id).display_state, 'posted');
  assert.equal(customerPaymentView.listDecoration(pInvRec, db), null);

  // 2b. Paid & bank-matched -> display_state 'reconciled' (Reconciled) + badge-success
  const pMatchedRes = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 85,
    date: d0,
    journal_id: bank.id,
    company_id: 1,
  });
  db = postPayment(pMatchedRes.db, read(pMatchedRes.db, 'account.payment', pMatchedRes.id));
  const stmtMatch = create(db, 'account.bank.statement.line', {
    journal_id: bank.id,
    date: d0,
    payment_ref: 'MATCH-BADGE',
    partner_id: partner.id,
    amount: 85,
    payment_id: pMatchedRes.id,
    company_id: 1,
  });
  db = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment')
    .run(stmtMatch.db, read(stmtMatch.db, 'account.bank.statement.line', stmtMatch.id)).db;
  const pMatched = read(db, 'account.payment', pMatchedRes.id);
  assert.equal(pMatched.display_state, 'reconciled');
  const byDisplayState = groupRecords(db, 'account.payment', [read(db, 'account.payment', pInvRec.id), pMatched], 'display_state');
  assert.deepEqual(byDisplayState.find((g) => g.key === 'posted')?.records.map((r) => r.id), [pInvRec.id]);
  assert.deepEqual(byDisplayState.find((g) => g.key === 'reconciled')?.records.map((r) => r.id), [pMatched.id]);

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
    const matchedRow = rowFor(pMatched.name);
    const rejRow = rowFor(read(db, 'account.payment', pRej.id).name);
    assert.ok(hasClass(unrecRow, 'warning'), 'paid unreconciled row has warning class');
    assert.ok(find(unrecRow, (n) => hasClass(n, 'badge-warning')), 'paid unreconciled badge has badge-warning');
    assert.ok(!hasClass(invRecRow, 'warning'), 'paid invoice-reconciled row has no warning class');
    const invRecBadge = find(invRecRow, (n) => hasClass(n, 'badge'));
    assert.ok(hasClass(invRecBadge, 'badge-warning'), 'invoice-settled unmatched payment badge matches display_state Paid');
    assert.equal(textOf(invRecBadge).trim(), 'Paid');
    const matchedBadge = find(matchedRow, (n) => hasClass(n, 'badge'));
    assert.ok(hasClass(matchedBadge, 'badge-success'), 'bank-matched payment badge has badge-success');
    assert.equal(textOf(matchedBadge).trim(), 'Reconciled');
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
      'Payment receipts can only be printed for posted payments.',
    ]) {
      assert.notEqual(t(key), key, `Missing Arabic translation for ${key}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('Regression 1: Rejected unapplied prepayment remains in aged receivables matching partner ledger', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partner = search(db, 'res.partner')[0];
  const d0 = today();

  const pRes = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 250,
    date: d0,
    journal_id: bank.id,
    company_id: 1,
  });
  db = postPayment(pRes.db, read(pRes.db, 'account.payment', pRes.id));
  db = markAsSent(db, pRes.id);
  db = rejectPayment(db, pRes.id);

  const ledger = partnerLedger(db, { from: d0, to: d0, company_id: 1, partnerIds: [partner.id] }, 'receivable');
  const aging = agedBalance(db, 'receivable', d0, 1);
  const ledgerPartner = ledger.find((r) => r.partner_id === partner.id);
  const agingPartner = aging.rows.find((r) => r.partner_id === partner.id);
  assert.equal(ledgerPartner?.end, -250);
  assert.equal(agingPartner?.total, ledgerPartner?.end);
});

test('Regression 2: Rejecting a sent internal transfer marks paired payment sent and rejects both cleanly', () => {
  let db = seed();
  const transferAcc = create(db, 'account.account', {
    code: '101799',
    name: 'Internal Transfers',
    account_type: 'asset_current',
    reconcile: true,
    company_id: 1,
  });
  db = write(transferAcc.db, 'res.company', 1, { transfer_account_id: transferAcc.id });
  const banks = search(db, 'account.journal').filter((j) => j.type === 'bank' || j.type === 'cash');
  assert.ok(banks.length >= 2);
  const [srcJournal, dstJournal] = banks;
  const d0 = today();

  const xferRes = create(db, 'account.payment', {
    is_internal_transfer: true,
    payment_type: 'outbound',
    amount: 300,
    date: d0,
    journal_id: srcJournal.id,
    destination_journal_id: dstJournal.id,
    company_id: 1,
  });
  db = postPayment(xferRes.db, read(xferRes.db, 'account.payment', xferRes.id));
  const srcPosted = read(db, 'account.payment', xferRes.id);
  const dstId = srcPosted.paired_internal_transfer_payment_id;
  assert.ok(dstId);

  const sentDb = markAsSent(db, srcPosted.id);
  assert.equal(read(sentDb, 'account.payment', srcPosted.id).is_sent, true);
  assert.equal(read(sentDb, 'account.payment', dstId).is_sent, true);

  const unmarkedDb = unmarkAsSent(sentDb, srcPosted.id);
  assert.equal(read(unmarkedDb, 'account.payment', srcPosted.id).is_sent, false);
  assert.equal(read(unmarkedDb, 'account.payment', dstId).is_sent, false);

  const resentDb = markAsSent(unmarkedDb, srcPosted.id);
  const rejDb = rejectPayment(resentDb, srcPosted.id);
  assert.equal(read(rejDb, 'account.payment', srcPosted.id).state, 'rejected');
  assert.equal(read(rejDb, 'account.payment', dstId).state, 'rejected');

  const synced = applyDiff(resentDb, diffDb(resentDb, rejDb), { isAdmin: true });
  assert.equal(read(synced, 'account.payment', srcPosted.id).state, 'rejected');
  assert.equal(read(synced, 'account.payment', dstId).state, 'rejected');

  // Even when paired leg has is_sent: false (e.g. non-manual paired method), rejecting the sent leg succeeds
  const asymRes = create(db, 'account.payment', {
    is_internal_transfer: true,
    payment_type: 'outbound',
    amount: 120,
    date: d0,
    journal_id: srcJournal.id,
    destination_journal_id: dstJournal.id,
    company_id: 1,
  });
  let asymDb = postPayment(asymRes.db, read(asymRes.db, 'account.payment', asymRes.id));
  const asymDstId = read(asymDb, 'account.payment', asymRes.id).paired_internal_transfer_payment_id;
  asymDb = write(asymDb, 'account.payment', asymRes.id, { is_sent: true });
  const asymRejDb = rejectPayment(asymDb, asymRes.id);
  assert.equal(read(asymRejDb, 'account.payment', asymRes.id).state, 'rejected');
  assert.equal(read(asymRejDb, 'account.payment', asymDstId).state, 'rejected');
});

test('Regression 4: isPaymentReconciled requires every reconcilable line to be zero, not just signed sum', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partner = search(db, 'res.partner')[0];
  const recvAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_receivable' && (a.company_id ?? 1) === 1);
  const d0 = today();

  const moveRes = create(db, 'account.move', {
    move_type: 'entry',
    state: 'posted',
    name: 'BNK1/2026/0099',
    date: d0,
    journal_id: bank.id,
    company_id: 1,
    line_ids: [
      { account_id: bank.default_account_id, debit: 100, credit: 0 },
      { account_id: recvAcc.id, partner_id: partner.id, debit: 0, credit: 100 },
      { account_id: recvAcc.id, partner_id: partner.id, debit: 60, credit: 0 },
      { account_id: recvAcc.id, partner_id: partner.id, debit: 0, credit: 60 },
    ],
  });
  db = moveRes.db;
  const pRes = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 100,
    date: d0,
    journal_id: bank.id,
    state: 'posted',
    name: 'PAY-OPEN-2',
    move_id: moveRes.id,
    outstanding_account_id: bank.default_account_id,
    company_id: 1,
  });
  db = pRes.db;
  const pay = read(db, 'account.payment', pRes.id);
  assert.equal(isPaymentReconciled(db, pay), false);
});

test('Regression 6: Reset to draft and cancel clear is_sent so re-confirm starts unsent even after method change', () => {
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

  // 1. Sent payment -> Reset to Draft -> switch to check_printing -> Confirm -> stays unsent
  const p1 = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 90,
    date: d0,
    journal_id: bank.id,
    payment_method_line_id: bank.outbound_payment_method_line_ids.find(
      (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'manual',
    ).id,
    company_id: 1,
  });
  db = postPayment(p1.db, read(p1.db, 'account.payment', p1.id));
  db = markAsSent(db, p1.id);
  const p1MoveId = read(db, 'account.payment', p1.id).move_id;
  const resetDb = resetPaymentToDraft(db, p1.id);
  assert.equal(read(resetDb, 'account.payment', p1.id).is_sent, false);
  const p1Step1 = write(
    write(db, 'account.move', p1MoveId, { state: 'draft' }),
    'account.payment',
    p1.id,
    { state: 'draft', move_id: null, destination_move_id: null, unapplied: 0, is_sent: false },
  );
  const p1Synced1 = applyDiff(db, diffDb(db, p1Step1), { isAdmin: true });
  const syncedReset = applyDiff(p1Synced1, diffDb(p1Synced1, resetDb), { isAdmin: true });
  assert.equal(read(syncedReset, 'account.payment', p1.id).is_sent, false);

  db = write(syncedReset, 'account.payment', p1.id, { payment_method_line_id: checkLine.id });
  db = postPayment(db, read(db, 'account.payment', p1.id));
  const reconfirmed = read(db, 'account.payment', p1.id);
  assert.equal(reconfirmed.is_sent, false);
  assert.equal(btn('Reject').when(reconfirmed, db), false);
  assert.equal(btn('Cancel').when(reconfirmed, db), false);
  assert.equal(btn('Unmark as Sent').when(reconfirmed, db), false);

  // 2. Sent payment -> Cancel -> Reset to Draft -> Confirm -> stays unsent
  const p2 = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 40,
    date: d0,
    journal_id: bank.id,
    payment_method_line_id: manualLine.id,
    company_id: 1,
  });
  db = postPayment(p2.db, read(p2.db, 'account.payment', p2.id));
  db = markAsSent(db, p2.id);
  const p2MoveId = read(db, 'account.payment', p2.id).move_id;
  const cancDb = cancelPayment(db, p2.id);
  assert.equal(read(cancDb, 'account.payment', p2.id).is_sent, false);
  const p2Step1 = write(
    write(db, 'account.move', p2MoveId, { state: 'draft' }),
    'account.payment',
    p2.id,
    { state: 'cancel', move_id: null, destination_move_id: null, unapplied: 0, is_sent: false },
  );
  const p2Synced1 = applyDiff(db, diffDb(db, p2Step1), { isAdmin: true });
  const syncedCanc = applyDiff(p2Synced1, diffDb(p2Synced1, cancDb), { isAdmin: true });
  assert.equal(read(syncedCanc, 'account.payment', p2.id).is_sent, false);
  db = resetPaymentToDraft(syncedCanc, p2.id);
  db = postPayment(db, read(db, 'account.payment', p2.id));
  assert.equal(read(db, 'account.payment', p2.id).is_sent, false);
});

test('Regression 7: Missing exchange rate on an invoice partial does not break Payment Receipt printing', async () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-02-01', rate: 0.5 }] });

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    currency_id: usd.id,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  db = payMove(db, inv.id, 100, '2026-02-02', { journalId: bank.id, currencyId: eur.id, paymentAmount: 50, memo: 'WITH-RATE' });
  const pay = db.records['account.payment'].at(-1);

  // Remove EUR rates so conversion on 2026-02-02 throws inside rateAt()
  db = write(db, 'res.currency', eur.id, { rate_ids: [] });
  const data = paymentReceiptData(db, pay);
  assert.equal(data.invoices.length, 1);
  assert.equal(data.invoices[0].rows[0].amountPayment, null);

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
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: pay.id, report: 'receipt' })));
    const text = textOf(host);
    assert.match(text, new RegExp(`Payment Receipt: ${pay.name}`));
    assert.match(text, /WITH-RATE/);
    // Amount In Currency cell must stay empty rather than rendering 0.00 €
    const tds = allFind(host, (n) => n.tagName === 'TD');
    assert.ok(!tds.some((td) => /0\.00\s*€|€\s*0\.00/.test(textOf(td))));
  } finally {
    await React.act(async () => root.unmount());
  }
});
