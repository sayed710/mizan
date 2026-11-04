import { useState } from 'react';
import { viewRecords } from '../companyView.js';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { today } from '../models/common.js';

export function LoansAnalysis() {
  const db = useDb();
  const [date, setDate] = useState(today());
  const loans = viewRecords(db, 'account.loan');
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
  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{t('Loans Analysis')}</h1>
      <label>{t('As of')} <input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
    </div>
    <div className="list-wrap"><table className="list report"><thead><tr>{['Loan', 'Lender', 'Amount Borrowed', 'Principal Repaid', 'Interest Paid', 'Outstanding Balance'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{rows.map(({ loan, unavailable, principal, repaid, interest, balance }) => <tr key={loan.id}>
        <td><a href={`#/accounting/loans/${loan.id}`}>{loan.name}</a></td><td>{read(db, 'res.partner', loan.lender_id)?.name ?? ''}</td>
        {unavailable ? <td colSpan="4">{t('Historical entry links unavailable')}</td> : [principal, repaid, interest, balance].map((value, i) => <td key={i}>{money(value)}</td>)}
      </tr>)}</tbody>
    </table></div>
  </main>;
}
