import { CompanySelect, reportCompanyScope } from './reportCompany.jsx';
import { downloadCsv, tableToRows } from '../csv.js';
import { useRef, useState } from 'react';
import { read } from '../orm.js';
import { companyCurrencyRecord } from '../money.js';
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
  const sourceDb = useDb();
  const [companyId, setCompanyId] = useState('all');
  const { companyDb: db, availableCompanies, companies, selectedCompany } = reportCompanyScope(sourceDb, companyId);
  const tableRef = useRef(null);
  const [date, setDate] = useState(today());
  const [isPrinting, setIsPrinting] = useState(false);
  const [excluded, setExcluded] = useState([]);
  const [wizard, setWizard] = useState(null);
  const [posting, setPosting] = useState(false);
  let rows = [];
  let error = '';
  try { rows = foreignBalanceReport(db, date, selectedCompany === 'all' ? {} : { companyId: Number(selectedCompany) }).filter((row) => !excluded.includes(row.account_id)); } catch (e) { error = e.message; }
  const openWizard = () => {
    const company = read(db, 'res.company', selectedCompany === 'all' ? currentCompany(db) : Number(selectedCompany));
    if (!company) return;
    setWizard({ companyId: company.id, date, journalId: company.account_revaluation_journal_id ?? '', expenseAccountId: company.account_revaluation_expense_provision_account_id ?? '', incomeAccountId: company.account_revaluation_income_provision_account_id ?? '' });
  };
  let preview = [];
  let previewError = '';
  if (wizard) {
    try {
      if (!wizard.journalId || !wizard.expenseAccountId || !wizard.incomeAccountId) throw new Error('Select a journal and provision accounts');
      const result = revalueForeignBalances(sourceDb, wizard.date, { ...wizard, excludedAccountIds: excluded });
      const ids = new Set((sourceDb.records['account.move'] ?? []).map((m) => m.id));
      preview = (result.records['account.move'] ?? []).filter((m) => !ids.has(m.id) && m.revaluation_date === wizard.date);
    } catch (e) { previewError = e.message; }
  }
  const wizardCurrency = wizard ? companyCurrencyRecord(db, wizard.companyId) : null;
  const post = async () => {
    if (posting) return;
    setPosting(true);
    let entry = null;
    let remappedId = null;
    const onRemap = (e) => {
      if (entry && e.detail?.['account.move']?.[entry.id] != null) remappedId = e.detail['account.move'][entry.id];
    };
    window?.addEventListener?.('mizan:remapped', onRemap);
    try {
      const source = getDb();
      const result = revalueForeignBalances(source, wizard.date, { ...wizard, excludedAccountIds: excluded });
      const ids = new Set((source.records['account.move'] ?? []).map((m) => m.id));
      entry = (result.records['account.move'] ?? []).find((m) => !ids.has(m.id) && m.revaluation_date === wizard.date);
      const committed = await commit(result);
      const targetId = remappedId ?? entry?.id;
      if (committed.ok && targetId) { setWizard(null); location.hash = `#/accounting/entries/${targetId}`; }
    } catch (e) { alert(t(e.message)); } finally {
      window?.removeEventListener?.('mizan:remapped', onRemap);
      setPosting(false);
    }
  };
  const exportXlsx = () => {
    if (!tableRef.current) return;
    const columnTypes = ['text', 'text', 'text', 'text', 'text', 'number', 'rate', 'number', 'number', 'number'];
    downloadXlsx('unrealized_currencies.xlsx', tableRef.current, { sheetName: t('Unrealized Currencies'), columnTypes });
  };
  const controls = (
    <div className="control-panel">
      <h1 className="cp-title">{t('Unrealized Currencies')}</h1>
      <label>{t('Date')} <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button type="button" className="btn sm" disabled={!!error} onClick={openWizard}>{t('Adjustment Entry')}</button>
      {excluded.length > 0 && <button type="button" className="btn sm" onClick={() => setExcluded([])}>{t('Restore Accounts')}</button>}
      {availableCompanies.length > 1 && <CompanySelect companies={companies} value={selectedCompany} onChange={setCompanyId} />}
      <span className="spacer" />
      <button type="button" className="btn sm" disabled={!!error} onClick={() => setIsPrinting(true)}>{t('Print')}</button>
      <button type="button" className="btn sm" disabled={!!error} onClick={() => downloadCsv('unrealized-currencies.csv', tableToRows(tableRef.current))}>{t('Download CSV')}</button>
      <button type="button" className="btn sm" disabled={!!error} onClick={exportXlsx}>{t('Export XLSX')}</button>
    </div>
  );
  const allowedIds = selectedCompany === 'all' ? (db.settings?.allowed_company_ids ?? [currentCompany(db)]) : [Number(selectedCompany)];
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
      {wizard && <div className="modal-overlay"><div className="modal" role="dialog" aria-label={t('Adjustment Entry')}>
        <h2>{t('Adjustment Entry')}</h2>
        <label>{t('Date')} <input type="date" value={wizard.date} onChange={(e) => setWizard({ ...wizard, date: e.target.value })} /></label>
        {[['journalId', 'Revaluation Journal', 'account.journal'], ['expenseAccountId', 'Expense Provision Account', 'account.account'], ['incomeAccountId', 'Income Provision Account', 'account.account']].map(([field, label, model]) => <label key={field}>{t(label)} <select value={wizard[field]} onChange={(e) => setWizard({ ...wizard, [field]: Number(e.target.value) || '' })}>
          <option value="">{t('None')}</option>{(db.records[model] ?? []).filter((r) => r.active !== false && (!r.company_id || r.company_id === wizard.companyId) && (model !== 'account.journal' || r.type === 'general')).map((r) => <option key={r.id} value={r.id}>{r.code ? `${r.code} ${r.name}` : r.name}</option>)}
        </select></label>)}
        <h3>{t('Preview')}</h3>{previewError && <p role="alert">{t(previewError)}</p>}
        {!previewError && !preview.length && <p className="muted">{t('No adjustment lines to post.')}</p>}
        {preview.length > 0 && <table className="list"><thead><tr><th>{t('Account')}</th><th className="num">{t('Debit')}</th><th className="num">{t('Credit')}</th></tr></thead><tbody>{preview.flatMap((move) => move.line_ids.map((line, i) => { const acc = read(db, 'account.account', line.account_id); return <tr key={`${move.id}-${i}`}><td>{acc?.code ? `${acc.code} ${acc.name}` : acc?.name}</td><td className="num">{money(line.debit, wizardCurrency?.name, wizardCurrency)}</td><td className="num">{money(line.credit, wizardCurrency?.name, wizardCurrency)}</td></tr>; }))}</tbody></table>}
        <button type="button" className="btn primary" disabled={!!previewError || !preview.length || posting} onClick={post}>{t('Post')}</button> <button type="button" className="btn" onClick={() => setWizard(null)}>{t('Cancel')}</button>
      </div></div>}
      {!error && (
        <div className="list-wrap"><table ref={tableRef} className="list report">
          <thead><tr>{['Company', 'Entry', 'Partner', 'Account', 'Currency', 'Foreign Balance', 'Exchange Rate', 'Booked', 'Current Value', 'Difference'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
          <tbody>{rows.map((row, i) => {
            const currency = read(db, 'res.currency', row.currency_id);
            const rate = rateAt(db, row.currency_id, date, row.company_id);
            return <tr key={`${row.company_id}-${row.account_id}-${row.currency_id}-${row.invoice_id ?? i}`}>
              <td>{read(db, 'res.company', row.company_id)?.name ?? row.company_id}</td>
              <td>{row.invoice_id ? read(db, 'account.move', row.invoice_id)?.name : '—'}</td>
              <td>{read(db, 'res.partner', row.partner_id)?.name ?? '—'}</td>
              <td>{read(db, 'account.account', row.account_id)?.name ?? row.account}{!isPrinting && <> <button type="button" className="link no-export" onClick={() => setExcluded((prev) => (prev.includes(row.account_id) ? prev : [...prev, row.account_id]))}>{t('Exclude Account')}</button></>}</td>
              <td>{currency?.name}</td>
              <td className="num">{money(row.residual ?? row.foreign, currency?.name ?? null, currency ?? null)}</td>
              <td className="num rate">{display(db, RATE_FIELD, rate)}</td>
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
