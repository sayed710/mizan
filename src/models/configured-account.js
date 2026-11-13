import { read } from '../orm.js';

/** Resolve an explicit account setting without interpreting its chart code. */
export function configuredAccount(db, id, company, role, owner, { allowArchived = false } = {}) {
  const account = Number.isInteger(id) && read(db, 'account.account', id);
  if (!account || (!allowArchived && account.active === false)) throw new Error(`Configure the ${role} account on ${owner}`);
  if (account.company_id && account.company_id !== (company ?? 1)) throw new Error(`The ${role} account on ${owner} belongs to another company`);
  return account.id;
}

export function roundingAccount(db, rounding, profit, company) {
  if (rounding?.company_id && rounding.company_id !== (company ?? 1)) throw new Error('The cash rounding method belongs to another company');
  const role = profit ? 'profit' : 'loss';
  return configuredAccount(db, rounding?.[`${role}_account_id`], company, role, rounding?.name ?? 'the cash rounding method');
}

/** Whether a cash rounding method may be used by a document of this company and currency (empty conditions apply everywhere). */
export function cashRoundingApplies(rounding, companyId, currencyId) {
  if (rounding?.company_id && rounding.company_id !== (companyId ?? 1)) return false;
  const currencies = rounding?.currency_ids ?? [];
  return !currencies.length || !currencyId || currencies.includes(currencyId);
}

/**
 * Reject a cash rounding method a document or POS config cannot use: a newly selected method must exist and be active,
 * and any selected method must belong to the record's company and allow its currency.
 */
export function cashRoundingError(db, id, priorId, companyId, currencyId) {
  if (!id) return null;
  const rounding = read(db, 'account.cash.rounding', id);
  if (id !== priorId && (!rounding || rounding.active === false)) return 'Select an active cash rounding method';
  if (rounding?.company_id && rounding.company_id !== (companyId ?? 1)) return 'The cash rounding method belongs to another company';
  if (rounding && !cashRoundingApplies(rounding, companyId, currencyId)) return 'The cash rounding method does not apply to this currency';
  return null;
}
