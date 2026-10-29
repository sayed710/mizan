// Tax Returns and Return Types (Odoo 20 parity).
import { create, read, write } from '../orm.js';
import { addDays, today } from './common.js';
import { accountId } from './ledger.js';
import { postPayment } from './pay.js';
import { moveDate, postTaxReturnClosing, syncLockDate, taxClosingProofMatchesReturn, taxReport, validateTaxReturnPeriod } from './finance.js';

/** Ensure a VAT return type exists for each company, matching its periodicity setting. */
export function ensureReturnTypes(db) {
  let next = db;
  const companies = next.records?.['res.company'] ?? [];
  const existingTypes = next.records?.['account.return.type'] ?? [];

  for (const company of companies) {
    const rawPer = company.tax_periodicity || company.account_tax_periodicity || next.settings?.tax_periodicity;
    const periodicity = ['quarterly', 'trimester'].includes(rawPer) ? 'trimester' : ['semester', 'year'].includes(rawPer) ? rawPer : 'monthly';
    const startDate = company.tax_start_date || company.fiscalyear_start_date || null;

    const existing = existingTypes.find((t) => (t.company_id ?? 1) === company.id && t.name === 'VAT Return');
    if (existing) {
      const updates = {};
      if (existing.deadline_periodicity !== periodicity) {
        updates.deadline_periodicity = periodicity;
      }
      if (company.tax_start_date && existing.deadline_start_date !== company.tax_start_date) {
        updates.deadline_start_date = company.tax_start_date;
      }
      if (Object.keys(updates).length > 0) {
        next = write(next, 'account.return.type', existing.id, updates);
      }
      continue;
    }

    const made = create(next, 'account.return.type', {
      name: 'VAT Return',
      category: 'account_return',
      states_workflow: 'generic_state_review_submit',
      deadline_periodicity: periodicity,
      deadline_start_date: startDate,
      deadline_days_delay: 20,
      auto_generate: true,
      company_id: company.id,
      tax_payable_account_id: accountId(next, '251000', company.id),
      tax_receivable_account_id: accountId(next, '131000', company.id),
      rounding_profit_account_id: accountId(next, '450000', company.id),
      rounding_loss_account_id: accountId(next, '690000', company.id),
      payment_partner_id: company.partner_id ?? 1,
    });
    next = made.db;
  }
  return next;
}

/** Calculate inclusive end date of a month (YYYY-MM-DD). */
function monthEnd(year, month) {
  const d = new Date(year, month, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Step through periods from `startDate` up to `atDate` (honoring start day and historical periods). */
export function periodsUpTo(periodicity = 'monthly', startDate = `${today().slice(0, 4)}-01-01`, atDate = today()) {
  const periods = [];
  const [, startM] = startDate.split('-').map(Number);
  const monthsStep = periodicity === 'year' ? 12 : periodicity === 'semester' ? 6 : periodicity === 'trimester' ? 3 : 1;

  let [y, m] = startDate.slice(0, 7).split('-').map(Number);
  let isFirst = true;

  while (true) {
    let from;
    let endMonth;
    if (isFirst) {
      from = startDate;
      if (periodicity === 'trimester') {
        endMonth = Math.floor((startM - 1) / 3) * 3 + 3;
      } else if (periodicity === 'semester') {
        endMonth = startM <= 6 ? 6 : 12;
      } else if (periodicity === 'year') {
        endMonth = 12;
      } else {
        endMonth = startM;
      }
      isFirst = false;
    } else {
      from = `${y}-${String(m).padStart(2, '0')}-01`;
      endMonth = m + monthsStep - 1;
    }

    if (from > atDate) break;
    const to = monthEnd(y, endMonth);
    periods.push({ from, to });

    m = endMonth + 1;
    if (m > 12) {
      y += Math.floor((m - 1) / 12);
      m = ((m - 1) % 12) + 1;
    }
  }
  return periods;
}

/** Derive the first complete period from the company's earliest accounting activity when no start was configured. */
function historicalStart(db, companyId, periodicity, atDate) {
  const earliest = (db.records['account.move'] ?? [])
    .filter((move) => move.state !== 'cancel' && (move.company_id ?? 1) === companyId)
    .map(moveDate)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= atDate)
    .sort()[0];
  if (!earliest) return `${atDate.slice(0, 4)}-01-01`;
  const [year, month] = earliest.split('-').map(Number);
  const step = periodicity === 'year' ? 12 : periodicity === 'semester' ? 6 : periodicity === 'trimester' ? 3 : 1;
  const firstMonth = Math.floor((month - 1) / step) * step + 1;
  return `${year}-${String(firstMonth).padStart(2, '0')}-01`;
}

/** Remove already covered dates from a planned period, preserving uncovered contiguous intervals. */
function uncoveredPeriods(period, covered) {
  let cursor = period.from;
  const gaps = [];
  for (const existing of covered) {
    if (existing.date_to < cursor) continue;
    if (existing.date_from > period.to) break;
    if (existing.date_from > cursor) gaps.push({ from: cursor, to: addDays(existing.date_from, -1) });
    if (existing.date_to >= cursor) cursor = addDays(existing.date_to, 1);
    if (cursor > period.to) break;
  }
  if (cursor <= period.to) gaps.push({ from: cursor, to: period.to });
  return gaps;
}

/** Create missing returns for each period up to today for return type `typeId`. */
export function generateReturns(db, typeId) {
  const type = read(db, 'account.return.type', typeId);
  if (!type) throw new Error('Return type not found');
  const companyId = type.company_id ?? 1;
  const periodicity = type.deadline_periodicity || 'monthly';
  const atDate = today();
  const start = type.deadline_start_date || historicalStart(db, companyId, periodicity, atDate);
  const periods = periodsUpTo(periodicity, start, atDate);

  // Archived and submitted returns still cover their dates; never recreate or overlap them.
  const existing = (db.records['account.return'] ?? [])
    .filter((r) => r.type_id === typeId && (r.company_id ?? 1) === companyId && r.date_from && r.date_to)
    .sort((a, b) => a.date_from.localeCompare(b.date_from));
  const missing = periods.flatMap((period) => uncoveredPeriods(period, existing)).filter((period) => period.from <= atDate);

  let nextDb = db;
  const created = [];
  for (const p of missing) {

    const rep = taxReport(nextDb, { from: p.from, to: p.to, company_id: companyId });
    const toPay = rep.payable;
    const deadline = addDays(p.to, type.deadline_days_delay ?? 0);
    const name = `${type.name} (${p.from} - ${p.to})`;

    const res = create(nextDb, 'account.return', {
      name,
      type_id: typeId,
      date_from: p.from,
      date_to: p.to,
      company_id: companyId,
      state: 'new',
      date_deadline: deadline,
      date_lock: null,
      date_submission: null,
      total_amount_to_pay: toPay,
      closing_move_ids: [],
      is_completed: false,
      attachment_ids: [],
    });
    nextDb = res.db;
    created.push(read(nextDb, 'account.return', res.id));
  }

  return { db: nextDb, created };
}

/** Review a draft return: checks for draft entries and unbalanced tax accounts. */
export function reviewReturn(db, returnId) {
  const ret = read(db, 'account.return', returnId);
  if (!ret) throw new Error('Tax return not found');
  if (ret.state !== 'new') {
    throw new Error(`Cannot review a tax return in state ${ret.state}`);
  }

  const rep = validateTaxReturnPeriod(db, ret);
  return write(db, 'account.return', ret.id, {
    state: 'reviewed',
    total_amount_to_pay: rep.payable,
  });
}


/** Submit a tax return: posts closing move, locks period, updates date_lock. */
export function submitReturn(db, returnId) {
  const ret = read(db, 'account.return', returnId);
  if (!ret) throw new Error('Tax return not found');
  const type = read(db, 'account.return.type', ret.type_id);
  const workflow = type?.states_workflow ?? 'generic_state_review_submit';

  let currentDb = db;
  if (workflow === 'generic_state_review_submit') {
    if (ret.state !== 'reviewed') {
      throw new Error(`Cannot submit a return in status "${ret.state}"; review it first`);
    }
  } else {
    if (!['new', 'reviewed'].includes(ret.state)) {
      throw new Error(`Cannot submit a return in status "${ret.state}"`);
    }
    if (ret.state === 'new') {
      currentDb = reviewReturn(currentDb, returnId);
    }
  }

  const currentRet = read(currentDb, 'account.return', returnId);
  const closing = postTaxReturnClosing(currentDb, currentRet.id);
  let nextDb = closing.db;
  const moveId = closing.id;
  const finalPayable = closing.payable;

  nextDb = write(nextDb, 'account.return', currentRet.id, {
    state: 'submitted',
    date_lock: currentRet.date_to,
    date_submission: today(),
    total_amount_to_pay: finalPayable,
    closing_move_ids: moveId ? [moveId] : currentRet.closing_move_ids ?? [],
    is_completed: false,
  });

  return syncLockDate(nextDb);
}

/** Pay a submitted tax return: registers outbound payment or inbound refund to payment_partner_id. */
export function payReturn(db, returnId) {
  const ret = read(db, 'account.return', returnId);
  if (!ret) throw new Error('Tax return not found');
  const type = read(db, 'account.return.type', ret.type_id);
  const workflow = type?.states_workflow ?? 'generic_state_review_submit';

  if (workflow === 'generic_state_only_pay') {
    if (!['new', 'reviewed', 'submitted'].includes(ret.state)) {
      throw new Error(`Cannot pay a tax return in state ${ret.state}`);
    }
    if (ret.state !== 'submitted') return payReturn(submitReturn(db, returnId), returnId);
  } else {
    if (ret.state !== 'submitted') {
      throw new Error(`Cannot pay a tax return in state ${ret.state}`);
    }
  }

  const partnerId = type?.payment_partner_id || ret.payment_partner_id;
  const companyId = ret.company_id ?? 1;
  const amount = Number(ret.total_amount_to_pay) || 0;

  const taxPayableAccId = type?.tax_payable_account_id || accountId(db, '251000', companyId);
  const taxReceivableAccId = type?.tax_receivable_account_id || accountId(db, '131000', companyId);
  const taxPayableAcc = (taxPayableAccId && read(db, 'account.account', taxPayableAccId)?.code) || '251000';
  const taxReceivableAcc = (taxReceivableAccId && read(db, 'account.account', taxReceivableAccId)?.code) || '131000';

  let nextDb = db;
  let paymentId = null;

  if (amount > 0) {
    if (!partnerId) throw new Error('Set a payment partner on the return type');
    const created = create(nextDb, 'account.payment', {
      partner_id: partnerId,
      partner_type: 'supplier',
      payment_type: 'outbound',
      amount,
      date: today(),
      memo: `Tax Return Payment: ${ret.name}`,
      company_id: companyId,
      state: 'draft',
      destination_account_id: taxPayableAccId,
      destination_account_code: taxPayableAcc,
      is_tax_payment: true,
      return_id: ret.id,
    });
    paymentId = created.id;
    nextDb = postPayment(created.db, read(created.db, 'account.payment', created.id));
  } else if (amount < 0) {
    if (!partnerId) throw new Error('Set a payment partner on the return type');
    const created = create(nextDb, 'account.payment', {
      partner_id: partnerId,
      partner_type: 'supplier',
      payment_type: 'inbound',
      amount: -amount,
      date: today(),
      memo: `Tax Return Refund: ${ret.name}`,
      company_id: companyId,
      state: 'draft',
      destination_account_id: taxReceivableAccId,
      destination_account_code: taxReceivableAcc,
      is_tax_payment: true,
      return_id: ret.id,
    });
    paymentId = created.id;
    nextDb = postPayment(created.db, read(created.db, 'account.payment', created.id));
  }

  return write(nextDb, 'account.return', ret.id, {
    state: 'paid',
    is_completed: true,
    ...(paymentId ? { payment_id: paymentId } : {}),
  });
}

/** Reset to draft: cancels closing move and unlocks period, forbidden after pay. */
export function resetReturnToDraft(db, returnId) {
  const ret = read(db, 'account.return', returnId);
  if (!ret) throw new Error('Tax return not found');
  if (ret.state === 'paid') {
    throw new Error('Paid returns cannot be reset to draft');
  }

  let nextDb = db;

  // Cancel closing moves
  for (const moveId of ret.closing_move_ids ?? []) {
    const m = read(nextDb, 'account.move', moveId);
    if (m && m.state !== 'cancel') {
      if (m.state === 'posted') {
        nextDb = write(nextDb, 'account.move', moveId, { state: 'draft' });
      }
      nextDb = write(nextDb, 'account.move', moveId, { state: 'cancel' });
    }
  }

  nextDb = write(nextDb, 'account.return', ret.id, {
    state: 'new',
    date_lock: null,
    date_submission: null,
    is_completed: false,
    closing_move_ids: [],
  });

  return syncLockDate(nextDb, { excludeReturnId: ret.id });
}

function returnGuard(db, before, after, ctx) {
  if (before?.state === 'paid' && after.state !== 'paid') {
    return 'Paid returns cannot be reset to draft';
  }
  const transitions = { new: ['reviewed'], reviewed: ['new', 'submitted'], submitted: ['new', 'paid'], paid: [] };
  const directPay = before && ['new', 'reviewed'].includes(before.state) && after.state === 'paid'
    && read(db, 'account.return.type', after.type_id)?.states_workflow === 'generic_state_only_pay'
    && taxClosingProofMatchesReturn(ctx, after);
  if (before && before.state !== after.state && !transitions[before.state]?.includes(after.state) && !directPay) {
    return 'Tax return transition is not allowed';
  }
  if (before?.state === 'reviewed' && after.state === 'submitted') {
    const moves = (after.closing_move_ids ?? []).map((id) => read(db, 'account.move', id));
    if (!moves.length || moves.some((move) => !move || move.state !== 'posted' || move.date !== after.date_to || (move.company_id ?? 1) !== after.company_id)
      || after.date_lock !== after.date_to || !after.date_submission) {
      return 'Tax return submission requires a posted closing move';
    }
  }
  if (before && ['submitted', 'paid'].includes(before.state)) {
    const LOCKED = ['type_id', 'date_from', 'date_to', 'company_id', 'total_amount_to_pay'];
    if (LOCKED.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) {
      return 'Submitted or paid tax returns cannot be modified';
    }
    if (before.state === 'submitted' && after.state === 'new') {
      if ((before.closing_move_ids ?? []).some((id) => read(db, 'account.move', id)?.state !== 'cancel')) {
        return 'Tax return closing moves must be cancelled before reset';
      }
    } else if (before.state === 'submitted' && after.state === 'paid') {
      const payment = after.payment_id && read(db, 'account.payment', after.payment_id);
      if (!after.is_completed || (Number(after.total_amount_to_pay) && (payment?.state !== 'posted' || payment.return_id !== after.id))) {
        return 'Tax return payment requires a posted payment';
      }
    }
  }
  return null;
}

export const taxReturnModels = {
  'account.return.type': {
    label: 'Return Types',
    fields: {
      name: { type: 'char', label: 'Return Type', required: true },
      category: {
        type: 'selection',
        label: 'Category',
        required: true,
        options: [['account_return', 'Tax Return'], ['audit', 'Audit']],
      },
      states_workflow: {
        type: 'selection',
        label: 'Workflow',
        required: true,
        options: [
          ['generic_state_review_submit', 'Review and Submit'],
          ['generic_state_tax_report', 'Tax Report'],
          ['generic_state_only_pay', 'Direct Pay'],
        ],
      },
      deadline_periodicity: {
        type: 'selection',
        label: 'Periodicity',
        options: [
          ['monthly', 'Monthly'],
          ['trimester', 'Trimester'],
          ['semester', 'Semester'],
          ['year', 'Year'],
        ],
      },
      deadline_start_date: { type: 'date', label: 'First Period Start' },
      deadline_days_delay: { type: 'integer', label: 'Deadline Delay (days)' },
      auto_generate: { type: 'boolean', label: 'Auto Generate' },
      payment_partner_id: { type: 'many2one', relation: 'res.partner', label: 'Payment Partner' },
      tax_payable_account_id: { type: 'many2one', relation: 'account.account', label: 'Tax Payable Account' },
      tax_receivable_account_id: { type: 'many2one', relation: 'account.account', label: 'Tax Receivable Account' },
      rounding_profit_account_id: { type: 'many2one', relation: 'account.account', label: 'Rounding Profit Account' },
      rounding_loss_account_id: { type: 'many2one', relation: 'account.account', label: 'Rounding Loss Account' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company' },
    },
    defaults: () => ({
      category: 'account_return',
      states_workflow: 'generic_state_review_submit',
      deadline_periodicity: 'monthly',
      deadline_days_delay: 20,
      auto_generate: true,
    }),
    list: ['name', 'category', 'states_workflow', 'deadline_periodicity', 'deadline_days_delay', 'auto_generate'],
    kanban: { title: 'name', lines: ['category', 'deadline_periodicity'] },
    form: {
      title: 'name',
      groups: [
        ['category', 'states_workflow', 'deadline_periodicity', 'deadline_start_date', 'deadline_days_delay', 'auto_generate'],
        ['payment_partner_id', 'tax_payable_account_id', 'tax_receivable_account_id', 'rounding_profit_account_id', 'rounding_loss_account_id', 'company_id'],
      ],
      buttons: [
        { label: 'Generate Returns', primary: true, run: (db, r) => generateReturns(db, r.id) },
      ],
      chatter: true,
    },
  },

  'account.return': {
    label: 'Tax Returns',
    guard: returnGuard,
    fields: {
      name: { type: 'char', label: 'Return', required: true },
      type_id: { type: 'many2one', relation: 'account.return.type', label: 'Return Type', required: true },
      date_from: { type: 'date', label: 'Start Date', required: true },
      date_to: { type: 'date', label: 'End Date', required: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      state: {
        type: 'selection',
        label: 'Status',
        tracking: true,
        options: [
          ['new', 'Draft'],
          ['reviewed', 'Reviewed'],
          ['submitted', 'Submitted'],
          ['paid', 'Paid'],
        ],
      },
      date_deadline: { type: 'date', label: 'Deadline' },
      date_lock: { type: 'date', label: 'Lock Date', readonly: true },
      date_submission: { type: 'date', label: 'Submission Date', readonly: true },
      total_amount_to_pay: { type: 'monetary', label: 'Amount to Pay' },
      closing_move_ids: { type: 'many2many', relation: 'account.move', label: 'Closing Moves', readonly: true },
      payment_id: { type: 'many2one', relation: 'account.payment', label: 'Payment', readonly: true },
      is_completed: { type: 'boolean', label: 'Completed', readonly: true },
      attachment_ids: { type: 'many2many', relation: 'documents.document', label: 'Attachments' },
    },
    defaults: () => ({
      state: 'new',
      company_id: 1,
      is_completed: false,
      closing_move_ids: [],
      attachment_ids: [],
    }),
    groupBys: ['type_id', 'state', 'company_id'],
    list: ['name', 'type_id', 'date_from', 'date_to', 'date_deadline', 'total_amount_to_pay', 'state'],
    kanban: { title: 'name', lines: ['date_from', 'date_to', 'total_amount_to_pay'], badge: 'state' },
    form: {
      statusbar: 'state',
      statusbarClickable: false,
      lockedWhen: (r) => ['submitted', 'paid'].includes(r.state),
      title: 'name',
      groups: [
        ['type_id', 'date_from', 'date_to', 'company_id'],
        ['date_deadline', 'date_lock', 'date_submission', 'total_amount_to_pay', 'is_completed'],
      ],
      tabs: [
        {
          label: 'Tax Report',
          fields: [],
        },
        {
          label: 'Closing Moves',
          fields: ['closing_move_ids', 'attachment_ids'],
        },
      ],
      buttons: [
        {
          label: 'Review',
          primary: true,
          when: (r, db) => r.state === 'new' && (read(db, 'account.return.type', r.type_id)?.states_workflow ?? 'generic_state_review_submit') === 'generic_state_review_submit',
          run: (db, r) => ({ db: reviewReturn(db, r.id) }),
        },
        {
          label: 'Submit',
          primary: true,
          posts: true,
          when: (r, db) => r.state === 'reviewed' || (r.state === 'new' && (read(db, 'account.return.type', r.type_id)?.states_workflow ?? 'generic_state_review_submit') !== 'generic_state_review_submit'),
          run: (db, r) => ({ db: submitReturn(db, r.id) }),
        },
        {
          label: 'Pay',
          primary: true,
          posts: true,
          when: (r, db) => r.state === 'submitted' || (['new', 'reviewed'].includes(r.state) && read(db, 'account.return.type', r.type_id)?.states_workflow === 'generic_state_only_pay'),
          run: (db, r) => ({ db: payReturn(db, r.id) }),
        },
        {
          label: 'Reset to Draft',
          when: (r) => ['reviewed', 'submitted'].includes(r.state),
          run: (db, r) => ({ db: resetReturnToDraft(db, r.id) }),
        },
      ],
      chatter: true,
    },
  },
};
