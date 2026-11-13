import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { matchBill } from './models/billcontrol.js';

const run = (db, model, id, label, values) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id), values);

test('purchase bill retains the received duplicate order line', () => {
  const po = create(seed(), 'purchase.order', { partner_id: 2, state: 'purchase', order_line: [
    { product_id: 1, qty: 2, qty_delivered: 0, price_unit: 10 },
    { product_id: 1, qty: 2, qty_delivered: 1, price_unit: 20 },
  ] });
  const result = run(po.db, 'purchase.order', po.id, 'Create Bill');
  const bill = search(result.db, 'account.move').find((m) => m.purchase_id === po.id);
  const updated = write(result.db, 'account.move', bill.id, { invoice_line_ids: bill.invoice_line_ids });
  assert.deepEqual(read(updated, 'purchase.order', po.id).order_line.map((l) => l.qty_invoiced), [0, 1]);
  assert.equal(bill.invoice_line_ids[0].price_unit, 20);
});

const purchaseFixture = () => {
  const po = create(seed(), 'purchase.order', { partner_id: 2, company_id: 1, state: 'purchase', order_line: [{ product_id: 1, qty: 5, qty_delivered: 1, price_unit: 20 }] });
  return po;
};
const makeBill = (db, vals) => create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, company_id: 1, invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 20, tax: 0 }], ...vals });

test('purchase matching accepts a vendor contact but rejects unrelated vendor or company', () => {
  const po = purchaseFixture();
  const contact = create(po.db, 'res.partner', { name: 'Vendor contact', parent_id: 2 });
  const bill = makeBill(contact.db, { partner_id: contact.id, purchase_id: po.id });
  assert.equal(matchBill(bill.db, bill.id)[0].billedQty, 2);
  const other = create(bill.db, 'res.partner', { name: 'Unrelated vendor' });
  const wrongVendor = makeBill(other.db, { partner_id: other.id, purchase_id: po.id });
  assert.throws(() => matchBill(wrongVendor.db, wrongVendor.id), /vendor and company/);
  const co2 = create(po.db, 'res.company', { id: 2, name: 'Company 2', currency_id: read(po.db, 'res.company', 1).currency_id });
  const wrongCompany = makeBill(co2.db, { company_id: 2, purchase_id: po.id });
  assert.throws(() => matchBill(wrongCompany.db, wrongCompany.id), /vendor and company/);
});

test('purchase matching does not infer a purchase order from source document', () => {
  const po = purchaseFixture();
  const bill = makeBill(po.db, { invoice_origin: read(po.db, 'purchase.order', po.id).name });
  assert.throws(() => matchBill(bill.db, bill.id), /Link the vendor bill/);
});

test('three-way exception blocks payment until explicitly approved', () => {
  const po = purchaseFixture();
  const enabled = write({ ...po.db, settings: { ...po.db.settings, three_way_matching: true } }, 'res.company', 1, { three_way_matching: true });
  const bill = makeBill(enabled, { purchase_id: po.id });
  const posted = run(bill.db, 'account.move', bill.id, 'Confirm').db;
  assert.equal(read(posted, 'account.move', bill.id).should_be_paid, 'exception');
  assert.throws(() => run(posted, 'account.move', bill.id, 'Register Payment'), /resolve or approve/i);
  const draft = create(posted, 'account.payment', { partner_id: read(posted, 'account.move', bill.id).partner_id, payment_type: 'outbound', partner_type: 'supplier', amount: 1 });
  const picker = models['account.payment'].fields.invoice_id.domain;
  assert.equal(picker(read(posted, 'account.move', bill.id), read(draft.db, 'account.payment', draft.id), draft.db), false, 'the invoice picker hides bills payment would refuse');
  const approved = run(posted, 'account.move', bill.id, 'Approve for Payment').db;
  assert.equal(picker(read(approved, 'account.move', bill.id), read(draft.db, 'account.payment', draft.id), approved), true);
  const companyId = read(approved, 'account.move', bill.id).company_id ?? 1;
  const bank = search(approved, 'account.journal').find((journal) => journal.default_for_payments && (!journal.company_id || journal.company_id === companyId));
  const paid = run(approved, 'account.move', bill.id, 'Register Payment', { amount: '40', date: read(approved, 'account.move', bill.id).invoice_date, journal_id: bank.id }).db;
  assert.equal(read(paid, 'account.move', bill.id).amount_paid, 40);
});

test('confirming a price mismatch records the product name in bill chatter', () => {
  const po = purchaseFixture();
  const bill = makeBill(po.db, { purchase_id: po.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 25, tax: 0 }] });
  const posted = run(bill.db, 'account.move', bill.id, 'Confirm').db;
  const product = read(posted, 'product', 1);
  assert.ok(posted.messages.some((m) => m.model === 'account.move' && m.res_id === bill.id && m.body.includes('Purchase price mismatch') && m.body.includes(product.name)));
});
