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

/** Reject selecting an archived or missing cash rounding method when creating or changing a document or POS config. */
export function activeCashRoundingError(db, id, priorId = null) {
  if (!id || id === priorId) return null;
  const rounding = read(db, 'account.cash.rounding', id);
  return !rounding || rounding.active === false ? 'Select an active cash rounding method' : null;
}
