import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { createCompany } from './models/company.js';
import { postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';

test('Qodo 2: offline vendor bill posting syncs when both invoice and bill are posted before first sync', () => {
  const base = seed();
  const buyer = createCompany(base, { name: 'Buyer', currency_id: read(base, 'res.company', 1).currency_id, intercompany_rule: 'invoice_bill' });
  const expense = create(buyer.db, 'account.account', { name: 'Buyer expense', code: 'BUY-EXP', account_type: 'expense', company_id: buyer.id });
  const journal = create(expense.db, 'account.journal', { name: 'Buyer purchases', code: 'BP', type: 'purchase', company_id: buyer.id, default_account_id: expense.id, invoice_sequence_prefix: 'BP-INV/', invoice_sequence_next_number: 1 });
  const configured = write(write(journal.db, 'res.company', buyer.id, { intercompany_journal_id: journal.id }), 'product', 5, { property_account_expense_id: expense.id });

  const invoice = create(configured, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: read(configured, 'res.company', buyer.id).partner_id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: 5, name: 'Product 5', qty: 1, price_unit: 100, tax: 0 }],
  });
  const postedInvoice = postMove(invoice.db, invoice.id);
  const billId = read(postedInvoice, 'account.move', invoice.id).intercompany_move_id;
  assert.ok(billId, 'Counterpart bill should be created');

  // Both the invoice and the vendor bill are posted locally before the first sync
  const postedBoth = postMove(postedInvoice, billId);
  const bill = read(postedBoth, 'account.move', billId);
  assert.equal(bill.state, 'posted', 'Counterpart bill was posted locally');

  const diff = diffDb(configured, postedBoth);

  // 1. Genuine save applies successfully
  const synced = applyDiff(configured, diff, { author: 'admin', isAdmin: true });
  const syncedInvoice = read(synced, 'account.move', invoice.id);
  const syncedBill = read(synced, 'account.move', billId);
  assert.equal(syncedInvoice.state, 'posted');
  assert.equal(syncedBill.state, 'posted');
  assert.equal(syncedInvoice.intercompany_move_id, billId);
  assert.equal(syncedBill.intercompany_move_id, invoice.id);

  // 2. Tampered journal items on posted counterpart are rejected
  const tamperedJournalDiff = structuredClone(diff);
  const counterpartJournal = tamperedJournalDiff.upserts['account.move'].find((m) => m.id === billId);
  counterpartJournal.line_ids[0].credit = 99999;
  assert.throws(
    () => applyDiff(configured, tamperedJournalDiff, { author: 'admin', isAdmin: true }),
    /Invalid inter-company counterpart: contents do not match the source/,
  );

  // 3. Tampered invoice lines on posted counterpart are rejected
  const tamperedPriceDiff = structuredClone(diff);
  const counterpartPrice = tamperedPriceDiff.upserts['account.move'].find((m) => m.id === billId);
  counterpartPrice.invoice_line_ids[0].price_unit = 99999;
  assert.throws(
    () => applyDiff(configured, tamperedPriceDiff, { author: 'admin', isAdmin: true }),
    /Invalid inter-company counterpart: contents do not match the source/,
  );

  // 4. Missing/default name on posted counterpart is rejected
  const tamperedNameDiff = structuredClone(diff);
  const counterpartName = tamperedNameDiff.upserts['account.move'].find((m) => m.id === billId);
  counterpartName.name = '/';
  assert.throws(
    () => applyDiff(configured, tamperedNameDiff, { author: 'admin', isAdmin: true }),
    /Invalid inter-company counterpart: contents do not match the source/,
  );

  // 5. Invalid state on counterpart is rejected
  const tamperedStateDiff = structuredClone(diff);
  const counterpartState = tamperedStateDiff.upserts['account.move'].find((m) => m.id === billId);
  counterpartState.state = 'cancel';
  assert.throws(
    () => applyDiff(configured, tamperedStateDiff, { author: 'admin', isAdmin: true }),
    /Invalid inter-company counterpart: contents do not match the source/,
  );
});

test('Qodo 2: offline credit note and refund counterpart sync when both are posted before sync', () => {
  const base = seed();
  const buyer = createCompany(base, { name: 'Buyer', currency_id: read(base, 'res.company', 1).currency_id, intercompany_rule: 'invoice_bill' });
  const expense = create(buyer.db, 'account.account', { name: 'Buyer expense', code: 'BUY-EXP', account_type: 'expense', company_id: buyer.id });
  const journal = create(expense.db, 'account.journal', {
    name: 'Buyer purchases',
    code: 'BP',
    type: 'purchase',
    company_id: buyer.id,
    default_account_id: expense.id,
    invoice_sequence_prefix: 'BP-INV/',
    invoice_sequence_next_number: 1,
    refund_sequence_prefix: 'BP-REF/',
    refund_sequence_next_number: 1,
  });
  const configured = write(write(journal.db, 'res.company', buyer.id, { intercompany_journal_id: journal.id }), 'product', 5, { property_account_expense_id: expense.id });

  // Post original invoice and bill, then sync to establish base state
  const invoice = create(configured, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: read(configured, 'res.company', buyer.id).partner_id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: 5, name: 'Product 5', qty: 1, price_unit: 100, tax: 0 }],
  });
  const postedInvoice = postMove(invoice.db, invoice.id);
  const billId = read(postedInvoice, 'account.move', invoice.id).intercompany_move_id;
  const postedBase = postMove(postedInvoice, billId);
  const syncedBase = applyDiff(configured, diffDb(configured, postedBase), { author: 'admin', isAdmin: true });

  // Create and post credit note and its counterpart refund locally before next sync
  const creditNote = create(syncedBase, 'account.move', {
    company_id: 1,
    move_type: 'out_refund',
    partner_id: read(syncedBase, 'res.company', buyer.id).partner_id,
    reversed_entry_id: invoice.id,
    invoice_date: '2026-01-02',
    invoice_line_ids: [{ product_id: 5, name: 'Product 5', qty: 1, price_unit: 100, tax: 0 }],
  });
  const postedCreditNote = postMove(creditNote.db, creditNote.id);
  const refundId = read(postedCreditNote, 'account.move', creditNote.id).intercompany_move_id;
  assert.ok(refundId, 'Counterpart refund should be created');

  const postedBoth = postMove(postedCreditNote, refundId);
  const refund = read(postedBoth, 'account.move', refundId);
  assert.equal(refund.state, 'posted');

  const diff = diffDb(syncedBase, postedBoth);
  const synced = applyDiff(syncedBase, diff, { author: 'admin', isAdmin: true });
  const syncedNote = read(synced, 'account.move', creditNote.id);
  const syncedRefund = read(synced, 'account.move', refundId);
  assert.equal(syncedNote.state, 'posted');
  assert.equal(syncedRefund.state, 'posted');
  assert.equal(syncedNote.intercompany_move_id, refundId);
  assert.equal(syncedRefund.intercompany_move_id, creditNote.id);
});
