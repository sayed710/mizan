import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import {
  agenda, checkIn, eventDashboard, invoiceRegistrations, invoiceSponsor,
  reserveBooth, sellBooth, trackConflicts,
} from './models/eventsplus.js';

const event = (db, vals = {}) => create(db, 'event.event', {
  name: 'Community Expo', date_begin: '2027-04-01', seats_max: 100, ...vals,
});

test('badge check-in accepts one active attendee and rejects unknown, cancelled, and repeat scans', () => {
  const { db: d0, id: eventId } = event(emptyDb());
  const active = create(d0, 'event.registration', { name: 'Mina', event_id: eventId });
  const cancelled = create(active.db, 'event.registration', { name: 'Omar', event_id: eventId, state: 'cancel' });
  assert.throws(() => checkIn(cancelled.db, 'missing-badge'), /Unknown badge/);
  assert.throws(() => checkIn(cancelled.db, read(cancelled.db, 'event.registration', cancelled.id).barcode), /Cancelled/);
  const checked = checkIn(cancelled.db, read(cancelled.db, 'event.registration', active.id).barcode, '2027-04-01T09:15:00.000Z');
  assert.deepEqual(
    [read(checked, 'event.registration', active.id).checked_in, read(checked, 'event.registration', active.id).check_in_time],
    [true, '2027-04-01T09:15:00.000Z'],
  );
  assert.throws(() => checkIn(checked, read(checked, 'event.registration', active.id).barcode), /already checked in/);
});

test('agenda orders published talks by date and time, groups rooms, and exposes same-room conflicts', () => {
  const { db: d0, id: eventId } = event(emptyDb());
  const addTrack = (db, vals) => create(db, 'event.track', { event_id: eventId, is_published: true, ...vals });
  let db = d0;
  db = addTrack(db, { name: 'Later', date: '2027-04-01', start: '10:30', duration: 30, location: 'Hall A' }).db;
  db = addTrack(db, { name: 'Second', date: '2027-04-01', start: '09:30', duration: 30, location: 'Hall A' }).db;
  db = addTrack(db, { name: 'First', date: '2027-04-01', start: '09:00', duration: 60, location: 'Hall A' }).db;
  db = addTrack(db, { name: 'Other Room', date: '2027-04-01', start: '09:15', duration: 30, location: 'Hall B' }).db;
  db = addTrack(db, { name: 'Hidden', date: '2027-04-01', start: '09:15', duration: 60, location: 'Hall A', is_published: false }).db;
  db = addTrack(db, { name: 'Refused', date: '2027-04-01', start: '09:15', duration: 60, location: 'Hall A', stage: 'refused' }).db;
  db = addTrack(db, { name: 'Late Talk', date: '2027-04-01', start: '23:30', duration: 90, location: 'Hall A' }).db;
  db = addTrack(db, { name: 'After Midnight', date: '2027-04-02', start: '00:30', duration: 30, location: 'Hall A' }).db;

  const plan = agenda(db, eventId);
  const hallA = plan.groups.find((group) => group.location === 'Hall A');
  assert.deepEqual(hallA.tracks.map((track) => track.name), ['First', 'Second', 'Later', 'Late Talk', 'After Midnight']);
  assert.equal(plan.groups.find((group) => group.location === 'Hall B').tracks.length, 1);
  assert.deepEqual(trackConflicts(db, eventId).map(([a, b]) => [a.name, b.name]), [['First', 'Second'], ['Late Talk', 'After Midnight']]);
  assert.deepEqual(hallA.conflicts.map(([a, b]) => [a.name, b.name]), [['First', 'Second'], ['Late Talk', 'After Midnight']]);
});

test('booths reserve and invoice once, and sponsors receive one draft invoice', () => {
  const { db: d0, id: eventId } = event(emptyDb());
  const contact = create(d0, 'res.partner', { name: 'Cairo Design Co.' });
  const booth = create(contact.db, 'event.booth', { event_id: eventId, name: 'B-12', price: 500 });
  const reserved = reserveBooth(booth.db, booth.id, contact.id);
  assert.deepEqual([read(reserved, 'event.booth', booth.id).state, read(reserved, 'event.booth', booth.id).partner_id], ['reserved', contact.id]);
  assert.throws(() => reserveBooth(reserved, booth.id, contact.id), /available/);
  const sold = sellBooth(reserved, booth.id);
  const boothRecord = read(sold.db, 'event.booth', booth.id);
  const boothInvoice = read(sold.db, 'account.move', boothRecord.invoice_id);
  assert.deepEqual([boothRecord.state, boothInvoice.move_type, boothInvoice.state], ['sold', 'out_invoice', 'draft']);
  assert.deepEqual(boothInvoice.invoice_line_ids[0], { product_id: null, name: 'Event booth: B-12', qty: 1, price_unit: 500, tax: 14 });
  assert.throws(() => sellBooth(sold.db, booth.id), /already been invoiced/);

  const sponsor = create(sold.db, 'event.sponsor', { event_id: eventId, partner_id: contact.id, level: 'gold', amount: 1200 });
  const invoiced = invoiceSponsor(sponsor.db, sponsor.id);
  const sponsorRecord = read(invoiced.db, 'event.sponsor', sponsor.id);
  const sponsorInvoice = read(invoiced.db, 'account.move', sponsorRecord.invoice_id);
  assert.deepEqual([sponsorInvoice.move_type, sponsorInvoice.state, sponsorInvoice.invoice_line_ids[0].price_unit], ['out_invoice', 'draft', 1200]);
  assert.throws(() => invoiceSponsor(invoiced.db, sponsor.id), /already been invoiced/);
});

test('registration invoicing bills only active attendees with a priced ticket, once each', () => {
  const { db: d0, id: eventId } = event(emptyDb(), {
    ticket_ids: [{ name: 'Standard', price: 80, seats_max: 0 }, { name: 'Free', price: 0, seats_max: 0 }],
  });
  const contact = create(d0, 'res.partner', { name: 'Nadia' });
  const paid = create(contact.db, 'event.registration', { name: 'Nadia', event_id: eventId, partner_id: contact.id, ticket: 'Standard' });
  const free = create(paid.db, 'event.registration', { name: 'Free guest', event_id: eventId, ticket: 'Free' });
  const cancelled = create(free.db, 'event.registration', { name: 'Cancelled', event_id: eventId, ticket: 'Standard', state: 'cancel' });
  const result = invoiceRegistrations(cancelled.db, eventId);
  assert.equal(result.invoices.length, 1);
  const registration = read(result.db, 'event.registration', paid.id);
  const invoice = read(result.db, 'account.move', registration.invoice_id);
  assert.deepEqual([invoice.move_type, invoice.state, invoice.partner_id, invoice.invoice_line_ids[0].price_unit], ['out_invoice', 'draft', contact.id, 80]);
  assert.equal(read(result.db, 'event.registration', free.id).invoice_id, null);
  assert.equal(invoiceRegistrations(result.db, eventId).invoices.length, 0);
});

test('event dashboard reports capacity, active attendance, and ticket, booth, and sponsor revenue', () => {
  const { db: d0, id: eventId } = event(emptyDb(), {
    seats_max: 12,
    ticket_ids: [{ name: 'Standard', price: 100, seats_max: 0 }],
  });
  const first = create(d0, 'event.registration', { name: 'Attended', event_id: eventId, ticket: 'Standard', checked_in: true, state: 'done' });
  const second = create(first.db, 'event.registration', { name: 'Registered', event_id: eventId, ticket: 'Standard' });
  const cancelled = create(second.db, 'event.registration', { name: 'Cancelled', event_id: eventId, ticket: 'Standard', state: 'cancel' });
  const booth = create(cancelled.db, 'event.booth', { event_id: eventId, name: 'A-1', price: 50, state: 'sold' });
  const sponsor = create(booth.db, 'event.sponsor', { event_id: eventId, partner_id: 3, level: 'silver', amount: 200 });
  assert.deepEqual(eventDashboard(sponsor.db, eventId), {
    seats: 12,
    registered: 2,
    checkedIn: 1,
    attendanceRate: 50,
    revenue: { tickets: 200, booths: 50, sponsors: 200 },
  });
});

test('event seed still loads and each new event model has list, kanban, and form views', () => {
  const db = seed();
  assert.ok(db.records['event.event'].length > 0);
  assert.ok(db.records['event.registration'].length > 0);
  for (const model of ['event.track', 'event.sponsor', 'event.booth', 'event.question']) {
    assert.ok(models[model].views.includes('list'));
    assert.ok(models[model].views.includes('kanban'));
    assert.ok(models[model].form);
  }
});
