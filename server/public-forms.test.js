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

test('visitors book appointments only in available slots', () => {
  const monday = (() => { let d = addDays(today(), 1); while (new Date(`${d}T00:00:00`).getDay() !== 1) d = addDays(d, 1); return d; })();
  const { db, id } = create(seed(), 'appointment.type', { name: 'Consult', is_published: true, slot_ids: [{ weekday: '1', start: '09:00', end: '12:00' }] });
  assert.equal(publicBook(db, { type_id: id, date: monday, time: '10:00', name: 'Hala', email: 'hala@example.com' }).status, 201);
  assert.match(publicBook(db, { type_id: id, date: monday, time: '15:00', name: 'Hala', email: 'hala@example.com' }).body.error, /not available/);
  assert.equal(publicBook(db, { type_id: id, date: '2000-01-03', time: '10:00', name: 'Hala', email: 'hala@example.com' }).status, 400);
});

test('unpublished appointment types are hidden and impossible dates are refused', () => {
  const { db, id } = create(seed(), 'appointment.type', { name: 'Internal interview' });
  assert.ok(!publicSite(db).appointments.some((a) => a.id === id));
  assert.equal(publicBook(db, { type_id: id, date: '2099-03-01', time: '10:00', name: 'A', email: 'a@b.co' }).status, 400);
  const pub = create(seed(), 'appointment.type', { name: 'Open', is_published: true });
  assert.equal(publicBook(pub.db, { type_id: pub.id, date: '2099-02-31', time: '10:00', name: 'A', email: 'a@b.co' }).status, 400);
  assert.equal(publicBook(pub.db, { type_id: pub.id, date: '2099-03-01', time: '99:99', name: 'A', email: 'a@b.co' }).status, 400);
});
