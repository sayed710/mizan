import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';

// Helper to call onchange on account.move
const onchange = (r, key, db, context = {}) => models['account.move'].onchange(r, key, db, context);

// Helper: create and post a bill using postMove
const makePostedBill = (db, { move_type = 'in_invoice', partner_id, ref, invoice_line_ids }) => {
  const r = {
    move_type,
    partner_id,
    invoice_date: '2026-01-15',
    invoice_line_ids: invoice_line_ids ?? [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  };
  if (ref) r.ref = ref;
  const bill = create(db, 'account.move', r);
  const postedDb = postMove(bill.db, bill.id);
  return { db: postedDb, id: bill.id };
};

// ─── BILL-4: payment_reference auto-populated from ref ───────────────────────

test('BILL-4: postMove sets payment_reference from ref on vendor bill when payment_reference is blank', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    ref: 'INV-2026-001',
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  const posted = read(db, 'account.move', bill.id);
  assert.equal(posted.payment_reference, 'INV-2026-001', 'payment_reference should be set from ref on posting');
});

test('BILL-4: postMove does NOT overwrite existing payment_reference on vendor bill', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    ref: 'INV-2026-001',
    payment_reference: 'EXISTING-REF',
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  const posted = read(db, 'account.move', bill.id);
  assert.equal(posted.payment_reference, 'EXISTING-REF', 'existing payment_reference should be preserved');
});

test('BILL-4: postMove does not set payment_reference when ref is blank on vendor bill', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  const posted = read(db, 'account.move', bill.id);
  assert.ok(!posted.payment_reference?.trim(), 'payment_reference should remain blank when ref is blank');
});

test('BILL-4: onchange ref on vendor bill updates payment_reference when it is empty', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const r = { move_type: 'in_invoice', partner_id: vendor.id, ref: 'REF-456', payment_reference: '' };
  const result = onchange(r, 'ref', db);

  assert.ok('payment_reference' in result, 'onchange ref should return payment_reference');
  assert.equal(result.payment_reference, 'REF-456');
});

test('BILL-4: onchange ref on vendor bill updates payment_reference when it matches previous ref', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const r = { move_type: 'in_invoice', partner_id: vendor.id, ref: 'NEW-REF', payment_reference: 'OLD-REF' };
  const result = onchange(r, 'ref', db, { previous: { ref: 'OLD-REF', payment_reference: 'OLD-REF' } });

  assert.ok('payment_reference' in result, 'onchange ref should return payment_reference');
  assert.equal(result.payment_reference, 'NEW-REF');
});

test('BILL-4: onchange ref on vendor bill does not overwrite a manually set payment_reference', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const r = { move_type: 'in_invoice', partner_id: vendor.id, ref: 'NEW-REF', payment_reference: 'MANUAL-REF' };
  const result = onchange(r, 'ref', db, { previous: { ref: 'OLD-REF', payment_reference: 'MANUAL-REF' } });

  // payment_reference != previous ref, so should not auto-update
  assert.ok(!('payment_reference' in result) || result.payment_reference === 'MANUAL-REF', 'manual payment_reference should not be overwritten');
});

test('BILL-4: onchange ref on customer invoice does not set payment_reference', () => {
  let db = seed();

  const r = { move_type: 'out_invoice', ref: 'CUSTOMER-REF', payment_reference: '' };
  const result = onchange(r, 'ref', db);

  assert.ok(!('payment_reference' in result), 'onchange ref on customer invoice should not set payment_reference');
});

// ─── BILL-6: partner_bank_id defaulting & domain ─────────────────────────────

test('BILL-6: onchange partner_id on vendor bill defaults partner_bank_id from vendor bank accounts', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  // Add a bank account for the vendor
  const bank = create(db, 'res.partner.bank', {
    partner_id: vendor.id,
    account_number: 'EG123456789',
    allow_out_payment: true,
    active: true,
  });
  db = bank.db;

  const r = { move_type: 'in_invoice', partner_id: vendor.id };
  const result = onchange(r, 'partner_id', db);

  assert.ok('partner_bank_id' in result, 'onchange partner_id should return partner_bank_id for vendor bill');
  assert.equal(result.partner_bank_id, bank.id, 'should default to the vendor primary bank account');
});

test('BILL-6: onchange partner_id on vendor bill falls back to an untrusted bank', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  // Add a bank account with allow_out_payment: false
  const bank = create(db, 'res.partner.bank', {
    partner_id: vendor.id,
    account_number: 'EG-NO-OUT',
    allow_out_payment: false,
    active: true,
  });
  db = bank.db;

  const r = { move_type: 'in_invoice', partner_id: vendor.id };
  const result = onchange(r, 'partner_id', db);

  assert.ok('partner_bank_id' in result, 'partner_bank_id should be returned');
  assert.equal(result.partner_bank_id, bank.id, 'an untrusted bank remains available as Odoo fallback');
});

test('BILL-6: onchange partner_id on customer invoice does not set partner_bank_id', () => {
  let db = seed();
  const customer = search(db, 'res.partner')[0];

  // No bank account needed; just ensure no partner_bank_id is set for out_invoice
  const r = { move_type: 'out_invoice', partner_id: customer.id };
  const result = onchange(r, 'partner_id', db);

  assert.ok(!('partner_bank_id' in result), 'onchange partner_id on customer invoice should not set partner_bank_id');
});

test('BILL-6: partner_bank_id field has domain filtering for purchase bills', () => {
  const field = models['account.move'].fields.partner_bank_id;
  assert.ok(field.domain, 'partner_bank_id field should have a domain');
  assert.equal(typeof field.domain, 'function', 'domain should be a function');

  // A bank with correct partner and allow_out_payment on a purchase bill
  const r = { move_type: 'in_invoice', partner_id: 2, company_id: 1 };
  const eligibleBank = { id: 1, partner_id: 2, company_id: null, allow_out_payment: true, active: true };
  assert.ok(field.domain(eligibleBank, r, null), 'eligible bank passes domain');

  // A bank that does not allow out payment on a purchase bill
  const noOutBank = { id: 2, partner_id: 2, company_id: null, allow_out_payment: false, active: true };
  assert.ok(field.domain(noOutBank, r, null), 'untrusted bank is selectable, with payment trust checked at payment');

  // A bank belonging to a different partner fails domain
  const wrongPartnerBank = { id: 3, partner_id: 99, company_id: null, allow_out_payment: true };
  assert.ok(!field.domain(wrongPartnerBank, r, null), 'bank with wrong partner_id fails domain');
});

// ─── BILL-10: Duplicate bill warning commercial partner hierarchy & in_refund ─

test('BILL-10: duplicate bill warning fires for in_refund with same ref', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  // Create and post a vendor refund
  const { db: postedDb } = makePostedBill(db, { move_type: 'in_refund', partner_id: vendor.id, ref: 'REF-DUP' });
  db = postedDb;

  // New draft vendor refund with same ref - warning function takes a plain object
  const refund2 = { move_type: 'in_refund', partner_id: vendor.id, ref: 'REF-DUP' };
  const warning = models['account.move'].form.warning(refund2, db);
  assert.ok(warning && warning.includes('Duplicate bill warning'), `Expected duplicate warning, got: "${warning}"`);
});

test('BILL-10: duplicate bill warning does NOT fire for in_refund when refs differ', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const { db: postedDb } = makePostedBill(db, { move_type: 'in_refund', partner_id: vendor.id, ref: 'REF-A' });
  db = postedDb;

  const refund2 = { move_type: 'in_refund', partner_id: vendor.id, ref: 'REF-B' };
  const warning = models['account.move'].form.warning(refund2, db);
  assert.ok(!warning, `No warning expected for different refs, got: "${warning}"`);
});

test('BILL-10: duplicate bill warning fires for subsidiary commercial partner', () => {
  let db = seed();

  // Create parent company partner
  const parent = create(db, 'res.partner', { name: 'Parent Corp', is_company: true });
  db = parent.db;

  // Create subsidiary (child) partner
  const child = create(db, 'res.partner', { name: 'Child Corp', is_company: true, parent_id: parent.id });
  db = child.db;

  // Post a vendor bill for the parent with ref
  const { db: postedDb } = makePostedBill(db, { move_type: 'in_invoice', partner_id: parent.id, ref: 'REF-CORP-001' });
  db = postedDb;

  // New bill for the child with the same ref should warn (commercial partner hierarchy)
  const newBill = { move_type: 'in_invoice', partner_id: child.id, ref: 'REF-CORP-001' };
  const warning = models['account.move'].form.warning(newBill, db);
  assert.ok(warning && warning.includes('Duplicate bill warning'), `Expected duplicate warning for subsidiary, got: "${warning}"`);
});

test('BILL-10: duplicate bill warning fires for in_invoice (original behavior preserved)', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const { db: postedDb } = makePostedBill(db, { move_type: 'in_invoice', partner_id: vendor.id, ref: 'INV-123' });
  db = postedDb;

  const bill2 = { move_type: 'in_invoice', partner_id: vendor.id, ref: 'INV-123' };
  const warning = models['account.move'].form.warning(bill2, db);
  assert.ok(warning && warning.includes('Duplicate bill warning'), `Expected duplicate warning, got: "${warning}"`);
});

// ─── BILL-12: Refund action label on in_invoice ───────────────────────────────

test('BILL-12: Credit Note button label is "Refund" for vendor bill (in_invoice)', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const { db: postedDb, id } = makePostedBill(db, { move_type: 'in_invoice', partner_id: vendor.id });
  db = postedDb;
  const r = read(db, 'account.move', id);

  const btn = models['account.move'].form.buttons.find((b) =>
    typeof b.label === 'function' ? b.label(r) === 'Refund' : b.label === 'Refund'
  );
  assert.ok(btn, 'A "Refund" button should exist for vendor bill');

  // The wizard title should also be 'Refund'
  const wizard = btn.wizard(db, r);
  assert.equal(wizard.title, 'Refund', 'wizard title should be "Refund" for vendor bill');
});

test('BILL-12: Credit Note button label is "Credit Note" for customer invoice (out_invoice)', () => {
  let db = seed();
  const customer = search(db, 'res.partner')[0];

  const { db: postedDb, id } = makePostedBill(db, { move_type: 'out_invoice', partner_id: customer.id });
  db = postedDb;
  const r = read(db, 'account.move', id);

  const btn = models['account.move'].form.buttons.find((b) =>
    typeof b.label === 'function' ? b.label(r) === 'Credit Note' : b.label === 'Credit Note'
  );
  assert.ok(btn, 'A "Credit Note" button should exist for customer invoice');

  const wizard = btn.wizard(db, r);
  assert.equal(wizard.title, 'Credit Note', 'wizard title should be "Credit Note" for customer invoice');
});

test('BILL-12: Refund button is visible for posted vendor bill', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];

  const { db: postedDb, id } = makePostedBill(db, { move_type: 'in_invoice', partner_id: vendor.id });
  db = postedDb;
  const r = read(db, 'account.move', id);

  // Find button whose label (possibly function) is 'Refund' and has a when condition
  const btn = models['account.move'].form.buttons.find((b) => {
    const label = typeof b.label === 'function' ? b.label(r) : b.label;
    return label === 'Refund' && b.when;
  });
  assert.ok(btn, 'Refund button should exist for posted vendor bill');
  assert.ok(btn.when(r), 'Refund button should be visible for posted vendor bill');
});



test('vendor bank selection prefers trusted commercial-family accounts', () => {
  let db = seed();
  const parent = create(db, 'res.partner', { name: 'Commercial vendor', is_company: true });
  const child = create(parent.db, 'res.partner', { name: 'Vendor contact', parent_id: parent.id });
  const untrusted = create(child.db, 'res.partner.bank', { partner_id: parent.id, account_number: 'UNTRUSTED', allow_out_payment: false });
  const trusted = create(untrusted.db, 'res.partner.bank', { partner_id: parent.id, account_number: 'TRUSTED', allow_out_payment: true });
  db = trusted.db;
  const bill = { move_type: 'in_invoice', partner_id: child.id, company_id: 1 };
  assert.equal(onchange(bill, 'partner_id', db).partner_bank_id, trusted.id);
  assert.equal(onchange({ ...bill, partner_bank_id: untrusted.id }, 'partner_id', db).partner_bank_id, trusted.id);
  assert.equal(models['account.move'].fields.partner_bank_id.domain(read(db, 'res.partner.bank', trusted.id), bill, db), true);
});
