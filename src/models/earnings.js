import { read } from '../orm.js';

export function currentYearEarningsAccount(db, companyId) {
  const company = read(db, 'res.company', companyId);
  const account = company?.current_year_earnings_account_id && read(db, 'account.account', company.current_year_earnings_account_id);
  if (!account || (account.company_id && account.company_id !== companyId) || !['equity', 'equity_unaffected'].includes(account.account_type)) {
    throw new Error(`Configure a current-year earnings equity account for company ${company?.name ?? companyId}`);
  }
  return account;
}
