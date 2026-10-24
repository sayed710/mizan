// Payroll: payslips computed from the employee wage, posted to accounting, grouped in monthly batches.
import { create, read, search, write } from '../orm.js';
import { pad, today } from './common.js';
import { postEntry } from './ledger.js';

// ponytail: one fixed salary structure; make rates configurable per company/country when needed.
export const RATES = { allowance: 0.1, socialInsurance: 0.11, incomeTax: 0.1 };
const round = (n) => Math.round(n * 100) / 100;

/** Salary rule lines for a wage (codes mirror a typical structure: BASIC, ALW, GROSS, SI, TAX, NET). */
export function computeLines(wage) {
  const basic = round(Number(wage) || 0);
  const allowance = round(basic * RATES.allowance);
  const gross = round(basic + allowance);
  const si = round(basic * RATES.socialInsurance);
  const tax = round((gross - si) * RATES.incomeTax);
  return [
    { code: 'BASIC', name: 'Basic Salary', amount: basic },
    { code: 'ALW', name: 'Allowances', amount: allowance },
    { code: 'GROSS', name: 'Gross', amount: gross },
    { code: 'SI', name: 'Social Insurance', amount: -si },
    { code: 'TAX', name: 'Income Tax', amount: -tax },
    { code: 'NET', name: 'Net Salary', amount: round(gross - si - tax) },
  ];
}

const amountOf = (r, code) => (r.line_ids ?? []).find((l) => l.code === code)?.amount ?? 0;
const monthBounds = (date = today()) => {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { date_from: `${y}-${String(m).padStart(2, '0')}-01`, date_to: `${y}-${String(m).padStart(2, '0')}-${last}` };
};

function compute(db, slip) {
  const emp = read(db, 'hr.employee', slip.employee_id);
  if (!emp) throw new Error('Select an employee first');
  if (!(Number(emp.wage) > 0)) throw new Error(`${emp.name} has no wage set`);
  return write(db, 'hr.payslip', slip.id, { line_ids: computeLines(emp.wage) });
}

/** Confirm: post the salary expense against payables (net to employee, SI and tax to authorities). */
function confirm(db, slip) {
  const s = slip.line_ids?.length ? slip : read(compute(db, slip), 'hr.payslip', slip.id);
  const next = slip.line_ids?.length ? db : compute(db, slip);
  const { db: booked } = postEntry(next, {
    journal: 'SAL', date: s.date_to, ref: `${s.name} — ${read(next, 'hr.employee', s.employee_id)?.name}`,
    lines: [
      { account: '620000', debit: amountOf(s, 'GROSS') },
      { account: '230000', credit: amountOf(s, 'NET') },
      { account: '240000', credit: -amountOf(s, 'SI') },
      { account: '250100', credit: -amountOf(s, 'TAX') },
    ],
  });
  return write(booked, 'hr.payslip', s.id, { state: 'done' });
}

function pay(db, slip) {
  const net = amountOf(slip, 'NET');
  const { db: booked } = postEntry(db, {
    journal: 'BNK1', ref: `Salary payment ${slip.name}`,
    lines: [{ account: '230000', debit: net }, { account: '101401', credit: net }],
  });
  return write(booked, 'hr.payslip', slip.id, { state: 'paid' });
}

/** Create draft payslips for every employee with a wage, linked to the batch. */
export function generateSlips(db, batch) {
  return search(db, 'hr.employee')
    .filter((e) => Number(e.wage) > 0 && !search(db, 'hr.payslip').some((p) => p.run_id === batch.id && p.employee_id === e.id))
    .reduce((acc, e) => {
      const { db: next, id } = create(acc, 'hr.payslip', { employee_id: e.id, run_id: batch.id, date_from: batch.date_from, date_to: batch.date_to });
      return compute(next, read(next, 'hr.payslip', id));
    }, db);
}

const slipsOf = (db, batch) => search(db, 'hr.payslip').filter((p) => p.run_id === batch.id);

export const payrollModels = {
  'hr.payslip': {
    label: 'Payslips',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Employee', required: true },
      run_id: { type: 'many2one', relation: 'hr.payslip.run', label: 'Batch', readonly: true },
      date_from: { type: 'date', label: 'From' },
      date_to: { type: 'date', label: 'To' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['done', 'Done'], ['paid', 'Paid'], ['cancel', 'Cancelled']] },
      line_ids: {
        type: 'one2many',
        label: 'Salary Computation',
        fields: { code: { type: 'char', label: 'Code' }, name: { type: 'char', label: 'Name' }, amount: { type: 'monetary', label: 'Amount' } },
        newLine: () => ({ code: '', name: '', amount: 0 }),
      },
      basic_wage: { type: 'monetary', label: 'Basic Wage', compute: (r) => amountOf(r, 'BASIC') },
      gross_wage: { type: 'monetary', label: 'Gross Wage', compute: (r) => amountOf(r, 'GROSS') },
      net_wage: { type: 'monetary', label: 'Net Wage', compute: (r) => amountOf(r, 'NET') },
    },
    defaults: (id) => ({ name: 'SLIP/' + pad(id), state: 'draft', line_ids: [], ...monthBounds() }),
    filters: [[{ id: 'draft', label: 'Draft', fn: (r) => r.state === 'draft' }, { id: 'done', label: 'Done', fn: (r) => r.state === 'done' }]],
    groupBys: ['employee_id', 'run_id', 'state', 'date_from'],
    kanban: { groupBy: 'state', title: 'name', lines: ['employee_id', 'net_wage', 'date_to'] },
    list: ['name', 'employee_id', 'date_from', 'date_to', 'gross_wage', 'net_wage', 'state'],
    views: ['list', 'kanban', 'pivot', 'graph'],
    pivot: { row: 'employee_id', col: 'date_from', measure: 'net_wage' },
    graph: { groupBy: 'employee_id', measure: 'net_wage' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => r.state !== 'draft',
      buttons: [
        { label: 'Compute Sheet', when: (r) => r.state === 'draft', run: (db, r) => ({ db: compute(db, r) }) },
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: confirm(db, r) }) },
        { label: 'Mark as Paid', primary: true, when: (r) => r.state === 'done', run: (db, r) => ({ db: pay(db, r) }) },
        { label: 'Print', when: (r) => r.line_ids?.length, run: (db, r) => ({ db, go: `#/print/hr.payslip/${r.id}` }) },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => r.state === 'draft' },
      ],
      title: 'name',
      groups: [['employee_id', 'run_id'], ['date_from', 'date_to']],
      tabs: [{ label: 'Salary Computation', fields: ['line_ids'] }],
      footer: ['gross_wage', 'net_wage'],
      chatter: true,
    },
  },

  'hr.payslip.run': {
    label: 'Payslip Batches',
    fields: {
      name: { type: 'char', label: 'Batch Name', required: true },
      date_from: { type: 'date', label: 'From' },
      date_to: { type: 'date', label: 'To' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'New'], ['done', 'Confirmed'], ['paid', 'Paid']] },
    },
    defaults: () => ({ name: `Payroll ${today().slice(0, 7)}`, state: 'draft', ...monthBounds() }),
    kanban: { title: 'name', lines: ['date_from', 'date_to'], badge: 'state', counter: { label: 'Payslips', model: 'hr.payslip', field: 'run_id' } },
    list: ['name', 'date_from', 'date_to', 'state'],
    form: {
      statusbar: 'state',
      buttons: [
        { label: 'Generate Payslips', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: generateSlips(db, r) }) },
        {
          label: 'Confirm All', when: (r) => r.state === 'draft',
          run: (db, r) => ({ db: write(slipsOf(db, r).filter((p) => p.state === 'draft').reduce((acc, p) => confirm(acc, read(acc, 'hr.payslip', p.id)), db), 'hr.payslip.run', r.id, { state: 'done' }) }),
        },
        {
          label: 'Pay All', primary: true, when: (r) => r.state === 'done',
          run: (db, r) => ({ db: write(slipsOf(db, r).filter((p) => p.state === 'done').reduce((acc, p) => pay(acc, read(acc, 'hr.payslip', p.id)), db), 'hr.payslip.run', r.id, { state: 'paid' }) }),
        },
      ],
      smart: [{ label: 'Payslips', model: 'hr.payslip', field: 'run_id', target: 'payroll/payslips' }],
      title: 'name',
      groups: [['date_from'], ['date_to']],
      chatter: true,
    },
  },
};
