// Credit limits, lock date, audit trail, tax report, aged balances, follow-ups, analytic accounting and budgets.
import { read, search } from '../orm.js';
import { today } from './common.js';
import { journalItems } from './ledger.js';

const round = (n) => Math.round(n * 100) / 100;
const accountByCode = (db, code) => (db.records['account.account'] ?? []).find((a) => a.code === code);

/** Open receivable (posted, unpaid invoices) of a partner. */
export const receivableOf = (db, partnerId) => round(search(db, 'account.move')
  .filter((m) => m.state === 'posted' && m.move_type === 'out_invoice' && m.partner_id === partnerId)
  .reduce((s, m) => s + m.amount_residual, 0));

/** Throws when confirming `amount` more would exceed the partner's credit limit (0 = no limit). */
export function checkCreditLimit(db, partnerId, amount) {
  const p = read(db, 'res.partner', partnerId);
  const limit = Number(p?.credit_limit) || 0;
  if (!limit) return;
  const exposure = receivableOf(db, partnerId) + (Number(amount) || 0);
  if (exposure > limit) throw new Error(`${p.name} would exceed the credit limit (${round(exposure)} > ${limit})`);
}

const LOCKED_FIELDS = ['invoice_line_ids', 'line_ids', 'invoice_date', 'state', 'partner_id', 'currency_id', 'move_type'];
const moveDate = (m) => m?.invoice_date ?? m?.date ?? today();

/** Entries in a locked period cannot be created posted or have their accounting changed; payments may still be recorded. */
export function moveGuard(db, before, after) {
  const lock = db.settings?.lock_date;
  if (!lock) return null;
  const touchesLocked = (before && moveDate(before) <= lock) || (after.state === 'posted' && moveDate(after) <= lock);
  if (!touchesLocked) return null;
  const changed = !before || LOCKED_FIELDS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return changed ? `The period up to ${lock} is locked` : null;
}

/** With the audit trail on, numbered entries are kept forever (they can be cancelled, not deleted). */
export function moveDeleteGuard(db, move) {
  if (moveDate(move) <= (db.settings?.lock_date ?? '')) return `The period up to ${db.settings.lock_date} is locked`;
  if (db.settings?.audit_trail && move.name && move.name !== '/') return 'Numbered entries cannot be deleted while the audit trail is active; cancel them instead';
  return null;
}

/** VAT return for a period: output tax (sales) − input tax (purchases) = payable. */
export function taxReport(db, period) {
  const items = journalItems(db, period);
  const sum = (code, sign) => {
    const acc = accountByCode(db, code);
    return round(items.filter((l) => l.account_id === acc?.id).reduce((s, l) => s + sign * ((Number(l.debit) || 0) - (Number(l.credit) || 0)), 0));
  };
  const output = sum('251000', -1);
  const input = sum('131000', 1);
  return { output, input, payable: round(output - input) };
}

const BUCKETS = [['current', 'Not due', -Infinity, 0], ['1_30', '1-30', 1, 30], ['31_60', '31-60', 31, 60], ['61_90', '61-90', 61, 90], ['older', 'Older', 91, Infinity]];

/** Aged receivable/payable per partner, bucketed by days past due. */
export function agedBalance(db, kind = 'receivable', at = today()) {
  const type = kind === 'receivable' ? 'out_invoice' : 'in_invoice';
  const rows = new Map();
  for (const m of search(db, 'account.move').filter((x) => x.state === 'posted' && x.move_type === type && x.amount_residual > 0)) {
    const days = Math.floor((new Date(at) - new Date(m.invoice_date_due ?? m.invoice_date)) / 864e5);
    const bucket = BUCKETS.find(([, , from, to]) => days >= from && days <= to)[0];
    const row = rows.get(m.partner_id) ?? { partner_id: m.partner_id, total: 0, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0])) };
    row[bucket] = round(row[bucket] + m.amount_residual);
    row.total = round(row.total + m.amount_residual);
    rows.set(m.partner_id, row);
  }
  return { buckets: BUCKETS.map(([k, label]) => [k, label]), rows: [...rows.values()].sort((a, b) => b.total - a.total) };
}

/** Partners with overdue invoices, for payment reminders. */
export function followUps(db, at = today()) {
  const overdue = search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice' && m.amount_residual > 0 && m.invoice_date_due < at);
  const by = new Map();
  for (const m of overdue) by.set(m.partner_id, [...(by.get(m.partner_id) ?? []), m]);
  return [...by].map(([partner_id, invoices]) => ({ partner_id, invoices, total: round(invoices.reduce((s, m) => s + m.amount_residual, 0)), oldest: invoices.map((m) => m.invoice_date_due).sort()[0] }));
}

/** Actual amount per analytic account from posted invoice/bill lines (income positive, costs negative). */
export function analyticActuals(db, period = {}) {
  const totals = new Map();
  for (const m of search(db, 'account.move').filter((x) => x.state === 'posted' && x.move_type !== 'entry' && (!period.from || x.invoice_date >= period.from) && (!period.to || x.invoice_date <= period.to))) {
    const sign = m.move_type === 'in_invoice' ? -1 : 1;
    for (const l of m.invoice_line_ids ?? []) {
      if (!l.analytic_account_id) continue;
      const amount = (Number(l.qty) || 0) * (Number(l.price_unit) || 0) * (1 - (Number(l.discount) || 0) / 100);
      totals.set(l.analytic_account_id, round((totals.get(l.analytic_account_id) ?? 0) + sign * amount));
    }
  }
  return totals;
}

export const financeModels = {
  'account.analytic.account': {
    label: 'Analytic Accounts',
    fields: {
      name: { type: 'char', label: 'Analytic Account', required: true },
      code: { type: 'char', label: 'Reference' },
      plan: { type: 'selection', label: 'Plan', options: [['project', 'Projects'], ['department', 'Departments'], ['region', 'Regions']] },
      balance: { type: 'monetary', label: 'Balance', readonly: true },
    },
    defaults: () => ({ plan: 'project' }),
    groupBys: ['plan'],
    kanban: { title: 'name', lines: ['code', 'plan'] },
    list: ['code', 'name', 'plan'],
    form: { title: 'name', groups: [['code', 'plan'], []], chatter: true },
  },

  'account.budget': {
    label: 'Budgets',
    fields: {
      name: { type: 'char', label: 'Budget Name', required: true },
      date_from: { type: 'date', label: 'Start Date' },
      date_to: { type: 'date', label: 'End Date' },
      lines: {
        type: 'one2many',
        label: 'Budget Lines',
        fields: { analytic_account_id: { type: 'many2one', relation: 'account.analytic.account', label: 'Analytic Account' }, planned: { type: 'monetary', label: 'Planned Amount' } },
        newLine: () => ({ analytic_account_id: null, planned: 0 }),
      },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['confirmed', 'Confirmed'], ['done', 'Done']] },
    },
    defaults: () => ({ state: 'draft', date_from: today().slice(0, 4) + '-01-01', date_to: today().slice(0, 4) + '-12-31', lines: [] }),
    kanban: { title: 'name', lines: ['date_from', 'date_to'], badge: 'state' },
    list: ['name', 'date_from', 'date_to', 'state'],
    form: {
      statusbar: 'state',
      statusbarClickable: true,
      buttons: [{ label: 'Budget vs Actual', run: (db, r) => ({ db, go: '#/accounting/budget-report' }) }],
      title: 'name',
      groups: [['date_from'], ['date_to']],
      tabs: [{ label: 'Budget Lines', fields: ['lines'] }],
      chatter: true,
    },
  },
};
