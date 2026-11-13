import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { applyCreditNote, creditNote, debitNote, payMove, postMove, settleWriteoff } from './models/accounting.js';
import { accountId, postEntry } from './models/ledger.js';
import { reverseEntry } from './models/pay.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { taxReport } from './models/finance.js';
import { applyDiff, diffDb } from './sync.js';

const move = (db, id) => read(db, 'account.move', id);

const accountBalance = (db, accId) => Math.round(
  (db.records['account.move'] ?? [])
    .filter((m) => m.state === 'posted')
    .flatMap((m) => m.line_ids ?? [])
    .filter((l) => l.account_id === accId)
    .reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0) * 100,
) / 100;

test('Finding 1: archived receivable/income accounts do not block system postings while manual selection still fails', () => {
  let db = seed();
  const cashAccId = accountId(db, '101401');
  const writeoffAccId = accountId(db, '600000');

  const recCreated = create(db, 'account.account', { code: '121990', name: 'Legacy Receivable', account_type: 'asset_receivable', reconcile: true, company_id: 1 });
  const incCreated = create(recCreated.db, 'account.account', { code: '400990', name: 'Legacy Income', account_type: 'income', company_id: 1 });
  db = incCreated.db;
  const legacyRecId = recCreated.id;
  const legacyIncId = incCreated.id;

  const partnerCreated = create(db, 'res.partner', { name: 'Legacy Customer', property_account_receivable_id: legacyRecId });
  db = partnerCreated.db;
  const partnerId = partnerCreated.id;

  const cashTax = create(db, 'account.tax', {
    name: 'Cash VAT 10% Archived',
    amount: 10,
    type_tax_use: 'sale',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(db, '251100'),
    ...defaultTaxRepartitionLines(accountId(db, '251000')),
  });
  db = cashTax.db;

  const fx = create(db, 'res.currency', { name: 'FXX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 4 }] });
  db = fx.db;

  const makePostedInv = (baseDb, { currencyId = null, tax = 0, date = '2026-01-10' } = {}) => {
    const snap = tax ? taxSnapshot(read(baseDb, 'account.tax', cashTax.id)) : { tax: 0 };
    const inv = create(baseDb, 'account.move', {
      move_type: 'out_invoice',
      partner_id: partnerId,
      company_id: 1,
      ...(currencyId ? { currency_id: currencyId } : {}),
      invoice_date: date,
      invoice_date_due: date,
      invoice_line_ids: [{ name: 'Legacy Service', account_id: legacyIncId, qty: 1, price_unit: 100, ...snap }],
    });
    return { db: postMove(inv.db, inv.id), id: inv.id };
  };

  // Post historical invoices and a manual entry while legacy accounts are active.
  const invForPay = makePostedInv(db, { currencyId: fx.id, tax: cashTax.id });
  const invForWriteoff = makePostedInv(invForPay.db, { tax: cashTax.id });
  const invForCredit = makePostedInv(invForWriteoff.db, { currencyId: fx.id });
  const invForDebit = makePostedInv(invForCredit.db);
  const manualEntry = postEntry(invForDebit.db, {
    journal: 'MISC',
    company: 1,
    date: '2026-01-10',
    ref: 'Historical Misc Entry',
    lines: [
      { account: legacyIncId, debit: 25 },
      { account: cashAccId, credit: 25 },
    ],
  });
  db = manualEntry.db;

  // Archive BOTH legacy receivable and legacy income accounts.
  db = write(db, 'account.account', legacyRecId, { active: false });
  db = write(db, 'account.account', legacyIncId, { active: false });
  const archivedMisc = create(db, 'account.account', { code: '699991', name: 'Archived Misc', account_type: 'expense', company_id: 1 });
  db = write(archivedMisc.db, 'account.account', archivedMisc.id, { active: false });

  // 1) Register payment (with FX + cash-basis release) on posted invoice succeeds.
  const paidDb = payMove(db, invForPay.id, 110, '2026-02-15');
  assert.equal(move(paidDb, invForPay.id).payment_state, 'paid');
  assert.ok(move(paidDb, invForPay.id).payments.at(-1).cash_basis_move_id);

  // 2) Write-off using an active write-off account succeeds; using an archived write-off account still fails.
  const writtenOffDb = settleWriteoff(db, invForWriteoff.id, 110, 110, '2026-02-15', {
    accountId: writeoffAccId,
    label: 'Bad debt write-off',
  }).db;
  assert.equal(move(writtenOffDb, invForWriteoff.id).payment_state, 'paid');
  assert.throws(
    () => settleWriteoff(db, invForWriteoff.id, 110, 110, '2026-02-15', { accountId: archivedMisc.id, label: 'Archived WO' }),
    /Archived accounts cannot be selected/,
  );

  // Payment and write-off without cash-basis system_generated entry also sync via applyDiff cleanly.
  assert.equal(move(applyDiff(db, diffDb(db, payMove(db, invForDebit.id, 100, '2026-02-15'))), invForDebit.id).payment_state, 'paid');
  assert.equal(move(applyDiff(db, diffDb(db, settleWriteoff(db, invForDebit.id, 100, 100, '2026-02-15', { accountId: writeoffAccId, label: 'WO' }).db)), invForDebit.id).payment_state, 'paid');

  // 3) Reverse posted manual entry using archived account succeeds.
  const reversed = reverseEntry(db, move(db, manualEntry.id), '2026-02-15');
  assert.equal(move(reversed.db, reversed.id).reversed_entry_id, manualEntry.id);
  assert.equal(move(reversed.db, reversed.id).state, 'posted');

  // 4) Credit note copying archived accounts (including FX diff entry) succeeds & syncs cleanly,
  //    while adding a manual line with an archived account to that draft still fails.
  const cnDraft = creditNote(db, move(db, invForCredit.id), { date: '2026-02-15' });
  assert.throws(
    () => write(cnDraft.db, 'account.move', cnDraft.id, {
      invoice_line_ids: [...move(cnDraft.db, cnDraft.id).invoice_line_ids, { name: 'Added', account_id: archivedMisc.id, qty: 1, price_unit: 10 }],
    }),
    /Archived accounts cannot be selected/,
  );
  const cnPosted = postMove(cnDraft.db, cnDraft.id);
  assert.equal(move(cnPosted, invForCredit.id).payment_state, 'paid');
  assert.equal(move(cnPosted, cnDraft.id).payment_state, 'paid');
  const cnSynced = applyDiff(db, diffDb(db, cnPosted));
  assert.equal(move(cnSynced, invForCredit.id).payment_state, 'paid');

  // 5) Debit note copying archived accounts succeeds & posts cleanly.
  const dnDraft = debitNote(db, move(db, invForDebit.id), { date: '2026-02-15', reason: 'Additional fee' });
  const dnPosted = postMove(dnDraft.db, dnDraft.id);
  assert.equal(move(dnPosted, dnDraft.id).state, 'posted');
  const dnSynced = applyDiff(db, diffDb(db, dnPosted));
  assert.equal(move(dnSynced, dnDraft.id).state, 'posted');

  // 6) Manual entry / direct invoice / adding new line choosing archived account still fails.
  assert.throws(
    () => postEntry(db, {
      journal: 'MISC',
      company: 1,
      date: '2026-02-15',
      lines: [
        { account_id: legacyIncId, debit: 50 },
        { account_id: cashAccId, credit: 50 },
      ],
    }),
    /Archived accounts cannot be selected/,
  );
  assert.throws(
    () => create(db, 'account.move', {
      move_type: 'entry',
      company_id: 1,
      date: '2026-02-15',
      line_ids: [
        { account_id: legacyRecId, debit: 50, credit: 0 },
        { account_id: cashAccId, debit: 0, credit: 50 },
      ],
    }),
    /Archived accounts cannot be selected/,
  );
  assert.throws(
    () => create(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: partnerId,
      company_id: 1,
      invoice_date: '2026-02-15',
      invoice_line_ids: [{ name: 'Manual', account_id: legacyIncId, qty: 1, price_unit: 50 }],
    }),
    /Archived accounts cannot be selected/,
  );
  // Direct create forged with reversed_entry_id without the workflow mechanism must also fail.
  assert.throws(
    () => create(db, 'account.move', {
      move_type: 'out_refund',
      partner_id: partnerId,
      company_id: 1,
      reversed_entry_id: invForDebit.id,
      invoice_date: '2026-02-15',
      invoice_line_ids: [{ name: 'Forged', account_id: archivedMisc.id, qty: 1, price_unit: 50 }],
    }),
    /Archived accounts cannot be selected/,
  );
});

test('Finding 2: standalone credit notes settling cash-basis invoices or bills release deferred tax and record cash_basis_move_id', () => {
  let db = seed();
  const saleTransId = accountId(db, '251100');
  const purchTransId = accountId(db, '131100');
  const saleTax = create(db, 'account.tax', {
    name: 'Sale Cash 10%',
    amount: 10,
    type_tax_use: 'sale',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: saleTransId,
    ...defaultTaxRepartitionLines(accountId(db, '251000')),
  });
  const purchTax = create(saleTax.db, 'account.tax', {
    name: 'Purchase Cash 10%',
    amount: 10,
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: purchTransId,
    ...defaultTaxRepartitionLines(accountId(saleTax.db, '131000')),
  });
  db = purchTax.db;

  // Customer invoice: 100 + 10 tax = 110; standalone credit note (tax-exempt): 110.
  const saleSnap = taxSnapshot(read(db, 'account.tax', saleTax.id));
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, ...saleSnap }],
  });
  const note = create(inv.db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    company_id: 1,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 110, tax: 0 }],
  });
  db = postMove(postMove(note.db, inv.id), note.id);

  // Before settlement: cash-basis tax is deferred in 251100, tax report shows 0 output tax.
  assert.equal(taxReport(db, { from: '2026-01-01', to: '2026-03-31', company_id: 1 }).output, 0);
  assert.equal(accountBalance(db, saleTransId), -10);

  // Partial settlement of 55 (half of 110) at 2026-02-01.
  db = applyCreditNote(db, note.id, inv.id, '2026-02-01', 55);
  assert.equal(taxReport(db, { from: '2026-02-01', to: '2026-02-28', company_id: 1 }).output, 5);
  assert.equal(accountBalance(db, saleTransId), -5);
  const invRow1 = move(db, inv.id).payments.at(-1);
  assert.ok(invRow1.cash_basis_move_id, 'invoice partial settlement must store cash_basis_move_id');
  assert.equal(move(db, invRow1.cash_basis_move_id).invoice_date, '2026-02-01');

  // Final settlement of remaining 55 at 2026-03-01.
  db = applyCreditNote(db, note.id, inv.id, '2026-03-01', 55);
  assert.equal(taxReport(db, { from: '2026-03-01', to: '2026-03-31', company_id: 1 }).output, 5);
  assert.equal(accountBalance(db, saleTransId), 0);
  const invRow2 = move(db, inv.id).payments.at(-1);
  assert.ok(invRow2.cash_basis_move_id, 'invoice final settlement must store cash_basis_move_id');

  // Vendor bill (100 + 10 cash-basis tax = 110) settled in full by standalone vendor refund (with its own 10% cash-basis tax = 110).
  const purchSnap = taxSnapshot(read(db, 'account.tax', purchTax.id));
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, ...purchSnap }],
  });
  const billNote = create(bill.db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    company_id: 1,
    invoice_date: '2026-01-12',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, ...purchSnap }],
  });
  db = postMove(postMove(billNote.db, bill.id), billNote.id);
  db = applyCreditNote(db, billNote.id, bill.id, '2026-02-10');
  const billRow = move(db, bill.id).payments.at(-1);
  const billNoteRow = move(db, billNote.id).payments.at(-1);
  assert.ok(billRow.cash_basis_move_id, 'bill settlement must release cash-basis tax');
  assert.ok(billNoteRow.cash_basis_move_id, 'vendor refund settlement must release cash-basis tax');
  assert.equal(accountBalance(db, purchTransId), 0);
  assert.equal(taxReport(db, { from: '2026-02-01', to: '2026-02-28', company_id: 1 }).input, 0);
});

test('Finding 3: linked credit note dated before its invoice posts using max date for auto-settlement while manual apply keeps date guard', () => {
  let db = seed();
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    invoice_date: '2026-02-15',
    invoice_date_due: '2026-02-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Linked credit note dated BEFORE the invoice posts without throwing and preserves its own date.
  const earlierLinked = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    company_id: 1,
    reversed_entry_id: inv.id,
    invoice_date: '2026-02-01',
    invoice_date_due: '2026-02-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }],
  });
  const postedLinked = postMove(earlierLinked.db, earlierLinked.id);
  assert.equal(move(postedLinked, earlierLinked.id).state, 'posted');
  assert.equal(move(postedLinked, earlierLinked.id).invoice_date, '2026-02-01', 'note keeps its own invoice_date');
  assert.equal(move(postedLinked, inv.id).amount_residual, 60);
  assert.equal(move(postedLinked, inv.id).payments.at(-1).date, '2026-02-15', 'settlement uses date >= both documents');

  // Standalone credit note dated earlier still fails manual applyCreditNote with an earlier application date.
  const earlierStandalone = create(postedLinked, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    company_id: 1,
    invoice_date: '2026-02-01',
    invoice_date_due: '2026-02-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 60, tax: 0 }],
  });
  db = postMove(earlierStandalone.db, earlierStandalone.id);
  assert.throws(
    () => applyCreditNote(db, earlierStandalone.id, inv.id, '2026-02-01'),
    /Reconciliation date cannot be before/,
  );
  const settledManual = applyCreditNote(db, earlierStandalone.id, inv.id, '2026-02-15');
  assert.equal(move(settledManual, inv.id).payment_state, 'paid');
});
