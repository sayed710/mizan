// PLM, Meeting Rooms, Referrals, Skills, ESG.
import { write } from '../orm.js';
import { today } from './common.js';
import { simple } from './apps2.js';

const employee = (label = 'Employee') => ({ type: 'many2one', relation: 'hr.employee', label });

/** Kg CO2e per unit for common activity sources (illustrative defaults; editable per entry). */
export const EMISSION_FACTORS = { electricity: 0.45, diesel: 2.68, gasoline: 2.31, flight: 0.15, natural_gas: 2.0 };

export const apps3Models = {
  'mrp.eco': simple({
    label: 'Engineering Changes',
    fields: {
      name: { type: 'char', label: 'Short Summary', required: true },
      bom_id: { type: 'many2one', relation: 'mrp.bom', label: 'Bill of Materials' },
      user_id: employee('Responsible'),
      version: { type: 'integer', label: 'Version' },
      priority: { type: 'priority', label: 'Priority' },
      note: { type: 'text', label: 'Description of Change' },
    },
    stages: [['new', 'New'], ['progress', 'In Progress'], ['validation', 'Validation'], ['done', 'Effective']],
    lines: ['bom_id', 'user_id', 'version'],
    list: ['name', 'bom_id', 'user_id', 'version', 'stage_id'],
    extra: {
      defaults: () => ({ version: 2, priority: 0 }),
      kanban: { groupBy: 'stage_id', title: 'name', lines: ['bom_id', 'version'], priority: 'priority', badge: 'user_id' },
      form: { tabs: [{ label: 'Description of Change', fields: ['note'] }] },
    },
  }),

  'room.room': {
    label: 'Meeting Rooms',
    fields: {
      name: { type: 'char', label: 'Room Name', required: true },
      capacity: { type: 'integer', label: 'Capacity' },
      location: { type: 'char', label: 'Location' },
      equipment: { type: 'tags', label: 'Equipment' },
    },
    defaults: () => ({ capacity: 6, equipment: [] }),
    kanban: { title: 'name', lines: ['capacity', 'location'], tags: 'equipment', counter: { label: 'Bookings', model: 'room.booking', field: 'room_id' } },
    list: ['name', 'capacity', 'location'],
    form: {
      title: 'name',
      smart: [{ label: 'Bookings', model: 'room.booking', field: 'room_id', target: 'rooms/bookings' }],
      groups: [['capacity', 'location'], ['equipment']],
    },
  },

  'room.booking': {
    label: 'Room Bookings',
    fields: {
      name: { type: 'char', label: 'Meeting', required: true },
      room_id: { type: 'many2one', relation: 'room.room', label: 'Room', required: true },
      organizer_id: employee('Organizer'),
      date: { type: 'date', label: 'Date', required: true },
      start: { type: 'char', label: 'From' },
      end: { type: 'char', label: 'To' },
    },
    defaults: () => ({ date: today(), start: '10:00', end: '11:00', organizer_id: 1 }),
    groupBys: ['room_id', 'organizer_id', 'date'],
    kanban: { title: 'name', lines: ['room_id', 'date', 'start'] },
    list: ['date', 'start', 'end', 'room_id', 'name', 'organizer_id'],
    views: ['calendar', 'list', 'kanban'],
    calendar: { date: 'date', time: 'start' },
    form: { title: 'name', groups: [['room_id', 'organizer_id'], ['date', 'start', 'end']], chatter: true },
  },

  'hr.referral': simple({
    label: 'Referrals',
    fields: {
      name: { type: 'char', label: 'Candidate', required: true },
      job_id: { type: 'many2one', relation: 'hr.job', label: 'Job Position' },
      referrer_id: employee('Referred by'),
      email: { type: 'char', label: 'Email' },
      points: { type: 'integer', label: 'Points', compute: (r) => ({ new: 10, interview: 30, hired: 100 })[r.stage_id] ?? 0 },
    },
    stages: [['new', 'Referred'], ['interview', 'Interviewing'], ['hired', 'Hired'], ['refused', 'Not Selected']],
    lines: ['job_id', 'referrer_id', 'points'],
    list: ['name', 'job_id', 'referrer_id', 'points', 'stage_id'],
    extra: {
      groupBys: ['referrer_id', 'job_id'],
      views: ['kanban', 'list', 'graph'],
      graph: { groupBy: 'referrer_id', measure: 'points' },
    },
  }),

  'hr.skill': {
    label: 'Skills',
    fields: {
      name: { type: 'char', label: 'Skill', required: true },
      employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Employee', required: true },
      skill_type: { type: 'selection', label: 'Skill Type', options: [['language', 'Languages'], ['tech', 'Technical'], ['soft', 'Soft Skills']] },
      level: { type: 'selection', label: 'Level', options: [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced'], ['expert', 'Expert']] },
      progress: { type: 'integer', label: 'Progress (%)', compute: (r) => ({ beginner: 25, intermediate: 50, advanced: 75, expert: 100 })[r.level] ?? 0 },
    },
    defaults: () => ({ skill_type: 'tech', level: 'beginner' }),
    groupBys: ['employee_id', 'skill_type', 'level'],
    kanban: { groupBy: 'skill_type', title: 'name', lines: ['employee_id', 'level'] },
    list: ['employee_id', 'skill_type', 'name', 'level', 'progress'],
    views: ['list', 'kanban', 'pivot'],
    pivot: { row: 'employee_id', col: 'skill_type', measure: '__count' },
    form: { title: 'name', groups: [['employee_id', 'skill_type'], ['level', 'progress']] },
  },

  'esg.emission': {
    label: 'Emissions',
    fields: {
      name: { type: 'char', label: 'Description', required: true },
      date: { type: 'date', label: 'Date' },
      scope: { type: 'selection', label: 'Scope', options: [['1', 'Scope 1 (direct)'], ['2', 'Scope 2 (energy)'], ['3', 'Scope 3 (value chain)']] },
      source: { type: 'selection', label: 'Source', options: [['electricity', 'Electricity (kWh)'], ['diesel', 'Diesel (L)'], ['gasoline', 'Gasoline (L)'], ['flight', 'Flights (km)'], ['natural_gas', 'Natural Gas (m³)']] },
      quantity: { type: 'float', label: 'Quantity' },
      factor: { type: 'float', label: 'Emission Factor (kg CO2e/unit)' },
      co2e: { type: 'float', label: 'Emissions (t CO2e)', compute: (r) => Math.round(((Number(r.quantity) || 0) * (Number(r.factor) || 0)) / 10) / 100 },
    },
    defaults: () => ({ date: today(), scope: '2', source: 'electricity', factor: EMISSION_FACTORS.electricity }),
    groupBys: ['scope', 'source', 'date'],
    kanban: { groupBy: 'scope', title: 'name', lines: ['source', 'quantity', 'co2e'] },
    list: ['date', 'name', 'scope', 'source', 'quantity', 'co2e'],
    views: ['list', 'graph', 'pivot', 'kanban'],
    graph: { groupBy: 'scope', measure: 'co2e' },
    pivot: { row: 'source', col: 'scope', measure: 'co2e' },
    form: {
      title: 'name',
      buttons: [{ label: 'Use Default Factor', run: (db, r) => ({ db: write(db, 'esg.emission', r.id, { factor: EMISSION_FACTORS[r.source] ?? r.factor }) }) }],
      groups: [['date', 'scope', 'source'], ['quantity', 'factor', 'co2e']],
      chatter: true,
    },
  },
};

