// Manufacturing, Expenses, Time Off, Recruitment, Timesheets, Events, Subscriptions, To-do, Point of Sale.
import { create, read, write } from '../orm.js';
import { addDays, amountFields, amounts, pad, productLines, today } from './common.js';
import { capitalizeStock, deliver, moveValued } from './valuation.js';
import { applyLots } from './logistics.js';
import { refundOrder } from './pos.js';
import { postEntry } from './ledger.js';
import { lineToStockQty } from './uom.js';
import { freeQty } from './picking.js';

const employee = (label = 'Employee') => ({ type: 'many2one', relation: 'hr.employee', label });
const state = (options, label = 'Status') => ({ type: 'selection', label, tracking: true, options });
const components = {
  type: 'one2many',
  label: 'Components',
  fields: {
    product_id: { type: 'many2one', relation: 'product', label: 'Component' },
    uom_id: { type: 'many2one', relation: 'uom.uom', label: 'Unit of Measure' },
    qty: { type: 'float', label: 'Quantity' },
  },
  newLine: () => ({ product_id: null, qty: 1 }),
};

const daysBetween = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 864e5) + 1) : 0);
const PLAN_MONTHS = { weekly: 12 / 52, monthly: 1, quarterly: 3, yearly: 12 };
/** Recurring price per period: the untaxed lines when there are any, else the single recurring price. */
const periodAmount = (r) => ((r.order_line ?? []).length ? amounts(r.order_line).untaxed : Number(r.recurring_amount) || 0);
const monthly = (r) => Math.round((periodAmount(r) / (PLAN_MONTHS[r.plan] ?? 1)) * 100) / 100;
/** Next period start: calendar months (day clamped to month end), or 7 days for weekly plans. */
export function nextPeriod(date, plan) {
  if (plan === 'weekly') return addDays(date, 7);
  const [y, m, d] = date.split('-').map(Number);
  const total = m - 1 + (PLAN_MONTHS[plan] ?? 1);
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(d, new Date(year, month, 0).getDate());
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const CLOSE_REASONS = [['price', 'Too expensive'], ['quality', 'Quality issues'], ['competitor', 'Moved to a competitor'], ['no_need', 'No longer needed'], ['other', 'Other']];

/** Components and work orders of an MO, scaled from its bill of materials. */
export function explode(db, mo) {
  const bom = read(db, 'mrp.bom', mo.bom_id);
  if (!bom) throw new Error('Select a bill of materials first');
  const factor = (Number(mo.product_qty) || 0) / (Number(bom.product_qty) || 1);
  return {
    move_raw: (bom.components ?? []).map((c) => ({ product_id: c.product_id, to_consume: lineToStockQty(db, { ...c, qty: (Number(c.qty) || 0) * factor }, read(db, 'product', c.product_id)), consumed: null })),
    workorders: (bom.operations ?? []).map((o) => ({ name: o.name, workcenter_id: o.workcenter_id, duration_expected: (Number(o.duration) || 0) * factor, duration: 0, state: 'ready' })),
  };
}

// Components count as available only when free: stock reserved by deliveries or other MOs is left alone.
const availability = (db, moves, moId) => (moves.every((m) => {
  const p = read(db, 'product', m.product_id);
  return p?.type !== 'goods' || freeQty(db, p.id, null, moId) >= m.to_consume;
}) ? 'available' : 'waiting');

/** Confirm: lay out components and work orders and report whether components are in stock. */
export function confirmMo(db, mo) {
  if (read(db, 'mrp.production', mo.id)?.state !== 'draft') throw new Error('Only draft manufacturing orders can be confirmed');
  const { move_raw, workorders } = explode(db, mo);
  return write(db, 'mrp.production', mo.id, { state: 'confirmed', move_raw, workorders, components_availability: availability(db, move_raw, mo.id) });
}

/**
 * Produce: consume what was recorded (to-consume by default, scaled to the quantity producing), stock the finished
 * product (with its lot), close work orders. Producing less than planned leaves a backorder MO for the rest.
 */
/** Quantities an MO will consume: what was recorded, else the BoM share for the quantity being produced. */
function consumption(db, mo) {
  const moves = mo.move_raw?.length ? mo.move_raw : explode(db, mo).move_raw;
  const planned = Number(mo.product_qty) || 0;
  const producing = Number(mo.qty_producing) > 0 ? Math.min(Number(mo.qty_producing), planned) : planned;
  const ratio = planned ? producing / planned : 1;
  const recorded = (m) => m.consumed !== null && m.consumed !== undefined && m.consumed !== '';
  const used = moves.map((m) => ({ product_id: m.product_id, qty: recorded(m) ? Number(m.consumed) || 0 : round2((Number(m.to_consume) || 0) * ratio), expected: round2((Number(m.to_consume) || 0) * ratio) }));
  return { moves, planned, producing, ratio, used };
}

/** Components consumed below the bill of materials (goods only), e.g. a 0 typed on a line. */
export const underConsumed = (db, mo) => consumption(db, mo).used
  .filter((c) => read(db, 'product', c.product_id)?.type === 'goods' && c.qty < c.expected - 1e-6);

/** Produce button: consuming less than the BoM needs an explicit confirmation. */
const produceButton = (db, mo) => {
  const short = underConsumed(db, mo);
  const allow = short.length > 0 && typeof confirm === 'function'
    && confirm(`Less than the bill of materials is consumed for ${short.map((c) => read(db, 'product', c.product_id)?.name).join(', ')}. Produce anyway?`);
  return produce(db, mo, { allowUnderConsumption: allow });
};

export function produce(db, mo, { allowUnderConsumption = false } = {}) {
  if (['done', 'cancel'].includes(mo.state)) throw new Error('This manufacturing order is already processed');
  const { moves, planned, producing, ratio, used } = consumption(db, mo);
  const short = underConsumed(db, mo);
  if (short.length && !allowUnderConsumption) throw new Error(`Less than the bill of materials is consumed for ${short.map((c) => read(db, 'product', c.product_id)?.name).join(', ')}; confirm to produce anyway`);
  const missing = used.find((c) => {
    const p = read(db, 'product', c.product_id);
    return p?.type === 'goods' && p.qty_available < c.qty;
  });
  if (missing) throw new Error(`Not enough ${read(db, 'product', missing.product_id).name} in stock`);
  const product = read(db, 'product', mo.product_id);
  if (product?.tracking && product.tracking !== 'none' && !mo.lot_name) throw new Error(`Set a lot/serial number for ${product.name}`);
  if (product?.tracking === 'serial' && producing !== 1) throw new Error('Serial-tracked products are produced one at a time');
  const finished = [{ product_id: mo.product_id, qty: producing, lot_name: mo.lot_name || undefined }];
  let consumed = db;
  let value = 0;
  for (const l of used) {
    const p = read(consumed, 'product', l.product_id);
    if (p?.type !== 'goods' || !l.qty) continue;
    if (p.valuation === 'manual_periodic') {
      consumed = moveValued(consumed, [l], -1);
      value += l.qty * (Number(p.cost) || 0);
    } else {
      const out = deliver(consumed, p.id, l.qty, { reference: mo.name, counterpart: '600000' });
      consumed = out.db;
      value += out.value;
    }
  }
  let stocked = moveValued(applyLots(consumed, { move_ids: finished }, 1), finished.map((l) => ({ ...l, unit_cost: producing ? value / producing : 0 })), 1, { reference: mo.name, counterpart: '600000' });
  if (mo.operation_cost_move_id && product?.valuation !== 'manual_periodic') {
    const operation = read(stocked, 'account.move', mo.operation_cost_move_id);
    const cost = (operation?.line_ids ?? []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
    if (cost) stocked = capitalizeStock(stocked, mo.product_id, cost, { reference: `Operation costs ${mo.name}`, moveId: operation.id });
  }
  const closed = write(stocked, 'mrp.production', mo.id, {
    state: 'done', date_finished: today(), product_qty: producing, qty_producing: producing,
    move_raw: moves.map((m, i) => ({ ...m, to_consume: round2((Number(m.to_consume) || 0) * ratio), consumed: used[i].qty })),
    workorders: (mo.workorders ?? []).map((w) => ({ ...w, state: 'done', duration: Number(w.duration) || Number(w.duration_expected) || 0 })),
  });
  if (producing >= planned) return { db: closed };
  const rest = create(closed, 'mrp.production', {
    product_id: mo.product_id, bom_id: mo.bom_id, product_qty: round2(planned - producing), origin: mo.name, backorder_of: mo.id,
    user_id: mo.user_id ?? null, date_deadline: mo.date_deadline ?? null, priority: mo.priority ?? 0,
  });
  return { db: confirmMo(rest.db, read(rest.db, 'mrp.production', rest.id)), go: `#/manufacturing/orders/${rest.id}` };
}

const round2 = (n) => Math.round(n * 100) / 100;
const CATEGORY_ACCOUNT = { travel: '610000', meals: '610000' };

/**
 * Post an approved expense: expense (net) + input VAT against the employee (to reimburse) or the bank (company paid).
 * The product's expense account wins over the category default.
 */
function postExpense(db, r) {
  const total = Number(r.total_amount) || 0;
  if (!(total > 0)) throw new Error('The expense total must be positive');
  const tax = round2(total - total / (1 + (Number(r.tax) || 0) / 100));
  const product = read(db, 'product', r.product_id);
  const accountCode = (product?.property_account_expense_id && read(db, 'account.account', product.property_account_expense_id)?.code) || CATEGORY_ACCOUNT[r.category] || '600000';
  const own = r.payment_mode !== 'company_account';
  const { db: booked, id } = postEntry(db, {
    journal: own ? 'MISC' : 'BNK1', date: r.date ?? today(), ref: `Expense: ${r.name}`,
    lines: [
      { account: accountCode, debit: round2(total - tax) },
      ...(tax ? [{ account: '131000', debit: tax, tax_name: `${Number(r.tax) || 0}%`, tax_base: round2(total - tax) }] : []),
      { account: own ? '230100' : '101401', credit: total },
    ],
  });
  return write(booked, 'hr.expense', r.id, { state: own ? 'posted' : 'paid', move_id: id });
}

/** Reimburse the employee for a posted expense they paid themselves. */
function reimburse(db, r) {
  const { db: paid } = postEntry(db, {
    journal: 'BNK1', date: today(), ref: `Reimbursement: ${r.name}`,
    lines: [{ account: '230100', debit: r.total_amount }, { account: '101401', credit: r.total_amount }],
  });
  return write(paid, 'hr.expense', r.id, { state: 'paid' });
}

const REFUSE_REASONS = [['skills', 'Does not fit the job requirements'], ['declined', 'Refused by applicant'], ['salary', 'Salary expectations too high'], ['duplicate', 'Duplicate'], ['other', 'Other']];

/** Hire: create the employee from the applicant (job, department, proposed wage) and link it back. */
function createEmployee(db, r) {
  const job = read(db, 'hr.job', r.job_id);
  const { db: next, id } = create(db, 'hr.employee', {
    name: r.name, job_title: job?.name ?? '', department_id: job?.department_id ?? null, work_email: r.email ?? '', mobile_phone: r.phone ?? '',
    wage: Number(r.salary_proposed) || Number(r.expected_salary) || 0, join_date: r.availability || today(),
  });
  return { db: write(next, 'hr.applicant', r.id, { emp_id: id, stage_id: 'hired', date_closed: today() }), go: `#/employees/employees/${id}` };
}

function refuseApplicant(db, r) {
  const pick = prompt(`Refuse reason:\n${REFUSE_REASONS.map(([, l], i) => `${i + 1}. ${l}`).join('\n')}`, '1');
  if (pick == null) return { db };
  return { db: write(db, 'hr.applicant', r.id, { active: false, refuse_reason: REFUSE_REASONS[Number(pick) - 1]?.[0] ?? 'other' }) };
}

function invoiceSubscription(db, sub) {
  const lines = (sub.order_line ?? []).length ? sub.order_line.map((l) => ({ ...l })) : [{ product_id: sub.product_id, qty: 1, price_unit: sub.recurring_amount, tax: 14 }];
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: sub.partner_id,
    invoice_date: today(),
    invoice_date_due: addDays(today(), 15),
    invoice_origin: sub.name,
    subscription_id: sub.id,
    invoice_line_ids: lines,
  });
  const nextDate = nextPeriod(sub.next_invoice_date ?? today(), sub.plan);
  const ended = sub.end_date && nextDate > sub.end_date;
  return { db: write(next, 'sale.subscription', sub.id, { next_invoice_date: nextDate, ...(ended ? { stage: 'closed', close_reason: null } : {}) }), go: `#/accounting/invoices/${id}` };
}

function closeSubscription(db, r) {
  const pick = prompt(`Close reason:\n${CLOSE_REASONS.map(([, l], i) => `${i + 1}. ${l}`).join('\n')}`, '1');
  if (pick == null) return { db };
  return { db: write(db, 'sale.subscription', r.id, { stage: 'closed', close_reason: CLOSE_REASONS[Number(pick) - 1]?.[0] ?? 'other', end_date: today() }) };
}

export const moreModels = {
  'mrp.bom': {
    label: 'Bills of Materials',
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      product_qty: { type: 'float', label: 'Quantity' },
      components,
      operations: {
        type: 'one2many', label: 'Operations',
        fields: { name: { type: 'char', label: 'Operation' }, workcenter_id: { type: 'many2one', relation: 'mrp.workcenter', label: 'Work Center' }, duration: { type: 'float', label: 'Duration (min)' } },
        newLine: () => ({ name: '', workcenter_id: null, duration: 60 }),
      },
    },
    defaults: () => ({ product_qty: 1, components: [], operations: [] }),
    kanban: { title: 'name', lines: ['product_id'] },
    list: ['name', 'product_id', 'product_qty'],
    views: ['list', 'kanban'],
    form: { title: 'name', groups: [['product_id', 'product_qty'], []], tabs: [{ label: 'Components', fields: ['components'] }, { label: 'Operations', fields: ['operations'] }], chatter: true },
  },

  'mrp.workcenter': {
    label: 'Work Centers',
    fields: {
      name: { type: 'char', label: 'Work Center', required: true },
      code: { type: 'char', label: 'Code' },
      capacity: { type: 'float', label: 'Capacity' },
      time_efficiency: { type: 'float', label: 'Time Efficiency (%)' },
      costs_hour: { type: 'monetary', label: 'Cost per Hour' },
    },
    defaults: () => ({ capacity: 1, time_efficiency: 100, costs_hour: 0 }),
    kanban: { title: 'name', lines: ['code', 'costs_hour'] },
    list: ['code', 'name', 'capacity', 'time_efficiency', 'costs_hour'],
    form: { title: 'name', groups: [['code', 'capacity'], ['time_efficiency', 'costs_hour']], chatter: true },
  },

  'mrp.production': {
    label: 'Manufacturing Orders',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      bom_id: { type: 'many2one', relation: 'mrp.bom', label: 'Bill of Materials' },
      product_qty: { type: 'float', label: 'Quantity To Produce' },
      qty_producing: { type: 'float', label: 'Quantity Producing' },
      backorder_of: { type: 'many2one', relation: 'mrp.production', label: 'Backorder of', readonly: true },
      date_deadline: { type: 'date', label: 'Deadline' },
      date_finished: { type: 'date', label: 'Finished on', readonly: true },
      user_id: employee('Responsible'),
      origin: { type: 'char', label: 'Source', readonly: true },
      priority: { type: 'priority', label: 'Priority' },
      date_start: { type: 'date', label: 'Scheduled Date' },
      lot_name: { type: 'char', label: 'Lot/Serial Number' },
      components_availability: { type: 'selection', label: 'Component Status', readonly: true, options: [['available', 'Available'], ['waiting', 'Not Available']] },
      move_raw: {
        type: 'one2many', label: 'Components',
        fields: { product_id: { type: 'many2one', relation: 'product', label: 'Product' }, to_consume: { type: 'float', label: 'To Consume', readonly: true }, consumed: { type: 'float', label: 'Consumed' } },
        newLine: () => ({ product_id: null, to_consume: 0, consumed: null }),
      },
      workorders: {
        type: 'one2many', label: 'Work Orders',
        fields: {
          name: { type: 'char', label: 'Operation' }, workcenter_id: { type: 'many2one', relation: 'mrp.workcenter', label: 'Work Center' },
          duration_expected: { type: 'float', label: 'Expected (min)', readonly: true }, duration: { type: 'float', label: 'Real (min)' },
          state: { type: 'selection', label: 'Status', options: [['ready', 'Ready'], ['progress', 'In Progress'], ['done', 'Finished']] },
        },
        newLine: () => ({ name: '', workcenter_id: null, duration_expected: 0, duration: 0, state: 'ready' }),
      },
      state: state([['draft', 'Draft'], ['confirmed', 'Confirmed'], ['progress', 'In Progress'], ['done', 'Done'], ['cancel', 'Cancelled']]),
    },
    defaults: (id) => ({ name: 'MO/' + pad(id), product_qty: 1, state: 'draft', priority: 0, date_start: today(), date_deadline: addDays(today(), 7), move_raw: [], workorders: [] }),
    filters: [
      [{ id: 'todo', label: 'To Do', fn: (r) => ['draft', 'confirmed', 'progress'].includes(r.state) }, { id: 'done', label: 'Done', fn: (r) => r.state === 'done' }],
      [{ id: 'waiting', label: 'Waiting Components', fn: (r) => r.components_availability === 'waiting' && r.state !== 'done' }],
    ],
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
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: confirmMo(db, r) }) },
        { label: 'Check Availability', when: (r) => r.state === 'confirmed', run: (db, r) => ({ db: write(db, 'mrp.production', r.id, { components_availability: availability(db, r.move_raw ?? [], r.id) }) }) },
        { label: 'Start', when: (r) => r.state === 'confirmed', vals: { state: 'progress' } },
        { label: 'Produce', primary: true, when: (r) => ['confirmed', 'progress'].includes(r.state), run: produceButton },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => ['draft', 'confirmed', 'progress'].includes(r.state) },
      ],
      title: 'name',
      groups: [['product_id', 'bom_id', 'product_qty', 'qty_producing', 'lot_name', 'backorder_of'], ['date_start', 'date_deadline', 'components_availability', 'user_id', 'priority', 'date_finished']],
      tabs: [{ label: 'Components', fields: ['move_raw'] }, { label: 'Work Orders', fields: ['workorders'] }],
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
      product_id: { type: 'many2one', relation: 'product', label: 'Expense Product' },
      quantity: { type: 'float', label: 'Quantity' },
      unit_amount: { type: 'monetary', label: 'Unit Price' },
      tax: { type: 'float', label: 'Tax % (included)' },
      total_amount: { type: 'monetary', label: 'Total' },
      payment_mode: { type: 'selection', label: 'Paid By', options: [['own_account', 'Employee (to reimburse)'], ['company_account', 'Company']] },
      receipt: { type: 'binary', label: 'Receipt' },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      state: state([['draft', 'To Submit'], ['submitted', 'Submitted'], ['approved', 'Approved'], ['posted', 'Posted'], ['paid', 'Paid'], ['refused', 'Refused']]),
      notes: { type: 'text', label: 'Notes' },
    },
    defaults: () => ({ date: today(), category: 'other', state: 'draft', employee_id: 1, quantity: 1, tax: 0, payment_mode: 'own_account' }),
    // A product fills the unit price and tax; quantity × unit price (tax included) gives the total.
    onchange: (r, key, db) => {
      if (key === 'product_id' && r.product_id) {
        const p = read(db, 'product', r.product_id);
        const unit = Number(p?.cost) || 0;
        return { unit_amount: unit, tax: p?.purchase_tax ?? r.tax, name: r.name || p?.name || '', total_amount: round2((Number(r.quantity) || 1) * unit * (1 + (Number(p?.purchase_tax ?? r.tax) || 0) / 100)) };
      }
      if (['quantity', 'unit_amount', 'tax'].includes(key) && Number(r.unit_amount) > 0) return { total_amount: round2((Number(r.quantity) || 0) * Number(r.unit_amount) * (1 + (Number(r.tax) || 0) / 100)) };
      return {};
    },
    filters: [[{ id: 'to_approve', label: 'To Approve', fn: (r) => r.state === 'submitted' }, { id: 'to_post', label: 'To Post', fn: (r) => r.state === 'approved' }, { id: 'to_pay', label: 'To Reimburse', fn: (r) => r.state === 'posted' }]],
    groupBys: ['employee_id', 'category', 'payment_mode', 'state', 'date'],
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
        { label: 'Post Journal Entries', primary: true, when: (r) => r.state === 'approved', run: (db, r) => ({ db: postExpense(db, r) }) },
        { label: 'Register Payment', primary: true, when: (r) => r.state === 'posted', run: (db, r) => ({ db: reimburse(db, r) }) },
        { label: 'Reset to Draft', vals: { state: 'draft' }, when: (r) => r.state === 'refused' },
      ],
      title: 'name',
      groups: [['employee_id', 'date', 'category', 'product_id', 'payment_mode'], ['quantity', 'unit_amount', 'tax', 'total_amount', 'move_id', 'receipt']],
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
      stage_id: state([['new', 'New'], ['screening', 'Initial Qualification'], ['interview', 'First Interview'], ['interview2', 'Second Interview'], ['contract', 'Contract Proposal'], ['hired', 'Contract Signed']], 'Stage'),
      expected_salary: { type: 'monetary', label: 'Expected Salary' },
      salary_proposed: { type: 'monetary', label: 'Proposed Salary' },
      availability: { type: 'date', label: 'Availability' },
      degree: { type: 'selection', label: 'Degree', options: [['graduate', 'Graduate'], ['bachelor', 'Bachelor Degree'], ['master', 'Master Degree'], ['doctoral', 'Doctoral Degree']] },
      user_id: employee('Recruiter'),
      interviewers: {
        type: 'one2many', label: 'Interviewers',
        fields: { employee_id: employee('Interviewer'), evaluation: { type: 'priority', label: 'Evaluation' }, note: { type: 'char', label: 'Feedback' } },
        newLine: () => ({ employee_id: null, evaluation: 0, note: '' }),
      },
      source: { type: 'selection', label: 'Source', options: [['website', 'Website'], ['linkedin', 'LinkedIn'], ['referral', 'Referral'], ['agency', 'Agency'], ['other', 'Other']] },
      linkedin: { type: 'char', label: 'LinkedIn Profile' },
      refuse_reason: { type: 'selection', label: 'Refuse Reason', options: REFUSE_REASONS },
      emp_id: employee('Employee'),
      date_closed: { type: 'date', label: 'Hired on', readonly: true },
      priority: { type: 'priority', label: 'Evaluation' },
      tag_ids: { type: 'tags', label: 'Tags' },
      description: { type: 'text', label: 'Notes' },
    },
    defaults: () => ({ stage_id: 'new', priority: 0, tag_ids: [], interviewers: [] }),
    groupBys: ['stage_id', 'job_id', 'user_id', 'source', 'refuse_reason'],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['job_id', 'email'], tags: 'tag_ids', priority: 'priority', quickCreate: true },
    list: ['name', 'job_id', 'email', 'phone', 'expected_salary', 'stage_id'],
    form: {
      statusbar: 'stage_id',
      statusbarClickable: true,
      buttons: [
        { label: 'Create Employee', primary: true, when: (r) => !r.emp_id && ['contract', 'hired'].includes(r.stage_id) && r.active !== false, run: createEmployee },
        { label: 'Refuse', when: (r) => r.active !== false && !r.emp_id, run: refuseApplicant },
        { label: 'Restore', vals: { active: true, refuse_reason: null }, when: (r) => r.active === false },
      ],
      ribbon: (r) => (r.emp_id ? 'Hired' : r.active === false ? 'Refused' : null),
      title: 'name',
      groups: [['job_id', 'email', 'phone', 'linkedin', 'degree'], ['user_id', 'source', 'priority', 'tag_ids', 'emp_id']],
      tabs: [
        { label: 'Contract', fields: ['expected_salary', 'salary_proposed', 'availability', 'date_closed'] },
        { label: 'Interviewers', fields: ['interviewers'] },
        { label: 'Notes', fields: ['description'] },
      ],
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
      ticket_ids: {
        type: 'one2many', label: 'Tickets',
        fields: { name: { type: 'char', label: 'Ticket' }, price: { type: 'monetary', label: 'Price' }, seats_max: { type: 'float', label: 'Seats (0 = unlimited)' } },
        newLine: () => ({ name: 'Standard', price: 0, seats_max: 0 }),
      },
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
      tabs: [{ label: 'Tickets', fields: ['ticket_ids'] }, { label: 'Description', fields: ['description'] }],
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
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      ticket: { type: 'char', label: 'Ticket' },
      barcode: { type: 'char', label: 'Badge Code', readonly: true },
      date_checked_in: { type: 'date', label: 'Checked in on', readonly: true },
      state: state([['open', 'Registered'], ['done', 'Attended'], ['cancel', 'Cancelled']]),
    },
    defaults: (id) => ({ state: 'open', barcode: `EVT${pad(id, 8)}` }),
    // Seats are capped per event and per ticket type (0 = unlimited); cancelled registrations free their seat.
    guard: (db, before, after) => {
      if (after.state === 'cancel' || (before && before.state !== 'cancel' && before.event_id === after.event_id && before.ticket === after.ticket)) return null;
      const event = read(db, 'event.event', after.event_id);
      const taken = (db.records['event.registration'] ?? []).filter((x) => x.id !== after.id && x.event_id === after.event_id && x.state !== 'cancel');
      if (Number(event?.seats_max) > 0 && taken.length >= Number(event.seats_max)) return `${event.name} is sold out`;
      const ticket = (event?.ticket_ids ?? []).find((t) => t.name === after.ticket);
      if (ticket && Number(ticket.seats_max) > 0 && taken.filter((x) => x.ticket === ticket.name).length >= Number(ticket.seats_max)) return `No ${ticket.name} tickets left`;
      return null;
    },
    groupBys: ['event_id', 'state'],
    kanban: { groupBy: 'state', title: 'name', lines: ['event_id', 'email'] },
    list: ['name', 'event_id', 'email', 'phone', 'state'],
    views: ['list', 'kanban'],
    form: {
      statusbar: 'state',
      statusbarClickable: true,
      buttons: [
        { label: 'Check in', primary: true, when: (r) => r.state === 'open', run: (db, r) => ({ db: write(db, 'event.registration', r.id, { state: 'done', date_checked_in: today() }) }) },
        { label: 'Cancel Registration', when: (r) => r.state === 'open', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['event_id', 'ticket', 'partner_id'], ['email', 'phone', 'barcode', 'date_checked_in']],
      chatter: true,
    },
  },

  'sale.subscription': {
    label: 'Subscriptions',
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product' },
      plan: { type: 'selection', label: 'Recurring Plan', options: [['weekly', 'Weekly'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']] },
      recurring_amount: { type: 'monetary', label: 'Recurring Price' },
      order_line: productLines('Recurring Lines', 'list_price'),
      end_date: { type: 'date', label: 'End Date' },
      close_reason: { type: 'selection', label: 'Close Reason', options: CLOSE_REASONS },
      recurring_monthly: { type: 'monetary', label: 'Monthly Recurring Revenue', compute: monthly },
      start_date: { type: 'date', label: 'Start Date' },
      next_invoice_date: { type: 'date', label: 'Next Invoice' },
      stage: state([['draft', 'Quotation'], ['progress', 'In Progress'], ['paused', 'Paused'], ['closed', 'Closed']], 'Stage'),
    },
    defaults: (id) => ({ name: 'SUB/' + pad(id), plan: 'monthly', start_date: today(), next_invoice_date: today(), stage: 'draft' }),
    filters: [[{ id: 'running', label: 'In Progress', fn: (r) => r.stage === 'progress' }, { id: 'due', label: 'To Invoice', fn: (r) => r.stage === 'progress' && r.next_invoice_date <= today() }]],
    groupBys: ['stage', 'plan', 'partner_id', 'close_reason'],
    kanban: { groupBy: 'stage', title: 'name', lines: ['partner_id', 'recurring_monthly', 'next_invoice_date'], sum: 'recurring_monthly' },
    list: ['name', 'partner_id', 'plan', 'recurring_amount', 'recurring_monthly', 'next_invoice_date', 'stage'],
    views: ['kanban', 'list', 'graph', 'pivot'],
    graph: { groupBy: 'partner_id', measure: 'recurring_monthly' },
    pivot: { row: 'plan', col: 'stage', measure: 'recurring_monthly' },
    form: {
      statusbar: 'stage',
      // Stage changes go through Start / Close / Reopen so their bookkeeping runs.
      statusbarClickable: false,
      buttons: [
        { label: 'Start', primary: true, vals: { stage: 'progress' }, when: (r) => r.stage === 'draft' },
        { label: 'Generate Invoice', primary: true, when: (r) => r.stage === 'progress', run: invoiceSubscription },
        { label: 'Pause', vals: { stage: 'paused' }, when: (r) => r.stage === 'progress' },
        { label: 'Resume', vals: { stage: 'progress' }, when: (r) => r.stage === 'paused' },
        { label: 'Close', when: (r) => ['progress', 'paused'].includes(r.stage), run: closeSubscription },
        { label: 'Renew', when: (r) => r.stage === 'closed', vals: { stage: 'progress', close_reason: null, end_date: null } },
      ],
      smart: [{ label: 'Invoices', model: 'account.move', field: 'subscription_id', target: 'accounting/invoices', sum: 'amount_total' }],
      title: 'name',
      groups: [['partner_id', 'product_id', 'plan', 'recurring_amount'], ['start_date', 'next_invoice_date', 'end_date', 'recurring_monthly', 'close_reason']],
      tabs: [{ label: 'Recurring Lines', fields: ['order_line'] }],
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

  'pos.order': {
    label: 'Orders',
    fields: {
      name: { type: 'char', label: 'Order Ref', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      date_order: { type: 'date', label: 'Date', readonly: true },
      payment_method: { type: 'selection', label: 'Payment Method', options: [['cash', 'Cash'], ['card', 'Card']] },
      kitchen_state: { type: 'selection', label: 'Kitchen', options: [['new', 'To Cook'], ['cooking', 'Cooking'], ['ready', 'Ready'], ['served', 'Served']] },
      session_id: { type: 'many2one', relation: 'pos.session', label: 'Session', readonly: true },
      state: { type: 'selection', label: 'Status', options: [['paid', 'Paid'], ['refunded', 'Refunded'], ['refund', 'Refund']] },
      refund_of: { type: 'many2one', relation: 'pos.order', label: 'Refund of', readonly: true },
      lines: productLines('Products', 'list_price'),
      ...amountFields('lines'),
    },
    defaults: (id) => ({ name: 'POS/' + pad(id), date_order: today(), payment_method: 'cash', state: 'paid', lines: [] }),
    groupBys: ['session_id', 'payment_method', 'state', 'partner_id', 'date_order'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total'], badge: 'payment_method' },
    list: ['name', 'date_order', 'session_id', 'partner_id', 'payment_method', 'amount_total', 'state'],
    views: ['list', 'kanban', 'graph', 'pivot'],
    graph: { groupBy: 'date_order', measure: 'amount_total' },
    pivot: { row: 'date_order', col: 'payment_method', measure: 'amount_total' },
    form: {
      lockedWhen: () => true,
      buttons: [{ label: 'Refund', server: '/api/op/pos.refund', posts: true, when: (r) => r.state === 'paid' && r.session_id, run: (db, r) => { const out = refundOrder(db, r); return { db: out.db, go: `#/pos/orders/${out.id}` }; } }],
      ribbon: (r) => (r.state === 'refunded' ? 'Refunded' : r.state === 'refund' ? 'Refund' : null),
      title: 'name',
      groups: [['partner_id', 'payment_method', 'session_id'], ['date_order', 'state', 'refund_of']],
      tabs: [{ label: 'Products', fields: ['lines'] }],
      footer: ['amount_untaxed', 'amount_tax', 'amount_total'],
      chatter: true,
    },
  },
};
