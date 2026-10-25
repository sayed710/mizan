import { create, read, search, write } from '../orm.js';
import { addDays, today } from './common.js';

const stages = [['new', 'New Request'], ['progress', 'In Progress'], ['repaired', 'Repaired'], ['scrap', 'Scrap']];
const stageOf = (r) => r.stage ?? r.stage_id ?? 'new';
const isOpen = (r) => !['repaired', 'scrap'].includes(stageOf(r));
const requestsFor = (db, id) => search(db, 'maintenance.request').filter((r) => r.equipment_id === id);
const corrective = (r) => (r.maintenance_type ?? 'corrective') === 'corrective';
const timestamp = (date) => date ? Date.parse(date) : NaN;
const mean = (values) => values.length ? values.reduce((s, n) => s + n, 0) / values.length : null;
const employee = { type: 'many2one', relation: 'hr.employee', label: 'Technician' };

/** Mean days between dated corrective requests, or null without two failures. */
export function mtbf(db, equipmentId) {
  const dates = requestsFor(db, equipmentId).filter(corrective).map((r) => timestamp(r.request_date)).filter(Number.isFinite).sort((a, b) => a - b);
  return mean(dates.slice(1).map((date, i) => (date - dates[i]) / 86400000));
}

/** Mean elapsed hours to close repaired corrective requests, or null. */
export function mttr(db, equipmentId) {
  const hours = requestsFor(db, equipmentId).filter((r) => corrective(r) && stageOf(r) === 'repaired')
    .map((r) => (timestamp(r.close_date) - timestamp(r.request_date)) / 3600000)
    .filter((n) => Number.isFinite(n) && n >= 0);
  return mean(hours);
}

/** Next preventive date from the last completed service or effective date. */
export function nextPreventiveDate(db, equipment) {
  const period = Number(equipment.period_days ?? equipment.period);
  if (!(period > 0)) return null;
  const dates = requestsFor(db, equipment.id).filter((r) => r.maintenance_type === 'preventive' && stageOf(r) === 'repaired')
    .map((r) => r.close_date || r.schedule_date || r.request_date).filter((d) => Number.isFinite(timestamp(d))).sort();
  const base = dates.at(-1) || equipment.effective_date;
  if (!dates.length && !equipment.period_days && equipment.next_maintenance) return equipment.next_maintenance;
  return base ? addDays(base.slice(0, 10), period) : equipment.next_maintenance || null;
}

/** Create at most one open preventive request per active equipment within seven days. */
export function schedulePreventive(db, at = today()) {
  if (!Number.isFinite(timestamp(at))) throw new Error('Enter a valid scheduling date');
  let next = db;
  const horizon = addDays(at, 7);
  for (const equipment of search(db, 'maintenance.equipment')) {
    const due = nextPreventiveDate(next, equipment);
    if (!due || due > horizon || requestsFor(next, equipment.id).some((r) => r.maintenance_type === 'preventive' && isOpen(r))) continue;
    next = create(next, 'maintenance.request', {
      name: `Preventive maintenance: ${equipment.name}`, equipment_id: equipment.id,
      maintenance_type: 'preventive', technician_id: equipment.technician_id ?? null,
      request_date: at, schedule_date: due, duration: Number(equipment.maintenance_duration) || 1,
    }).db;
  }
  return next;
}

/** Request smart count and reliability metrics with equipment acquisition cost. */
export function equipmentStats(db, equipmentId) {
  const equipment = read(db, 'maintenance.equipment', equipmentId);
  if (!equipment) throw new Error('Equipment not found');
  const requests = requestsFor(db, equipmentId);
  return { requests: requests.length, open: requests.filter(isOpen).length, mtbf: mtbf(db, equipmentId), mttr: mttr(db, equipmentId), cost: Number(equipment.cost) || 0 };
}

/** Scheduled hours per occupied day for a technician, inclusive of both bounds. */
export function calendarLoad(db, technicianId, { from, to }) {
  if (!Number.isFinite(timestamp(from)) || !Number.isFinite(timestamp(to)) || from > to) throw new Error('Enter a valid calendar date range');
  const load = {};
  for (const r of search(db, 'maintenance.request')) {
    const day = r.schedule_date?.slice(0, 10);
    if (r.technician_id !== technicianId || stageOf(r) === 'scrap' || !day || day < from || day > to) continue;
    load[day] = (load[day] ?? 0) + (Number(r.duration) || 0);
  }
  return load;
}

function transition(db, request, stage) {
  const current = read(db, 'maintenance.request', request.id);
  if (!current || !isOpen(current)) throw new Error('Only open maintenance requests can be changed');
  if (stage === 'progress' && stageOf(current) !== 'new') throw new Error('Only new requests can be started');
  const equipment = read(db, 'maintenance.equipment', current.equipment_id);
  if (stage === 'scrap' && !equipment) throw new Error('Select equipment to scrap');
  if (equipment?.active === false) throw new Error('This equipment is scrapped');
  let next = write(db, 'maintenance.request', current.id, {
    stage, stage_id: stage, ...(stage !== 'progress' ? { close_date: today(), kanban_state: 'done' } : {}),
  });
  if (stage === 'scrap') next = write(next, 'maintenance.equipment', equipment.id, { active: false });
  return next;
}

export const maintPlusModels = {
  'maintenance.equipment': {
    label: 'Equipment',
    fields: {
      name: { type: 'char', label: 'Equipment Name', required: true },
      category: { type: 'selection', label: 'Category', options: [['machine', 'Machines'], ['vehicle', 'Vehicles'], ['computer', 'Computers'], ['tool', 'Tools'], ['other', 'Other']] },
      serial_no: { type: 'char', label: 'Serial Number' },
      location: { type: 'char', label: 'Used in location' },
      technician_id: employee,
      assign_date: { type: 'date', label: 'Assigned Date' },
      effective_date: { type: 'date', label: 'Effective Date' },
      cost: { type: 'monetary', label: 'Cost' },
      warranty_date: { type: 'date', label: 'Warranty Expiration Date' },
      vendor_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor' },
      next_maintenance: { type: 'date', label: 'Next Preventive Maintenance' },
      period: { type: 'integer', label: 'Legacy Preventive Interval (days)' },
      period_days: { type: 'integer', label: 'Preventive Interval (days)' },
      maintenance_duration: { type: 'float', label: 'Maintenance Duration (hours)' },
      expected_mtbf: { type: 'float', label: 'Expected MTBF (days)' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ active: true, effective_date: today(), cost: 0 }),
    guard: (db, before, r) => ['period', 'period_days', 'maintenance_duration', 'expected_mtbf', 'cost'].some((k) => r[k] != null && (!Number.isFinite(Number(r[k])) || Number(r[k]) < 0)) ? 'Equipment intervals, duration and cost cannot be negative' : null,
    kanban: { title: 'name', lines: ['category', 'serial_no', 'next_maintenance'] },
    list: ['name', 'category', 'serial_no', 'technician_id', 'next_maintenance'],
    groupBys: ['category', 'technician_id'],
    form: {
      title: 'name', chatter: true,
      smart: [{ label: 'Maintenance', model: 'maintenance.request', field: 'equipment_id', target: 'maintenance/requests' }],
      groups: [['category', 'serial_no', 'location', 'vendor_id', 'cost', 'warranty_date', 'assign_date', 'active'], ['technician_id', 'effective_date', 'period_days', 'expected_mtbf', 'next_maintenance', 'period', 'maintenance_duration']],
    },
  },
  'maintenance.request': {
    label: 'Maintenance Requests',
    fields: {
      name: { type: 'char', label: 'Subject', required: true },
      equipment_id: { type: 'many2one', relation: 'maintenance.equipment', label: 'Equipment' },
      maintenance_type: { type: 'selection', label: 'Type', options: [['corrective', 'Corrective'], ['preventive', 'Preventive']] },
      stage: { type: 'selection', label: 'Stage', tracking: true, options: stages },
      stage_id: { type: 'selection', label: 'Stage', tracking: true, options: stages },
      priority: { type: 'priority', label: 'Priority' },
      request_date: { type: 'date', label: 'Request Date' },
      schedule_date: { type: 'date', label: 'Scheduled Date' },
      duration: { type: 'float', label: 'Duration (hours)' },
      close_date: { type: 'date', label: 'Close Date' },
      technician_id: employee,
      description: { type: 'text', label: 'Notes' },
      kanban_state: { type: 'selection', label: 'Kanban State', options: [['normal', 'Normal'], ['blocked', 'Blocked'], ['done', 'Done']] },
    },
    defaults: () => ({ stage_id: 'new', maintenance_type: 'corrective', priority: 0, request_date: today(), schedule_date: today(), duration: 0, kanban_state: 'normal' }),
    onchange: (r, field) => field === 'stage' ? { stage_id: r.stage } : field === 'stage_id' ? { stage: r.stage_id } : {},
    guard: (db, before, r) => {
      if (!stages.some(([s]) => s === stageOf(r))) return 'Select a valid maintenance stage';
      if (!Number.isFinite(Number(r.duration)) || Number(r.duration) < 0) return 'Maintenance duration cannot be negative';
      if (r.close_date && timestamp(r.close_date) < timestamp(r.request_date)) return 'Close date cannot precede the request date';
      return null;
    },
    views: ['kanban', 'list', 'calendar'],
    calendar: { date: 'schedule_date' },
    kanban: { title: 'name', groupBy: 'stage_id', quickCreate: true, lines: ['equipment_id', 'technician_id', 'schedule_date'] },
    list: ['name', 'equipment_id', 'maintenance_type', 'technician_id', 'schedule_date', 'stage_id'],
    groupBys: ['stage_id', 'equipment_id', 'technician_id', 'maintenance_type'],
    form: {
      title: 'name', statusbar: 'stage_id', lockedWhen: (r) => !isOpen(r), chatter: true,
      buttons: [
        { label: 'Start', primary: true, when: (r) => stageOf(r) === 'new', run: (db, r) => ({ db: transition(db, r, 'progress') }) },
        { label: 'Repaired', primary: true, when: isOpen, run: (db, r) => ({ db: transition(db, r, 'repaired') }) },
        { label: 'Scrap', when: isOpen, run: (db, r) => ({ db: transition(db, r, 'scrap') }) },
      ],
      groups: [['equipment_id', 'maintenance_type', 'priority', 'kanban_state'], ['technician_id', 'request_date', 'schedule_date', 'duration', 'close_date']],
      tabs: [{ label: 'Notes', fields: ['description'] }],
    },
  },
};
