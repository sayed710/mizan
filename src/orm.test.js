import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, applyFilters, create, groupRecords, matches, messagesOf, read, search, unlink, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const runButton = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

test('create assigns sequence and defaults', () => {
  const db0 = seed();
  const { db, id } = create(db0, 'sale.order', { partner_id: 1 });
  const so = read(db, 'sale.order', id);
  assert.equal(so.name, 'S00004');
  assert.equal(so.state, 'draft');
  assert.equal(so.amount_total, 0);
});

test('required fields are enforced', () => {
  assert.throws(() => create(seed(), 'crm.lead', { name: '' }), /Opportunity is required/);
});

test('order totals include tax', () => {
  const so = read(seed(), 'sale.order', 1);
  const untaxed = 40 * 210 + 8 * 45;
  assert.equal(so.amount_untaxed, untaxed);
  assert.equal(Math.round(so.amount_total * 100), Math.round(untaxed * 1.14 * 100));
});

test('stage change writes a tracking message and does not mutate input', () => {
  const db0 = seed();
  const db1 = write(db0, 'crm.lead', 1, { stage_id: 'qualified' });
  assert.equal(read(db0, 'crm.lead', 1).stage_id, 'new');
  assert.equal(read(db1, 'crm.lead', 1).stage_id, 'qualified');
  assert.match(messagesOf(db1, 'crm.lead', 1)[0].body, /Stage: New → Qualified/);
});

test('archived records are hidden, unlink removes', () => {
  let db = write(seed(), 'crm.lead', 2, { active: false });
  assert.ok(!search(db, 'crm.lead').some((r) => r.id === 2));
  db = unlink(db, 'crm.lead', [1]);
  assert.equal(read(db, 'crm.lead', 1), undefined);
});

test('text search matches related partner names and tags', () => {
  const db = seed();
  const lead = read(db, 'crm.lead', 1);
  assert.ok(matches(db, 'crm.lead', lead, ['nile']));
  assert.ok(matches(db, 'crm.lead', lead, ['product']));
  assert.ok(!matches(db, 'crm.lead', lead, ['zzz']));
});

test('groupRecords keeps selection order and empty stages', () => {
  const db = seed();
  const groups = groupRecords(db, 'crm.lead', search(db, 'crm.lead'), 'stage_id');
  assert.deepEqual(groups.map((g) => g.key), ['new', 'qualified', 'proposition', 'won']);
  assert.equal(aggregate(groups[0].records, '__count'), 2);
  assert.equal(aggregate(groups[0].records, 'expected_revenue'), 50500);
});

test('filters OR within a group and AND across groups', () => {
  const db = seed();
  const leads = search(db, 'crm.lead');
  assert.equal(applyFilters('crm.lead', leads, ['won']).length, 1);
  assert.equal(applyFilters('crm.lead', leads, ['won', 'ongoing']).length, leads.length);
  assert.equal(applyFilters('crm.lead', leads, ['unassigned', 'won']).length, 0);
});

test('confirming a sale creates a delivery; stock leaves only when it is validated (same for PO receipts)', () => {
  let db = seed();
  const before = read(db, 'product', 1).qty_available;
  db = runButton(db, 'sale.order', 1, 'Confirm').db;
  assert.equal(read(db, 'product', 1).qty_available, before);
  const delivery = search(db, 'stock.picking').find((p) => p.sale_id === 1);
  assert.deepEqual(delivery.move_ids, [{ product_id: 1, qty: 40 }]); // service line (installation) is not shipped
  db = runButton(db, 'stock.picking', delivery.id, 'Validate').db;
  assert.equal(read(db, 'product', 1).qty_available, before - 40);
  const { db: db2, id } = create(db, 'purchase.order', { partner_id: 7, order_line: [{ product_id: 1, qty: 10, price_unit: 120, tax: 14 }] });
  let db3 = runButton(db2, 'purchase.order', id, 'Confirm Order').db;
  const receipt = search(db3, 'stock.picking').find((p) => p.purchase_id === id);
  db3 = runButton(db3, 'stock.picking', receipt.id, 'Validate').db;
  assert.equal(read(db3, 'product', 1).qty_available, before - 30);
  assert.equal(read(db3, 'purchase.order', id).receipt_done, true);
});

test('line discounts reduce the untaxed amount', () => {
  const { db, id } = create(seed(), 'sale.order', { partner_id: 1, order_line: [{ product_id: 1, qty: 10, price_unit: 100, discount: 10, tax: 14 }] });
  const so = read(db, 'sale.order', id);
  assert.equal(so.amount_untaxed, 900);
  assert.equal(Math.round(so.amount_total * 100), 102600);
});

test('invoice from sale order, posting numbers it, payment state follows amount paid', () => {
  let db = seed();
  const res = runButton(db, 'sale.order', 3, 'Create Invoice');
  db = res.db;
  const inv = search(db, 'account.move').find((m) => m.sale_id === 3);
  assert.match(res.go, new RegExp(`/invoices/${inv.id}$`));
  assert.equal(inv.state, 'draft');
  db = runButton(db, 'account.move', inv.id, 'Confirm').db;
  const posted = read(db, 'account.move', inv.id);
  // Numbering restarts each year; the seed's invoices may belong to the previous one.
  const year = posted.invoice_date.slice(0, 4);
  const numbered = search(db, 'account.move').filter((m) => m.id !== inv.id && m.name?.startsWith(`INV/${year}/`)).length;
  assert.equal(posted.name, `INV/${year}/${String(numbered + 1).padStart(5, '0')}`);
  assert.equal(posted.payment_state, 'not_paid');
  db = write(db, 'account.move', inv.id, { amount_paid: posted.amount_total });
  assert.equal(read(db, 'account.move', inv.id).payment_state, 'paid');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
});
