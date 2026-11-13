import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { journalItems } from './models/ledger.js';
import { discountAvailable, payMove, payWithDiscount, postMove, residual } from './models/accounting.js';
import { postPayment, reconcileJournalItems } from './models/pay.js';
import { followUps, journalCards, partnerFollowUp, runFollowUps, taxReport } from './models/finance.js';
import { discountTaxComputation } from './models/terms.js';
import { taxSnapshot } from './models/taxes.js';

const periodFor = (date) => {
  const year = date.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
};

test('early discount helper, term defaults/guard, seeded 2/7 Net 30 and legacy unset term tax reduction', () => {
  let db = seed();

  // Seeded "2/7 Net 30" explicitly configures 'included'.
  const seededTerm = search(db, 'account.payment.term').find((t) => t.name === '2/7 Net 30');
  assert.equal(seededTerm?.discount_tax_computation, 'included');

  // Creating an early-discount term defaults discount_tax_computation to 'included'; onchange also defaults when toggled on.
  const created = create(db, 'account.payment.term', { name: '2/10 Net 30', early_discount: true, discount_percent: 2, discount_days: 10 });
  assert.equal(read(created.db, 'account.payment.term', created.id).discount_tax_computation, 'included');
  const toggled = models['account.payment.term'].onchange({ early_discount: true, discount_tax_computation: null }, 'early_discount');
  assert.equal(toggled.discount_tax_computation, 'included');

  // Guard rejects an early-discount term saved with an empty or invalid discount_tax_computation.
  assert.throws(
    () => create(db, 'account.payment.term', { name: 'Bad Early Term', early_discount: true, discount_percent: 2, discount_days: 7, discount_tax_computation: '' }),
    /discount tax computation/i,
  );
  assert.throws(
    () => write(created.db, 'account.payment.term', created.id, { discount_tax_computation: null }),
    /discount tax computation/i,
  );

  // Stored legacy term lacking discount_tax_computation resolves consistently to 'included' across all readers.
  const storedTerm = create(db, 'account.payment.term', {
    name: 'Legacy 2/7', early_discount: true, discount_percent: 2, discount_days: 7,
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });
  db = {
    ...storedTerm.db,
    records: {
      ...storedTerm.db.records,
      'account.payment.term': storedTerm.db.records['account.payment.term'].map((t) => (
        t.id === storedTerm.id ? { ...t, discount_tax_computation: undefined } : t
      )),
    },
  };
  assert.equal(discountTaxComputation(read(db, 'account.payment.term', storedTerm.id)), 'included');

  const invDate = '2026-06-01';
  const vatTax = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.amount === 14);
  assert.ok(vatTax);
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: invDate,
    invoice_payment_term_id: storedTerm.id,
    invoice_line_ids: [{ name: 'Desk', price_unit: 100, qty: 1, ...taxSnapshot(vatTax) }],
  });
  db = postMove(inv.db, inv.id);
  const postedInv = read(db, 'account.move', inv.id);
  assert.equal(postedInv.amount_total, 114);
  assert.equal(discountAvailable(db, postedInv, '2026-06-05'), 2.28);

  const beforeOutputVat = taxReport(db, periodFor(invDate)).output;
  db = payWithDiscount(db, inv.id, 111.72, '2026-06-05');
  assert.equal(residual(read(db, 'account.move', inv.id), db), 0);

  const discountMove = search(db, 'account.move').find((m) => m.ref === `Early payment discount ${postedInv.name}`);
  assert.ok(discountMove);
  const company = read(db, 'res.company', postedInv.company_id ?? 1);
  const discountExpenseLines = discountMove.line_ids.filter((l) => l.account_id === company.expense_early_payment_discount_account_id);
  const vatReductionLines = discountMove.line_ids.filter((l) => l.tax_id === vatTax.id);
  assert.equal(discountExpenseLines.reduce((s, l) => s + l.debit - l.credit, 0), 2);
  assert.equal(vatReductionLines.reduce((s, l) => s + l.debit - l.credit, 0), 0.28);
  assert.equal(taxReport(db, periodFor(invDate)).output, Number((beforeOutputVat - 0.28).toFixed(2)));
});

test('postMove sets invoice_date_due from invoice_payment_term_id when created without form onchange', () => {
  let db = seed();
  const term = search(db, 'account.payment.term').find((t) => t.name === '30 Days');
  assert.ok(term);
  const oldDate = addDays(today(), -45);
  const expectedDue = addDays(oldDate, 30);

  // Invoice and vendor bill created without running form onchange keep stale default due date until posted.
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: oldDate,
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ name: 'Chair', price_unit: 500, qty: 1 }],
  });
  const bill = create(inv.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: oldDate,
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ name: 'Wood', price_unit: 250, qty: 1 }],
  });
  db = postMove(postMove(bill.db, inv.id), bill.id);

  const postedInv = read(db, 'account.move', inv.id);
  const postedBill = read(db, 'account.move', bill.id);
  assert.equal(postedInv.invoice_date_due, expectedDue);
  assert.equal(postedBill.invoice_date_due, expectedDue);

  const overdueFilter = models['account.move'].filters.flat().find((f) => f.id === 'overdue');
  assert.equal(overdueFilter.fn(postedInv), true);
  assert.equal(overdueFilter.fn(postedBill), true);
  const cards = journalCards(db);
  const saleCard = cards.find((c) => c.journal.id === postedInv.journal_id);
  const purchaseCard = cards.find((c) => c.journal.id === postedBill.journal_id);
  assert.ok(saleCard.late >= 1);
  assert.ok(purchaseCard.late >= 1);

  // Without a payment term, postMove preserves the explicit due date.
  const manualDue = addDays(today(), 12);
  const noTermInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: oldDate,
    invoice_date_due: manualDue,
    invoice_line_ids: [{ name: 'Desk', price_unit: 100, qty: 1 }],
  });
  const afterNoTerm = postMove(noTermInv.db, noTermInv.id);
  assert.equal(read(afterNoTerm, 'account.move', noTermInv.id).invoice_date_due, manualDue);
});

test('runFollowUps resets follow-up level to Level 1 after prior overdue balance was cleared between runs', () => {
  let db = seed();
  // Create partner with no prior open invoices to isolate the installment timeline cleanly.
  const partner = create(db, 'res.partner', { name: 'Installment Reset Customer', email: 'reset@example.com' });
  db = partner.db;
  const term = create(db, 'account.payment.term', {
    name: 'Split 300/700',
    line_ids: [
      { value: 30, value_type: 'percent', nb_days: 0, delay_type: 'days_after' },
      { value: 70, value_type: 'percent', nb_days: 30, delay_type: 'days_after' },
    ],
  });
  db = term.db;
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ name: 'Equipment', price_unit: 1000, qty: 1 }],
  });
  db = postMove(inv.db, inv.id);

  const sent = [];
  const deliver = (msg) => sent.push(msg);

  // Level 1 (delay 15) fires on 2026-01-16 for the 300 installment due 2026-01-01.
  db = runFollowUps(db, '2026-01-16', deliver);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'First reminder');
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_level_delay, 15);

  // Customer pays 300 on 2026-01-18, clearing all overdue balance before 700 becomes due on 2026-01-31.
  db = payMove(db, inv.id, 300, '2026-01-18');

  // On 2026-02-15 (15 days after 2026-01-31), runFollowUps resets prior progress and sends Level 1 again for 700.
  db = runFollowUps(db, '2026-02-15', deliver);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subject, 'First reminder');
  assert.match(sent[1].text, /700\.00/);
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_date, '2026-02-15');
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_level_delay, 15);
});

test('runFollowUps does not reset the follow-up level when a second overdue invoice is added while the first stays unpaid', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Unpaid Multi-Invoice Customer', email: 'multi@example.com' });
  db = partner.db;
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-01',
    invoice_line_ids: [{ name: 'First Order', price_unit: 500, qty: 1 }],
  });
  db = postMove(inv1.db, inv1.id);

  const sent = [];
  const deliver = (msg) => sent.push(msg);

  // Level 1 (delay 15) fires on 2026-01-16 for inv1 due 2026-01-01.
  db = runFollowUps(db, '2026-01-16', deliver);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'First reminder');
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_level_delay, 15);
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_oldest_date, '2026-01-01');

  // A second overdue invoice due 2026-01-20 is posted while inv1 stays unpaid.
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-10',
    invoice_date_due: '2026-01-20',
    invoice_line_ids: [{ name: 'Second Order', price_unit: 400, qty: 1 }],
  });
  db = postMove(inv2.db, inv2.id);

  // At 2026-01-25 (only 24 days after 2026-01-01), level must NOT reset to Level 1.
  db = runFollowUps(db, '2026-01-25', deliver);
  assert.equal(sent.length, 1);
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_level_delay, 15);

  // At 2026-01-31 (30 days after 2026-01-01), it escalates directly to Level 2.
  db = runFollowUps(db, '2026-01-31', deliver);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subject, 'Second reminder');
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_level_delay, 30);
});

test('followUps nets standalone credit notes and open receivable credits, counting only overdue debits', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Credit Followup Customer', email: 'cf@example.com' });
  db = partner.db;

  const overdueInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-10',
    invoice_line_ids: [{ name: 'Overdue Goods', price_unit: 1000, qty: 1 }],
  });
  const futureInv = create(overdueInv.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-20',
    invoice_date_due: '2026-03-01',
    invoice_line_ids: [{ name: 'Future Goods', price_unit: 500, qty: 1 }],
  });
  // Standalone credit note whose own due date is still in the future still reduces total due immediately.
  const creditNote = create(futureInv.db, 'account.move', {
    move_type: 'out_refund',
    partner_id: partner.id,
    invoice_date: '2026-01-25',
    invoice_date_due: '2026-03-01',
    invoice_line_ids: [{ name: 'Return Credit', price_unit: 200, qty: 1 }],
  });
  db = postMove(postMove(postMove(creditNote.db, overdueInv.id), futureInv.id), creditNote.id);

  let row = followUps(db, '2026-02-01').find((f) => f.partner_id === partner.id);
  assert.ok(row);
  assert.equal(row.total, 800);
  assert.equal(row.oldest, '2026-01-10');

  // An unapplied inbound customer payment on the receivable account reduces the follow-up balance via ageUnappliedCredits.
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  assert.ok(bankJournal);
  const advance = create(db, 'account.payment', {
    partner_type: 'customer',
    payment_type: 'inbound',
    partner_id: partner.id,
    journal_id: bankJournal.id,
    date: '2025-12-20',
    amount: 300,
  });
  db = postPayment(advance.db, read(advance.db, 'account.payment', advance.id));
  row = followUps(db, '2026-02-01').find((f) => f.partner_id === partner.id);
  assert.equal(row?.total, 500);

  // If another standalone credit note offsets the remaining 500+, the partner is no longer overdue.
  const largeRefund = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: partner.id,
    invoice_date: '2026-01-28',
    invoice_line_ids: [{ name: 'Full Allowance', price_unit: 600, qty: 1 }],
  });
  db = postMove(largeRefund.db, largeRefund.id);
  assert.equal(followUps(db, '2026-02-01').find((f) => f.partner_id === partner.id), undefined);
});

test('reconcileJournalItems and outstandingCredits apply standalone credit notes (full, partial, guards)', () => {
  let db = seed();
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-05',
    invoice_line_ids: [{ name: 'Desk', price_unit: 1000, qty: 1 }],
  });
  const note = create(inv.db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Standalone Credit', price_unit: 400, qty: 1 }],
  });
  const otherPartnerNote = create(note.db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 3,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Other Customer Credit', price_unit: 150, qty: 1 }],
  });
  db = postMove(postMove(postMove(otherPartnerNote.db, inv.id), note.id), otherPartnerNote.id);

  const invPosted = read(db, 'account.move', inv.id);
  const notePosted = read(db, 'account.move', note.id);
  assert.equal(notePosted.reversed_entry_id ?? null, null);

  // Widget lists the standalone credit note on the invoice form.
  const widget = models['account.move'].form.outstandingCredits;
  const widgetRows = widget.list(db, invPosted);
  const noteWidgetRow = widgetRows.find((r) => r.move_id === note.id);
  assert.ok(noteWidgetRow);
  assert.equal(noteWidgetRow.unapplied, 400);
  assert.equal(widgetRows.some((r) => r.move_id === otherPartnerNote.id), false);

  // Applying via the widget settles in full (up to credit note balance).
  const viaWidgetDb = widget.apply(db, invPosted, noteWidgetRow.id).db;
  assert.equal(residual(read(viaWidgetDb, 'account.move', inv.id), viaWidgetDb), 600);
  assert.equal(residual(read(viaWidgetDb, 'account.move', note.id), viaWidgetDb), 0);

  // Reconcile Journal Items supports partial reconciliation without any payment record.
  const arAccountId = invPosted.line_ids.find((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable').account_id;
  const items = journalItems(db);
  const findCounterpart = (moveId) => items.find((i) => i.move_id === moveId && i.account_id === arAccountId);
  const invItem = findCounterpart(inv.id);
  const noteItem = findCounterpart(note.id);
  const wrongPartnerItem = findCounterpart(otherPartnerNote.id);
  assert.ok(invItem && noteItem && wrongPartnerItem);

  const selectionFor = (item) => ({ move_id: item.move_id, line_identity: item.line_identity });

  assert.throws(
    () => reconcileJournalItems(db, [selectionFor(invItem), selectionFor(wrongPartnerItem)], { date: '2026-01-15' }),
    /same account and partner/i,
  );

  db = reconcileJournalItems(db, [selectionFor(invItem), selectionFor(noteItem)], { date: '2026-01-15', amount: 150 });
  assert.equal(residual(read(db, 'account.move', inv.id), db), 850);
  assert.equal(residual(read(db, 'account.move', note.id), db), 250);

  // Remaining credit balance can then be applied completely.
  db = reconcileJournalItems(db, [selectionFor(invItem), selectionFor(noteItem)], { date: '2026-01-16' });
  assert.equal(residual(read(db, 'account.move', inv.id), db), 600);
  assert.equal(residual(read(db, 'account.move', note.id), db), 0);
});
