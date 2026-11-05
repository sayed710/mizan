import { create, search, write } from '../orm.js';

export function configureRevaluationLoss(db) {
  let account = search(db, 'account.account').find((item) => item.code === '650100' && (item.company_id ?? 1) === 1);
  if (!account) {
    const made = create(db, 'account.account', { name: 'Exchange loss', code: '650100', account_type: 'expense_other', company_id: 1 });
    db = made.db;
    account = { id: made.id };
  }
  return write(db, 'res.company', 1, { expense_currency_exchange_account_id: account.id });
}
