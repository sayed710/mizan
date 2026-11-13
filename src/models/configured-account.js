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
 * and it must belong to the record's company and allow its currency. `next` and `prior` are { id, companyId, currencyId };
 * an unchanged selection on an unchanged company and currency is not re-checked, so later edits to the method never
 * block payments or other writes on records that already use it.
 */
export function cashRoundingError(db, next, prior = null) {
  const { id, companyId, currencyId } = next;
  if (!id) return null;
  if (id === prior?.id && companyId === prior?.companyId && currencyId === prior?.currencyId) return null;
  const rounding = read(db, 'account.cash.rounding', id);
  if (id !== prior?.id && (!rounding || rounding.active === false)) return 'Select an active cash rounding method';
  if (rounding?.company_id && rounding.company_id !== (companyId ?? 1)) return 'The cash rounding method belongs to another company';
  if (rounding && !cashRoundingApplies(rounding, companyId, currencyId)) return 'The cash rounding method does not apply to this currency';
  return null;
}
