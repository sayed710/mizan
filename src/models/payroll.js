// Payroll: payslips computed from the employee wage, posted to accounting, grouped in monthly batches.
import { create, read, search, write } from '../orm.js';
import { pad, today } from './common.js';
import { postEntry } from './ledger.js';

const round = (n) => Math.round(n * 100) / 100;

/**
 * Default salary structure (rules in order). Categories: basic, allowance, gross (= basic + allowances),
 * deduction (stored negative, credited to `account`), net (= gross + deductions).
 * amount_type: 'wage' (contract wage), 'fixed' (value), 'percentage' (value % of the `base` rule's amount).
 */
export const DEFAULT_RULES = [
  { sequence: 1, code: 'BASIC', name: 'Basic Salary', category: 'basic', amount_type: 'wage', base: '', value: 0, account: '' },
  { sequence: 2, code: 'ALW', name: 'Allowances', category: 'allowance', amount_type: 'percentage', base: 'BASIC', value: 10, account: '' },
  { sequence: 3, code: 'GROSS', name: 'Gross', category: 'gross', amount_type: 'wage', base: '', value: 0, account: '' },
  { sequence: 4, code: 'SI', name: 'Social Insurance', category: 'deduction', amount_type: 'percentage', base: 'BASIC', value: 11, account: '240000' },
  { sequence: 5, code: 'TAX', name: 'Income Tax', category: 'deduction', amount_type: 'percentage', base: 'GROSS_AFTER_SI', value: 10, account: '250100' },
  { sequence: 6, code: 'NET', name: 'Net Salary', category: 'net', amount_type: 'wage', base: '', value: 0, account: '' },
];

/** Evaluate rules for a wage. The pseudo-base GROSS_AFTER_SI is gross minus deductions computed so far. */
export function computeLines(wage, rules = DEFAULT_RULES) {
  const values = {};
  const out = [];
  let gross = 0;
  let deductions = 0;
  for (const r of [...rules].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
    const baseValue = r.base === 'GROSS_AFTER_SI' ? gross + deductions : Math.abs(values[r.base] ?? 0);
    let amount;
    if (r.category === 'gross') amount = gross;
    else if (r.category === 'net') amount = gross + deductions;
    else if (r.amount_type === 'wage') amount = Number(wage) || 0;
    else if (r.amount_type === 'fixed') amount = Number(r.value) || 0;
    else amount = (baseValue * (Number(r.value) || 0)) / 100;
    amount = round(r.category === 'deduction' ? -Math.abs(amount) : amount);
    if (r.category === 'basic' || r.category === 'allowance') gross = round(gross + amount);
    if (r.category === 'deduction') deductions = round(deductions + amount);
    values[r.code] = amount;
    out.push({ code: r.code, name: r.name, amount });
  }
  return out;
}

/** Running contract of an employee on a date, if any. */
export const runningContract = (db, employeeId, date = today()) => search(db, 'hr.contract')
  .find((c) => c.employee_id === employeeId && c.state === 'running' && (!c.date_start || c.date_start <= date) && (!c.date_end || c.date_end >= date));

const amountOf = (r, code) => (r.line_ids ?? []).find((l) => l.code === code)?.amount ?? 0;
const accountsOf = (r) => Object.fromEntries((r.rule_accounts ?? []).map((x) => x.split(':')));
const deductionsOf = (r) => (r.line_ids ?? []).filter((l) => l.amount < 0).map((l) => ({ ...l, account: accountsOf(r)[l.code] ?? '240000' }));
const netOf = (r) => round((r.line_ids ?? []).at(-1)?.amount ?? 0);
const grossOf = (r) => round(netOf(r) - deductionsOf(r).reduce((s, d) => s + d.amount, 0));
const monthBounds = (date = today()) => {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { date_from: `${y}-${String(m).padStart(2, '0')}-01`, date_to: `${y}-${String(m).padStart(2, '0')}-${last}` };
};

/** Wage and structure come from the running contract, else from the employee wage and the default structure. */
function compute(db, slip) {
  const emp = read(db, 'hr.employee', slip.employee_id);
  if (!emp) throw new Error('Select an employee first');
  const contract = runningContract(db, emp.id, slip.date_to);
  const wage = contract?.wage ?? emp.wage;
  if (!(Number(wage) > 0)) throw new Error(`${emp.name} has no wage set`);
  const structure = read(db, 'hr.payroll.structure', contract?.structure_id ?? slip.structure_id);
  const rules = structure?.rules?.length ? structure.rules : DEFAULT_RULES;
  return write(db, 'hr.payslip', slip.id, { line_ids: computeLines(wage, rules), structure_id: structure?.id ?? null, rule_accounts: rules.filter((r) => r.category === 'deduction').map((r) => `${r.code}:${r.account || '240000'}`) });
}

/** Confirm: post the salary expense against payables (net to employee, SI and tax to authorities). */
function confirm(db, slip) {
  const s = slip.line_ids?.length ? slip : read(compute(db, slip), 'hr.payslip', slip.id);
  const next = slip.line_ids?.length ? db : compute(db, slip);
  const { db: booked } = postEntry(next, {
    journal: 'SAL', date: s.date_to, ref: `${s.name} — ${read(next, 'hr.employee', s.employee_id)?.name}`,
    // Gross expense against net payable + one payable per deduction rule (its account, default 240000).
    lines: [
      { account: '620000', debit: grossOf(s) },
      { account: '230000', credit: netOf(s) },
      ...deductionsOf(s).map((d) => ({ account: d.account, credit: -d.amount })).filter((l) => l.credit > 0),
    ],
  });
  return write(booked, 'hr.payslip', s.id, { state: 'done' });
}

function pay(db, slip) {
  const net = netOf(slip);
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
  'hr.payroll.structure': {
    label: 'Salary Structures',
    fields: {
      name: { type: 'char', label: 'Structure Name', required: true },
      rules: {
        type: 'one2many',
        label: 'Salary Rules',
        fields: {
          sequence: { type: 'integer', label: 'Sequence' },
          code: { type: 'char', label: 'Code' },
          name: { type: 'char', label: 'Name' },
          category: { type: 'selection', label: 'Category', options: [['basic', 'Basic'], ['allowance', 'Allowance'], ['gross', 'Gross'], ['deduction', 'Deduction'], ['net', 'Net']] },
          amount_type: { type: 'selection', label: 'Amount Type', options: [['wage', 'Contract Wage'], ['fixed', 'Fixed Amount'], ['percentage', 'Percentage']] },
          base: { type: 'char', label: 'Based on (code)' },
          value: { type: 'float', label: 'Value' },
          account: { type: 'char', label: 'Account' },
        },
        newLine: () => ({ sequence: 10, code: '', name: '', category: 'allowance', amount_type: 'fixed', base: '', value: 0, account: '' }),
      },
    },
    defaults: () => ({ rules: DEFAULT_RULES.map((r) => ({ ...r })) }),
    kanban: { title: 'name', lines: [], counter: { label: 'Contracts', model: 'hr.contract', field: 'structure_id' } },
    list: ['name'],
    form: {
      title: 'name',
      buttons: [{
        label: 'Simulate 10,000', run: (db, r) => {
          alert(computeLines(10000, r.rules).map((l) => `${l.code}  ${l.amount.toLocaleString('en-US')}`).join('\n'));
          return { db };
        },
      }],
      groups: [[], []],
      tabs: [{ label: 'Salary Rules', fields: ['rules'] }],
      chatter: true,
    },
  },

  'hr.contract': {
    label: 'Contracts',
    fields: {
      name: { type: 'char', label: 'Contract Reference', required: true },
      employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Employee', required: true },
      structure_id: { type: 'many2one', relation: 'hr.payroll.structure', label: 'Salary Structure' },
      wage: { type: 'monetary', label: 'Wage' },
      date_start: { type: 'date', label: 'Contract Start Date' },
      date_end: { type: 'date', label: 'Contract End Date' },
      contract_type: { type: 'selection', label: 'Contract Type', options: [['permanent', 'Permanent'], ['fixed', 'Fixed Term'], ['intern', 'Internship']] },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'New'], ['running', 'Running'], ['close', 'Expired'], ['cancel', 'Cancelled']] },
    },
    defaults: () => ({ state: 'draft', contract_type: 'permanent', date_start: today() }),
    filters: [[{ id: 'running', label: 'Running', fn: (r) => r.state === 'running' }, { id: 'expiring', label: 'Expiring Soon', fn: (r) => r.state === 'running' && r.date_end && r.date_end <= today().slice(0, 7) + '-31' }]],
    groupBys: ['state', 'structure_id', 'contract_type'],
    kanban: { groupBy: 'state', title: 'name', lines: ['employee_id', 'wage', 'date_end'] },
    list: ['name', 'employee_id', 'structure_id', 'wage', 'date_start', 'date_end', 'state'],
    form: {
      statusbar: 'state',
      statusbarClickable: true,
      title: 'name',
      groups: [['employee_id', 'structure_id', 'contract_type'], ['wage', 'date_start', 'date_end']],
      chatter: true,
    },
  },

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
      structure_id: { type: 'many2one', relation: 'hr.payroll.structure', label: 'Structure' },
      rule_accounts: { type: 'tags', label: 'Rule Accounts', readonly: true },
      basic_wage: { type: 'monetary', label: 'Basic Wage', compute: (r) => amountOf(r, 'BASIC') },
      gross_wage: { type: 'monetary', label: 'Gross Wage', compute: grossOf },
      net_wage: { type: 'monetary', label: 'Net Wage', compute: netOf },
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
