import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { create, read, search } from './orm.js';

// MOD-007: functions that were only reachable from tests now have a form button.
const button = (model, label) => {
  const b = models[model].form.buttons.find((x) => x.label === label);
  assert.ok(b, `${model} has a "${label}" button`);
  return b;
};

test('fleet contracts can be renewed from the form', () => {
  const db = seed();
  const made = create(db, 'fleet.contract', { name: 'Lease', vehicle_id: search(db, 'fleet.vehicle')[0].id, start_date: '2026-01-01', expiration_date: '2026-12-31', stage_id: 'open' });
  const renew = button('fleet.contract', 'Renew');
  const rec = read(made.db, 'fleet.contract', made.id);
  assert.ok(renew.when(rec));
  const out = renew.run(made.db, rec);
  assert.equal(read(out.db, 'fleet.contract', made.id).stage_id, 'closed');
  assert.match(out.go, /^#\/open\/fleet\.contract\/\d+$/);
});

test('event registrations can be invoiced from the event form, once', () => {
  const ev = create(seed(), 'event.event', { name: 'Expo', date_begin: '2027-04-01', ticket_ids: [{ name: 'VIP', price: 100, seats_max: 0 }] });
  const reg = create(ev.db, 'event.registration', { event_id: ev.id, name: 'Sara', partner_id: 3, ticket: 'VIP' });
  const b = button('event.event', 'Invoice Registrations');
  const event = read(reg.db, 'event.event', ev.id);
  assert.ok(b.when(event));
  const out = b.run(reg.db, event);
  assert.ok(read(out.db, 'event.registration', reg.id).invoice_id);
  assert.throws(() => b.run(out.db, event), /already invoiced/);
});

test('a draft purchase order takes the vendor pricelist price', () => {
  const db0 = seed();
  const po = search(db0, 'purchase.order').find((p) => p.state === 'draft');
  const line = po.order_line[0];
  const info = create(db0, 'product.supplierinfo', { partner_id: po.partner_id, product_id: line.product_id, price: 7.25, min_qty: 0 });
  const b = button('purchase.order', 'Apply Vendor Prices');
  assert.ok(b.when(po));
  assert.equal(b.when({ ...po, state: 'purchase' }), false);
  const out = b.run(info.db, read(info.db, 'purchase.order', po.id));
  assert.equal(read(out.db, 'purchase.order', po.id).order_line[0].price_unit, 7.25);
});

test('expense sheets re-invoice once posted, and front desk can check everyone out', () => {
  const reinvoice = button('hr.expense.sheet', 'Re-invoice to Sales Orders');
  assert.ok(reinvoice.when({ state: 'post' }));
  assert.equal(reinvoice.when({ state: 'draft' }), false);
  const db = seed();
  assert.ok(button('frontdesk.station', 'Check Out All Visitors').run(db, {}).db.records);
});
