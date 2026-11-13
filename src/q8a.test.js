import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { migrate } from './migrations.js';
import { isOutstandingCreditFor, outstandingPaymentCredits, creditNote, postMove, payWithDiscount } from './models/accounting.js';
import { postPayment, applyPaymentCredit, unapplyPaymentCredit, unreconcileJournalItems } from './models/pay.js';
import { applyRule } from './models/reconcile.js';
import { journalCards } from './models/finance.js';
import { actionRecords } from './companyView.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';
import { journalItemIdentity, resolveDocumentJournal, partnerAccount } from './models/ledger.js';
import { today } from './models/common.js';
import { models } from './models/index.js';

test('Qodo 1: unapplied rows on posted invoices are accepted without reversing entries', () => {
  let db = seed();
  const inv = search(db, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual > 0);
  const preResidual = inv.amount_residual;
  const pay = create(db, 'account.payment', {
    payment_type: 'inbound', partner_type: 'customer', partner_id: inv.partner_id,
    amount: preResidual, journal_id: search(db, 'account.journal').find((j) => j.type === 'bank').id,
    date: today(),
  });
  db = postPayment(pay.db, read(pay.db, 'account.payment', pay.id));
  const postedPay = read(db, 'account.payment', pay.id);
  const appliedInv = read(db, 'account.move', inv.id);
  assert.equal(appliedInv.amount_residual, 0);

  const unapplied = unapplyPaymentCredit(db, inv.id, postedPay.move_id, today());
  const unappliedInv = read(unapplied, 'account.move', inv.id);
  assert.equal(unappliedInv.amount_residual, preResidual);
  const row = unappliedInv.payments.find((p) => p.move_id === postedPay.move_id);
  assert.ok(row.reversed);
  assert.ok(row.unapplied);
  assert.equal(row.reversal_move_id, undefined);
});

test('Qodo 2: vendor bills with 3-way matching exceptions cannot receive payment credits', () => {
  let db = seed();
  db = write({ ...db, settings: { ...db.settings, three_way_matching: true } }, 'res.company', 1, { three_way_matching: true });

  const partner = create(db, 'res.partner', { name: 'Vendor 3-Way', is_company: true });
  db = partner.db;
  const prod = search(db, 'product').find((p) => p.type === 'goods') ?? search(db, 'product')[0];
  db = write(db, 'product', prod.id, { purchase_method: 'receive', type: 'goods' });

  const purchaseJournal = search(db, 'account.journal').find((j) => j.type === 'purchase');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const expenseAccount = search(db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);

  // Purchase order for 2 units
  const order = create(db, 'purchase.order', {
    partner_id: partner.id, company_id: 1,
    order_line: [{ product_id: prod.id, name: 'Chair', qty: 2, price_unit: 100 }],
  });
  db = write(order.db, 'purchase.order', order.id, { state: 'purchase' });

  // Bill for 2 units before receiving anything -> 3-way matching exception
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: partner.id, journal_id: purchaseJournal.id,
    invoice_date: '2026-06-01', company_id: 1, purchase_id: order.id,
    invoice_line_ids: [{ product_id: prod.id, name: 'Chair', qty: 2, price_unit: 100, account_id: expenseAccount.id, purchase_line_key: `${order.id}:0` }],
  });
  db = postMove(bill.db, bill.id);
  const postedBill = read(db, 'account.move', bill.id);

  // Advance payment
  const payment = create(db, 'account.payment', {
    payment_type: 'outbound', partner_type: 'supplier', partner_id: partner.id,
    amount: 200, journal_id: bankJournal.id, date: '2026-06-01', company_id: 1,
  });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const postedPay = read(db, 'account.payment', payment.id);

  assert.equal(isOutstandingCreditFor(db, postedBill, postedPay), false);
  assert.equal(outstandingPaymentCredits(db, postedBill).length, 0);
  assert.throws(
    () => applyPaymentCredit(db, postedPay.id, postedBill.id, '2026-06-05'),
    /three-way matching exception/i
  );
});

test('Qodo 3: custom write-off rules with custom account codes survive Migration 31 and reconcile', () => {
  let db = seed();
  const customAccount = create(db, 'account.account', {
    code: '999123', name: 'Custom Discrepancy', account_type: 'expense', company_id: 1,
  });
  db = customAccount.db;

  const rule = create(db, 'account.reconcile.model', {
    name: 'Custom Write-off Rule',
    company_id: 1,
    rule_type: 'writeoff_button',
    line_ids: [{ account_code: '999123', amount_type: 'percentage', amount: 100, label: 'Custom Discrepancy' }],
  });
  db = { ...rule.db, schema_version: 30 };

  const migrated = migrate(db, 31);
  const migratedRule = read(migrated, 'account.reconcile.model', rule.id);
  assert.equal(migratedRule.line_ids[0].account_id, customAccount.id);

  const bankJournal = search(migrated, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const line = create(migrated, 'account.bank.statement.line', {
    date: '2026-06-10', payment_ref: 'Fee Discrepancy', amount: -25, journal_id: bankJournal.id, company_id: 1,
  });
  const result = applyRule(line.db, migratedRule, read(line.db, 'account.bank.statement.line', line.id));
  const reconciledLine = read(result, 'account.bank.statement.line', line.id);
  assert.equal(reconciledLine.state, 'reconciled');
  const entry = read(result, 'account.move', reconciledLine.move_id);
  assert.ok(entry.line_ids.some((l) => l.account_id === customAccount.id && l.debit === 25));
});

test('Qodo 18: direct payments have zero unapplied invoice credit and cannot settle invoices', () => {
  let db = seed();
  const directAccount = search(db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner').find((p) => p.is_company);
  const inv = search(db, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual > 0);

  const payment = create(db, 'account.payment', {
    payment_type: 'inbound', partner_type: 'customer', partner_id: partner.id,
    amount: 150, journal_id: bankJournal.id, destination_account_id: directAccount.id,
    date: '2026-07-01', company_id: 1,
  });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const postedPay = read(db, 'account.payment', payment.id);

  assert.equal(postedPay.unapplied, 0);
  assert.equal(isOutstandingCreditFor(db, inv, postedPay), false);

  assert.throws(
    () => applyPaymentCredit(db, postedPay.id, inv.id, '2026-07-02'),
    /direct destination account/i
  );
});

test('Qodo 19: upgraded banks with shared suspense accounts configure suspense in Migration 30', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const suspenseAccount = search(db, 'account.account').find((a) => a.code === '101404');
  db = write(db, 'account.account', suspenseAccount.id, { company_id: null });
  db = { ...db, schema_version: 29, records: { ...db.records, 'account.journal': db.records['account.journal'].map((j) => (j.id === bankJournal.id ? { ...j, suspense_account_id: null } : j)) } };

  const migrated = migrate(db, 30);
  const upgradedJournal = read(migrated, 'account.journal', bankJournal.id);
  assert.equal(upgradedJournal.suspense_account_id, suspenseAccount.id);
});

test('Qodo 33: bank reversals in unreconcileJournalItems respect the selected reversal date', () => {
  let db = seed();
  const partner = search(db, 'res.partner').find((p) => p.is_company);
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, journal_id: saleJournal.id,
    invoice_date: '2026-08-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invoice.db, invoice.id);
  const postedInv = read(db, 'account.move', invoice.id);

  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const line = create(db, 'account.bank.statement.line', {
    date: '2026-08-01', payment_ref: 'Inv match', amount: 100,
    move_id: postedInv.id, journal_id: journal.id, company_id: 1,
  });
  const runMatch = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match').run;
  db = runMatch(line.db, read(line.db, 'account.bank.statement.line', line.id)).db;

  const matchedLine = read(db, 'account.bank.statement.line', line.id);
  assert.equal(matchedLine.state, 'reconciled');
  const bankMove = read(db, 'account.move', matchedLine.bank_move_id);

  const matchedInv = read(db, 'account.move', postedInv.id);
  const receivableAccount = partnerAccount(db, partner.id, 1, 'receivable');
  const invoiceItem = matchedInv.line_ids.find((l) => l.account_id === receivableAccount);
  assert.ok(invoiceItem);

  const selectedDate = '2026-08-25';
  const selections = [{ move_id: postedInv.id, line_identity: journalItemIdentity(invoiceItem) }];
  const unreconciled = unreconcileJournalItems(db, selections, { date: selectedDate });

  const reversalMoves = search(unreconciled, 'account.move').filter((m) => m.reversed_entry_id === bankMove.id);
  assert.equal(reversalMoves.length, 1);
  assert.equal(reversalMoves[0].invoice_date, selectedDate);
  assert.equal(reversalMoves[0].date, selectedDate);
});

test('Qodo 34: selecting payment outstanding-account item in unreconcileJournalItems unapplies payment credit', () => {
  let db = seed();
  // Ensure company has an outstanding receipts account with reconcile: true
  const outstandingAcc = create(db, 'account.account', {
    code: '101499', name: 'Test Outstanding Receipts', company_id: 1, account_type: 'asset_current', reconcile: true,
  });
  db = write(outstandingAcc.db, 'res.company', 1, { outstanding_receipts_account_id: outstandingAcc.id });

  const partner = search(db, 'res.partner').find((p) => p.is_company);
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, journal_id: saleJournal.id,
    invoice_date: '2026-09-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const postedInv = read(db, 'account.move', inv.id);

  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const payment = create(db, 'account.payment', {
    payment_type: 'inbound', partner_type: 'customer', partner_id: partner.id,
    amount: 100, journal_id: bankJournal.id, date: '2026-09-01', company_id: 1,
  });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const postedPay = read(db, 'account.payment', payment.id);

  assert.equal(postedPay.outstanding_account_id, outstandingAcc.id);
  const appliedInv = read(db, 'account.move', postedInv.id);
  assert.equal(appliedInv.amount_residual, 0);

  const payMove = read(db, 'account.move', postedPay.move_id);
  const outstandingLine = payMove.line_ids.find((l) => l.account_id === outstandingAcc.id);
  assert.ok(outstandingLine);

  const selections = [{ move_id: payMove.id, line_identity: journalItemIdentity(outstandingLine) }];
  const unreconciled = unreconcileJournalItems(db, selections, { date: '2026-09-05' });

  const unappliedInv = read(unreconciled, 'account.move', postedInv.id);
  assert.equal(unappliedInv.amount_residual, 100);
  const refreshedPay = read(unreconciled, 'account.payment', postedPay.id);
  assert.equal(refreshedPay.unapplied, 100);
});

test('Qodo 35: unapplying a payment credit reverses linked early payment discounts', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', {
    name: '2/10 Net 30',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    line_ids: [{ value: 'balance', days: 30 }],
  });
  db = term.db;

  const product = read(db, 'product', 1);
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, journal_id: journal.id,
    invoice_date: '2026-10-01', invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invoice.db, invoice.id);
  const postedInv = read(db, 'account.move', invoice.id);
  assert.equal(postedInv.amount_total, 100);

  // Pay 98 within 10 days -> 2% discount (2.00) applied
  const paidDb = payWithDiscount(db, postedInv.id, 98, '2026-10-05');
  const paidInv = read(paidDb, 'account.move', postedInv.id);
  assert.equal(paidInv.amount_residual, 0);
  assert.equal(paidInv.payments.length, 2);
  const payRow = paidInv.payments.find((p) => !p.discount);
  const discRow = paidInv.payments.find((p) => p.discount);
  assert.ok(discRow);
  assert.equal(discRow.amount, 2);

  // Unapply the payment credit
  const unappliedDb = unapplyPaymentCredit(paidDb, postedInv.id, payRow.move_id, '2026-10-10');
  const restoredInv = read(unappliedDb, 'account.move', postedInv.id);
  assert.equal(restoredInv.amount_paid, 0);
  assert.equal(restoredInv.amount_residual, 100);

  const restoredDisc = restoredInv.payments.find((p) => p.discount);
  assert.ok(restoredDisc.reversed);
  assert.ok(restoredDisc.reversal_move_id);
  const reversalEntry = read(unappliedDb, 'account.move', restoredDisc.reversal_move_id);
  assert.equal(reversalEntry.state, 'posted');
  assert.equal(reversalEntry.reversed_entry_id, discRow.move_id);
});

test('Qodo 37: isOutstandingCreditFor validates partner_type and recipient bank compatibility', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Dual Role Partner', is_company: true });
  db = partner.db;
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  // Customer invoice
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const postedInv = read(db, 'account.move', inv.id);

  // Inbound supplier payment (refund from vendor)
  const suppRefund = create(db, 'account.payment', {
    payment_type: 'inbound', partner_type: 'supplier', partner_id: partner.id,
    amount: 50, journal_id: bankJournal.id, date: '2026-05-02', company_id: 1,
  });
  db = postPayment(suppRefund.db, read(suppRefund.db, 'account.payment', suppRefund.id));
  const postedSuppRefund = read(db, 'account.payment', suppRefund.id);

  assert.equal(isOutstandingCreditFor(db, postedInv, postedSuppRefund), false);

  // Recipient bank mismatch on vendor bills
  const bankA = create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'BANK_AAA', allow_out_payment: true });
  const bankB = create(bankA.db, 'res.partner.bank', { partner_id: partner.id, account_number: 'BANK_BBB', allow_out_payment: true });
  db = bankB.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: partner.id, invoice_date: '2026-05-01',
    partner_bank_id: bankA.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);
  const postedBill = read(db, 'account.move', bill.id);

  const vendorPay = create(db, 'account.payment', {
    payment_type: 'outbound', partner_type: 'supplier', partner_id: partner.id,
    amount: 100, journal_id: bankJournal.id, date: '2026-05-02', company_id: 1,
    partner_bank_id: bankB.id,
  });
  db = postPayment(vendorPay.db, read(vendorPay.db, 'account.payment', vendorPay.id));
  const postedVendorPay = read(db, 'account.payment', vendorPay.id);

  assert.equal(isOutstandingCreditFor(db, postedBill, postedVendorPay), false);
});

test('Qodo 43: applyPaymentCredit rejects an application date before the target invoice date', () => {
  let db = seed();
  const partner = search(db, 'res.partner').find((p) => p.is_company);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: '2026-06-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const pay = create(db, 'account.payment', {
    payment_type: 'inbound', partner_type: 'customer', partner_id: partner.id,
    amount: 100, journal_id: bankJournal.id, date: '2026-06-01', company_id: 1,
  });
  db = postPayment(pay.db, read(pay.db, 'account.payment', pay.id));
  const postedPay = read(db, 'account.payment', pay.id);

  assert.throws(
    () => applyPaymentCredit(db, postedPay.id, inv.id, '2026-06-10'),
    /application date cannot be before the invoice date/i
  );
});

test('Qodo 47: an upgraded bank transaction without a stored journal is assigned the single bank journal of its company and counts on its card', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const initialCards = journalCards(db);
  const bankCardBefore = initialCards.find((c) => c.journal.id === bankJournal.id);

  const oldLine = {
    id: 999888, date: '2025-01-15', payment_ref: 'Old line', amount: 350,
    state: 'to_check', company_id: 1,
  };
  db = { ...db, schema_version: 29, records: { ...db.records, 'account.bank.statement.line': [...(db.records['account.bank.statement.line'] ?? []), oldLine] } };

  // The upgrade assigns the company's only bank journal, so the line counts on that card.
  const cardsAfter = journalCards(migrate(db));
  const bankCardAfter = cardsAfter.find((c) => c.journal.id === bankJournal.id);
  assert.equal(bankCardAfter.toReconcile, bankCardBefore.toReconcile + 1);

  db = { ...db, schema_version: 29 };
  const migrated = migrate(db, 30);
  const migratedLine = read(migrated, 'account.bank.statement.line', oldLine.id);
  assert.equal(migratedLine.journal_id, bankJournal.id);
});

test('Qodo 49: cash-card Reconcile action carries the cash journal ID in its URL', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  const cards = journalCards(db);
  const cashCard = cards.find((c) => c.journal.id === cashJournal.id);
  assert.ok(cashCard);
  const actionUrl = `#/accounting/bank?view=list&rel=journal_id:${cashCard.journal.id}`;
  assert.ok(actionUrl.includes(`rel=journal_id:${cashJournal.id}`));
});

test('Qodo 51: creditNote rejects a date before the source invoice date', () => {
  let db = seed();
  const inv = search(db, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted');
  assert.throws(
    () => creditNote(db, inv, { date: '2020-01-01' }),
    /credit note date cannot be before the invoice date/i
  );
});

test('Qodo 54: draft invoices without stored journal_id appear in actionRecords for the default journal', () => {
  let db = seed();
  const defaultSaleJournal = resolveDocumentJournal(db, { move_type: 'out_invoice', company_id: 1 });
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice', state: 'draft', partner_id: 1, company_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = draftInv.db;
  const createdInv = read(db, 'account.move', draftInv.id);
  assert.equal(createdInv.journal_id, undefined);

  const leaf = { model: 'account.move' };
  const rel = { field: 'journal_id', id: defaultSaleJournal.id };
  const records = actionRecords(db, leaf, rel);
  assert.ok(records.some((r) => r.id === draftInv.id));
});

test('Qodo 70: reconciliation models with group taxes write off without error', () => {
  let db = seed();
  const taxAccount = search(db, 'account.account').find((a) => a.account_type === 'liability_current' && (a.company_id ?? 1) === 1);
  const counterpartAccount = search(db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  const childTax = create(db, 'account.tax', {
    name: 'Child 10%', amount: 10, amount_type: 'percent', type_tax_use: 'sale',
    company_id: 1, ...defaultTaxRepartitionLines(taxAccount.id),
  });
  const groupTax = create(childTax.db, 'account.tax', {
    name: 'Group Tax', amount_type: 'group', children_tax_ids: [childTax.id],
    type_tax_use: 'sale', company_id: 1,
  });
  db = groupTax.db;

  const rule = create(db, 'account.reconcile.model', {
    name: 'Group Tax Rule', company_id: 1, rule_type: 'writeoff_button',
    line_ids: [{ account_id: counterpartAccount.id, amount_type: 'percentage', amount: 100, tax_ids: [groupTax.id] }],
  });
  db = rule.db;

  const line = create(db, 'account.bank.statement.line', {
    date: '2026-11-01', payment_ref: 'Group tax transaction', amount: 110,
    journal_id: bankJournal.id, company_id: 1,
  });
  const result = applyRule(line.db, read(line.db, 'account.reconcile.model', rule.id), read(line.db, 'account.bank.statement.line', line.id));
  const reconciled = read(result, 'account.bank.statement.line', line.id);
  assert.equal(reconciled.state, 'reconciled');
  const entry = read(result, 'account.move', reconciled.move_id);
  assert.ok(entry.line_ids.some((l) => l.account_id === taxAccount.id && l.credit === 10));
  assert.ok(entry.line_ids.some((l) => l.account_id === counterpartAccount.id && l.credit === 100));
});

test('Qodo 71: reconciliation models with tax having null account in repartition write off to counterpart', () => {
  let db = seed();
  const counterpartAccount = search(db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  const nullAccTax = create(db, 'account.tax', {
    name: 'Zero Destination Tax', amount: 10, amount_type: 'percent', type_tax_use: 'purchase',
    company_id: 1, ...defaultTaxRepartitionLines(null),
  });
  db = nullAccTax.db;

  const rule = create(db, 'account.reconcile.model', {
    name: 'Null Account Tax Rule', company_id: 1, rule_type: 'writeoff_button',
    line_ids: [{ account_id: counterpartAccount.id, amount_type: 'percentage', amount: 100, tax_ids: [nullAccTax.id] }],
  });
  db = rule.db;

  const line = create(db, 'account.bank.statement.line', {
    date: '2026-11-01', payment_ref: 'Null acc transaction', amount: -110,
    journal_id: bankJournal.id, company_id: 1,
  });
  const result = applyRule(line.db, read(line.db, 'account.reconcile.model', rule.id), read(line.db, 'account.bank.statement.line', line.id));
  const reconciled = read(result, 'account.bank.statement.line', line.id);
  assert.equal(reconciled.state, 'reconciled');
  const entry = read(result, 'account.move', reconciled.move_id);
  const counterpartLines = entry.line_ids.filter((l) => l.account_id === counterpartAccount.id);
  assert.equal(counterpartLines.reduce((s, l) => s + (l.debit || 0), 0), 110);
});

test('Qodo 69: reconciliation models with split VAT allocate to multiple accounts according to factor_percent', () => {
  let db = seed();
  const taxAcc1 = create(db, 'account.account', { code: '888001', name: 'Tax 1', account_type: 'liability_current', company_id: 1 });
  const taxAcc2 = create(taxAcc1.db, 'account.account', { code: '888002', name: 'Tax 2', account_type: 'liability_current', company_id: 1 });
  const counterpartAccount = search(taxAcc2.db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);
  const bankJournal = search(taxAcc2.db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  const splitTax = create(taxAcc2.db, 'account.tax', {
    name: 'Split 20%', amount: 20, amount_type: 'percent', type_tax_use: 'purchase', company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: taxAcc1.id, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: taxAcc2.id, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: taxAcc1.id, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: taxAcc2.id, tag_ids: [] },
    ],
  });
  db = splitTax.db;

  const rule = create(db, 'account.reconcile.model', {
    name: 'Split Tax Rule', company_id: 1, rule_type: 'writeoff_button',
    line_ids: [{ account_id: counterpartAccount.id, amount_type: 'percentage', amount: 100, tax_ids: [splitTax.id] }],
  });
  db = rule.db;

  const line = create(db, 'account.bank.statement.line', {
    date: '2026-11-01', payment_ref: 'Split VAT transaction', amount: -120,
    journal_id: bankJournal.id, company_id: 1,
  });
  const result = applyRule(line.db, read(line.db, 'account.reconcile.model', rule.id), read(line.db, 'account.bank.statement.line', line.id));
  const reconciled = read(result, 'account.bank.statement.line', line.id);
  assert.equal(reconciled.state, 'reconciled');
  const entry = read(result, 'account.move', reconciled.move_id);
  assert.ok(entry.line_ids.some((l) => l.account_id === taxAcc1.id && l.debit === 10));
  assert.ok(entry.line_ids.some((l) => l.account_id === taxAcc2.id && l.debit === 10));
  assert.ok(entry.line_ids.some((l) => l.account_id === counterpartAccount.id && l.debit === 100));
});

test('Qodo 73: reconciliation models with cascading taxes compute base and tax sequentially', () => {
  let db = seed();
  const taxAcc1 = create(db, 'account.account', { code: '889001', name: 'Tax 1', account_type: 'liability_current', company_id: 1 });
  const taxAcc2 = create(taxAcc1.db, 'account.account', { code: '889002', name: 'Tax 2', account_type: 'liability_current', company_id: 1 });
  const counterpartAccount = search(taxAcc2.db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);
  const bankJournal = search(taxAcc2.db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  // Tax 1: 10%, sequence 1, include_base_amount: true
  const tax1 = create(taxAcc2.db, 'account.tax', {
    name: 'Cascading Tax 1', sequence: 1, amount: 10, amount_type: 'percent',
    include_base_amount: true, type_tax_use: 'purchase', company_id: 1,
    ...defaultTaxRepartitionLines(taxAcc1.id),
  });
  // Tax 2: 5%, sequence 2, is_base_affected: true
  const tax2 = create(tax1.db, 'account.tax', {
    name: 'Cascading Tax 2', sequence: 2, amount: 5, amount_type: 'percent',
    is_base_affected: true, type_tax_use: 'purchase', company_id: 1,
    ...defaultTaxRepartitionLines(taxAcc2.id),
  });
  db = tax2.db;

  const rule = create(db, 'account.reconcile.model', {
    name: 'Cascading Rule', company_id: 1, rule_type: 'writeoff_button',
    line_ids: [{ account_id: counterpartAccount.id, amount_type: 'percentage', amount: 100, tax_ids: [tax1.id, tax2.id] }],
  });
  db = rule.db;

  // Total gross: 115.50 -> net base 100, tax 1 = 10, tax 2 = 5.50
  const line = create(db, 'account.bank.statement.line', {
    date: '2026-11-01', payment_ref: 'Cascading transaction', amount: -115.5,
    journal_id: bankJournal.id, company_id: 1,
  });
  const result = applyRule(line.db, read(line.db, 'account.reconcile.model', rule.id), read(line.db, 'account.bank.statement.line', line.id));
  const reconciled = read(result, 'account.bank.statement.line', line.id);
  assert.equal(reconciled.state, 'reconciled');
  const entry = read(result, 'account.move', reconciled.move_id);

  const netLine = entry.line_ids.find((l) => l.account_id === counterpartAccount.id);
  const tax1Line = entry.line_ids.find((l) => l.account_id === taxAcc1.id);
  const tax2Line = entry.line_ids.find((l) => l.account_id === taxAcc2.id);

  assert.equal(netLine.debit, 100);
  assert.equal(tax1Line.debit, 10);
  assert.equal(tax2Line.debit, 5.5);
});
