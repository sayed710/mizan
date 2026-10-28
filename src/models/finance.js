// Credit limits, lock date, audit trail, tax report, aged balances, follow-ups, analytic accounting and budgets.
import { postNotes, read, search, writeMany } from '../orm.js';
import { today } from './common.js';
import { journalItems } from './ledger.js';
import { lineTaxOf, lineUntaxed } from './taxes.js';
import { companySum } from './money.js';

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

const LOCKED_FIELDS = ['name', 'invoice_line_ids', 'line_ids', 'invoice_date', 'state', 'partner_id', 'currency_id', 'move_type'];
const moveDate = (m) => m?.invoice_date ?? m?.date ?? today();

/**
 * Entries in a locked period cannot be created posted or have their accounting changed (payments dated after the
 * lock date may still settle them); with the audit trail on, a posted entry keeps its number.
 */
/**
 * The latest lock date that applies to a move: the global and hard locks always, the sales or purchase lock
 * by journal type. Empty when nothing is locked.
 */
export function lockDateFor(settings = {}, move = {}) {
  const side = String(move.move_type ?? '').startsWith('out_') ? settings.sale_lock_date : String(move.move_type ?? '').startsWith('in_') ? settings.purchase_lock_date : null;
  return [settings.lock_date, settings.hard_lock_date, side].filter(Boolean).sort().at(-1) ?? '';
}

/**
 * Journal items of a posted entry need an existing account: reports group by account and silently skip unknown
 * ones, so a single bad line would stop the trial balance and balance sheet from closing.
 */
export function accountsError(db, before, after) {
  if (after.state !== 'posted') return null;
  if (before?.state === 'posted' && JSON.stringify(before.line_ids) === JSON.stringify(after.line_ids)) return null;
  const known = new Set((db.records?.['account.account'] ?? []).map((a) => a.id));
  const bad = (after.line_ids ?? []).findIndex((l) => ((Number(l.debit) || 0) || (Number(l.credit) || 0)) && !known.has(l.account_id));
  return bad < 0 ? null : `Journal item ${bad + 1} needs an existing account`;
}

/** Accounts used by journal items cannot be deleted (archive them instead): their balances would vanish from reports. */
export function accountDeleteGuard(db, account, pending = db) {
  // `pending` is the database as the diff leaves it, so moves created in the same diff count too.
  const used = [...(db.records['account.move'] ?? []), ...(pending.records['account.move'] ?? [])].some((m) => (m.line_ids ?? []).some((l) => l.account_id === account.id));
  return used ? `${account.code} ${account.name} has journal items and cannot be deleted` : null;
}

export function moveGuard(db, before, after) {
  const accounts = accountsError(db, before, after);
  if (accounts) return accounts;
  if (db.settings?.audit_trail && before?.state === 'posted' && before.name !== after.name) return 'Posted entries keep their number while the audit trail is active';
  const lock = [before, after].filter(Boolean).map((m) => lockDateFor(db.settings, m)).sort().at(-1);
  if (!lock) return null;
  const touchesLocked = (before && moveDate(before) <= lock) || (after.state === 'posted' && moveDate(after) <= lock);
  if (!touchesLocked) return null;
  const changed = !before || LOCKED_FIELDS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return changed ? `The period up to ${lock} is locked` : null;
}

/** With the audit trail on, numbered entries are kept forever (they can be cancelled, not deleted). */
export function moveDeleteGuard(db, move) {
  const lock = lockDateFor(db.settings, move);
  if (lock && moveDate(move) <= lock) return `The period up to ${lock} is locked`;
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

/** Base and tax per tax over posted invoices/bills dated in the period, split into sales and purchases (refunds negative). */
export function taxesByTax(db, { from, to } = {}) {
  const rows = new Map();
  for (const m of search(db, 'account.move').filter((x) => x.state === 'posted' && x.move_type !== 'entry' && (!from || x.invoice_date >= from) && (!to || x.invoice_date <= to))) {
    const side = ['in_invoice', 'in_refund'].includes(m.move_type) ? 'purchase' : 'sale';
    const sign = ['out_refund', 'in_refund'].includes(m.move_type) ? -1 : 1;
    for (const l of m.invoice_line_ids ?? []) {
      const name = l.tax_name || `${Number(l.tax) || 0}%`;
      const key = `${side}|${name}`;
      const row = rows.get(key) ?? { side, name, base: 0, tax: 0 };
      rows.set(key, { ...row, base: round(row.base + sign * lineUntaxed(l)), tax: round(row.tax + sign * lineTaxOf(l)) });
    }
  }
  return [...rows.values()].sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name));
}

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

/**
 * One summary card per journal, as on the accounting dashboard: documents to validate, unpaid and late
 * for sales/purchase journals; balance and lines to reconcile for bank/cash journals.
 */
export function journalCards(db, at = today()) {
  const moves = search(db, 'account.move');
  const items = journalItems(db);
  // Draft invoices get their journal on posting, so they count on the default INV/BILL journal meanwhile.
  const draftJournal = (m) => (m.move_type === 'entry' ? null : ['in_invoice', 'in_refund'].includes(m.move_type) ? 'BILL' : 'INV');
  return search(db, 'account.journal').map((j) => {
    const own = moves.filter((m) => m.journal_id === j.id || (m.state === 'draft' && !m.journal_id && draftJournal(m) === j.code));
    if (['sale', 'purchase'].includes(j.type)) {
      const unpaid = own.filter((m) => m.state === 'posted' && m.amount_residual > 0);
      return {
        journal: j, kind: j.type, draft: own.filter((m) => m.state === 'draft').length, unpaid: unpaid.length,
        unpaidAmount: companySum(db, unpaid, 'amount_residual'), late: unpaid.filter((m) => m.invoice_date_due < at).length,
      };
    }
    if (['bank', 'cash'].includes(j.type)) {
      const balance = round(items.filter((l) => l.account_id === j.default_account_id).reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
      const toCheck = j.type === 'bank' ? search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check') : [];
      return { journal: j, kind: j.type, balance, toReconcile: toCheck.length, toReconcileAmount: round(toCheck.reduce((s, l) => s + (Number(l.amount) || 0), 0)) };
    }
    return { journal: j, kind: 'general', entries: own.filter((m) => m.state === 'posted').length, draft: own.filter((m) => m.state === 'draft').length };
  });
}

/** Partners with overdue invoices, for payment reminders. */
export function followUps(db, at = today()) {
  const overdue = search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice' && m.amount_residual > 0 && m.invoice_date_due < at);
  const by = new Map();
  for (const m of overdue) (by.get(m.partner_id) ?? by.set(m.partner_id, []).get(m.partner_id)).push(m);
  return [...by].map(([partner_id, invoices]) => ({ partner_id, invoices, total: round(invoices.reduce((s, m) => s + m.amount_residual, 0)), oldest: invoices.map((m) => m.invoice_date_due).sort()[0] }));
}

/**
 * Automatic reminders: for each overdue customer, the highest follow-up level reached by its oldest overdue
 * invoice is logged on the contact once (the contact remembers the last level sent).
 */
export function runFollowUps(db, at = today()) {
  const levels = search(db, 'account.followup.level').sort((a, b) => (Number(a.delay) || 0) - (Number(b.delay) || 0));
  if (!levels.length) return db;
  const overdue = followUps(db, at);
  // Customers who caught up start again from the first level next time.
  const late = new Set(overdue.map((f) => f.partner_id));
  const partners = new Map((db.records['res.partner'] ?? []).map((p) => [p.id, p]));
  const updates = new Map(search(db, 'res.partner').filter((p) => p.followup_level_delay != null && !late.has(p.id))
    .map((p) => [p.id, { followup_level_delay: null }]));
  // Notes and level changes are collected, then written in one batch so the job stays linear in the data.
  const notes = [];
  for (const f of overdue) {
    const days = Math.floor((new Date(at) - new Date(f.oldest)) / 864e5);
    const level = [...levels].reverse().find((l) => days >= (Number(l.delay) || 0));
    const partner = partners.get(f.partner_id);
    if (!level || !partner || (Number(partner.followup_level_delay) || -1) >= Number(level.delay)) continue;
    const list = f.invoices.map((m) => `${m.name} (${m.invoice_date_due}): ${round(m.amount_residual)}`).join('; ');
    notes.push(['res.partner', partner.id, `${level.name}: ${round(f.total)} overdue — ${list}. ${level.message ?? ''}`.trim()]);
    updates.set(partner.id, { followup_level_delay: Number(level.delay), followup_date: at });
  }
  return writeMany(postNotes(db, notes), 'res.partner', updates);
}

const currencyOf = (db, move) => read(db, 'res.currency', move.currency_id)?.name ?? db.settings?.currency ?? '';

/** Reminder text for one customer's overdue invoices, each amount with its currency. */
export const followUpText = (db, f) => f.invoices.map((m) => `${m.name} (${m.invoice_date_due}): ${round(m.amount_residual)} ${currencyOf(db, m)}`.trim()).join('\n');

/** Record a reminder sent by hand: a note on the contact, the date, and the follow-up level it reached. */
export function logManualFollowUp(db, partnerId, at = today()) {
  const f = followUps(db, at).find((x) => x.partner_id === partnerId);
  if (!f) throw new Error('This customer has no overdue invoices');
  const late = Math.floor((new Date(at) - new Date(f.oldest)) / 864e5);
  const level = search(db, 'account.followup.level').sort((a, b) => (Number(b.delay) || 0) - (Number(a.delay) || 0)).find((l) => late >= (Number(l.delay) || 0));
  const noted = postNote(db, 'res.partner', partnerId, `Payment reminder sent by email${level ? ` (${level.name})` : ''}:\n${followUpText(db, f)}`);
  return write(noted, 'res.partner', partnerId, { followup_date: at, ...(level ? { followup_level_delay: Number(level.delay) } : {}) });
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
  'account.followup.level': {
    label: 'Follow-up Levels',
    fields: {
      name: { type: 'char', label: 'Level', required: true },
      delay: { type: 'integer', label: 'Days Overdue' },
      message: { type: 'text', label: 'Message' },
    },
    defaults: () => ({ delay: 15 }),
    kanban: { title: 'name', lines: ['delay'] },
    list: ['delay', 'name'],
    form: { title: 'name', groups: [['delay'], []], tabs: [{ label: 'Message', fields: ['message'] }] },
  },

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
