import { findCompanyCurrencyRecord, formatCurrency } from '../money.js';
import { journalAudit, journalAuditTotals } from './journal_audit.js';

/** Complete, unfolded journal report rows shared by CSV and XLSX exports. */
export function journalAuditExportRows(db, { period = {}, companyId = 'all', sort = 'date', includeDraft = false, includePayments = true, translate = (s) => s } = {}) {
  const groups = journalAudit(db, { ...period, companyId: companyId === 'all' ? null : Number(companyId), sort, includeDraft, includePayments });
  const find = (model, id) => (db.records[model] ?? []).find((record) => record.id === id);
  const rows = [['Journal', 'Documents', 'To Review', 'Date', 'Number', 'Partner', 'Account', 'Label', 'Currency', 'Debit', 'Credit', 'Balance', 'Base', 'Tax Amount'].map(translate)];
  const { totals, companyTotals, multipleCurrencies, singleCurrency } = journalAuditTotals(db, groups);
  for (const group of groups) {
    const { journal, items, taxes, grids } = group;
    const groupCurrencies = new Set((group.company_totals ?? [{ company_id: group.split_company_id ?? journal.company_id ?? items[0]?.move?.company_id ?? 1 }]).map((ct) => findCompanyCurrencyRecord(db, ct.company_id)?.id ?? null));
    const groupMixed = groupCurrencies.size > 1;
    const groupCompanyId = group.split_company_id ?? group.company_totals?.[0]?.company_id ?? journal.company_id ?? items[0]?.move?.company_id ?? 1;
    const groupCurrency = !groupMixed ? findCompanyCurrencyRecord(db, groupCompanyId) : null;
    const splitCompany = group.split_company_id != null ? find('res.company', group.split_company_id) : null;
    const journalTitle = splitCompany
      ? `${journal.name} (${journal.code ?? ''}) — ${splitCompany.name}${groupCurrency?.name ? ` (${groupCurrency.name})` : ''}`
      : `${journal.name} (${journal.code ?? ''})`;
    rows.push([
      journalTitle,
      group.count,
      group.to_review,
      '', '', '', '', '',
      groupCurrency ? groupCurrency.name : '',
      groupMixed ? '' : group.incomplete ? translate('Unavailable') : group.debit,
      groupMixed ? '' : group.incomplete ? translate('Unavailable') : group.credit,
      groupMixed ? '' : group.incomplete ? translate('Unavailable') : group.balance,
      '', '',
    ]);
    for (const { move, line, date } of items) {
      const account = find('account.account', line.account_id);
      const company = find('res.company', move.company_id ?? 1);
      const currency = line.currency_id && line.currency_id !== company?.currency_id && line.amount_currency != null
        ? formatCurrency(line.amount_currency, find('res.currency', line.currency_id)) : '';
      rows.push(['', '', '', date, move.name ?? '', find('res.partner', line.partner_id ?? move.partner_id)?.name ?? '', account ? `${account.code} ${account.name}` : '', line.name ?? '', currency, Number(line.debit) || 0, Number(line.credit) || 0, '', '', '']);
    }
    for (const { move, date, error } of group.incomplete_moves ?? []) {
      rows.push([
        '', '', '',
        date,
        move.name || '/',
        find('res.partner', move.partner_id)?.name ?? '',
        '',
        `${translate('Incomplete')}: ${translate(error)}`,
        '', '', '', '', '', '',
      ]);
    }
    if (!groupMixed && taxes.length) {
      rows.push([translate('Tax Summary')]);
      for (const tax of taxes) rows.push(['', '', '', '', '', '', '', tax.name, '', '', '', '', tax.base, tax.tax]);
    }
    if (!groupMixed && grids.length) {
      rows.push([translate('Tax Grids')]);
      for (const grid of grids) rows.push(['', '', '', '', '', '', '', grid.name, '', '', '', grid.amount, '', '']);
    }
  }
  if (multipleCurrencies) {
    for (const ct of companyTotals) {
      const label = `${translate('Total')} - ${ct.company?.name ?? ct.company_id}${ct.currency?.name ? ` (${ct.currency.name})` : ''}`;
      rows.push([
        label,
        ct.count,
        ct.to_review,
        '', '', '', '', '',
        ct.currency?.name ?? '',
        ct.incomplete ? translate('Unavailable') : ct.debit,
        ct.incomplete ? translate('Unavailable') : ct.credit,
        ct.incomplete ? translate('Unavailable') : ct.balance,
        '', '',
      ]);
    }
    rows.push([translate('Total'), totals.count, totals.to_review, '', '', '', '', '', '', '', '', '', '', '']);
  } else {
    rows.push([
      translate('Total'),
      totals.count,
      totals.to_review,
      '', '', '', '', '',
      singleCurrency?.name ?? '',
      totals.incomplete ? translate('Unavailable') : totals.debit,
      totals.incomplete ? translate('Unavailable') : totals.credit,
      totals.incomplete ? translate('Unavailable') : totals.balance,
      '', '',
    ]);
  }
  return { rows, columnTypes: ['text', 'number', 'number', 'text', 'text', 'text', 'text', 'text', 'text', 'number', 'number', 'number', 'number', 'number'] };
}
