import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { billControlModels, shouldBePaid, matchBill } from './models/billcontrol.js';

const run = (db, model, id, label) => (billControlModels[model] ?? models[model]).form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

test('BILL-1: shouldBePaid returns "no" when received quantity is 0 under receive policy', () => {
  let db = seed();
  const comp = search(db, 'res.company')[0];
  db = write(db, 'res.company', comp.id, { three_way_matching: true });

  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product').find((p) => p.type === 'goods') ?? search(db, 'product')[0];
  db = write(db, 'product', prod.id, { purchase_method: 'receive', type: 'goods' });

  const po = create(db, 'purchase.order', {
    company_id: comp.id,
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: prod.id, qty: 10, qty_delivered: 0, price_unit: 50 }],
  });
  db = po.db;

  const bill = create(db, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: po.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: prod.id, qty: 10, price_unit: 50 }],
  });
  db = bill.db;

  const billRec = read(db, 'account.move', bill.id);
  assert.equal(shouldBePaid(db, billRec), 'no');
});

test('BILL-1: shouldBePaid returns "exception" when billed qty exceeds received qty or price differs', () => {
  let db = seed();
  const comp = search(db, 'res.company')[0];
  db = write(db, 'res.company', comp.id, { three_way_matching: true });

  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product').find((p) => p.type === 'goods') ?? search(db, 'product')[0];
  db = write(db, 'product', prod.id, { purchase_method: 'receive', type: 'goods' });

  // PO with 5 delivered
  const po = create(db, 'purchase.order', {
    company_id: comp.id,
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: prod.id, qty: 10, qty_delivered: 5, price_unit: 50 }],
  });
  db = po.db;

  // Bill with 8 billed (> 5 received) -> exception
  const billQty = create(db, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: po.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: prod.id, qty: 8, price_unit: 50 }],
  });
  assert.equal(shouldBePaid(billQty.db, read(billQty.db, 'account.move', billQty.id)), 'exception');

  // Bill with 5 billed (<= 5 received), but price 55 > 50 -> exception
  const billPrice = create(db, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: po.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: prod.id, qty: 5, price_unit: 55 }],
  });
  assert.equal(shouldBePaid(billPrice.db, read(billPrice.db, 'account.move', billPrice.id)), 'exception');

  // Bill with 5 billed and price 50 -> yes
  const billOk = create(db, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: po.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: prod.id, qty: 5, price_unit: 50 }],
  });
  assert.equal(shouldBePaid(billOk.db, read(billOk.db, 'account.move', billOk.id)), 'yes');
});

test('BILL-1: should_be_paid field options include "no"', () => {
  const field = models['account.move'].fields.should_be_paid;
  assert.ok(field, 'should_be_paid field exists');
  const values = field.options.map((o) => o[0]);
  assert.ok(values.includes('no'), 'options include "no"');
  assert.ok(values.includes('yes'), 'options include "yes"');
  assert.ok(values.includes('exception'), 'options include "exception"');
});

test('BILL-2: createBill links purchase_line_id to PO line id', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product')[0];

  const po = create(db, 'purchase.order', {
    partner_id: vendor.id,
    order_line: [{ product_id: prod.id, qty: 5, price_unit: 30 }],
  });
  const confirmed = run(po.db, 'purchase.order', po.id, 'Confirm Order');
  // Deliver items
  const picking = search(confirmed.db, 'stock.picking').find((p) => p.purchase_id === po.id && p.state === 'ready');
  const validated = run(confirmed.db, 'stock.picking', picking.id, 'Validate');

  const billed = run(validated.db, 'purchase.order', po.id, 'Create Bill');
  const move = search(billed.db, 'account.move').find((m) => m.purchase_id === po.id);
  assert.ok(move, 'Bill created');
  assert.ok(move.invoice_line_ids.length > 0);
  const firstLine = move.invoice_line_ids[0];
  assert.ok(firstLine.purchase_line_id != null, 'Bill line has purchase_line_id');
  assert.equal(firstLine.purchase_line_key, undefined, 'Bill line stores no separate key');

  const poUpdated = read(billed.db, 'purchase.order', po.id);
  const poLine = poUpdated.order_line[0];
  assert.equal(firstLine.purchase_line_id, poLine.id);
  assert.ok(poLine.id != null);
});

test('BILL-2: invoiceLineField maps purchase_line_id to order line details', () => {
  const lineDef = models['account.move'].fields.invoice_line_ids;
  assert.ok(lineDef.fields.purchase_line_id, 'purchase_line_id is declared on invoice line');
  assert.equal(lineDef.fields.purchase_line_id.relation, 'purchase.order.line');

  let db = seed();
  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product')[0];
  const poKey = 'test-po-line-key-123';
  const po = create(db, 'purchase.order', {
    partner_id: vendor.id,
    order_line: [{ id: 101, product_id: prod.id, qty: 5, price_unit: 40, purchase_line_key: poKey }],
  });

  const moveContext = { move_type: 'in_invoice', purchase_id: po.id, company_id: 1 };
  const mapped = lineDef.onchange({ purchase_line_id: 101 }, 'purchase_line_id', po.db, moveContext);
  assert.equal(mapped.product_id, prod.id);
  assert.equal(mapped.purchase_line_id, 101);
  assert.equal(mapped.purchase_line_key, undefined);
});

test('BILL-5: purchase_id is editable in draft and readonly when posted', () => {
  const purchaseIdDef = models['account.move'].fields.purchase_id;
  assert.ok(purchaseIdDef, 'purchase_id field exists');
  assert.equal(typeof purchaseIdDef.readonly, 'function', 'purchase_id readonly is a function');
  assert.equal(purchaseIdDef.readonly({ state: 'draft' }), false, 'editable in draft');
  assert.equal(purchaseIdDef.readonly({ state: 'posted' }), true, 'readonly when posted');
  assert.equal(purchaseIdDef.readonly({ state: 'cancel' }), true, 'readonly when cancelled');
});

test('BILL-5: form.groups includes purchase_id for vendor bills but not customer invoices', () => {
  const groupsFn = models['account.move'].form.groups;
  assert.ok(typeof groupsFn === 'function');

  const billGroups = groupsFn({ move_type: 'in_invoice' });
  const billFields = billGroups.flat().map((f) => (typeof f === 'string' ? f : f.field));
  assert.ok(billFields.includes('purchase_id'), 'Vendor bill form group contains purchase_id');

  const invoiceGroups = groupsFn({ move_type: 'out_invoice' });
  const invoiceFields = invoiceGroups.flat().map((f) => (typeof f === 'string' ? f : f.field));
  assert.ok(!invoiceFields.includes('purchase_id'), 'Customer invoice form group does not contain purchase_id');
});

test('BILL-5: onchange with purchase_id auto-populates vendor, currency, terms, and unbilled lines', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product')[0];
  const term = search(db, 'account.payment.term')[0];

  const po = create(db, 'purchase.order', {
    partner_id: vendor.id,
    currency_id: 1,
    payment_term_id: term.id,
    state: 'purchase',
    order_line: [{ product_id: prod.id, qty: 7, price_unit: 45, qty_delivered: 7 }],
  });

  const onchangeFn = models['account.move'].onchange;
  const draftBill = { move_type: 'in_invoice', state: 'draft', purchase_id: po.id, company_id: 1 };
  const changes = onchangeFn(draftBill, 'purchase_id', po.db);

  assert.equal(changes.partner_id, vendor.id);
  assert.equal(changes.currency_id, 1);
  assert.equal(changes.invoice_payment_term_id, term.id);
  assert.ok(Array.isArray(changes.invoice_line_ids));
  assert.equal(changes.invoice_line_ids.length, 1);
  assert.equal(changes.invoice_line_ids[0].qty, 7);
  assert.equal(changes.invoice_line_ids[0].price_unit, 45);
  assert.ok(changes.invoice_line_ids[0].purchase_line_id != null);
  assert.equal(changes.invoice_line_ids[0].purchase_line_key, undefined);
});

test('BILL-1: shouldBePaid edge cases: service/ordered policy, force_post, 3WM disabled, multi-line', () => {
  let db = seed();
  const comp = search(db, 'res.company')[0];
  db = write(db, 'res.company', comp.id, { three_way_matching: true });

  const vendor = search(db, 'res.partner')[0];
  const service = create(db, 'product', { name: 'Audit Service', type: 'service', purchase_method: 'purchase' });
  db = service.db;
  const goods = create(db, 'product', { name: 'Hardware', type: 'goods', purchase_method: 'receive' });
  db = goods.db;

  // 1. Service order (purchase policy): 0 delivered should return 'yes'
  const poService = create(db, 'purchase.order', {
    company_id: comp.id,
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: service.id, qty: 1, qty_delivered: 0, price_unit: 100 }],
  });
  const billService = create(poService.db, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: poService.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: service.id, qty: 1, price_unit: 100 }],
  });
  assert.equal(shouldBePaid(billService.db, read(billService.db, 'account.move', billService.id)), 'yes');

  // 2. force_post: true on bill returns 'yes' even if nothing received
  const poGoods = create(billService.db, 'purchase.order', {
    company_id: comp.id,
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: goods.id, qty: 10, qty_delivered: 0, price_unit: 50 }],
  });
  const billForced = create(poGoods.db, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: poGoods.id,
    force_post: true,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: goods.id, qty: 10, price_unit: 50 }],
  });
  assert.equal(shouldBePaid(billForced.db, read(billForced.db, 'account.move', billForced.id)), 'yes');

  // 3. three_way_matching: false on company returns 'yes'
  const dbNo3WM = write(billForced.db, 'res.company', comp.id, { three_way_matching: false });
  const billNo3WM = create(dbNo3WM, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: poGoods.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: goods.id, qty: 10, price_unit: 50 }],
  });
  assert.equal(shouldBePaid(billNo3WM.db, read(billNo3WM.db, 'account.move', billNo3WM.id)), 'yes');

  // 4. No PO returns 'yes'
  const billNoPO = create(billForced.db, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: goods.id, qty: 10, price_unit: 50 }],
  });
  assert.equal(shouldBePaid(billNoPO.db, read(billNoPO.db, 'account.move', billNoPO.id)), 'yes');

  // 5. Multi-line bill: line 1 received 5/5, line 2 received 0/5 -> returns 'no'
  const prod2 = create(billForced.db, 'product', { name: 'Gadget', type: 'goods', purchase_method: 'receive' });
  const poMulti = create(prod2.db, 'purchase.order', {
    company_id: comp.id,
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [
      { product_id: goods.id, qty: 5, qty_delivered: 5, price_unit: 20 },
      { product_id: prod2.id, qty: 5, qty_delivered: 0, price_unit: 30 },
    ],
  });
  const billMulti = create(poMulti.db, 'account.move', {
    company_id: comp.id,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: poMulti.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [
      { product_id: goods.id, qty: 5, price_unit: 20 },
      { product_id: prod2.id, qty: 5, price_unit: 30 },
    ],
  });
  assert.equal(shouldBePaid(billMulti.db, read(billMulti.db, 'account.move', billMulti.id)), 'no');
});

test('BILL-2: commitment tracking works with purchase_line_id mapped on manual bill lines', async () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product')[0];

  const po = create(db, 'purchase.order', {
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: prod.id, qty: 10, price_unit: 25 }],
  });
  db = po.db;
  const poRecord = read(db, 'purchase.order', po.id);
  const poLine = poRecord.order_line[0];

  // Create manual bill with purchase_line_id
  const lineDef = models['account.move'].fields.invoice_line_ids;
  const lineData = lineDef.onchange(
    { product_id: prod.id, qty: 4, purchase_line_id: poLine.id },
    'purchase_line_id',
    db,
    { move_type: 'in_invoice', purchase_id: po.id, company_id: 1 }
  );

  assert.equal(lineData.purchase_line_id, poLine.id);
  assert.equal(lineData.purchase_line_key, undefined);
});


test('price review catches cheaper bills and ignores unrelated lines', () => {
  let db = seed();
  const company = search(db, 'res.company')[0];
  db = write(db, 'res.company', company.id, { three_way_matching: true });
  const vendor = search(db, 'res.partner')[0];
  const product = create(db, 'product', { name: 'Received goods', type: 'goods', purchase_method: 'receive' });
  const po = create(product.db, 'purchase.order', { company_id: company.id, partner_id: vendor.id, state: 'purchase', order_line: [{ product_id: product.id, qty: 1, qty_delivered: 1, price_unit: 100 }] });
  const lines = [{ display_type: 'product', product_id: product.id, qty: 1, price_unit: 90 }, { display_type: 'line_section', name: 'Section' }, { name: 'Freight', qty: 1, price_unit: 20 }];
  const bill = create(po.db, 'account.move', { company_id: company.id, partner_id: vendor.id, move_type: 'in_invoice', purchase_id: po.id, invoice_line_ids: lines });
  assert.equal(shouldBePaid(bill.db, read(bill.db, 'account.move', bill.id)), 'exception');
  assert.equal(matchBill(bill.db, bill.id)[0].status, 'price_differs');
  const updated = write(bill.db, 'account.move', bill.id, { invoice_line_ids: [{ ...lines[0], price_unit: 100 }, ...lines.slice(1)] });
  assert.equal(shouldBePaid(updated, read(updated, 'account.move', bill.id)), 'yes');
});


test('purchase autocomplete preserves existing bill lines and avoids duplicating linked lines', () => {
  const db = seed();
  const vendor = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];
  const po = create(db, 'purchase.order', { partner_id: vendor.id, state: 'purchase', order_line: [{ product_id: product.id, qty: 1, qty_delivered: 1, price_unit: 10 }] });
  const first = models['account.move'].onchange({ move_type: 'in_invoice', purchase_id: po.id, invoice_line_ids: [{ name: 'Freight', qty: 1, price_unit: 5 }] }, 'purchase_id', po.db);
  assert.equal(first.invoice_line_ids[0].name, 'Freight');
  assert.equal(first.invoice_line_ids.length, 2);
  const second = models['account.move'].onchange({ move_type: 'in_invoice', purchase_id: po.id, invoice_line_ids: first.invoice_line_ids }, 'purchase_id', po.db);
  assert.equal(second.invoice_line_ids.length, 2);
});


test('multi-order bill lines sync to their own orders and invalid links fail direct and diff writes', () => {
  let db = seed();
  const vendor = search(db, 'res.partner')[0];
  const product = search(db, 'product')[0];
  const po1 = create(db, 'purchase.order', { partner_id: vendor.id, state: 'purchase', order_line: [{ id: 70001, product_id: product.id, qty: 5, price_unit: 10 }] });
  const po2 = create(po1.db, 'purchase.order', { partner_id: vendor.id, state: 'purchase', order_line: [{ id: 70002, product_id: product.id, qty: 5, price_unit: 10 }] });
  const bill = create(po2.db, 'account.move', { move_type: 'in_invoice', partner_id: vendor.id, purchase_id: po1.id, invoice_line_ids: [{ product_id: product.id, purchase_line_id: 70002, qty: 2, price_unit: 10 }] });
  db = bill.db;
  assert.equal(read(db, 'purchase.order', po2.id).order_line[0].qty_invoiced, 2);
  assert.equal(read(db, 'purchase.order', po1.id).order_line[0].qty_invoiced, 0);
  const badLines = [{ product_id: product.id, purchase_line_id: 999999, qty: 2, price_unit: 10 }];
  assert.throws(() => write(db, 'account.move', bill.id, { invoice_line_ids: badLines }), /Purchase order line must match/);
  const forged = structuredClone(db);
  forged.records['account.move'].find((m) => m.id === bill.id).invoice_line_ids = badLines;
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: false }), /Purchase order line must match/);
});

test('purchase autocomplete adopts the selected order company as Odoo does', () => {
  const db = seed();
  const vendor = search(db, 'res.partner')[0];
  const po = create(db, 'purchase.order', { partner_id: vendor.id, company_id: 2, order_line: [] });
  const result = models['account.move'].onchange({ move_type: 'in_invoice', company_id: 1, purchase_id: po.id }, 'purchase_id', po.db);
  assert.equal(result.company_id, 2);
});
