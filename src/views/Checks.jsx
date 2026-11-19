import { Fragment, useMemo, useState } from 'react';
import { viewRecords } from '../companyView.js';
import { read } from '../orm.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { checkRegisterRows, CHECK_REGISTER_STATES } from '../models/payments.js';

export function Checks() {
  const db = useDb();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [groupByDate, setGroupByDate] = useState(false);

  const rows = checkRegisterRows(db, viewRecords(db, 'account.batch.payment'), viewRecords(db, 'account.payment'));

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (status !== 'all' && row.state !== status) return false;

      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const payment = read(db, 'account.payment', row.paymentId);
        const invoice = read(db, 'account.move', row.invoiceId);
        const vendorName = (read(db, 'res.partner', invoice?.partner_id ?? payment?.partner_id)?.name ?? '').toLowerCase();
        const checkStr = String(row.checkNumber ?? '').toLowerCase();
        const memoStr = String(payment?.memo ?? payment?.name ?? '').toLowerCase();
        if (!vendorName.includes(q) && !checkStr.includes(q) && !memoStr.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [rows, status, search, db]);

  const grouped = useMemo(() => {
    if (!groupByDate) return null;
    const map = new Map();
    for (const row of filtered) {
      const d = row.date ?? '';
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(row);
    }
    return map;
  }, [filtered, groupByDate]);

  const renderRow = (row) => {
    const payment = read(db, 'account.payment', row.paymentId);
    const invoice = read(db, 'account.move', row.invoiceId);
    const canPrint = ['Posted', 'Issued'].includes(row.state);
    const printUrl = row.paymentId ? `#/print/account.payment/${row.paymentId}` : `#/print/account.batch.payment/${row.batchId}`;
    return (
      <tr key={row.key}>
        <td>{row.checkNumber}</td>
        <td>{row.date}</td>
        <td>
          {row.batchId ? (
            <a href={`#/accounting/batch-payments/${row.batchId}`}>{read(db, 'account.batch.payment', row.batchId)?.name}</a>
          ) : (
            <a href={`#/open/account.payment/${row.paymentId}`}>{payment?.memo || payment?.name || `#${row.paymentId}`}</a>
          )}
        </td>
        <td>{read(db, 'res.partner', invoice?.partner_id ?? payment?.partner_id)?.name ?? ''}</td>
        <td>{money(row.amount)}</td>
        <td>{t(row.state)}</td>
        <td>
          {canPrint && (
            <a href={printUrl} className="btn sm" title={t('Print Check')}>{t('Print')}</a>
          )}
        </td>
      </tr>
    );
  };

  return (
    <main className="action report-page">
      <div className="control-panel">
        <h1 className="cp-title">{t('Checks')}</h1>
        <div className="cp-actions search-filters">
          <input
            type="search"
            className="search-input"
            placeholder={t('Search checks...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('Search checks...')}
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="select-filter"
            aria-label={t('Status Filter')}
          >
            <option value="all">{t('All Statuses')}</option>
            {CHECK_REGISTER_STATES.map((s) => (
              <option key={s} value={s}>{t(s)}</option>
            ))}
          </select>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={groupByDate}
              onChange={(e) => setGroupByDate(e.target.checked)}
            /> {t('Group by Date')}
          </label>
        </div>
      </div>
      <div className="list-wrap">
        <table className="list report">
          <thead>
            <tr>
              {(rows.length ? ['Check Number', 'Date', 'Payment', 'Vendor', 'Amount', 'Status', 'Actions'] : ['Check Number', 'Date', 'Payment', 'Vendor', 'Amount', 'Status']).map((label) => (
                <th key={label}>{t(label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr><td colSpan={6} className="empty">{t('No checks yet.')}</td></tr>
            ) : !filtered.length ? (
              <tr><td colSpan={7} className="empty">{t('No matching checks found.')}</td></tr>
            ) : grouped ? (
              Array.from(grouped.entries()).map(([date, groupRows]) => (
                <Fragment key={date}>
                  <tr className="rep-section">
                    <td colSpan={7}><b>{date || t('No Date')}</b> ({groupRows.length} {t('checks')})</td>
                  </tr>
                  {groupRows.map(renderRow)}
                </Fragment>
              ))
            ) : (
              filtered.map(renderRow)
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
