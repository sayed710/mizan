import { read } from '../orm.js';

/** Resolve a company's configured exchange account, or its standard account code. */
export function exchangeAccount(db, companyId, difference) {
  const company = read(db, 'res.company', companyId ?? 1);
  const field = difference > 0 ? 'income_currency_exchange_account_id' : 'expense_currency_exchange_account_id';
  const configured = company?.[field];
  if (configured) {
    const account = read(db, 'account.account', configured);
    if (!account || (account.company_id && account.company_id !== (companyId ?? 1))) throw new Error('Exchange account must belong to the document company');
  }
  return configured || (difference > 0 ? '450100' : '690100');
}
