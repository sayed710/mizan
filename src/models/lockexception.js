// Account Lock Exception (Odoo 17+ parity: JE-15).
import { create, read, search, write } from '../orm.js';
import { validDate } from './common.js';
import { currentActor, employeeFor } from './actor.js';

export const LOCK_EXCEPTION_FIELDS = [
  ['global', 'Global Lock Date'],
  ['tax', 'Tax Return Lock Date'],
  ['sale', 'Sales Lock Date'],
  ['purchase', 'Purchase Lock Date'],
];

export const LOCK_EXCEPTION_TARGET = {
  global: 'lock_date',
  tax: 'tax_lock_date',
  sale: 'sale_lock_date',
  purchase: 'purchase_lock_date',
};

/**
 * Resolve the acting user login from sync ctx (server) or current client actor.
 */
export const lockActorLogin = (ctx) => ctx?.login ?? currentActor()?.login ?? null;

/**
 * Check whether the given context belongs to an accounting manager or admin.
 * Follows the codebase convention: !ctx || ctx.isAdmin !== false.
 */
export const isAccountingManager = (ctx) => !ctx || ctx.isAdmin !== false;

/**
 * State computed from end_datetime and revoked status: active, revoked, or expired.
 */
export function exceptionState(r, now = new Date()) {
  if (!r) return 'expired';
  if (r.revoked) return 'revoked';
  if (r.end_datetime) {
    const end = new Date(r.end_datetime).getTime();
    const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isNaN(end) && !Number.isNaN(current) && end < current) return 'expired';
  }
  return 'active';
}

/**
 * Match exception against acting user. Empty user_id = everyone.
 * Matched ONLY by employeeFor(db, login).id === exception.user_id.
 */
export function matchesUser(db, exception, ctx = null) {
  if (!exception.user_id) return true;
  const login = lockActorLogin(ctx);
  if (!login) return false;
  const employee = employeeFor(db, login);
  return employee?.id === exception.user_id;
}

/**
 * Return active lock exceptions for a company and user context.
 */
export function activeLockExceptions(db, companyId, ctx = null, now = new Date()) {
  return search(db, 'account.lock_exception').filter((ex) => {
    if ((ex.company_id ?? 1) !== (companyId ?? 1)) return false;
    if (exceptionState(ex, now) !== 'active') return false;
    return matchesUser(db, ex, ctx);
  });
}

/**
 * Return a copy of company with its lock dates replaced by active exceptions for the acting user.
 * Hard lock date is never relaxed.
 */
export function effectiveCompanyLockDates(company, db, ctx = null, now = new Date()) {
  if (!company || !db) return company;
  const active = activeLockExceptions(db, company.id ?? 1, ctx, now);
  if (!active.length) return company;

  const result = { ...company };
  for (const ex of active) {
    const field = LOCK_EXCEPTION_TARGET[ex.lock_field];
    if (!field || !ex.lock_date) continue;
    if (result[field] == null || ex.lock_date < result[field]) {
      result[field] = ex.lock_date;
    }
  }
  return result;
}

/**
 * Server-side guard for account.lock_exception.
 */
export function lockExceptionGuard(db, before, after, ctx) {
  if (!isAccountingManager(ctx)) {
    return 'Only accounting managers create or revoke exceptions';
  }

  if (after.company_id && !read(db, 'res.company', after.company_id)) {
    return 'Select an existing company';
  }

  const targetField = LOCK_EXCEPTION_TARGET[after.lock_field];
  if (!targetField) {
    return 'Select a lock date field';
  }

  if (!after.lock_date || !validDate(after.lock_date)) {
    return 'Enter a valid exception lock date';
  }

  if (!after.end_datetime || !validDate(String(after.end_datetime).slice(0, 10))) {
    return 'Enter a valid expiry date';
  }

  const company = read(db, 'res.company', after.company_id ?? 1);
  if (company && !before) {
    const currentLock = company[targetField] ?? null;
    if (currentLock && after.lock_date >= currentLock) {
      return 'The exception date must be earlier than the current lock date';
    }
  }

  if (before?.revoked && !after.revoked) {
    return 'Revoked exceptions cannot be reactivated';
  }

  return null;
}

/**
 * Plain create for account.lock_exception. The guard validates for ORM and sync.
 */
export function createLockException(db, vals) {
  return create(db, 'account.lock_exception', {
    company_id: vals.company_id ?? 1,
    user_id: vals.user_id || null,
    lock_field: vals.lock_field,
    lock_date: vals.lock_date,
    end_datetime: vals.end_datetime,
    reason: vals.reason ?? '',
    revoked: false,
  }).db;
}

/**
 * Revoke an existing lock exception.
 */
export function revokeLockException(db, id) {
  const ex = read(db, 'account.lock_exception', id);
  if (!ex) throw new Error('Record not found');
  return write(db, 'account.lock_exception', id, { revoked: true });
}

export const lockExceptionModels = {
  'account.lock_exception': {
    label: 'Lock Date Exception',
    fields: {
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', required: true },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'User' },
      lock_field: {
        type: 'selection',
        label: 'Field',
        required: true,
        options: LOCK_EXCEPTION_FIELDS,
      },
      lock_date: { type: 'date', label: 'Exception Lock Date', required: true },
      end_datetime: { type: 'datetime', label: 'Expiry Date', required: true },
      reason: { type: 'char', label: 'Reason' },
      revoked: { type: 'boolean', label: 'Revoked', default: false },
      state: {
        type: 'selection',
        label: 'Status',
        readonly: true,
        compute: (r) => exceptionState(r),
        options: [
          ['active', 'Active'],
          ['revoked', 'Revoked'],
          ['expired', 'Expired'],
        ],
      },
    },
    defaults: () => ({
      user_id: null,
      revoked: false,
    }),
    guard: lockExceptionGuard,
    list: ['company_id', 'user_id', 'lock_field', 'lock_date', 'end_datetime', 'reason', 'state'],
    searchFields: ['reason', 'lock_field'],
  },
};
