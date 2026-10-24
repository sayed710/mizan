// Live Chat, SMS & Social Marketing, Marketing Automation, PLM, Meeting Rooms, Referrals, Skills, ESG.
import { write } from '../orm.js';
import { addDays, today } from './common.js';
import { simple } from './apps2.js';

const employee = (label = 'Employee') => ({ type: 'many2one', relation: 'hr.employee', label });
const SMS_LIMIT = 160;

/** Kg CO2e per unit for common activity sources (illustrative defaults; editable per entry). */
export const EMISSION_FACTORS = { electricity: 0.45, diesel: 2.68, gasoline: 2.31, flight: 0.15, natural_gas: 2.0 };

export const apps3Models = {
  'livechat.session': simple({
    label: 'Sessions',
    fields: {
      name: { type: 'char', label: 'Visitor', required: true },
      operator_id: employee('Operator'),
      date: { type: 'date', label: 'Date' },
      country: { type: 'char', label: 'Country' },
      rating: { type: 'priority', label: 'Rating' },
      transcript: { type: 'text', label: 'Transcript' },
    },
    stages: [['waiting', 'Waiting'], ['open', 'In Conversation'], ['closed', 'Closed']],
    lines: ['operator_id', 'date', 'country'],
    list: ['date', 'name', 'operator_id', 'country', 'rating', 'stage_id'],
    extra: {
      defaults: () => ({ date: today(), rating: 0 }),
      groupBys: ['operator_id', 'country', 'date'],
      kanban: { groupBy: 'stage_id', title: 'name', lines: ['operator_id', 'country'], priority: 'rating' },
      form: { tabs: [{ label: 'Transcript', fields: ['transcript'] }] },
    },
  }),

  'sms.campaign': simple({
    label: 'SMS Campaigns',
    fields: {
      name: { type: 'char', label: 'Subject', required: true },
      list_id: { type: 'many2one', relation: 'mailing.list', label: 'Recipients' },
      body: { type: 'text', label: 'SMS Content' },
      length: { type: 'integer', label: 'Characters', compute: (r) => (r.body ?? '').length },
      sent: { type: 'integer', label: 'Sent', readonly: true },
    },
    stages: [['draft', 'Draft'], ['scheduled', 'Scheduled'], ['sent', 'Sent']],
    lines: ['list_id', 'sent'],
    list: ['name', 'list_id', 'length', 'sent', 'stage_id'],
    extra: {
      defaults: () => ({ sent: 0 }),
      groups: [['list_id'], ['length', 'sent']],
      form: {
        statusbarClickable: false,
        buttons: [{
          label: 'Send', primary: true, when: (r) => r.stage_id !== 'sent',
          run: (db, r) => {
            if (!(r.body ?? '').trim()) throw new Error('Write the SMS content first');
            if ((r.body ?? '').length > SMS_LIMIT) throw new Error(`SMS content is longer than ${SMS_LIMIT} characters`);
            const n = (db.records['mailing.contact'] ?? []).filter((c) => c.list_id === r.list_id && !c.opt_out).length;
            return { db: write(db, 'sms.campaign', r.id, { stage_id: 'sent', sent: n }) };
          },
        }],
        tabs: [{ label: 'SMS Content', fields: ['body'] }],
      },
    },
  }),

  'social.post': simple({
    label: 'Posts',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      message: { type: 'text', label: 'Message' },
      accounts: { type: 'tags', label: 'Accounts' },
      scheduled_date: { type: 'date', label: 'Scheduled Date' },
      likes: { type: 'integer', label: 'Likes' },
      shares: { type: 'integer', label: 'Shares' },
    },
    stages: [['draft', 'Draft'], ['scheduled', 'Scheduled'], ['posted', 'Posted']],
    lines: ['accounts', 'scheduled_date', 'likes'],
    list: ['scheduled_date', 'name', 'accounts', 'likes', 'shares', 'stage_id'],
    extra: {
      defaults: () => ({ accounts: ['Facebook', 'LinkedIn'], scheduled_date: addDays(today(), 1), likes: 0, shares: 0 }),
      views: ['kanban', 'list', 'calendar', 'graph'],
      calendar: { date: 'scheduled_date' },
      graph: { groupBy: 'stage_id', measure: 'likes' },
      kanban: { groupBy: 'stage_id', title: 'name', lines: ['scheduled_date', 'likes'], tags: 'accounts', quickCreate: true },
      groups: [['accounts', 'scheduled_date'], ['likes', 'shares']],
      form: { tabs: [{ label: 'Message', fields: ['message'] }] },
    },
  }),

  'marketing.campaign': simple({
    label: 'Campaigns',
    fields: {
      name: { type: 'char', label: 'Campaign', required: true },
      list_id: { type: 'many2one', relation: 'mailing.list', label: 'Target' },
      steps: {
        type: 'one2many',
        label: 'Workflow',
        fields: {
          action: { type: 'selection', label: 'Action', options: [['email', 'Send Email'], ['sms', 'Send SMS'], ['wait', 'Wait'], ['tag', 'Add Tag']] },
          detail: { type: 'char', label: 'Details' },
          delay_days: { type: 'float', label: 'After (days)' },
        },
        newLine: () => ({ action: 'email', detail: '', delay_days: 0 }),
      },
      participants: { type: 'integer', label: 'Participants', readonly: true },
    },
    stages: [['draft', 'New'], ['running', 'Running'], ['stopped', 'Stopped']],
    lines: ['list_id', 'participants'],
    list: ['name', 'list_id', 'participants', 'stage_id'],
    extra: {
      defaults: () => ({ steps: [], participants: 0 }),
      groups: [['list_id'], ['participants']],
      form: {
        statusbarClickable: false,
        buttons: [
          {
            label: 'Start', primary: true, when: (r) => r.stage_id !== 'running',
            run: (db, r) => {
              if (!r.steps?.length) throw new Error('Add at least one workflow step');
              const n = (db.records['mailing.contact'] ?? []).filter((c) => c.list_id === r.list_id && !c.opt_out).length;
              return { db: write(db, 'marketing.campaign', r.id, { stage_id: 'running', participants: n }) };
            },
          },
          { label: 'Stop', vals: { stage_id: 'stopped' }, when: (r) => r.stage_id === 'running' },
        ],
        tabs: [{ label: 'Workflow', fields: ['steps'] }],
      },
    },
  }),

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

