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

test('planning flags overlapping shifts and time off, fills from templates and copies a week ahead', async () => {
  const { models } = await import('./models/index.js');
  const { shiftConflict } = await import('./models/extra.js');
  const { db: d0, id: tpl } = create(seed(), 'planning.template', { name: 'Morning', role: 'support', duration: 6 });
  const { db: d1 } = create(d0, 'planning.slot', { name: 'A', employee_id: 4, start: '2027-05-03', end: '2027-05-04' });
  const { db, id } = create(d1, 'planning.slot', { name: 'B', start: '2027-05-04' });
  const assigned = write(db, 'planning.slot', id, { employee_id: 4 });
  assert.match(read(assigned, 'planning.slot', id).conflict, /Overlaps A/);
  const templated = write(db, 'planning.slot', id, { template_id: tpl });
  assert.deepEqual([read(templated, 'planning.slot', id).role, read(templated, 'planning.slot', id).allocated_hours], ['support', 6]);
  const withLeave = create(db, 'hr.leave', { name: 'Off', employee_id: 5, leave_type: 'sick', date_from: '2027-06-01', date_to: '2027-06-02', state: 'validate' }).db;
  assert.match(shiftConflict(withLeave, { employee_id: 5, start: '2027-06-02' }), /time off/);
  const copied = models['planning.slot'].form.buttons.find((b) => b.label === 'Copy to Next Week').run(templated, read(templated, 'planning.slot', id));
  assert.ok(Object.values(copied.db.records['planning.slot']).some((s) => s.start === '2027-05-11' && s.state === 'draft'));
});

test('documents are signed by every signer in order, then complete', async () => {
  const { applySignature, nextSigner } = await import('./models/extra.js');
  const { db, id } = create(seed(), 'sign.request', { name: 'NDA', partner_id: 1, state: 'sent', signer_ids: [{ partner_id: 1, role: 'customer', signed: false }, { partner_id: 2, role: 'employee', signed: false }] });
  const one = applySignature(db, read(db, 'sign.request', id), 'Nile Rep');
  assert.equal(read(one, 'sign.request', id).state, 'sent');
  assert.equal(nextSigner(read(one, 'sign.request', id)), 1);
  const two = applySignature(one, read(one, 'sign.request', id), 'Our Manager');
  assert.equal(read(two, 'sign.request', id).state, 'signed');
  assert.equal(read(two, 'sign.request', id).progress, '2 / 2');
  const late = create(seed(), 'sign.request', { name: 'Old', partner_id: 1, state: 'sent', deadline: '2020-01-01' });
  assert.throws(() => applySignature(late.db, read(late.db, 'sign.request', late.id), 'X'), /expired/);
});
