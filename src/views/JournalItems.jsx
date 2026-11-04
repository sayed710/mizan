import { Fragment, useState } from 'react';
import { companyViewDb } from '../companyView.js';
import { journalItems } from '../models/ledger.js';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { money } from '../ui.jsx';
import { t } from '../i18n.js';
import { formatCurrency } from '../money.js';

export function JournalItems({ leaf = {} } = {}) {
  const db = companyViewDb(useDb());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const name = (model, id) => read(db, model, id)?.name ?? '';
  const mode = leaf.reviewMode ?? 'posted';
  const title = mode === 'unreconciled' ? 'Unreconciled' : mode === 'draft' ? 'Draft Entries' : 'Journal Items';
  const rows = journalItems(db, { from, to, reviewMode: mode }).map((line, index) => ({
    ...line, index,
    account: name('account.account', line.account_id),
    partner: name('res.partner', line.partner_id),
    journal: name('account.journal', line.journal_id),
    company: name('res.company', line.company_id),
  })).filter((line) => [line.move_name, line.name, line.account, line.partner, line.journal, line.company].some((value) => String(value ?? '').toLowerCase().includes(query.toLowerCase())));
  const groups = new Map();
  for (const line of rows) {
    const key = group ? line[`${group}_id`] ?? null : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{t(title)}</h1>
      <label>{t('From')} <input aria-label={t('From')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>{t('To')} <input aria-label={t('To')} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label>{t('Search')} <input aria-label={t('Search')} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <label>{t('Group By')} <select aria-label={t('Group By')} value={group} onChange={(e) => setGroup(e.target.value)}>
        <option value="">{t('None')}</option>{['account', 'partner', 'journal'].map((key) => <option key={key} value={key}>{t(key[0].toUpperCase() + key.slice(1))}</option>)}
      </select></label>
    </div>
    <div className="list-wrap"><table className="list report"><thead><tr>{['Date', 'Due Date', 'Entry', 'Account', 'Partner', 'Label', 'Debit', 'Credit', 'Amount in Currency', 'Matching', 'Company'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{[...groups.entries()].map(([key, lines]) => <Fragment key={key ?? 'none'}>
        {group && <tr><th colSpan={8}>{lines[0][group] || t('Undefined')}</th><th colSpan={3} /></tr>}
        {lines.map((line) => <tr key={`${line.move_id}-${line.index}`}>
          <td>{line.date}</td><td>{line.date_maturity ?? ''}</td><td><a href={`#/accounting/entries/${line.move_id}`}>{line.move_name}</a></td>
          <td>{line.account}</td><td>{line.partner}</td><td>{line.name}</td>
          <td className="num">{money(line.debit || 0)}</td><td className="num">{money(line.credit || 0)}</td><td className="num">{line.currency_id && line.amount_currency != null ? formatCurrency(line.amount_currency, read(db, 'res.currency', line.currency_id)) : ''}</td><td>{line.matching_number ?? (line.reconciled ? t('Reconciled') : '')}</td><td>{line.company}</td>
        </tr>)}
      </Fragment>)}</tbody>
    </table></div>
  </main>;
}
