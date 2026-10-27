// Event talks, sponsors, booths, questions, and attendee operations.
import { create, read, search, write } from '../orm.js';
import { pad, today } from './common.js';
import { moreModels } from './more.js';

const state = (options, label = 'Status') => ({ type: 'selection', label, tracking: true, options });
const eventField = { type: 'many2one', relation: 'event.event', label: 'Event', required: true };
const invoiceField = { type: 'many2one', relation: 'account.move', label: 'Invoice', readonly: true };
const sortTracks = (a, b) => String(a.date ?? '').localeCompare(String(b.date ?? ''))
  || String(a.start ?? '').localeCompare(String(b.start ?? '')) || Number(a.id) - Number(b.id);

const visibleTracks = (db, eventId) => search(db, 'event.track')
  .filter((track) => track.event_id === eventId && track.is_published && track.stage !== 'refused')
  .sort(sortTracks);

const minuteOfDay = (value) => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const trackStart = (track) => {
  const time = minuteOfDay(track.start);
  const date = Date.parse(`${track.date}T00:00:00Z`);
  return Number.isFinite(date) && time !== null ? date / 60000 + time : null;
};

const trackEnd = (track) => {
  const start = trackStart(track);
  return start === null ? null : start + Math.max(0, Number(track.duration) || 0);
};

function makeInvoice(db, { partner_id, origin, name, price }) {
  return create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner_id ?? null,
    invoice_date: today(),
    invoice_origin: origin,
    invoice_line_ids: [{ product_id: null, name, qty: 1, price_unit: Number(price) || 0, tax: 14 }],
  });
}

/** Check in one attendee by badge, returning a new database or refusing an invalid scan. */
export function checkIn(db, barcode, now = new Date()) {
  const registration = search(db, 'event.registration').find((r) => r.barcode === barcode);
  if (!registration) throw new Error('Unknown badge code');
  if (['cancel', 'cancelled'].includes(registration.state)) throw new Error('Cancelled registrations cannot check in');
  if (registration.checked_in || registration.state === 'done') throw new Error('Attendee is already checked in');
  const checkInTime = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return write(db, 'event.registration', registration.id, {
    checked_in: true,
    check_in_time: checkInTime,
    state: 'done',
    date_checked_in: checkInTime.slice(0, 10),
  });
}

/** Overlapping pairs among published, non-refused talks in the same room. */
export function trackConflicts(db, eventId) {
  const tracks = visibleTracks(db, eventId);
  const pairs = [];
  for (let left = 0; left < tracks.length; left += 1) {
    for (let right = left + 1; right < tracks.length; right += 1) {
      const a = tracks[left];
      const b = tracks[right];
      if (!a.location || a.location !== b.location) continue;
      const aStart = trackStart(a);
      const bStart = trackStart(b);
      const aEnd = trackEnd(a);
      const bEnd = trackEnd(b);
      if (aStart !== null && bStart !== null && aEnd !== null && bEnd !== null && aStart < bEnd && bStart < aEnd) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Published talks grouped by room with same-room overlaps attached to the agenda. */
export function agenda(db, eventId) {
  const tracks = visibleTracks(db, eventId);
  const conflicts = trackConflicts(db, eventId);
  const byLocation = new Map();
  for (const track of tracks) {
    const location = track.location || 'Unassigned';
    byLocation.set(location, [...(byLocation.get(location) ?? []), track]);
  }
  const groups = [...byLocation].map(([location, roomTracks]) => ({
    location,
    tracks: roomTracks,
    conflicts: conflicts.filter(([a]) => (a.location || 'Unassigned') === location),
  }));
  return { groups, conflicts };
}

/** Reserve an available booth for a partner. */
export function reserveBooth(db, boothId, partnerId) {
  const booth = read(db, 'event.booth', boothId);
  if (!booth) throw new Error('Booth not found');
  if (booth.state !== 'available') throw new Error('Only available booths can be reserved');
  if (partnerId == null) throw new Error('Select a partner to reserve this booth');
  return write(db, 'event.booth', booth.id, { state: 'reserved', partner_id: partnerId });
}

/** Invoice the booth partner once, then mark the booth sold. */
export function sellBooth(db, boothId) {
  const booth = read(db, 'event.booth', boothId);
  if (!booth) throw new Error('Booth not found');
  if (booth.invoice_id || booth.state === 'sold') throw new Error('Booth has already been invoiced');
  if (booth.partner_id == null) throw new Error('Assign a partner before selling this booth');
  const event = read(db, 'event.event', booth.event_id);
  const invoice = makeInvoice(db, {
    partner_id: booth.partner_id,
    origin: `${event?.name ?? 'Event'} - ${booth.name}`,
    name: `Event booth: ${booth.name}`,
    price: booth.price,
  });
  const next = write(invoice.db, 'event.booth', booth.id, { state: 'sold', invoice_id: invoice.id });
  return { db: next, id: invoice.id, invoiceId: invoice.id };
}

/** Invoice a sponsor once. */
export function invoiceSponsor(db, sponsorId) {
  const sponsor = read(db, 'event.sponsor', sponsorId);
  if (!sponsor) throw new Error('Sponsor not found');
  if (sponsor.invoice_id) throw new Error('Sponsor has already been invoiced');
  if (sponsor.partner_id == null) throw new Error('Select a partner before invoicing this sponsor');
  const event = read(db, 'event.event', sponsor.event_id);
  const invoice = makeInvoice(db, {
    partner_id: sponsor.partner_id,
    origin: `${event?.name ?? 'Event'} - sponsorship`,
    name: `${event?.name ?? 'Event'} ${sponsor.level} sponsorship`,
    price: sponsor.amount,
  });
  const next = write(invoice.db, 'event.sponsor', sponsor.id, { invoice_id: invoice.id });
  return { db: next, id: invoice.id, invoiceId: invoice.id };
}

/** Create one draft invoice for each active registration with a priced ticket and no invoice. */
export function invoiceRegistrations(db, eventId) {
  const event = read(db, 'event.event', eventId);
  if (!event) throw new Error('Event not found');
  const registrations = search(db, 'event.registration')
    .filter((r) => r.event_id === eventId && !['cancel', 'cancelled'].includes(r.state) && !r.invoice_id);
  let next = db;
  const invoices = [];
  for (const registration of registrations) {
    const ticket = (event.ticket_ids ?? []).find((item) => item.name === registration.ticket);
    const price = Number(ticket?.price) || 0;
    if (!(price > 0)) continue;
    const invoice = makeInvoice(next, {
      partner_id: registration.partner_id,
      origin: `${event.name} - ${registration.name}`,
      name: `${event.name} ticket: ${registration.ticket}`,
      price,
    });
    next = write(invoice.db, 'event.registration', registration.id, { invoice_id: invoice.id });
    invoices.push({ registration_id: registration.id, invoice_id: invoice.id });
  }
  return { db: next, invoices };
}

/** Event capacity, attendance, and contracted revenue totals. Attendance rate is a percentage. */
export function eventDashboard(db, eventId) {
  const event = read(db, 'event.event', eventId);
  if (!event) throw new Error('Event not found');
  const registrations = search(db, 'event.registration').filter((r) => r.event_id === eventId && !['cancel', 'cancelled'].includes(r.state));
  const checkedIn = registrations.filter((r) => r.checked_in || r.state === 'done').length;
  const tickets = registrations.reduce((sum, registration) => {
    const ticket = (event.ticket_ids ?? []).find((item) => item.name === registration.ticket);
    return sum + (Number(ticket?.price) || 0);
  }, 0);
  const booths = search(db, 'event.booth').filter((b) => b.event_id === eventId && b.state === 'sold')
    .reduce((sum, booth) => sum + (Number(booth.price) || 0), 0);
  const sponsors = search(db, 'event.sponsor').filter((s) => s.event_id === eventId)
    .reduce((sum, sponsor) => sum + (Number(sponsor.amount) || 0), 0);
  return {
    seats: Number(event.seats_max) || 0,
    registered: registrations.length,
    checkedIn,
    attendanceRate: registrations.length ? (checkedIn / registrations.length) * 100 : 0,
    revenue: { tickets, booths, sponsors },
  };
}

const baseEvent = moreModels['event.event'];

export const eventsPlusModels = {
  'event.event': {
    ...baseEvent,
    form: {
      ...baseEvent.form,
      buttons: [...(baseEvent.form.buttons ?? []), { label: 'Invoice Registrations', when: (r) => (r.ticket_ids ?? []).some((t) => Number(t.price) > 0), run: (db, r) => {
        const out = invoiceRegistrations(db, r.id);
        if (!out.invoices.length) throw new Error('Every priced registration is already invoiced');
        return { db: out.db };
      } }],
    },
  },
  'event.registration': {
    label: 'Attendees',
    fields: {
      name: { type: 'char', label: 'Attendee Name', required: true },
      event_id: eventField,
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      ticket: { type: 'char', label: 'Ticket' },
      barcode: { type: 'char', label: 'Badge Code', readonly: true, unique: true },
      date_checked_in: { type: 'date', label: 'Checked in on', readonly: true },
      checked_in: { type: 'boolean', label: 'Checked In', readonly: true },
      check_in_time: { type: 'char', label: 'Check-in Time', readonly: true },
      answers: {
        type: 'one2many', label: 'Answers',
        fields: {
          question_id: { type: 'many2one', relation: 'event.question', label: 'Question' },
          answer: { type: 'char', label: 'Answer' },
        },
        newLine: () => ({ question_id: null, answer: '' }),
      },
      invoice_id: invoiceField,
      state: state([['open', 'Registered'], ['done', 'Attended'], ['cancel', 'Cancelled']]),
    },
    defaults: (id) => ({ state: 'open', barcode: `EVT${pad(id, 8)}`, checked_in: false, check_in_time: null, answers: [], invoice_id: null }),
    // Seats are capped per event and ticket type; cancelled registrations free their seat.
    guard: (db, before, after) => {
      if (after.barcode && (db.records['event.registration'] ?? []).some((r) => r.id !== after.id && r.event_id === after.event_id && r.barcode === after.barcode)) return 'Badge code must be unique within an event';
      if (after.state === 'cancel' || (before && before.state !== 'cancel' && before.event_id === after.event_id && before.ticket === after.ticket)) return null;
      const event = read(db, 'event.event', after.event_id);
      const taken = (db.records['event.registration'] ?? []).filter((r) => r.id !== after.id && r.event_id === after.event_id && r.state !== 'cancel');
      if (Number(event?.seats_max) > 0 && taken.length >= Number(event.seats_max)) return `${event.name} is sold out`;
      const ticket = (event?.ticket_ids ?? []).find((t) => t.name === after.ticket);
      if (ticket && Number(ticket.seats_max) > 0 && taken.filter((r) => r.ticket === ticket.name).length >= Number(ticket.seats_max)) return `No ${ticket.name} tickets left`;
      return null;
    },
    groupBys: ['event_id', 'state'],
    kanban: { groupBy: 'state', title: 'name', lines: ['event_id', 'email'] },
    list: ['name', 'event_id', 'email', 'phone', 'ticket', 'state', 'checked_in', 'invoice_id'],
    views: ['list', 'kanban'],
    form: {
      statusbar: 'state',
      statusbarClickable: true,
      buttons: [
        { label: 'Check in', primary: true, when: (r) => r.state === 'open' && !r.checked_in, run: (db, r) => ({ db: checkIn(db, r.barcode) }) },
        { label: 'Cancel Registration', when: (r) => r.state === 'open', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['event_id', 'ticket', 'partner_id'], ['email', 'phone', 'barcode', 'checked_in', 'check_in_time'], ['invoice_id']],
      tabs: [{ label: 'Answers', fields: ['answers'] }],
      chatter: true,
    },
  },
  'event.track': {
    label: 'Talks',
    fields: {
      event_id: eventField,
      name: { type: 'char', label: 'Talk Title', required: true },
      speaker_name: { type: 'char', label: 'Speaker' },
      speaker_email: { type: 'char', label: 'Speaker Email' },
      date: { type: 'date', label: 'Date' },
      start: { type: 'char', label: 'Start Time' },
      duration: { type: 'integer', label: 'Duration (minutes)' },
      location: { type: 'char', label: 'Room' },
      stage: state([['proposal', 'Proposal'], ['confirmed', 'Confirmed'], ['announced', 'Announced'], ['refused', 'Refused']]),
      is_published: { type: 'boolean', label: 'Published' },
    },
    defaults: () => ({ stage: 'proposal', is_published: false, duration: 30 }),
    groupBys: ['event_id', 'date', 'location', 'stage'],
    kanban: { groupBy: 'stage', title: 'name', lines: ['event_id', 'date', 'start', 'location'] },
    list: ['name', 'event_id', 'speaker_name', 'date', 'start', 'duration', 'location', 'stage', 'is_published'],
    views: ['list', 'kanban', 'calendar'],
    calendar: { date: 'date' },
    form: { statusbar: 'stage', title: 'name', groups: [['event_id', 'name', 'stage', 'is_published'], ['speaker_name', 'speaker_email'], ['date', 'start', 'duration', 'location']], chatter: false },
  },
  'event.sponsor': {
    label: 'Sponsors',
    fields: {
      event_id: eventField,
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Sponsor', required: true },
      level: { type: 'selection', label: 'Level', options: [['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze']] },
      amount: { type: 'monetary', label: 'Sponsorship Amount' },
      invoice_id: invoiceField,
    },
    defaults: () => ({ level: 'silver', amount: 0, invoice_id: null }),
    groupBys: ['event_id', 'level'],
    kanban: { groupBy: 'level', title: 'partner_id', lines: ['event_id', 'amount'] },
    list: ['event_id', 'partner_id', 'level', 'amount', 'invoice_id'],
    views: ['list', 'kanban'],
    form: {
      title: 'partner_id',
      buttons: [{ label: 'Invoice Sponsor', primary: true, when: (r) => !r.invoice_id, run: (db, r) => invoiceSponsor(db, r.id) }],
      groups: [['event_id', 'partner_id', 'level', 'amount'], ['invoice_id']],
      chatter: false,
    },
  },
  'event.booth': {
    label: 'Booths',
    fields: {
      event_id: eventField,
      name: { type: 'char', label: 'Booth', required: true },
      category: { type: 'selection', label: 'Category', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
      price: { type: 'monetary', label: 'Price' },
      state: state([['available', 'Available'], ['reserved', 'Reserved'], ['sold', 'Sold']]),
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      invoice_id: invoiceField,
    },
    defaults: () => ({ category: 'small', price: 0, state: 'available', partner_id: null, invoice_id: null }),
    groupBys: ['event_id', 'category', 'state'],
    kanban: { groupBy: 'state', title: 'name', lines: ['event_id', 'category', 'partner_id', 'price'] },
    list: ['name', 'event_id', 'category', 'price', 'state', 'partner_id', 'invoice_id'],
    views: ['list', 'kanban'],
    form: {
      statusbar: 'state',
      title: 'name',
      buttons: [
        { label: 'Reserve Booth', when: (r) => r.state === 'available' && r.partner_id != null, run: (db, r) => ({ db: reserveBooth(db, r.id, r.partner_id) }) },
        { label: 'Sell Booth', primary: true, when: (r) => r.state !== 'sold' && r.partner_id != null, run: (db, r) => sellBooth(db, r.id) },
      ],
      groups: [['event_id', 'name', 'category', 'price'], ['state', 'partner_id', 'invoice_id']],
      chatter: false,
    },
  },
  'event.question': {
    label: 'Questions',
    fields: {
      event_id: eventField,
      title: { type: 'char', label: 'Question', required: true },
      required: { type: 'boolean', label: 'Required' },
      answers: { type: 'char', label: 'Answer Options', help: 'Comma-separated options; leave empty for free text.' },
    },
    defaults: () => ({ required: false, answers: '' }),
    groupBys: ['event_id', 'required'],
    kanban: { groupBy: 'required', title: 'title', lines: ['event_id', 'answers'] },
    list: ['title', 'event_id', 'required', 'answers'],
    views: ['list', 'kanban'],
    form: { title: 'title', groups: [['event_id', 'title'], ['required', 'answers']], chatter: false },
  },
};
