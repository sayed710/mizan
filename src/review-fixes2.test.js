import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { applyDiff } from './sync.js';
import { rentedQty } from './models/extra.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';

test('one batched diff cannot overbook an event', () => {
  const { db, id } = create(seed(), 'event.event', { name: 'Tiny', date_begin: '2027-01-01', seats_max: 1 });
  const n = db.seq['event.registration'] ?? 0;
  const regs = [1, 2].map((k) => ({ id: n + k, name: `R${k}`, event_id: id, state: 'open', company_id: 1 }));
  assert.throws(() => applyDiff(db, { upserts: { 'event.registration': regs }, deletes: {} }), /sold out/);
});

test('a staff member cannot hold overlapping bookings, even at different start times', () => {
  const { db, id } = create(seed(), 'appointment.type', { name: 'Call', duration: 60, capacity: 1 });
  const first = create(db, 'appointment.booking', { name: 'A', type_id: id, staff_id: 2, start: '2027-03-01T10:00', end: '2027-03-01T11:00' });
  assert.throws(() => create(first.db, 'appointment.booking', { name: 'B', type_id: id, staff_id: 2, start: '2027-03-01T10:30', end: '2027-03-01T11:30' }), /already booked/);
  assert.ok(create(first.db, 'appointment.booking', { name: 'B', type_id: id, staff_id: 2, start: '2027-03-01T11:00', end: '2027-03-01T12:00' }).id);
});

test('an overdue rental still out keeps its units busy', () => {
  const { db } = create(seed(), 'sale.rental', { partner_id: 1, product_id: 3, qty: 1, pickup_date: addDays(today(), -10), return_date: addDays(today(), -2), state: 'picked' });
  assert.ok(rentedQty(db, 3, addDays(today(), 5), addDays(today(), 7), null) >= 1);
});

test('more lateness after invoicing can be invoiced as a late fee', () => {
  const run = (d, rid, label) => models['sale.rental'].form.buttons.find((b) => b.label === label).run(d, read(d, 'sale.rental', rid)).db;
  const { db, id } = create(seed(), 'sale.rental', { partner_id: 1, product_id: 1, qty: 1, pickup_date: addDays(today(), -6), return_date: addDays(today(), 0), price_per_day: 10, state: 'picked', late_fee_factor: 1 });
  const invoiced = run(db, id, 'Create Invoice');
  const later = write(invoiced, 'sale.rental', id, { return_date: addDays(today(), -3) });
  const returned = run(later, id, 'Return');
  const billed = run(returned, id, 'Invoice Late Fee');
  assert.equal(search(billed, 'account.move').filter((m) => m.invoice_origin === read(billed, 'sale.rental', id).name).length, 2);
});

test('an explicit zero consumption is respected when producing', () => {
  const bom = search(seed(), 'mrp.bom')[0];
  const { db, id } = create(seed(), 'mrp.production', { product_id: bom.product_id, bom_id: bom.id, product_qty: 1 });
  const btn = (d, label) => models['mrp.production'].form.buttons.find((b) => b.label === label).run(d, read(d, 'mrp.production', id)).db;
  const confirmed = btn(db, 'Confirm');
  const mo = read(confirmed, 'mrp.production', id);
  const zero = write(confirmed, 'mrp.production', id, { move_raw: mo.move_raw.map((m) => ({ ...m, consumed: 0 })) });
  const comp = mo.move_raw[0].product_id;
  const before = read(zero, 'product', comp).qty_available;
  assert.equal(read(btn(zero, 'Produce'), 'product', comp).qty_available, before);
});
