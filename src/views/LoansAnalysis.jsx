import { useRef, useState } from 'react';
import { viewRecords } from '../companyView.js';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { today } from '../models/common.js';
import { currentCompany, documentCompany } from '../models/company.js';
import { downloadCsv, tableToRows } from '../csv.js';
import { downloadXlsx } from '../xlsx.js';
import { ReportPrintView } from './FinancialReportPrint.jsx';
import { CompanySelect, reportCompanyScope } from './reportCompany.jsx';

export function LoansAnalysis() {
  const sourceDb = useDb();
  const [companyId, setCompanyId] = useState('all');
  const { companyDb: db, availableCompanies, companies, selectedCompany } = reportCompanyScope(sourceDb, companyId);
  const [date, setDate] = useState(today());
  const [isPrinting, setIsPrinting] = useState(false);
  const tableRef = useRef(null);

  const allLoans = viewRecords(db, 'account.loan');
  const loans = selectedCompany === 'all'
    ? allLoans
    : allLoans.filter((loan) => (loan.company_id ?? 1) === Number(selectedCompany));

  const loanCompanyId = (loan) => loan.company_id ?? 1;
  const posted = (id, loan) => {
    if (!id) return null;
    const move = read(db, 'account.move', id);
    return move?.state === 'posted' && (move.company_id ?? 1) === loanCompanyId(loan) && (move.date || move.invoice_date) <= date ? move : null;
  };
  const amount = (move, accountId) => (move?.line_ids ?? []).reduce((sum, line) => (
    line.account_id === accountId ? sum + (Number(line.debit) || 0) - (Number(line.credit) || 0) : sum
  ), 0);

  const rows = loans.flatMap((loan) => {
    const receipt = posted(loan.receipt_move_id, loan);
    if (!loan.receipt_move_id) return loan.state === 'draft' || loan.state === 'cancel' ? [] : [{ loan, unavailable: true }];
    if (!receipt) return [];
    const moves = [...(loan.line_ids ?? []).map((line) => line.move_id), ...(loan.early_moves ?? []).map((line) => line.move_id)]
      .map((id) => posted(id, loan)).filter(Boolean);
    const principal = -amount(receipt, loan.principal_account_id);
    const repaid = moves.reduce((sum, move) => sum + amount(move, loan.principal_account_id), 0);
    const interest = moves.reduce((sum, move) => sum + amount(move, loan.interest_account_id), 0);
    return [{ loan, principal, repaid, interest, balance: principal - repaid }];
  });

  const totalPrincipal = rows.reduce((sum, r) => sum + (r.unavailable ? 0 : (r.principal ?? 0)), 0);
  const totalRepaid = rows.reduce((sum, r) => sum + (r.unavailable ? 0 : (r.repaid ?? 0)), 0);
  const totalInterest = rows.reduce((sum, r) => sum + (r.unavailable ? 0 : (r.interest ?? 0)), 0);
  const totalBalance = rows.reduce((sum, r) => sum + (r.unavailable ? 0 : (r.balance ?? 0)), 0);

  const exportCsv = () => {
    if (!tableRef.current) return;
    downloadCsv('loans_analysis.csv', tableToRows(tableRef.current));
  };
  const exportXlsx = () => {
    if (!tableRef.current) return;
    downloadXlsx('loans_analysis.xlsx', tableRef.current, { sheetName: t('Loans Analysis') });
  };

  const controls = (
    <div className="control-panel"><h1 className="cp-title">{t('Loans Analysis')}</h1>
      <label>{t('As of')} <input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      {availableCompanies.length > 1 && <CompanySelect companies={companies} value={selectedCompany} onChange={setCompanyId} />}
      <span className="spacer" />
      <button type="button" className="btn sm" onClick={() => setIsPrinting(true)}>{t('Print')}</button>
      <button type="button" className="btn sm" onClick={exportCsv}>{t('Download CSV')}</button>
      <button type="button" className="btn sm" onClick={exportXlsx}>{t('Download XLSX')}</button>
    </div>
  );

  const activeCompanyId = selectedCompany === 'all' ? currentCompany(db) : Number(selectedCompany);
  const printCompany = isPrinting ? documentCompany(db, { company_id: activeCompanyId }) : null;
  const printCompanies = isPrinting
    ? (selectedCompany === 'all'
        ? companies.map((c) => documentCompany(db, { company_id: c.id }) || c)
        : (printCompany ? [printCompany] : []))
    : null;

  return (
    <ReportPrintView
      active={isPrinting}
      company={printCompany}
      companies={printCompanies}
      title={t('Loans Analysis')}
      subtitle={`≤ ${date}`}
      controls={controls}
      onBack={() => setIsPrinting(false)}
    >
      <div className="list-wrap"><table className="list report" ref={tableRef}>
        <thead><tr>{['Loan', 'Lender', 'Amount Borrowed', 'Principal Repaid', 'Interest Paid', 'Outstanding Balance'].map((label, i) => <th key={label} className={i >= 2 ? 'num' : undefined}>{t(label)}</th>)}</tr></thead>
        <tbody>
          {rows.map(({ loan, unavailable, principal, repaid, interest, balance }) => <tr key={loan.id}>
            <td><a href={`#/accounting/loans/${loan.id}`}>{loan.name}</a></td><td>{read(db, 'res.partner', loan.lender_id)?.name ?? ''}</td>
            {unavailable ? <td colSpan="4">{t('Historical entry links unavailable')}</td> : [principal, repaid, interest, balance].map((value, i) => <td key={i} className="num">{money(value)}</td>)}
          </tr>)}
          <tr className="rep-total strong">
            <td>{t('Total')}</td>
            <td />
            <td className="num">{money(totalPrincipal)}</td>
            <td className="num">{money(totalRepaid)}</td>
            <td className="num">{money(totalInterest)}</td>
            <td className="num">{money(totalBalance)}</td>
          </tr>
        </tbody>
      </table></div>
    </ReportPrintView>
  );
}
