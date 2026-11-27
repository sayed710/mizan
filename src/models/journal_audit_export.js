import { formatCurrency, round } from '../money.js';
import { journalAudit } from './journal_audit.js';

/** Complete, unfolded journal report rows shared by CSV and XLSX exports. */
export function journalAuditExportRows(db, { period = {}, companyId = 'all', sort = 'date', includeDraft = false, includePayments = true, translate = (s) => s } = {}) {
  const groups = journalAudit(db, { ...period, companyId: companyId === 'all' ? null : Number(companyId), sort, includeDraft, includePayments });
  const find = (model, id) => (db.records[model] ?? []).find((record) => record.id === id);
  const rows = [['Journal', 'Documents', 'To Review', 'Date', 'Number', 'Partner', 'Account', 'Label', 'Currency', 'Debit', 'Credit', 'Balance', 'Base', 'Tax Amount'].map(translate)];
  const totals = { count: 0, to_review: 0, debit: 0, credit: 0, balance: 0 };
  for (const group of groups) {
    const { journal, items, taxes, grids } = group;
    rows.push([`${journal.name} (${journal.code ?? ''})`, group.count, group.to_review, '', '', '', '', '', '', group.debit, group.credit, group.balance, '', '']);
    for (const { move, line, date } of items) {
      const account = find('account.account', line.account_id);
      const company = find('res.company', move.company_id ?? 1);
      const currency = line.currency_id && line.currency_id !== company?.currency_id && line.amount_currency != null
        ? formatCurrency(line.amount_currency, find('res.currency', line.currency_id)) : '';
      rows.push(['', '', '', date, move.name ?? '', find('res.partner', line.partner_id ?? move.partner_id)?.name ?? '', account ? `${account.code} ${account.name}` : '', line.name ?? '', currency, Number(line.debit) || 0, Number(line.credit) || 0, '', '', '']);
    }
    if (taxes.length) rows.push([translate('Tax Summary')]);
    for (const tax of taxes) rows.push(['', '', '', '', '', '', '', tax.name, '', '', '', '', tax.base, tax.tax]);
    if (grids.length) rows.push([translate('Tax Grids')]);
    for (const grid of grids) rows.push(['', '', '', '', '', '', '', grid.name, '', '', '', grid.amount, '', '']);
    for (const key of Object.keys(totals)) totals[key] = round(totals[key] + group[key]);
  }
  rows.push([translate('Total'), totals.count, totals.to_review, '', '', '', '', '', '', totals.debit, totals.credit, totals.balance, '', '']);
  return { rows, columnTypes: ['text', 'number', 'number', 'text', 'text', 'text', 'text', 'text', 'text', 'number', 'number', 'number', 'number', 'number'] };
}
