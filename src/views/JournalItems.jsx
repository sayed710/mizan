import { Fragment, useState } from 'react';
import { companyViewDb } from '../companyView.js';
import { journalItems } from '../models/ledger.js';
import { read } from '../orm.js';
import { commit, getDb, useDb } from '../store.js';
import { reconcileJournalItems, unreconcileJournalItems, writeoffJournalItem } from '../models/pay.js';
import { today } from '../models/common.js';
import { money } from '../ui.jsx';
import { t } from '../i18n.js';
import { formatCurrency } from '../money.js';

export function JournalItems({ leaf = {} } = {}) {
  const db = companyViewDb(useDb());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [selected, setSelected] = useState([]);
  const [action, setAction] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [journalId, setJournalId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyOf = (line) => JSON.stringify([line.move_id, line.line_identity]);
  const run = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const visible = new Set(journalItems(companyViewDb(getDb())).map(keyOf));
      if (selected.some((item) => !visible.has(keyOf(item)))) throw new Error('The selected items are no longer visible; refresh the selection');
      const execute = { Reconcile: reconcileJournalItems, Unreconcile: unreconcileJournalItems, 'Write Off': writeoffJournalItem }[action];
      const result = execute(getDb(), selected, { date, amount: amount === '' ? null : Number(amount), journalId: Number(journalId), accountId: Number(accountId), label });
      if ((await commit(result)).ok) { setSelected([]); setAction(''); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const name = (model, id) => read(db, model, id)?.name ?? '';
  const mode = leaf.reviewMode ?? 'posted';
  const title = mode === 'unreconciled' ? 'Unreconciled' : mode === 'draft' ? 'Draft Entries' : 'Journal Items';
  const rows = journalItems(db, { from, to, reviewMode: mode }).map((line) => ({
    ...line,
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
    {mode !== 'draft' && <div className="control-panel">
      <span>{t('{n} selected', { n: selected.length })}</span>
      {['Reconcile', 'Unreconcile', 'Write Off'].map((name) => <button type="button" className="btn" key={name} disabled={!selected.length || busy} onClick={() => { setAction(name); setError(''); }}>{t(name)}</button>)}
    </div>}
    {action && <form onSubmit={run} className="control-panel" aria-label={t(action)}>
      <h2>{t(action)}</h2>
      {action === 'Unreconcile' && <p>{t('This removes the matching: payments stay posted and their credit becomes available again. Write-offs and direct bank matches are reversed on the selected date.')}</p>}
      <label>{t('Date')} <input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {action !== 'Unreconcile' && <label>{t('Amount in Invoice Currency')} <input required={action === 'Write Off'} type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('Available balance')} /></label>}
      {action === 'Write Off' && <>
        <label>{t('Journal')} <select required value={journalId} onChange={(e) => setJournalId(e.target.value)}><option value="">{t('Select a journal')}</option>{(db.records['account.journal'] ?? []).filter((j) => ['bank', 'cash'].includes(j.type)).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select></label>
        <label>{t('Write-off Account')} <select required value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">{t('Select an account')}</option>{(db.records['account.account'] ?? []).filter((a) => !a.deprecated && !['asset_receivable', 'liability_payable', 'off_balance'].includes(a.account_type)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>{t('Write-off Label')} <input required value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      </>}
      <button className="btn primary" disabled={busy}>{t('Confirm')}</button><button type="button" className="btn" disabled={busy} onClick={() => setAction('')}>{t('Cancel')}</button>
      {error && <p role="alert">{t(error)}</p>}
    </form>}
    <div className="list-wrap"><table className="list report"><thead><tr><th>{t('Select')}</th>{['Date', 'Due Date', 'Entry', 'Account', 'Partner', 'Label', 'Debit', 'Credit', 'Amount in Currency', 'Matching', 'Company'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{[...groups.entries()].map(([key, lines]) => <Fragment key={key ?? 'none'}>
        {group && <tr><th /><th colSpan={8}>{lines[0][group] || t('Undefined')}</th><th colSpan={3} /></tr>}
        {lines.map((line) => <tr key={keyOf(line)}>
          <td><input type="checkbox" aria-label={t('Select journal item {entry}: {account} — {label}', { entry: line.move_name, account: line.account, label: line.name })} disabled={mode === 'draft' || busy} checked={selected.some((item) => keyOf(item) === keyOf(line))} onChange={(e) => setSelected(e.target.checked ? [...selected, { move_id: line.move_id, line_identity: line.line_identity }] : selected.filter((item) => keyOf(item) !== keyOf(line)))} /></td>
          <td>{line.date}</td><td>{line.date_maturity ?? ''}</td><td><a href={`#/accounting/entries/${line.move_id}`}>{line.move_name}</a></td>
          <td>{line.account}</td><td>{line.partner}</td><td>{line.name}</td>
          <td className="num">{money(line.debit || 0)}</td><td className="num">{money(line.credit || 0)}</td><td className="num">{line.currency_id && line.amount_currency != null ? formatCurrency(line.amount_currency, read(db, 'res.currency', line.currency_id)) : ''}</td><td>{line.matching_number ?? (line.reconciled ? t('Reconciled') : '')}</td><td>{line.company}</td>
        </tr>)}
      </Fragment>)}</tbody>
    </table></div>
  </main>;
}
