// Expense reports preserve the standalone expense workflow while grouping accounting and approval.
import { create, read, search, write, postNote } from '../orm.js';
import { nextName, promptedAmount, today } from './common.js';
import { currentActor, employeeFor } from './authority.js';
import { postEntry } from './ledger.js';
import { moreModels } from './more.js';
import { round } from '../money.js';

const expense = moreModels['hr.expense'];
const employee = (label) => ({ type: 'many2one', relation: 'hr.employee', label });
const sheetLines = (db, id) => search(db, 'hr.expense').filter((r) => r.sheet_id === id);
const total = (lines) => round(lines.reduce((sum, r) => sum + round(Number(r.total_amount)), 0));
const snapshots = (lines) => lines.map((r) => ({ expense_id: r.id, name: r.name, total_amount: r.total_amount }));

function sheet(db, id, states) {
  const r = read(db, 'hr.expense.sheet', id);
  if (!r) throw new Error('Expense report not found');
  if (!states.includes(r.state)) throw new Error('This action is not allowed in the current report status');
  return r;
}

function checkedLines(db, r) {
  const lines = sheetLines(db, r.id);
  if (!lines.length) throw new Error('Select at least one expense');
  if (lines.some((l) => l.employee_id !== r.employee_id)) throw new Error('All expenses must belong to the same employee');
  if (lines.some((l) => !Number.isFinite(Number(l.total_amount)) || Number(l.total_amount) <= 0 || !Number.isFinite(Number(l.tax ?? 0)) || Number(l.tax ?? 0) < 0)) throw new Error('Expense amounts must be positive and taxes non-negative');
  const modes = new Set(lines.map((l) => l.payment_mode));
  if (modes.size !== 1 || !['own_account', 'company_account'].includes(lines[0].payment_mode)) throw new Error('All expenses must agree on who paid');
  return lines;
}

function transition(db, r, state, lineState, vals = {}) {
  const lines = sheetLines(db, r.id);
  const next = lines.reduce((acc, l) => write(acc, 'hr.expense', l.id, { state: lineState }), db);
  return write(next, 'hr.expense.sheet', r.id, { state, expense_line_ids: snapshots(lines), ...vals });
}

/** Group draft expenses for one employee into a new report. */
export function createSheet(db, expenseIds, { name } = {}) {
  const ids = [...new Set(expenseIds)];
  if (!ids.length) throw new Error('Select at least one expense');
  const lines = ids.map((id) => read(db, 'hr.expense', id));
  if (lines.some((r) => !r)) throw new Error('Expense not found');
  if (lines.some((r) => r.sheet_id)) throw new Error('An expense is already in another report');
  if (lines.some((r) => r.state !== 'draft')) throw new Error('Only draft expenses can be reported');
  const person = read(db, 'hr.employee', lines[0].employee_id);
  if (!person || lines.some((r) => r.employee_id !== person.id)) throw new Error('Select expenses from the same employee');
  const made = create(db, 'hr.expense.sheet', {
    name: name || nextName(db, 'hr.expense.sheet', 'EXP/'), employee_id: person.id,
    manager_id: person.parent_id ?? null, payment_mode: lines[0].payment_mode, expense_line_ids: snapshots(lines),
  });
  const linked = lines.reduce((acc, r) => write(acc, 'hr.expense', r.id, { sheet_id: made.id }), made.db);
  checkedLines(linked, read(linked, 'hr.expense.sheet', made.id));
  return { db: linked, id: made.id };
}

/** Submit a draft report and its expenses for approval. */
export function submitSheet(db, id) {
  const r = sheet(db, id, ['draft']);
  const lines = checkedLines(db, r);
  if (lines.some((l) => l.state !== 'draft')) throw new Error('Only draft expenses can be submitted');
  return transition(db, r, 'submit', 'submitted', { payment_mode: lines[0].payment_mode, refuse_reason: '' });
}

/** Approve a submitted report as its manager, or any valid employee when no manager is assigned. */
export function approveSheet(db, id, approverEmployeeId) {
  const r = sheet(db, id, ['submit']);
  if (!read(db, 'hr.employee', approverEmployeeId)) throw new Error('Select an approver employee');
  if (r.manager_id && r.manager_id !== approverEmployeeId) throw new Error('Only the report manager can approve');
  checkedLines(db, r);
  return transition(db, r, 'approve', 'approved');
}

/** Refuse an unposted report and return its expenses to draft with an audit note. */
export function refuseSheet(db, id, reason) {
  const r = sheet(db, id, ['submit', 'approve']);
  if (!String(reason ?? '').trim()) throw new Error('Enter a refusal reason');
  return postNote(transition(db, r, 'draft', 'draft', { refuse_reason: reason.trim() }), 'hr.expense.sheet', id, `Report refused: ${reason.trim()}`);
}

function employeePartner(db, employeeId) {
  const person = read(db, 'hr.employee', employeeId);
  if (!person) throw new Error('Employee not found');
  const contact = search(db, 'res.partner').find((p) => person.work_email && p.email?.toLowerCase() === person.work_email.toLowerCase());
  if (contact) return { db, id: contact.id };
  return create(db, 'res.partner', { name: person.name, email: person.work_email || '', supplier_rank: 1 });
}

/** Post one entry with included input VAT and employee payable or company bank credit. */
export function postSheet(db, id, date = today()) {
  const r = sheet(db, id, ['approve']);
  const lines = checkedLines(db, r);
  if (lines.some((l) => l.state !== 'approved' || l.move_id)) throw new Error('All expenses must be approved and unposted');
  const own = lines[0].payment_mode === 'own_account';
  const contact = own ? employeePartner(db, r.employee_id) : { db, id: null };
  const debits = lines.flatMap((l) => {
    const product = read(db, 'product', l.product_id);
    const account = product?.property_account_expense_id ? read(db, 'account.account', product.property_account_expense_id)?.code : '600000';
    if (!account) throw new Error('Select a valid product expense account');
    const tax = round(Number(l.total_amount) - Number(l.total_amount) / (1 + Number(l.tax ?? 0) / 100));
    return [{ account, debit: round(Number(l.total_amount) - tax) }, ...(tax ? [{ account: '131000', debit: tax, tax_name: `${Number(l.tax ?? 0)}%`, tax_side: 'purchase', tax_base: round(Number(l.total_amount) - tax) }] : [])];
  });
  const booked = postEntry(contact.db, { journal: r.journal || 'MISC', date, ref: r.name,
    lines: [...debits, { account: own ? '211000' : '101401', credit: total(lines), partner_id: contact.id }],
  });
  const linked = lines.reduce((acc, l) => write(acc, 'hr.expense', l.id, { move_id: booked.id }), booked.db);
  return transition(linked, r, own ? 'post' : 'done', own ? 'posted' : 'paid', {
    move_id: booked.id, accounting_date: date, payment_mode: lines[0].payment_mode, partner_id: contact.id, amount_paid: own ? 0 : total(lines),
  });
}

/** Reimburse an employee partially or fully without exceeding the posted report balance. */
export function registerPayment(db, id, amount, date = today()) {
  const r = sheet(db, id, ['post']);
  const value = round(Number(amount));
  const due = round(r.total_amount - (r.amount_paid || 0));
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter a positive reimbursement amount');
  if (value > due) throw new Error('Reimbursement exceeds the outstanding amount');
  const booked = postEntry(db, { journal: 'BNK1', date, ref: `Reimbursement: ${r.name}`, lines: [
    { account: '211000', debit: value, partner_id: r.partner_id }, { account: '101401', credit: value, partner_id: r.partner_id },
  ] });
  return transition(booked.db, r, value === due ? 'done' : 'post', value === due ? 'paid' : 'posted', { amount_paid: round((r.amount_paid || 0) + value) });
}

/** Append each eligible expense to its sales order exactly once, using untaxed cost or sales price. */
export function reinvoiceExpenses(db, sheetId) {
  sheet(db, sheetId, ['post', 'done']);
  let next = db;
  for (const r of sheetLines(db, sheetId).filter((l) => l.sale_order_id && l.reinvoice && l.reinvoice !== 'no' && !l.reinvoiced)) {
    const order = read(next, 'sale.order', r.sale_order_id);
    const product = read(next, 'product', r.product_id);
    if (!order || order.state === 'cancel' || !product) throw new Error('Select a valid sales order and expense product');
    if (!['cost', 'sales_price'].includes(r.reinvoice)) throw new Error('Select a valid re-invoicing policy');
    const qty = Number(r.quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Expense quantity must be positive');
    const price = r.reinvoice === 'cost' ? Number(r.total_amount) / (1 + Number(r.tax ?? 0) / 100) / qty : Number(product.list_price);
    if (!Number.isFinite(price) || price < 0) throw new Error('Select a valid sales price');
    next = write(next, 'sale.order', order.id, { order_line: [...(order.order_line ?? []), { product_id: product.id, name: r.name, qty, price_unit: round(price), tax: product.sale_tax ?? 14, expense_id: r.id }] });
    next = write(next, 'hr.expense', r.id, { reinvoiced: true });
  }
  return next;
}

/** Find other expenses matching employee, date and amount. */
export function duplicates(db, r) {
  return search(db, 'hr.expense').filter((l) => l.id !== r.id && l.employee_id === r.employee_id && l.date === r.date && round(Number(l.total_amount)) === round(Number(r.total_amount)));
}

/** Inclusive date-range totals grouped independently by employee and category. */
export function expenseAnalysis(db, { from, to } = {}) {
  const lines = search(db, 'hr.expense').filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  const grouped = (key) => [...new Set(lines.map((r) => r[key]))].map((id) => ({ [key]: id, total_amount: total(lines.filter((r) => r[key] === id)) }));
  return { employees: grouped('employee_id'), categories: grouped('category') };
}

function resetSheet(db, id) {
  const r = sheet(db, id, ['submit', 'approve', 'cancel']);
  if (r.move_id) throw new Error('Posted reports cannot be reset');
  return transition(db, r, 'draft', 'draft');
}

export const expensePlusModels = {
  'hr.expense.sheet': {
    label: 'Expense Reports',
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      employee_id: { ...employee('Employee'), required: true }, manager_id: employee('Manager'),
      expense_line_ids: { type: 'one2many', label: 'Expenses', relation: 'hr.expense', inverse: 'sheet_id', readonly: true, fields: {
        expense_id: { type: 'many2one', relation: 'hr.expense', label: 'Expense' }, name: { type: 'char', label: 'Description' }, total_amount: { type: 'monetary', label: 'Total' },
      }, newLine: () => ({}) },
      total_amount: { type: 'monetary', label: 'Total', compute: (r) => total(r.expense_line_ids ?? []) },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['submit', 'Submitted'], ['approve', 'Approved'], ['post', 'Posted'], ['done', 'Paid'], ['cancel', 'Cancelled']] },
      refuse_reason: { type: 'text', label: 'Refusal Reason', readonly: true },
      payment_mode: { ...expense.fields.payment_mode, readonly: true },
      accounting_date: { type: 'date', label: 'Accounting Date' },
      move_id: { ...expense.fields.move_id },
      journal: { type: 'char', label: 'Journal' },
      amount_paid: { type: 'monetary', label: 'Reimbursed', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Reimbursement Contact', readonly: true },
    },
    protectDelete: (db, r) => sheetLines(db, r.id).length ? 'Reports containing expenses cannot be deleted' : null,
    defaults: (id) => ({ name: `EXP/${id}`, state: 'draft', journal: 'MISC', accounting_date: today(), amount_paid: 0, expense_line_ids: [] }),
    onchange: (r, key, db) => key === 'employee_id' ? { manager_id: read(db, 'hr.employee', r.employee_id)?.parent_id ?? null } : {},
    list: ['name', 'employee_id', 'manager_id', 'total_amount', 'state'],
    kanban: { title: 'name', lines: ['employee_id', 'total_amount'], badge: 'state' },
    form: {
      title: 'name', statusbar: 'state', lockedWhen: (r) => r.state !== 'draft', chatter: true,
      groups: [['employee_id', 'manager_id', 'payment_mode'], ['accounting_date', 'journal', 'total_amount', 'amount_paid', 'move_id', 'refuse_reason']],
      tabs: [{ label: 'Expenses', fields: ['expense_line_ids'] }],
      buttons: [
        { label: 'Submit', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: submitSheet(db, r.id) }) },
        { label: 'Approve', primary: true, when: (r) => r.state === 'submit', run: (db, r) => {
          // Signed in: approve as your own employee; the server checks you manage the requester.
          const mine = employeeFor(db, currentActor()?.login)?.id;
          const answer = mine ?? prompt('Approver employee ID', String(r.manager_id ?? ''));
          return { db: answer === null ? db : approveSheet(db, r.id, Number(answer)) };
        } },
        { label: 'Refuse', when: (r) => ['submit', 'approve'].includes(r.state), run: (db, r) => {
          const reason = prompt('Refusal reason', '');
          return { db: reason === null ? db : refuseSheet(db, r.id, reason) };
        } },
        { label: 'Post Journal Entries', primary: true, when: (r) => r.state === 'approve', run: (db, r) => ({ db: postSheet(db, r.id, r.accounting_date) }) },
        { label: 'Re-invoice to Sales Orders', when: (r) => ['post', 'done'].includes(r.state), run: (db, r) => ({ db: reinvoiceExpenses(db, r.id) }) },
        { label: 'Register Payment', primary: true, when: (r) => r.state === 'post', run: (db, r) => {
          const amount = promptedAmount(prompt('Reimbursement amount', String(round(r.total_amount - r.amount_paid))));
          return { db: amount == null ? db : registerPayment(db, r.id, amount) };
        } },
        { label: 'Reset to Draft', when: (r) => ['submit', 'approve', 'cancel'].includes(r.state), run: (db, r) => ({ db: resetSheet(db, r.id) }) },
      ],
    },
  },
  'hr.expense': {
    ...expense,
    fields: {
      ...expense.fields,
      sheet_id: { type: 'many2one', relation: 'hr.expense.sheet', label: 'Expense Report', readonly: true },
      sale_order_id: { type: 'many2one', relation: 'sale.order', label: 'Re-invoice Customer Order' },
      reinvoice: { type: 'selection', label: 'Re-invoice', options: [['no', 'No'], ['cost', 'At Cost'], ['sales_price', 'At Sales Price']] },
      analytic_account_id: { type: 'many2one', relation: 'account.analytic.account', label: 'Analytic Account' },
      duplicate_warning: { type: 'char', label: 'Duplicate Warning', readonly: true },
      reinvoiced: { type: 'boolean', label: 'Re-invoiced', readonly: true },
    },
    defaults: () => ({ ...expense.defaults(), reinvoice: 'no', reinvoiced: false }),
    guard: (db, before, after, ctx) => {
      if (after.sheet_id && !before?.sheet_id) {
        const report = read(db, 'hr.expense.sheet', after.sheet_id);
        if (!report || report.state !== 'draft' || report.employee_id !== after.employee_id || !report.expense_line_ids.some((l) => l.expense_id === after.id)) return 'Use Create Report to group draft expenses';
      }
      if (before?.sheet_id && ['employee_id', 'date', 'product_id', 'category', 'quantity', 'unit_amount', 'tax', 'total_amount', 'payment_mode', 'sheet_id'].some((key) => before[key] !== after[key])) return 'Reported expense amounts and ownership cannot be changed';
      return expense.guard?.(db, before, after, ctx);
    },
    protectDelete: (db, r) => r.sheet_id ? 'Reported expenses cannot be deleted' : expense.protectDelete?.(db, r),
    onchange: (r, key, db) => {
      const changes = expense.onchange(r, key, db);
      const matches = duplicates(db, { ...r, ...changes });
      return { ...changes, duplicate_warning: matches.length ? `Possible duplicate: ${matches.map((l) => l.name).join(', ')}` : '' };
    },
    form: {
      ...expense.form,
      groups: [...expense.form.groups, ['sheet_id', 'sale_order_id', 'reinvoice', 'analytic_account_id', 'duplicate_warning']],
      buttons: [...expense.form.buttons.map((b) => ({ ...b, when: (r) => !r.sheet_id && b.when(r) })),
        { label: 'Create Report', when: (r) => r.state === 'draft' && !r.sheet_id, run: (db, r) => createSheet(db, [r.id], { name: r.name }) }],
    },
  },
};
