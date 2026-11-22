import { useRef, useState } from 'react';
import { read } from '../orm.js';
import { today } from '../models/common.js';
import { currentCompany, documentCompany } from '../models/company.js';
import { rateAt } from '../models/currency.js';
import { foreignBalanceReport, revalueForeignBalances } from '../models/closing.js';
import { commit, getDb, useDb } from '../store.js';
import { display, money } from '../ui.jsx';
import { t } from '../i18n.js';
import { downloadXlsx } from '../xlsx.js';
import { ReportPrintView } from './FinancialReportPrint.jsx';

const RATE_FIELD = { type: 'float', digits: [6, 6] };

export function UnrealizedCurrencies() {
  const db = useDb();
  const [date, setDate] = useState(today());
  const [isPrinting, setIsPrinting] = useState(false);
  const tableRef = useRef(null);
  let rows = [];
  let error = '';
  try { rows = foreignBalanceReport(db, date); } catch (e) { error = e.message; }
  const revalue = () => {
    try { commit(revalueForeignBalances(getDb(), date, { companyScoped: true })); }
    catch (e) { alert(e.message); }
  };
  const exportXlsx = () => {
    if (!tableRef.current) return;
    downloadXlsx('unrealized_currencies.xlsx', tableRef.current, { sheetName: t('Unrealized Currencies') });
  };
  const controls = (
    <div className="control-panel">
      <h1 className="cp-title">{t('Unrealized Currencies')}</h1>
      <label>{t('Date')} <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button type="button" className="btn sm" disabled={!!error} onClick={revalue}>{t('Revalue Foreign Currency')}</button>
      <span className="spacer" />
      <button type="button" className="btn sm" disabled={!!error} onClick={() => setIsPrinting(true)}>{t('Print')}</button>
      <button type="button" className="btn sm" disabled={!!error} onClick={exportXlsx}>{t('Export XLSX')}</button>
    </div>
  );
  const allowedIds = db.settings?.allowed_company_ids ?? [currentCompany(db)];
  const printCompanies = isPrinting
    ? allowedIds.map((cId) => documentCompany(db, { company_id: cId })).filter(Boolean)
    : null;
  const printCompany = isPrinting ? (printCompanies?.[0] ?? documentCompany(db, { company_id: currentCompany(db) })) : null;
  return (
    <ReportPrintView
      active={isPrinting}
      company={printCompany}
      companies={printCompanies}
      title={t('Unrealized Currencies')}
      subtitle={`≤ ${date}`}
      controls={controls}
      autoPrint={!error}
      onBack={() => setIsPrinting(false)}
    >
      {error && <p role="alert">{error}</p>}
      {!error && (
        <div className="list-wrap"><table className="list report" ref={tableRef}>
          <thead><tr>{['Company', 'Entry', 'Partner', 'Account', 'Currency', 'Foreign Balance', 'Exchange Rate', 'Booked', 'Current Value', 'Difference'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
          <tbody>{rows.map((row, i) => {
            const currency = read(db, 'res.currency', row.currency_id);
            const rate = rateAt(db, row.currency_id, date, row.company_id);
            return <tr key={`${row.company_id}-${row.account_id}-${row.currency_id}-${row.invoice_id ?? i}`}>
              <td>{read(db, 'res.company', row.company_id)?.name ?? row.company_id}</td>
              <td>{row.invoice_id ? read(db, 'account.move', row.invoice_id)?.name : '—'}</td>
              <td>{read(db, 'res.partner', row.partner_id)?.name ?? '—'}</td>
              <td>{read(db, 'account.account', row.account_id)?.name ?? row.account}</td>
              <td>{currency?.name}</td>
              <td className="num">{money(row.residual ?? row.foreign, currency?.name ?? null, currency ?? null)}</td>
              <td className="num">{display(db, RATE_FIELD, rate)}</td>
              <td className="num">{money(row.booked)}</td>
              <td className="num">{money(row.value ?? row.booked + row.difference)}</td>
              <td className="num">{money(row.difference)}</td>
            </tr>;
          })}</tbody>
        </table></div>
      )}
    </ReportPrintView>
  );
}
