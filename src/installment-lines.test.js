import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, payMove, postMove } from './models/accounting.js';
import { agedBalance, followUps } from './models/finance.js';
import {
  balanceSheet,
  isBalanced,
  journalItemIdentity,
  postEntry,
  reconciledJournalItems,
} from './models/ledger.js';
import {
  postPayment,
  reconcileJournalItems,
  unreconcileJournalItems,
  writeoffJournalItem,
} from './models/pay.js';
import { round } from './money.js';

function makeTerm(db, name, lineIds) {
  return create(db, 'account.payment.term', {
    name,
    line_ids: lineIds,
  });
}

function makePartner(db, name) {
  return create(db, 'res.partner', { name, is_company: true });
}

function makeInvoice(db, {
  move_type = 'out_invoice',
  partner_id,
  invoice_date = '2026-01-01',
  invoice_date_due = invoice_date,
  invoice_payment_term_id = null,
  currency_id = null,
  amount = 1000,
  account_id = null,
}) {
  const acc = account_id ?? search(db, 'account.account').find((a) => (
    move_type.startsWith('in_') ? a.account_type === 'expense' : a.account_type === 'income'
  )).id;
  return create(db, 'account.move', {
    move_type,
    partner_id,
    invoice_date,
    invoice_date_due,
    ...(invoice_payment_term_id ? { invoice_payment_term_id } : {}),
    ...(currency_id ? { currency_id } : {}),
    invoice_line_ids: [{ name: 'Service line', qty: 1, price_unit: amount, account_id: acc }],
  });
}

function counterpartLines(db, move, accountType) {
  return (move.line_ids ?? []).filter((line) => read(db, 'account.account', line.account_id)?.account_type === accountType);
}

function agedTotal(db, kind, at) {
  return round(agedBalance(db, kind, at).rows.reduce((sum, row) => sum + row.total, 0));
}

function bsTotalByType(db, at, section, accountType) {
  const bs = balanceSheet(db, at);
  return round(bs[section].filter((r) => r.account.account_type === accountType).reduce((sum, r) => sum + r.balance, 0));
}

test('PKG-07: multi-installment term posts one AR line per installment with due dates and balanced entry (Probe 8 scenario)', () => {
  let db = seed();
  const partner = makePartner(db, 'Installment Customer A');
  db = partner.db;
  const term = makeTerm(db, '30% Now / 70% +60d', [
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 70, nb_days: 60, delay_type: 'days_after' },
  ]);
  db = term.db;
  const inv = makeInvoice(db, {
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    amount: 1000,
  });
  db = postMove(inv.db, inv.id);

  const move = read(db, 'account.move', inv.id);
  const arLines = counterpartLines(db, move, 'asset_receivable');
  assert.equal(arLines.length, 2);
  assert.deepEqual(
    arLines.map((l) => ({
      debit: l.debit,
      credit: l.credit ?? 0,
      date_maturity: l.date_maturity,
      account_id: l.account_id,
      partner_id: l.partner_id,
    })),
    [
      { debit: 300, credit: 0, date_maturity: '2026-01-01', account_id: arLines[0].account_id, partner_id: partner.id },
      { debit: 700, credit: 0, date_maturity: '2026-03-02', account_id: arLines[0].account_id, partner_id: partner.id },
    ],
  );
  assert.equal(move.invoice_date_due, '2026-03-02');
  assert.equal(isBalanced(move.line_ids), true);
  assert.equal(
    round(move.line_ids.reduce((s, l) => s + (l.debit || 0), 0)),
    round(move.line_ids.reduce((s, l) => s + (l.credit || 0), 0)),
  );
});

test('PKG-07: foreign-currency installment amounts and company-currency rounding land on last installment', () => {
  let db = seed();
  const eur = create(db, 'res.currency', {
    name: 'EUR',
    full_name: 'Euro',
    symbol: 'EUR',
    rounding: 0.01,
    active: true,
    rate_ids: [{ date: '2026-01-01', rate: 0.3, company_id: null }],
  });
  db = eur.db;
  const partner = makePartner(db, 'Foreign Currency Client');
  db = partner.db;
  // Total = 100.00 EUR -> at rate 0.3, total company USD = round(100 / 0.3) = 333.33 USD.
  // 3 equal percentage installments put rounding remainders on the last line in both currencies.
  const term = makeTerm(db, '3x 33.33%', [
    { value_type: 'percent', value: 33.33, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 33.33, nb_days: 30, delay_type: 'days_after' },
    { value_type: 'percent', value: 33.34, nb_days: 60, delay_type: 'days_after' },
  ]);
  db = term.db;
  const inv = makeInvoice(db, {
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    currency_id: eur.id,
    amount: 100,
  });
  db = postMove(inv.db, inv.id);

  const move = read(db, 'account.move', inv.id);
  const arLines = counterpartLines(db, move, 'asset_receivable');
  assert.equal(arLines.length, 3);
  assert.deepEqual(
    arLines.map((l) => l.amount_currency),
    [33.33, 33.33, 33.34],
  );
  assert.equal(round(arLines.reduce((s, l) => s + l.amount_currency, 0)), 100);
  const companyDebitSum = round(arLines.reduce((s, l) => s + l.debit, 0));
  assert.equal(companyDebitSum, 333.33);
  assert.deepEqual(
    arLines.map((l) => l.debit),
    [111.1, 111.1, 111.13],
  );
  assert.deepEqual(
    arLines.map((l) => l.date_maturity),
    ['2026-01-01', '2026-01-31', '2026-03-02'],
  );
  assert.equal(isBalanced(move.line_ids), true);
});

test('PKG-07: single-installment term and no payment term keep one receivable line due on invoice_date_due', () => {
  let db = seed();
  const partner = makePartner(db, 'Single Term Client');
  db = partner.db;
  const singleTerm = makeTerm(db, 'Net 30', [
    { value_type: 'percent', value: 100, nb_days: 30, delay_type: 'days_after' },
  ]);
  db = singleTerm.db;

  const withTerm = makeInvoice(db, {
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: singleTerm.id,
    amount: 500,
  });
  db = postMove(withTerm.db, withTerm.id);
  const m1 = read(db, 'account.move', withTerm.id);
  const ar1 = counterpartLines(db, m1, 'asset_receivable');
  assert.equal(ar1.length, 1);
  assert.equal(ar1[0].debit, 500);
  assert.equal(ar1[0].date_maturity, m1.invoice_date_due);
  assert.equal(m1.invoice_date_due, '2026-01-31');

  const withoutTerm = makeInvoice(db, {
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-02-05',
    amount: 500,
  });
  db = postMove(withoutTerm.db, withoutTerm.id);
  const m2 = read(db, 'account.move', withoutTerm.id);
  const ar2 = counterpartLines(db, m2, 'asset_receivable');
  assert.equal(ar2.length, 1);
  assert.equal(ar2[0].debit, 500);
  assert.equal(ar2[0].date_maturity, '2026-02-05');
});

test('PKG-07: partial payment settles earliest due date first and aged report buckets installments + ties to balance sheet', () => {
  let db = seed();
  const partner = makePartner(db, 'Aged & Partial Client');
  db = partner.db;
  const term = makeTerm(db, '30/70 Split', [
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 70, nb_days: 60, delay_type: 'days_after' },
  ]);
  db = term.db;
  const inv = makeInvoice(db, {
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    amount: 1000,
  });
  db = postMove(inv.db, inv.id);

  // At 2026-02-15: 2026-01-01 is 45 days past due (31_60), 2026-03-02 is not yet due (current).
  const beforeAged = agedBalance(db, 'receivable', '2026-02-15');
  const beforeRow = beforeAged.rows.find((r) => r.partner_id === partner.id);
  assert.equal(beforeRow['31_60'], 300);
  assert.equal(beforeRow.current, 700);
  assert.equal(beforeRow.total, 1000);
  assert.equal(agedTotal(db, 'receivable', '2026-02-15'), bsTotalByType(db, '2026-02-15', 'assets', 'asset_receivable'));

  // Partial payment of 400 on 2026-02-10 clears the 300 installment and reduces the 700 installment to 600.
  db = payMove(db, inv.id, 400, '2026-02-10');
  const paidMove = read(db, 'account.move', inv.id);
  assert.equal(paidMove.amount_residual, 600);
  assert.equal(paidMove.payment_state, 'partial');
  const items = reconciledJournalItems(db, paidMove).filter((l) => l.date_maturity);
  assert.deepEqual(
    items.map((l) => ({ date_maturity: l.date_maturity, amount_residual: l.amount_residual })),
    [
      { date_maturity: '2026-01-01', amount_residual: 0 },
      { date_maturity: '2026-03-02', amount_residual: 600 },
    ],
  );

  const afterAged = agedBalance(db, 'receivable', '2026-02-15');
  const afterRow = afterAged.rows.find((r) => r.partner_id === partner.id);
  assert.equal(afterRow['31_60'], 0);
  assert.equal(afterRow.current, 600);
  assert.equal(afterRow.total, 600);
  assert.equal(agedTotal(db, 'receivable', '2026-02-15'), bsTotalByType(db, '2026-02-15', 'assets', 'asset_receivable'));
});

test('PKG-07: vendor bill mirror posts one AP line per installment, pays earliest first, and ages/ties to AP balance', () => {
  let db = seed();
  const vendor = makePartner(db, 'Installment Vendor');
  db = vendor.db;
  const term = makeTerm(db, 'Bill 30/70', [
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 70, nb_days: 60, delay_type: 'days_after' },
  ]);
  db = term.db;
  const bill = makeInvoice(db, {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    amount: 1000,
  });
  db = postMove(bill.db, bill.id);

  const postedBill = read(db, 'account.move', bill.id);
  const apLines = counterpartLines(db, postedBill, 'liability_payable');
  assert.equal(apLines.length, 2);
  assert.deepEqual(
    apLines.map((l) => ({ credit: l.credit, debit: l.debit ?? 0, date_maturity: l.date_maturity, partner_id: l.partner_id })),
    [
      { credit: 300, debit: 0, date_maturity: '2026-01-01', partner_id: vendor.id },
      { credit: 700, debit: 0, date_maturity: '2026-03-02', partner_id: vendor.id },
    ],
  );
  assert.equal(postedBill.invoice_date_due, '2026-03-02');
  assert.equal(isBalanced(postedBill.line_ids), true);

  const beforeApRow = agedBalance(db, 'payable', '2026-02-15').rows.find((r) => r.partner_id === vendor.id);
  assert.equal(beforeApRow['31_60'], 300);
  assert.equal(beforeApRow.current, 700);
  assert.equal(agedTotal(db, 'payable', '2026-02-15'), bsTotalByType(db, '2026-02-15', 'liabilities', 'liability_payable'));

  db = payMove(db, bill.id, 400, '2026-02-10');
  const paidBill = read(db, 'account.move', bill.id);
  const apItems = reconciledJournalItems(db, paidBill).filter((l) => l.date_maturity);
  assert.deepEqual(
    apItems.map((l) => ({ date_maturity: l.date_maturity, amount_residual: l.amount_residual })),
    [
      { date_maturity: '2026-01-01', amount_residual: 0 },
      { date_maturity: '2026-03-02', amount_residual: -600 },
    ],
  );

  const afterApRow = agedBalance(db, 'payable', '2026-02-15').rows.find((r) => r.partner_id === vendor.id);
  assert.equal(afterApRow['31_60'], 0);
  assert.equal(afterApRow.current, 600);
  assert.equal(agedTotal(db, 'payable', '2026-02-15'), bsTotalByType(db, '2026-02-15', 'liabilities', 'liability_payable'));
});

test('PKG-07: credit note against multi-installment invoice settles earliest installment first', () => {
  let db = seed();
  const partner = makePartner(db, 'Credit Note Installment Client');
  db = partner.db;
  const term = makeTerm(db, 'CN 30/70', [
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 70, nb_days: 60, delay_type: 'days_after' },
  ]);
  db = term.db;
  const inv = makeInvoice(db, {
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    amount: 1000,
  });
  db = postMove(inv.db, inv.id);

  const cnDraft = creditNote(db, read(db, 'account.move', inv.id), { date: '2026-01-20', method: 'refund', reason: 'Partial allowance' });
  db = write(cnDraft.db, 'account.move', cnDraft.id, {
    invoice_line_ids: read(cnDraft.db, 'account.move', cnDraft.id).invoice_line_ids.map((l) => ({ ...l, price_unit: 400 })),
  });
  db = postMove(db, cnDraft.id);

  const updatedInv = read(db, 'account.move', inv.id);
  assert.equal(updatedInv.amount_residual, 600);
  const arItems = reconciledJournalItems(db, updatedInv).filter((l) => l.date_maturity);
  assert.deepEqual(
    arItems.map((l) => ({ date_maturity: l.date_maturity, amount_residual: l.amount_residual })),
    [
      { date_maturity: '2026-01-01', amount_residual: 0 },
      { date_maturity: '2026-03-02', amount_residual: 600 },
    ],
  );
  const agedRow = agedBalance(db, 'receivable', '2026-02-15').rows.find((r) => r.partner_id === partner.id);
  assert.equal(agedRow['31_60'], 0);
  assert.equal(agedRow.current, 600);
  assert.equal(agedTotal(db, 'receivable', '2026-02-15'), bsTotalByType(db, '2026-02-15', 'assets', 'asset_receivable'));
});

test('PKG-07: follow-up reminder uses the overdue installment only and clears once overdue installment is paid', () => {
  let db = seed();
  const partner = makePartner(db, 'Follow-Up Installment Client');
  db = partner.db;
  const term = makeTerm(db, 'FollowUp 30/70', [
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 70, nb_days: 60, delay_type: 'days_after' },
  ]);
  db = term.db;
  const inv = makeInvoice(db, {
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    amount: 1000,
  });
  db = postMove(inv.db, inv.id);

  const reminders = followUps(db, '2026-02-15');
  const row = reminders.find((r) => r.partner_id === partner.id);
  assert.ok(row);
  assert.equal(row.total, 300);
  assert.equal(row.oldest, '2026-01-01');
  assert.equal(row.invoices.length, 1);
  assert.equal(row.invoices[0].amount_residual, 300);

  db = payMove(db, inv.id, 300, '2026-02-10');
  const afterPay = followUps(db, '2026-02-15').find((r) => r.partner_id === partner.id);
  assert.equal(afterPay, undefined);
});

test('PKG-07: journal-item reconcile, unreconcile, and writeoff work on multi-installment invoices while manual split entries stay guarded', () => {
  let db = seed();
  const partner = makePartner(db, 'Journal Item Settlement Client');
  db = partner.db;
  const term = makeTerm(db, 'Split 30/70', [
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 70, nb_days: 60, delay_type: 'days_after' },
  ]);
  db = term.db;
  const inv = makeInvoice(db, {
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    amount: 1000,
  });
  db = postMove(inv.db, inv.id);

  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && j.default_for_payments) ?? search(db, 'account.journal').find((j) => j.type === 'bank');
  // Post payment dated before invoice_date so it stays an unapplied customer credit ready for manual journal-item matching.
  const payRes = create(db, 'account.payment', {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: 400,
    date: '2025-12-20',
    journal_id: bankJournal.id,
  });
  db = postPayment(payRes.db, read(payRes.db, 'account.payment', payRes.id));

  const invMove = read(db, 'account.move', inv.id);
  assert.equal(invMove.amount_residual, 1000);
  const invAr = counterpartLines(db, invMove, 'asset_receivable')[0];
  const payMoveRec = read(db, 'account.move', read(db, 'account.payment', payRes.id).move_id);
  const payCounterpart = payMoveRec.line_ids.find((l) => l.account_id === invAr.account_id && l.partner_id === partner.id);

  db = reconcileJournalItems(db, [
    { move_id: invMove.id, line_identity: journalItemIdentity(invAr) },
    { move_id: payMoveRec.id, line_identity: journalItemIdentity(payCounterpart) },
  ], { date: '2026-02-10' });
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 600);

  // Unreconcile via selecting the invoice's AR item.
  db = unreconcileJournalItems(db, [
    { move_id: invMove.id, line_identity: journalItemIdentity(invAr) },
  ], { date: '2026-02-12' });
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 1000);

  // Write off a partial amount via selecting an installment item on the invoice.
  const writeoffAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const miscJournal = search(db, 'account.journal').find((j) => j.type === 'general');
  db = writeoffJournalItem(db, [
    { move_id: invMove.id, line_identity: journalItemIdentity(invAr) },
  ], { date: '2026-02-12', amount: 100, journalId: bankJournal.id, accountId: writeoffAcc.id, label: 'Installment rounding' });
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 900);

  // Non-invoice manual entries with duplicate (account_id, partner_id) lines remain rejected.
  const arAccId = invAr.account_id;
  const revAcc = search(db, 'account.account').find((a) => a.account_type === 'income');
  const manual = postEntry(db, {
    journal: miscJournal.id,
    date: '2026-02-01',
    ref: 'Manual split',
    lines: [
      { account_id: arAccId, partner_id: partner.id, debit: 40 },
      { account_id: arAccId, partner_id: partner.id, debit: 60 },
      { account_id: revAcc.id, credit: 100 },
    ],
  });
  db = manual.db;
  const manualMove = read(db, 'account.move', manual.id);
  assert.throws(
    () => writeoffJournalItem(db, [
      { move_id: manualMove.id, line_identity: journalItemIdentity(manualMove.line_ids[0]) },
    ], { date: '2026-02-01', amount: 50, journalId: miscJournal.id, accountId: writeoffAcc.id }),
    /multiple counterpart items/,
  );
});
