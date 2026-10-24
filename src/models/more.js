// Manufacturing, Expenses, Time Off, Recruitment, Timesheets, Events, Subscriptions, To-do, Knowledge, Point of Sale.
import { create, read, write } from '../orm.js';
import { addDays, amountFields, pad, productLines, today } from './common.js';
import { moveStock } from './sales.js';
import { postEntry } from './ledger.js';

const employee = (label = 'Employee') => ({ type: 'many2one', relation: 'hr.employee', label });
const state = (options, label = 'Status') => ({ type: 'selection', label, tracking: true, options });
const components = {
  type: 'one2many',
  label: 'Components',
  fields: {
    product_id: { type: 'many2one', relation: 'product', label: 'Component' },
    qty: { type: 'float', label: 'Quantity' },
  },
  newLine: () => ({ product_id: null, qty: 1 }),
};

const daysBetween = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 864e5) + 1) : 0);
const monthly = (r) => (r.plan === 'yearly' ? (Number(r.recurring_amount) || 0) / 12 : Number(r.recurring_amount) || 0);

function produce(db, mo) {
  const bom = read(db, 'mrp.bom', mo.bom_id);
  if (!bom) throw new Error('Select a bill of materials first');
  const factor = (Number(mo.product_qty) || 0) / (Number(bom.product_qty) || 1);
  const used = (bom.components ?? []).map((c) => ({ product_id: c.product_id, qty: c.qty * factor }));
  const missing = used.find((c) => {
    const p = read(db, 'product', c.product_id);
    return p?.type === 'goods' && p.qty_available < c.qty;
  });
  if (missing) throw new Error(`Not enough ${read(db, 'product', missing.product_id).name} in stock`);
  let next = moveStock(db, used, -1);
  next = moveStock(next, [{ product_id: mo.product_id, qty: mo.product_qty }], 1);
  return { db: write(next, 'mrp.production', mo.id, { state: 'done', date_finished: today() }) };
}

function invoiceSubscription(db, sub) {
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: sub.partner_id,
    invoice_date: today(),
    invoice_date_due: addDays(today(), 15),
    invoice_origin: sub.name,
    invoice_line_ids: [{ product_id: sub.product_id, qty: 1, price_unit: sub.recurring_amount, tax: 14 }],
  });
  const step = sub.plan === 'yearly' ? 365 : 30;
  return { db: write(next, 'sale.subscription', sub.id, { next_invoice_date: addDays(sub.next_invoice_date ?? today(), step) }), go: `#/accounting/invoices/${id}` };
}

export const moreModels = {
  'mrp.bom': {
    label: 'Bills of Materials',
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      product_qty: { type: 'float', label: 'Quantity' },
      components,
    },
    defaults: () => ({ product_qty: 1, components: [] }),
    kanban: { title: 'name', lines: ['product_id'] },
    list: ['name', 'product_id', 'product_qty'],
    views: ['list', 'kanban'],
    form: { title: 'name', groups: [['product_id', 'product_qty'], []], tabs: [{ label: 'Components', fields: ['components'] }], chatter: true },
  },

  'mrp.production': {
    label: 'Manufacturing Orders',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      bom_id: { type: 'many2one', relation: 'mrp.bom', label: 'Bill of Materials' },
      product_qty: { type: 'float', label: 'Quantity To Produce' },
      date_deadline: { type: 'date', label: 'Deadline' },
      date_finished: { type: 'date', label: 'Finished on', readonly: true },
      user_id: employee('Responsible'),
      state: state([['draft', 'Draft'], ['confirmed', 'Confirmed'], ['done', 'Done'], ['cancel', 'Cancelled']]),
    },
    defaults: (id) => ({ name: 'MO/' + pad(id), product_qty: 1, state: 'draft', date_deadline: addDays(today(), 7) }),
    filters: [[{ id: 'todo', label: 'To Do', fn: (r) => ['draft', 'confirmed'].includes(r.state) }, { id: 'done', label: 'Done', fn: (r) => r.state === 'done' }]],
    groupBys: ['state', 'product_id', 'date_deadline'],
    kanban: { groupBy: 'state', title: 'name', lines: ['product_id', 'product_qty', 'date_deadline'], badge: 'user_id' },
    list: ['name', 'product_id', 'product_qty', 'date_deadline', 'user_id', 'state'],
    views: ['list', 'kanban', 'calendar', 'graph'],
    calendar: { date: 'date_deadline' },
    graph: { groupBy: 'product_id', measure: 'product_qty' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => ['done', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Confirm', primary: true, vals: { state: 'confirmed' }, when: (r) => r.state === 'draft' },
        { label: 'Produce', primary: true, when: (r) => r.state === 'confirmed', run: produce },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => ['draft', 'confirmed'].includes(r.state) },
      ],
      title: 'name',
      groups: [['product_id', 'bom_id', 'product_qty'], ['date_deadline', 'date_finished', 'user_id']],
      chatter: true,
    },
  },

  'hr.expense': {
    label: 'Expenses',
    fields: {
      name: { type: 'char', label: 'Description', required: true },
      employee_id: employee(),
      date: { type: 'date', label: 'Expense Date' },
      category: { type: 'selection', label: 'Category', options: [['travel', 'Travel'], ['meals', 'Meals'], ['office', 'Office Supplies'], ['other', 'Other']] },
      total_amount: { type: 'monetary', label: 'Total' },
      state: state([['draft', 'To Submit'], ['submitted', 'Submitted'], ['approved', 'Approved'], ['paid', 'Paid'], ['refused', 'Refused']]),
      notes: { type: 'text', label: 'Notes' },
    },
    defaults: () => ({ date: today(), category: 'other', state: 'draft', employee_id: 1 }),
    filters: [[{ id: 'to_approve', label: 'To Approve', fn: (r) => r.state === 'submitted' }, { id: 'to_pay', label: 'To Pay', fn: (r) => r.state === 'approved' }]],
    groupBys: ['employee_id', 'category', 'state', 'date'],
    kanban: { groupBy: 'state', title: 'name', lines: ['total_amount', 'employee_id'], badge: 'category' },
    list: ['date', 'name', 'employee_id', 'category', 'total_amount', 'state'],
    views: ['list', 'kanban', 'graph', 'pivot'],
    graph: { groupBy: 'category', measure: 'total_amount' },
    pivot: { row: 'employee_id', col: 'category', measure: 'total_amount' },
    form: {
      statusbar: 'state',
      statusbarHide: ['refused'],
      lockedWhen: (r) => r.state !== 'draft',
      buttons: [
        { label: 'Submit', primary: true, vals: { state: 'submitted' }, when: (r) => r.state === 'draft' },
        { label: 'Approve', primary: true, vals: { state: 'approved' }, when: (r) => r.state === 'submitted' },
        { label: 'Refuse', vals: { state: 'refused' }, when: (r) => r.state === 'submitted' },
        {
          label: 'Mark as Paid',
          primary: true,
          when: (r) => r.state === 'approved',
          run: (db, r) => {
            const { db: withEntry } = postEntry(db, {
              journal: 'BNK1', date: today(), ref: `Expense: ${r.name}`,
              lines: [{ account: ['travel', 'meals'].includes(r.category) ? '610000' : '600000', debit: r.total_amount }, { account: '101401', credit: r.total_amount }],
            });
            return { db: write(withEntry, 'hr.expense', r.id, { state: 'paid' }) };
          },
        },
        { label: 'Reset to Draft', vals: { state: 'draft' }, when: (r) => r.state === 'refused' },
      ],
      title: 'name',
      groups: [['employee_id', 'date', 'category'], ['total_amount']],
      tabs: [{ label: 'Notes', fields: ['notes'] }],
      chatter: true,
    },
  },

  'hr.leave': {
    label: 'Time Off',
    fields: {
      name: { type: 'char', label: 'Description', required: true },
      employee_id: employee(),
      leave_type: { type: 'selection', label: 'Time Off Type', options: [['paid', 'Paid Time Off'], ['sick', 'Sick Time Off'], ['unpaid', 'Unpaid'], ['comp', 'Compensatory Days']] },
      date_from: { type: 'date', label: 'From', required: true },
      date_to: { type: 'date', label: 'To', required: true },
      number_of_days: { type: 'float', label: 'Duration (days)', compute: (r) => daysBetween(r.date_from, r.date_to) },
      state: state([['confirm', 'To Approve'], ['validate', 'Approved'], ['refuse', 'Refused']]),
    },
    defaults: () => ({ name: 'Time off', leave_type: 'paid', date_from: today(), date_to: today(), state: 'confirm', employee_id: 1 }),
    filters: [[{ id: 'to_approve', label: 'To Approve', fn: (r) => r.state === 'confirm' }, { id: 'approved', label: 'Approved', fn: (r) => r.state === 'validate' }]],
    groupBys: ['employee_id', 'leave_type', 'state', 'date_from'],
    kanban: { title: 'name', lines: ['employee_id', 'date_from', 'number_of_days'], badge: 'state' },
    list: ['employee_id', 'leave_type', 'name', 'date_from', 'date_to', 'number_of_days', 'state'],
    views: ['gantt', 'calendar', 'list', 'kanban', 'pivot'],
    gantt: { start: 'date_from', stop: 'date_to', row: 'employee_id', color: 'state' },
    calendar: { date: 'date_from' },
    pivot: { row: 'employee_id', col: 'leave_type', measure: 'number_of_days' },
    form: {
      statusbar: 'state',
      buttons: [
        { label: 'Approve', primary: true, vals: { state: 'validate' }, when: (r) => r.state === 'confirm' },
        { label: 'Refuse', vals: { state: 'refuse' }, when: (r) => r.state === 'confirm' },
      ],
      title: 'name',
      groups: [['employee_id', 'leave_type'], ['date_from', 'date_to', 'number_of_days']],
      chatter: true,
    },
  },

  'hr.job': {
    label: 'Job Positions',
    fields: {
      name: { type: 'char', label: 'Job Position', required: true },
      department_id: { type: 'many2one', relation: 'hr.department', label: 'Department' },
      no_of_recruitment: { type: 'float', label: 'Target' },
      is_published: { type: 'boolean', label: 'Published on Website' },
      description: { type: 'text', label: 'Job Summary' },
    },
    defaults: () => ({ no_of_recruitment: 1 }),
    kanban: { title: 'name', lines: ['department_id'], counter: { label: 'Applications', model: 'hr.applicant', field: 'job_id' } },
    list: ['name', 'department_id', 'no_of_recruitment'],
    form: {
      title: 'name',
      smart: [{ label: 'Applications', model: 'hr.applicant', field: 'job_id', target: 'recruitment/applications' }],
      groups: [['department_id', 'no_of_recruitment'], ['is_published']],
      tabs: [{ label: 'Job Summary', fields: ['description'] }],
      chatter: true,
    },
  },

  'hr.applicant': {
    label: 'Applications',
    fields: {
      name: { type: 'char', label: 'Candidate Name', required: true },
      job_id: { type: 'many2one', relation: 'hr.job', label: 'Job Position' },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      stage_id: state([['new', 'New'], ['screening', 'Initial Qualification'], ['interview', 'Interview'], ['contract', 'Contract Proposal'], ['hired', 'Contract Signed']], 'Stage'),
      expected_salary: { type: 'monetary', label: 'Expected Salary' },
      priority: { type: 'priority', label: 'Evaluation' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Notes' },
    },
    defaults: () => ({ stage_id: 'new', priority: 0, tag_ids: [] }),
    groupBys: ['stage_id', 'job_id'],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['job_id', 'email'], tags: 'tag_ids', priority: 'priority', quickCreate: true },
    list: ['name', 'job_id', 'email', 'phone', 'expected_salary', 'stage_id'],
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      buttons: [{ label: 'Refuse', vals: { active: false }, when: (r) => r.active !== false }],
      title: 'name',
      groups: [['job_id', 'email', 'phone'], ['expected_salary', 'priority', 'tag_ids']],
      tabs: [{ label: 'Notes', fields: ['description'] }],
      chatter: true,
    },
  },

  'account.analytic.line': {
    label: 'Timesheets',
    fields: {
      date: { type: 'date', label: 'Date', required: true },
      employee_id: employee(),
      project_id: { type: 'many2one', relation: 'project.project', label: 'Project' },
      task_id: { type: 'many2one', relation: 'project.task', label: 'Task' },
      name: { type: 'char', label: 'Description', required: true },
      unit_amount: { type: 'float', label: 'Hours Spent' },
    },
    defaults: () => ({ date: today(), employee_id: 1, unit_amount: 1, name: '/' }),
    filters: [[{ id: 'today', label: 'Today', fn: (r) => r.date === today() }]],
    groupBys: ['employee_id', 'project_id', 'task_id', 'date'],
    kanban: { title: 'name', lines: ['project_id', 'unit_amount', 'date'] },
    list: ['date', 'employee_id', 'project_id', 'task_id', 'name', 'unit_amount'],
    views: ['list', 'graph', 'pivot', 'calendar'],
    graph: { groupBy: 'project_id', measure: 'unit_amount' },
    pivot: { row: 'employee_id', col: 'project_id', measure: 'unit_amount' },
    calendar: { date: 'date' },
    form: { title: 'name', groups: [['date', 'employee_id', 'unit_amount'], ['project_id', 'task_id']], chatter: false },
  },

  'event.event': {
    label: 'Events',
    fields: {
      name: { type: 'char', label: 'Event Name', required: true },
      date_begin: { type: 'date', label: 'Start Date', required: true },
      date_end: { type: 'date', label: 'End Date' },
      location: { type: 'char', label: 'Venue' },
      seats_max: { type: 'float', label: 'Maximum Attendees' },
      stage_id: state([['new', 'New'], ['booked', 'Booked'], ['announced', 'Announced'], ['ended', 'Ended'], ['cancelled', 'Cancelled']], 'Stage'),
      user_id: employee('Organizer'),
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Description' },
    },
    defaults: () => ({ date_begin: addDays(today(), 14), stage_id: 'new', seats_max: 50, tag_ids: [] }),
    groupBys: ['stage_id', 'date_begin', 'user_id'],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['date_begin', 'location'], tags: 'tag_ids', counter: { label: 'Attendees', model: 'event.registration', field: 'event_id' } },
    list: ['name', 'date_begin', 'date_end', 'location', 'seats_max', 'stage_id'],
    views: ['kanban', 'list', 'calendar'],
    calendar: { date: 'date_begin' },
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      title: 'name',
      smart: [{ label: 'Attendees', model: 'event.registration', field: 'event_id', target: 'events/attendees' }],
      groups: [['date_begin', 'date_end', 'location'], ['seats_max', 'user_id', 'tag_ids']],
      tabs: [{ label: 'Description', fields: ['description'] }],
      chatter: true,
    },
  },

  'event.registration': {
    label: 'Attendees',
    fields: {
      name: { type: 'char', label: 'Attendee Name', required: true },
      event_id: { type: 'many2one', relation: 'event.event', label: 'Event', required: true },
      email: { type: 'char', label: 'Email' },
      phone: { type: 'char', label: 'Phone' },
      state: state([['open', 'Registered'], ['done', 'Attended'], ['cancel', 'Cancelled']]),
    },
    defaults: () => ({ state: 'open' }),
    groupBys: ['event_id', 'state'],
    kanban: { groupBy: 'state', title: 'name', lines: ['event_id', 'email'] },
    list: ['name', 'event_id', 'email', 'phone', 'state'],
    views: ['list', 'kanban'],
    form: {
      statusbar: 'state',
      statusbarClickable: true,
      buttons: [{ label: 'Attended', primary: true, vals: { state: 'done' }, when: (r) => r.state === 'open' }],
      title: 'name',
      groups: [['event_id', 'email', 'phone'], []],
      chatter: true,
    },
  },

  'sale.subscription': {
    label: 'Subscriptions',
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product' },
      plan: { type: 'selection', label: 'Recurring Plan', options: [['monthly', 'Monthly'], ['yearly', 'Yearly']] },
      recurring_amount: { type: 'monetary', label: 'Recurring Price' },
      recurring_monthly: { type: 'monetary', label: 'Monthly Recurring Revenue', compute: monthly },
      start_date: { type: 'date', label: 'Start Date' },
      next_invoice_date: { type: 'date', label: 'Next Invoice' },
      stage: state([['draft', 'Quotation'], ['progress', 'In Progress'], ['paused', 'Paused'], ['closed', 'Closed']], 'Stage'),
    },
    defaults: (id) => ({ name: 'SUB/' + pad(id), plan: 'monthly', start_date: today(), next_invoice_date: today(), stage: 'draft' }),
    filters: [[{ id: 'running', label: 'In Progress', fn: (r) => r.stage === 'progress' }, { id: 'due', label: 'To Invoice', fn: (r) => r.stage === 'progress' && r.next_invoice_date <= today() }]],
    groupBys: ['stage', 'plan', 'partner_id'],
    kanban: { groupBy: 'stage', title: 'name', lines: ['partner_id', 'recurring_monthly', 'next_invoice_date'], sum: 'recurring_monthly' },
    list: ['name', 'partner_id', 'plan', 'recurring_amount', 'recurring_monthly', 'next_invoice_date', 'stage'],
    views: ['kanban', 'list', 'graph', 'pivot'],
    graph: { groupBy: 'partner_id', measure: 'recurring_monthly' },
    pivot: { row: 'plan', col: 'stage', measure: 'recurring_monthly' },
    form: {
      statusbar: 'stage',
      statusbarClickable: true,
      buttons: [
        { label: 'Start', primary: true, vals: { stage: 'progress' }, when: (r) => r.stage === 'draft' },
        { label: 'Generate Invoice', primary: true, when: (r) => r.stage === 'progress', run: invoiceSubscription },
        { label: 'Pause', vals: { stage: 'paused' }, when: (r) => r.stage === 'progress' },
        { label: 'Resume', vals: { stage: 'progress' }, when: (r) => r.stage === 'paused' },
        { label: 'Close', vals: { stage: 'closed' }, when: (r) => ['progress', 'paused'].includes(r.stage) },
      ],
      title: 'name',
      groups: [['partner_id', 'product_id', 'plan', 'recurring_amount'], ['start_date', 'next_invoice_date', 'recurring_monthly']],
      chatter: true,
    },
  },

  'todo.task': {
    label: 'To-do',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      stage: { type: 'selection', label: 'Stage', options: [['inbox', 'Inbox'], ['today', 'Today'], ['week', 'This Week'], ['later', 'Later'], ['done', 'Done']] },
      date_deadline: { type: 'date', label: 'Deadline' },
      priority: { type: 'priority', label: 'Priority' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Description' },
    },
    defaults: () => ({ stage: 'inbox', priority: 0, tag_ids: [] }),
    groupBys: ['stage', 'date_deadline'],
    kanban: { groupBy: 'stage', title: 'name', lines: ['date_deadline'], tags: 'tag_ids', priority: 'priority', quickCreate: true },
    list: ['name', 'date_deadline', 'stage'],
    form: { title: 'name', groups: [['stage', 'date_deadline'], ['priority', 'tag_ids']], tabs: [{ label: 'Description', fields: ['description'] }], chatter: true },
  },

  'knowledge.article': {
    label: 'Articles',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      parent_id: { type: 'many2one', relation: 'knowledge.article', label: 'Parent Article' },
      category: { type: 'selection', label: 'Section', options: [['workspace', 'Workspace'], ['shared', 'Shared'], ['private', 'Private']] },
      is_favorite: { type: 'boolean', label: 'Favorite' },
      body: { type: 'text', label: 'Content' },
      write_date: { type: 'date', label: 'Last Edited', readonly: true },
    },
    defaults: () => ({ category: 'workspace', write_date: today() }),
    filters: [[{ id: 'fav', label: 'Favorites', fn: (r) => r.is_favorite }]],
    groupBys: ['category', 'parent_id'],
    kanban: { groupBy: 'category', title: 'name', lines: ['parent_id', 'write_date'] },
    list: ['name', 'parent_id', 'category', 'write_date'],
    form: { title: 'name', groups: [['parent_id', 'category'], ['is_favorite', 'write_date']], tabs: [{ label: 'Content', fields: ['body'] }], chatter: true },
  },

  'pos.order': {
    label: 'Orders',
    fields: {
      name: { type: 'char', label: 'Order Ref', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      date_order: { type: 'date', label: 'Date', readonly: true },
      payment_method: { type: 'selection', label: 'Payment Method', options: [['cash', 'Cash'], ['card', 'Card']] },
      kitchen_state: { type: 'selection', label: 'Kitchen', options: [['new', 'To Cook'], ['cooking', 'Cooking'], ['ready', 'Ready'], ['served', 'Served']] },
      lines: productLines('Products', 'list_price'),
      ...amountFields('lines'),
    },
    defaults: (id) => ({ name: 'POS/' + pad(id), date_order: today(), payment_method: 'cash', lines: [] }),
    groupBys: ['payment_method', 'partner_id', 'date_order'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total'], badge: 'payment_method' },
    list: ['name', 'date_order', 'partner_id', 'payment_method', 'amount_total'],
    views: ['list', 'kanban', 'graph', 'pivot'],
    graph: { groupBy: 'date_order', measure: 'amount_total' },
    pivot: { row: 'date_order', col: 'payment_method', measure: 'amount_total' },
    form: { lockedWhen: () => true, title: 'name', groups: [['partner_id', 'payment_method'], ['date_order']], tabs: [{ label: 'Products', fields: ['lines'] }], footer: ['amount_untaxed', 'amount_tax', 'amount_total'], chatter: true },
  },
};
