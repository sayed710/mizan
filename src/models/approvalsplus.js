import { create, read, search, write, postNote } from '../orm.js';
import { today } from './common.js';

const MODEL = 'approval.request';
const employee = (label) => ({ type: 'many2one', relation: 'hr.employee', label });
const states = [['new', 'To Submit'], ['pending', 'Submitted'], ['approved', 'Approved'], ['refused', 'Refused'], ['cancel', 'Cancelled']];
const status = (r) => r.request_status ?? r.state ?? 'new';
const current = (db, r) => {
  const record = read(db, MODEL, r?.id);
  if (!record) throw new Error('Approval request not found');
  return record;
};
const update = (db, r, vals) => {
  const { state, ...fields } = vals;
  return write(db, MODEL, r.id, state ? { ...fields, request_status: state } : fields);
};
const categoryOf = (db, r) => {
  const category = read(db, 'approval.category', r.category_id);
  if (!category) throw new Error('Select an approval type');
  return category;
};
const minimum = (c) => c.approval_minimum ?? 1;
const pendingLines = (r) => (r.approver_ids ?? []).filter((a) => a.status === 'pending');

/** Validate and submit a request with a fresh, ordered approver roster. */
export function submitRequest(db, request) {
  const r = current(db, request);
  if (status(r) !== 'new') throw new Error('Only a new request can be submitted');
  const c = categoryOf(db, r);
  const owner = read(db, 'hr.employee', r.request_owner_id);
  if (!owner) throw new Error('Select a request owner');
  if (c.has_amount === 'required' && !(Number.isFinite(Number(r.amount)) && Number(r.amount) > 0)) throw new Error('Amount is required and must be positive');
  if (c.has_date === 'required' && !r.date) throw new Error('Date is required');
  if (c.has_partner === 'required' && !read(db, 'res.partner', r.partner_id)) throw new Error('Partner is required');
  if (c.has_product === 'required' && (!(r.product_lines?.length) || r.product_lines.some((l) => !read(db, 'product', l.product_id) || !(Number(l.qty) > 0)))) throw new Error('Products with positive quantities are required');
  if (r.date_end && (!r.date || r.date_end < r.date)) throw new Error('End date must be on or after the start date');
  let lines = (c.approver_ids ?? []).map((a) => ({ employee_id: a.employee_id, required: !!a.required, sequence: Number(a.sequence) || 0, status: 'new' }));
  if (c.manager_approval === 'approver' || c.manager_approval === 'required') {
    if (!owner.parent_id && c.manager_approval === 'required') throw new Error('The request owner must have a manager');
    if (owner.parent_id) {
      const manager = lines.find((a) => a.employee_id === owner.parent_id);
      if (manager) lines = lines.map((a) => a === manager ? { ...a, required: a.required || c.manager_approval === 'required' } : a);
      else lines = [...lines, { employee_id: owner.parent_id, required: c.manager_approval === 'required', sequence: 0, status: 'new' }];
    }
  }
  if (lines.some((a) => !read(db, 'hr.employee', a.employee_id))) throw new Error('Select an employee for every approver');
  if (new Set(lines.map((a) => a.employee_id)).size !== lines.length) throw new Error('An employee can only be listed once as an approver');
  if (!Number.isInteger(minimum(c)) || minimum(c) < 1 || lines.length < minimum(c)) throw new Error('The minimum approvals must be positive and cannot exceed the number of approvers');
  lines = lines.toSorted((a, b) => a.sequence - b.sequence).map((a, i) => ({ ...a, status: !c.approver_sequence || i === 0 ? 'pending' : 'new' }));
  return update(db, r, { state: 'pending', approver_ids: lines });
}

function acting(db, request, employeeId) {
  const r = current(db, request);
  if (status(r) !== 'pending' || !pendingLines(r).some((a) => a.employee_id === employeeId)) throw new Error('Only a pending approver can act on this request');
  return r;
}

function followUp(db, r, c) {
  if (c.approval_type === 'purchase' && !r.purchase_id) {
    const out = create(db, 'purchase.order', {
      partner_id: r.partner_id, state: 'draft', origin: r.name,
      order_line: (r.product_lines ?? []).map((l) => ({ product_id: l.product_id, qty: l.qty, price_unit: l.price, tax: 14 })),
    });
    return update(out.db, r, { purchase_id: out.id });
  }
  if (c.approval_type === 'leave' && !r.leave_id) {
    if (!r.date) throw new Error('A start date is required for time off');
    const out = create(db, 'hr.leave', { name: r.name, employee_id: r.request_owner_id, date_from: r.date, date_to: r.date_end || r.date, leave_type: 'paid', state: 'draft' });
    return update(out.db, r, { leave_id: out.id });
  }
  return db;
}

/** Approve as a pending employee, advancing the sequence and creating a follow-up at the threshold. */
export function approve(db, request, employeeId) {
  const r = acting(db, request, employeeId);
  const c = categoryOf(db, r);
  let lines = r.approver_ids.map((a) => a.employee_id === employeeId ? { ...a, status: 'approved' } : a);
  const complete = lines.filter((a) => a.status === 'approved').length >= minimum(c) && lines.every((a) => !a.required || a.status === 'approved');
  if (!complete && c.approver_sequence) {
    const next = lines.find((a) => a.status === 'new');
    lines = lines.map((a) => a === next ? { ...a, status: 'pending' } : a);
  }
  const next = update(db, r, { state: complete ? 'approved' : 'pending', approver_ids: lines });
  return complete ? followUp(next, read(next, MODEL, r.id), c) : next;
}

/** Refuse a submitted request as a pending employee and record the reason in chatter. */
export function refuse(db, request, employeeId, reason) {
  const r = acting(db, request, employeeId);
  if (!reason?.trim()) throw new Error('Enter a refusal reason');
  const next = update(db, r, { state: 'refused', approver_ids: r.approver_ids.map((a) => a.employee_id === employeeId ? { ...a, status: 'refused' } : a) });
  return postNote(next, MODEL, r.id, reason.trim());
}

/** Return a submitted request to new, provided nobody has approved it. */
export function withdraw(db, request) {
  const r = current(db, request);
  if (status(r) !== 'pending' || (r.approver_ids ?? []).some((a) => a.status === 'approved')) throw new Error('Withdraw is only allowed before any approval on a submitted request');
  return update(db, r, { state: 'new', approver_ids: [] });
}

/** Requests currently awaiting this employee, excluding future sequential approvers. */
export function pendingFor(db, employeeId) {
  return search(db, MODEL).filter((r) => status(r) === 'pending' && pendingLines(r).some((a) => a.employee_id === employeeId));
}

function promptAction(db, r, action) {
  const selected = prompt('Approver employee ID', String(pendingLines(r)[0]?.employee_id ?? ''));
  if (selected === null) return { db };
  if (action === approve) return { db: approve(db, r, Number(selected)) };
  const reason = prompt('Refusal reason', '');
  return { db: reason === null ? db : refuse(db, r, Number(selected), reason) };
}

const approverFields = { employee_id: employee('Approver'), required: { type: 'boolean', label: 'Required' }, sequence: { type: 'integer', label: 'Sequence' } };
const requirement = (label) => ({ type: 'selection', label, options: [['no', 'No'], ['optional', 'Optional'], ['required', 'Required']] });

export const approvalsPlusModels = {
  'approval.category': {
    label: 'Approval Types',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      approval_type: { type: 'selection', label: 'Approval Type', options: [['generic', 'Generic'], ['purchase', 'Purchase'], ['borrow', 'Borrow'], ['payment', 'Payment'], ['travel', 'Travel'], ['leave', 'Leave']] },
      approver_ids: { type: 'one2many', label: 'Approvers', fields: approverFields, newLine: () => ({ required: false, sequence: 10 }) },
      approval_minimum: { type: 'integer', label: 'Minimum Approvals' },
      manager_approval: { type: 'selection', label: 'Manager Approval', options: [['none', 'None'], ['approver', 'Approver'], ['required', 'Required']] },
      approver_sequence: { type: 'boolean', label: 'Approval in Sequence' },
      has_amount: requirement('Amount'), has_date: requirement('Date'), has_product: requirement('Products'), has_partner: requirement('Partner'),
    },
    defaults: () => ({ approval_type: 'generic', approval_minimum: 1, manager_approval: 'none', approver_sequence: false, approver_ids: [], has_amount: 'optional', has_date: 'optional', has_product: 'optional', has_partner: 'optional' }),
    list: ['name', 'approval_type', 'approval_minimum', 'manager_approval'],
    kanban: { title: 'name', lines: ['approval_type', 'approval_minimum'] },
    form: { title: 'name', groups: [['approval_type', 'approval_minimum', 'manager_approval', 'approver_sequence'], ['has_amount', 'has_date', 'has_product', 'has_partner']], tabs: [{ label: 'Approvers', fields: ['approver_ids'] }] },
  },
  'approval.request': {
    label: 'Approvals',
    fields: {
      name: { type: 'char', label: 'Request', required: true },
      category_id: { type: 'many2one', relation: 'approval.category', label: 'Approval Type' },
      category: { type: 'selection', label: 'Category', options: [['purchase', 'Purchase'], ['travel', 'Business Trip'], ['borrow', 'Borrow Items'], ['general', 'General Approval']] },
      request_owner_id: employee('Request Owner'), approver_id: employee('Approver'),
      amount: { type: 'monetary', label: 'Amount' }, date: { type: 'date', label: 'Date' }, date_end: { type: 'date', label: 'End Date' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      product_lines: { type: 'one2many', label: 'Products', fields: { product_id: { type: 'many2one', relation: 'product', label: 'Product' }, qty: { type: 'float', label: 'Quantity' }, price: { type: 'monetary', label: 'Price' } }, newLine: () => ({ qty: 1, price: 0 }) },
      reason: { type: 'text', label: 'Description' },
      // Keep legacy seed and stored requests authoritative without a data migration.
      state: { type: 'selection', label: 'Status', readonly: true, options: states, compute: (r) => r.request_status ?? 'new' },
      request_status: { type: 'selection', label: 'Request Status', tracking: true, options: states },
      approver_ids: { type: 'one2many', label: 'Approvers', readonly: true, fields: { ...approverFields, status: { type: 'selection', label: 'Status', options: states.filter(([s]) => s !== 'cancel') } }, newLine: () => ({ status: 'new', required: false, sequence: 10 }) },
    },
    defaults: () => ({ category: 'general', request_status: 'new', date: today(), request_owner_id: 1, product_lines: [], approver_ids: [] }),
    groupBys: ['category_id', 'state', 'request_owner_id'],
    filters: [[{ id: 'to_review', label: 'To Review', fn: (r) => status(r) === 'pending' }]],
    list: ['name', 'category_id', 'category', 'request_owner_id', 'approver_id', 'amount', 'state', 'request_status'],
    kanban: { groupBy: 'state', title: 'name', lines: ['category_id', 'request_owner_id', 'amount'], badge: 'state' },
    form: {
      title: 'name', statusbar: 'state', statusbarClickable: false, lockedWhen: (r) => status(r) !== 'new',
      buttons: [
        { label: 'Submit', primary: true, when: (r) => status(r) === 'new', run: (db, r) => ({ db: submitRequest(db, r) }) },
        { label: 'Approve', primary: true, when: (r) => status(r) === 'pending', run: (db, r) => promptAction(db, r, approve) },
        { label: 'Refuse', when: (r) => status(r) === 'pending', run: (db, r) => promptAction(db, r, refuse) },
        { label: 'Withdraw', when: (r) => status(r) === 'pending' && !(r.approver_ids ?? []).some((a) => a.status === 'approved'), run: (db, r) => ({ db: withdraw(db, r) }) },
        { label: 'Cancel', when: (r) => ['new', 'pending', 'refused'].includes(status(r)), run: (db, request) => {
          const r = current(db, request);
          if (!['new', 'pending', 'refused'].includes(status(r))) throw new Error('This request cannot be cancelled');
          return { db: update(db, r, { state: 'cancel' }) };
        } },
      ],
      groups: [['category_id', 'request_owner_id'], ['amount', 'date', 'date_end', 'partner_id']],
      tabs: [{ label: 'Description', fields: ['reason'] }, { label: 'Products', fields: ['product_lines'] }, { label: 'Approvers', fields: ['approver_ids'] }], chatter: true,
    },
  },
};
