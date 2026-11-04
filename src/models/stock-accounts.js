import { read } from '../orm.js';
import { productProperty } from './productconfig-helpers.js';

export const STOCK_CHART_ROLES = {
  account_stock_valuation_id: ['110100', 'asset_current', 'Stock Valuation'],
  account_stock_input_id: ['110200', 'asset_current', 'Stock Interim (Received)'],
  account_stock_output_id: ['110200', 'asset_current', 'Stock Interim (Received)'],
  account_cogs_id: ['500000', 'expense_direct_cost', 'Cost of Goods Sold'],
  account_price_difference_id: ['600000', 'expense', 'Expenses'],
  account_production_id: ['600000', 'expense', 'Expenses'],
};

const ROLES = {
  valuation: ['property_stock_valuation_account_id', 'account_stock_valuation_id', 'stock valuation'],
  input: ['property_stock_account_input_categ_id', 'account_stock_input_id', 'stock input'],
  output: ['property_stock_account_output_categ_id', 'account_stock_output_id', 'stock output'],
  cogs: ['property_account_expense_categ_id', 'account_cogs_id', 'cost of goods sold'],
  price_difference: ['property_account_creditor_price_difference_categ', 'account_price_difference_id', 'price difference'],
  production: [null, 'account_production_id', 'production cost'],
};

export function stockAccount(db, p, role, companyId = 1) {
  const [property, field, label] = ROLES[role];
  const company = read(db, 'res.company', companyId);
  const id = (property && productProperty(db, { categ_id: p?.categ_id }, property, companyId)) || company?.[field];
  const category = read(db, 'product.category', p?.categ_id);
  const message = `Configure the ${label} account on category ${category?.name ?? '(none)'} or company ${company?.name ?? companyId}`;
  if (!id) throw new Error(message);
  const account = read(db, 'account.account', id);
  if (!account || account.active === false) throw new Error(`${message}: configured account is missing or archived`);
  if (account.company_id && account.company_id !== companyId) throw new Error(`${message}: account belongs to another company`);
  return account.id;
}
