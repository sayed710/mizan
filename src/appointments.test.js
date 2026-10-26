import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, messagesOf, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { availableSlots, bookAppointment, cancelBooking, localNow, migrateAppointments } from './models/appointments.js';

const NOW = new Date('2027-03-01T06:00:00Z'); // Monday 2027-03-01 08:00 in Cairo
const MONDAY = '2027-03-01';
const visitor = { name: 'Hala Adel', email: 'hala@example.com', phone: '+20 100 000 0000' };

/** A type available on Mondays 09:00-12:00 with the given extra values. */
const makeType = (vals = {}) => {
  // The seed's leaves and meetings are dated relative to today; drop them so they never land on the fixed test dates.
  const base = seed();
  const quiet = { ...base, records: { ...base.records, 'hr.leave': [], 'calendar.event': [] } };
  const res = create(quiet, 'appointment.type', { name: 'Consult', duration: 60, slot_ids: [{ weekday: '1', start: '09:00', end: '12:00' }], staff_ids: [{ employee_id: 2 }], ...vals });
  return { db: res.db, type: read(res.db, 'appointment.type', res.id) };
};
const startsOn = (db, type, date = MONDAY, opts = {}) => availableSlots(db, type, { from: date, days: 1, now: NOW, ...opts })[0].times.map((t) => t.start.slice(11));
const book = (db, type, start, extra = {}) => bookAppointment(db, type, { ...visitor, start, now: NOW, ...extra });

test('slots follow the weekday windows, the interval and the duration', () => {
  const { db, type } = makeType({ slot_interval: 30 });
  assert.equal(localNow(NOW, 'Africa/Cairo'), '2027-03-01T08:00');
  assert.deepEqual(startsOn(db, type), ['09:00', '09:30', '10:00', '10:30', '11:00']);
  const hourly = makeType();
  assert.deepEqual(startsOn(hourly.db, hourly.type), ['09:00', '10:00', '11:00']);
  assert.deepEqual(startsOn(db, type, '2027-03-02'), []);
  assert.equal(availableSlots(db, type, { from: MONDAY, days: 14, now: NOW }).length, 14);
});

test('slots respect the minimum notice and the maximum horizon', () => {
  const { db, type } = makeType({ min_schedule_hours: 2 });
  assert.deepEqual(startsOn(db, type), ['10:00', '11:00']);
  const near = makeType({ max_schedule_days: 7 });
  assert.deepEqual(startsOn(near.db, near.type, '2027-03-08', { now: new Date('2027-01-04T07:30:00Z') }), []);
  assert.deepEqual(startsOn(near.db, near.type, '2027-03-08', { now: new Date('2027-03-01T07:30:00Z') }), ['09:00']);
});

test('a slot stays open until capacity times free staff is reached', () => {
  const { db, type } = makeType({ capacity: 2, staff_ids: [{ employee_id: 2 }, { employee_id: 3 }] });
  let next = db;
  for (let i = 0; i < 4; i += 1) next = book(next, type, `${MONDAY}T09:00`, { email: `v${i}@example.com` }).db;
  assert.ok(!startsOn(next, type).includes('09:00'));
  assert.throws(() => book(next, type, `${MONDAY}T09:00`), /no longer available/);
  const staff = search(next, 'appointment.booking').filter((b) => b.start === `${MONDAY}T09:00`).map((b) => b.staff_id).sort();
  assert.deepEqual(staff, [2, 2, 3, 3]);
});

test('staff with another booking, approved time off or a meeting are not offered', () => {
  const { db, type } = makeType();
  const other = create(db, 'appointment.type', { name: 'Other', duration: 60, slot_ids: [{ weekday: '1', start: '09:00', end: '12:00' }], staff_ids: [{ employee_id: 2 }] });
  const busy = book(other.db, read(other.db, 'appointment.type', other.id), `${MONDAY}T09:00`).db;
  assert.deepEqual(startsOn(busy, type), ['10:00', '11:00']);
  const refused = create(db, 'hr.leave', { name: 'Off', employee_id: 2, date_from: MONDAY, date_to: MONDAY, state: 'confirm' }).db;
  assert.deepEqual(startsOn(refused, type), ['09:00', '10:00', '11:00']);
  const leave = create(db, 'hr.leave', { name: 'Off', employee_id: 2, date_from: MONDAY, date_to: MONDAY, state: 'validate' }).db;
  assert.deepEqual(startsOn(leave, type), []);
  const email = read(db, 'hr.employee', 2).work_email;
  const partner = create(db, 'res.partner', { name: 'Mona', email });
  const meeting = create(partner.db, 'calendar.event', { name: 'Review', start: MONDAY, start_time: '10:30', duration: 1, partner_id: partner.id }).db;
  assert.deepEqual(startsOn(meeting, type), ['09:00']);
});

test('random assignment picks the least busy staff; chosen assignment keeps the customer pick', () => {
  const { db, type } = makeType({ staff_ids: [{ employee_id: 2 }, { employee_id: 3 }] });
  const first = book(db, type, `${MONDAY}T09:00`, { staffId: 3 });
  assert.equal(read(first.db, 'appointment.booking', first.id).staff_id, 2);
  const second = book(first.db, type, `${MONDAY}T10:00`);
  assert.equal(read(second.db, 'appointment.booking', second.id).staff_id, 3);
  const chosen = makeType({ assign_method: 'chosen', staff_ids: [{ employee_id: 2 }, { employee_id: 3 }] });
  const pick = book(chosen.db, chosen.type, `${MONDAY}T09:00`, { staffId: 3 });
  assert.equal(read(pick.db, 'appointment.booking', pick.id).staff_id, 3);
  assert.deepEqual(availableSlots(pick.db, chosen.type, { from: MONDAY, days: 1, staffId: 3, now: NOW })[0].times.map((t) => t.start.slice(11)), ['10:00', '11:00']);
});

test('booking links a contact, logs a note, and paid online types get an invoice and a meeting link', () => {
  const { db, type } = makeType({ is_online: true, price: 150 });
  const res = book(db, type, `${MONDAY}T09:00`);
  const b = read(res.db, 'appointment.booking', res.id);
  assert.match(b.meeting_url, /^https:\/\/meet\.example\/\w+$/);
  assert.equal(b.end, `${MONDAY}T10:00`);
  const invoice = read(res.db, 'account.move', b.invoice_id);
  assert.deepEqual([invoice.move_type, invoice.state, invoice.partner_id, invoice.amount_total], ['out_invoice', 'draft', b.partner_id, 150]);
  assert.ok(messagesOf(res.db, 'res.partner', b.partner_id).some((m) => /Appointment booked: Consult/.test(m.body)));
  const again = book(res.db, type, `${MONDAY}T10:00`, { email: 'HALA@example.com' });
  assert.equal(read(again.db, 'appointment.booking', again.id).partner_id, b.partner_id);
  const free = makeType();
  const plain = read(book(free.db, free.type, `${MONDAY}T09:00`).db, 'appointment.booking', 1 + (free.db.seq['appointment.booking'] ?? 0));
  assert.deepEqual([plain.invoice_id ?? null, plain.meeting_url ?? null], [null, null]);
});

test('required answers, email and phone are validated', () => {
  const { db, type } = makeType({ questions: [{ label: 'Topic?', required: true }, { label: 'Notes', required: false }] });
  assert.throws(() => book(db, type, `${MONDAY}T09:00`), /Please answer: Topic\?/);
  assert.throws(() => book(db, type, `${MONDAY}T09:00`, { email: 'nope', answers: [{ question: 'Topic?', answer: 'Desks' }] }), /valid email/);
  assert.throws(() => book(db, type, `${MONDAY}T09:00`, { phone: 'call me', answers: [{ question: 'Topic?', answer: 'Desks' }] }), /valid phone/);
  const ok = book(db, type, `${MONDAY}T09:00`, { answers: [{ question: 'Topic?', answer: 'Desks' }] });
  assert.deepEqual(read(ok.db, 'appointment.booking', ok.id).answers, [{ question: 'Topic?', answer: 'Desks' }]);
});

test('cancelling is only possible before the start and frees the slot', () => {
  const { db, type } = makeType();
  const res = book(db, type, `${MONDAY}T09:00`);
  assert.ok(!startsOn(res.db, type).includes('09:00'));
  assert.throws(() => cancelBooking(res.db, res.id, { now: new Date('2027-03-01T07:00:00Z') }), /before it starts/);
  const cancelled = cancelBooking(res.db, res.id, { now: NOW });
  assert.equal(read(cancelled, 'appointment.booking', res.id).state, 'cancelled');
  assert.ok(startsOn(cancelled, type).includes('09:00'));
  assert.throws(() => cancelBooking(cancelled, res.id, { now: NOW }), /Only booked/);
  assert.throws(() => cancelBooking(write(res.db, 'appointment.booking', res.id, { state: 'attended' }), res.id, { now: NOW }), /Only booked/);
});

test('the seed loads appointment types and bookings in the new fields, and old records migrate', () => {
  const db = seed();
  const types = search(db, 'appointment.type');
  assert.ok(types.length >= 2 && types.every((t) => t.is_published && t.staff_ids.length && t.slot_ids.length && t.duration >= 30));
  assert.ok(types.some((t) => t.is_online && t.price > 0 && t.questions.some((q) => q.required)));
  const bookings = search(db, 'appointment.booking');
  assert.ok(bookings.length >= 2 && bookings.every((b) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.start) && b.date === b.start.slice(0, 10) && b.state === 'booked'));
  const legacy = { records: { 'appointment.type': [{ id: 1, name: 'Old', duration: 0.5, user_id: 4 }], 'appointment.booking': [{ id: 1, name: 'A', type_id: 1, date: MONDAY, time: '10:00', state: 'done' }] } };
  const migrated = migrateAppointments(legacy);
  assert.deepEqual(migrated.records['appointment.type'][0], { id: 1, name: 'Old', duration: 30, staff_ids: [{ employee_id: 4 }] });
  assert.deepEqual(migrated.records['appointment.booking'][0], { id: 1, name: 'A', type_id: 1, start: `${MONDAY}T10:00`, end: `${MONDAY}T10:30`, state: 'attended' });
  assert.deepEqual(migrateAppointments(migrated), migrated);
});
