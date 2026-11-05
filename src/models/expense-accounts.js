import { read } from '../orm.js';
import { round } from '../money.js';
import { productProperty } from './productconfig-helpers.js';
import { taxRepartitionLine, taxRepartitionSplits, taxRowsFactor } from './taxes.js';

export function expenseReportJournal(db, report) {
  const company = report.company_id ?? 1;
  const journal = read(db, 'account.journal', report.expense_journal_id ?? read(db, 'res.company', company)?.default_general_journal_id);
  if (!journal || (journal.company_id && journal.company_id !== company) || !['general', 'purchase'].includes(journal.type)) {
    throw new Error('Select a general or purchase expense journal, or configure a default general journal for this company');
  }
  return journal;
}

/** Resolve each expense's debit accounts from its configured product, journal and tax. */
export function expenseDebits(db, report, expenses, postingJournal = null) {
  const company = report.company_id ?? 1;
  const journalId = report.expense_journal_id ?? read(db, 'res.company', company)?.default_purchase_journal_id ?? postingJournal?.id;
  const journal = read(db, 'account.journal', journalId);
  if (!journal || (journal.company_id && journal.company_id !== company)) throw new Error('Configure an expense journal for this company');
  return expenses.flatMap((line) => {
    const product = read(db, 'product', line.product_id);
    const account = read(db, 'account.account', productProperty(db, product, 'property_account_expense_id') ?? journal.default_account_id);
    if (!account || account.active === false || (account.company_id && account.company_id !== company)) throw new Error('Configure the expense account on the product, category or expense journal');
    const tax = Number(line.tax) && line.tax_id ? read(db, 'account.tax', line.tax_id) : null;
    if (Number(line.tax) && !tax) throw new Error(`Configure the expense tax on ${line.name || 'the expense'}`);
    if (tax && (tax.type_tax_use !== 'purchase' || tax.amount_type !== 'percent' || Number(tax.amount) !== Number(line.tax) || (tax.company_id && tax.company_id !== company))) throw new Error('Configure the expense tax and its account');
    const factor = tax ? taxRowsFactor(tax, 'invoice') : 0;
    const total = round(Number(line.total_amount) || 0);
    const rate = Number(line.tax) || 0;
    let base;
    let taxAmount;
    if (factor === 0) {
      base = total;
      taxAmount = round(base * rate / 100);
    } else {
      base = round(total / (1 + rate * factor / 100));
      const netTax = round(total - base);
      taxAmount = netTax / factor;
    }
    const splits = tax ? taxRepartitionSplits({ ...tax, amount: taxAmount, base }, {}, 'invoice', null).splits : [];
    if (tax && factor !== 0) {
      const splitSum = round(splits.reduce((sum, s) => sum + s.amount, 0));
      if (round(base + splitSum - total) !== 0) {
        base = round(total - splitSum);
      }
    }
    const taxLines = splits.map(({ row, amount, base: taxBase }) => {
      const taxAccount = read(db, 'account.account', row.account_id ?? account.id);
      if (!taxAccount || taxAccount.active === false || (taxAccount.company_id && taxAccount.company_id !== company)) throw new Error('Configure the expense tax and its account');
      return { account: taxAccount.id, debit: Math.max(amount, 0), credit: Math.max(-amount, 0), tax_id: tax.id, tax_name: tax.name, tax_side: 'purchase', tax_base: taxBase, tax_tag_ids: row.tag_ids ?? [] };
    });
    const baseTags = taxRepartitionLine(tax, 'invoice', 'base')?.tag_ids ?? [];
    return [{
      account: account.id,
      debit: base,
      ...(baseTags.length ? { tax_tag_ids: baseTags, tax_grid_base: true } : {}),
      ...(line.product_id ? { product_id: line.product_id } : {}),
      ...(line.analytic_distribution != null ? { analytic_distribution: line.analytic_distribution } : (line.analytic_account_id ? { analytic_account_id: line.analytic_account_id } : {})),
    }, ...taxLines];
  });
}
