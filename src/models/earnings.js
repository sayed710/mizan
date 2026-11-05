import { read } from '../orm.js';

/** The company's configured current-year earnings equity account, or null when it is not (validly) set. */
export function configuredEarningsAccount(db, companyId) {
  const company = read(db, 'res.company', companyId);
  const account = company?.current_year_earnings_account_id && read(db, 'account.account', company.current_year_earnings_account_id);
  return account && (!account.company_id || account.company_id === companyId) && ['equity', 'equity_unaffected'].includes(account.account_type) ? account : null;
}

export function currentYearEarningsAccount(db, companyId) {
  const account = configuredEarningsAccount(db, companyId);
  if (!account) throw new Error(`Configure a current-year earnings equity account for company ${read(db, 'res.company', companyId)?.name ?? companyId}`);
  return account;
}
