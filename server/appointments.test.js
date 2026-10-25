import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { availableSlots } from '../src/models/appointments.js';
import { publicBook, publicSite, publicSlots } from './api.js';

const NOW = new Date('2027-03-01T06:00:00Z'); // Monday 08:00 in Cairo
const published = () => create(seed(), 'appointment.type', {
  name: 'Consult', is_published: true, is_online: true, duration: 30, assign_method: 'chosen', staff_ids: [{ employee_id: 2 }, { employee_id: 3 }],
  slot_ids: [{ weekday: '1', start: '09:00', end: '11:00' }], questions: [{ label: 'Topic?', required: true }],
});

test('the public site lists published types with staff names and no emails', () => {
  const { db, id } = published();
  const type = publicSite(db).appointments.find((a) => a.id === id);
  assert.deepEqual(type.staff.map((s) => s.name), [read(db, 'hr.employee', 2).name, read(db, 'hr.employee', 3).name]);
  assert.deepEqual(type.questions, [{ label: 'Topic?', required: true }]);
  assert.ok(!JSON.stringify(publicSite(db).appointments).includes('@'));
});

test('the slots endpoint returns availableSlots computed on the server', () => {
  const { db, id } = published();
  const type = read(db, 'appointment.type', id);
  const out = publicSlots(db, String(id), new URLSearchParams({ from: '2027-03-01', staff: '3' }), NOW);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.slots, availableSlots(db, type, { from: '2027-03-01', days: 14, staffId: 3, now: NOW }));
  assert.equal(out.body.slots.length, 14);
  assert.equal(publicSlots(db, '9999', new URLSearchParams(), NOW).status, 404);
});

test('a booked slot is refused to the next visitor and the answer carries the meeting link', () => {
  const { db, id } = published();
  const body = { type_id: id, staff_id: 2, start: '2027-03-01T09:00', name: 'Hala', email: 'hala@example.com', answers: [{ question: 'Topic?', answer: 'Desks' }] };
  const ok = publicBook(db, body, NOW);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.start, '2027-03-01T09:00');
  assert.match(ok.body.meeting_url, /^https:\/\/meet\.example\//);
  assert.equal(search(ok.db, 'appointment.booking').find((b) => b.id === ok.body.booking).staff_id, 2);
  const taken = publicBook(ok.db, { ...body, email: 'omar@example.com' }, NOW);
  assert.equal(taken.status, 400);
  assert.match(taken.body.error, /no longer available/);
  assert.equal(publicBook(ok.db, { ...body, staff_id: 3, email: 'omar@example.com' }, NOW).status, 201);
  assert.match(publicBook(db, { ...body, answers: [] }, NOW).body.error, /Please answer/);
  const slots = publicSlots(ok.db, String(id), new URLSearchParams({ from: '2027-03-01', staff: '2' }), NOW).body.slots[0].times.map((t) => t.start);
  assert.ok(!slots.includes('2027-03-01T09:00'));
});
