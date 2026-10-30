import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import { seed } from './seed.js';
import { today, addDays } from './models/common.js';
import { payMove, postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { postBatch } from './models/payments.js';
import { postEntry } from './models/ledger.js';
import { migrate } from './migrations.js';
import { applyDiff, diffDb } from './sync.js';
import {
  generateReturns,
  periodsUpTo,
  reviewReturn,
  submitReturn,
  payReturn,
  resetReturnToDraft,
} from './models/taxreturn.js';
import { findAnalyticDistribution } from './models/analyticplus.js';
import { taxReport } from './models/finance.js';
import { models } from './models/index.js';

const taxNamed = (db, name, use = 'sale') => search(db, 'account.tax').find((t) => t.name === name && t.type_tax_use === use);
const invoiceLine = (db, taxName, use, vals = {}) => ({
  product_id: 1, qty: 1, price_unit: 100, discount: 0,
  ...taxSnapshot(taxNamed(db, taxName, use)),
  ...vals,
});

test('invoice account onchange preserves a manually entered unit price', () => {
  const db = seed();
  const line = { product_id: 1, account_id: 1, qty: 1, price_unit: 12345 };
  const updated = models['account.move'].fields.invoice_line_ids.onchange(line, 'account_id', db, { move_type: 'out_invoice', company_id: 1 });
  assert.equal(updated.price_unit, 12345);
});

test('submission revalidates tax entries posted after review', () => {
  let db = seed();
  const type = search(db, 'account.return.type')[0];
  const made = create(db, 'account.return', { name: 'Review race', type_id: type.id, company_id: 1, date_from: '2025-03-01', date_to: '2025-03-31' });
  const actions = models['account.return'].form.buttons;
  const review = actions.find((action) => action.label === 'Review');
  const submit = actions.find((action) => action.label === 'Submit');
  db = review.run(made.db, read(made.db, 'account.return', made.id)).db;
  db = postEntry(db, { journal: 'MISC', date: '2025-03-15', company: 1, lines: [
    { account: '251000', credit: 100 }, { account: '101401', debit: 100 },
  ] }).db;
  assert.throws(() => submit.run(db, read(db, 'account.return', made.id)), /untagged/i);
  assert.equal(read(db, 'account.return', made.id).state, 'reviewed');
});

test('direct return state writes cannot bypass actions or alter locked fields during transitions', () => {
  const initial = seed();
  const type = search(initial, 'account.return.type')[0];
  const made = create(initial, 'account.return', { name: 'State guard', type_id: type.id, company_id: 1, date_from: '2025-01-01', date_to: '2025-01-31' });
  for (const state of ['submitted', 'paid']) {
    assert.throws(() => write(made.db, 'account.return', made.id, { state }), /return|closing|transition/i);
  }
  const actions = models['account.return'].form.buttons;
  let db = actions.find((a) => a.label === 'Review').run(made.db, read(made.db, 'account.return', made.id)).db;
  db = actions.find((a) => a.label === 'Submit').run(db, read(db, 'account.return', made.id)).db;
  for (const state of ['paid', 'new']) {
    assert.throws(() => write(db, 'account.return', made.id, { state, date_to: '2025-02-28' }), /return|modified|transition/i);
  }
  assert.throws(() => write(db, 'account.return', made.id, { state: 'new' }), /return|closing|transition/i);
});

test('submission revalidates drafts created after review through form actions', () => {
  const initial = seed();
  const type = search(initial, 'account.return.type')[0];
  const made = create(initial, 'account.return', { name: 'Draft race', type_id: type.id, company_id: 1, date_from: '2025-03-01', date_to: '2025-03-31' });
  const actions = models['account.return'].form.buttons;
  const review = actions.find((action) => action.label === 'Review');
  const submit = actions.find((action) => action.label === 'Submit');
  const reviewed = review.run(made.db, read(made.db, 'account.return', made.id)).db;
  const draft = create(reviewed, 'account.move', { move_type: 'entry', state: 'draft', date: '2025-03-15', company_id: 1 });
  assert.throws(() => submit.run(draft.db, read(draft.db, 'account.return', made.id)), /draft/i);
  assert.equal(read(draft.db, 'account.return', made.id).state, 'reviewed');
});

test('a forged tax closing reference cannot bypass a period lock', () => {
  const db = updateSettings(seed(), { lock_date: '2025-03-31' });
  assert.throws(() => postEntry(db, { journal: 'MISC', date: '2025-03-15', ref: 'Tax Closing: forged', lines: [
    { account: '101401', debit: 100 }, { account: '211000', credit: 100 },
  ] }), /locked/i);
});

test('only a return submission can post its generated closing into a locked period', () => {
  let db = updateSettings(seed(), { lock_date: '2025-03-31' });
  const bank = search(db, 'account.account').find((a) => a.code === '101401');
  const payable = search(db, 'account.account').find((a) => a.code === '211000');
  const forged = { name: 'MISC/2025/99999', move_type: 'entry', company_id: 1, date: '2025-03-31', invoice_date: '2025-03-31',
    ref: 'Tax Closing: impersonated', line_ids: [{ account_id: bank.id, debit: 100 }, { account_id: payable.id, credit: 100 }] };
  assert.throws(() => create(db, 'account.move', { ...forged, state: 'posted' }), /locked/i);
  const draft = create(db, 'account.move', { ...forged, state: 'draft' });
  const confirm = models['account.move'].form.buttons.find((button) => button.label === 'Confirm');
  assert.throws(() => confirm.run(draft.db, read(draft.db, 'account.move', draft.id)), /locked/i);
  // The rejected draft remains only in the separate immutable branch; submit from the original database.
  const type = search(db, 'account.return.type')[0];
  const ret = create(db, 'account.return', { name: 'Legitimate VAT', type_id: type.id, company_id: 1, date_from: '2025-03-01', date_to: '2025-03-31' });
  const actions = models['account.return'].form.buttons;
  db = actions.find((a) => a.label === 'Review').run(ret.db, read(ret.db, 'account.return', ret.id)).db;
  db = actions.find((a) => a.label === 'Submit').run(db, read(db, 'account.return', ret.id)).db;
  const result = read(db, 'account.return', ret.id);
  const closing = read(db, 'account.move', result.closing_move_ids[0]);
  assert.equal(result.state, 'submitted');
  assert.equal(closing.state, 'posted');
  assert.equal(closing.date, '2025-03-31');
  assert.equal(closing.company_id, 1);
  assert.equal(db.settings.lock_date, '2025-03-31');
});

test('sync round trips preserve manual locks through out-of-order return resets', () => {
  let db = updateSettings(seed(), { lock_date: '2024-12-31' });
  const type = search(db, 'account.return.type')[0];
  const actions = models['account.return'].form.buttons;
  const run = (label, id) => { const next = actions.find((action) => action.label === label).run(db, read(db, 'account.return', id)).db; db = applyDiff(db, diffDb(db, next), { isAdmin: true }); };
  const first = create(db, 'account.return', { name: 'First return', type_id: type.id, company_id: 1, date_from: '2025-01-01', date_to: '2025-01-31' });
  db = first.db;
  run('Review', first.id);
  run('Submit', first.id);
  const second = create(db, 'account.return', { name: 'Second return', type_id: type.id, company_id: 1, date_from: '2025-02-01', date_to: '2025-02-28' });
  db = second.db;
  run('Review', second.id);
  run('Submit', second.id);
  assert.equal(db.settings.lock_sources.manual, '2024-12-31');
  const closingId = read(db, 'account.return', first.id).closing_move_ids[0];
  assert.equal(read(db, 'account.move', closingId).tax_return_id, first.id);
  const reset = actions.find((action) => action.label === 'Reset to Draft').run(db, read(db, 'account.return', first.id)).db;
  const forged = diffDb(db, reset);
  const closing = forged.upserts['account.move'].find((move) => move.id === closingId);
  forged.bases['account.move'][closingId].ref = read(db, 'account.move', closingId).ref;
  closing.ref = 'Altered during reset';
  assert.throws(() => applyDiff(db, forged, { isAdmin: true }), /locked|draft/i);
  run('Reset to Draft', first.id);
  assert.equal(db.settings.lock_date, '2025-02-28');
  run('Reset to Draft', second.id);
  assert.equal(db.settings.lock_date, '2024-12-31');
});

test('journal posting resolves duplicate account codes in the entry company', () => {
  let db = seed();
  const account = create(db, 'account.account', { code: '251000', name: 'Other company tax', company_id: 2 });
  db = account.db;
  const cash = create(db, 'account.account', { code: '101401', name: 'Other company cash', company_id: 2 });
  db = cash.db;
  const entry = postEntry(db, { journal: 'MISC', date: '2025-03-01', company: 2, lines: [
    { account: '251000', credit: 100 }, { account: '101401', debit: 100 },
  ] });
  assert.deepEqual(read(entry.db, 'account.move', entry.id).line_ids.map((l) => l.account_id), [account.id, cash.id]);
});

test('tax return actions post closing and payment to the company chart when account codes repeat', () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Separate chart company' });
  db = company.db;
  const accounts = {};
  for (const code of ['251000', '131000', '101401']) {
    const created = create(db, 'account.account', { code, name: `Company chart ${code}`, company_id: company.id });
    db = created.db;
    accounts[code] = created.id;
  }
  const type = search(db, 'account.return.type').find((t) => t.company_id === company.id);
  db = create(db, 'res.partner.bank', { partner_id: 1, account_number: 'COMPANY TAX BANK' }).db;
  db = write(db, 'account.return.type', type.id, {
    tax_payable_account_id: accounts['251000'], tax_receivable_account_id: accounts['131000'], payment_partner_id: 1,
  });
  const move = create(db, 'account.move', {
    move_type: 'entry', name: 'MISC/2025/00001', state: 'posted', company_id: company.id, date: '2025-03-15', invoice_date: '2025-03-15',
    line_ids: [
      { account_id: accounts['251000'], credit: 100, debit: 0, tax_name: 'VAT' },
      { account_id: accounts['101401'], debit: 100, credit: 0 },
    ],
  });
  const ret = create(move.db, 'account.return', {
    name: 'Company VAT', type_id: type.id, company_id: company.id, date_from: '2025-03-01', date_to: '2025-03-31',
  });
  const actions = models['account.return'].form.buttons;
  db = ret.db;
  for (const label of ['Review', 'Submit']) {
    db = actions.find((action) => action.label === label).run(db, read(db, 'account.return', ret.id)).db;
  }
  const submitted = read(db, 'account.return', ret.id);
  const closing = read(db, 'account.move', submitted.closing_move_ids[0]);
  assert.equal(submitted.total_amount_to_pay, 100);
  assert.equal(closing.company_id, company.id);
  assert.deepEqual(closing.line_ids.map((line) => line.account_id), [accounts['251000'], accounts['251000']]);
  db = actions.find((action) => action.label === 'Pay').run(db, submitted).db;
  const payment = read(db, 'account.payment', read(db, 'account.return', ret.id).payment_id);
  const paymentMove = read(db, 'account.move', payment.move_id);
  assert.equal(payment.state, 'posted');
  assert.equal(paymentMove.company_id, company.id);
  assert.deepEqual(paymentMove.line_ids.map((line) => line.account_id), [accounts['251000'], accounts['101401']]);
});

test('partner bank partial updates retain the account number and reject foreign IDs', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Bank owner' });
  db = partner.db;
  const other = create(db, 'res.partner', { name: 'Other owner' });
  db = other.db;
  const bank = create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'AB 123', allow_out_payment: true });
  db = bank.db;
  db = write(db, 'res.partner', partner.id, { bank_ids: [{ id: bank.id, allow_out_payment: false }] });
  assert.equal(read(db, 'res.partner.bank', bank.id).account_number, 'AB 123');
  assert.equal(read(db, 'res.partner.bank', bank.id).allow_out_payment, false);
  assert.throws(() => write(db, 'res.partner', other.id, { bank_ids: [{ id: bank.id, account_number: 'AB 123' }] }));
  assert.throws(() => write(db, 'res.partner', partner.id, { bank_ids: [{ id: 999999, account_number: 'X' }] }));
  assert.throws(() => write(db, 'res.partner', partner.id, { bank_ids: [{ id: 0, account_number: 'X' }] }));
  assert.throws(() => create(db, 'res.partner', { name: 'Forged account owner', bank_ids: [{ id: bank.id }] }), /invalid|partner/i);
  assert.throws(() => create(db, 'res.partner', { name: 'Unknown account owner', bank_ids: [{ id: 999999, account_number: 'X' }] }), /invalid|partner/i);
  const preserved = write(db, 'res.partner', partner.id, { bank_ids: [{ id: bank.id, account_number: undefined, bank_name: 'Edited' }] });
  assert.equal(read(preserved, 'res.partner.bank', bank.id).account_number, 'AB 123');
});

test('partner bank tab uses registered bank model validation for creates and partial updates', () => {
  const partner = create(seed(), 'res.partner', { name: 'Validated bank owner' });
  const bank = create(partner.db, 'res.partner.bank', { partner_id: partner.id, account_number: 'EG 123', bank_name: 'Before', bank_bic: 'VALID' });
  const bankModel = models['res.partner.bank'];
  const guard = bankModel.guard;
  bankModel.guard = (db, before, after, ctx) => guard?.(db, before, after, ctx) ?? (after.bank_bic === 'BLOCKED' ? 'Bank validation refused this identifier' : null);
  try {
    assert.throws(() => write(bank.db, 'res.partner', partner.id, { bank_ids: [{ id: bank.id, bank_bic: 'BLOCKED' }] }), /bank validation/i);
    assert.throws(() => create(bank.db, 'res.partner', { name: 'Invalid new owner', bank_ids: [{ account_number: 'NEW', bank_bic: 'BLOCKED' }] }), /bank validation/i);
    const updated = write(bank.db, 'res.partner', partner.id, { bank_ids: [{ id: bank.id, bank_name: null, allow_out_payment: false }] });
    assert.equal(read(updated, 'res.partner.bank', bank.id).account_number, 'EG 123');
    assert.equal(read(updated, 'res.partner.bank', bank.id).bank_name, null);
    assert.equal(read(updated, 'res.partner.bank', bank.id).allow_out_payment, false);
    assert.equal(read(bank.db, 'res.partner.bank', bank.id).bank_name, 'Before');
  } finally {
    bankModel.guard = guard;
  }
});

test('partner bank tab validates simultaneous number swaps as one update', () => {
  const partner = create(seed(), 'res.partner', { name: 'Bank swap owner', bank_ids: [
    { account_number: 'FIRST 123', bank_name: 'First' }, { account_number: 'SECOND 456', bank_name: 'Second' },
  ] });
  const [first, second] = read(partner.db, 'res.partner', partner.id).bank_ids;
  const db = write(partner.db, 'res.partner', partner.id, { bank_ids: [
    { id: first.id, account_number: 'SECOND 456' }, { id: second.id, account_number: 'FIRST 123' },
  ] });
  assert.equal(read(db, 'res.partner.bank', first.id).account_number, 'SECOND 456');
  assert.equal(read(db, 'res.partner.bank', second.id).account_number, 'FIRST 123');
  assert.equal(read(db, 'res.partner.bank', first.id).bank_name, 'First');
  assert.equal(read(partner.db, 'res.partner.bank', first.id).account_number, 'FIRST 123');
  const synced = applyDiff(partner.db, diffDb(partner.db, db), { author: 'test' });
  assert.equal(read(synced, 'res.partner.bank', first.id).account_number, 'SECOND 456');
  assert.equal(read(synced, 'res.partner.bank', second.id).account_number, 'FIRST 123');
});

test('partner bank tab rejects explicitly blank account numbers', () => {
  const partner = create(seed(), 'res.partner', { name: 'Bank owner' });
  const bank = create(partner.db, 'res.partner.bank', { partner_id: partner.id, account_number: 'AB 123' });
  assert.throws(() => write(bank.db, 'res.partner', partner.id, { bank_ids: [{ id: bank.id, account_number: '' }] }), /account number/i);
  assert.equal(read(bank.db, 'res.partner.bank', bank.id).account_number, 'AB 123');
});

test('return generation and deadlines: seeds VAT return type and generates missing returns up to today', () => {
  const db = seed();
  const types = search(db, 'account.return.type');
  assert.ok(types.length > 0, 'VAT return type should be seeded');
  const vatType = types.find((t) => t.name === 'VAT Return');
  assert.ok(vatType, 'Seeded VAT Return type found');
  assert.equal(vatType.category, 'account_return');
  assert.equal(vatType.states_workflow, 'generic_state_review_submit');

  // Generate returns creates returns up to today
  const { db: withReturns, created } = generateReturns(db, vatType.id);
  assert.ok(created.length > 0, 'Generates missing returns');
  const returns = search(withReturns, 'account.return').filter((r) => r.type_id === vatType.id);
  assert.ok(returns.length > 0);

  // Each return has correct dates and deadline = period end + deadline_days_delay
  for (const ret of returns) {
    assert.equal(ret.state, 'new');
    assert.ok(ret.date_from <= ret.date_to);
    const expectedDeadline = addDays(ret.date_to, vatType.deadline_days_delay ?? 0);
    assert.equal(ret.date_deadline, expectedDeadline);
  }

  // Running generate returns again creates no duplicates
  const { created: secondRun } = generateReturns(withReturns, vatType.id);
  assert.equal(secondRun.length, 0, 'No duplicate returns generated');
});

test('review checks for draft entries and unbalanced tax accounts', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  const { db: withReturns, created } = generateReturns(db, vatType.id);
  const ret = created[0];

  // Draft entry in the period blocks Review
  const draftEntry = create(withReturns, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    date: ret.date_from,
    line_ids: [{ account_id: 1, debit: 50, credit: 0 }, { account_id: 2, debit: 0, credit: 50 }],
  });
  assert.throws(
    () => reviewReturn(draftEntry.db, ret.id),
    /draft/i,
    'Review must reject when draft entries exist in the period'
  );

  // Once posted, Review passes
  const reviewed = reviewReturn(withReturns, ret.id);
  const reviewedRet = read(reviewed, 'account.return', ret.id);
  assert.equal(reviewedRet.state, 'reviewed');
});

test('the closing entry line-level assertions: moves tax balances, sets partner on payable, and books rounding line', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  const from = '2026-05-01';
  const to = '2026-05-20';

  // Create an invoice with sales tax
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: from,
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 100.25 })], // 14% of 100.25 = 14.035 -> 14.04
  });
  db = postMove(inv.db, inv.id);

  // Create a vendor bill with purchase tax
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: from,
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'purchase', { price_unit: 50 })], // 14% of 50 = 7.00
  });
  db = postMove(bill.db, bill.id);

  const retRes = create(db, 'account.return', {
    name: 'VAT Test Period May',
    type_id: vatType.id,
    date_from: from,
    date_to: to,
    company_id: 1,
    state: 'reviewed',
  });
  db = retRes.db;

  // Submit posts the tax closing entry
  const submittedDb = submitReturn(db, retRes.id);
  const submittedRet = read(submittedDb, 'account.return', retRes.id);
  assert.equal(submittedRet.state, 'submitted');
  assert.ok(submittedRet.closing_move_ids?.length > 0, 'Closing move is linked');

  const closingMove = read(submittedDb, 'account.move', submittedRet.closing_move_ids[0]);
  assert.equal(closingMove.state, 'posted');
  assert.equal(closingMove.date, to);

  // Verify closing move items balance
  const lines = closingMove.line_ids ?? [];
  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  assert.equal(Math.round(totalDebit * 100), Math.round(totalCredit * 100), 'Closing entry must be balanced');

  // Finding 12: Assert exact line amounts on tax accounts and payable line
  // 1. Sales tax account (251000) was credited 14.04 by invoice; closing entry debits 14.04
  const salesCloseLine = lines.find((l) => read(submittedDb, 'account.account', l.account_id)?.code === '251000' && Number(l.debit) === 14.04);
  assert.ok(salesCloseLine, 'Sales tax account is debited 14.04 to clear balance');

  // 2. Purchase tax account (131000) was debited 7.00 by bill; closing entry credits 7.00
  const purchaseCloseLine = lines.find((l) => read(submittedDb, 'account.account', l.account_id)?.code === '131000' && Number(l.credit) === 7.00);
  assert.ok(purchaseCloseLine, 'Purchase tax account is credited 7.00 to clear balance');

  // 3. Tax payable account (251000) is credited 7.04 with payment_partner_id
  const payableLine = lines.find((l) => read(submittedDb, 'account.account', l.account_id)?.code === '251000' && Number(l.credit) === 7.04);
  assert.ok(payableLine, 'Tax payable account is credited 7.04 for the net payable');
  assert.equal(payableLine.partner_id, vatType.payment_partner_id);

  assert.equal(submittedRet.total_amount_to_pay, 7.04);
});

test('stale totals: review and submit refresh total_amount_to_pay from latest ledger/report', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  const from = '2026-06-01';
  const to = '2026-06-30';

  // Create return in June with initial 0 amount
  const retRes = create(db, 'account.return', {
    name: 'VAT June 2026',
    type_id: vatType.id,
    date_from: from,
    date_to: to,
    company_id: 1,
    state: 'new',
    total_amount_to_pay: 0,
  });
  db = retRes.db;
  const initialRet = read(db, 'account.return', retRes.id);
  assert.equal(Number(initialRet.total_amount_to_pay) || 0, 0);

  // Post an invoice after generation
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: from,
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 1000 })], // 140 tax
  });
  db = postMove(inv1.db, inv1.id);

  // Reviewing refreshes total_amount_to_pay from 0 to 140
  const reviewedDb = reviewReturn(db, retRes.id);
  const reviewedRet = read(reviewedDb, 'account.return', retRes.id);
  assert.equal(reviewedRet.total_amount_to_pay, 140);

  // Post another invoice before submit
  const inv2 = create(reviewedDb, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: from,
    invoice_line_ids: [invoiceLine(reviewedDb, 'VAT 14%', 'sale', { price_unit: 500 })], // 70 tax
  });
  db = postMove(inv2.db, inv2.id);

  // Submitting recalculates final amount to 210 and does not book it as rounding
  const submittedDb = submitReturn(db, retRes.id);
  const submittedRet = read(submittedDb, 'account.return', retRes.id);
  assert.equal(submittedRet.total_amount_to_pay, 210);

  const closingMove = read(submittedDb, 'account.move', submittedRet.closing_move_ids[0]);
  const lines = closingMove.line_ids ?? [];
  const payableLine = lines.find((l) => read(submittedDb, 'account.account', l.account_id)?.code === '251000' && Number(l.credit) === 210);
  assert.ok(payableLine, 'Closing move books the full 210 payable, not stale total');

  // No bogus rounding difference
  const roundLine = lines.find((l) => ['450000', '690000'].includes(read(submittedDb, 'account.account', l.account_id)?.code));
  assert.equal(roundLine, undefined, 'No rounding entry when totals match exactly');
});

test('company isolation: tax report, journal items, and closing entries isolate by company', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return' && (t.company_id ?? 1) === 1);
  const from = '2026-07-01';
  const to = '2026-07-20';

  // Post invoice in Company 1 (100 tax)
  const inv1 = create(db, 'account.move', {
    company_id: 1, move_type: 'out_invoice', partner_id: 1, invoice_date: from,
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 100 / 0.14 })],
  });
  db = postMove(inv1.db, inv1.id);

  // Ensure Company 2 exists and post invoice in Company 2 (500 tax)
  const co2 = create(db, 'res.company', { name: 'Company Two' });
  db = co2.db;
  const inv2 = create(db, 'account.move', {
    company_id: co2.id, move_type: 'out_invoice', partner_id: 1, invoice_date: from,
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 500 / 0.14 })],
  });
  db = postMove(inv2.db, inv2.id);

  // Submit return for Company 1
  const ret1 = create(db, 'account.return', {
    name: 'Co1 VAT Return',
    type_id: vatType.id,
    date_from: from,
    date_to: to,
    company_id: 1,
    state: 'reviewed',
  });
  const submittedDb = submitReturn(ret1.db, ret1.id);
  const ret1Record = read(submittedDb, 'account.return', ret1.id);

  // Closing entry posted in Company 1 with Company 1's tax amount only
  const closing1 = read(submittedDb, 'account.move', ret1Record.closing_move_ids[0]);
  assert.equal(closing1.company_id, 1);
  assert.equal(ret1Record.total_amount_to_pay, 100);

  // Company 2's tax items are untouched
  const co2Type = search(submittedDb, 'account.return.type').find((t) => t.company_id === co2.id);
  assert.ok(co2Type, 'Return type for Company 2 exists');
  const co2ReturnRes = create(submittedDb, 'account.return', {
    name: 'Co2 VAT Return',
    type_id: co2Type.id,
    date_from: from,
    date_to: to,
    company_id: co2.id,
    state: 'reviewed',
  });
  const co2Submitted = submitReturn(co2ReturnRes.db, co2ReturnRes.id);
  const co2Record = read(co2Submitted, 'account.return', co2ReturnRes.id);
  assert.equal(co2Record.total_amount_to_pay, 500);
});

test('tax payment settles tax obligation without settling unrelated open vendor bills', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  db = create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'TAX BANK' }).db;
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  db = write(db, 'account.return.type', vatType.id, { payment_partner_id: partner.id });

  // Create an unrelated open vendor bill for the payment partner
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: partner.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  // Submit a real obligation and pay it through the form actions.
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: '2026-03-01',
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 1000 })],
  });
  db = postMove(invoice.db, invoice.id);
  const retRes = create(db, 'account.return', {
    name: 'VAT Settle Obligation', type_id: vatType.id,
    date_from: '2026-03-01', date_to: '2026-03-31', company_id: 1,
  });
  const buttons = models['account.return'].form.buttons;
  db = buttons.find((b) => b.label === 'Review').run(retRes.db, read(retRes.db, 'account.return', retRes.id)).db;
  db = buttons.find((b) => b.label === 'Submit').run(db, read(db, 'account.return', retRes.id)).db;
  const paidDb = buttons.find((b) => b.label === 'Pay').run(db, read(db, 'account.return', retRes.id)).db;
  const paidRet = read(paidDb, 'account.return', retRes.id);
  assert.equal(paidRet.state, 'paid');

  // Verify the tax payment record
  const payments = search(paidDb, 'account.payment').filter((p) => p.return_id === retRes.id);
  assert.equal(payments.length, 1);
  const p = payments[0];
  assert.equal(p.payment_type, 'outbound');
  assert.equal(p.amount, 140);
  assert.equal(p.unapplied, 0);
  const closing = read(paidDb, 'account.move', paidRet.closing_move_ids[0]);
  const settlement = closing.payments[0];
  assert.equal(settlement.move_id, p.move_id);
  assert.equal(settlement.amount, 140);
  assert.equal(closing.line_ids[settlement.line_index].account_id, p.destination_account_id);
  assert.equal(closing.line_ids[settlement.line_index].credit, 140);
  const paymentEntry = read(paidDb, 'account.move', p.move_id);
  assert.equal(p.state, 'posted');
  assert.equal(paymentEntry.state, 'posted');
  assert.equal(paymentEntry.line_ids.find((line) => line.account_id === p.destination_account_id)?.debit, 140);
  assert.equal(paymentEntry.line_ids.find((line) => read(paidDb, 'account.account', line.account_id)?.code === '101401')?.credit, 140);
  assert.equal(p.destination_account_code, '251000');
  assert.equal(p.is_tax_payment, true);

  // Open vendor bill must NOT be settled by the tax payment
  const billAfter = read(paidDb, 'account.move', bill.id);
  assert.equal(billAfter.amount_paid, 0);
  assert.equal(billAfter.state, 'posted');
});

test('direct-pay return refreshes and settles its closing obligation', () => {
  let db = seed();
  const type = search(db, 'account.return.type')[0];
  db = create(db, 'res.partner.bank', { partner_id: type.payment_partner_id, account_number: 'DIRECT TAX BANK' }).db;
  db = write(db, 'account.return.type', type.id, { states_workflow: 'generic_state_only_pay' });
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2025-04-01',
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 1000 })],
  });
  db = postMove(invoice.db, invoice.id);
  const ret = create(db, 'account.return', {
    name: 'Direct VAT', type_id: type.id, company_id: 1,
    date_from: '2025-04-01', date_to: '2025-04-30', total_amount_to_pay: 1,
  });
  const pay = models['account.return'].form.buttons.find((button) => button.label === 'Pay');
  db = pay.run(ret.db, read(ret.db, 'account.return', ret.id)).db;
  const paid = read(db, 'account.return', ret.id);
  const payment = read(db, 'account.payment', paid.payment_id);
  const closing = read(db, 'account.move', paid.closing_move_ids?.[0]);
  assert.equal(paid.total_amount_to_pay, 140);
  assert.equal(closing?.state, 'posted');
  assert.equal(payment?.state, 'posted');
  assert.equal(payment?.amount, 140);
  assert.equal(payment?.unapplied, 0);
  assert.ok((closing?.payments ?? []).some((p) => p.move_id === payment.move_id && p.amount === 140));
});

test('negative return: posts debit to tax receivable and registers inbound payment refund', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  db = write(db, 'account.return.type', vatType.id, { payment_partner_id: partner.id });
  const from = '2026-04-01';
  const to = '2026-04-30';

  // Vendor bill with 140 tax
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: partner.id, invoice_date: from,
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'purchase', { price_unit: 1000 })],
  });
  db = postMove(bill.db, bill.id);

  // Customer invoice with 40 tax
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: from,
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 40 / 0.14 })],
  });
  db = postMove(inv.db, inv.id);

  // Submit return: net tax payable is 40 - 140 = -100 (refund)
  const ret = create(db, 'account.return', {
    name: 'Negative VAT Return',
    type_id: vatType.id,
    date_from: from,
    date_to: to,
    company_id: 1,
    state: 'reviewed',
  });
  const submittedDb = submitReturn(ret.db, ret.id);
  const submittedRet = read(submittedDb, 'account.return', ret.id);
  assert.equal(submittedRet.total_amount_to_pay, -100);

  // Closing entry debits tax receivable account (131000)
  const closing = read(submittedDb, 'account.move', submittedRet.closing_move_ids[0]);
  const recLine = closing.line_ids.find((l) => read(submittedDb, 'account.account', l.account_id)?.code === '131000' && Number(l.debit) === 100);
  assert.ok(recLine, 'Closing entry debits tax receivable for negative return refund');

  // Pay registers inbound payment (receipt) through the form action.
  const pay = models['account.return'].form.buttons.find((button) => button.label === 'Pay');
  const paidDb = pay.run(submittedDb, submittedRet).db;
  const paidRet = read(paidDb, 'account.return', ret.id);
  assert.equal(paidRet.state, 'paid');
  assert.equal(paidRet.is_completed, true);

  const payments = search(paidDb, 'account.payment').filter((p) => p.return_id === ret.id);
  assert.equal(payments.length, 1);
  const refundP = payments[0];
  assert.equal(refundP.payment_type, 'inbound');
  assert.equal(refundP.amount, 100);
  assert.equal(refundP.destination_account_code, '131000');
  assert.equal(refundP.unapplied, 0);
  assert.equal(refundP.state, 'posted');
  const refundEntry = read(paidDb, 'account.move', refundP.move_id);
  assert.equal(refundEntry.state, 'posted');
  assert.equal(refundEntry.line_ids.find((line) => line.account_id === refundP.destination_account_id)?.credit, 100);
  assert.equal(refundEntry.line_ids.find((line) => read(paidDb, 'account.account', line.account_id)?.code === '101401')?.debit, 100);
  const settledClosing = read(paidDb, 'account.move', paidRet.closing_move_ids[0]);
  assert.equal(settledClosing.payments[0].move_id, refundP.move_id);
  assert.equal(settledClosing.line_ids[settledClosing.payments[0].line_index].account_id, refundP.destination_account_id);
});

test('manual lock preservation on reset and closing cancellation under later lock', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');

  // 1. Pre-existing manual lock date preserved on reset
  db = updateSettings(db, { lock_date: '2026-01-31' });
  const r1 = create(db, 'account.return', {
    name: 'VAT Jan 2026',
    type_id: vatType.id,
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    company_id: 1,
    state: 'reviewed',
  });
  const sub1 = submitReturn(r1.db, r1.id);
  assert.equal(sub1.settings?.lock_date, '2026-01-31');

  // Resetting r1 must NOT erase the manual lock date
  const reset1 = resetReturnToDraft(sub1, r1.id);
  assert.equal(reset1.settings?.lock_date, '2026-01-31', 'Manual lock date preserved on reset');

  // 2. Cancellation under later lock
  const r2 = create(reset1, 'account.return', {
    name: 'VAT Feb 2026',
    type_id: vatType.id,
    date_from: '2026-02-01',
    date_to: '2026-02-28',
    company_id: 1,
    state: 'reviewed',
  });
  const sub2 = submitReturn(r2.db, r2.id);
  assert.equal(sub2.settings?.lock_date, '2026-02-28');
  const closingId = read(sub2, 'account.return', r2.id).closing_move_ids[0];

  // A later lock date (e.g. from year-end closing or manual lock 2026-12-31) is configured
  const laterLocked = updateSettings(sub2, { lock_date: '2026-12-31' });

  // Resetting r2 cancels its closing move cleanly despite the later lock
  const reset2 = resetReturnToDraft(laterLocked, r2.id);
  const cancelledMove = read(reset2, 'account.move', closingId);
  assert.equal(cancelledMove.state, 'cancel');
  assert.equal(reset2.settings?.lock_date, '2026-12-31', 'Later lock remains active');
});

test('states workflow transitions and immutability of submitted/paid returns', () => {
  let db = seed();

  // Workflow: generic_state_review_submit
  const typeReview = create(db, 'account.return.type', {
    name: 'Type Review Submit',
    category: 'account_return',
    states_workflow: 'generic_state_review_submit',
  });
  const rReview = create(typeReview.db, 'account.return', {
    name: 'R Review', type_id: typeReview.id, date_from: '2026-05-01', date_to: '2026-05-31', state: 'new',
  });
  assert.throws(() => submitReturn(rReview.db, rReview.id), /review it first/i);
  assert.throws(() => payReturn(rReview.db, rReview.id), /state new/i);

  // Workflow: generic_state_tax_report
  const typeReport = create(rReview.db, 'account.return.type', {
    name: 'Type Tax Report',
    category: 'account_return',
    states_workflow: 'generic_state_tax_report',
  });
  const rReport = create(typeReport.db, 'account.return', {
    name: 'R Report', type_id: typeReport.id, date_from: '2026-06-01', date_to: '2026-06-30', state: 'new',
  });
  const subReport = submitReturn(rReport.db, rReport.id);
  assert.equal(read(subReport, 'account.return', rReport.id).state, 'submitted');

  // Workflow: generic_state_only_pay
  const typePay = create(subReport, 'account.return.type', {
    name: 'Type Only Pay',
    category: 'account_return',
    states_workflow: 'generic_state_only_pay',
    payment_partner_id: 1,
  });
  const rPay = create(typePay.db, 'account.return', {
    name: 'R Pay', type_id: typePay.id, date_from: '2026-07-01', date_to: '2026-07-31', state: 'new', total_amount_to_pay: 50,
  });
  const paidOnly = payReturn(rPay.db, rPay.id);
  assert.equal(read(paidOnly, 'account.return', rPay.id).state, 'paid');

  // Immutability of submitted return fields
  assert.throws(
    () => write(subReport, 'account.return', rReport.id, { date_to: '2026-12-31' }),
    /cannot be modified/i
  );
  assert.throws(
    () => write(subReport, 'account.return', rReport.id, { total_amount_to_pay: 9999 }),
    /cannot be modified/i
  );

  // Immutability of paid return
  assert.throws(
    () => write(paidOnly, 'account.return', rPay.id, { state: 'new' }),
    /cannot be reset/i
  );
  assert.throws(
    () => resetReturnToDraft(paidOnly, rPay.id),
    /cannot be reset/i
  );
});

test('partner tab bank_ids persistence, ownership, validation, and compute', () => {
  let db = seed();

  // Create partner with bank_ids through public create
  const p = create(db, 'res.partner', {
    name: 'Partner Bank Tab Test',
    bank_ids: [
      { account_number: 'eg 88 7777 6666', bank_name: 'Alexandria Bank', allow_out_payment: true },
    ],
  });
  db = p.db;

  // Verify res.partner.bank record created and synced
  const banks = search(db, 'res.partner.bank').filter((b) => b.partner_id === p.id);
  assert.equal(banks.length, 1);
  assert.equal(banks[0].sanitized_account_number, 'EG8877776666');
  assert.equal(banks[0].allow_out_payment, true);

  // Compute field on partner returns the bank account
  const partnerRec = read(db, 'res.partner', p.id);
  assert.equal(partnerRec.bank_ids.length, 1);
  assert.equal(partnerRec.bank_ids[0].sanitized_account_number, 'EG8877776666');

  // Update bank via partner write
  const updatedDb = write(db, 'res.partner', p.id, {
    bank_ids: [{ id: banks[0].id, allow_out_payment: false }],
  });
  const updatedBank = read(updatedDb, 'res.partner.bank', banks[0].id);
  assert.equal(updatedBank.allow_out_payment, false);

  // Removing from tab deactivates the bank account
  const clearedDb = write(updatedDb, 'res.partner', p.id, { bank_ids: [] });
  const clearedBank = read(clearedDb, 'res.partner.bank', banks[0].id);
  assert.equal(clearedBank.active, false);
  assert.equal(read(clearedDb, 'res.partner', p.id).bank_ids.length, 0);

  // Duplicate in partner bank_ids is rejected
  assert.throws(
    () => create(db, 'res.partner', {
      name: 'Dup Partner',
      bank_ids: [
        { account_number: 'EG123' },
        { account_number: 'eg 123 ' },
      ],
    }),
    /unique/i
  );
});

test('out-payment rule: vendor bill payments and batch payments require allow_out_payment', () => {
  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'Restricted Vendor' });
  const otherVendor = create(vendor.db, 'res.partner', { name: 'Other Vendor' });
  const bankBlocked = create(otherVendor.db, 'res.partner.bank', {
    partner_id: vendor.id,
    account_number: 'BLOCKED999',
    allow_out_payment: false,
  });
  const bankOther = create(bankBlocked.db, 'res.partner.bank', {
    partner_id: otherVendor.id,
    account_number: 'OTHER888',
    allow_out_payment: true,
  });
  const bankArchived = create(bankOther.db, 'res.partner.bank', {
    partner_id: vendor.id,
    account_number: 'ARCH777',
    allow_out_payment: true,
    active: false,
  });
  db = bankArchived.db;

  // Outbound bill
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const postedBill = postMove(bill.db, bill.id);

  // Bill payment with other partner's bank rejected
  const billWrongBank = create(postedBill, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor.id, partner_bank_id: bankOther.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  assert.throws(
    () => payMove(postMove(billWrongBank.db, billWrongBank.id), billWrongBank.id, 50),
    /belong to the partner/i
  );

  // Bill payment with blocked bank rejected
  const billDisallowed = create(postedBill, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor.id, partner_bank_id: bankBlocked.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  assert.throws(
    () => payMove(postMove(billDisallowed.db, billDisallowed.id), billDisallowed.id, 50),
    /outbound payments/i
  );

  // Bill payment with archived bank rejected
  const billArch = create(postedBill, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor.id, partner_bank_id: bankArchived.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  assert.throws(
    () => payMove(postMove(billArch.db, billArch.id), billArch.id, 50),
    /invalid or inactive/i
  );

  // Batch payment with outbound bill to vendor without allow_out_payment must be rejected
  const batch = create(postedBill, 'account.batch.payment', {
    batch_type: 'outbound',
    check_number_start: 101,
    date: today(),
    lines: [{ move_id: bill.id, amount: 100 }],
  });
  assert.throws(
    () => postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id)),
    /out.*payment|bank account/i,
    'Outbound payments must reject bank accounts without allow_out_payment'
  );

  // Enable allow_out_payment -> payMove and batch succeed, persisting recipient bank
  const bankAllowed = write(postedBill, 'res.partner.bank', bankBlocked.id, { allow_out_payment: true });
  const paidMoveDb = payMove(bankAllowed, bill.id, 100);
  const paidBill = read(paidMoveDb, 'account.move', bill.id);
  assert.equal(paidBill.partner_bank_id, bankBlocked.id);
  assert.equal(paidBill.amount_paid, 100);
  const directPayment = search(paidMoveDb, 'account.payment').find((p) => p.invoice_id === bill.id);
  assert.equal(directPayment.state, 'posted');
  assert.equal(directPayment.partner_bank_id, bankBlocked.id);

  const bill2 = create(paidMoveDb, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const posted2 = postMove(bill2.db, bill2.id);
  const batch2 = create(posted2, 'account.batch.payment', {
    batch_type: 'outbound',
    check_number_start: 102,
    date: today(),
    lines: [{ move_id: bill2.id, amount: 100 }],
  });
  const batchPaid = postBatch(batch2.db, read(batch2.db, 'account.batch.payment', batch2.id));
  assert.equal(read(batchPaid, 'account.move', bill2.id).amount_paid, 100);
  assert.equal(search(batchPaid, 'account.payment').find((p) => p.invoice_id === bill2.id).partner_bank_id, bankBlocked.id);
});

test('outbound payment actions require and consistently persist the bill recipient bank', () => {
  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'Action bank vendor' });
  db = vendor.db;
  const makeBill = (source, bankId) => {
    const made = create(source, 'account.move', { move_type: 'in_invoice', partner_id: vendor.id, partner_bank_id: bankId,
      invoice_date: today(), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
    return { id: made.id, db: models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(made.db, read(made.db, 'account.move', made.id)).db };
  };
  const confirmPayment = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm');
  const noBankBill = makeBill(db, null);
  const draft = create(noBankBill.db, 'account.payment', { partner_id: vendor.id, partner_type: 'supplier', payment_type: 'outbound', amount: 100, invoice_id: noBankBill.id });
  assert.throws(() => confirmPayment.run(draft.db, read(draft.db, 'account.payment', draft.id)), /bank account.*required/i);
  const standaloneMissing = create(noBankBill.db, 'account.payment', { partner_id: vendor.id, partner_type: 'supplier', payment_type: 'outbound', amount: 100 });
  assert.throws(() => confirmPayment.run(standaloneMissing.db, read(standaloneMissing.db, 'account.payment', standaloneMissing.id)), /bank account.*required/i);
  const missingSelection = write(draft.db, 'account.payment', draft.id, { partner_bank_id: 999999 });
  assert.throws(() => confirmPayment.run(missingSelection, read(missingSelection, 'account.payment', draft.id)), /invalid or inactive/i);
  const batch = create(noBankBill.db, 'account.batch.payment', { batch_type: 'outbound', check_number_start: 1, lines: [{ move_id: noBankBill.id, amount: 100 }] });
  const validate = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Validate');
  assert.throws(() => validate.run(batch.db, read(batch.db, 'account.batch.payment', batch.id)), /bank account.*required/i);

  const first = create(draft.db, 'res.partner.bank', { partner_id: vendor.id, account_number: 'FIRST' });
  const second = create(first.db, 'res.partner.bank', { partner_id: vendor.id, account_number: 'SECOND' });
  const bill = makeBill(second.db, second.id);
  const conflict = create(bill.db, 'account.payment', { partner_id: vendor.id, partner_type: 'supplier', payment_type: 'outbound', amount: 100, invoice_id: bill.id, partner_bank_id: first.id });
  assert.throws(() => confirmPayment.run(conflict.db, read(conflict.db, 'account.payment', conflict.id)), /bank account.*match/i);
  const matching = write(conflict.db, 'account.payment', conflict.id, { partner_bank_id: null });
  const paid = confirmPayment.run(matching, read(matching, 'account.payment', conflict.id)).db;
  assert.equal(read(paid, 'account.payment', conflict.id).partner_bank_id, second.id);
  assert.equal(read(paid, 'account.payment', conflict.id).state, 'posted');
  assert.equal(read(paid, 'account.move', bill.id).amount_paid, 100);

  const differentBill = makeBill(write(paid, 'account.move', noBankBill.id, { partner_bank_id: second.id }), second.id);
  const standalone = create(differentBill.db, 'account.payment', { partner_id: vendor.id, partner_type: 'supplier', payment_type: 'outbound', amount: 100, partner_bank_id: first.id });
  const standalonePaid = confirmPayment.run(standalone.db, read(standalone.db, 'account.payment', standalone.id)).db;
  assert.equal(read(standalonePaid, 'account.move', differentBill.id).amount_paid, 0);
  assert.equal(read(standalonePaid, 'account.payment', standalone.id).unapplied, 100);

  const direct = makeBill(standalonePaid, null);
  const register = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const oldPrompt = globalThis.prompt;
  try {
    globalThis.prompt = () => '100';
    const result = register.run(direct.db, read(direct.db, 'account.move', direct.id)).db;
    const payment = search(result, 'account.payment').find((p) => p.invoice_id === direct.id);
    assert.equal(read(result, 'account.move', direct.id).amount_paid, 100);
    assert.equal(payment.state, 'posted');
    assert.equal(payment.partner_bank_id, first.id);
  } finally {
    if (oldPrompt === undefined) delete globalThis.prompt; else globalThis.prompt = oldPrompt;
  }
});

test('batch payment form action posts each bill settlement to the selected bank', () => {
  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'Batch settlement vendor' });
  const bank = create(vendor.db, 'res.partner.bank', { partner_id: vendor.id, account_number: 'BATCH-VENDOR-01', allow_out_payment: true });
  db = bank.db;
  const confirm = models['account.move'].form.buttons.find((button) => button.label === 'Confirm');
  const ids = [];
  for (const amount of [100, 200]) {
    const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: vendor.id, partner_bank_id: bank.id, invoice_date: today(),
      invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: amount, tax: 0 }] });
    db = confirm.run(bill.db, read(bill.db, 'account.move', bill.id)).db;
    ids.push(bill.id);
  }
  const batch = create(db, 'account.batch.payment', { batch_type: 'outbound', date: today(), check_number_start: 100,
    lines: ids.map((move_id) => ({ move_id, amount: read(db, 'account.move', move_id).amount_residual })) });
  const validate = models['account.batch.payment'].form.buttons.find((button) => button.label === 'Validate');
  db = validate.run(batch.db, read(batch.db, 'account.batch.payment', batch.id)).db;
  const postedBatch = read(db, 'account.batch.payment', batch.id);
  assert.equal(postedBatch.state, 'posted');
  assert.deepEqual(postedBatch.lines.map((line) => line.check_number), [100, 101]);
  for (const [i, id] of ids.entries()) {
    const bill = read(db, 'account.move', id);
    const amount = [100, 200][i];
    const payment = search(db, 'account.payment').find((p) => p.invoice_id === id);
    assert.equal(bill.amount_paid, amount);
    assert.equal(bill.amount_residual, 0);
    assert.equal(payment?.state, 'posted');
    assert.equal(payment.partner_bank_id, bank.id);
    assert.equal(payment.amount, amount);
    const entry = read(db, 'account.move', payment.move_id);
    assert.equal(entry?.state, 'posted');
    assert.equal(bill.payments.at(-1).move_id, entry.id);
    const payable = entry.line_ids.find((line) => read(db, 'account.account', line.account_id)?.code === '211000');
    const cash = entry.line_ids.find((line) => read(db, 'account.account', line.account_id)?.code === '101401');
    assert.equal(payable?.debit, amount);
    assert.equal(cash?.credit, amount);
  }
});

test('migration v11: sequence advance, preserved formatting, and uniqueness of archived accounts', () => {
  const legacy = {
    schema_version: 10,
    records: {
      'res.partner': [
        { id: 101, name: 'Old Partner With Bank', bank_account: 'eg 55 9999 0001' },
        { id: 102, name: 'Old Partner Without Bank' },
      ],
      'res.partner.bank': [
        { id: 40, partner_id: 99, account_number: 'EXISTING40', sanitized_account_number: 'EXISTING40', allow_out_payment: true, active: true },
      ],
    },
    messages: [],
  };

  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, 11);

  // Sequence is advanced past highest migrated ID
  assert.ok((migrated.seq?.['res.partner.bank'] ?? 0) >= 41, 'Sequence advanced past existing and migrated bank IDs');

  // Next create gets non-colliding ID
  const made = create(migrated, 'res.partner.bank', {
    partner_id: 102,
    account_number: 'NEW ACC 100',
  });
  assert.ok(made.id > 40, 'Newly created ID does not collide with migrated IDs');

  // Original formatted account number preserved alongside sanitized account number
  const banks = migrated.records['res.partner.bank'] ?? [];
  const p101Bank = banks.find((b) => b.partner_id === 101);
  assert.ok(p101Bank);
  assert.equal(p101Bank.account_number, 'eg 55 9999 0001');
  assert.equal(p101Bank.sanitized_account_number, 'EG5599990001');

  // Uniqueness check rejects duplicate of an archived account
  const archivedDb = write(made.db, 'res.partner.bank', made.id, { active: false });
  assert.throws(
    () => create(archivedDb, 'res.partner.bank', {
      partner_id: 102,
      account_number: 'new acc 100',
    }),
    /unique/i,
    'Uniqueness guard must check all accounts including archived'
  );
});

test('bank migration retains both original formats and advances the sequence without legacy values', () => {
  const original = {
    schema_version: 5, seq: { 'res.partner.bank': 90 }, messages: [],
    records: {
      'res.partner': [{ id: 1, name: 'Vendor', bank_account: 'eg 12 345' }, { id: 2, name: 'Next' }],
      'res.partner.bank': [{ id: 40, partner_id: 1, account_number: 'EG12 345', sanitized_account_number: 'EG12345', active: false, allow_out_payment: false }],
    },
  };
  const result = migrate(original);
  const bank = read(result, 'res.partner.bank', 40);
  assert.equal(bank.account_number, 'EG12 345');
  assert.deepEqual(bank.legacy_account_numbers, ['eg 12 345']);
  assert.equal(bank.active, false);
  assert.equal(bank.allow_out_payment, false);
  assert.equal(result.records['res.partner'][0].bank_account, undefined);
  assert.equal(original.records['res.partner.bank'][0].account_number, 'EG12 345');
  assert.equal(migrate(result), result);
  assert.equal(create(result, 'res.partner.bank', { partner_id: 2, account_number: 'OTHER' }).id, 91);

  const noLegacy = { schema_version: 5, records: { 'res.partner': [{ id: 2, name: 'Next' }], 'res.partner.bank': [{ id: 40, partner_id: 1, account_number: 'EXISTING' }] }, seq: {}, messages: [] };
  const migrated = migrate(noLegacy);
  const created = create(migrated, 'res.partner.bank', { partner_id: 2, account_number: 'NEW' });
  assert.equal(created.id, 41);
  assert.equal(read(created.db, 'res.partner.bank', 40).account_number, 'EXISTING');
  assert.equal(migrate(migrated), migrated);
});

test('bank migration recognizes a matching account without a stored sanitized value', () => {
  const legacy = { schema_version: 5, seq: {}, messages: [], records: {
    'res.partner': [{ id: 1, bank_account: ' eg 1 2 ' }],
    'res.partner.bank': [{ id: 7, partner_id: 1, account_number: 'EG12', active: false }],
  } };
  const db = migrate(legacy);
  assert.equal(db.records['res.partner.bank'].length, 1);
  assert.equal(read(db, 'res.partner.bank', 7).account_number, 'EG12');
  assert.deepEqual(read(db, 'res.partner.bank', 7).legacy_account_numbers, [' eg 1 2 ']);
  assert.throws(() => create(db, 'res.partner.bank', { partner_id: 1, account_number: 'eg 12' }), /unique/i);
});

test('bank migration honors a higher existing sequence when creating a migrated account', () => {
  const legacy = { schema_version: 5, seq: { 'res.partner.bank': 90 }, messages: [], records: {
    'res.partner': [{ id: 1, bank_account: 'account 1' }, { id: 2 }],
    'res.partner.bank': [{ id: 40, partner_id: 2, account_number: 'OTHER' }],
  } };
  const db = migrate(legacy);
  assert.equal(search(db, 'res.partner.bank').find((b) => b.partner_id === 1).id, 91);
  assert.equal(create(db, 'res.partner.bank', { partner_id: 2, account_number: 'NEXT' }).id, 92);
});

test('invoice analytic defaults follow posting accounts and refresh through form changes', () => {
  let db = seed();
  const a = search(db, 'account.analytic.account')[0].id;
  const b = search(db, 'account.analytic.account')[1].id;
  const source = create(db, 'account.account', { code: '622220', name: 'Original expense' });
  const mapped = create(source.db, 'account.account', { code: '633330', name: 'Mapped expense' });
  const fp = create(mapped.db, 'account.fiscal.position', { name: 'Mapped', account_ids: [{ account_src_id: source.id, account_dest_id: mapped.id }] });
  const partner = create(fp.db, 'res.partner', { name: 'Mapped vendor', property_account_position_id: fp.id });
  const other = create(partner.db, 'res.partner', { name: 'Other vendor' });
  const product = create(other.db, 'product', { name: 'Analytic service', type: 'service', property_account_expense_id: source.id, cost: 100 });
  const model = create(product.db, 'account.analytic.distribution.model', { account_prefix: '63333', analytic_distribution: { [a]: 100 } });
  const partnerModel = create(model.db, 'account.analytic.distribution.model', { partner_id: other.id, analytic_distribution: { [b]: 100 } });
  db = partnerModel.db;
  const moveDef = models['account.move'];
  const lineChange = moveDef.fields.invoice_line_ids.onchange;
  const move = { move_type: 'in_invoice', partner_id: partner.id, company_id: 1, fiscal_position_id: fp.id };
  const line = lineChange({ product_id: product.id, qty: 1, price_unit: 99 }, 'product_id', db, move);
  assert.deepEqual(line.analytic_distribution, { [a]: 100 });
  const manuallyPriced = lineChange({ ...line, price_unit: 123 }, 'account_id', db, move);
  assert.equal(manuallyPriced.price_unit, 123);
  assert.deepEqual(manuallyPriced.analytic_distribution, { [a]: 100 });
  const changed = moveDef.onchange({ ...move, partner_id: other.id, invoice_line_ids: [line] }, 'partner_id', db);
  assert.deepEqual(changed.invoice_line_ids[0].analytic_distribution, { [b]: 100 });
  const unmatched = moveDef.onchange({ ...move, partner_id: 0, invoice_line_ids: [line] }, 'partner_id', db);
  assert.deepEqual(unmatched.invoice_line_ids[0].analytic_distribution, {});
  const clearedAccount = lineChange({ ...line, account_id: source.id }, 'account_id', db, { ...move, fiscal_position_id: null });
  assert.deepEqual(clearedAccount.analytic_distribution, {});
  const positionChanged = moveDef.onchange({ ...move, fiscal_position_id: null, invoice_line_ids: [line] }, 'fiscal_position_id', db);
  assert.deepEqual(positionChanged.invoice_line_ids[0].analytic_distribution, {});
  const noCompany = moveDef.onchange({ ...move, company_id: null, invoice_line_ids: [line] }, 'company_id', db);
  assert.deepEqual(noCompany.invoice_line_ids[0].analytic_distribution, {});
  const made = create(db, 'account.move', { ...move, invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = moveDef.form.buttons.find((b) => b.label === 'Confirm').run(made.db, read(made.db, 'account.move', made.id)).db;
  const invoice = read(posted, 'account.move', made.id);
  assert.deepEqual(invoice.invoice_line_ids[0].analytic_distribution, { [a]: 100 });
  assert.ok(invoice.line_ids.some((l) => l.account_id === mapped.id));
  assert.equal(search(posted, 'account.analytic.line').find((l) => l.move_id === made.id).general_account, '633330');
});

test('bill analytic defaults use the stock interim account actually posted', () => {
  let db = seed();
  const analytic = search(db, 'account.analytic.account')[0].id;
  const expense = create(db, 'account.account', { code: '677770', name: 'Expense' });
  const product = create(expense.db, 'product', { name: 'Stock product', type: 'goods', valuation: 'automated', property_account_expense_id: expense.id, cost: 100 });
  const model = create(product.db, 'account.analytic.distribution.model', { account_prefix: '110200', analytic_distribution: { [analytic]: 100 } });
  db = model.db;
  const move = { move_type: 'in_invoice', partner_id: 1, company_id: 1 };
  const def = models['account.move'];
  const line = def.fields.invoice_line_ids.onchange({ product_id: product.id, qty: 1, price_unit: 100 }, 'product_id', db, move);
  assert.deepEqual(line.analytic_distribution, { [analytic]: 100 });
  const made = create(db, 'account.move', { ...move, invoice_line_ids: [{ product_id: product.id, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = def.form.buttons.find((b) => b.label === 'Confirm').run(made.db, read(made.db, 'account.move', made.id)).db;
  const bill = read(posted, 'account.move', made.id);
  const interim = search(posted, 'account.account').find((a) => a.code === '110200');
  assert.ok(bill.line_ids.some((l) => l.account_id === interim.id));
  assert.deepEqual(bill.invoice_line_ids[0].analytic_distribution, { [analytic]: 100 });
  assert.equal(search(posted, 'account.analytic.line').find((l) => l.move_id === made.id).general_account, '110200');
});

test('analytic distribution models: matches most specific model and propagates onchange / posting fallback', () => {
  let db = seed();
  const acc1 = search(db, 'account.analytic.account')[0].id;
  const acc2 = search(db, 'account.analytic.account')[1].id;

  // Model 1: Specific for partner 2 AND product 1
  const m1 = create(db, 'account.analytic.distribution.model', {
    partner_id: 2,
    product_id: 1,
    analytic_distribution: { [acc2]: 100 },
    sequence: 10,
  });

  // Model 2: By expense account prefix "60"
  const m2 = create(m1.db, 'account.analytic.distribution.model', {
    account_prefix: '60',
    analytic_distribution: { [acc1]: 50, [acc2]: 50 },
    sequence: 30,
  });
  db = m2.db;

  // 1. Specific matching: partner 2 + product 1 resolves Model 1
  const distSpecific = findAnalyticDistribution(db, { partner_id: 2, product_id: 1, company_id: 1 });
  assert.deepEqual(distSpecific, { [acc2]: 100 });

  // 2. Prefix matching: account prefix 60 resolves Model 2
  const distPrefix = findAnalyticDistribution(db, { account_code: '600000', company_id: 1 });
  assert.deepEqual(distPrefix, { [acc1]: 50, [acc2]: 50 });

  // 3. Move onchange on partner_id updates lines
  const moveOnchange = models['account.move'].onchange;
  const moveWithPartner2 = moveOnchange({
    partner_id: 2,
    move_type: 'in_invoice',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  }, 'partner_id', db);
  assert.deepEqual(moveWithPartner2.invoice_line_ids[0].analytic_distribution, { [acc2]: 100 });

  // 4. Posting fallback: bill line without distribution gets resolved on postMove
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const postedBill = postMove(bill.db, bill.id);
  const postedRec = read(postedBill, 'account.move', bill.id);
  assert.deepEqual(postedRec.invoice_line_ids[0].analytic_distribution, { [acc2]: 100 });
});

test('generation after periodicity changes fills uncovered dates without overlapping existing returns', () => {
  let db = seed();
  const year = Number(today().slice(0, 4)) - 1;
  const start = `${year}-01-01`;
  const company = create(db, 'res.company', { name: 'Changing tax periods', tax_periodicity: 'monthly', tax_start_date: start });
  db = company.db;
  const type = search(db, 'account.return.type').find((t) => t.company_id === company.id);
  const action = models['account.return.type'].form.buttons.find((b) => b.label === 'Generate Returns');
  const first = create(db, 'account.return', { name: 'Already filed January', type_id: type.id, company_id: company.id, date_from: start, date_to: `${year}-01-31` });
  const third = create(first.db, 'account.return', { name: 'Archived March', type_id: type.id, company_id: company.id, date_from: `${year}-03-01`, date_to: `${year}-03-31`, active: false });
  db = write(third.db, 'res.company', company.id, { tax_periodicity: 'trimester' });
  assert.equal(read(db, 'account.return.type', type.id).deadline_periodicity, 'trimester');
  db = action.run(db, read(db, 'account.return.type', type.id)).db;
  const returns = db.records['account.return'].filter((r) => r.type_id === type.id).sort((a, b) => a.date_from.localeCompare(b.date_from));
  assert.deepEqual(returns.slice(0, 3).map((r) => [r.date_from, r.date_to]), [[start, `${year}-01-31`], [`${year}-02-01`, `${year}-02-${year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? '29' : '28'}`], [`${year}-03-01`, `${year}-03-31`]]);
  for (let i = 1; i < returns.length; i++) assert.ok(returns[i - 1].date_to < returns[i].date_from, 'periods must not overlap');
  const count = returns.length;
  db = action.run(db, read(db, 'account.return.type', type.id)).db;
  assert.equal(db.records['account.return'].filter((r) => r.type_id === type.id).length, count);
  db = write(db, 'res.company', company.id, { tax_periodicity: 'monthly' });
  db = action.run(db, read(db, 'account.return.type', type.id)).db;
  assert.equal(db.records['account.return'].filter((r) => r.type_id === type.id).length, count);
});

test('generation without configured start recovers earlier company ledger history', () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Historical company', tax_periodicity: 'trimester' });
  db = company.db;
  const type = search(db, 'account.return.type').find((t) => t.company_id === company.id);
  assert.equal(type.deadline_start_date, null);
  const action = models['account.return.type'].form.buttons.find((b) => b.label === 'Generate Returns');
  db = action.run(db, read(db, 'account.return.type', type.id)).db;
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2018-01-10', lines: [
    { account: '251000', credit: 50, tax_name: 'Other company VAT' }, { account: '101401', debit: 50 },
  ] }).db;
  db = postEntry(db, { journal: 'MISC', company: company.id, date: '2021-05-17', lines: [
    { account: '251000', credit: 100, tax_name: 'Historical VAT' }, { account: '101401', debit: 100 },
  ] }).db;
  db = action.run(db, read(db, 'account.return.type', type.id)).db;
  const returns = db.records['account.return'].filter((r) => r.type_id === type.id).sort((a, b) => a.date_from.localeCompare(b.date_from));
  assert.equal(returns[0].date_from, '2021-04-01');
  assert.equal(returns[0].date_to, '2021-06-30');
  assert.equal(returns[0].total_amount_to_pay, 100);
  for (let i = 1; i < returns.length; i++) assert.ok(returns[i - 1].date_to < returns[i].date_from);
});

test('company tax periodicity setting, start date, and period generation', () => {
  let db = seed();
  const company = search(db, 'res.company')[0];

  // Update company tax periodicity to trimester and start date to 2025-05-15
  const updatedCo = write(db, 'res.company', company.id, {
    tax_periodicity: 'trimester',
    tax_start_date: '2025-05-15',
  });
  const vatType = search(updatedCo, 'account.return.type').find((t) => (t.company_id ?? 1) === company.id && t.name === 'VAT Return');
  assert.equal(vatType.deadline_periodicity, 'trimester');
  assert.equal(vatType.deadline_start_date, '2025-05-15');

  // periodsUpTo honors exact start day and does not align backward
  const periods = periodsUpTo('trimester', '2025-05-15', '2025-10-01');
  assert.ok(periods.length >= 2);
  assert.equal(periods[0].from, '2025-05-15');
  assert.equal(periods[0].to, '2025-06-30');
  assert.equal(periods[1].from, '2025-07-01');
  assert.equal(periods[1].to, '2025-09-30');
  assert.ok(!periods.some((p) => p.from < '2025-05-15'));
});

test('review compares invoice tax source to independently posted tax account balances', () => {
  let db = seed();
  const type = search(db, 'account.return.type')[0];
  const saleTax = search(db, 'account.account').find((a) => a.code === '251000');
  const receivable = search(db, 'account.account').find((a) => a.code === '121000');
  const revenue = search(db, 'account.account').find((a) => a.code === '400000');
  const bad = create(db, 'account.move', {
    name: 'INV/2020/99999', move_type: 'out_invoice', state: 'posted', company_id: 1, partner_id: 1,
    invoice_date: '2020-05-15', invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 1000 })],
    line_ids: [
      { account_id: receivable.id, debit: 1100, credit: 0 },
      { account_id: revenue.id, debit: 0, credit: 1000 },
      { account_id: saleTax.id, debit: 0, credit: 100, tax_name: 'VAT 14%' },
    ],
  });
  const ret = create(bad.db, 'account.return', { name: 'Source reconciliation', type_id: type.id, company_id: 1, date_from: '2020-05-01', date_to: '2020-05-31' });
  const actions = models['account.return'].form.buttons;
  const review = actions.find((b) => b.label === 'Review');
  assert.throws(() => review.run(ret.db, read(ret.db, 'account.return', ret.id)), /tax account.*invoice|invoice.*tax account/i);
  const cleanReturn = create(db, 'account.return', { name: 'Post-review invoice', type_id: type.id, company_id: 1, date_from: '2020-05-01', date_to: '2020-05-31' });
  const reviewed = review.run(cleanReturn.db, read(cleanReturn.db, 'account.return', cleanReturn.id)).db;
  const late = create(reviewed, 'account.move', read(bad.db, 'account.move', bad.id));
  assert.throws(() => actions.find((b) => b.label === 'Submit').run(late.db, read(late.db, 'account.return', cleanReturn.id)), /tax account.*invoice|invoice.*tax account/i);
});

test('tax review uses the invoice posting exchange rate after rates change', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'TAX-FOREIGN', rate_ids: [{ date: '2020-01-01', rate: 2 }] });
  const type = search(currency.db, 'account.return.type')[0];
  const invoice = create(currency.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: 1, currency_id: currency.id, invoice_date: '2020-05-15',
    invoice_line_ids: [invoiceLine(currency.db, 'VAT 14%', 'sale', { price_unit: 1000 })] });
  const confirm = models['account.move'].form.buttons.find((b) => b.label === 'Confirm');
  db = confirm.run(invoice.db, read(invoice.db, 'account.move', invoice.id)).db;
  const postedInvoice = read(db, 'account.move', invoice.id);
  assert.throws(() => write(db, 'account.move', invoice.id, { tax_rate_at_posting: 4 }), /posted entries cannot be edited/i);
  // Older stored invoices have no rate snapshot, but their journal items retain document-currency amounts.
  const legacy = create(invoice.db, 'account.move', {
    name: 'INV/2020/99998', move_type: 'out_invoice', state: 'posted', partner_id: 1, company_id: 1,
    currency_id: currency.id, invoice_date: '2020-06-15', invoice_line_ids: postedInvoice.invoice_line_ids, line_ids: postedInvoice.line_ids,
  });
  let legacyDb = write(legacy.db, 'res.currency', currency.id, { rate_ids: [{ date: '2020-01-01', rate: 4 }] });
  const legacyReturn = create(legacyDb, 'account.return', { name: 'Legacy foreign VAT', type_id: type.id, company_id: 1, date_from: '2020-06-01', date_to: '2020-06-30' });
  const review = models['account.return'].form.buttons.find((b) => b.label === 'Review');
  legacyDb = review.run(legacyReturn.db, read(legacyReturn.db, 'account.return', legacyReturn.id)).db;
  assert.equal(read(legacyDb, 'account.return', legacyReturn.id).total_amount_to_pay, 70);
  db = write(db, 'res.currency', currency.id, { rate_ids: [{ date: '2020-01-01', rate: 4 }] });
  const ret = create(db, 'account.return', { name: 'Foreign VAT', type_id: type.id, company_id: 1, date_from: '2020-05-01', date_to: '2020-05-31' });
  db = review.run(ret.db, read(ret.db, 'account.return', ret.id)).db;
  assert.equal(read(db, 'account.return', ret.id).total_amount_to_pay, 70);
});

test('unbalanced tax account ledger check in review and relational fields', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  const from = '2026-08-01';
  const to = '2026-08-31';

  // Create return in state 'new'
  const ret = create(db, 'account.return', {
    name: 'Unbalanced Test Return',
    type_id: vatType.id,
    date_from: from,
    date_to: to,
    company_id: 1,
    state: 'new',
  });

  // Post a rogue manual entry directly altering tax account 251000 without tax report tags
  const rogue = postEntry(ret.db, {
    journal: 'MISC',
    date: from,
    ref: 'Rogue Tax Entry',
    lines: [
      { account: '251000', debit: 500, credit: 0 },
      { account: '101401', debit: 0, credit: 500 },
    ],
  });

  // Review must detect mismatch between tax report payable (0) and ledger balance (500)
  assert.throws(
    () => reviewReturn(rogue.db, ret.id),
    /unbalanced tax account/i,
    'Review must reject unbalanced tax accounts'
  );

  // Relational fields: closing_move_ids and attachment_ids are declared as many2many
  assert.equal(models['account.return'].fields.closing_move_ids.type, 'many2many');
  assert.equal(models['account.return'].fields.closing_move_ids.relation, 'account.move');
  assert.equal(models['account.return'].fields.attachment_ids.type, 'many2many');
  assert.equal(models['account.return'].fields.attachment_ids.relation, 'documents.document');
});

test('lock on submit: locks period on date_to and refuses new or edited moves in the period', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  const pastStart = '2026-01-01';
  const pastEnd = '2026-01-31';
  const retRes = create(db, 'account.return', {
    name: 'VAT Jan 2026',
    type_id: vatType.id,
    date_from: pastStart,
    date_to: pastEnd,
    company_id: 1,
    state: 'reviewed',
  });
  db = retRes.db;

  const submittedDb = submitReturn(db, retRes.id);
  const ret = read(submittedDb, 'account.return', retRes.id);
  assert.equal(ret.date_lock, pastEnd);
  assert.ok(submittedDb.settings?.lock_date >= pastEnd, 'Global lock date reflects submitted period');

  // Attempting to post an invoice in the locked period must fail
  const inv = create(submittedDb, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  assert.throws(
    () => postMove(inv.db, inv.id),
    /locked/i,
    'Moves in submitted return period must be refused by lock'
  );
});

test('reset rules: reset to draft cancels closing move and unlocks, but is forbidden after pay', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  const periodTo = '2026-02-28';
  const retRes = create(db, 'account.return', {
    name: 'VAT Feb 2026',
    type_id: vatType.id,
    date_from: '2026-02-01',
    date_to: periodTo,
    company_id: 1,
    state: 'reviewed',
  });
  const submittedDb = submitReturn(retRes.db, retRes.id);
  const submittedRet = read(submittedDb, 'account.return', retRes.id);
  const closingId = submittedRet.closing_move_ids[0];

  // Reset to Draft from submitted
  const resetDb = resetReturnToDraft(submittedDb, retRes.id);
  const resetRet = read(resetDb, 'account.return', retRes.id);
  assert.equal(resetRet.state, 'new');
  assert.equal(resetRet.date_lock, null);

  // Closing move must be cancelled
  const cancelledMove = read(resetDb, 'account.move', closingId);
  assert.equal(cancelledMove.state, 'cancel');

  // Once paid, reset to draft is rejected
  const paidRet = payReturn(submittedDb, retRes.id);
  assert.throws(
    () => resetReturnToDraft(paidRet, retRes.id),
    /paid/i,
    'Reset to draft is forbidden after pay'
  );
});

test('bank account sanitizing and uniqueness per partner', () => {
  let db = seed();
  const partner1 = 1;
  const partner2 = 2;

  // Sanitizes uppercase without spaces
  const acc1 = create(db, 'res.partner.bank', {
    partner_id: partner1,
    account_number: 'eg 12 3456 7890 ',
    holder_name: 'Test Holder',
  });
  const saved1 = read(acc1.db, 'res.partner.bank', acc1.id);
  assert.equal(saved1.sanitized_account_number, 'EG1234567890');

  // Unique per partner: same partner cannot add the same sanitized account
  assert.throws(
    () => create(acc1.db, 'res.partner.bank', {
      partner_id: partner1,
      account_number: 'EG1234567890',
    }),
    /unique/i,
    'Duplicate account number for the same partner must be rejected'
  );

  // Different partner CAN have the same account number
  assert.doesNotThrow(() => {
    create(acc1.db, 'res.partner.bank', {
      partner_id: partner2,
      account_number: 'EG1234567890',
    });
  });
});

test('i18n has no duplicate keys in Arabic translations', async () => {
  const fs = await import('node:fs');
  const content = fs.readFileSync('src/i18n.js', 'utf8');
  const arBlock = content.slice(content.indexOf('const ar = {'), content.indexOf('export function t('));
  const lines = arBlock.split('\n');
  const seen = new Set();
  const dups = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const re = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))\s*:/;
    const match = trimmed.match(re);
    if (match) {
      const key = match[1] ?? match[2] ?? match[3];
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
  }
  assert.deepEqual(dups, [], 'No duplicate keys in src/i18n.js');
});

test('closing and payment entries on tax accounts do not fail subsequent or overlapping reviews or pollute tax reports', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  db = create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'TAX-BANK-001' }).db;
  const vatType = search(db, 'account.return.type').find((t) => t.name === 'VAT Return');
  db = write(db, 'account.return.type', vatType.id, { payment_partner_id: partner.id });

  // 1. Post a customer invoice and vendor bill with tax in January 2025
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    company_id: 1,
    invoice_date: '2025-01-10',
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'sale', { price_unit: 1000 })],
  });
  db = postMove(inv.db, inv.id);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    company_id: 1,
    invoice_date: '2025-01-15',
    invoice_line_ids: [invoiceLine(db, 'VAT 14%', 'purchase', { price_unit: 400 })],
  });
  db = postMove(bill.db, bill.id);

  const initialReport = taxReport(db, { from: '2025-01-01', to: '2025-01-31', company_id: 1 });
  assert.equal(initialReport.output, 140);
  assert.equal(initialReport.input, 56);
  assert.equal(initialReport.payable, 84);

  // 2. Create, review, submit and pay January 2025 VAT return
  const retJan = create(db, 'account.return', {
    name: 'VAT Jan 2025',
    type_id: vatType.id,
    date_from: '2025-01-01',
    date_to: '2025-01-31',
    company_id: 1,
  });
  db = retJan.db;
  db = reviewReturn(db, retJan.id);
  db = submitReturn(db, retJan.id);
  db = payReturn(db, retJan.id);

  const paidRet = read(db, 'account.return', retJan.id);
  assert.equal(paidRet.state, 'paid');
  assert.ok(paidRet.closing_move_ids.length > 0);
  assert.ok(paidRet.payment_id);

  // 3. Reports for the period must still report ONLY genuine tax activity, not closing or settlement lines
  const reportAfterPay = taxReport(db, { from: '2025-01-01', to: '2025-01-31', company_id: 1 });
  assert.equal(reportAfterPay.output, 140, 'Closing/payment lines on 251000 must not inflate output tax');
  assert.equal(reportAfterPay.input, 56, 'Closing/payment lines on 131000 must not inflate input tax');
  assert.equal(reportAfterPay.payable, 84, 'Payable must remain strictly reportable tax');

  // Also check Q1 report containing January
  const q1Report = taxReport(db, { from: '2025-01-01', to: '2025-03-31', company_id: 1 });
  assert.equal(q1Report.output, 140);
  assert.equal(q1Report.input, 56);
  assert.equal(q1Report.payable, 84);

  // 4. Overlapping or regenerated return (e.g. Q1 return or audit) must review without failing on untagged closing/settlement lines
  const retQ1 = create(db, 'account.return', {
    name: 'VAT Q1 2025',
    type_id: vatType.id,
    date_from: '2025-01-01',
    date_to: '2025-03-31',
    company_id: 1,
  });
  assert.doesNotThrow(() => {
    reviewReturn(retQ1.db, retQ1.id);
  }, 'Overlapping return review must distinguish closing and settlement entries from untagged tax errors');
});

test('ordinary tax entries remain reportable when their reference resembles a return settlement', () => {
  let db = seed();
  for (const ref of ['Tax Closing: ordinary', 'Tax Return Payment: ordinary', 'Tax Return Refund: ordinary']) {
    db = postEntry(db, { journal: 'MISC', date: '2025-03-01', ref, lines: [{ account: '251000', credit: 10, tax_name: 'VAT' }, { account: '101401', debit: 10 }] }).db;
  }
  const report = taxReport(db, { from: '2025-03-01', to: '2025-03-31' });
  assert.equal(report.output, 30);
});
