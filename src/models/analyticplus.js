// Analytic plans, invoice allocations and budgets, alongside existing timesheets.
import { create, nextSequence, read, search, unlink, write } from '../orm.js';
import { dayOf, subtotal, today } from './common.js';
import { toCompany } from './currency.js';
import { convert } from './uom.js';
import { analyticActualLines, financeModels } from './finance.js';
import { moreModels } from './more.js';
import { analyticEligibleAccount, invoiceLines, invoiceLineAccount, journalItems, registerAnalyticPostingHooks } from './ledger.js';
import { companyCurrencyRecord, documentCurrency, findCompanyCurrencyRecord, round, roundCurrency } from '../money.js';
import { hasMultiCurrency } from './money.js';
import { currentCompany } from './company.js';
import { isSectionOrNote } from './taxes.js';
import { categoryHierarchy, findAnalyticDistribution, planOf } from './analytic-distribution-models.js';
export { isSectionOrNote } from './taxes.js';

const accountModel = financeModels['account.analytic.account'];
const budgetModel = financeModels['account.budget'];
const timesheetModel = moreModels['account.analytic.line'];
const inPeriod = (r, from, to) => (!from || r.date >= from) && (!to || r.date <= to);
const allocatedShares = (db, distribution, base) => {
  const entries = Object.entries(normalizeDistribution(distribution, db)).filter(([, n]) => n > 0);
  const amounts = entries.map(([, percent]) => round(base * percent / 100));
  const plans = new Map();
  entries.forEach(([id, percent], index) => {
    const plan = planOf(read(db, 'account.analytic.account', Number(id)));
    const group = plans.get(plan) ?? [];
    group.push({ index, percent });
    plans.set(plan, group);
  });
  for (const group of plans.values()) {
    const largest = group.reduce((a, b) => b.percent > a.percent ? b : a);
    const expected = round(base * group.reduce((sum, item) => sum + item.percent, 0) / 100);
    amounts[largest.index] = round(amounts[largest.index] + expected - group.reduce((sum, item) => sum + amounts[item.index], 0));
  }
  return entries.map(([id], index) => [id, amounts[index]]);
};
export { normalizeDistribution } from '../analytic_distribution.js';
import { normalizeDistribution } from '../analytic_distribution.js';
export { findAnalyticDistribution } from './analytic-distribution-models.js';

/** Resolve a fresh default using the same account that will be posted. */
export function defaultDistributionForLine(db, line, move, fallback = {}) {
  return findAnalyticDistribution(db, {
    partner_id: line?.partner_id ?? move?.partner_id,
    product_id: line.product_id,
    account_id: move?.move_type === 'entry' ? (line.account_id ?? line.account) : invoiceLineAccount(db, move, line),
    company_id: move && Object.hasOwn(move, 'company_id') ? move.company_id : (line?.company_id ?? 1),
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

/** Determine the winning applicability for a plan on a given move line context. */
export function planApplicability(db, plan, line, move = null) {
  const targetCompany = (move && 'company_id' in move ? move.company_id : line?.company_id) ?? 1;
  const isInvoiceDoc = ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(move?.move_type);
  const domain = isInvoiceDoc
    ? (['out_invoice', 'out_refund'].includes(move.move_type) ? 'invoice' : 'bill')
    : move?.move_type === 'entry' ? 'general' : null;

  const accountId = line?.account_id || (isInvoiceDoc ? invoiceLineAccount(db, move, line) : null);
  const code = accountId ? read(db, 'account.account', accountId)?.code || '' : '';

  const product = line?.product_id ? read(db, 'product', line.product_id) : null;
  const categories = categoryHierarchy(db, product?.categ_id);

  const matched = [];
  for (const r of plan?.applicability_ids ?? []) {
    let score = 0;
    let prefixLen = 0;
    if (r.company_id) {
      if (r.company_id !== targetCompany) continue;
      score += 1;
    }
    if (r.business_domain) {
      if (r.business_domain !== domain) continue;
      score += 1;
    }
    const prefixStr = String(r.account_prefix ?? '').trim();
    if (prefixStr) {
      const prefixes = prefixStr.split(',').map((p) => p.trim()).filter((p) => p && code.startsWith(p));
      if (!prefixes.length) continue;
      prefixLen = Math.max(...prefixes.map((p) => p.length));
      score += 1;
    }
    if (r.product_categ_id) {
      if (!categories.has(r.product_categ_id)) continue;
      score += 1;
    }
    matched.push({ rule: r, score: score * 100 + prefixLen });
  }

  if (matched.length) {
    matched.sort((a, b) => b.score - a.score);
    return matched[0].rule.applicability || 'optional';
  }
  return plan?.default_applicability || 'optional';
}

/** Require a positive product-line allocation for every mandatory plan. */
export function checkMandatoryPlans(db, move, { systemGenerated = false } = {}) {
  const isInvoiceDoc = ['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(move?.move_type);
  const isEntry = move?.move_type === 'entry';
  if (!isInvoiceDoc && !isEntry) return;
  if (isEntry && systemGenerated) return;

  const plans = search(db, 'account.analytic.plan');
  if (!plans.length) return;

  const lines = isInvoiceDoc ? (move.invoice_line_ids ?? []) : (move.line_ids ?? []);
  for (const line of lines) {
    if (isSectionOrNote(line)) continue;
    const distribution = normalizeDistribution(distributionOfLine(line, db, move), db);
    const allocated = new Map();
    for (const [id, percent] of Object.entries(distribution)) {
      const planId = read(db, 'account.analytic.account', Number(id))?.plan_id;
      if (planId) allocated.set(planId, (allocated.get(planId) ?? 0) + percent);
    }
    for (const plan of plans) {
      const applicability = planApplicability(db, plan, line, move);
      if (applicability === 'mandatory' && (isInvoiceDoc || analyticEligibleAccount(read(db, 'account.account', line.account_id)) || allocated.has(plan.id)) && Math.abs((allocated.get(plan.id) ?? 0) - 100) > 0.00001) {
        throw new Error(`Allocate product lines to the mandatory analytic plan: ${plan.name}`);
      }
      if (applicability === 'unavailable' && (allocated.get(plan.id) ?? 0) > 0) {
        throw new Error(`Analytic plan is unavailable: ${plan.name}`);
      }
    }
  }
}

/** Build untaxed analytic allocations for a customer invoice or vendor bill. */
export function analyticLinesForMove(db, move, { historical = false } = {}) {
  if (move.move_type === 'entry') return (move.line_ids ?? []).flatMap((line) => {
    const base = (Number(line.credit) || 0) - (Number(line.debit) || 0);
    return allocatedShares(db, distributionOfLine(line), base).map(([id, amount]) => ({
    name: line.name || move.name || '/', date: move.date || move.invoice_date || today(), account_id: Number(id),
    amount,
    general_account: read(db, 'account.account', line.account_id)?.code || '', move_id: move.id,
    partner_id: line.partner_id ?? move.partner_id ?? null, category: 'journal_entry', employee_id: null, unit_amount: 0, company_id: move.company_id ?? 1,
    }));
  });
  if (!['out_invoice', 'in_invoice', 'out_refund', 'in_refund'].includes(move.move_type)) return [];
  if (!historical) checkMandatoryPlans(db, move);
  const purchase = ['in_invoice', 'in_refund'].includes(move.move_type);
  const refund = ['out_refund', 'in_refund'].includes(move.move_type);
  const journalLines = move.line_ids?.length ? move.line_ids : invoiceLines(db, move);
  const allocations = new Map();
  for (const journalLine of journalLines) {
    for (const source of journalLine.invoice_sources ?? []) allocations.set(source.index, { amount: source.amount, account: journalLine.account_id, deferred: Boolean(source.original_account_id) });
  }
  return (move.invoice_line_ids ?? []).flatMap((line, index) => {
    if (isSectionOrNote(line)) return [];
    const product = read(db, 'product', line.product_id);
    const allocation = allocations.get(index);
    if (allocation?.deferred) return [];
    const account = move.line_ids?.length ? allocation?.account : invoiceLineAccount(db, move, line);
    const lineAmount = allocation?.amount ?? 0;
    return allocatedShares(db, distributionOfLine(line, db, move), lineAmount).map(([id, amount]) => {
      return {
        name: line.name || product?.name || move.name || '/', date: move.date ?? move.invoice_date ?? today(),
        account_id: Number(id), amount: round(amount * (purchase !== refund ? -1 : 1)),
        general_account: read(db, 'account.account', account)?.code || '',
        move_id: move.id, partner_id: move.partner_id ?? null, product_id: line.product_id ?? null,
        category: purchase ? 'vendor_bill' : 'invoice', employee_id: null, unit_amount: 0, company_id: move.company_id ?? 1,
      };
    });
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

registerAnalyticPostingHooks({ checkMandatoryPlans, postAnalytic });

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

const budgetCompanyError = (db, budget, selectedCompanyId = null) => {
  const companyId = budget.company_id ?? selectedCompanyId;
  return !companyId || !read(db, 'res.company', companyId) ? 'Select an existing company for the budget' : null;
};

/** Posted bills consume commitments only through explicit order-line links, never product or reference guesses. */
function postedPurchaseQuantities(db, order) {
  const billed = new Map();
  const keyedLines = (order.order_line ?? []).filter((line) => line.purchase_line_key);
  const byKey = new Map(keyedLines.map((line) => [line.purchase_line_key, line]));
  if (byKey.size !== keyedLines.length) throw new Error('Configure a unique purchase order line link for each line');
  for (const move of search(db, 'account.move').filter((move) => move.purchase_id === order.id && move.state === 'posted' && ['in_invoice', 'in_refund'].includes(move.move_type))) {
    if ((move.company_id ?? 1) !== (order.company_id ?? 1)) throw new Error('Purchase order and posted bill must belong to the same company');
    for (const line of move.invoice_line_ids ?? []) {
      if (isSectionOrNote(line)) continue;
      if (!line.purchase_line_key) throw new Error('Link each posted bill line to its purchase order line before reporting budget commitments');
      const source = byKey.get(line.purchase_line_key);
      if (!source || source.product_id !== line.product_id) throw new Error('Link each posted bill line to its purchase order line before reporting budget commitments');
      let qty = Number(line.qty) || 0;
      if (line.uom_id !== source.uom_id) {
        if (!line.uom_id || !source.uom_id) throw new Error('Configure units of measure on the purchase order and bill lines');
        qty = convert(db, qty, line.uom_id, source.uom_id, { round: false });
      }
      billed.set(line.purchase_line_key, (billed.get(line.purchase_line_key) ?? 0) + qty * (move.move_type === 'in_refund' ? -1 : 1));
    }
  }
  return billed;
}

/** Unbilled confirmed purchase allocations in company currency (costs negative), derived on every report. */
function budgetCommitmentLines(db, budgetLine, { from, to, company_id }) {
  return search(db, 'purchase.order').filter((order) => ['purchase', 'done'].includes(order.state) && (order.company_id ?? 1) === company_id
    && inPeriod({ date: dayOf(order.date_order) }, from, to)).flatMap((order) => {
    const billed = postedPurchaseQuantities(db, order);
    return (order.order_line ?? []).flatMap((line) => {
      if (isSectionOrNote(line)) return [];
      const qty = Math.max(0, (Number(line.qty) || 0) - (billed.get(line.purchase_line_key) ?? 0));
      if (!qty) return [];
      const distribution = distributionOfLine(line, db, { ...order, move_type: 'in_invoice' });
      if (budgetLine.analytic_account_id && !normalizeDistribution(distribution, db)[budgetLine.analytic_account_id]) return [];
      const accountId = budgetLine.account_id || budgetLine.general_account
        ? invoiceLineAccount(db, { ...order, move_type: 'in_invoice' }, line) : null;
      const code = accountId ? read(db, 'account.account', accountId)?.code : '';
      if ((budgetLine.account_id && accountId !== budgetLine.account_id) || (budgetLine.general_account && !code?.startsWith(budgetLine.general_account))) return [];
      const amount = -toCompany(db, documentCurrency(db, order).id, subtotal({ ...line, qty }), dayOf(order.date_order), company_id);
      const allocated = budgetLine.analytic_account_id ? allocatedShares(db, distribution, amount).find(([id]) => Number(id) === budgetLine.analytic_account_id)?.[1] ?? 0 : amount;
      return [{ purchase_id: order.id, purchase_line_key: line.purchase_line_key, date: dayOf(order.date_order), amount: allocated }];
    });
  });
}

/** Report full-period actuals and inclusive elapsed-day planned amounts as of atDate. */
export function budgetReport(db, budgetId, atDate = today(), { period = {}, company_id: selectedCompanyId = null } = {}) {
  const budget = read(db, 'account.budget', budgetId);
  if (!budget) throw new Error('Budget not found');
  const companyError = budgetCompanyError(db, budget, selectedCompanyId);
  if (companyError) throw new Error(companyError);
  const companyId = budget.company_id ?? selectedCompanyId;
  const companyCurrency = companyCurrencyRecord(db, companyId);
  const start = day(budget.date_from);
  const end = day(budget.date_to);
  if (end < start) throw new Error('Budget end date must be on or after its start date');
  return (budget.lines ?? []).map((line) => {
    const planned = Number(line.planned) || 0;
    const lineStart = line.date_from ? day(line.date_from) : start;
    const lineEnd = line.date_to ? day(line.date_to) : end;
    if (lineEnd < lineStart) throw new Error('Budget end date must be on or after its start date');
    const fraction = Math.min(1, Math.max(0, (day(atDate) - lineStart + 1) / (lineEnd - lineStart + 1)));
    const from = [budget.date_from, line.date_from, period.from].filter(Boolean).sort().at(-1);
    const to = [budget.date_to, line.date_to, period.to].filter(Boolean).sort()[0];
    const targetAccount = line.account_id ? read(db, 'account.account', line.account_id) : null;
    if (line.account_id && !targetAccount) throw new Error('Budget account not found');
    const analytic_lines = line.analytic_account_id
      ? analyticActualLines(db, { from, to, company_id: companyId, account_id: line.analytic_account_id, general_account: line.general_account, posted_only: true })
          .filter((item) => !targetAccount || item.general_account === targetAccount.code)
      : (line.account_id || line.general_account)
        ? journalItems(db, { from, to, company_id: companyId })
            .filter((item) => !item.is_closing
              && (!line.account_id || item.account_id === line.account_id)
              && (!line.general_account || (read(db, 'account.account', item.account_id)?.code ?? '').startsWith(line.general_account)))
            .map((item, idx) => ({
              id: `${item.move_id}-${idx}`,
              name: item.name || item.move_name,
              date: item.date,
              move_id: item.move_id,
              account_id: null,
              general_account: read(db, 'account.account', item.account_id)?.code || '',
              amount: roundCurrency((Number(item.credit) || 0) - (Number(item.debit) || 0), companyCurrency),
              company_id: companyId,
            }))
            .filter((item) => item.amount !== 0)
        : [];
    const practical = roundCurrency(analytic_lines.reduce((sum, item) => sum + (Number(item.amount) || 0), 0), companyCurrency);
    const commitment_lines = line.analytic_account_id || line.account_id || line.general_account
      ? budgetCommitmentLines(db, line, { from, to, company_id: companyId }) : [];
    const committed = roundCurrency(commitment_lines.reduce((sum, line) => sum + line.amount, 0), companyCurrency);
    const theoretical = roundCurrency(planned * fraction, companyCurrency);
    return { ...line, planned, practical, committed, theoretical, variance: roundCurrency(practical - planned, companyCurrency), achievement: theoretical ? round(practical / theoretical * 100) : 0, analytic_lines, commitment_lines };
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

/** Return a plan's id together with all descendant subplan ids. */
export function planSubtreeIds(db, rootId) {
  if (!rootId) return [];
  const plans = search(db, 'account.analytic.plan');
  const out = [rootId];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i += 1) {
    const pid = out[i];
    for (const p of plans) {
      if (p.parent_id === pid && !seen.has(p.id)) {
        seen.add(p.id);
        out.push(p.id);
      }
    }
  }
  return out;
}

/** Validate that a plan does not reference itself as an ancestor. */
export function planHierarchyError(db, plan) {
  if (!plan?.parent_id || !plan.id) return null;
  const seen = new Set([plan.id]);
  let cur = plan.parent_id;
  while (cur) {
    if (seen.has(cur)) return 'A plan cannot be its own ancestor';
    seen.add(cur);
    cur = read(db, 'account.analytic.plan', cur)?.parent_id ?? null;
  }
  return null;
}

const analyticStat = (db, rec, key) => (db && rec?.id ? analyticBalance(db, rec.id)[key] : 0);

export const analyticPlusModels = {
  'account.analytic.plan': {
    label: 'Analytic Plans',
    fields: {
      sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
      name: { type: 'char', label: 'Name', required: true },
      parent_id: {
        type: 'many2one', relation: 'account.analytic.plan', label: 'Parent Plan',
        domain: (r, rec) => !rec?.id || r.id !== rec.id,
      },
      default_applicability: {
        type: 'selection', label: 'Default Applicability',
        options: [['optional', 'Optional'], ['mandatory', 'Mandatory'], ['unavailable', 'Unavailable']],
        required: (r) => !r?.parent_id,
        hideWhen: (r) => Boolean(r?.parent_id),
      },
      color: { type: 'integer', label: 'Color' },
      applicability_ids: {
        type: 'one2many',
        label: 'Applicability',
        fields: {
          business_domain: { type: 'selection', label: 'Domain', options: [['general', 'General'], ['invoice', 'Invoice'], ['bill', 'Bill']] },
          company_id: { type: 'many2one', relation: 'res.company', label: 'Company', multiCompanyOnly: true, placeholder: 'Visible to all' },
          applicability: { type: 'selection', label: 'Applicability', options: [['optional', 'Optional'], ['mandatory', 'Mandatory'], ['unavailable', 'Unavailable']], required: true },
          account_prefix: { type: 'char', label: 'Accounts Prefix' },
          product_categ_id: { type: 'many2one', relation: 'product.category', label: 'Product Category' },
        },
        newLine: () => ({ business_domain: null, account_prefix: '', product_categ_id: null, applicability: 'mandatory', company_id: null }),
      },
    },
    defaults: () => ({ default_applicability: 'optional', color: 0, applicability_ids: [] }),
    createDefaults: (db) => ({ sequence: nextSequence(db, 'account.analytic.plan') }),
    guard: (db, _before, after) => planHierarchyError(db, after),
    sort: (a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || a.id - b.id,
    views: ['list', 'kanban'],
    list: ['sequence', 'name', 'default_applicability', 'color'],
    listLabels: { name: 'Analytic Plans' },
    kanban: { title: 'name', lines: ['parent_id', 'default_applicability'] },
    form: {
      title: 'name',
      smart: [
        { label: 'Subplans', model: 'account.analytic.plan', field: 'parent_id', target: 'accounting/analytic-plans' },
        { label: 'Analytic Accounts', model: 'account.analytic.account', field: 'plan_id', ids: (db, rec) => planSubtreeIds(db, rec.id), target: 'accounting/analytic' },
      ],
      groups: [['parent_id', 'default_applicability', 'color']],
      tabs: [{ label: 'Applicability', when: (r) => !r?.parent_id, fields: ['applicability_ids'] }],
      chatter: true,
    },
  },
  'account.analytic.account': {
    ...accountModel,
    fields: {
      ...accountModel.fields,
      name: { ...accountModel.fields.name, placeholder: 'e.g. Project XYZ' },
      plan_id: { type: 'many2one', relation: 'account.analytic.plan', label: 'Analytic Plan' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', multiCompanyOnly: true, placeholder: 'Visible to all' },
      currency_id: {
        type: 'many2one', relation: 'res.currency', label: 'Currency', readonly: true,
        hideWhen: (_r, db) => !hasMultiCurrency(db),
        compute: (r, db) => (db ? findCompanyCurrencyRecord(db, r?.company_id ?? currentCompany(db))?.id ?? null : r?.currency_id ?? null),
      },
      active: { type: 'boolean', label: 'Active' },
      debit: { type: 'monetary', label: 'Debit', readonly: true, compute: (r, db) => analyticStat(db, r, 'debit') },
      credit: { type: 'monetary', label: 'Credit', readonly: true, compute: (r, db) => analyticStat(db, r, 'credit') },
      balance: { ...accountModel.fields.balance, compute: (r, db) => analyticStat(db, r, 'balance') },
    },
    defaults: () => ({ ...accountModel.defaults(), active: true }),
    views: ['list', 'kanban'],
    list: ['name', 'code', 'partner_id', 'plan_id', 'company_id', 'balance'],
    listLabels: { name: 'Name' },
    listDecoration: (r) => (r.active === false ? 'muted' : ''),
    searchFields: ['name', 'code', 'partner_id'],
    groupBys: ['partner_id'],
    groupByLabels: { partner_id: 'Associated Partner' },
    form: {
      ...accountModel.form,
      titleLabel: true,
      groups: [['partner_id', 'code'], ['plan_id', 'company_id', 'currency_id']],
      smart: [{ label: 'Gross Margin', valueField: 'balance', target: (r) => `accounting/analytic-items?view=list&rel=account_id:${r.id}` }],
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
    prepareCreate: (db, vals) => ({ db, vals: { company_id: currentCompany(db), ...vals } }),
    guard: (db, before, budget) => budgetCompanyError(db, budget),
    fields: {
      ...budgetModel.fields,
      lines: { ...budgetModel.fields.lines, fields: { ...budgetModel.fields.lines.fields, account_id: { type: 'many2one', relation: 'account.account', label: 'Account' }, date_from: { type: 'date', label: 'Start Date' }, date_to: { type: 'date', label: 'End Date' }, general_account: { type: 'char', label: 'General Account Prefix' } } },
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
      product_categ_id: { type: 'many2one', relation: 'product.category', label: 'Product Category' },
      account_prefix: { type: 'char', label: 'Accounts Prefix' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
    },
    defaults: () => ({ sequence: 10, analytic_distribution: {} }),
    createDefaults: (db) => ({ company_id: currentCompany(db) }),
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
