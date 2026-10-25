// Maintenance, Quality, Fleet, Attendances, Appraisals, Surveys, Lunch, Approvals, Repairs, Field Service, Frontdesk, eLearning.
import { create, write } from '../orm.js';
import { addDays, amountFields, pad, productLines, today } from './common.js';
import { moveStock } from './sales.js';

const employee = (label = 'Employee') => ({ type: 'many2one', relation: 'hr.employee', label });
const stage = (options, label = 'Stage') => ({ type: 'selection', label, tracking: true, options });
const hm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
};
const STANDARD_DAY_HOURS = 8;
export const workedHours = (r) => {
  const a = hm(r.check_in);
  const b = hm(r.check_out);
  return a != null && b != null && b > a ? Math.round((b - a) * 100) / 100 : 0;
};

/** A stage-driven model with kanban/list/form defaults; `extra` overrides any part. */
export function simple({ label, fields, stages, title = 'name', lines, list, extra = {} }) {
  const { defaults, groupBys = [], groups, form, ...rest } = extra;
  return {
    label,
    fields: { ...fields, ...(stages ? { stage_id: stage(stages) } : {}) },
    kanban: { ...(stages ? { groupBy: 'stage_id', quickCreate: true } : {}), title, lines },
    list,
    ...rest,
    defaults: (id) => ({ ...(stages ? { stage_id: stages[0][0] } : {}), ...(defaults?.(id) ?? {}) }),
    groupBys: [...(stages ? ['stage_id'] : []), ...groupBys],
    form: {
      ...(stages ? { statusbar: 'stage_id', statusbarClickable: true } : {}),
      title,
      groups: groups ?? [lines, []],
      chatter: true,
      ...form,
    },
  };
}

function repairInvoice(db, r) {
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: r.partner_id, invoice_origin: r.name, invoice_date: today(), invoice_date_due: addDays(today(), 15),
    invoice_line_ids: r.parts.map((l) => ({ ...l })),
  });
  return { db: write(next, 'repair.order', r.id, { invoiced: true }), go: `#/accounting/invoices/${id}` };
}

export const apps2Models = {
  'maintenance.equipment': simple({
    label: 'Equipment',
    fields: {
      name: { type: 'char', label: 'Equipment Name', required: true },
      category: { type: 'selection', label: 'Category', options: [['machine', 'Machines'], ['computer', 'Computers'], ['vehicle', 'Vehicles'], ['other', 'Other']] },
      serial_no: { type: 'char', label: 'Serial Number' },
      technician_id: employee('Technician'),
      location: { type: 'char', label: 'Used in location' },
      next_maintenance: { type: 'date', label: 'Next Preventive Maintenance' },
    },
    lines: ['category', 'serial_no', 'next_maintenance'],
    list: ['name', 'category', 'serial_no', 'technician_id', 'next_maintenance'],
    extra: {
      groupBys: ['category', 'technician_id'],
      groups: [['category', 'serial_no', 'location'], ['technician_id', 'next_maintenance']],
      form: { smart: [{ label: 'Maintenance', model: 'maintenance.request', field: 'equipment_id', target: 'maintenance/requests' }] },
    },
  }),

  'maintenance.request': simple({
    label: 'Maintenance Requests',
    fields: {
      name: { type: 'char', label: 'Subject', required: true },
      equipment_id: { type: 'many2one', relation: 'maintenance.equipment', label: 'Equipment' },
      maintenance_type: { type: 'selection', label: 'Type', options: [['corrective', 'Corrective'], ['preventive', 'Preventive']] },
      technician_id: employee('Technician'),
      schedule_date: { type: 'date', label: 'Scheduled Date' },
      duration: { type: 'float', label: 'Duration (hours)' },
      priority: { type: 'priority', label: 'Priority' },
      description: { type: 'text', label: 'Notes' },
    },
    stages: [['new', 'New Request'], ['progress', 'In Progress'], ['repaired', 'Repaired'], ['scrap', 'Scrap']],
    lines: ['equipment_id', 'technician_id', 'schedule_date'],
    list: ['name', 'equipment_id', 'maintenance_type', 'technician_id', 'schedule_date', 'stage_id'],
    extra: {
      defaults: () => ({ maintenance_type: 'corrective', priority: 0, schedule_date: today() }),
      groupBys: ['equipment_id', 'technician_id', 'maintenance_type'],
      views: ['kanban', 'list', 'calendar'],
      calendar: { date: 'schedule_date' },
      groups: [['equipment_id', 'maintenance_type', 'priority'], ['technician_id', 'schedule_date', 'duration']],
      form: { tabs: [{ label: 'Notes', fields: ['description'] }] },
    },
  }),

  'quality.check': simple({
    label: 'Quality Checks',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      test_type: { type: 'selection', label: 'Type', options: [['pass_fail', 'Pass - Fail'], ['measure', 'Measure'], ['instructions', 'Instructions']] },
      measure: { type: 'float', label: 'Measure' },
      norm_min: { type: 'float', label: 'Min Tolerance' },
      norm_max: { type: 'float', label: 'Max Tolerance' },
      user_id: employee('Responsible'),
      result: stage([['none', 'To do'], ['pass', 'Passed'], ['fail', 'Failed']], 'Status'),
      note: { type: 'text', label: 'Instructions' },
    },
    lines: ['product_id', 'test_type', 'result'],
    list: ['name', 'product_id', 'test_type', 'measure', 'user_id', 'result'],
    extra: {
      defaults: (id) => ({ name: 'QC/' + pad(id), test_type: 'pass_fail', result: 'none' }),
      groupBys: ['product_id', 'result'],
      kanban: { groupBy: 'result', title: 'name', lines: ['product_id', 'test_type'] },
      groups: [['product_id', 'test_type', 'user_id'], ['measure', 'norm_min', 'norm_max']],
      form: {
        statusbar: 'result',
        buttons: [
          { label: 'Pass', primary: true, when: (r) => r.result === 'none', vals: { result: 'pass' } },
          { label: 'Fail', when: (r) => r.result === 'none', vals: { result: 'fail' } },
          {
            label: 'Validate Measure', primary: true,
            when: (r) => r.result === 'none' && r.test_type === 'measure',
            run: (db, r) => ({ db: write(db, 'quality.check', r.id, { result: r.measure >= r.norm_min && r.measure <= r.norm_max ? 'pass' : 'fail' }) }),
          },
        ],
        tabs: [{ label: 'Instructions', fields: ['note'] }],
      },
    },
  }),

  'quality.alert': simple({
    label: 'Quality Alerts',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product' },
      user_id: employee('Responsible'),
      priority: { type: 'priority', label: 'Priority' },
      description: { type: 'text', label: 'Description' },
    },
    stages: [['new', 'New'], ['confirmed', 'Confirmed'], ['action', 'Action Proposed'], ['solved', 'Solved']],
    lines: ['product_id', 'user_id'],
    list: ['name', 'product_id', 'user_id', 'stage_id'],
    extra: { defaults: () => ({ priority: 0 }), form: { tabs: [{ label: 'Description', fields: ['description'] }] } },
  }),

  'fleet.vehicle': simple({
    label: 'Vehicles',
    fields: {
      name: { type: 'char', label: 'Model', required: true },
      license_plate: { type: 'char', label: 'License Plate' },
      driver_id: employee('Driver'),
      fuel_type: { type: 'selection', label: 'Fuel Type', options: [['gasoline', 'Gasoline'], ['diesel', 'Diesel'], ['electric', 'Electric'], ['hybrid', 'Hybrid']] },
      odometer: { type: 'float', label: 'Last Odometer (km)' },
      acquisition_date: { type: 'date', label: 'Registration Date' },
    },
    stages: [['new', 'New Request'], ['ordered', 'To Order'], ['registered', 'Registered'], ['downgraded', 'Downgraded']],
    lines: ['license_plate', 'driver_id', 'odometer'],
    list: ['name', 'license_plate', 'driver_id', 'fuel_type', 'odometer', 'stage_id'],
    extra: {
      defaults: () => ({ fuel_type: 'gasoline', odometer: 0 }),
      groupBys: ['driver_id', 'fuel_type'],
      groups: [['license_plate', 'driver_id', 'fuel_type'], ['odometer', 'acquisition_date']],
      form: { smart: [{ label: 'Services', model: 'fleet.service', field: 'vehicle_id', target: 'fleet/services', sum: 'amount' }] },
    },
  }),

  'fleet.service': simple({
    label: 'Services',
    fields: {
      name: { type: 'char', label: 'Description', required: true },
      vehicle_id: { type: 'many2one', relation: 'fleet.vehicle', label: 'Vehicle', required: true },
      service_type: { type: 'selection', label: 'Service Type', options: [['repair', 'Repair'], ['maintenance', 'Maintenance'], ['fuel', 'Fuel'], ['insurance', 'Insurance']] },
      date: { type: 'date', label: 'Date' },
      amount: { type: 'monetary', label: 'Cost' },
      vendor_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor' },
    },
    stages: [['new', 'New'], ['running', 'Running'], ['done', 'Done'], ['cancelled', 'Cancelled']],
    lines: ['vehicle_id', 'date', 'amount'],
    list: ['date', 'vehicle_id', 'service_type', 'name', 'vendor_id', 'amount', 'stage_id'],
    extra: {
      defaults: () => ({ date: today(), service_type: 'maintenance', amount: 0 }),
      groupBys: ['vehicle_id', 'service_type', 'date'],
      views: ['list', 'kanban', 'graph', 'pivot'],
      graph: { groupBy: 'vehicle_id', measure: 'amount' },
      pivot: { row: 'vehicle_id', col: 'service_type', measure: 'amount' },
      groups: [['vehicle_id', 'service_type', 'vendor_id'], ['date', 'amount']],
    },
  }),

  'hr.attendance': {
    label: 'Attendances',
    fields: {
      employee_id: employee(),
      date: { type: 'date', label: 'Date', required: true },
      check_in: { type: 'char', label: 'Check In' },
      check_out: { type: 'char', label: 'Check Out' },
      worked_hours: { type: 'float', label: 'Worked Hours', compute: workedHours },
      overtime: { type: 'float', label: 'Extra Hours', compute: (r) => (r.check_out ? Math.round((workedHours(r) - STANDARD_DAY_HOURS) * 100) / 100 : 0) },
      name: { type: 'char', label: 'Name', compute: (r) => `${r.date ?? ''} ${r.check_in ?? ''}` },
    },
    defaults: () => ({ date: today(), check_in: '09:00' }),
    filters: [[{ id: 'today', label: 'Today', fn: (r) => r.date === today() }, { id: 'open', label: 'Checked In', fn: (r) => !r.check_out }]],
    groupBys: ['employee_id', 'date'],
    kanban: { title: 'date', lines: ['employee_id', 'check_in', 'check_out', 'worked_hours'] },
    list: ['employee_id', 'date', 'check_in', 'check_out', 'worked_hours', 'overtime'],
    views: ['list', 'kanban', 'pivot', 'graph'],
    pivot: { row: 'employee_id', col: 'date', measure: 'worked_hours' },
    graph: { groupBy: 'employee_id', measure: 'worked_hours' },
    form: { title: 'date', groups: [['employee_id', 'date'], ['check_in', 'check_out', 'worked_hours', 'overtime']] },
  },

  'hr.appraisal': simple({
    label: 'Appraisals',
    fields: {
      name: { type: 'char', label: 'Title', compute: (r) => `Appraisal ${r.date_close ?? ''}` },
      employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Employee', required: true },
      manager_id: employee('Manager'),
      date_close: { type: 'date', label: 'Appraisal Date' },
      rating: { type: 'priority', label: 'Final Rating' },
      feedback: { type: 'text', label: 'Feedback' },
    },
    title: 'employee_id',
    stages: [['new', 'To Start'], ['pending', 'Appraisal Sent'], ['done', 'Done']],
    lines: ['manager_id', 'date_close'],
    list: ['employee_id', 'manager_id', 'date_close', 'rating', 'stage_id'],
    extra: {
      defaults: () => ({ date_close: addDays(today(), 30), rating: 0 }),
      groupBys: ['employee_id', 'manager_id'],
      kanban: { groupBy: 'stage_id', title: 'name', lines: ['employee_id', 'manager_id', 'date_close'], priority: 'rating' },
      groups: [['employee_id', 'manager_id'], ['date_close', 'rating']],
      form: { title: 'name', tabs: [{ label: 'Feedback', fields: ['feedback'] }] },
    },
  }),

  'survey.survey': simple({
    label: 'Surveys',
    fields: {
      name: { type: 'char', label: 'Survey Title', required: true },
      questions: {
        type: 'one2many',
        label: 'Questions',
        fields: {
          question: { type: 'char', label: 'Question' },
          kind: { type: 'selection', label: 'Question Type', options: [['text', 'Text'], ['choice', 'Multiple choice'], ['rating', 'Rating 1-5']] },
          choices: { type: 'char', label: 'Choices (comma separated)' },
        },
        newLine: () => ({ question: '', kind: 'text', choices: '' }),
      },
      responses: { type: 'integer', label: 'Responses', readonly: true },
      user_id: employee('Responsible'),
    },
    stages: [['draft', 'Draft'], ['open', 'In Progress'], ['closed', 'Closed']],
    lines: ['user_id', 'responses'],
    list: ['name', 'user_id', 'responses', 'stage_id'],
    extra: {
      defaults: () => ({ questions: [], responses: 0 }),
      groups: [['user_id'], ['responses']],
      form: {
        buttons: [{ label: 'Take Survey', primary: true, when: (r) => r.stage_id === 'open', run: (db, r) => ({ db, go: `#/surveys/take?survey=${r.id}` }) }],
        tabs: [{ label: 'Questions', fields: ['questions'] }],
      },
    },
  }),

  'survey.answer': {
    label: 'Survey Answers',
    fields: {
      survey_id: { type: 'many2one', relation: 'survey.survey', label: 'Survey', required: true },
      name: { type: 'char', label: 'Respondent', required: true },
      date: { type: 'date', label: 'Date', readonly: true },
      answers: {
        type: 'one2many',
        label: 'Answers',
        fields: { question: { type: 'char', label: 'Question' }, answer: { type: 'char', label: 'Answer' } },
        newLine: () => ({ question: '', answer: '' }),
      },
    },
    defaults: () => ({ date: today(), answers: [] }),
    groupBys: ['survey_id', 'date'],
    kanban: { title: 'name', lines: ['survey_id', 'date'] },
    list: ['date', 'survey_id', 'name'],
    views: ['list', 'kanban'],
    form: { lockedWhen: () => true, title: 'name', groups: [['survey_id'], ['date']], tabs: [{ label: 'Answers', fields: ['answers'] }] },
  },

  'lunch.product': {
    label: 'Lunch Products',
    fields: {
      name: { type: 'char', label: 'Product Name', required: true },
      vendor: { type: 'char', label: 'Vendor' },
      price: { type: 'monetary', label: 'Price' },
      category: { type: 'selection', label: 'Category', options: [['sandwich', 'Sandwich'], ['pizza', 'Pizza'], ['salad', 'Salad'], ['drink', 'Drinks']] },
    },
    defaults: () => ({ category: 'sandwich', price: 0 }),
    groupBys: ['category', 'vendor'],
    kanban: { title: 'name', lines: ['price', 'vendor'], avatar: true },
    list: ['name', 'category', 'vendor', 'price'],
    form: { title: 'name', groups: [['category', 'vendor'], ['price']] },
  },

  'lunch.order': simple({
    label: 'Lunch Orders',
    fields: {
      name: { type: 'char', label: 'Reference', compute: (r) => `Lunch ${r.date ?? ''}` },
      product_id: { type: 'many2one', relation: 'lunch.product', label: 'Product', required: true },
      employee_id: employee('User'),
      date: { type: 'date', label: 'Order Date' },
      quantity: { type: 'float', label: 'Quantity' },
      note: { type: 'char', label: 'Notes' },
    },
    stages: [['new', 'To Order'], ['ordered', 'Ordered'], ['received', 'Received'], ['cancelled', 'Cancelled']],
    lines: ['product_id', 'employee_id', 'date'],
    list: ['date', 'employee_id', 'product_id', 'quantity', 'note', 'stage_id'],
    extra: {
      defaults: () => ({ date: today(), quantity: 1, employee_id: 1 }),
      groupBys: ['employee_id', 'product_id', 'date'],
      kanban: { groupBy: 'stage_id', title: 'name', lines: ['product_id', 'employee_id'] },
      groups: [['product_id', 'quantity', 'note'], ['employee_id', 'date']],
      form: { title: 'name' },
    },
  }),

  'approval.request': simple({
    label: 'Approvals',
    fields: {
      name: { type: 'char', label: 'Request', required: true },
      category: { type: 'selection', label: 'Category', options: [['purchase', 'Purchase'], ['travel', 'Business Trip'], ['borrow', 'Borrow Items'], ['general', 'General Approval']] },
      request_owner_id: employee('Request Owner'),
      approver_id: employee('Approver'),
      amount: { type: 'monetary', label: 'Amount' },
      date: { type: 'date', label: 'Date' },
      reason: { type: 'text', label: 'Description' },
      request_status: stage([['new', 'To Submit'], ['pending', 'Submitted'], ['approved', 'Approved'], ['refused', 'Refused']], 'Status'),
    },
    lines: ['category', 'request_owner_id', 'amount'],
    list: ['name', 'category', 'request_owner_id', 'approver_id', 'amount', 'request_status'],
    extra: {
      defaults: () => ({ category: 'general', request_status: 'new', date: today(), request_owner_id: 1 }),
      groupBys: ['category', 'request_status', 'request_owner_id'],
      filters: [[{ id: 'to_review', label: 'To Review', fn: (r) => r.request_status === 'pending' }]],
      kanban: { groupBy: 'request_status', title: 'name', lines: ['category', 'request_owner_id', 'amount'] },
      groups: [['category', 'request_owner_id', 'approver_id'], ['amount', 'date']],
      form: {
        statusbar: 'request_status',
        statusbarClickable: false,
        lockedWhen: (r) => r.request_status !== 'new',
        buttons: [
          { label: 'Submit', primary: true, vals: { request_status: 'pending' }, when: (r) => r.request_status === 'new' },
          { label: 'Approve', primary: true, vals: { request_status: 'approved' }, when: (r) => r.request_status === 'pending' },
          { label: 'Refuse', vals: { request_status: 'refused' }, when: (r) => r.request_status === 'pending' },
        ],
        tabs: [{ label: 'Description', fields: ['reason'] }],
      },
    },
  }),

  'repair.order': {
    label: 'Repair Orders',
    fields: {
      name: { type: 'char', label: 'Repair Reference', readonly: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product to Repair', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      user_id: employee('Responsible'),
      schedule_date: { type: 'date', label: 'Scheduled Date' },
      state: stage([['draft', 'New'], ['confirmed', 'Confirmed'], ['progress', 'Under Repair'], ['done', 'Repaired'], ['cancel', 'Cancelled']], 'Status'),
      parts: productLines('Parts', 'list_price'),
      ...amountFields('parts'),
      invoiced: { type: 'boolean', label: 'Invoiced', readonly: true },
      internal_notes: { type: 'text', label: 'Internal Notes' },
    },
    defaults: (id) => ({ name: 'RO/' + pad(id), state: 'draft', schedule_date: today(), parts: [], invoiced: false }),
    groupBys: ['state', 'partner_id', 'product_id'],
    kanban: { groupBy: 'state', title: 'name', lines: ['product_id', 'partner_id', 'amount_total'] },
    list: ['name', 'product_id', 'partner_id', 'schedule_date', 'amount_total', 'state'],
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => ['done', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Confirm Repair', primary: true, vals: { state: 'confirmed' }, when: (r) => r.state === 'draft' },
        { label: 'Start Repair', primary: true, vals: { state: 'progress' }, when: (r) => r.state === 'confirmed' },
        {
          label: 'End Repair', primary: true, when: (r) => r.state === 'progress',
          run: (db, r) => ({ db: write(moveStock(db, r.parts, -1), 'repair.order', r.id, { state: 'done' }) }),
        },
        { label: 'Create Invoice', when: (r) => r.state === 'done' && !r.invoiced && r.partner_id && r.parts.length, run: repairInvoice },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => ['draft', 'confirmed'].includes(r.state) },
      ],
      title: 'name',
      groups: [['product_id', 'partner_id'], ['user_id', 'schedule_date']],
      tabs: [{ label: 'Parts', fields: ['parts'] }, { label: 'Internal Notes', fields: ['internal_notes'] }],
      footer: ['amount_untaxed', 'amount_tax', 'amount_total'],
      chatter: true,
    },
  },

  'fsm.task': simple({
    label: 'Field Service Tasks',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      address: { type: 'char', label: 'Address' },
      technician_id: employee('Technician'),
      date: { type: 'date', label: 'Planned Date' },
      hours: { type: 'float', label: 'Hours Spent' },
      description: { type: 'text', label: 'Description' },
    },
    stages: [['new', 'New'], ['planned', 'Planned'], ['progress', 'In Progress'], ['done', 'Done']],
    lines: ['partner_id', 'technician_id', 'date'],
    list: ['date', 'name', 'partner_id', 'technician_id', 'hours', 'stage_id'],
    extra: {
      defaults: () => ({ date: today(), hours: 0 }),
      groupBys: ['technician_id', 'partner_id', 'date'],
      views: ['kanban', 'list', 'calendar', 'pivot'],
      calendar: { date: 'date' },
      pivot: { row: 'technician_id', col: 'stage_id', measure: 'hours' },
      groups: [['partner_id', 'address'], ['technician_id', 'date', 'hours']],
      form: { tabs: [{ label: 'Description', fields: ['description'] }] },
    },
  }),

  'frontdesk.visitor': simple({
    label: 'Visitors',
    fields: {
      name: { type: 'char', label: 'Visitor Name', required: true },
      company: { type: 'char', label: 'Visitor Company' },
      phone: { type: 'char', label: 'Phone' },
      host_id: employee('Host'),
      date: { type: 'date', label: 'Date' },
      check_in: { type: 'char', label: 'Checked-In' },
      check_out: { type: 'char', label: 'Checked-Out' },
    },
    stages: [['planned', 'Planned'], ['checked_in', 'Checked-In'], ['checked_out', 'Checked-Out'], ['canceled', 'Cancelled']],
    lines: ['company', 'host_id', 'date'],
    list: ['date', 'name', 'company', 'host_id', 'check_in', 'check_out', 'stage_id'],
    extra: {
      defaults: () => ({ date: today() }),
      groupBys: ['host_id', 'date'],
      groups: [['company', 'phone'], ['host_id', 'date', 'check_in', 'check_out']],
      form: {
        statusbarClickable: false,
        buttons: [
          { label: 'Check In', primary: true, when: (r) => r.stage_id === 'planned', run: (db, r) => ({ db: write(db, 'frontdesk.visitor', r.id, { stage_id: 'checked_in', check_in: new Date().toTimeString().slice(0, 5) }) }) },
          { label: 'Check Out', primary: true, when: (r) => r.stage_id === 'checked_in', run: (db, r) => ({ db: write(db, 'frontdesk.visitor', r.id, { stage_id: 'checked_out', check_out: new Date().toTimeString().slice(0, 5) }) }) },
        ],
      },
    },
  }),

  'slide.channel': simple({
    label: 'Courses',
    fields: {
      name: { type: 'char', label: 'Course Title', required: true },
      user_id: employee('Responsible'),
      lessons: {
        type: 'one2many',
        label: 'Content',
        fields: { title: { type: 'char', label: 'Lesson' }, kind: { type: 'selection', label: 'Type', options: [['video', 'Video'], ['doc', 'Document'], ['quiz', 'Quiz']] }, duration: { type: 'float', label: 'Duration (min)' } },
        newLine: () => ({ title: '', kind: 'video', duration: 10 }),
      },
      members: { type: 'integer', label: 'Attendees' },
      total_time: { type: 'float', label: 'Duration (min)', compute: (r) => (r.lessons ?? []).reduce((s, l) => s + (Number(l.duration) || 0), 0) },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Description' },
    },
    stages: [['draft', 'Draft'], ['published', 'Published']],
    lines: ['user_id', 'members', 'total_time'],
    list: ['name', 'user_id', 'members', 'total_time', 'stage_id'],
    extra: {
      defaults: () => ({ lessons: [], members: 0, tag_ids: [] }),
      groups: [['user_id', 'tag_ids'], ['members', 'total_time']],
      form: { tabs: [{ label: 'Content', fields: ['lessons'] }, { label: 'Description', fields: ['description'] }] },
    },
  }),
};

