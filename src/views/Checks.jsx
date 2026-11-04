import { viewRecords } from '../companyView.js';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { checkRegisterRows } from '../models/payments.js';

export function Checks() {
  const db = useDb();
  const rows = checkRegisterRows(db, viewRecords(db, 'account.batch.payment'), viewRecords(db, 'account.payment'));
  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{t('Checks')}</h1></div>
    <div className="list-wrap"><table className="list report"><thead><tr>{['Check Number', 'Date', 'Payment', 'Vendor', 'Amount', 'Status'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{rows.map((row) => {
        const payment = read(db, 'account.payment', row.paymentId);
        const invoice = read(db, 'account.move', row.invoiceId);
        return <tr key={row.key}><td>{row.checkNumber}</td><td>{row.date}</td>
          <td>{row.batchId
            ? <a href={`#/accounting/batch-payments/${row.batchId}`}>{read(db, 'account.batch.payment', row.batchId)?.name}</a>
            : <a href={`#/open/account.payment/${row.paymentId}`}>{payment?.memo || payment?.name || `#${row.paymentId}`}</a>}</td>
          <td>{read(db, 'res.partner', invoice?.partner_id ?? payment?.partner_id)?.name ?? ''}</td><td>{money(row.amount)}</td>
          <td>{t(row.state)}</td></tr>;
      })}</tbody></table></div>
  </main>;
}
