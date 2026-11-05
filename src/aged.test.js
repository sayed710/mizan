import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from './orm.js';
import { seed } from './seed.js';
import { postMove, payMove } from './models/accounting.js';
import { agedBalance } from './models/finance.js';

test('invoice 100 on 2026-01-10, payment 60 on 2026-02-15; aged at 2026-02-01 shows 100, at 2026-03-01 shows 40', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Customer Aging Test' });
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-10',
    date: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  db = payMove(db, inv.id, 60, '2026-02-15');

  const agedFeb = agedBalance(db, 'receivable', '2026-02-01');
  const rowFeb = agedFeb.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowFeb, 'Customer row should exist at 2026-02-01');
  assert.equal(rowFeb.total, 100);
  assert.equal(rowFeb['1_30'], 100);

  const agedMar = agedBalance(db, 'receivable', '2026-03-01');
  const rowMar = agedMar.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowMar, 'Customer row should exist at 2026-03-01');
  assert.equal(rowMar.total, 40);
  assert.equal(rowMar['31_60'], 40);
});

test('a credit note after the cutoff does not reduce it', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Customer Credit Note Test' });
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-10',
    date: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const note = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: partner.id,
    reversed_entry_id: inv.id,
    invoice_date: '2026-02-15',
    date: '2026-02-15',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 40, tax: 0 }],
  });
  db = postMove(note.db, note.id);

  const agedFeb = agedBalance(db, 'receivable', '2026-02-01');
  const rowFeb = agedFeb.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowFeb, 'Customer row should exist at 2026-02-01');
  assert.equal(rowFeb.total, 100);
  assert.equal(rowFeb['1_30'], 100);

  const agedMar = agedBalance(db, 'receivable', '2026-03-01');
  const rowMar = agedMar.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowMar, 'Customer row should exist at 2026-03-01');
  assert.equal(rowMar.total, 60);
  assert.equal(rowMar['31_60'], 60);
});

test('a two-installment term ages each part by its own due date', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Customer Installments Test' });
  const term = create(partner.db, 'account.payment.term', {
    name: '50-50 Split',
    line_ids: [
      { value_type: 'percent', value: 50, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const agedJan10 = agedBalance(db, 'receivable', '2026-01-10');
  const rowJan10 = agedJan10.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowJan10);
  assert.equal(rowJan10.total, 100);
  assert.equal(rowJan10['1_30'], 50);
  assert.equal(rowJan10.current, 50);

  const agedFeb15 = agedBalance(db, 'receivable', '2026-02-15');
  const rowFeb15 = agedFeb15.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowFeb15);
  assert.equal(rowFeb15.total, 100);
  assert.equal(rowFeb15['31_60'], 50);
  assert.equal(rowFeb15['1_30'], 50);
  assert.equal(rowFeb15.current, 0);
});

test('a document dated after the cutoff is excluded', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Future Invoice Partner' });
  const inv = create(partner.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-02-10',
    date: '2026-02-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const agedFeb01 = agedBalance(db, 'receivable', '2026-02-01');
  const rowFeb01 = agedFeb01.rows.find((r) => r.partner_id === partner.id);
  assert.equal(rowFeb01, undefined, 'Document dated 2026-02-10 must be excluded at cutoff 2026-02-01');

  const agedFeb15 = agedBalance(db, 'receivable', '2026-02-15');
  const rowFeb15 = agedFeb15.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowFeb15, 'Document dated 2026-02-10 must be included at cutoff 2026-02-15');
  assert.equal(rowFeb15.total, 100);
});

test('payable side: bill 100 on 2026-01-10, payment 60 on 2026-02-15; aged at 2026-02-01 shows 100, at 2026-03-01 shows 40', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Vendor Aging Test' });
  const bill = create(partner.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2026-01-10',
    date: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);
  db = payMove(db, bill.id, 60, '2026-02-15');

  const agedFeb = agedBalance(db, 'payable', '2026-02-01');
  const rowFeb = agedFeb.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowFeb, 'Vendor row should exist at 2026-02-01');
  assert.equal(rowFeb.total, 100);
  assert.equal(rowFeb['1_30'], 100);

  const agedMar = agedBalance(db, 'payable', '2026-03-01');
  const rowMar = agedMar.rows.find((r) => r.partner_id === partner.id);
  assert.ok(rowMar, 'Vendor row should exist at 2026-03-01');
  assert.equal(rowMar.total, 40);
  assert.equal(rowMar['31_60'], 40);
});

test('payable side: credit note after cutoff, two installments by due date, document after cutoff excluded', () => {
  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'Vendor Full Scenarios' });

  // 1. Credit note after cutoff
  const bill1 = create(vendor.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-01-10',
    date: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: vendor.id,
    reversed_entry_id: bill1.id,
    invoice_date: '2026-02-15',
    date: '2026-02-15',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 40, tax: 0 }],
  });
  db = postMove(refund.db, refund.id);

  const agedFeb = agedBalance(db, 'payable', '2026-02-01');
  const rowFeb = agedFeb.rows.find((r) => r.partner_id === vendor.id);
  assert.ok(rowFeb);
  assert.equal(rowFeb.total, 100);

  const agedMar = agedBalance(db, 'payable', '2026-03-01');
  const rowMar = agedMar.rows.find((r) => r.partner_id === vendor.id);
  assert.ok(rowMar);
  assert.equal(rowMar.total, 60);

  // 2. Two installments on bill
  const term = create(db, 'account.payment.term', {
    name: 'Vendor Split Term',
    line_ids: [
      { value_type: 'percent', value: 50, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' },
    ],
  });
  db = term.db;
  const vendor2 = create(db, 'res.partner', { name: 'Vendor 2 Terms' });
  const bill2 = create(vendor2.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor2.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill2.db, bill2.id);

  const agedJan10 = agedBalance(db, 'payable', '2026-01-10');
  const rowJan10 = agedJan10.rows.find((r) => r.partner_id === vendor2.id);
  assert.ok(rowJan10);
  assert.equal(rowJan10.total, 100);
  assert.equal(rowJan10['1_30'], 50);
  assert.equal(rowJan10.current, 50);

  // 3. Document dated after cutoff is excluded
  const vendor3 = create(db, 'res.partner', { name: 'Vendor 3 Future' });
  const bill3 = create(vendor3.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor3.id,
    invoice_date: '2026-02-10',
    date: '2026-02-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill3.db, bill3.id);

  const agedExcl = agedBalance(db, 'payable', '2026-02-01');
  assert.equal(agedExcl.rows.find((r) => r.partner_id === vendor3.id), undefined);
});
