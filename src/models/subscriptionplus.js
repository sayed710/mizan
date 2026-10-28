// Recurring plans, billing, upsells, renewals and subscription metrics.
import { create, messagesOf, postNote, read, search, write } from '../orm.js';
import { addDays, amounts, today } from './common.js';
import { moreModels } from './more.js';
import { postMove } from './accounting.js';

const base = moreModels['sale.subscription'];
const round = (n) => Math.round(n * 100) / 100;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
const fallback = (plan) => ({ interval: plan === 'quarterly' ? 3 : 1, unit: { weekly: 'week', yearly: 'year' }[plan] ?? 'month' });
const planFor = (db, sub) => (sub.plan_id && read(db, 'sale.subscription.plan', sub.plan_id)) || fallback(sub.plan);
const priced = (db, sub) => ({ ...sub, recurring_plan: planFor(db, sub) });
const planValues = (plan) => ({ plan_interval: plan.interval, plan_unit: plan.unit });
const checkDate = (date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid invoice date');
};
const linesFor = (sub) => sub.order_line?.length ? sub.order_line : [{ product_id: sub.product_id, qty: 1, price_unit: sub.recurring_amount, tax: 14 }];
const invoicesFor = (db, id) => search(db, 'account.move').filter((r) => r.subscription_id === id && r.move_type === 'out_invoice');
const unpaid = (invoices) => invoices.filter((r) => r.state === 'posted' && r.amount_residual > 0);
const requireSub = (db, id) => {
  const sub = read(db, 'sale.subscription', id);
  if (!sub) throw new Error('Subscription not found');
  return sub;
};

/** Advance a positive recurring interval, clamping calendar months and years to month end. */
export function nextDate(date, plan) {
  const interval = Number(plan?.interval);
  if (!Number.isInteger(interval) || interval <= 0 || !['week', 'month', 'year'].includes(plan?.unit)) throw new Error('Choose a positive recurring interval and a valid unit');
  checkDate(date);
  if (plan.unit === 'week') return addDays(date, interval * 7);
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + interval * (plan.unit === 'year' ? 12 : 1), 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

function refresh(db, sub, date) {
  const invoices = invoicesFor(db, sub.id);
  const vals = {
    ...planValues(planFor(db, sub)),
    invoice_ids: invoices.map((r) => ({ invoice_id: r.id })),
    upsell_ids: search(db, 'sale.subscription').filter((r) => r.origin_id === sub.id && r.is_upsell).map((r) => ({ subscription_id: r.id })),
    overdue: unpaid(invoices).some((r) => (r.invoice_date_due || r.invoice_date) < date),
    last_invoice_date: invoices.map((r) => r.invoice_date).filter(Boolean).sort().at(-1) ?? null,
  };
  const stored = db.records['sale.subscription'].find((r) => r.id === sub.id);
  return Object.entries(vals).every(([key, value]) => JSON.stringify(stored[key]) === JSON.stringify(value)) ? db : write(db, 'sale.subscription', sub.id, vals);
}

function billPeriod(db, sub, date) {
  const following = nextDate(date, planFor(db, sub));
  const generated = base.form.buttons.find((b) => b.label === 'Generate Invoice').run(db, sub);
  const id = Number(generated.go.split('/').at(-1));
  let next = write(generated.db, 'account.move', id, { invoice_date: date, invoice_date_due: addDays(date, 15), company_id: sub.company_id });
  next = postMove(next, id);
  next = write(next, 'sale.subscription', sub.id, { next_invoice_date: following, stage: sub.stage, close_reason: sub.close_reason });
  return { db: next, id };
}

/**
 * Automatic payment needs a payment provider to charge the customer, and Mizan has none yet: the invoice stays open
 * with a note to collect it, instead of booking a bank receipt that never happened.
 */
const collectNote = (db, sub, invoiceId) => (sub.payment_token
  ? postNote(db, 'account.move', invoiceId, 'Automatic payment is on for this subscription, but no payment provider is connected: collect the payment, then register it')
  : db);

function generateInvoice(db, sub) {
  if (sub.stage !== 'progress') throw new Error('Only an in-progress subscription can be invoiced');
  const date = sub.next_invoice_date || today();
  if (sub.end_date && date >= sub.end_date) throw new Error('The subscription term has ended');
  const billed = billPeriod(db, sub, date);
  let next = billed.db;
  next = collectNote(next, sub, billed.id);
  return { db: refresh(next, read(next, 'sale.subscription', sub.id), today()), go: `#/accounting/invoices/${billed.id}` };
}

/** Post each due period once, with an exclusive contract end date. */
export function invoiceDue(db, date = today()) {
  checkDate(date);
  let next = db;
  for (const initial of search(db, 'sale.subscription')) {
    const before = next;
    try {
      next = invoiceOne(next, initial.id, date);
    } catch (e) {
      // One failing contract (e.g. a locked period) must not stop the others; say why on the contract, once.
      const body = `Recurring invoicing failed: ${e.message}`;
      next = messagesOf(before, 'sale.subscription', initial.id).some((m) => m.body === body) ? before : postNote(before, 'sale.subscription', initial.id, body);
    }
  }
  return next;
}

/** Bill every due period of one contract. */
function invoiceOne(db, id, date) {
  let next = db;
  let sub = read(next, 'sale.subscription', id);
  while (sub.stage === 'progress' && sub.next_invoice_date && sub.next_invoice_date <= date) {
    const at = sub.next_invoice_date;
    if (sub.end_date && at >= sub.end_date) {
      next = write(next, 'sale.subscription', sub.id, { stage: 'closed', closed_date: sub.end_date });
      break;
    }
    const following = nextDate(at, planFor(next, sub));
    if (!invoicesFor(next, sub.id).some((r) => r.invoice_date === at && r.state !== 'cancel')) {
      const billed = billPeriod(next, sub, at);
      next = billed.db;
      next = collectNote(next, sub, billed.id);
    }
    next = write(next, 'sale.subscription', sub.id, { next_invoice_date: following, stage: 'progress', close_reason: sub.close_reason });
    sub = read(next, 'sale.subscription', sub.id);
  }
  return refresh(next, read(next, 'sale.subscription', id), date);
}

/** Close running contracts whose oldest posted unpaid invoice has exceeded the plan's grace days. */
export function autoClose(db, date = today()) {
  checkDate(date);
  return search(db, 'sale.subscription').reduce((next, sub) => {
    const limit = Number(planFor(next, sub).auto_close_days ?? 15);
    const oldest = unpaid(invoicesFor(next, sub.id)).map((r) => r.invoice_date).filter(Boolean).sort()[0];
    if (sub.stage === 'progress' && oldest && days(oldest, date) > limit) next = write(next, 'sale.subscription', sub.id, { stage: 'closed', close_reason: 'unpaid', closed_date: date });
    return refresh(next, read(next, 'sale.subscription', sub.id), date);
  }, db);
}

/** Draft an origin-linked upsell quotation priced for the unelapsed days of the current period. */
export function upsell(db, subId, extraLines, date = today()) {
  checkDate(date);
  const sub = requireSub(db, subId);
  if (sub.stage !== 'progress') throw new Error('Only an in-progress subscription can be upsold');
  if (!extraLines?.length) throw new Error('Add at least one upsell line');
  if (extraLines.some((l) => !l.product_id || !Number.isFinite(Number(l.price_unit)) || Number(l.price_unit) < 0 || !(Number(l.qty) > 0))) throw new Error('Upsell lines need a product, positive quantity and a non-negative price');
  const plan = planFor(db, sub);
  let start = sub.start_date;
  let end = nextDate(start, plan);
  while (end <= date) { start = end; end = nextDate(start, plan); }
  if (date < start || (sub.end_date && date >= sub.end_date)) throw new Error('Upsell date must be inside the subscription term');
  const periodDays = days(start, end);
  if (sub.end_date && sub.end_date < end) end = sub.end_date;
  const ratio = days(date, end) / periodDays;
  const result = create(db, 'sale.subscription', {
    partner_id: sub.partner_id, company_id: sub.company_id, product_id: sub.product_id, plan: sub.plan, plan_id: sub.plan_id,
    ...planValues(plan), origin_id: sub.id, is_upsell: true, stage: 'draft', start_date: date, next_invoice_date: date, end_date: end,
    order_line: extraLines.map((l) => ({ ...l, price_unit: round(Number(l.price_unit) * ratio) })),
  });
  return { db: refresh(result.db, sub, date), id: result.id };
}

/** Create a fresh quotation for the successor term and close the original with reciprocal links. */
export function renew(db, subId, { date = today() } = {}) {
  checkDate(date);
  const sub = requireSub(db, subId);
  if (sub.renewal_id) throw new Error('This subscription already has a renewal');
  if (!['progress', 'paused', 'closed'].includes(sub.stage) || sub.is_upsell) throw new Error('Start the subscription before renewing it');
  const start = sub.end_date || date;
  const { db: next, id } = create(db, 'sale.subscription', {
    partner_id: sub.partner_id, company_id: sub.company_id, product_id: sub.product_id, plan: sub.plan, plan_id: sub.plan_id,
    ...planValues(planFor(db, sub)), recurring_amount: sub.recurring_amount, order_line: (sub.order_line ?? []).map((l) => ({ ...l })),
    origin_id: sub.id, start_date: start, next_invoice_date: start, stage: 'draft', payment_token: sub.payment_token,
  });
  return { db: write(next, 'sale.subscription', sub.id, { stage: 'closed', renewal_id: id, closed_date: date, close_reason: 'other' }), id };
}

/** Untaxed recurring revenue normalized to one month (52 weeks per year). */
export function mrr(sub) {
  const plan = sub.recurring_plan ?? (sub.plan_interval ? { interval: sub.plan_interval, unit: sub.plan_unit } : fallback(sub.plan));
  const months = Number(plan.interval) * ({ week: 12 / 52, month: 1, year: 12 }[plan.unit]);
  return round(amounts(linesFor(sub)).untaxed / months);
}

/** Monthly cohort metrics; opening prices come from the last invoice before the month, or current pricing. */
export function kpis(db, date = today()) {
  checkDate(date);
  const start = date.slice(0, 7) + '-01';
  const subs = search(db, 'sale.subscription').filter((s) => !s.is_upsell && s.start_date <= date);
  const closedAt = (s) => s.closed_date || (s.stage === 'closed' ? s.end_date : null);
  const active = subs.filter((s) => s.stage === 'progress');
  const opening = subs.filter((s) => s.start_date < start && (!closedAt(s) || closedAt(s) >= start) && s.stage !== 'draft');
  const churned = subs.filter((s) => s.stage === 'closed' && closedAt(s) >= start && closedAt(s) <= date && !s.renewal_id);
  const value = (s) => mrr(priced(db, s));
  const openingValue = (s) => {
    const invoice = invoicesFor(db, s.id).filter((r) => r.state === 'posted' && r.invoice_date < start).sort((a, b) => b.invoice_date.localeCompare(a.invoice_date))[0];
    return invoice ? mrr({ ...priced(db, s), order_line: invoice.invoice_line_ids }) : value(s);
  };
  const sum = (rows, fn = value) => round(rows.reduce((n, s) => n + fn(s), 0));
  const revenue = sum(active);
  const openingMrr = sum(opening, openingValue);
  return {
    mrr: revenue, arr: round(revenue * 12), activeCount: active.length,
    churnRate: opening.length ? churned.filter((s) => opening.some((o) => o.id === s.id)).length / opening.length : 0,
    newMrr: sum(active.filter((s) => s.start_date >= start && !s.origin_id)), churnedMrr: sum(churned),
    netRevenueRetention: openingMrr ? sum(opening.filter((s) => s.stage === 'progress' || s.renewal_id), (s) => s.renewal_id ? value(read(db, 'sale.subscription', s.renewal_id)) : value(s)) / openingMrr : 0,
  };
}

/** Scheduler entry point: bill due periods, then enforce unpaid closure policy. */
export const subscriptionJobs = (db, date = today()) => autoClose(invoiceDue(db, date), date);

const relationLines = (model, key, label) => ({ type: 'one2many', label, readonly: true, fields: { [key]: { type: 'many2one', relation: model, label } } });

export const subscriptionPlusModels = {
  'sale.subscription.plan': {
    label: 'Recurring Plans',
    fields: {
      name: { type: 'char', label: 'Plan Name', required: true },
      interval: { type: 'integer', label: 'Interval', required: true },
      unit: { type: 'selection', label: 'Unit', options: [['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']], required: true },
      auto_close_days: { type: 'integer', label: 'Unpaid Days Before Closing' },
      user_closable: { type: 'boolean', label: 'Customer Can Close' },
      user_extend: { type: 'boolean', label: 'Customer Can Extend' },
    },
    defaults: () => ({ interval: 1, unit: 'month', auto_close_days: 15, user_closable: false, user_extend: false }),
    guard: (db, before, r) => !Number.isInteger(r.interval) || r.interval <= 0 || !['week', 'month', 'year'].includes(r.unit) || !Number.isInteger(r.auto_close_days) || r.auto_close_days < 0 ? 'Use a positive interval and non-negative unpaid days' : null,
    list: ['name', 'interval', 'unit', 'auto_close_days'],
    form: { title: 'name', groups: [['interval', 'unit', 'auto_close_days'], ['user_closable', 'user_extend']] },
  },
  'sale.subscription': {
    ...base,
    fields: {
      ...base.fields,
      plan_id: { type: 'many2one', relation: 'sale.subscription.plan', label: 'Recurring Plan' },
      origin_id: { type: 'many2one', relation: 'sale.subscription', label: 'Original Subscription', readonly: true },
      renewal_id: { type: 'many2one', relation: 'sale.subscription', label: 'Renewal', readonly: true },
      upsell_ids: relationLines('sale.subscription', 'subscription_id', 'Upsells'),
      invoice_ids: relationLines('account.move', 'invoice_id', 'Invoices'),
      payment_token: { type: 'boolean', label: 'Automatic Payment (needs a payment provider)' },
      plan_interval: { type: 'integer', label: 'Billing Interval', readonly: true },
      plan_unit: { type: 'selection', label: 'Billing Unit', readonly: true, options: [['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']] },
      overdue: { type: 'boolean', label: 'Has Overdue Invoices', readonly: true },
      is_upsell: { type: 'boolean', label: 'Upsell Quotation', readonly: true },
      last_invoice_date: { type: 'date', label: 'Last Invoice', readonly: true },
      closed_date: { type: 'date', label: 'Closed On', readonly: true },
      close_reason: { ...base.fields.close_reason, options: [...base.fields.close_reason.options, ['unpaid', 'Unpaid Invoices']] },
      health: { type: 'selection', label: 'Health', options: [['normal', 'Normal'], ['done', 'Closed'], ['bad', 'Overdue']], compute: (r) => r.stage === 'closed' ? 'done' : r.overdue ? 'bad' : 'normal' },
      recurring_monthly: { ...base.fields.recurring_monthly, compute: mrr },
    },
    onchange: (r, field, db) => ['plan_id', 'plan'].includes(field) ? planValues(planFor(db, r)) : {},
    kanban: { ...base.kanban, badge: 'health' },
    form: {
      ...base.form,
      buttons: [
        ...base.form.buttons.filter((b) => !['Renew', 'Generate Invoice', 'Close'].includes(b.label)),
        { label: 'Generate Invoice', primary: true, when: (r) => r.stage === 'progress', run: generateInvoice },
        { label: 'Upsell', when: (r) => r.stage === 'progress', run: (db, r) => { const result = upsell(db, r.id, linesFor(r).map((l) => ({ ...l, qty: 1 })), today()); return { db: result.db, go: `#/subscriptions/subscriptions/${result.id}` }; } },
        { label: 'Renew', when: (r) => ['progress', 'closed'].includes(r.stage) && !r.renewal_id, run: (db, r) => { const result = renew(db, r.id, { date: today() }); return { db: result.db, go: `#/subscriptions/subscriptions/${result.id}` }; } },
        { ...base.form.buttons.find((b) => b.label === 'Close'), run: (db, r) => { const result = base.form.buttons.find((b) => b.label === 'Close').run(db, r); return { db: result.db === db ? db : write(result.db, 'sale.subscription', r.id, { closed_date: today() }) }; } },
        { label: 'Reopen', when: (r) => r.stage === 'closed' && !r.renewal_id, vals: { stage: 'progress', close_reason: null, closed_date: null, end_date: null } },
      ],
      groups: [...base.form.groups, ['plan_id', 'payment_token', 'health', 'last_invoice_date'], ['origin_id', 'renewal_id', 'closed_date']],
      tabs: [...base.form.tabs, { label: 'Invoices', fields: ['invoice_ids'] }, { label: 'Upsells', fields: ['upsell_ids'] }],
    },
  },
};
