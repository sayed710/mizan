// Analytic plans, invoice allocations and budgets, alongside existing timesheets.
import { create, read, search, unlink, write } from '../orm.js';
import { subtotal, today } from './common.js';
import { financeModels } from './finance.js';
import { moreModels } from './more.js';
import { invoiceLineAccount } from './ledger.js';
import { round } from '../money.js';

const accountModel = financeModels['account.analytic.account'];
const budgetModel = financeModels['account.budget'];
const timesheetModel = moreModels['account.analytic.line'];
const inPeriod = (r, from, to) => (!from || r.date >= from) && (!to || r.date <= to);
const planOf = (account) => account.plan_id ? `plan:${account.plan_id}` : `legacy:${account.plan || 'project'}`;

/** Validate percentages; optional db resolves accounts and independent plan totals. */
export function normalizeDistribution(distribution, db) {
  if (distribution == null) return {};
  if (typeof distribution !== 'object' || Array.isArray(distribution)) throw new Error('Analytic distribution must be an object');
  const totals = new Map();
  const entries = Object.entries(distribution).map(([id, percent]) => {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('Select a valid analytic account');
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) throw new Error('Analytic percentages must be non-negative numbers');
    const account = db && read(db, 'account.analytic.account', Number(id));
    if (db && !account) throw new Error('Analytic account not found');
    const plan = db ? planOf(account) : 'all';
    totals.set(plan, (totals.get(plan) ?? 0) + percent);
    return [id, percent];
  });
  if ([...totals.values()].some((n) => n > 100 + 1e-9)) throw new Error('Analytic distribution cannot exceed 100% per plan');
  return Object.fromEntries(entries);
}

/** Find the most specific matching analytic distribution model for line context. */
export function findAnalyticDistribution(db, { partner_id, partner_category_id, product_id, product_categ_id, account_id, account_code, company_id } = {}, fallback = {}) {
  const models = search(db, 'account.analytic.distribution.model');
  if (!models?.length) return fallback;

  const partner = partner_id ? read(db, 'res.partner', partner_id) : null;
  const product = product_id ? read(db, 'product', product_id) : null;
  const code = account_code || (account_id ? read(db, 'account.account', account_id)?.code : '') || '';

  const partnerCat = partner_category_id ?? partner?.partner_category_id ?? partner?.category_id;
  const productCat = product_categ_id ?? product?.product_categ_id ?? product?.category_id ?? product?.categ;

  const targetCompany = company_id;
  const matched = [];
  for (const m of models) {
    if (m.company_id && m.company_id !== targetCompany) continue;
    if (m.partner_id && m.partner_id !== partner_id) continue;
    if (m.product_id && m.product_id !== product_id) continue;
    if (m.partner_category_id) {
      const matchCat = partnerCat === m.partner_category_id || (partner?.tag_ids ?? []).includes(m.partner_category_id);
      if (!matchCat) continue;
    }
    if (m.product_categ_id) {
      const matchProdCat = productCat === m.product_categ_id;
      if (!matchProdCat) continue;
    }
    if (m.account_prefix) {
      if (!code || !code.startsWith(m.account_prefix)) continue;
    }

    let score = 0;
    if (m.partner_id) score += 1000;
    if (m.product_id) score += 1000;
    if (m.partner_category_id) score += 100;
    if (m.product_categ_id) score += 100;
    if (m.account_prefix) score += 10 + (m.account_prefix.length ?? 0);
    if (m.company_id) score += 1;

    matched.push({ model: m, score, seq: Number(m.sequence) || 10 });
  }

  if (!matched.length) return fallback;
  matched.sort((a, b) => b.score - a.score || a.seq - b.seq);
  return matched[0].model.analytic_distribution ?? {};
}

/** Resolve a fresh default using the same account that will be posted. */
export function defaultDistributionForLine(db, line, move, fallback = {}) {
  return findAnalyticDistribution(db, {
    partner_id: move?.partner_id,
    product_id: line.product_id,
    account_id: invoiceLineAccount(db, move, line),
    company_id: move && Object.hasOwn(move, 'company_id') ? move.company_id : 1,
  }, fallback);
}

/** Read a distribution, preserving the legacy single-account allocation. */
export function distributionOfLine(line, db, move) {
  if (line.analytic_distribution != null) {
    return line.analytic_distribution;
  }
  if (line.analytic_account_id) {
    return { [line.analytic_account_id]: 100 };
  }
  return db ? defaultDistributionForLine(db, line, move) : {};
}

/** Require a positive product-line allocation for every mandatory plan. */
export function checkMandatoryPlans(db, move) {
  if (!['out_invoice', 'in_invoice'].includes(move.move_type)) return;
  const plans = search(db, 'account.analytic.plan');
  for (const line of move.invoice_line_ids ?? []) {
    const distribution = normalizeDistribution(distributionOfLine(line, db, move), db);
    const allocated = new Set(Object.entries(distribution).filter(([, n]) => n > 0).map(([id]) => read(db, 'account.analytic.account', Number(id))?.plan_id));
    for (const plan of plans) {
      if (line.product_id && plan.default_applicability === 'mandatory' && !allocated.has(plan.id)) throw new Error(`Allocate product lines to the mandatory analytic plan: ${plan.name}`);
      if (plan.default_applicability === 'unavailable' && allocated.has(plan.id)) throw new Error(`Analytic plan is unavailable: ${plan.name}`);
    }
  }
}

/** Build untaxed analytic allocations for a customer invoice or vendor bill. */
export function analyticLinesForMove(db, move) {
  if (!['out_invoice', 'in_invoice'].includes(move.move_type)) return [];
  checkMandatoryPlans(db, move);
  const purchase = move.move_type === 'in_invoice';
  return (move.invoice_line_ids ?? []).flatMap((line) => {
    const product = read(db, 'product', line.product_id);
    const account = invoiceLineAccount(db, move, line);
    return Object.entries(normalizeDistribution(distributionOfLine(line, db, move), db)).filter(([, n]) => n > 0).map(([id, percent]) => ({
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
  if ((db.records['account.analytic.line'] ?? []).some((r) => r.move_id === moveId && ['invoice', 'vendor_bill'].includes(r.category))) return db;
  return analyticLinesForMove(db, move).reduce((next, vals) => create(next, 'account.analytic.line', vals).db, db);
}

/** Remove generated allocations on reset or cancellation, preserving timesheets. */
export function removeAnalytic(db, moveId) {
  const ids = (db.records['account.analytic.line'] ?? []).filter((r) => r.move_id === moveId && ['invoice', 'vendor_bill'].includes(r.category)).map((r) => r.id);
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
      category: { type: 'selection', label: 'Category', options: [['invoice', 'Invoice'], ['vendor_bill', 'Vendor Bill'], ['timesheet', 'Timesheet'], ['other', 'Other']] },
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
  'account.analytic.distribution.model': {
    label: 'Analytic Distribution Models',
    fields: {
      analytic_distribution: { type: 'distribution', label: 'Analytic Distribution', required: true },
      sequence: { type: 'integer', label: 'Sequence' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      partner_category_id: { type: 'char', label: 'Partner Category' },
      product_id: { type: 'many2one', relation: 'product', label: 'Product' },
      product_categ_id: { type: 'char', label: 'Product Category' },
      account_prefix: { type: 'char', label: 'Accounts Prefix' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
    },
    defaults: () => ({ sequence: 10, analytic_distribution: {} }),
    list: ['sequence', 'partner_id', 'product_id', 'account_prefix', 'analytic_distribution'],
    kanban: { title: 'sequence', lines: ['partner_id', 'product_id', 'account_prefix'] },
    form: {
      title: 'sequence',
      groups: [
        ['partner_id', 'partner_category_id', 'product_id', 'product_categ_id'],
        ['account_prefix', 'company_id', 'sequence', 'analytic_distribution'],
      ],
      chatter: true,
    },
  },
};
