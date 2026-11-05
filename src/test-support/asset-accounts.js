import { accountId } from '../models/ledger.js';

export function assetAccounts(db, company = 1) {
  return {
    account_asset_id: accountId(db, '151000', company),
    account_depreciation_id: accountId(db, '152000', company),
    account_depreciation_expense_id: accountId(db, '680000', company),
  };
}
