import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';

test('BILL-8: Assets smart button computes correct count, visibility, and target on vendor bills', () => {
  const smart = models['account.move'].form.smart;
  const assetsBtn = smart.find((s) => s.label === 'Assets');
  assert.ok(assetsBtn, 'Assets smart button must be registered on account.move');

  let db = seed();
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ name: 'Desk', qty: 1, price_unit: 1000, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);
  const billRec = read(db, 'account.move', bill.id);

  // Initially, no assets linked -> button should be hidden (when === false)
  assert.equal(assetsBtn.when(billRec, db), false, 'Assets button hidden when bill has no assets');
  assert.equal(assetsBtn.value(db, billRec), 0, 'Assets count is 0 when no assets');

  // Create an asset linked to this posted bill
  const asset1 = create(db, 'account.asset', {
    name: 'Office Desk',
    bill_id: bill.id,
    original_value: 1000,
    state: 'draft',
    company_id: 1,
  });
  db = asset1.db;

  assert.equal(assetsBtn.when(billRec, db), true, 'Assets button visible when bill has linked asset');
  assert.equal(assetsBtn.value(db, billRec), 1, 'Assets count is 1 when 1 asset is linked');
  assert.equal(assetsBtn.target(billRec, db), `accounting/assets/${asset1.id}`, 'Single asset links directly to asset form');

  // Create a second asset linked to this bill
  const asset2 = create(db, 'account.asset', {
    name: 'Desk Chair',
    bill_id: bill.id,
    original_value: 300,
    state: 'open',
    company_id: 1,
  });
  db = asset2.db;

  assert.equal(assetsBtn.value(db, billRec), 2, 'Assets count is 2 when 2 assets are linked');
  assert.equal(assetsBtn.target(billRec, db), `accounting/assets?view=list&rel=bill_id:${bill.id}`, 'Multiple assets link to asset list filtered by bill');

  // Customer invoice should NOT show Assets button
  const customerInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 500, tax: 0 }],
  });
  db = postMove(customerInv.db, customerInv.id);
  const invRec = read(db, 'account.move', customerInv.id);
  assert.equal(assetsBtn.when(invRec, db), false, 'Assets button hidden on customer invoices');

  // Vendor refund linking to the bill should also see the assets
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    reversed_entry_id: bill.id,
    invoice_date: '2026-04-05',
    invoice_line_ids: [{ name: 'Desk Return', qty: 1, price_unit: 1000, tax: 0 }],
  });
  db = refund.db;
  const refundRec = read(db, 'account.move', refund.id);
  assert.equal(assetsBtn.when(refundRec, db), true, 'Assets button visible on vendor refund linking to bill');
  assert.equal(assetsBtn.value(db, refundRec), 2, 'Assets count on refund matches original bill assets');
});

test('BILL-8: Deferrals / Deferred Expenses smart button is visible on vendor bills with deferred expenses', () => {
  const smart = models['account.move'].form.smart;
  const deferralBtn = smart.find((s) => {
    const l = typeof s.label === 'function' ? s.label({ move_type: 'in_invoice' }) : s.label;
    return l === 'Deferred Expenses' || l === 'Deferrals';
  });
  assert.ok(deferralBtn, 'Deferral smart button must exist on account.move');

  let db = seed();
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ name: 'Annual Software License', qty: 1, price_unit: 1200, tax: 0 }],
  });
  db = bill.db;
  const billRec = read(db, 'account.move', bill.id);

  // Hidden when no deferrals exist
  assert.equal(deferralBtn.when(billRec, db), false, 'Deferral button hidden when no deferrals exist');

  // Label is Deferred Expenses on vendor bill
  const billLabel = typeof deferralBtn.label === 'function' ? deferralBtn.label(billRec) : deferralBtn.label;
  assert.equal(billLabel, 'Deferred Expenses', 'Label on vendor bill is Deferred Expenses');

  // On entry, label is Deferrals
  const entryRec = { move_type: 'entry', id: 999 };
  const entryLabel = typeof deferralBtn.label === 'function' ? deferralBtn.label(entryRec) : deferralBtn.label;
  assert.equal(entryLabel, 'Deferrals', 'Label on journal entry is Deferrals');

  // Create a deferral schedule referencing this bill
  const def1 = create(db, 'account.deferral', {
    name: 'License Deferral 1',
    kind: 'expense',
    source_move_id: bill.id,
    amount: 1200,
    months: 12,
    start_date: '2026-04-01',
    company_id: 1,
  });
  db = def1.db;

  assert.equal(deferralBtn.when(billRec, db), true, 'Deferrals button visible on vendor bill when deferral exists');
  assert.equal(deferralBtn.value(db, billRec), 1, 'Deferrals count is 1 on vendor bill');
  assert.equal(deferralBtn.target(billRec, db), `accounting/deferred-expenses/${def1.id}`, 'Single deferral navigates to deferred-expenses form');

  // Create a second deferral schedule referencing this bill
  const def2 = create(db, 'account.deferral', {
    name: 'License Deferral 2',
    kind: 'expense',
    source_move_id: bill.id,
    amount: 600,
    months: 6,
    start_date: '2026-05-01',
    company_id: 1,
  });
  db = def2.db;

  assert.equal(deferralBtn.value(db, billRec), 2, 'Deferrals count is 2 when 2 schedules exist');
  assert.equal(deferralBtn.target(billRec, db), `accounting/deferred-expenses?view=list&rel=move_id:${bill.id}`, 'Multiple deferrals navigate to deferred-expenses list');

  // On journal entry, target is accounting/deferrals
  const entryMove = create(db, 'account.move', { move_type: 'entry', date: '2026-04-01' });
  db = entryMove.db;
  const defEntry = create(db, 'account.deferral', {
    name: 'Entry Deferral',
    kind: 'expense',
    source_move_id: entryMove.id,
    amount: 500,
    months: 6,
    start_date: '2026-04-01',
    company_id: 1,
  });
  db = defEntry.db;
  const entryMoveRec = read(db, 'account.move', entryMove.id);
  assert.equal(deferralBtn.when(entryMoveRec, db), true, 'Deferrals button visible on journal entry with deferral');
  assert.equal(deferralBtn.target(entryMoveRec, db), `accounting/deferrals/${defEntry.id}`, 'Entry navigates to accounting/deferrals');
});

test('BILL-8: Purchase Orders smart button computes count, visibility, and target on vendor bills', () => {
  const smart = models['account.move'].form.smart;
  const poBtn = smart.find((s) => s.label === 'Purchase Orders');
  assert.ok(poBtn, 'Purchase Orders smart button must be registered on account.move');

  let db = seed();
  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product')[0];

  // Create two purchase orders
  const po1Key = 'po-line-key-1';
  const po1 = create(db, 'purchase.order', {
    partner_id: vendor.id,
    state: 'purchase',
    name: 'P00091',
    order_line: [{ id: 501, product_id: prod.id, qty: 5, price_unit: 50, purchase_line_key: po1Key }],
  });
  db = po1.db;

  const po2Key = 'po-line-key-2';
  const po2 = create(db, 'purchase.order', {
    partner_id: vendor.id,
    state: 'purchase',
    name: 'P00092',
    order_line: [{ id: 502, product_id: prod.id, qty: 3, price_unit: 60, purchase_line_key: po2Key }],
  });
  db = po2.db;

  // Bill 1: Unlinked bill -> button hidden
  const unlinkedBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ name: 'Miscellaneous', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = unlinkedBill.db;
  const unlinkedRec = read(db, 'account.move', unlinkedBill.id);
  assert.equal(poBtn.when(unlinkedRec, db), false, 'Purchase Orders button hidden on unlinked bill');
  assert.equal(poBtn.value(db, unlinkedRec), 0, 'PO count is 0 on unlinked bill');

  // Bill 2: Linked via purchase_id
  const billWithPo = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: po1.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ name: 'Product from PO1', qty: 5, price_unit: 50, tax: 0 }],
  });
  db = billWithPo.db;
  const billWithPoRec = read(db, 'account.move', billWithPo.id);
  assert.equal(poBtn.when(billWithPoRec, db), true, 'Purchase Orders button visible when purchase_id set');
  assert.equal(poBtn.value(db, billWithPoRec), 1, 'PO count is 1 when single PO linked');
  assert.equal(poBtn.target(billWithPoRec, db), `purchase/po/${po1.id}`, 'Navigates to purchase/po for confirmed order');

  // Bill 3: Linked via line IDs without move header purchase_id
  const billWithLinePo = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ name: 'Line from PO1', qty: 2, price_unit: 50, purchase_line_id: 501, tax: 0 }],
  });
  db = billWithLinePo.db;
  const billWithLinePoRec = read(db, 'account.move', billWithLinePo.id);
  assert.equal(poBtn.when(billWithLinePoRec, db), true, 'Purchase Orders button visible when line linked via ID');
  assert.equal(poBtn.value(db, billWithLinePoRec), 1, 'PO count is 1 from line link');

  // Bill 4: Linked to multiple POs across lines
  const billMultiPo = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [
      { name: 'Line from PO1', qty: 2, price_unit: 50, purchase_line_id: 501, tax: 0 },
      { name: 'Line from PO2', qty: 1, price_unit: 60, purchase_line_id: 502, tax: 0 },
    ],
  });
  db = billMultiPo.db;
  const billMultiPoRec = read(db, 'account.move', billMultiPo.id);
  assert.equal(poBtn.when(billMultiPoRec, db), true, 'Purchase Orders button visible on multi-PO bill');
  assert.equal(poBtn.value(db, billMultiPoRec), 2, 'PO count is 2 for multi-PO bill');
  assert.equal(poBtn.target(billMultiPoRec, db), 'purchase/rfq?view=list', 'Multi-PO links to purchase orders list');

  // Customer invoice should NOT show Purchase Orders button
  const custInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: vendor.id,
    purchase_id: po1.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 10, tax: 0 }],
  });
  db = custInv.db;
  const custInvRec = read(db, 'account.move', custInv.id);
  assert.equal(poBtn.when(custInvRec, db), false, 'Purchase Orders button hidden on customer invoices');
});

test('BILL-8: Arabic translations exist for all vendor bill smart buttons', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  let tAr;
  try {
    ({ t: tAr } = await import(`./i18n.js?ar=${Date.now()}`));
  } finally {
    globalThis.localStorage = prevStorage;
  }

  for (const label of ['Assets', 'Deferred Expenses', 'Purchase Orders', 'Deferrals']) {
    const tr = tAr(label);
    assert.ok(tr && tr !== label, `Missing Arabic translation for: ${label}`);
  }
  assert.equal(tAr('Assets'), 'الأصول');
  assert.equal(tAr('Deferred Expenses'), 'المصروفات المؤجلة');
  assert.equal(tAr('Purchase Orders'), 'أوامر الشراء');
  assert.equal(tAr('Deferrals'), 'التأجيلات');
});
