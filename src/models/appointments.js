// Appointments: bookable types with staff, weekly availabilities and questions; bookings with slots computed in the type's timezone.
import { create, postNote, read, search, write } from '../orm.js';
import { addDays } from './common.js';

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;
const PHONE = /^\+?[\d\s().-]{6,20}$/;
const ACTIVE = (b) => b.state !== 'cancelled';

const minutes = (hhmm) => (/^\d{2}:\d{2}$/.test(hhmm ?? '') ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) : null);
const two = (n) => String(n).padStart(2, '0');
/** Local 'YYYY-MM-DDTHH:MM' strings are compared as text and shifted as naive UTC (no DST inside one string). */
const fmt = (d) => `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
export const addMinutes = (local, m) => fmt(new Date(Date.parse(`${local}:00Z`) + m * 6e4));
const weekdayOf = (date) => String(new Date(`${date}T00:00:00Z`).getUTCDay());
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

/** Wall-clock time of `now` in `timeZone` as 'YYYY-MM-DDTHH:MM'. */
export function localNow(now = new Date(), timeZone = 'Africa/Cairo') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const durationOf = (type) => Math.max(5, Number(type.duration) || 60);
const staffOf = (type) => [...new Set((type.staff_ids ?? []).map((l) => l.employee_id).filter(Boolean))];
const endOf = (type, start) => addMinutes(start, durationOf(type));

/** Calendar events of an employee: the attendee contact shares the employee's work email. */
function eventsOf(db, employeeId) {
  const email = read(db, 'hr.employee', employeeId)?.work_email?.toLowerCase();
  if (!email || !db.records['calendar.event']) return [];
  const attends = (e) => [e.partner_id, ...(e.attendee_ids ?? []).map((a) => a.partner_id)]
    .some((id) => id && read(db, 'res.partner', id)?.email?.toLowerCase() === email);
  return search(db, 'calendar.event').filter(attends).map((e) => {
    const start = `${e.start}T${e.start_time && minutes(e.start_time) != null ? e.start_time : '00:00'}`;
    return { start, end: e.start_time ? addMinutes(start, Math.round((Number(e.duration) || 1) * 60)) : `${addDays(e.start, 1)}T00:00` };
  });
}

/** Why an employee cannot take [start, end): another booking (any type), validated time off or a calendar event. */
function staffBlocked(db, employeeId, slot, ignore) {
  const bookings = (db.records['appointment.booking'] ?? []).filter((b) => ACTIVE(b) && b.staff_id === employeeId && !ignore(b) && overlaps(b, slot));
  if (bookings.length) return 'booking';
  const day = slot.start.slice(0, 10);
  if ((db.records['hr.leave'] ?? []).some((l) => l.state === 'validate' && l.employee_id === employeeId && l.date_from <= day && day <= l.date_to)) return 'leave';
  return eventsOf(db, employeeId).some((e) => overlaps(e, slot)) ? 'event' : null;
}

/** Bookings of this type starting exactly at `start` (they share the slot's capacity). */
const sameSlot = (db, type, start, excludeId) => (db.records['appointment.booking'] ?? [])
  .filter((b) => ACTIVE(b) && b.id !== excludeId && b.type_id === type.id && b.start === start);

/** Staff still able to take the slot: not blocked elsewhere and below the per-slot capacity. */
function freeStaff(db, type, slot, pool, excludeId) {
  const capacity = Math.max(1, Number(type.capacity) || 1);
  const here = sameSlot(db, type, slot.start, excludeId);
  const ignore = (b) => b.id === excludeId || (b.type_id === type.id && b.start === slot.start);
  return pool.filter((s) => (s == null || !staffBlocked(db, s, slot, ignore)) && here.filter((b) => (b.staff_id ?? null) === s).length < capacity);
}

/**
 * Free slots of a type, day by day, in the type's timezone.
 * @returns {{ date: string, times: { start: string, end: string, staffIds: number[] }[] }[]}
 */
export function availableSlots(db, type, { from, days = 14, staffId = null, now = new Date() } = {}) {
  const nowLocal = localNow(now, type.timezone || 'Africa/Cairo');
  const earliest = addMinutes(nowLocal, (Number(type.min_schedule_hours ?? 1) || 0) * 60);
  const latest = addMinutes(nowLocal, (Number(type.max_schedule_days ?? 15) || 0) * 1440);
  const staff = staffOf(type);
  const pool = staffId != null ? staff.filter((s) => s === staffId) : staff.length ? staff : [null];
  const duration = durationOf(type);
  const step = Math.max(5, Number(type.slot_interval) || duration);
  const first = from || nowLocal.slice(0, 10);
  return Array.from({ length: Math.max(0, Math.min(Number(days) || 0, 62)) }, (_, i) => {
    const date = addDays(first, i);
    const times = (type.slot_ids ?? []).filter((w) => String(w.weekday) === weekdayOf(date)).flatMap((w) => {
      const out = [];
      for (let m = minutes(w.start); m != null && minutes(w.end) != null && m + duration <= minutes(w.end); m += step) {
        const start = `${date}T${two(Math.floor(m / 60))}:${two(m % 60)}`;
        if (start < earliest || start > latest) continue;
        const free = freeStaff(db, type, { start, end: addMinutes(start, duration) }, pool);
        if (free.length) out.push({ start, end: addMinutes(start, duration), staffIds: free.filter((s) => s != null) });
      }
      return out;
    }).sort((a, b) => a.start.localeCompare(b.start)).filter((t, k, all) => k === 0 || all[k - 1].start !== t.start);
    return { date, times };
  });
}

/** The least busy of `candidates` on `date` (fewest active bookings), first in the type's order on ties. */
function leastBusy(db, candidates, date) {
  const load = (s) => (db.records['appointment.booking'] ?? []).filter((b) => ACTIVE(b) && b.staff_id === s && b.start?.slice(0, 10) === date).length;
  return candidates.reduce((best, s) => (best == null || load(s) < load(best) ? s : best), null);
}

const meetingUrl = () => `https://meet.example/${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

/** Contact matched by email (case-insensitive), else created. */
function contactFor(db, { name, email, phone }) {
  const known = search(db, 'res.partner').find((p) => p.email?.toLowerCase() === email.toLowerCase());
  return known ? { db, id: known.id } : create(db, 'res.partner', { name, email, phone, tag_ids: ['Appointment'] });
}

/**
 * Book a free slot: validates the slot, answers, email and phone, assigns staff, links a contact,
 * adds a meeting link (online) and a draft invoice (paid), and logs it on the contact.
 * @returns {{ db: object, id: number }}
 */
export function bookAppointment(db, type, { start, staffId = null, name, email, phone = '', answers = [], now = new Date() } = {}) {
  if (!type) throw new Error('Unknown appointment type');
  if (!String(name ?? '').trim()) throw new Error('Enter your name');
  if (!EMAIL.test(String(email ?? '').trim())) throw new Error('Enter a valid email address');
  if (phone && !PHONE.test(String(phone).trim())) throw new Error('Enter a valid phone number');
  if (!LOCAL.test(start ?? '')) throw new Error('Pick a time');
  const given = Object.fromEntries((Array.isArray(answers) ? answers : []).map((a) => [a?.question, String(a?.answer ?? '').trim()]));
  const missing = (type.questions ?? []).find((q) => q.required && !given[q.label]);
  if (missing) throw new Error(`Please answer: ${missing.label}`);
  const chosen = type.assign_method === 'chosen' && staffId != null ? staffId : null;
  const slot = availableSlots(db, type, { from: start.slice(0, 10), days: 1, staffId: chosen, now })[0]?.times.find((t) => t.start === start);
  if (!slot) throw new Error('This slot is no longer available');
  const staff_id = chosen ?? leastBusy(db, slot.staffIds, start.slice(0, 10));
  const contact = contactFor(db, { name: name.trim(), email: email.trim(), phone: String(phone).trim() });
  const booking = create(contact.db, 'appointment.booking', {
    type_id: type.id, staff_id, partner_id: contact.id, name: name.trim(), email: email.trim(), phone: String(phone).trim(), start, end: slot.end, state: 'booked',
    answers: (type.questions ?? []).filter((q) => given[q.label]).map((q) => ({ question: q.label, answer: given[q.label].slice(0, 2000) })),
    ...(type.is_online ? { meeting_url: meetingUrl() } : {}),
  });
  let next = booking.db;
  if (Number(type.price) > 0) {
    const invoice = create(next, 'account.move', {
      move_type: 'out_invoice', partner_id: contact.id, invoice_origin: type.name, invoice_date: start.slice(0, 10), invoice_date_due: start.slice(0, 10),
      invoice_line_ids: [{ name: `${type.name} (${start.replace('T', ' ')})`, qty: 1, price_unit: Number(type.price), tax: 0 }],
    });
    next = write(invoice.db, 'appointment.booking', booking.id, { invoice_id: invoice.id });
  }
  const host = staff_id ? ` with ${read(next, 'hr.employee', staff_id)?.name ?? ''}` : '';
  return { db: postNote(next, 'res.partner', contact.id, `Appointment booked: ${type.name} on ${start.replace('T', ' ')}${host}`), id: booking.id };
}

/** Cancel a booking before it starts; its slot becomes free again. */
export function cancelBooking(db, id, { now = new Date() } = {}) {
  const b = read(db, 'appointment.booking', id);
  if (!b) throw new Error('Booking not found');
  if (b.state !== 'booked') throw new Error('Only booked appointments can be cancelled');
  const type = read(db, 'appointment.type', b.type_id);
  if (localNow(now, type?.timezone || 'Africa/Cairo') >= b.start) throw new Error('An appointment can only be cancelled before it starts');
  return write(db, 'appointment.booking', id, { state: 'cancelled' });
}

/** Staff conflicts and slot capacity, also for bookings made in the back office or through a sync. */
export function bookingGuard(db, b) {
  if (!ACTIVE(b)) return null;
  if (!LOCAL.test(b.start ?? '')) return 'Enter the start as YYYY-MM-DDTHH:MM';
  const type = read(db, 'appointment.type', b.type_id);
  if (!type) return null;
  const slot = { start: b.start, end: b.end && b.end > b.start ? b.end : endOf(type, b.start) };
  const capacity = Math.max(1, Number(type.capacity) || 1);
  const here = sameSlot(db, type, b.start, b.id).filter((x) => (x.staff_id ?? null) === (b.staff_id ?? null));
  if (here.length >= capacity) return 'This slot is already booked';
  if (b.staff_id && staffBlocked(db, b.staff_id, slot, (x) => x.id === b.id || (x.type_id === type.id && x.start === b.start)) === 'booking') {
    return `${read(db, 'hr.employee', b.staff_id)?.name ?? 'This staff member'} is already booked at that time`;
  }
  return null;
}

/** Older records (duration in hours, one host, date + time) in the current field names; idempotent. */
export function migrateAppointments(db) {
  if (!db?.records) return db;
  const types = (db.records['appointment.type'] ?? []).map(({ user_id, ...t }) => (user_id === undefined ? t : {
    ...t, duration: Math.round((Number(t.duration) || 1) * 60), staff_ids: t.staff_ids?.length ? t.staff_ids : user_id ? [{ employee_id: user_id }] : [],
  }));
  const typeOf = (id) => types.find((t) => t.id === id) ?? {};
  const STATES = { done: 'attended', cancel: 'cancelled' };
  const bookings = (db.records['appointment.booking'] ?? []).map(({ date, time, ...b }) => {
    if (date === undefined) return b;
    const start = `${date}T${minutes(time) != null ? time : '09:00'}`;
    return { ...b, start: b.start ?? start, end: b.end ?? endOf(typeOf(b.type_id), start), state: STATES[b.state] ?? b.state };
  });
  return { ...db, records: { ...db.records, 'appointment.type': types, 'appointment.booking': bookings } };
}

const button = (label, state, extra = {}) => ({ label, vals: { state }, when: (r) => r.state === 'booked', ...extra });

export const appointmentModels = {
  'appointment.type': {
    label: 'Appointment Types',
    fields: {
      name: { type: 'char', label: 'Appointment Title', required: true },
      description: { type: 'text', label: 'Description' },
      image: { type: 'binary', label: 'Image' },
      location: { type: 'char', label: 'Location' },
      is_online: { type: 'boolean', label: 'Online Meeting' },
      duration: { type: 'integer', label: 'Duration (minutes)' },
      slot_interval: { type: 'integer', label: 'Slot Interval (minutes)' },
      is_published: { type: 'boolean', label: 'Published on Website' },
      price: { type: 'monetary', label: 'Price' },
      staff_ids: {
        type: 'one2many', label: 'Staff',
        fields: { employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Employee' } },
        newLine: () => ({ employee_id: null }),
      },
      assign_method: { type: 'selection', label: 'Assignment', options: [['random', 'Random'], ['chosen', 'Chosen by customer']] },
      slot_ids: {
        type: 'one2many', label: 'Availabilities',
        fields: {
          weekday: { type: 'selection', label: 'Day', options: [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']] },
          start: { type: 'char', label: 'From (HH:MM)' }, end: { type: 'char', label: 'To (HH:MM)' },
        },
        newLine: () => ({ weekday: '1', start: '09:00', end: '17:00' }),
      },
      min_schedule_hours: { type: 'float', label: 'Book at least (hours ahead)' },
      max_schedule_days: { type: 'integer', label: 'Book at most (days ahead)' },
      capacity: { type: 'integer', label: 'Bookings per Slot' },
      questions: {
        type: 'one2many', label: 'Questions',
        fields: { label: { type: 'char', label: 'Question' }, required: { type: 'boolean', label: 'Required' } },
        newLine: () => ({ label: '', required: false }),
      },
      timezone: { type: 'char', label: 'Timezone' },
    },
    defaults: () => ({ duration: 60, capacity: 1, min_schedule_hours: 1, max_schedule_days: 15, assign_method: 'random', timezone: 'Africa/Cairo', price: 0, staff_ids: [], slot_ids: [], questions: [] }),
    onchange: (r, field) => (field === 'duration' && !r.slot_interval ? { slot_interval: r.duration } : {}),
    kanban: { title: 'name', lines: ['duration', 'location', 'price'], counter: { label: 'Bookings', model: 'appointment.booking', field: 'type_id' } },
    list: ['name', 'duration', 'location', 'price', 'is_published'],
    form: {
      title: 'name',
      smart: [{ label: 'Bookings', model: 'appointment.booking', field: 'type_id', target: 'appointments/bookings' }],
      groups: [['duration', 'slot_interval', 'location', 'is_online', 'price'], ['assign_method', 'capacity', 'min_schedule_hours', 'max_schedule_days', 'timezone', 'is_published']],
      tabs: [
        { label: 'Availabilities', fields: ['slot_ids'] }, { label: 'Staff', fields: ['staff_ids'] }, { label: 'Questions', fields: ['questions'] },
        { label: 'Description', fields: ['description', 'image'] },
      ],
    },
  },

  'appointment.booking': {
    label: 'Bookings',
    fields: {
      name: { type: 'char', label: 'Booked by', required: true },
      type_id: { type: 'many2one', relation: 'appointment.type', label: 'Appointment', required: true },
      staff_id: { type: 'many2one', relation: 'hr.employee', label: 'Staff' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      start: { type: 'char', label: 'Start (YYYY-MM-DDTHH:MM)', required: true },
      end: { type: 'char', label: 'End' },
      date: { type: 'date', label: 'Date', compute: (r) => r.start?.slice(0, 10) ?? null },
      time: { type: 'char', label: 'Time', compute: (r) => r.start?.slice(11, 16) ?? null },
      answers: {
        type: 'one2many', label: 'Answers',
        fields: { question: { type: 'char', label: 'Question' }, answer: { type: 'text', label: 'Answer' } },
      },
      meeting_url: { type: 'char', label: 'Meeting Link' },
      invoice_id: { type: 'many2one', relation: 'account.move', label: 'Invoice', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['booked', 'Booked'], ['attended', 'Attended'], ['cancelled', 'Cancelled'], ['no_show', 'No Show']] },
    },
    defaults: () => ({ state: 'booked', answers: [] }),
    guard: (db, before, after) => bookingGuard(db, after),
    groupBys: ['type_id', 'staff_id', 'state', 'date'],
    kanban: { groupBy: 'state', title: 'name', lines: ['type_id', 'staff_id', 'start'] },
    list: ['start', 'name', 'type_id', 'staff_id', 'partner_id', 'state'],
    views: ['calendar', 'list', 'kanban', 'pivot'],
    calendar: { date: 'date', time: 'time' },
    pivot: { row: 'type_id', col: 'staff_id' },
    form: {
      statusbar: 'state',
      buttons: [
        button('Mark Attended', 'attended', { primary: true }),
        button('No Show', 'no_show'),
        { label: 'Cancel', when: (r) => r.state === 'booked', run: (db, r) => ({ db: cancelBooking(db, r.id) }) },
      ],
      title: 'name',
      groups: [['type_id', 'staff_id', 'partner_id', 'email', 'phone'], ['start', 'end', 'meeting_url', 'invoice_id']],
      tabs: [{ label: 'Answers', fields: ['answers'] }],
      chatter: true,
    },
  },
};
