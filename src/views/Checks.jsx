import { viewRecords } from '../companyView.js';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';

export function Checks() {
  const db = useDb();
  const rows = viewRecords(db, 'account.batch.payment').filter((batch) => batch.state === 'posted' && batch.batch_type === 'outbound')
    .flatMap((batch) => (batch.lines ?? []).flatMap((line, index) => line.check_number != null ? [{ batch, line, index }] : []));
  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{t('Checks')}</h1></div>
    <div className="list-wrap"><table className="list report"><thead><tr>{['Check Number', 'Date', 'Batch Payments', 'Vendor', 'Amount', 'Status'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{rows.map(({ batch, line, index }) => {
        const invoice = read(db, 'account.move', line.move_id);
        const payment = read(db, 'account.payment', line.payment_id);
        return <tr key={`${batch.id}-${index}`}><td>{line.check_number}</td><td>{batch.date}</td>
          <td><a href={`#/accounting/batch-payments/${batch.id}`}>{batch.name}</a></td>
          <td>{read(db, 'res.partner', invoice?.partner_id)?.name ?? ''}</td><td>{money(line.amount)}</td>
          <td>{t(line.cancelled ? 'Cancelled' : payment?.state === 'posted' ? 'Posted' : payment?.state === 'cancel' ? 'Cancelled' : 'Unknown')}</td></tr>;
      })}</tbody></table></div>
  </main>;
}
