import { viewRecords } from '../companyView.js';
import { CompanySelect, reportCompanyScope } from './reportCompany.jsx';
import { ReportPrintView } from './FinancialReportPrint.jsx';
import { documentCompany } from '../models/company.js';
import { downloadCsv, tableToRows } from '../csv.js';
import { downloadXlsx } from '../xlsx.js';
import { useRef, useState } from 'react';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { today } from '../models/common.js';

export function LoansAnalysis() {
  const sourceDb = useDb();
  const [companyId, setCompanyId] = useState('all');
  const { companyDb: db, availableCompanies, companies, selectedCompany } = reportCompanyScope(sourceDb, companyId);
  const [date, setDate] = useState(today());
  const loans = viewRecords(db, 'account.loan').filter((loan) => selectedCompany === 'all' || (loan.company_id ?? 1) === Number(selectedCompany));
  const posted = (id, loan) => {
    const move = read(db, 'account.move', id);
    return move?.state === 'posted' && move.company_id === loan.company_id && (move.date || move.invoice_date) <= date ? move : null;
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
  const totals = ['principal', 'repaid', 'interest', 'balance'].map((key) => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0));
  const tableRef = useRef(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const printCompanies = (selectedCompany === 'all' ? companies : companies.filter((company) => company.id === Number(selectedCompany))).map((company) => documentCompany(sourceDb, { company_id: company.id })).filter(Boolean);
  const controls = <div className="control-panel"><h1 className="cp-title">{t('Loans Analysis')}</h1>
      <label>{t('As of')} <input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      {availableCompanies.length > 1 && <CompanySelect companies={companies} value={selectedCompany} onChange={setCompanyId} />}
      <span className="spacer" />
      <button type="button" className="btn sm" onClick={() => setIsPrinting(true)}>{t('Print')}</button>
      <button type="button" className="btn sm" onClick={() => downloadCsv('loans-analysis.csv', tableToRows(tableRef.current))}>{t('Download CSV')}</button>
      <button type="button" className="btn sm" onClick={() => downloadXlsx('loans-analysis.xlsx', tableRef.current, { sheetName: 'Loans Analysis' })}>{t('Export XLSX')}</button>
    </div>;
  return <ReportPrintView active={isPrinting} company={printCompanies[0]} companies={printCompanies} title={t('Loans Analysis')} subtitle={date} controls={controls} onBack={() => setIsPrinting(false)}>
    <div className="list-wrap"><table ref={tableRef} className="list report"><thead><tr>{['Loan', 'Lender', 'Amount Borrowed', 'Principal Repaid', 'Interest Paid', 'Outstanding Balance'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{rows.map(({ loan, unavailable, principal, repaid, interest, balance }) => <tr key={loan.id}>
        <td><a href={`#/accounting/loans/${loan.id}`}>{loan.name}</a></td><td>{read(db, 'res.partner', loan.lender_id)?.name ?? ''}</td>
        {unavailable ? <td colSpan="4">{t('Historical entry links unavailable')}</td> : [principal, repaid, interest, balance].map((value, i) => <td key={i}>{money(value)}</td>)}
      </tr>)}</tbody>
      <tfoot><tr><th colSpan="2">{t('Total')}</th>{totals.map((value, i) => <td key={i}>{money(value)}</td>)}</tr></tfoot>
    </table></div>
  </ReportPrintView>;
}
