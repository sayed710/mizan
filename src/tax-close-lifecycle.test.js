import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { round } from './money.js';
import { postMove } from './models/accounting.js';
import { createCompany } from './models/company.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';
import { taxSnapshot } from './models/taxes.js';
import { payReturn, resetReturnToDraft, submitReturn } from './models/taxreturn.js';
import { journalItems } from './models/ledger.js';
import { taxReturnBoxes } from './models/taxExport.js';

function setupCompany2(db) {
  const c2 = createCompany(db, { name: 'Company 2', ...invoiceJournalDefaults(db) });
  let next = c2.db;
  const partner = create(next, 'res.partner', { name: 'Tax Auth C2', company_id: c2.id });
  next = partner.db;
  const type = search(next, 'account.return.type').find((t) => (t.company_id ?? 1) === c2.id);
  if (type) {
    next = write(next, 'account.return.type', type.id, {
      payment_partner_id: partner.id,
      tax_payable_account_id: read(next, 'res.company', c2.id).account_default_payable_id,
      tax_receivable_account_id: read(next, 'res.company', c2.id).account_default_receivable_id,
    });
  }
  return { db: next, companyId: c2.id };
}

test('behavior 4: resetting a closed return to draft is allowed only while nothing later depends on it, guards through diffDb+applyDiff, and company 2 is untouched', () => {
  let db = seed();
  const { db: withC2, companyId: c2Id } = setupCompany2(db);
  db = withC2;

  const vatType1 = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  const vatType2 = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === c2Id && t.name === 'VAT Return');

  // 1. Create and submit two periods for Company 1: Jan and Feb 2026
  const ret1Res = create(db, 'account.return', {
    name: 'VAT C1 Jan 2026',
    type_id: vatType1.id,
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    company_id: 1,
    state: 'reviewed',
  });
  db = submitReturn(ret1Res.db, ret1Res.id);
  assert.equal(read(db, 'res.company', 1).tax_lock_date, '2026-01-31');

  const ret2Res = create(db, 'account.return', {
    name: 'VAT C1 Feb 2026',
    type_id: vatType1.id,
    date_from: '2026-02-01',
    date_to: '2026-02-28',
    company_id: 1,
    state: 'reviewed',
  });
  db = submitReturn(ret2Res.db, ret2Res.id);
  assert.equal(read(db, 'res.company', 1).tax_lock_date, '2026-02-28');

  // 2. Create and submit a return for Company 2: Jan 2026
  const retC2Res = create(db, 'account.return', {
    name: 'VAT C2 Jan 2026',
    type_id: vatType2.id,
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    company_id: c2Id,
    state: 'reviewed',
  });
  db = submitReturn(retC2Res.db, retC2Res.id);
  assert.equal(read(db, 'res.company', c2Id).tax_lock_date, '2026-01-31');

  // 3. Attempting to reset Return 1 to draft directly while Return 2 is closed must throw
  assert.throws(
    () => resetReturnToDraft(db, ret1Res.id),
    /locked|later closed return/i,
    'Reset to draft must be rejected when a later closed return exists'
  );

  // 4. Attempting to reset Return 1 to draft via diffDb+applyDiff must be blocked by returnGuard
  const forgedReset = {
    ...db,
    records: {
      ...db.records,
      'account.return': db.records['account.return'].map((r) => (r.id === ret1Res.id ? { ...r, state: 'new' } : r)),
    },
  };
  const diff = diffDb(db, forgedReset);
  assert.throws(
    () => applyDiff(db, diff, { isAdmin: true }),
    /locked|later closed return/i,
    'returnGuard in applyDiff must reject resetting return to draft when a later closed return exists'
  );

  // 5. Company 2 is untouched: Company 1 having later returns does not block Company 2 from resetting
  const resetC2 = resetReturnToDraft(db, retC2Res.id);
  assert.equal(read(resetC2, 'account.return', retC2Res.id).state, 'new');
  assert.equal(read(resetC2, 'res.company', c2Id).tax_lock_date, null);
  // Company 1 lock date and returns are completely unchanged
  assert.equal(read(resetC2, 'res.company', 1).tax_lock_date, '2026-02-28');

  // 6. A return that was only reviewed (never submitted) still goes back to draft while later returns are closed
  const reviewedRes = create(db, 'account.return', {
    name: 'VAT C1 Dec 2025', type_id: vatType1.id, date_from: '2025-12-01', date_to: '2025-12-31', company_id: 1, state: 'reviewed',
  });
  assert.equal(read(resetReturnToDraft(reviewedRes.db, reviewedRes.id), 'account.return', reviewedRes.id).state, 'new');

  // 7. Once Return 2 is reset, Return 1 can be reset to draft
  const reset2Db = resetReturnToDraft(db, ret2Res.id);
  assert.equal(read(reset2Db, 'account.return', ret2Res.id).state, 'new');
  assert.equal(read(reset2Db, 'res.company', 1).tax_lock_date, '2026-01-31');

  const reset1Db = resetReturnToDraft(reset2Db, ret1Res.id);
  const reset1Ret = read(reset1Db, 'account.return', ret1Res.id);
  assert.equal(reset1Ret.state, 'new');
  assert.equal(reset1Ret.date_lock, null);
  assert.equal(read(reset1Db, 'res.company', 1).tax_lock_date, null);

  // Closing moves are cancelled (reversed, not deleted)
  for (const moveId of reset1Ret.closing_move_ids ?? []) {
    const m = read(reset1Db, 'account.move', moveId);
    assert.ok(m, 'Closing move must remain in database (not deleted)');
    assert.equal(m.state, 'cancel');
  }
});

test('behavior 1: closing a return posts one closing entry zeroing every tax account balance against tax payable/receivable matching report boxes, company 2 untouched', () => {
  let db = seed();
  const { db: withC2, companyId: c2Id } = setupCompany2(db);
  db = withC2;

  // Create dedicated tax payable account for company 1
  const payableAcc = create(db, 'account.account', { code: '251999', name: 'VAT Settlement Payable', account_type: 'liability_current', company_id: 1 });
  db = payableAcc.db;
  const vatType1 = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  db = write(db, 'account.return.type', vatType1.id, { tax_payable_account_id: payableAcc.id });

  const saleTaxC1 = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'sale');
  const purchTaxC1 = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'purchase');
  const saleTaxC2 = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === c2Id && t.type_tax_use === 'sale');

  // Company 1: post sale (tax credit) and purchase (tax debit)
  const invC1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-04-10', company_id: 1,
    invoice_line_ids: [{ name: 'C1 sale', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxC1) }],
  });
  db = postMove(invC1.db, invC1.id);

  const billC1 = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-04-12', company_id: 1,
    invoice_line_ids: [{ name: 'C1 purchase', qty: 1, price_unit: 40, ...taxSnapshot(purchTaxC1) }],
  });
  db = postMove(billC1.db, billC1.id);

  // Company 2: post sale
  const invC2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-04-10', company_id: c2Id,
    invoice_line_ids: [{ name: 'C2 sale', qty: 1, price_unit: 200, ...taxSnapshot(saleTaxC2) }],
  });
  db = postMove(invC2.db, invC2.id);

  const ret = create(db, 'account.return', {
    name: 'VAT C1 April 2026',
    type_id: vatType1.id,
    date_from: '2026-04-01',
    date_to: '2026-04-30',
    company_id: 1,
    state: 'reviewed',
  });
  db = submitReturn(ret.db, ret.id);
  const submittedRet = read(db, 'account.return', ret.id);

  // 1. One closing move posted for company 1
  assert.equal(submittedRet.closing_move_ids.length, 1);
  const closingMove = read(db, 'account.move', submittedRet.closing_move_ids[0]);
  assert.equal(closingMove.state, 'posted');
  assert.equal(closingMove.company_id ?? 1, 1);
  assert.equal(closingMove.date, '2026-04-30');

  // 2. Net payable equals report boxes payable
  const { boxes, totals } = taxReturnBoxes(db, submittedRet);
  assert.equal(submittedRet.total_amount_to_pay, totals.payable);
  const payableBox = boxes.find((b) => b.kind === 'total' && b.tax === totals.payable);
  assert.equal(payableBox.tax, submittedRet.total_amount_to_pay);

  // 3. Every tax account balance for Company 1 in that period is zeroed
  const allItems = journalItems(db, { from: '2026-04-01', to: '2026-04-30', company_id: 1 });
  const vatOutAccId = saleTaxC1.invoice_repartition_line_ids.find((l) => l.repartition_type === 'tax')?.account_id;
  const vatInAccId = purchTaxC1.invoice_repartition_line_ids.find((l) => l.repartition_type === 'tax')?.account_id;
  const balOut = round(allItems.filter((l) => l.account_id === vatOutAccId).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
  const balIn = round(allItems.filter((l) => l.account_id === vatInAccId).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
  assert.equal(balOut, 0, 'Sales tax account balance must be zero after closing');
  assert.equal(balIn, 0, 'Purchase tax account balance must be zero after closing');

  // 4. Company 2 is untouched
  const c2Moves = (db.records['account.move'] ?? []).filter((m) => (m.company_id ?? 1) === c2Id);
  assert.equal(c2Moves.some((m) => m.tax_return_id != null), false);
  assert.equal(read(db, 'res.company', c2Id).tax_lock_date ?? null, null);
});

test('behavior 2: closing sets tax lock date; posting/editing taxed entries dated on or before is blocked for company 1 only; later arriving entries belong to next return', () => {
  let db = seed();
  const { db: withC2, companyId: c2Id } = setupCompany2(db);
  db = withC2;

  const saleTaxC1 = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'sale');
  const purchTaxC1 = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'purchase');
  const saleTaxC2 = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === c2Id && t.type_tax_use === 'sale');
  const vatType1 = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');

  const ret = create(db, 'account.return', {
    name: 'VAT C1 May 2026',
    type_id: vatType1.id,
    date_from: '2026-05-01',
    date_to: '2026-05-31',
    company_id: 1,
    state: 'reviewed',
  });
  db = submitReturn(ret.db, ret.id);

  // Closing sets tax_lock_date on Company 1, leaves Company 2 untouched
  assert.equal(read(db, 'res.company', 1).tax_lock_date, '2026-05-31');
  assert.equal(read(db, 'res.company', c2Id).tax_lock_date ?? null, null);

  // Posting taxed entry dated on or before tax_lock_date is blocked for Company 1
  const blockedInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-05-20', company_id: 1,
    invoice_line_ids: [{ name: 'Locked item', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxC1) }],
  });
  assert.throws(() => postMove(blockedInv.db, blockedInv.id), /locked/i);

  // Company 2 is untouched: entry dated in same locked period succeeds for Company 2
  const allowedC2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-05-20', company_id: c2Id,
    invoice_line_ids: [{ name: 'C2 item', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxC2) }],
  });
  assert.doesNotThrow(() => postMove(allowedC2.db, allowedC2.id));

  // Taxed entry dated in locked period that arrives later with accounting date in next period
  const lateBill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-05-25', date: '2026-06-05', company_id: 1,
    invoice_line_ids: [{ name: 'Late service', qty: 1, price_unit: 80, ...taxSnapshot(purchTaxC1) }],
  });
  db = postMove(lateBill.db, lateBill.id);

  // Late entry belongs to next period, never added to the closed May return
  const mayBoxes = taxReturnBoxes(db, { date_from: '2026-05-01', date_to: '2026-05-31', company_id: 1 });
  const juneBoxes = taxReturnBoxes(db, { date_from: '2026-06-01', date_to: '2026-06-30', company_id: 1 });
  assert.equal(mayBoxes.totals.payable, read(db, 'account.return', ret.id).total_amount_to_pay);
  assert.ok(juneBoxes.totals.output > 0 || juneBoxes.totals.input > 0, 'Late arriving item belongs to June return');
});

test('behavior 3: paying the return posts payment against tax payable (outbound) or receivable (inbound refund with opposite sign) and return shows paid', () => {
  let db = seed();
  const vatType1 = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  const partner = search(db, 'res.partner')[0];
  db = write(db, 'account.return.type', vatType1.id, { payment_partner_id: partner.id });

  const saleTax = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'sale');
  const purchTax = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'purchase');

  // Case A: Positive payable (outbound payment)
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: '2026-07-10', company_id: 1,
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100, ...taxSnapshot(saleTax) }],
  });
  db = postMove(inv.db, inv.id);

  const retPay = create(db, 'account.return', {
    name: 'VAT July 2026', type_id: vatType1.id, date_from: '2026-07-01', date_to: '2026-07-31', company_id: 1, state: 'reviewed',
  });
  db = submitReturn(retPay.db, retPay.id);
  db = payReturn(db, retPay.id);

  const paidRet = read(db, 'account.return', retPay.id);
  assert.equal(paidRet.state, 'paid');
  assert.equal(paidRet.is_completed, true);
  const payment = read(db, 'account.payment', paidRet.payment_id);
  assert.equal(payment.payment_type, 'outbound');
  assert.equal(payment.destination_account_id, vatType1.tax_payable_account_id);

  // Case B: Refund return (negative payable -> inbound receipt)
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: partner.id, invoice_date: '2026-08-10', company_id: 1,
    invoice_line_ids: [{ name: 'Item', qty: 10, price_unit: 100, ...taxSnapshot(purchTax) }],
  });
  db = postMove(bill.db, bill.id);

  const retRefund = create(db, 'account.return', {
    name: 'VAT Aug 2026', type_id: vatType1.id, date_from: '2026-08-01', date_to: '2026-08-31', company_id: 1, state: 'reviewed',
  });
  db = submitReturn(retRefund.db, retRefund.id);
  db = payReturn(db, retRefund.id);

  const paidRefund = read(db, 'account.return', retRefund.id);
  assert.equal(paidRefund.state, 'paid');
  assert.equal(paidRefund.is_completed, true);
  const refundPayment = read(db, 'account.payment', paidRefund.payment_id);
  assert.equal(refundPayment.payment_type, 'inbound');
  assert.equal(refundPayment.destination_account_id, vatType1.tax_receivable_account_id);
});
