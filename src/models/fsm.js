// Field Service depth: worksheets, materials, timesheets, signature and invoicing.
import { create, read, search, write } from '../orm.js';
import { addDays, amounts, productLines, today } from './common.js';

const QUARTER_MINUTES = 15;
const STAGES = [['new', 'New'], ['planned', 'Planned'], ['progress', 'In Progress'], ['done', 'Done']];
const round2 = (n) => Math.round(n * 100) / 100;

/** Timesheet hours, or the legacy `hours` field while no timesheet is logged. */
export const totalHours = (r) => {
  const lines = r.timesheet_ids ?? [];
  return round2(lines.length ? lines.reduce((s, l) => s + (Number(l.hours) || 0), 0) : Number(r.hours) || 0);
};

/** Start the work timer at `now` (ISO datetime) and move the task in progress. */
export function startTimer(db, task, now) {
  if (task.timer_start) throw new Error('A timer is already running on this task');
  return write(db, 'fsm.task', task.id, { timer_start: now, stage_id: 'progress' });
}

/** Stop the timer: logs a timesheet line rounded up to 15 minutes (at least 15). */
export function stopTimer(db, task, now, description = '') {
  if (!task.timer_start) throw new Error('No timer is running on this task');
  const minutes = (new Date(now) - new Date(task.timer_start)) / 60000;
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error('The stop time must be after the start time');
  const quarters = Math.max(1, Math.ceil(minutes / QUARTER_MINUTES));
  const line = { date: now.slice(0, 10), technician_id: task.technician_id ?? null, hours: (quarters * QUARTER_MINUTES) / 60, description };
  return write(db, 'fsm.task', task.id, { timer_start: null, timesheet_ids: [...(task.timesheet_ids ?? []), line] });
}

/** Record the customer's typed signature. */
export function signTask(db, task, name, date = today()) {
  if (!name?.trim()) throw new Error('The customer must type a name to sign');
  return write(db, 'fsm.task', task.id, { customer_signature: name.trim(), signed_on: date });
}

/** Close the task (worksheet complete and signed, unless there is no worksheet) and solve the linked tickets. */
export function markDone(db, task, { date = today() } = {}) {
  const sheet = task.worksheet ?? [];
  if (sheet.length && !sheet.every((l) => l.done)) throw new Error('Complete every worksheet item before marking the task done');
  if (sheet.length && !task.customer_signature) throw new Error('The customer must sign the worksheet first');
  if (task.timer_start) throw new Error('Stop the timer before marking the task done');
  const closed = write(db, 'fsm.task', task.id, { stage_id: 'done' });
  return search(closed, 'helpdesk.ticket')
    .filter((t) => (t.id === task.helpdesk_ticket_id || t.fsm_task_id === task.id) && !['solved', 'cancelled'].includes(t.stage_id))
    .reduce((acc, t) => write(acc, 'helpdesk.ticket', t.id, { stage_id: 'solved', close_date: date }), closed);
}

/** Draft customer invoice for the materials plus total_hours × hourlyRate on the service product. */
export function createInvoice(db, task, { serviceProductId, hourlyRate = 50 } = {}) {
  if (task.invoice_id) throw new Error('This task is already invoiced');
  if (!task.partner_id) throw new Error('Set a customer before invoicing');
  const hours = totalHours(task);
  const service = serviceProductId ? read(db, 'product', serviceProductId) : null;
  const lines = [
    ...(task.material_ids ?? []).filter((l) => Number(l.qty)).map((l) => ({ ...l })),
    ...(hours ? [{ product_id: service?.id ?? null, name: `${task.name} (${hours} h)`, qty: hours, price_unit: hourlyRate, discount: 0, tax: Number(service?.sale_tax ?? 14) }] : []),
  ];
  if (!lines.length) throw new Error('Nothing to invoice: no time spent and no products used');
  const date = today();
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: task.partner_id, invoice_origin: task.name, invoice_date: date, invoice_date_due: addDays(date, 15), invoice_line_ids: lines,
  });
  return { db: write(next, 'fsm.task', task.id, { invoice_id: id }), id };
}

/** Planned hours of a technician's tasks on a date (planned_hours, else hours spent). */
export const technicianLoad = (db, technicianId, date) =>
  round2(search(db, 'fsm.task').filter((t) => t.technician_id === technicianId && t.date === date)
    .reduce((s, t) => s + (Number(t.planned_hours) || Number(t.hours) || 0), 0));

/** Dispatch board for a date: tasks and planned hours per technician (unassigned as null). */
export function planTasks(db, { date = today() } = {}) {
  const tasks = search(db, 'fsm.task').filter((t) => t.date === date);
  return [...new Set(tasks.map((t) => t.technician_id ?? null))].map((technician_id) => {
    const own = tasks.filter((t) => (t.technician_id ?? null) === technician_id);
    return { technician_id, tasks: own, hours: round2(own.reduce((s, t) => s + (Number(t.planned_hours) || Number(t.hours) || 0), 0)) };
  });
}

const askSignature = (db, r) => {
  const name = prompt('Customer name (signature)', read(db, 'res.partner', r.partner_id)?.name ?? '');
  return { db: name == null ? db : signTask(db, r, name) };
};

const invoiceButton = (db, r) => {
  const service = search(db, 'product').find((p) => p.type === 'service' && /hour/i.test(p.name));
  const { db: next, id } = createInvoice(db, r, { serviceProductId: service?.id });
  return { db: next, go: `#/accounting/invoices/${id}` };
};

export const fsmModels = {
  'fsm.task': {
    label: 'Field Service Tasks',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      address: { type: 'char', label: 'Address' },
      technician_id: { type: 'many2one', relation: 'hr.employee', label: 'Technician' },
      date: { type: 'date', label: 'Planned Date' },
      planned_hours: { type: 'float', label: 'Planned Hours' },
      hours: { type: 'float', label: 'Hours Spent' },
      timer_start: { type: 'char', label: 'Timer Started', readonly: true },
      description: { type: 'text', label: 'Description' },
      stage_id: { type: 'selection', label: 'Stage', tracking: true, options: STAGES },
      priority: { type: 'priority', label: 'Priority' },
      tag_ids: { type: 'tags', label: 'Tags' },
      timesheet_ids: {
        type: 'one2many',
        label: 'Timesheets',
        fields: {
          date: { type: 'date', label: 'Date' },
          technician_id: { type: 'many2one', relation: 'hr.employee', label: 'Technician' },
          hours: { type: 'float', label: 'Hours' },
          description: { type: 'char', label: 'Description' },
        },
        newLine: () => ({ date: today(), technician_id: null, hours: 0, description: '' }),
      },
      material_ids: productLines('Products', 'list_price'),
      worksheet: {
        type: 'one2many',
        label: 'Worksheet',
        fields: { label: { type: 'char', label: 'Check' }, done: { type: 'boolean', label: 'Done' }, comment: { type: 'char', label: 'Comment' } },
        newLine: () => ({ label: '', done: false, comment: '' }),
      },
      customer_signature: { type: 'char', label: 'Signed by' },
      signed_on: { type: 'date', label: 'Signed on' },
      invoice_id: { type: 'many2one', relation: 'account.move', label: 'Invoice', readonly: true },
      helpdesk_ticket_id: { type: 'many2one', relation: 'helpdesk.ticket', label: 'Helpdesk Ticket' },
      total_hours: { type: 'float', label: 'Total Hours', compute: totalHours },
      amount_materials: { type: 'monetary', label: 'Products Total', compute: (r) => amounts(r.material_ids).total },
    },
    defaults: () => ({ stage_id: 'new', date: today(), hours: 0, planned_hours: 0, priority: 0, tag_ids: [], timesheet_ids: [], material_ids: [], worksheet: [], timer_start: null }),
    kanban: { groupBy: 'stage_id', quickCreate: true, title: 'name', lines: ['partner_id', 'technician_id', 'date'], tags: 'tag_ids', priority: 'priority' },
    list: ['date', 'name', 'partner_id', 'technician_id', 'planned_hours', 'total_hours', 'stage_id'],
    groupBys: ['stage_id', 'technician_id', 'partner_id', 'date'],
    views: ['kanban', 'list', 'calendar', 'pivot'],
    calendar: { date: 'date' },
    pivot: { row: 'technician_id', col: 'stage_id', measure: 'total_hours' },
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      buttons: [
        { label: 'Start', primary: true, when: (r) => !r.timer_start && r.stage_id !== 'done', run: (db, r) => ({ db: startTimer(db, r, new Date().toISOString()) }) },
        { label: 'Stop', primary: true, when: (r) => !!r.timer_start, run: (db, r) => ({ db: stopTimer(db, r, new Date().toISOString()) }) },
        { label: 'Sign', when: (r) => !r.customer_signature && r.stage_id !== 'done', run: askSignature },
        { label: 'Mark as Done', primary: true, when: (r) => r.stage_id !== 'done' && !r.timer_start, run: (db, r) => ({ db: markDone(db, r) }) },
        { label: 'Create Invoice', when: (r) => r.stage_id === 'done' && !r.invoice_id && r.partner_id, run: invoiceButton },
        { label: 'View Invoice', when: (r) => !!r.invoice_id, run: (db, r) => ({ db, go: `#/accounting/invoices/${r.invoice_id}` }) },
      ],
      title: 'name',
      groups: [['partner_id', 'address', 'helpdesk_ticket_id', 'tag_ids'], ['technician_id', 'date', 'planned_hours', 'total_hours', 'priority', 'customer_signature', 'signed_on', 'invoice_id']],
      tabs: [
        { label: 'Timesheets', fields: ['timesheet_ids'] },
        { label: 'Products', fields: ['material_ids'] },
        { label: 'Worksheet', fields: ['worksheet'] },
        { label: 'Description', fields: ['description'] },
      ],
      footer: ['amount_materials'],
      chatter: true,
    },
  },
};
