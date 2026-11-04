import { read } from '../orm.js';
import { round } from '../money.js';
import { productProperty } from './productconfig-helpers.js';
import { taxRepartitionLine } from './taxes.js';

/** Resolve each expense's debit accounts from its configured product, journal and tax. */
export function expenseDebits(db, report, expenses) {
  const company = report.company_id ?? 1;
  const journal = read(db, 'account.journal', report.expense_journal_id ?? read(db, 'res.company', company)?.default_purchase_journal_id);
  if (!journal || (journal.company_id && journal.company_id !== company)) throw new Error('Configure an expense journal for this company');
  return expenses.flatMap((line) => {
    const product = read(db, 'product', line.product_id);
    const account = read(db, 'account.account', productProperty(db, product, 'property_account_expense_id') ?? journal.default_account_id);
    if (!account || account.active === false || (account.company_id && account.company_id !== company)) throw new Error('Configure the expense account on the product, category or expense journal');
    const taxAmount = round(Number(line.total_amount) - Number(line.total_amount) / (1 + Number(line.tax ?? 0) / 100));
    const tax = taxAmount ? read(db, 'account.tax', line.tax_id) : null;
    const taxAccount = tax && read(db, 'account.account', taxRepartitionLine(tax)?.account_id);
    if (taxAmount && (!tax || tax.type_tax_use !== 'purchase' || tax.amount_type !== 'percent' || Number(tax.amount) !== Number(line.tax) || !taxAccount || taxAccount.active === false || (tax.company_id && tax.company_id !== company) || (taxAccount.company_id && taxAccount.company_id !== company))) throw new Error('Configure the expense tax and its account');
    const base = round(Number(line.total_amount) - taxAmount);
    return [{ account: account.id, debit: base }, ...(taxAmount ? [{ account: taxAccount.id, debit: taxAmount, tax_name: tax.name, tax_side: 'purchase', tax_base: base }] : [])];
  });
}
