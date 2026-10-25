import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, search } from '../src/orm.js';
import { addDays, today } from '../src/models/common.js';
import { seed } from '../src/seed.js';
import { publicBook, publicRegister, publicSite } from './api.js';

const eventDb = () => create(seed(), 'event.event', { name: 'Open Day', date_begin: addDays(today(), 10), stage_id: 'announced', seats_max: 1, ticket_ids: [{ name: 'Free', price: 0 }] });

test('visitors register to announced events until seats run out', () => {
  const { db, id } = eventDb();
  assert.ok(publicSite(db).events.some((e) => e.id === id));
  const ok = publicRegister(db, { event_id: id, ticket: 'Free', name: 'Hala', email: 'hala@example.com' });
  assert.equal(ok.status, 201);
  assert.ok(search(ok.db, 'event.registration').some((r) => r.event_id === id && r.email === 'hala@example.com' && r.partner_id));
  assert.match(publicRegister(ok.db, { event_id: id, ticket: 'Free', name: 'Omar', email: 'omar@example.com' }).body.error, /sold out/);
  assert.match(publicRegister(db, { event_id: id, name: 'Omar', email: 'omar@example.com' }).body.error, /Choose a ticket/);
  assert.match(publicRegister(ok.db, { event_id: id, ticket: 'Free', name: 'Hala', email: 'HALA@example.com' }).body.error, /already registered/);
  assert.equal(publicRegister(db, { event_id: id, name: '', email: 'x' }).status, 400);
});

const NOW = new Date('2027-03-01T06:00:00Z'); // Monday 08:00 in Cairo

test('visitors book appointments only in available slots', () => {
  const { db, id } = create(seed(), 'appointment.type', { name: 'Consult', is_published: true, slot_ids: [{ weekday: '1', start: '09:00', end: '12:00' }] });
  assert.equal(publicBook(db, { type_id: id, start: '2027-03-01T10:00', name: 'Hala', email: 'hala@example.com' }, NOW).status, 201);
  assert.match(publicBook(db, { type_id: id, start: '2027-03-01T15:00', name: 'Hala', email: 'hala@example.com' }, NOW).body.error, /no longer available/);
  assert.equal(publicBook(db, { type_id: id, start: '2000-01-03T10:00', name: 'Hala', email: 'hala@example.com' }, NOW).status, 400);
});

test('unpublished appointment types are hidden and impossible times are refused', () => {
  const { db, id } = create(seed(), 'appointment.type', { name: 'Internal interview', slot_ids: [{ weekday: '1', start: '09:00', end: '12:00' }] });
  assert.ok(!publicSite(db).appointments.some((a) => a.id === id));
  assert.equal(publicBook(db, { type_id: id, start: '2027-03-01T10:00', name: 'A', email: 'a@b.co' }, NOW).status, 400);
  const pub = create(seed(), 'appointment.type', { name: 'Open', is_published: true });
  assert.equal(publicBook(pub.db, { type_id: pub.id, start: '2027-02-31T10:00', name: 'A', email: 'a@b.co' }, NOW).status, 400);
  assert.equal(publicBook(pub.db, { type_id: pub.id, start: '2027-03-01T99:99', name: 'A', email: 'a@b.co' }, NOW).status, 400);
});
