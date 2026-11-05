import { createElement } from 'react';
import { companyCurrencyRecord } from '../money.js';

/** Resolve the explicit currency configured on a budget's company. */
export function budgetCurrency(db, companyId) {
  if (!companyId) throw new Error('Select a company for this budget before showing amounts');
  return companyCurrencyRecord(db, companyId);
}

/** Render every budget amount through the shared money formatter with its company's currency. */
export function BudgetMoneyCell({ value, currency, money }) {
  if (!currency) throw new Error('Configure a company currency before showing budget amounts');
  return createElement('td', { className: 'num' }, money(value, currency.name, currency));
}
