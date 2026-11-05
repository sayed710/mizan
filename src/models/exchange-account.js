import { read } from '../orm.js';

/** Resolve a company's configured exchange account. */
export function exchangeAccount(db, companyId, difference) {
  const company = read(db, 'res.company', companyId ?? 1);
  const field = difference > 0 ? 'income_currency_exchange_account_id' : 'expense_currency_exchange_account_id';
  const configured = company?.[field];
  if (!configured) throw new Error(`Configure the exchange ${difference > 0 ? 'gain' : 'loss'} account on company ${company?.name ?? companyId ?? 1}`);
  if (configured) {
    const account = read(db, 'account.account', configured);
    if (!account || account.active === false || (account.company_id && account.company_id !== (companyId ?? 1))) throw new Error(`Configure the exchange ${difference > 0 ? 'gain' : 'loss'} account on company ${company?.name ?? companyId ?? 1}`);
  }
  return configured;
}
