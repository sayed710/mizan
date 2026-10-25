import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';

test('events cap seats overall and per ticket; cancelling frees a seat', () => {
  const { db, id } = create(seed(), 'event.event', { name: 'Expo', date_begin: '2027-03-01', seats_max: 2, ticket_ids: [{ name: 'VIP', price: 100, seats_max: 1 }] });
  const a = create(db, 'event.registration', { name: 'A', event_id: id, ticket: 'VIP' });
  assert.match(read(a.db, 'event.registration', a.id).barcode, /^EVT\d{8}$/);
  assert.throws(() => create(a.db, 'event.registration', { name: 'B', event_id: id, ticket: 'VIP' }), /No VIP tickets left/);
  const b = create(a.db, 'event.registration', { name: 'B', event_id: id });
  assert.throws(() => create(b.db, 'event.registration', { name: 'C', event_id: id }), /sold out/);
  const freed = write(b.db, 'event.registration', a.id, { state: 'cancel' });
  assert.ok(create(freed, 'event.registration', { name: 'C', event_id: id }).id);
});

test('bookings must fit a weekly slot and its capacity', () => {
  const { db, id } = create(seed(), 'appointment.type', { name: 'Demo', capacity: 1, slot_ids: [{ weekday: '1', start: '09:00', end: '12:00' }] });
  const monday = '2027-03-01';
  assert.throws(() => create(db, 'appointment.booking', { name: 'X', type_id: id, date: monday, time: '13:00' }), /not available/);
  assert.throws(() => create(db, 'appointment.booking', { name: 'X', type_id: id, date: '2027-03-02', time: '10:00' }), /not available/);
  const first = create(db, 'appointment.booking', { name: 'X', type_id: id, date: monday, time: '10:00' });
  assert.throws(() => create(first.db, 'appointment.booking', { name: 'Y', type_id: id, date: monday, time: '10:00' }), /already booked/);
});
