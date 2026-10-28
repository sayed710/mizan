// Stations, planned visits, badge check-in, refreshments and evacuation reporting.
import { create, postNote, read, search, write } from '../orm.js';
import { apps2Models } from './apps2.js';
import { round } from '../money.js';

const MODEL = 'frontdesk.visitor';
const filled = (v) => v != null && String(v).trim() !== '';
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function dateValue(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid date');
  return ms;
}

function timestamp(at) {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(at)) throw new Error('Enter a valid ISO date and time');
  dateValue(at.slice(0, 10));
  return { date: at.slice(0, 10), time: at.slice(11, 16), ms: Date.parse(`${at.slice(0, 16)}:00Z`) };
}

const startOf = (r) => Date.parse(`${r.date}T${r.check_in}:00Z`);
const duration = (r) => {
  const end = Date.parse(`${r.check_out_date || r.date}T${r.check_out}:00Z`);
  return r.check_in && r.check_out && Number.isFinite(end - startOf(r)) ? round(Math.max(0, end - startOf(r)) / 3600000) : 0;
};

function stationFor(db, id) {
  if (id == null) return null;
  const station = read(db, 'frontdesk.station', id);
  if (!station) throw new Error('Station not found');
  return station;
}

function hostFor(db, id) {
  if (id == null) return null;
  const host = read(db, 'hr.employee', id);
  if (!host || host.active === false) throw new Error('Host not found');
  return host;
}

function visitorFor(db, id) {
  const visitor = read(db, MODEL, id);
  if (!visitor) throw new Error('Visitor not found');
  return visitor;
}

function badgeFor(db, generateCode) {
  const used = new Set(search(db, MODEL, { includeArchived: true }).map((r) => r.badge_code));
  for (let i = 0; i < 20; i++) {
    const code = generateCode();
    if (typeof code !== 'string' || !/^[A-Za-z0-9-]{4,16}$/.test(code)) throw new Error('Badge code must contain 4 to 16 letters, digits or hyphens');
    if (!used.has(code)) return code;
  }
  throw new Error('Could not generate a unique badge code');
}

/** Plan a visit; an optional generator supplies unique short badge codes. */
export function planVisit(db, { name, hostId, date, time, stationId, email, company }, generateCode = () => crypto.randomUUID().slice(0, 8).toUpperCase()) {
  if (!filled(name)) throw new Error('Visitor name is required');
  dateValue(date);
  if (!clock.test(time ?? '')) throw new Error('Enter a valid planned time (HH:MM)');
  stationFor(db, stationId);
  hostFor(db, hostId);
  return create(db, MODEL, { name: name.trim(), host_id: hostId, station_id: stationId, email, company, date, planned_date: date, planned_time: time, stage_id: 'planned', badge_code: badgeFor(db, generateCode) });
}

function arrive(db, visitor, values, at) {
  const station = stationFor(db, values.station_id ?? visitor.station_id);
  const stamp = timestamp(at);
  if (visitor.stage_id !== 'planned') throw new Error('Visitor has already used this badge or is no longer planned');
  const r = { ...visitor, ...values };
  if (!filled(r.name)) throw new Error('Visitor name is required');
  for (const field of ['phone', 'email', 'company']) {
    if (station?.[`ask_${field}`] === 'required' && !filled(r[field])) throw new Error(`${field[0].toUpperCase() + field.slice(1)} is required at this station`);
  }
  const host = hostFor(db, r.host_id);
  const drink = r.drink_id;
  if (filled(drink) && (!station?.drink_offer || !(station.drink_ids ?? []).some((d) => d.name === drink))) throw new Error('Select a drink offered at this station');
  const duplicate = search(db, MODEL).some((v) => v.id !== r.id && v.stage_id === 'checked_in' && v.station_id === r.station_id
    && v.name.trim().toLowerCase() === r.name.trim().toLowerCase());
  if (duplicate) throw new Error('Visitor is already checked in');
  let next = write(db, MODEL, r.id, { ...values, date: stamp.date, check_in: stamp.time, check_out: null, check_out_date: null, stage_id: 'checked_in', drink_served: false, host_notified: !!host });
  if (host) {
    const mode = station?.notify_host || 'chat';
    const body = `${r.name} has checked in${station ? ` at ${station.name}` : ''}. Host: ${host.name}. Notification: ${mode}${mode !== 'chat' && host.work_email ? ` (${host.work_email})` : ''}.`;
    next = postNote(next, 'hr.employee', host.id, body);
    next = postNote(next, MODEL, r.id, body);
  }
  return { db: next, id: r.id };
}

/** Check in a planned badge or create a walk-in, enforcing station requirements. */
export function checkIn(db, { stationId, name, badgeCode, phone, email, company, hostId, drink }, at) {
  const planned = filled(badgeCode) ? search(db, MODEL).find((r) => r.badge_code === badgeCode) : null;
  if (filled(badgeCode) && !planned) throw new Error('Unknown visitor badge code');
  if (planned && stationId != null && planned.station_id != null && planned.station_id !== stationId) throw new Error('Badge belongs to another station');
  const station = stationFor(db, stationId ?? planned?.station_id);
  const values = Object.fromEntries(Object.entries({ phone, email, company, host_id: hostId, drink_id: drink }).filter(([, v]) => v !== undefined));
  if (drink !== undefined && typeof drink === 'number') values.drink_id = station?.drink_ids?.[drink]?.name ?? String(drink);
  if (planned) return arrive(db, planned, { ...values, station_id: station?.id }, at);
  if (!filled(name)) throw new Error('Visitor name is required');
  const created = create(db, MODEL, { name: name.trim(), station_id: station?.id, ...values });
  return arrive(created.db, read(created.db, MODEL, created.id), values, at);
}

/** Close one checked-in visitor, retaining the departure date for overnight visits. */
export function checkOut(db, visitorId, at) {
  const visitor = visitorFor(db, visitorId);
  const stamp = timestamp(at);
  if (visitor.stage_id !== 'checked_in') throw new Error('Visitor is not checked in');
  if (stamp.ms < startOf(visitor)) throw new Error('Check-out must not precede check-in');
  return write(db, MODEL, visitorId, { stage_id: 'checked_out', check_out: stamp.time, check_out_date: stamp.date });
}

/** Close every visitor still on site, excluding future check-ins. */
export function checkOutAll(db, at) {
  return onSite(db, at).reduce((next, r) => checkOut(next, r.id, at), db);
}

/** Mark an offered drink as served while its visitor is on site. */
export function serveDrink(db, visitorId) {
  const visitor = visitorFor(db, visitorId);
  if (visitor.stage_id !== 'checked_in' || !filled(visitor.drink_id)) throw new Error('A checked-in visitor must request a drink first');
  if (visitor.drink_served) throw new Error('Drink has already been served');
  return write(db, MODEL, visitorId, { drink_served: true });
}

/** Current evacuation list, with host records; not a historical occupancy query. */
export function onSite(db, at) {
  const stamp = timestamp(at);
  return search(db, MODEL).filter((r) => r.stage_id === 'checked_in' && startOf(r) <= stamp.ms)
    .map((r) => ({ ...r, host: r.host_id ? read(db, 'hr.employee', r.host_id) ?? null : null }));
}

/** Actual arrivals by day and host; averages include only completed visits. */
export function visitorReport(db, { from, to }) {
  if (dateValue(from) > dateValue(to)) throw new Error('The end date must not precede the start date');
  const visits = search(db, MODEL).filter((r) => r.check_in && ['checked_in', 'checked_out'].includes(r.stage_id) && r.date >= from && r.date <= to);
  const summary = (rows) => {
    const closed = rows.filter((r) => r.stage_id === 'checked_out');
    return { count: rows.length, average_duration: closed.length ? round(closed.reduce((sum, r) => sum + duration(r), 0) / closed.length) : 0 };
  };
  return {
    ...summary(visits),
    perDay: [...new Set(visits.map((r) => r.date))].sort().map((date) => ({ date, ...summary(visits.filter((r) => r.date === date)) })),
    perHost: [...new Set(visits.map((r) => r.host_id ?? null))].map((host_id) => ({ host_id, host: host_id ? read(db, 'hr.employee', host_id) ?? null : null, ...summary(visits.filter((r) => (r.host_id ?? null) === host_id)) })),
  };
}

const base = apps2Models[MODEL];
const now = () => new Date().toISOString();
const buttons = [
  { label: 'Check In', primary: true, when: (r) => r.stage_id === 'planned', run: (db, r) => arrive(db, visitorFor(db, r.id), {}, now()) },
  { label: 'Check Out', primary: true, when: (r) => r.stage_id === 'checked_in', run: (db, r) => ({ db: checkOut(db, r.id, now()) }) },
  { label: 'Drink Served', when: (r) => r.stage_id === 'checked_in' && filled(r.drink_id) && !r.drink_served, run: (db, r) => ({ db: serveDrink(db, r.id) }) },
  { label: 'Cancel', when: (r) => r.stage_id === 'planned', run: (db, r) => {
    if (visitorFor(db, r.id).stage_id !== 'planned') throw new Error('Only planned visits can be canceled');
    return { db: write(db, MODEL, r.id, { stage_id: 'canceled' }) };
  } },
];
const ask = [['required', 'Required'], ['optional', 'Optional'], ['hidden', 'Hidden']];

export const frontdeskPlusModels = {
  'frontdesk.station': {
    label: 'Stations',
    fields: {
      name: { type: 'char', label: 'Station Name', required: true },
      host_selection: { type: 'boolean', label: 'Allow Host Selection' },
      ask_phone: { type: 'selection', label: 'Phone', options: ask },
      ask_email: { type: 'selection', label: 'Email', options: ask },
      ask_company: { type: 'selection', label: 'Company', options: ask },
      drink_offer: { type: 'boolean', label: 'Offer Drinks' },
      drink_ids: { type: 'one2many', label: 'Drinks', fields: { name: { type: 'char', label: 'Drink', required: true } }, newLine: () => ({ name: '' }) },
      self_check_in: { type: 'boolean', label: 'Self Check-In' },
      notify_host: { type: 'selection', label: 'Notify Host', options: [['email', 'Email'], ['chat', 'Chat'], ['both', 'Email and Chat']] },
      theme_color: { type: 'char', label: 'Theme Color' },
    },
    defaults: () => ({ host_selection: true, ask_phone: 'optional', ask_email: 'optional', ask_company: 'optional', drink_offer: false, drink_ids: [], self_check_in: true, notify_host: 'chat', theme_color: '#714B67' }),
    list: ['name', 'self_check_in', 'notify_host'],
    kanban: { title: 'name', lines: ['notify_host'] },
    form: {
      title: 'name', groups: [['host_selection', 'self_check_in'], ['ask_phone', 'ask_email', 'ask_company'], ['notify_host', 'theme_color', 'drink_offer']], tabs: [{ label: 'Drinks', fields: ['drink_ids'] }],
      // End of day: everyone still on site is checked out now.
      buttons: [
        {
          label: 'Plan Visit', primary: true,
          ask: [{ label: 'Visitor name' }, { label: 'Host (employee name)' }, { label: 'Date (YYYY-MM-DD)', default: () => now().slice(0, 10) }, { label: 'Time (HH:MM)', default: () => '09:00' }],
          run: (db, r, [name, hostName, date, time]) => {
            const host = search(db, 'hr.employee').find((e) => e.name.toLowerCase() === hostName.toLowerCase());
            if (!host) throw new Error('No employee with that name');
            const res = planVisit(db, { name, hostId: host.id, date, time, stationId: r.id });
            return { db: res.db, go: `#/frontdesk/visitors/${res.id}` };
          },
        },
        { label: 'Check Out All Visitors', run: (db) => ({ db: checkOutAll(db, now()) }) },
      ],
    },
  },
  [MODEL]: {
    ...base,
    fields: {
      ...base.fields,
      station_id: { type: 'many2one', relation: 'frontdesk.station', label: 'Station' },
      email: { type: 'char', label: 'Email' },
      planned_date: { type: 'date', label: 'Planned Date' },
      planned_time: { type: 'char', label: 'Planned Time' },
      check_out_date: { type: 'date', label: 'Check Out Date' },
      duration: { type: 'float', label: 'Duration (hours)', readonly: true, compute: duration },
      drink_id: { type: 'char', label: 'Requested Drink' },
      drink_served: { type: 'boolean', label: 'Drink Served', readonly: true },
      badge_code: { type: 'char', label: 'Badge Code', readonly: true },
      host_notified: { type: 'boolean', label: 'Host Notified', readonly: true },
    },
    defaults: (id) => ({ ...base.defaults(id), drink_served: false, host_notified: false }),
    guard: (db, before, r) => r.badge_code && search(db, MODEL, { includeArchived: true }).some((v) => v.id !== r.id && v.badge_code === r.badge_code) ? 'Badge code must be unique' : null,
    kanban: { ...base.kanban, buttons },
    filters: [[{ id: 'on_site', label: 'On Site', fn: (r) => r.stage_id === 'checked_in' }]],
    list: [...base.list, 'station_id', 'duration', 'drink_id', 'drink_served'],
    form: {
      ...base.form, buttons,
      groups: [['station_id', 'host_id'], ['company', 'phone', 'email'], ['planned_date', 'planned_time', 'badge_code'], ['date', 'check_in', 'check_out_date', 'check_out', 'duration'], ['drink_id', 'drink_served', 'host_notified']],
    },
  },
};
