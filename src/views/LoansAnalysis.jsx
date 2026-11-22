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

  const findReceiptMove = (loan) => {
    if (loan.receipt_move_id) {
      const m = posted(loan.receipt_move_id, loan);
      if (m) return m;
    }
    const cId = loanCompanyId(loan);
    const moves = (db.records?.['account.move'] ?? []).filter((m) =>
      m.state === 'posted' && (m.company_id ?? 1) === cId && (m.date || m.invoice_date) <= date
    );
    let found = moves.find((m) => m.ref === `Loan received ${loan.name}`);
    if (found) return found;
    found = moves.find((m) => m.ref?.startsWith(`Loan received ${loan.name}`));
    if (found) return found;
    if (loan.principal_account_id && loan.start_date) {
      found = moves.find((m) =>
        (m.date || m.invoice_date) === loan.start_date &&
        (m.line_ids ?? []).some((l) =>
          l.account_id === loan.principal_account_id &&
          (loan.amount == null || Math.abs((Number(l.credit) || 0) - (Number(l.debit) || 0) - Number(loan.amount)) < 1e-4)
        )
      );
      if (found) return found;
    }
    return null;
  };

  const findRepaymentMoves = (loan) => {
    const cId = loanCompanyId(loan);
    const linkedIds = new Set([
      ...(loan.line_ids ?? []).map((line) => line.move_id),
      ...(loan.early_moves ?? []).map((line) => line.move_id),
    ].filter(Boolean));
    const moves = [...linkedIds].map((id) => posted(id, loan)).filter(Boolean);
    const foundIds = new Set(moves.map((m) => m.id));
    const allPosted = (db.records?.['account.move'] ?? []).filter((m) =>
      m.state === 'posted' && (m.company_id ?? 1) === cId && (m.date || m.invoice_date) <= date && !foundIds.has(m.id)
    );
    for (const line of (loan.line_ids ?? [])) {
      if (!line.move_id && line.date) {
        const match = allPosted.find((m) => m.ref === `${loan.name} ${line.date.slice(0, 7)}`);
        if (match && !foundIds.has(match.id)) {
          moves.push(match);
          foundIds.add(match.id);
        }
      }
    }
    for (const m of allPosted) {
      if (m.ref === `Early repayment ${loan.name}` && !foundIds.has(m.id)) {
        moves.push(m);
        foundIds.add(m.id);
      }
    }
    return moves;
  };

  const rows = loans.flatMap((loan) => {
    const receipt = findReceiptMove(loan);
    if (!receipt) return loan.state === 'draft' || loan.state === 'cancel' ? [] : [{ loan, unavailable: true }];
    const moves = findRepaymentMoves(loan);
    const principal = -amount(receipt, loan.principal_account_id) || Number(loan.amount) || 0;
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
