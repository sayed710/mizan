// Tax Returns and Return Types (Odoo 20 parity).
import { create, getActiveCompany, read, search, updateSettings, write } from '../orm.js';
import { round } from '../money.js';
import { addDays, today } from './common.js';
import { postPayment } from './pay.js';
import { moveDate, postTaxReturnClosing, returnCompanies, returnTaxLock, taxClosingMatchesReturn, taxClosingSpec, taxReport, taxUnitMemberTypeValidation, validateTaxReturnPeriod } from './finance.js';
import { checkInalterability } from './hash_chain.js';

/** The tax lock follows the latest submitted or paid return. */
const syncTaxLockDate = (db, ret, excludeId = null) => {
  const dates = { ...db.settings?.tax_lock_dates };
  for (const companyId of returnCompanies(db, ret)) dates[companyId] = returnTaxLock(db, companyId, excludeId) || null;
  return updateSettings(db, { tax_lock_dates: dates });
};

/** Determine if a return is an audit working file rather than a standard tax return. */
/** A working file being created or edited: audit by status, category or type. */
const isNewAudit = (db, vals) => (vals?.type_id ? isAuditReturn(vals, db) : Boolean(vals?.audit_status || vals?.category === 'audit'));
const returnCompany = (db, vals) => Number(vals?.company_id ?? getActiveCompany() ?? db.settings?.current_company_id ?? 1);

export function isAuditReturn(r, db) {
  return !!(r?.type_id && db && read(db, 'account.return.type', r.type_id)?.category === 'audit');
}

// A new working-file form has no persisted type until its first save.
const auditForm = (r, db, context) => isAuditReturn(r, db)
  || (!!context?.isNew && context.leaf?.key === 'working-files' && !r?.type_id);

/** Compute audit verification checks for an audit return. */
export function computeAuditChecks(db, ret) {
  const companyId = ret?.company_id ?? 1;
  const from = ret?.date_from;
  const to = ret?.date_to;
  const checks = [];

  // 1. Draft entries check
  const drafts = search(db, 'account.move').filter(
    (m) => m.state === 'draft'
      && (!from || (m.invoice_date ?? m.date) >= from)
      && (!to || (m.invoice_date ?? m.date) <= to)
      && (!companyId || (m.company_id ?? 1) === companyId),
  );
  checks.push({
    name: 'Draft Entries',
    status: drafts.length === 0 ? 'passed' : 'warning',
    message: drafts.length === 0 ? 'No draft entries in the period' : `${drafts.length} draft entries found`,
  });

  // 2. Balanced journal entries check
  const postedMoves = search(db, 'account.move').filter(
    (m) => m.state === 'posted'
      && (!from || (m.invoice_date ?? m.date) >= from)
      && (!to || (m.invoice_date ?? m.date) <= to)
      && (!companyId || (m.company_id ?? 1) === companyId),
  );
  const unbalanced = postedMoves.filter((m) => {
    const sumDebit = (m.line_ids ?? []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const sumCredit = (m.line_ids ?? []).reduce((s, l) => s + (Number(l.credit) || 0), 0);
    return round(sumDebit - sumCredit) !== 0;
  });
  checks.push({
    name: 'Balanced Entries',
    status: unbalanced.length === 0 ? 'passed' : 'failed',
    message: unbalanced.length === 0 ? 'All journal entries are balanced' : `${unbalanced.length} unbalanced entries found`,
  });

  // 3. Inalterability hash chain check
  const inalt = checkInalterability(db, { companyId });
  const corrupted = inalt.filter((r) => r.status !== 'ok');
  checks.push({
    name: 'Data Inalterability',
    status: corrupted.length === 0 ? 'passed' : 'failed',
    message: corrupted.length === 0 ? 'All journal hash chains are valid' : `Hash chain issues in ${corrupted.map((c) => c.journal_name).join(', ')}`,
  });

  return checks;
}

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
    } else {
      const made = create(next, 'account.return.type', {
        name: 'VAT Return',
        category: 'account_return',
        states_workflow: 'generic_state_review_submit',
        deadline_periodicity: periodicity,
        deadline_start_date: startDate,
        deadline_days_delay: 20,
        auto_generate: true,
        company_id: company.id,
      });
      next = made.db;
    }
  }

  return next;
}

/** Ensure an audit return type exists for the given company. */
export function ensureAuditReturnType(db, companyId = 1) {
  const currentTypes = db.records?.['account.return.type'] ?? [];
  const existingAudit = currentTypes.find((t) => (t.company_id ?? 1) === companyId && t.category === 'audit');
  if (existingAudit) return { db, typeId: existingAudit.id };
  const made = create(db, 'account.return.type', {
    name: 'Audit File',
    category: 'audit',
    states_workflow: 'generic_state_review_submit',
    deadline_periodicity: 'year',
    deadline_days_delay: 0,
    auto_generate: false,
    company_id: companyId,
  });
  return { db: made.db, typeId: made.id };
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

    const isAudit = type.category === 'audit';
    const rep = isAudit ? { payable: 0 } : taxReport(nextDb, { from: p.from, to: p.to, company_id: companyId });
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
      ...(isAudit ? { audit_status: 'ongoing' } : {}),
      date_deadline: deadline,
      date_lock: null,
      date_submission: null,
      total_amount_to_pay: toPay,
      closing_move_ids: [],
      is_completed: false,
      attachment_ids: [],
      ...(isAudit ? { checks: computeAuditChecks(nextDb, { date_from: p.from, date_to: p.to, company_id: companyId }) } : {}),
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
  const moveIds = closing.ids;
  const finalPayable = closing.payable;

  nextDb = write(nextDb, 'account.return', currentRet.id, {
    state: 'submitted',
    date_lock: currentRet.date_to,
    date_submission: today(),
    total_amount_to_pay: finalPayable,
    closing_move_ids: moveIds,
    is_completed: false,
  });

  return syncTaxLockDate(nextDb, currentRet);
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

  let nextDb = db;
  const paymentIds = [];
  const specs = returnCompanies(db, ret).map((companyId) => ({ companyId, spec: taxClosingSpec(db, ret, companyId) }));

  for (const { companyId, spec } of specs) {
    if (!spec.payable) continue;
    const inbound = spec.payable < 0;
    const targetAccount = inbound ? spec.receivableAccount : spec.payableAccount;
    const created = create(nextDb, 'account.payment', {
      partner_id: spec.partner,
      partner_type: 'supplier',
      payment_type: inbound ? 'inbound' : 'outbound',
      amount: Math.abs(spec.payable),
      date: today(),
      memo: inbound ? `Tax Return Refund: ${ret.name}` : `Tax Return Payment: ${ret.name}`,
      company_id: companyId,
      state: 'draft',
      destination_account_id: targetAccount.id,
      destination_account_code: targetAccount.code,
      is_tax_payment: true,
      return_id: ret.id,
    });
    paymentIds.push(created.id);
    nextDb = postPayment(created.db, read(created.db, 'account.payment', created.id));
  }

  const mainPaymentId = paymentIds.find((id) => (read(nextDb, 'account.payment', id)?.company_id ?? 1) === (ret.company_id ?? 1)) ?? paymentIds[0] ?? null;
  return syncTaxLockDate(write(nextDb, 'account.return', ret.id, {
    state: 'paid',
    is_completed: true,
    ...(mainPaymentId ? { payment_id: mainPaymentId } : {}),
    payment_ids: paymentIds,
  }), ret);
}

/** Reset to draft: cancels closing move and unlocks period, forbidden after pay. */
export function resetReturnToDraft(db, returnId) {
  const ret = read(db, 'account.return', returnId);
  if (!ret) throw new Error('Tax return not found');
  if (ret.state === 'paid') {
    throw new Error('Paid returns cannot be reset to draft');
  }

  let nextDb = syncTaxLockDate(db, ret, ret.id);

  // Cancel closing moves after removing this return's tax lock.
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
  });

  return syncTaxLockDate(nextDb, ret);
}

function taxPaymentsMatchReturn(db, after) {
  if (!after.is_completed || !taxClosingMatchesReturn(db, after)) return false;
  const staged = { ...db, records: { ...db.records, 'account.return': (db.records['account.return'] ?? []).map((r) => r.id === after.id ? after : r) } };
  const ids = after.payment_ids?.length ? after.payment_ids : (after.payment_id ? [after.payment_id] : []);
  if ((after.payment_id && !ids.includes(after.payment_id)) || new Set(ids).size !== ids.length) return false;
  const payments = ids.map((id) => read(db, 'account.payment', id));
  if (payments.some((p) => !p || p.state !== 'posted' || !p.is_tax_payment || p.return_id !== after.id)) return false;
  let required = 0;
  for (const companyId of returnCompanies(staged, after)) {
    const spec = taxClosingSpec(staged, after, companyId);
    if (!spec.payable) continue;
    required += 1;
    const payment = payments.find((p) => (p.company_id ?? 1) === companyId);
    const closing = (after.closing_move_ids ?? []).map((id) => read(db, 'account.move', id)).find((m) => (m?.company_id ?? 1) === companyId);
    if (!payment || !closing || payment.payment_type !== (spec.payable < 0 ? 'inbound' : 'outbound')
      || round(Number(payment.amount) || 0) !== Math.abs(spec.payable)
      || !(closing.payments ?? []).some((p) => !p.reversed && p.move_id === payment.move_id && round(Number(p.amount) || 0) === Math.abs(spec.payable))) {
      return false;
    }
  }
  return ids.length === required;
}

function returnGuard(db, before, after) {
  const isAudit = isAuditReturn(after, db);
  if (before && isAuditReturn(before, db) !== isAudit) return 'Cannot change a return between tax and audit workflows';
  if (!isAudit && after.audit_status != null) return 'Audit status requires an audit return type';
  if (!isAudit && after.tax_unit_id) {
    try {
      returnCompanies(db, after);
      const unit = read(db, 'account.tax.unit', after.tax_unit_id);
      const mainType = read(db, 'account.return.type', after.type_id);
      const { error } = taxUnitMemberTypeValidation(db, unit, mainType ? [mainType] : []);
      if (error) return error;
    } catch (error) { return error.message; }
  }
  if (isAudit) {
    if (before?.audit_status === 'done') {
      const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
      if (!['done', 'ongoing'].includes(after.audit_status)
        || [...fields].some((k) => k !== 'audit_status' && JSON.stringify(before[k]) !== JSON.stringify(after[k]))) {
        return 'Done audit files cannot be modified';
      }
    }
    if (after.audit_status && !['ongoing', 'paused', 'done'].includes(after.audit_status)) {
      return 'Invalid audit status';
    }
    return null;
  }
  if (before?.state === 'paid' && after.state !== 'paid') {
    return 'Paid returns cannot be reset to draft';
  }
  const transitions = { new: ['reviewed'], reviewed: ['new', 'submitted'], submitted: ['new', 'paid'], paid: [] };
  const directPay = before && ['new', 'reviewed'].includes(before.state) && after.state === 'paid'
    && read(db, 'account.return.type', after.type_id)?.states_workflow === 'generic_state_only_pay'
    && taxClosingMatchesReturn(db, after);
  if (!before && ['submitted', 'paid'].includes(after.state)) return 'Tax return transition is not allowed';
  if (before && before.state !== after.state && !transitions[before.state]?.includes(after.state) && !directPay) {
    return 'Tax return transition is not allowed';
  }
  if ((before?.state === 'reviewed' && after.state === 'submitted') || directPay) {
    if (!taxClosingMatchesReturn(db, after) || after.date_lock !== after.date_to || !after.date_submission) {
      return 'Tax return submission requires a posted linked closing move with matching amounts';
    }
  }
  if (directPay && !taxPaymentsMatchReturn(db, after)) {
    return 'Tax return payment requires a posted payment';
  }
  if (before && ['submitted', 'paid'].includes(before.state)) {
    const LOCKED = ['type_id', 'date_from', 'date_to', 'company_id', 'tax_unit_id', 'total_amount_to_pay', ...(before.state === 'paid' ? ['payment_id', 'payment_ids'] : [])];
    if (LOCKED.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))) {
      return 'Submitted or paid tax returns cannot be modified';
    }
    if (JSON.stringify(before.closing_move_ids ?? []) !== JSON.stringify(after.closing_move_ids ?? [])) {
      return 'Submitted or paid tax return closing links cannot be modified';
    }
    if (before.state === 'submitted' && after.state === 'new') {
      if ((before.closing_move_ids ?? []).some((id) => read(db, 'account.move', id)?.state !== 'cancel')) {
        return 'Tax return closing moves must be cancelled before reset';
      }
    } else if (before.state === 'submitted' && after.state === 'paid') {
      if (!taxPaymentsMatchReturn(db, after)) {
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
    prepareCreate: (db, vals) => {
      const companyId = returnCompany(db, vals);
      if (isAuditReturn(vals, db)) {
        vals = { ...vals, audit_status: vals?.audit_status || 'ongoing', company_id: companyId };
      }
      if (!isNewAudit(db, vals)) return { db, vals };
      if (vals.type_id) return { db, vals: { ...vals, company_id: companyId } };
      const ensured = ensureAuditReturnType(db, companyId);
      return { db: ensured.db, vals: { ...vals, company_id: companyId, type_id: ensured.typeId } };
    },
    fields: {
      name: { type: 'char', label: 'Return', required: true },
      // Working files (audit_status set) pick audit types, tax returns pick tax types, both in the record's company.
      type_id: { type: 'many2one', relation: 'account.return.type', label: 'Return Type', required: true, domain: (type, r) => (type.company_id ?? 1) === (r?.company_id ?? 1) && (type.category === 'audit') === Boolean(r?.audit_status) },
      date_from: { type: 'date', label: 'Start Date', required: true },
      date_to: { type: 'date', label: 'End Date', required: true },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      tax_unit_id: { type: 'many2one', relation: 'account.tax.unit', label: 'Tax Unit', domain: (unit, ret) => (unit.company_ids ?? []).includes(ret?.company_id ?? 1) },
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
      payment_ids: { type: 'many2many', relation: 'account.payment', label: 'Payments', readonly: true },
      is_completed: { type: 'boolean', label: 'Completed', readonly: true },
      attachment_ids: { type: 'many2many', relation: 'documents.document', label: 'Attachments' },
      audit_status: {
        type: 'selection',
        label: 'Audit Status',
        tracking: true,
        options: [
          ['ongoing', 'Ongoing'],
          ['paused', 'Paused'],
          ['done', 'Done'],
        ],
      },
      checks: {
        type: 'one2many',
        label: 'Checks',
        readonly: true,
        fields: {
          name: { type: 'char', label: 'Check' },
          status: { type: 'selection', label: 'Status', options: [['passed', 'Passed'], ['failed', 'Failed'], ['warning', 'Warning'], ['pending', 'Pending']] },
          message: { type: 'char', label: 'Details' },
        },
        newLine: () => ({ name: '', status: 'pending', message: '' }),
      },
    },
    defaults: () => ({
      state: 'new',
      is_completed: false,
      closing_move_ids: [],
      payment_ids: [],
      attachment_ids: [],
    }),
    createDefaults: (db, vals) => {
      const companyId = returnCompany(db, vals);
      if (isNewAudit(db, vals)) {
        let typeId = vals?.type_id;
        if (!typeId) {
          const auditType = (db.records?.['account.return.type'] ?? []).find(
            (t) => (t.company_id ?? 1) === companyId && t.category === 'audit',
          );
          if (auditType) typeId = auditType.id;
        }
        return {
          company_id: companyId,
          audit_status: vals?.audit_status || 'ongoing',
          ...(typeId ? { type_id: typeId } : {}),
          checks: (vals?.checks && vals.checks.length > 0) ? vals.checks : computeAuditChecks(db, { ...vals, company_id: companyId }),
        };
      }
      return { company_id: companyId };
    },
    // Audit checks follow the working file's period and company.
    onchange: (r, key, db) => {
      if (key === 'type_id') {
        const isAudit = isAuditReturn(r, db);
        return isAudit ? { audit_status: r.audit_status || 'ongoing' } : { audit_status: null };
      }
      const next = ['date_from', 'date_to', 'company_id'].includes(key) && isNewAudit(db, r) ? { checks: computeAuditChecks(db, r) } : {};
      if (key === 'company_id' && r.tax_unit_id && (!r.id || read(db, 'res.company', r.company_id))) {
        const unit = read(db, 'account.tax.unit', r.tax_unit_id);
        if (!unit || !(unit.company_ids ?? []).includes(r.company_id ?? 1)) next.tax_unit_id = null;
      }
      return next;
    },
    groupBys: ['type_id', 'state', 'company_id'],
    filters: [
      [
        { id: 'ongoing', label: 'Ongoing', fn: (r) => r.audit_status === 'ongoing' },
        { id: 'paused', label: 'Paused', fn: (r) => r.audit_status === 'paused' },
        { id: 'done', label: 'Done', fn: (r) => r.audit_status === 'done' },
      ],
      [
        { id: 'draft', label: 'Draft', fn: (r) => r.state === 'new' },
        { id: 'reviewed', label: 'Reviewed', fn: (r) => r.state === 'reviewed' },
        { id: 'submitted', label: 'Submitted', fn: (r) => r.state === 'submitted' },
        { id: 'paid', label: 'Paid', fn: (r) => r.state === 'paid' },
      ],
    ],
    list: ['name', 'type_id', 'date_from', 'date_to', 'date_deadline', 'total_amount_to_pay', 'state', 'audit_status'],
    kanban: { title: 'name', lines: ['date_from', 'date_to', 'total_amount_to_pay'], badge: 'state' },
    form: {
      statusbar: 'state',
      statusbarFor: (r, db, context) => (auditForm(r, db, context) ? 'audit_status' : 'state'),
      statusbarClickable: false,
      lockedWhen: (r, db) => (isAuditReturn(r, db) ? r?.audit_status === 'done' : ['submitted', 'paid'].includes(r?.state)),
      title: 'name',
      groups: (r, db, context) => (auditForm(r, db, context) ? [
        ['type_id', 'date_from', 'date_to', 'company_id'],
        ['audit_status', 'date_deadline'],
      ] : [
        ['type_id', 'date_from', 'date_to', 'company_id', 'tax_unit_id'],
        ['date_deadline', 'date_lock', 'date_submission', 'total_amount_to_pay', 'is_completed'],
      ]),
      tabs: (r, db, context) => (auditForm(r, db, context) ? [
        {
          label: 'Checks',
          fields: ['checks'],
        },
        {
          label: 'Attachments',
          fields: ['attachment_ids'],
        },
      ] : [
        {
          label: 'Tax Report',
          fields: [],
        },
        {
          label: 'Closing Moves',
          fields: ['closing_move_ids', 'attachment_ids'],
        },
      ]),
      buttons: [
        {
          label: 'Refresh Checks',
          when: (r, db) => isAuditReturn(r, db) && r.audit_status !== 'done',
          run: (db, r) => ({ db: write(db, 'account.return', r.id, { checks: computeAuditChecks(db, r) }) }),
        },
        {
          label: 'Pause',
          when: (r, db) => isAuditReturn(r, db) && r.audit_status === 'ongoing',
          run: (db, r) => ({ db: write(db, 'account.return', r.id, { audit_status: 'paused' }) }),
        },
        {
          label: 'Resume',
          when: (r, db) => isAuditReturn(r, db) && r.audit_status === 'paused',
          run: (db, r) => ({ db: write(db, 'account.return', r.id, { audit_status: 'ongoing' }) }),
        },
        {
          label: 'Mark as Done',
          primary: true,
          when: (r, db) => isAuditReturn(r, db) && r.audit_status !== 'done',
          run: (db, r) => ({ db: write(db, 'account.return', r.id, { audit_status: 'done', checks: computeAuditChecks(db, r) }) }),
        },
        {
          label: 'Review',
          primary: true,
          when: (r, db) => !isAuditReturn(r, db) && r.state === 'new' && (read(db, 'account.return.type', r.type_id)?.states_workflow ?? 'generic_state_review_submit') === 'generic_state_review_submit',
          run: (db, r) => ({ db: reviewReturn(db, r.id) }),
        },
        {
          label: 'Submit',
          primary: true,
          posts: true,
          when: (r, db) => !isAuditReturn(r, db) && (r.state === 'reviewed' || (r.state === 'new' && (read(db, 'account.return.type', r.type_id)?.states_workflow ?? 'generic_state_review_submit') !== 'generic_state_review_submit')),
          run: (db, r) => ({ db: submitReturn(db, r.id) }),
        },
        {
          label: 'Pay',
          primary: true,
          posts: true,
          when: (r, db) => !isAuditReturn(r, db) && (r.state === 'submitted' || (['new', 'reviewed'].includes(r.state) && read(db, 'account.return.type', r.type_id)?.states_workflow === 'generic_state_only_pay')),
          run: (db, r) => ({ db: payReturn(db, r.id) }),
        },
        {
          label: 'Reset to Draft',
          when: (r, db) => (isAuditReturn(r, db) ? r.audit_status === 'done' : ['reviewed', 'submitted'].includes(r.state)),
          run: (db, r) => ({ db: isAuditReturn(r, db) ? write(db, 'account.return', r.id, { audit_status: 'ongoing' }) : resetReturnToDraft(db, r.id) }),
        },
      ],
      chatter: true,
    },
  },
};
