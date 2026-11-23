import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { creditNote, payMove, postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

const postedInvoice = (total = 100, { move_type = 'out_invoice', partner_id = 1 } = {}) => {
  const s = seed();
  const created = create(s, 'account.move', {
    move_type,
    partner_id,
    invoice_line_ids: [{ product_id: 1, name: 'Service', qty: 1, price_unit: total, tax: 0 }],
  });
  const postedDb = postMove(created.db, created.id);
  return { db: postedDb, id: created.id };
};

const move = (db, id) => read(db, 'account.move', id);

test('INV13-1 Proforma: draft customer invoices and vendor bills expose Proforma Invoice in form menuActions', () => {
  const proformaAction = models['account.move'].menuActions.find((a) => a.label === 'Proforma Invoice');
  assert.ok(proformaAction, 'Proforma Invoice menuAction must exist');

  // Draft customer invoice and draft vendor bill must show Proforma Invoice
  assert.equal(proformaAction.when({ state: 'draft', move_type: 'out_invoice' }), true, 'draft out_invoice');
  assert.equal(proformaAction.when({ state: 'draft', move_type: 'in_invoice' }), true, 'draft in_invoice');

  // Posted, cancelled, refunds, and general entries must NOT show Proforma Invoice
  assert.equal(proformaAction.when({ state: 'posted', move_type: 'out_invoice' }), false, 'posted out_invoice');
  assert.equal(proformaAction.when({ state: 'cancel', move_type: 'out_invoice' }), false, 'cancelled out_invoice');
  assert.equal(proformaAction.when({ state: 'posted', move_type: 'in_invoice' }), false, 'posted in_invoice');
  assert.equal(proformaAction.when({ state: 'cancel', move_type: 'in_invoice' }), false, 'cancelled in_invoice');
  assert.equal(proformaAction.when({ state: 'draft', move_type: 'out_refund' }), false, 'draft out_refund');
  assert.equal(proformaAction.when({ state: 'draft', move_type: 'in_refund' }), false, 'draft in_refund');
  assert.equal(proformaAction.when({ state: 'draft', move_type: 'entry' }), false, 'draft entry');

  // Navigation target must pass ?report=proforma
  const sampleMove = { id: 77, state: 'draft', move_type: 'out_invoice' };
  const db = { records: { 'account.move': [sampleMove] } };
  assert.deepEqual(proformaAction.run(db, sampleMove), { db, go: '#/print/account.move/77?report=proforma' });
});

test('INV13-1 Proforma: printing draft customer invoices and vendor bills renders Proforma Invoice title and watermark', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  await initStore();

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    const s = seed();

    // 1. Draft customer invoice with proforma
    const draftInv = create(s, 'account.move', {
      move_type: 'out_invoice',
      partner_id: 1,
      invoice_line_ids: [{ name: 'Desk', qty: 1, price_unit: 500, tax: 0 }],
    });
    await React.act(async () => commit(draftInv.db));
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: draftInv.id, proforma: true })));
    let text = textOf(host);
    assert.ok(text.includes('Proforma Invoice'), `Draft out_invoice with proforma must have Proforma Invoice title: ${text}`);
    assert.ok(!text.includes('Draft Invoice'), 'Must not render Draft Invoice when proforma is requested');
    assert.ok(text.includes('PRO-FORMA'), 'Text must include watermark PRO-FORMA');
    const invoiceWatermark = find(host, (n) => n.className?.includes('paper-watermark'));
    assert.ok(invoiceWatermark, 'Watermark element must exist');
    assert.ok(textOf(invoiceWatermark).includes('PRO-FORMA'), 'Watermark must display PRO-FORMA');

    // 2. Draft vendor bill with proforma
    const draftBill = create(draftInv.db, 'account.move', {
      move_type: 'in_invoice',
      partner_id: 1,
      invoice_line_ids: [{ name: 'Raw Material', qty: 1, price_unit: 200, tax: 0 }],
    });
    await React.act(async () => commit(draftBill.db));
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: draftBill.id, proforma: true })));
    text = textOf(host);
    assert.ok(text.includes('Proforma Invoice'), `Draft in_invoice with proforma must have Proforma Invoice title: ${text}`);
    assert.ok(!text.includes('Draft Bill'), 'Must not render Draft Bill when proforma is requested');
    assert.ok(text.includes('PRO-FORMA'), 'Text must include watermark PRO-FORMA');
    const billWatermark = find(host, (n) => n.className?.includes('paper-watermark'));
    assert.ok(billWatermark, 'Watermark element must exist for bill');
    assert.ok(textOf(billWatermark).includes('PRO-FORMA'), 'Bill watermark must display PRO-FORMA');

    // 3. Draft customer invoice WITHOUT proforma (default print) preserves standard behavior
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.move', id: draftInv.id })));
    text = textOf(host);
    assert.ok(text.includes('Draft Invoice'), `Default draft out_invoice print must render Draft Invoice: ${text}`);
    assert.ok(!text.includes('Proforma Invoice'), 'Default print must not render Proforma Invoice');
    assert.ok(!text.includes('PRO-FORMA'), 'Default print must not include PRO-FORMA text');
    assert.equal(find(host, (n) => n.className?.includes('paper-watermark')), null, 'Default print must not have proforma watermark');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('INV13-2 Credit note wizard on a paid invoice: Full Refund and Full refund and new draft work and reconcile per Odoo 20', () => {
  // --- Case 1: Fully paid invoice ---
  const { db: paidBase, id: paidId } = postedInvoice(100);
  const paidDb = payMove(paidBase, paidId, 100);
  const paidInv = move(paidDb, paidId);
  assert.equal(paidInv.amount_paid, 100);
  assert.equal(paidInv.amount_residual, 0);
  assert.equal(paidInv.payment_state, 'paid');

  // 1a. Full Refund (cancel) on fully paid invoice
  const cancelRes = creditNote(paidDb, paidInv, { method: 'cancel', reason: 'Defective goods' });
  const cancelSynced = applyDiff(paidDb, diffDb(paidDb, cancelRes.db));
  const cancelNote = move(cancelSynced, cancelRes.id);
  const cancelOrig = move(cancelSynced, paidId);

  // Credit note is posted with full amount residual (stays open as customer credit)
  assert.equal(cancelNote.state, 'posted');
  assert.equal(cancelNote.amount_total, 100);
  assert.equal(cancelNote.amount_paid, 0);
  assert.equal(cancelNote.amount_residual, 100);
  assert.equal(cancelNote.reversed_entry_id, paidId);
  // Original invoice remains fully paid and points to the reversal move
  assert.equal(cancelOrig.payment_state, 'paid');
  assert.equal(cancelOrig.amount_paid, 100);
  assert.equal(cancelOrig.amount_residual, 0);
  assert.equal(cancelOrig.reversal_move_id, cancelRes.id);

  // 1b. Full refund and new draft (modify) on fully paid invoice
  const { db: paidBase2, id: paidId2 } = postedInvoice(100);
  const paidDb2 = payMove(paidBase2, paidId2, 100);
  const paidInv2 = move(paidDb2, paidId2);

  const modifyRes = creditNote(paidDb2, paidInv2, { method: 'modify', reason: 'Price mistake' });
  const modifySynced = applyDiff(paidDb2, diffDb(paidDb2, modifyRes.db));
  const modifyNote = move(modifySynced, modifyRes.credit_note_id);
  const modifyOrig = move(modifySynced, paidId2);
  const modifyDraft = move(modifySynced, modifyRes.id);

  assert.equal(modifyNote.state, 'posted');
  assert.equal(modifyNote.amount_residual, 100);
  assert.equal(modifyOrig.reversal_move_id, modifyRes.credit_note_id);
  assert.equal(modifyDraft.state, 'draft');
  assert.equal(modifyDraft.move_type, 'out_invoice');
  assert.equal(modifyDraft.partner_id, paidInv2.partner_id);
  assert.equal(modifyDraft.invoice_line_ids?.length, paidInv2.invoice_line_ids?.length);
});

test('INV13-2 Credit note wizard on a partially paid invoice: Full Refund and Full refund and new draft reconcile open balance', () => {
  // --- Case 2: Partially paid invoice ---
  const { db: partBase, id: partId } = postedInvoice(100);
  const partDb = payMove(partBase, partId, 40);
  const partInv = move(partDb, partId);
  assert.equal(partInv.amount_paid, 40);
  assert.equal(partInv.amount_residual, 60);
  assert.equal(partInv.payment_state, 'partial');

  // 2a. Full Refund (cancel) on partially paid invoice
  const cancelRes = creditNote(partDb, partInv, { method: 'cancel' });
  const cancelSynced = applyDiff(partDb, diffDb(partDb, cancelRes.db));
  const cancelNote = move(cancelSynced, cancelRes.id);
  const cancelOrig = move(cancelSynced, partId);

  // The credit note settles the remaining 60 on the invoice
  assert.equal(cancelOrig.amount_paid, 100, 'Original invoice amount_paid becomes 40 + 60 = 100');
  assert.equal(cancelOrig.amount_residual, 0, 'Original invoice residual becomes 0');
  assert.equal(cancelOrig.payment_state, 'paid', 'Original invoice becomes paid');
  assert.equal(cancelOrig.reversal_move_id, cancelRes.id, 'Original invoice references credit note reversal');

  // The credit note has 60 paid against invoice, and 40 remaining as open customer credit
  assert.equal(cancelNote.state, 'posted');
  assert.equal(cancelNote.amount_total, 100);
  assert.equal(cancelNote.amount_paid, 60);
  assert.equal(cancelNote.amount_residual, 40);
  assert.equal(cancelNote.payment_state, 'partial');
  assert.equal(cancelNote.reversed_entry_id, partId);

  // 2b. Full refund and new draft (modify) on partially paid invoice
  const { db: partBase2, id: partId2 } = postedInvoice(100);
  const partDb2 = payMove(partBase2, partId2, 40);
  const partInv2 = move(partDb2, partId2);

  const modifyRes = creditNote(partDb2, partInv2, { method: 'modify' });
  const modifySynced = applyDiff(partDb2, diffDb(partDb2, modifyRes.db));
  const modifyNote = move(modifySynced, modifyRes.credit_note_id);
  const modifyOrig = move(modifySynced, partId2);
  const modifyDraft = move(modifySynced, modifyRes.id);

  assert.equal(modifyOrig.amount_paid, 100);
  assert.equal(modifyOrig.amount_residual, 0);
  assert.equal(modifyOrig.payment_state, 'paid');
  assert.equal(modifyOrig.reversal_move_id, modifyRes.credit_note_id);

  assert.equal(modifyNote.state, 'posted');
  assert.equal(modifyNote.amount_paid, 60);
  assert.equal(modifyNote.amount_residual, 40);
  assert.equal(modifyNote.payment_state, 'partial');

  assert.equal(modifyDraft.state, 'draft');
  assert.equal(modifyDraft.invoice_line_ids?.length, partInv2.invoice_line_ids?.length);

  // 2c. Partially paid vendor bill reverses identically
  const { db: billBase, id: billId } = postedInvoice(100, { move_type: 'in_invoice' });
  const billDb = payMove(billBase, billId, 35);
  const billInv = move(billDb, billId);
  const billCancel = creditNote(billDb, billInv, { method: 'cancel' });
  const billSynced = applyDiff(billDb, diffDb(billDb, billCancel.db));
  const billOrig = move(billSynced, billId);
  const billRefund = move(billSynced, billCancel.id);

  assert.equal(billRefund.move_type, 'in_refund');
  assert.equal(billOrig.amount_paid, 100);
  assert.equal(billOrig.amount_residual, 0);
  assert.equal(billOrig.payment_state, 'paid');
  assert.equal(billRefund.amount_paid, 65);
  assert.equal(billRefund.amount_residual, 35);

  // 2d. Existing credit note blocks Full Refund (cancel) and Modify (modify)
  const { db: invBase, id: invId } = postedInvoice(100);
  const partialNoteRes = creditNote(invBase, move(invBase, invId), { method: 'refund' });
  const partialCustom = write(partialNoteRes.db, 'account.move', partialNoteRes.id, {
    invoice_line_ids: [{ product_id: 1, name: 'Service', qty: 1, price_unit: 20, tax: 0 }],
  });
  const postedPartialNoteDb = postMove(partialCustom, partialNoteRes.id);

  assert.throws(
    () => creditNote(postedPartialNoteDb, move(postedPartialNoteDb, invId), { method: 'cancel' }),
    /Full refund and modify require an invoice with no existing credit notes/
  );
  assert.throws(
    () => creditNote(postedPartialNoteDb, move(postedPartialNoteDb, invId), { method: 'modify' }),
    /Full refund and modify require an invoice with no existing credit notes/
  );

  // 2e. Guard verification through diffDb + applyDiff: forging an overpayment on a settled invoice via credit note is rejected
  const forgedOverpayDb = {
    ...cancelSynced,
    records: {
      ...cancelSynced.records,
      'account.move': cancelSynced.records['account.move'].map((m) => (
        m.id === partId
          ? {
              ...m,
              amount_paid: 140,
              payments: [...(cancelOrig.payments ?? []), { id: 99, date: cancelNote.invoice_date, amount: 40, move_id: cancelRes.id }],
            }
          : m
      )),
    },
  };
  assert.throws(
    () => applyDiff(cancelSynced, diffDb(cancelSynced, forgedOverpayDb)),
    /paid amount cannot exceed/i
  );
});
