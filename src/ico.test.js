import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { creditNote, payWithDiscount, postMove } from './models/accounting.js';
import { diffDb, applyDiff } from './sync.js';
import { models } from './models/index.js';

test('intercompany credit note links its vendor refund to the original vendor bill', () => {
  const base = seed();
  const buyer = createCompany(base, { name: 'Buyer', currency_id: read(base, 'res.company', 1).currency_id, intercompany_rule: 'invoice_bill' });
  const expense = create(buyer.db, 'account.account', { name: 'Buyer expense', code: 'BUY-EXP', account_type: 'expense', company_id: buyer.id });
  const journal = create(expense.db, 'account.journal', { name: 'Buyer purchases', code: 'BP', type: 'purchase', company_id: buyer.id, default_account_id: expense.id });
  const configured = write(write(journal.db, 'res.company', buyer.id, { intercompany_journal_id: journal.id }), 'product', 5, { property_account_expense_id: expense.id });
  const invoice = create(configured, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: read(configured, 'res.company', buyer.id).partner_id, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = postMove(invoice.db, invoice.id);
  const source = read(posted, 'account.move', invoice.id);
  const bill = read(posted, 'account.move', source.intercompany_move_id);
  const credit = creditNote(posted, source, { date: '2026-01-02' });
  const credited = postMove(credit.db, credit.id);
  const note = read(credited, 'account.move', credit.id);
  const refund = read(credited, 'account.move', note.intercompany_move_id);
  assert.equal(refund.move_type, 'in_refund');
  assert.equal(refund.company_id, buyer.id);
  assert.equal(refund.intercompany_move_id, note.id);
  assert.equal(refund.reversed_entry_id, bill.id);
});

test('reset cancels the draft counterpart and repost replaces it with one live counterpart', () => {
  const base = seed();
  const buyer = createCompany(base, { name: 'Buyer', currency_id: read(base, 'res.company', 1).currency_id, intercompany_rule: 'invoice_bill' });
  const expense = create(buyer.db, 'account.account', { name: 'Buyer expense', code: 'BUY-EXP', account_type: 'expense', company_id: buyer.id });
  const journal = create(expense.db, 'account.journal', { name: 'Buyer purchases', code: 'BP', type: 'purchase', company_id: buyer.id, default_account_id: expense.id });
  const configured = write(write(journal.db, 'res.company', buyer.id, { intercompany_journal_id: journal.id }), 'product', 5, { property_account_expense_id: expense.id });
  const invoice = create(configured, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: read(configured, 'res.company', buyer.id).partner_id, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = postMove(invoice.db, invoice.id);
  const source = read(posted, 'account.move', invoice.id);
  const reset = models['account.move'].form.buttons.find((button) => button.label === 'Reset to Draft');
  const resetDb = reset.run(posted, source).db;
  assert.equal(read(resetDb, 'account.move', source.intercompany_move_id).state, 'cancel');
  const reposted = postMove(resetDb, source.id);
  const replacement = read(reposted, 'account.move', read(reposted, 'account.move', source.id).intercompany_move_id);
  assert.notEqual(replacement.id, source.intercompany_move_id);
  assert.equal(replacement.state, 'draft');
  assert.equal(read(reposted, 'account.move', source.intercompany_move_id).state, 'cancel');
  assert.equal((reposted.records['account.move'] ?? []).filter((move) => move.intercompany_move_id === source.id && move.state !== 'cancel').length, 1);
});

test('cancel cancels draft counterpart; posted or paid counterpart blocks reset and cancel', () => {
  const base = seed();
  const buyer = createCompany(base, { name: 'Buyer', currency_id: read(base, 'res.company', 1).currency_id, intercompany_rule: 'invoice_bill' });
  const expense = create(buyer.db, 'account.account', { name: 'Buyer expense', code: 'BUY-EXP', account_type: 'expense', company_id: buyer.id });
  const journal = create(expense.db, 'account.journal', { name: 'Buyer purchases', code: 'BP', type: 'purchase', company_id: buyer.id, default_account_id: expense.id, invoice_sequence_prefix: 'BP-INV/', invoice_sequence_next_number: 1 });
  const configured = write(write(journal.db, 'res.company', buyer.id, { intercompany_journal_id: journal.id }), 'product', 5, { property_account_expense_id: expense.id });
  const invoice = create(configured, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: read(configured, 'res.company', buyer.id).partner_id, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = postMove(invoice.db, invoice.id);
  const source = read(posted, 'account.move', invoice.id);
  const bill = read(posted, 'account.move', source.intercompany_move_id);

  // 1. Cancel button on the source resets and cancels draft counterpart
  const resetBtn = models['account.move'].form.buttons.find((button) => button.label === 'Reset to Draft');
  const cancelBtn = models['account.move'].form.buttons.find((button) => button.label === 'Cancel');
  const resetDb = resetBtn.run(posted, source).db;
  assert.equal(read(resetDb, 'account.move', bill.id).state, 'cancel');
  const cancelDb = cancelBtn.run(resetDb, read(resetDb, 'account.move', source.id)).db;
  assert.equal(read(cancelDb, 'account.move', source.id).state, 'cancel');
  assert.equal(read(cancelDb, 'account.move', bill.id).state, 'cancel');

  // 2. Posted counterpart blocks reset and cancel
  const withPostedBill = postMove(posted, bill.id);
  assert.throws(() => resetBtn.run(withPostedBill, read(withPostedBill, 'account.move', source.id)), /The inter-company bill is posted or paid; issue a credit note instead/);
  assert.throws(() => write(withPostedBill, 'account.move', source.id, { state: 'cancel' }), /The inter-company bill is posted or paid; issue a credit note instead/);

  // 3. Paid counterpart blocks reset and cancel
  const withPaidBill = payWithDiscount(withPostedBill, bill.id, 100);
  assert.equal(read(withPaidBill, 'account.move', bill.id).amount_paid, 100);
  assert.throws(() => resetBtn.run(withPaidBill, read(withPaidBill, 'account.move', source.id)), /The inter-company bill is posted or paid; issue a credit note instead/);
  assert.throws(() => write(withPaidBill, 'account.move', source.id, { state: 'cancel' }), /The inter-company bill is posted or paid; issue a credit note instead/);
});

test('intercompany bill maps lines through buyer expense accounts, taxes, and fiscal position with strict errors and no fallbacks', () => {
  const base = seed();
  const buyer = createCompany(base, { name: 'Buyer Co', currency_id: read(base, 'res.company', 1).currency_id, intercompany_rule: 'invoice_bill' });
  const sellerPartnerId = read(buyer.db, 'res.company', 1).partner_id;

  // Buyer accounts
  const accSrc = create(buyer.db, 'account.account', { name: 'Original Expense', code: 'EXP-SRC', account_type: 'expense', company_id: buyer.id });
  const accDest = create(accSrc.db, 'account.account', { name: 'Mapped Expense', code: 'EXP-DEST', account_type: 'expense', company_id: buyer.id });

  // Buyer taxes
  const taxSrc = create(accDest.db, 'account.tax', { name: 'Buyer 14%', amount: 14, type_tax_use: 'purchase', company_id: buyer.id });

  // Buyer fiscal position for the seller partner
  const fp = create(taxSrc.db, 'account.fiscal.position', {
    name: 'Intercompany Position',
    company_id: buyer.id,
    account_ids: [{ account_src_id: accSrc.id, account_dest_id: accDest.id }],
  });
  const taxDest = create(fp.db, 'account.tax', { name: 'Buyer Exempt', amount: 0, type_tax_use: 'purchase', company_id: buyer.id, fiscal_position_ids: [fp.id], original_tax_ids: [taxSrc.id] });
  const partnerConfigured = write(taxDest.db, 'res.partner', sellerPartnerId, { property_account_position_id: fp.id });

  // Buyer purchase journal (without default account fallback; configured for creation validation)
  const journal = create(partnerConfigured, 'account.journal', { name: 'Buyer Purchases', code: 'BP', type: 'purchase', company_id: buyer.id, default_account_id: accDest.id });
  let db = write(journal.db, 'res.company', buyer.id, { intercompany_journal_id: journal.id });

  // Product with configured expense account and purchase tax
  const productOk = create(db, 'product', { name: 'Desk Pro', type: 'goods', property_account_expense_id: accSrc.id, supplier_tax_id: taxSrc.id });
  db = productOk.db;

  // Invoice with productOk
  const invoice = create(db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: read(db, 'res.company', buyer.id).partner_id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: productOk.id, qty: 2, price_unit: 150, discount: 0, tax: 0 }],
  });
  const posted = postMove(invoice.db, invoice.id);
  const source = read(posted, 'account.move', invoice.id);
  const bill = read(posted, 'account.move', source.intercompany_move_id);
  assert.equal(bill.move_type, 'in_invoice');
  assert.equal(bill.company_id, buyer.id);
  assert.equal(bill.invoice_line_ids.length, 1);
  assert.equal(bill.invoice_line_ids[0].account_id, accDest.id, 'Mapped through fiscal position');
  assert.equal(bill.invoice_line_ids[0].tax_id, taxDest.id, 'Mapped tax through fiscal position');
  assert.equal(bill.invoice_line_ids[0].tax, 0);

  // Missing expense account raises error naming the product and creates nothing
  const productNoAcc = create(db, 'product', { name: 'Widget Without Account', type: 'goods', supplier_tax_id: taxSrc.id });
  const invNoAcc = create(productNoAcc.db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: read(db, 'res.company', buyer.id).partner_id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: productNoAcc.id, qty: 1, price_unit: 50, tax: 0 }],
  });
  assert.throws(() => postMove(invNoAcc.db, invNoAcc.id), /Configure an expense account for Widget Without Account/);
  assert.equal(read(invNoAcc.db, 'account.move', invNoAcc.id).intercompany_move_id ?? null, null);

  // A product with no purchase tax configured gives an untaxed bill line, as in Odoo
  const productNoTax = create(db, 'product', { name: 'Widget Without Tax', type: 'goods', property_account_expense_id: accSrc.id, supplier_tax_id: null, purchase_tax: null });
  const invNoTax = create(productNoTax.db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: read(db, 'res.company', buyer.id).partner_id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ product_id: productNoTax.id, qty: 1, price_unit: 50, tax: 0 }],
  });
  const untaxedDb = postMove(invNoTax.db, invNoTax.id);
  const untaxedBill = read(untaxedDb, 'account.move', read(untaxedDb, 'account.move', invNoTax.id).intercompany_move_id);
  assert.equal(untaxedBill.invoice_line_ids[0].tax_id ?? null, null);
  assert.equal(untaxedBill.invoice_line_ids[0].tax, 0);
});

test('server sync validates genuine counterpart and rejects client-forged counterpart', () => {
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
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const posted = postMove(invoice.db, invoice.id);
  const diff = diffDb(configured, posted);

  // 1. Genuine save applies successfully
  const synced = applyDiff(configured, diff, { author: 'admin', isAdmin: true });
  assert.ok(synced.records['account.move'].some((m) => m.id === invoice.id && m.state === 'posted'));
  const source = synced.records['account.move'].find((m) => m.id === invoice.id);
  assert.ok(synced.records['account.move'].some((m) => m.id === source.intercompany_move_id && m.move_type === 'in_invoice'));

  // 2. Forged counterpart contents (tampered line price_unit) is rejected
  const tamperedPriceDiff = structuredClone(diff);
  const counterpartInDiff = tamperedPriceDiff.upserts['account.move'].find((m) => m.id === source.intercompany_move_id);
  counterpartInDiff.invoice_line_ids[0].price_unit = 999;
  assert.throws(() => applyDiff(configured, tamperedPriceDiff, { author: 'admin', isAdmin: true }), /Invalid inter-company counterpart: contents do not match the source/);

  // 3. Forged counterpart link (pointing to wrong source) is rejected
  const tamperedLinkDiff = structuredClone(diff);
  const counterpartLink = tamperedLinkDiff.upserts['account.move'].find((m) => m.id === source.intercompany_move_id);
  counterpartLink.intercompany_move_id = 99999;
  assert.throws(() => applyDiff(configured, tamperedLinkDiff, { author: 'admin', isAdmin: true }), /Invalid inter-company counterpart: source link does not match/);

  // 4. Source link mismatch (source does not point to counterpart) is rejected
  const tamperedSourceDiff = structuredClone(diff);
  const sourceInDiff = tamperedSourceDiff.upserts['account.move'].find((m) => m.id === invoice.id);
  sourceInDiff.intercompany_move_id = 99999;
  assert.throws(() => applyDiff(configured, tamperedSourceDiff, { author: 'admin', isAdmin: true }), /Invalid inter-company counterpart: source link does not match/);
});
