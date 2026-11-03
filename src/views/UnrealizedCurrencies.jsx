import { useState } from 'react';
import { read } from '../orm.js';
import { today } from '../models/common.js';
import { foreignBalanceReport, revalueForeignBalances } from '../models/closing.js';
import { commit, getDb, useDb } from '../store.js';
import { money } from '../ui.jsx';
import { t } from '../i18n.js';

export function UnrealizedCurrencies() {
  const db = useDb();
  const [date, setDate] = useState(today());
  let rows = [];
  let error = '';
  try { rows = foreignBalanceReport(db, date); } catch (e) { error = e.message; }
  const revalue = () => {
    try { commit(revalueForeignBalances(getDb(), date, { companyScoped: true })); }
    catch (e) { alert(e.message); }
  };
  return <main className="action report-page">
    <div className="control-panel">
      <h1 className="cp-title">{t('Unrealized Currencies')}</h1>
      <label>{t('Date')} <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button type="button" className="btn sm" disabled={!!error} onClick={revalue}>{t('Revalue Foreign Currency')}</button>
      <span className="spacer" />
      <button type="button" className="btn sm" onClick={() => window.print()}>{t('Print')}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="list-wrap"><table className="list report">
      <thead><tr>{['Company', 'Entry', 'Partner', 'Account', 'Currency', 'Foreign Balance', 'Booked', 'Current Value', 'Difference'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={`${row.company_id}-${row.account_id}-${row.currency_id}-${row.invoice_id ?? i}`}>
        <td>{read(db, 'res.company', row.company_id)?.name ?? row.company_id}</td>
        <td>{row.invoice_id ? read(db, 'account.move', row.invoice_id)?.name : '—'}</td>
        <td>{read(db, 'res.partner', row.partner_id)?.name ?? '—'}</td>
        <td>{read(db, 'account.account', row.account_id)?.name ?? row.account}</td>
        <td>{read(db, 'res.currency', row.currency_id)?.name}</td>
        <td className="num">{money(row.residual ?? row.foreign)}</td>
        <td className="num">{money(row.booked)}</td>
        <td className="num">{money(row.value ?? row.booked + row.difference)}</td>
        <td className="num">{money(row.difference)}</td>
      </tr>)}</tbody>
    </table></div>
  </main>;
}
