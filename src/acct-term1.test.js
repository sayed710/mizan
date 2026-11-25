import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installments, invoiceInstallments, termModels } from './models/terms.js';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { postMove } from './models/accounting.js';
import { addDays, today } from './models/common.js';

const line = (value, nb_days) => ({ value_type: 'percent', value, nb_days, delay_type: 'days_after' });

test('installments allocate rounding in computed due-date order', () => {
  const term = { line_ids: [line(50, 30), line(50, 0)] };
  assert.deepEqual(installments(term, 0.01, '2026-01-01'), [
    { date: '2026-01-01', amount: 0.01 }, { date: '2026-01-31', amount: 0 },
  ]);
});

test('installments already in date order retain their allocation', () => {
  assert.deepEqual(installments({ line_ids: [line(50, 0), line(50, 30)] }, 0.01, '2026-01-01'), [
    { date: '2026-01-01', amount: 0.01 }, { date: '2026-01-31', amount: 0 },
  ]);
});

test('installment dates option is available on the term and used by the invoice print', () => {
  const model = termModels['account.payment.term'];
  assert.equal(model.fields.display_on_invoice.type, 'boolean');
  assert.equal(model.fields.display_on_invoice.label, 'Show installment dates');
  assert.equal(model.fields.show_installment_dates, undefined);
  assert.ok(model.form.groups({}).some((group) => group.fields.includes('display_on_invoice')));
  const print = readFileSync(new URL('./views/PrintDoc.jsx', import.meta.url), 'utf8');
  assert.match(print, /term\?\.display_on_invoice/);
  assert.doesNotMatch(print, /show_installment_dates/);
  assert.match(print, /installments\(/);
  assert.match(print, /<table/);
});

test('a balance line keeps the remainder even when its due date is earlier', () => {
  const term = { line_ids: [line(30, 30), { value_type: 'balance', nb_days: 0 }] };
  assert.deepEqual(installments(term, 100, '2026-01-01'), [
    { date: '2026-01-01', amount: 70 }, { date: '2026-01-31', amount: 30 },
  ]);
});

test('posted invoice installment schedule is derived from posted lines even after term is edited', () => {
  const db0 = seed();
  const term = create(db0, 'account.payment.term', {
    name: '30% now, 70% in 30 days',
    display_on_invoice: true,
    line_ids: [
      { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 70, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  const inv = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-02-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 0 }],
  });
  const postedDb = postMove(inv.db, inv.id);
  const postedInv = read(postedDb, 'account.move', inv.id);

  // Initial posted schedule
  const initialSchedule = invoiceInstallments(postedDb, postedInv);
  assert.deepEqual(initialSchedule, [
    { date: '2026-02-01', amount: 300 },
    { date: '2026-03-03', amount: 700 },
  ]);

  // Edit the term after posting: change to 50% now, 50% in 10 days
  const editedDb = write(postedDb, 'account.payment.term', term.id, {
    line_ids: [
      { value_type: 'percent', value: 50, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 50, nb_days: 10, delay_type: 'days_after' },
    ],
  });

  // Posted invoice still returns the original posted schedule, not the edited term's schedule
  const preservedSchedule = invoiceInstallments(editedDb, postedInv);
  assert.deepEqual(preservedSchedule, [
    { date: '2026-02-01', amount: 300 },
    { date: '2026-03-03', amount: 700 },
  ]);

  // But for an unposted (draft) invoice, it calculates from the current edited term
  const draftInv = read(editedDb, 'account.move', inv.id);
  const draftCopy = { ...draftInv, state: 'draft', line_ids: [] };
  const draftSchedule = invoiceInstallments(editedDb, draftCopy);
  assert.deepEqual(draftSchedule, [
    { date: '2026-02-01', amount: 500 },
    { date: '2026-02-11', amount: 500 },
  ]);
});

test('invalid payment term schedule does not throw during invoice rendering', () => {
  const db0 = seed();
  // Term with fixed installment of 500 plus 100% remainder line (valid in Odoo, but exceeds a 100 invoice total)
  const term = create(db0, 'account.payment.term', {
    name: 'Fixed 500',
    display_on_invoice: true,
    line_ids: [
      { value_type: 'fixed', value: 500, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 100, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  // Draft invoice total is only 100 (fixed 500 exceeds 100)
  const inv = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const draftInv = read(inv.db, 'account.move', inv.id);

  // Calling installments directly throws
  assert.throws(() => installments(read(inv.db, 'account.payment.term', term.id), draftInv.amount_total, draftInv.invoice_date));

  // But invoiceInstallments returns null without throwing, allowing PrintDoc to render
  assert.equal(invoiceInstallments(inv.db, draftInv), null);

  // For a posted invoice where term was edited to become invalid for a 100 invoice, it still returns the recorded schedule
  const validTerm = create(db0, 'account.payment.term', {
    name: 'Valid term',
    display_on_invoice: true,
    line_ids: [line(100, 0)],
  });
  const inv2 = create(validTerm.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_payment_term_id: validTerm.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  let postedDb = postMove(inv2.db, inv2.id);
  // Edit the term to an invalid fixed amount exceeding the 100 invoice total
  postedDb = write(postedDb, 'account.payment.term', validTerm.id, {
    line_ids: [
      { value_type: 'fixed', value: 500, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 100, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  const postedInv2 = read(postedDb, 'account.move', inv2.id);
  assert.doesNotThrow(() => {
    const rows = invoiceInstallments(postedDb, postedInv2);
    assert.deepEqual(rows, [{ date: '2026-03-01', amount: 100 }]);
  });
});

test('fixed installment preserves configured amount when earlier percentage line is sorted first', () => {
  // 100% residual due at day 0, fixed 100 due at day 30, total 1000
  const term = {
    line_ids: [
      { value_type: 'percent', value: 100, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'fixed', value: 100, nb_days: 30, delay_type: 'days_after' },
    ],
  };
  const schedule = installments(term, 1000, '2026-01-01');
  assert.deepEqual(schedule, [
    { date: '2026-01-01', amount: 900 },
    { date: '2026-01-31', amount: 100 },
  ]);

  // Even if defined with fixed line first but later due date
  const termReverseDef = {
    line_ids: [
      { value_type: 'fixed', value: 100, nb_days: 30, delay_type: 'days_after' },
      { value_type: 'percent', value: 100, nb_days: 0, delay_type: 'days_after' },
    ],
  };
  assert.deepEqual(installments(termReverseDef, 1000, '2026-01-01'), [
    { date: '2026-01-01', amount: 900 },
    { date: '2026-01-31', amount: 100 },
  ]);

  // Pure fixed lines that do not sum to total are rejected
  const allFixed = {
    line_ids: [
      { value_type: 'fixed', value: 40, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'fixed', value: 60, nb_days: 30, delay_type: 'days_after' },
    ],
  };
  assert.deepEqual(installments(allFixed, 100, '2026-01-01'), [
    { date: '2026-01-01', amount: 40 },
    { date: '2026-01-31', amount: 60 },
  ]);
  assert.throws(() => installments(allFixed, 120, '2026-01-01'), /100%/);
});

test('draft invoices use today as base date fallback matching posting when invoice_date is missing', () => {
  const db0 = seed();
  const term = create(db0, 'account.payment.term', {
    name: 'Net 30',
    display_on_invoice: true,
    line_ids: [line(100, 30)],
  });

  // Draft invoice with an accounting date '2026-01-01' but no invoice_date
  const invWithDate = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    date: '2026-01-01',
    invoice_date: null,
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const draftWithDate = read(invWithDate.db, 'account.move', invWithDate.id);
  const expectedDate = addDays(today(), 30);
  const rowsWithDate = invoiceInstallments(invWithDate.db, draftWithDate);
  assert.deepEqual(rowsWithDate, [{ date: expectedDate, amount: 100 }]);

  // When posted, the recorded maturity date matches today's computation, not accounting date
  const postedDb = postMove(invWithDate.db, invWithDate.id);
  const postedInv = read(postedDb, 'account.move', invWithDate.id);
  const postedRows = invoiceInstallments(postedDb, postedInv);
  assert.deepEqual(postedRows, [{ date: expectedDate, amount: 100 }]);

  // Draft invoice with neither invoice_date nor accounting date
  const invNoDate = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    date: null,
    invoice_date: null,
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const draftNoDate = read(invNoDate.db, 'account.move', invNoDate.id);
  assert.doesNotThrow(() => {
    const rowsNoDate = invoiceInstallments(invNoDate.db, draftNoDate);
    assert.deepEqual(rowsNoDate, [{ date: expectedDate, amount: 100 }]);
  });
});
