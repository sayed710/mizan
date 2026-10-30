// Analytic plans, invoice allocations and budgets, alongside existing timesheets.
import { create, read, search, unlink, write } from '../orm.js';
import { subtotal, today } from './common.js';
import { financeModels } from './finance.js';
import { moreModels } from './more.js';
import { mapAccount } from './taxes.js';
import { round } from '../money.js';
import { productProperty } from './productconfig-helpers.js';

const accountModel = financeModels['account.analytic.account'];
const budgetModel = financeModels['account.budget'];
const timesheetModel = moreModels['account.analytic.line'];
const inPeriod = (r, from, to) => (!from || r.date >= from) && (!to || r.date <= to);
export { normalizeDistribution } from '../analytic_distribution.js';
import { normalizeDistribution } from '../analytic_distribution.js';

/** Read a distribution, preserving the legacy single-account allocation. */
export function distributionOfLine(line) {
  return line.analytic_distribution != null ? line.analytic_distribution : line.analytic_account_id ? { [line.analytic_account_id]: 100 } : {};
}

/** Require a positive product-line allocation for every mandatory plan. */
export function checkMandatoryPlans(db, move) {
  if (!['out_invoice', 'in_invoice'].includes(move.move_type)) return;
  const plans = search(db, 'account.analytic.plan');
  for (const line of move.invoice_line_ids ?? []) {
    const distribution = normalizeDistribution(distributionOfLine(line), db);
    const allocated = new Set(Object.entries(distribution).filter(([, n]) => n > 0).map(([id]) => read(db, 'account.analytic.account', Number(id))?.plan_id));
    for (const plan of plans) {
      if (line.product_id && plan.default_applicability === 'mandatory' && !allocated.has(plan.id)) throw new Error(`Allocate product lines to the mandatory analytic plan: ${plan.name}`);
      if (plan.default_applicability === 'unavailable' && allocated.has(plan.id)) throw new Error(`Analytic plan is unavailable: ${plan.name}`);
    }
  }
}

/** Build untaxed analytic allocations for a customer invoice or vendor bill. */
export function analyticLinesForMove(db, move) {
  if (move.move_type === 'entry') return (move.line_ids ?? []).flatMap((line) => Object.entries(normalizeDistribution(distributionOfLine(line), db)).filter(([, n]) => n > 0).map(([id, percent]) => ({
    name: line.name || move.name || '/', date: move.invoice_date || today(), account_id: Number(id),
    amount: round(((Number(line.credit) || 0) - (Number(line.debit) || 0)) * percent / 100),
    general_account: read(db, 'account.account', line.account_id)?.code || '', move_id: move.id,
    partner_id: line.partner_id ?? move.partner_id ?? null, category: 'journal_entry', employee_id: null, unit_amount: 0, company_id: move.company_id ?? 1,
  })));
  if (!['out_invoice', 'in_invoice'].includes(move.move_type)) return [];
  checkMandatoryPlans(db, move);
  const purchase = move.move_type === 'in_invoice';
  return (move.invoice_line_ids ?? []).flatMap((line) => {
    const product = read(db, 'product', line.product_id);
    const fallback = search(db, 'account.account').find((a) => a.code === (purchase ? '600000' : '400000'))?.id;
    const account = mapAccount(db, move.fiscal_position_id, line.account_id || productProperty(db, product, purchase ? 'property_account_expense_id' : 'property_account_income_id') || fallback);
    return Object.entries(normalizeDistribution(distributionOfLine(line), db)).filter(([, n]) => n > 0).map(([id, percent]) => ({
      name: line.name || product?.name || move.name || '/', date: move.invoice_date || today(),
      account_id: Number(id), amount: round(subtotal(line) * percent / 100 * (purchase ? -1 : 1)),
      general_account: read(db, 'account.account', account)?.code || (purchase ? '600000' : '400000'),
      move_id: move.id, partner_id: move.partner_id ?? null, product_id: line.product_id ?? null,
      category: purchase ? 'vendor_bill' : 'invoice', employee_id: null, unit_amount: 0, company_id: move.company_id ?? 1,
    }));
  });
}

/** Create a posted move's analytic lines once. */
export function postAnalytic(db, moveId) {
  const move = read(db, 'account.move', moveId);
  if (!move) throw new Error('Invoice or bill not found');
  if (move.state !== 'posted') throw new Error('Post the invoice or bill before creating analytic lines');
  const category = move.move_type === 'entry' ? 'journal_entry' : move.move_type === 'in_invoice' ? 'vendor_bill' : 'invoice';
  if ((db.records['account.analytic.line'] ?? []).some((r) => r.move_id === moveId && r.category === category)) return db;
  return analyticLinesForMove(db, move).reduce((next, vals) => create(next, 'account.analytic.line', vals).db, db);
}

/** Remove generated allocations on reset or cancellation, preserving timesheets. */
export function removeAnalytic(db, moveId) {
  const ids = (db.records['account.analytic.line'] ?? []).filter((r) => r.move_id === moveId && ['invoice', 'vendor_bill', 'journal_entry'].includes(r.category)).map((r) => r.id);
  return ids.length ? unlink(db, 'account.analytic.line', ids) : db;
}

/** Return positive cost debits, income credits and signed balance in an inclusive period. */
export function analyticBalance(db, accountId, { from, to } = {}) {
  const lines = search(db, 'account.analytic.line').filter((r) => r.account_id === accountId && inPeriod(r, from, to));
  const debit = round(lines.reduce((s, r) => s + Math.max(0, -(Number(r.amount) || 0)), 0));
  const credit = round(lines.reduce((s, r) => s + Math.max(0, Number(r.amount) || 0), 0));
  return { debit, credit, balance: round(credit - debit) };
}

const day = (date) => {
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid budget date');
  return value / 86400000;
};

/** Report full-period actuals and inclusive elapsed-day planned amounts as of atDate. */
export function budgetReport(db, budgetId, atDate = today()) {
  const budget = read(db, 'account.budget', budgetId);
  if (!budget) throw new Error('Budget not found');
  const start = day(budget.date_from);
  const end = day(budget.date_to);
  if (end < start) throw new Error('Budget end date must be on or after its start date');
  const fraction = Math.min(1, Math.max(0, (day(atDate) - start + 1) / (end - start + 1)));
  const lines = search(db, 'account.analytic.line').filter((r) => inPeriod(r, budget.date_from, budget.date_to));
  return (budget.lines ?? []).map((line) => {
    const planned = Number(line.planned) || 0;
    const practical = round(lines.filter((r) => r.account_id === line.analytic_account_id && (!line.general_account || (r.general_account ?? '').startsWith(line.general_account))).reduce((s, r) => s + (Number(r.amount) || 0), 0));
    const theoretical = round(planned * fraction);
    return { ...line, planned, practical, theoretical, achievement: theoretical ? round(practical / theoretical * 100) : 0 };
  });
}

const transition = (label, from, state) => ({
  label, primary: ['confirmed', 'validated'].includes(state), when: (r) => from.includes(r.state),
  run: (db, r) => {
    const current = read(db, 'account.budget', r.id);
    if (!current || !from.includes(current.state)) throw new Error(`Cannot ${label.toLowerCase()} this budget in its current state`);
    if (state === 'confirmed' || state === 'validated') budgetReport(db, r.id);
    return { db: write(db, 'account.budget', r.id, { state }) };
  },
});

export const analyticPlusModels = {
  'account.analytic.plan': {
    label: 'Analytic Plans',
    fields: {
      name: { type: 'char', label: 'Plan Name', required: true },
      parent_id: { type: 'many2one', relation: 'account.analytic.plan', label: 'Parent Plan' },
      default_applicability: { type: 'selection', label: 'Default Applicability', options: [['optional', 'Optional'], ['mandatory', 'Mandatory'], ['unavailable', 'Unavailable']] },
      color: { type: 'integer', label: 'Color' },
    },
    defaults: () => ({ default_applicability: 'optional', color: 0 }),
    list: ['name', 'parent_id', 'default_applicability'],
    kanban: { title: 'name', lines: ['parent_id', 'default_applicability'] },
    form: { title: 'name', groups: [['parent_id'], ['default_applicability', 'color']], chatter: true },
  },
  'account.analytic.account': {
    ...accountModel,
    fields: {
      ...accountModel.fields,
      plan_id: { type: 'many2one', relation: 'account.analytic.plan', label: 'Analytic Plan' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Company Currency', readonly: true },
      active: { type: 'boolean', label: 'Active' },
      debit: { type: 'monetary', label: 'Debit', readonly: true },
      credit: { type: 'monetary', label: 'Credit', readonly: true },
    },
    defaults: () => ({ ...accountModel.defaults(), active: true }),
    list: ['code', 'name', 'plan', 'plan_id', 'partner_id'],
    form: {
      ...accountModel.form, groups: [['code', 'plan', 'plan_id'], ['partner_id', 'currency_id', 'active']],
      smart: [{ label: 'Balance', model: 'account.analytic.line', field: 'account_id', sum: 'amount', target: 'timesheets/timesheets' }],
    },
  },
  'account.analytic.line': {
    ...timesheetModel,
    fields: {
      ...timesheetModel.fields,
      amount: { type: 'monetary', label: 'Amount' },
      account_id: { type: 'many2one', relation: 'account.analytic.account', label: 'Analytic Account' },
      general_account: { type: 'char', label: 'General Account Code' },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Invoice / Bill' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      product_id: { type: 'many2one', relation: 'product', label: 'Product' },
      category: { type: 'selection', label: 'Category', options: [['invoice', 'Invoice'], ['vendor_bill', 'Vendor Bill'], ['journal_entry', 'Journal Entry'], ['timesheet', 'Timesheet'], ['other', 'Other']] },
    },
    defaults: () => ({ ...timesheetModel.defaults(), amount: 0, category: 'timesheet' }),
    form: { ...timesheetModel.form, groups: [...timesheetModel.form.groups, ['account_id', 'amount', 'category'], ['general_account', 'move_id', 'partner_id', 'product_id']] },
  },
  'account.budget': {
    ...budgetModel,
    fields: {
      ...budgetModel.fields,
      lines: { ...budgetModel.fields.lines, fields: { ...budgetModel.fields.lines.fields, general_account: { type: 'char', label: 'General Account Prefix' } } },
      state: { ...budgetModel.fields.state, options: [['draft', 'Draft'], ['confirmed', 'Confirmed'], ['validated', 'Validated'], ['done', 'Done'], ['cancel', 'Cancelled']] },
    },
    form: {
      ...budgetModel.form, statusbarClickable: false, lockedWhen: (r) => r.state !== 'draft',
      buttons: [
        transition('Confirm', ['draft'], 'confirmed'), transition('Approve', ['confirmed'], 'validated'),
        transition('Done', ['validated'], 'done'), transition('Cancel', ['draft', 'confirmed', 'validated'], 'cancel'),
        transition('Reset to Draft', ['confirmed', 'validated', 'done', 'cancel'], 'draft'), ...budgetModel.form.buttons,
      ],
    },
  },
};
