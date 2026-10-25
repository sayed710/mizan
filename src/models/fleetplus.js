// Fleet services, fuel consumption and cost of ownership.
import { create, read, search, write } from '../orm.js';
import { addDays, today } from './common.js';

const day = 86400000;
const timestamp = (date) => Date.parse(`${date}T00:00:00Z`);
const serviceState = (r) => r.state === 'new' && r.stage_id && r.stage_id !== 'new' ? r.stage_id : (r.state ?? r.stage_id ?? 'new');
const serviceCost = (r) => Number(r.cost ?? r.amount) || 0;
const inPeriod = (date, from, to) => date && date >= from && date <= to;
const states = [['new', 'New'], ['running', 'Running'], ['done', 'Done'], ['cancelled', 'Cancelled']];

function checkPeriod(from, to) {
  const valid = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(timestamp(date)) && new Date(timestamp(date)).toISOString().slice(0, 10) === date;
  if (!valid(from) || !valid(to) || from > to) throw new Error('Choose a valid date range');
}

function contractCost(contract, from, to) {
  if (contract.cost_frequency === 'no' || !contract.start_date || !contract.expiration_date) return 0;
  const start = contract.start_date > from ? contract.start_date : from;
  const end = contract.expiration_date < to ? contract.expiration_date : to;
  if (start > end) return 0;
  const monthly = (Number(contract.cost_generated) || 0) / (contract.cost_frequency === 'yearly' ? 12 : 1);
  let total = 0;
  for (let cursor = start; cursor <= end;) {
    const date = new Date(timestamp(cursor));
    const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    const monthEnd = addDays(nextMonth, -1);
    const last = monthEnd < end ? monthEnd : end;
    total += monthly * ((timestamp(last) - timestamp(cursor)) / day + 1) / Number(monthEnd.slice(8));
    cursor = nextMonth;
  }
  return total;
}

/** Costs and distance in an inclusive period; recurring costs are prorated by calendar month. */
export function vehicleCosts(db, vehicleId, { from, to }) {
  checkPeriod(from, to);
  const serviceLogs = search(db, 'fleet.service').filter((r) => r.vehicle_id === vehicleId && inPeriod(r.date, from, to));
  const fuelLogs = search(db, 'fleet.fuel.log').filter((r) => r.vehicle_id === vehicleId && inPeriod(r.date, from, to));
  const services = serviceLogs.filter((r) => serviceState(r) === 'done').reduce((s, r) => s + serviceCost(r), 0);
  const fuel = fuelLogs.reduce((s, r) => s + r.amount, 0);
  const contracts = search(db, 'fleet.contract').filter((r) => r.vehicle_id === vehicleId).reduce((s, r) => s + contractCost(r, from, to), 0);
  const readings = [
    ...search(db, 'fleet.odometer').filter((r) => r.vehicle_id === vehicleId && inPeriod(r.date, from, to)).map((r) => r.value),
    ...serviceLogs.filter((r) => serviceState(r) === 'done').map((r) => r.odometer),
    ...fuelLogs.map((r) => r.odometer),
  ].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const km = readings.length > 1 ? Math.max(...readings) - Math.min(...readings) : 0;
  const total = services + fuel + contracts;
  return { services, fuel, contracts, total, perKm: km > 0 ? total / km : null, km };
}

/** Liters per 100 km between full fills, including intervening partial fills. */
export function fuelEfficiency(db, vehicleId) {
  const logs = search(db, 'fleet.fuel.log').filter((r) => r.vehicle_id === vehicleId && r.odometer != null)
    .sort((a, b) => a.odometer - b.odometer || a.id - b.id);
  let previous = null;
  let pending = 0;
  let liters = 0;
  let km = 0;
  for (const log of logs) {
    if (previous) pending += Number(log.liters) || 0;
    if (log.full === false) continue;
    if (previous && log.odometer > previous.odometer) {
      km += log.odometer - previous.odometer;
      liters += pending;
    }
    previous = log;
    pending = 0;
  }
  return km > 0 ? liters / km * 100 : null;
}

/** Unrenewed incoming, open or expired contracts expiring in the inclusive upcoming window. */
export function contractsToRenew(db, at, days = 30) {
  if (!Number.isInteger(days) || days < 0) throw new Error('Reminder days must be a non-negative integer');
  checkPeriod(at, at);
  const until = addDays(at, days);
  return search(db, 'fleet.contract').filter((r) => r.stage_id !== 'closed' && inPeriod(r.expiration_date, at, until));
}

/** Renew a contract for the same inclusive number of days and close its predecessor. */
export function renewContract(db, contract) {
  const current = read(db, 'fleet.contract', contract?.id);
  if (!current) throw new Error('Select an existing contract');
  if (current.stage_id === 'closed') throw new Error('This contract is already closed or renewed');
  checkPeriod(current.start_date, current.expiration_date);
  const length = (timestamp(current.expiration_date) - timestamp(current.start_date)) / day + 1;
  const { id: oldId, ...terms } = current;
  const start = addDays(current.expiration_date, 1);
  const result = create(db, 'fleet.contract', {
    ...terms, name: `${current.name} (renewal)`, start_date: start, expiration_date: addDays(start, length - 1), stage_id: 'futur',
  });
  return { db: write(result.db, 'fleet.contract', oldId, { stage_id: 'closed' }), id: result.id };
}

/** Vehicles due by date or current mileage on their latest completed service. */
export function servicesDue(db, at) {
  checkPeriod(at, at);
  const done = search(db, 'fleet.service').filter((r) => serviceState(r) === 'done');
  return search(db, 'fleet.vehicle').filter((vehicle) => {
    const latest = done.filter((r) => r.vehicle_id === vehicle.id)
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id - a.id)[0];
    return latest && ((latest.next_due_date && latest.next_due_date <= at)
      || (Number(latest.next_due_km) > 0 && Number(vehicle.odometer) >= Number(latest.next_due_km)));
  });
}

function changeServiceState(db, record, state) {
  const current = read(db, 'fleet.service', record.id);
  const before = current && serviceState(current);
  if (!current || !({ running: ['new'], done: ['new', 'running'], cancelled: ['new', 'running'] }[state] ?? []).includes(before)) {
    throw new Error('This service cannot make that status change');
  }
  return { db: write(db, 'fleet.service', record.id, { state, stage_id: state }) };
}

export const fleetPlusModels = {
  'fleet.service': {
    label: 'Services',
    fields: {
      name: { type: 'char', label: 'Description', required: true },
      vehicle_id: { type: 'many2one', relation: 'fleet.vehicle', label: 'Vehicle', required: true },
      service_type: { type: 'selection', label: 'Service Type', options: [['repair', 'Repair'], ['maintenance', 'Maintenance'], ['tyres', 'Tyres'], ['inspection', 'Inspection'], ['other', 'Other'], ['fuel', 'Fuel'], ['insurance', 'Insurance']] },
      vendor_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor' },
      cost: { type: 'monetary', label: 'Cost' },
      amount: { type: 'monetary', label: 'Legacy Cost' },
      odometer: { type: 'float', label: 'Odometer (km)' },
      date: { type: 'date', label: 'Date' },
      state: { type: 'selection', label: 'Status', tracking: true, options: states },
      stage_id: { type: 'selection', label: 'Legacy Status', tracking: true, options: states },
      notes: { type: 'text', label: 'Notes' },
      next_due_km: { type: 'float', label: 'Next Service (km)' },
      next_due_date: { type: 'date', label: 'Next Service Date' },
    },
    defaults: () => ({ date: today(), service_type: 'maintenance', amount: 0, state: 'new', stage_id: 'new' }),
    onchange: (r, key) => ({ cost: { amount: r.cost }, amount: { cost: r.amount }, state: { stage_id: r.state }, stage_id: { state: r.stage_id } }[key] ?? {}),
    groupBys: ['vehicle_id', 'service_type', 'date', 'state'],
    views: ['list', 'kanban', 'graph', 'pivot'],
    kanban: { groupBy: 'state', title: 'name', lines: ['vehicle_id', 'date', 'cost'], badge: 'state' },
    list: ['date', 'vehicle_id', 'service_type', 'name', 'vendor_id', 'cost', 'odometer', 'state'],
    graph: { groupBy: 'vehicle_id', measure: 'cost' },
    pivot: { row: 'vehicle_id', col: 'service_type', measure: 'cost' },
    form: {
      title: 'name', statusbar: 'state', lockedWhen: (r) => ['done', 'cancelled'].includes(serviceState(r)),
      buttons: [
        { label: 'Start', primary: true, when: (r) => serviceState(r) === 'new', run: (db, r) => changeServiceState(db, r, 'running') },
        { label: 'Done', primary: true, when: (r) => ['new', 'running'].includes(serviceState(r)), run: (db, r) => changeServiceState(db, r, 'done') },
        { label: 'Cancel', when: (r) => ['new', 'running'].includes(serviceState(r)), run: (db, r) => changeServiceState(db, r, 'cancelled') },
      ],
      groups: [['vehicle_id', 'service_type', 'vendor_id'], ['date', 'cost', 'odometer'], ['next_due_date', 'next_due_km']],
      tabs: [{ label: 'Notes', fields: ['notes'] }], chatter: true,
    },
  },
  'fleet.fuel.log': {
    label: 'Fuel Logs',
    fields: {
      vehicle_id: { type: 'many2one', relation: 'fleet.vehicle', label: 'Vehicle', required: true },
      date: { type: 'date', label: 'Date', required: true },
      liters: { type: 'float', label: 'Liters', required: true },
      price_per_liter: { type: 'monetary', label: 'Price per Liter' },
      amount: { type: 'monetary', label: 'Amount', compute: (r) => (Number(r.liters) || 0) * (Number(r.price_per_liter) || 0) },
      odometer: { type: 'float', label: 'Odometer (km)', required: true },
      driver_id: { type: 'many2one', relation: 'hr.employee', label: 'Driver' },
      station: { type: 'char', label: 'Station' },
      full: { type: 'boolean', label: 'Full Tank' },
    },
    defaults: () => ({ date: today(), liters: 0, price_per_liter: 0, full: true }),
    guard: (db, before, r) => ![r.liters, r.price_per_liter, r.odometer].every((n) => Number.isFinite(Number(n)) && Number(n) >= 0) ? 'Fuel quantities, prices and mileage must be non-negative numbers' : null,
    groupBys: ['vehicle_id', 'date', 'driver_id'],
    views: ['list', 'kanban', 'graph'],
    list: ['date', 'vehicle_id', 'driver_id', 'liters', 'price_per_liter', 'amount', 'odometer', 'station'],
    kanban: { title: 'vehicle_id', lines: ['date', 'liters', 'amount', 'odometer'] },
    graph: { groupBy: 'vehicle_id', measure: 'amount' },
    form: { title: 'vehicle_id', groups: [['vehicle_id', 'driver_id', 'station'], ['date', 'odometer', 'full'], ['liters', 'price_per_liter', 'amount']] },
  },
};
