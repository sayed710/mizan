import { Fragment, useMemo, useState } from 'react';
import { viewRecords } from '../companyView.js';
import { read } from '../orm.js';
import { commit, useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { checkRegisterRows, CHECK_REGISTER_STATES } from '../models/payments.js';
import { paymentPaysByCheck, printCheck, voidCheck } from '../models/pay.js';

export function Checks() {
  const db = useDb();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [groupByDate, setGroupByDate] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [error, setError] = useState(null);

  const payments = viewRecords(db, 'account.payment');
  const batches = viewRecords(db, 'account.batch.payment');

  const rows = useMemo(() => {
    const existingRows = checkRegisterRows(db, batches, payments);
    const toPrintRows = payments
      .filter((p) => p.state === 'posted' && p.payment_type === 'outbound' && paymentPaysByCheck(db, p)
        && (p.check_number == null || (p.voided_check_numbers ?? []).some((v) => v.check_number === p.check_number)))
      .map((p) => ({
        key: `payment-${p.id}-to-print`,
        checkNumber: '—',
        date: p.date,
        paymentId: p.id,
        amount: p.amount,
        state: 'To Print',
      }));
    return [...existingRows, ...toPrintRows];
  }, [db, batches, payments]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (status !== 'all') {
        if (status === 'to_print' && row.state !== 'To Print') return false;
        if (status === 'printed' && !['Posted', 'Issued'].includes(row.state)) return false;
        if (status === 'voided' && row.state !== 'Voided') return false;
        if (!['to_print', 'printed', 'voided'].includes(status) && row.state !== status) return false;
      }

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

  const allOn = filtered.length > 0 && filtered.every((row) => selected.has(row.key));

  const toggleAll = () => {
    const next = new Set(selected);
    for (const row of filtered) {
      if (allOn) next.delete(row.key);
      else next.add(row.key);
    }
    setSelected(next);
  };

  const toggleRow = (key) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const onBulkPrint = () => {
    const selectedRows = filtered.filter((r) => selected.has(r.key));
    if (!selectedRows.length) {
      setError(t('Select at least one record first'));
      return;
    }
    const printableRows = selectedRows.filter((r) => ['Posted', 'Issued'].includes(r.state) || r.state === 'To Print');
    if (!printableRows.length) {
      setError(t('Only posted outbound payments can be printed'));
      return;
    }

    let nextDb = db;
    const paymentIdsToPrint = [];
    const batchIdsToPrint = [];

    const journalIds = new Set(
      printableRows.map((r) => {
        const payment = r.paymentId ? read(nextDb, 'account.payment', r.paymentId) : null;
        return payment?.journal_id ?? (r.batchId ? read(nextDb, 'account.batch.payment', r.batchId)?.journal_id : null);
      }).filter(Boolean),
    );
    if (journalIds.size > 1) {
      setError(t('Selected payments must belong to the same journal'));
      return;
    }

    try {
      for (const row of printableRows) {
        if (row.state === 'To Print' && row.paymentId) {
          const p = read(nextDb, 'account.payment', row.paymentId);
          if (p) {
            const journal = p.journal_id ? read(nextDb, 'account.journal', p.journal_id) : null;
            if (journal?.check_manual_sequencing && p.check_number == null) {
              window.location.hash = `#/open/account.payment/${p.id}`;
              return;
            }
            nextDb = printCheck(nextDb, p);
            paymentIdsToPrint.push(p.id);
          }
        } else if (row.paymentId) {
          paymentIdsToPrint.push(row.paymentId);
        } else if (row.batchId) {
          batchIdsToPrint.push(row.batchId);
        }
      }

      if (nextDb !== db) {
        commit(nextDb);
      }

      if (paymentIdsToPrint.length) {
        window.location.hash = `#/print/account.payment/${paymentIdsToPrint.join(',')}`;
      } else if (batchIdsToPrint.length) {
        window.location.hash = `#/print/account.batch.payment/${batchIdsToPrint[0]}`;
      }
    } catch (e) {
      setError(t(e.message));
    }
  };

  const onBulkVoid = () => {
    const selectedRows = filtered.filter((r) => selected.has(r.key));
    if (!selectedRows.length) {
      setError(t('Select at least one record first'));
      return;
    }
    const voidableRows = selectedRows.filter((r) => ['Posted', 'Issued'].includes(r.state) && Boolean(r.paymentId));
    if (!voidableRows.length) {
      setError(t('Only issued checks can be voided'));
      return;
    }

    if (!confirm(t('Void selected checks?'))) return;
    try {
      let nextDb = db;
      const seen = new Set();
      for (const row of voidableRows) {
        if (seen.has(row.paymentId)) continue;
        seen.add(row.paymentId);
        const p = read(nextDb, 'account.payment', row.paymentId);
        if (p) {
          nextDb = voidCheck(nextDb, p);
        }
      }
      commit(nextDb);
      setSelected(new Set());
    } catch (e) {
      setError(t(e.message));
    }
  };

  const renderRow = (row) => {
    const payment = read(db, 'account.payment', row.paymentId);
    const invoice = read(db, 'account.move', row.invoiceId);
    const isToPrint = row.state === 'To Print';
    const canPrint = ['Posted', 'Issued'].includes(row.state) || isToPrint;
    const canVoid = ['Posted', 'Issued'].includes(row.state) && Boolean(row.paymentId);
    const printUrl = row.paymentId ? `#/print/account.payment/${row.paymentId}` : `#/print/account.batch.payment/${row.batchId}`;

    const onPrintToPrint = () => {
      const p = read(db, 'account.payment', row.paymentId);
      if (p) {
        const journal = p.journal_id ? read(db, 'account.journal', p.journal_id) : null;
        if (journal?.check_manual_sequencing) {
          window.location.hash = `#/open/account.payment/${row.paymentId}`;
          return;
        }
        try {
          const nextDb = printCheck(db, p);
          commit(nextDb);
          window.location.hash = `#/print/account.payment/${row.paymentId}`;
        } catch (e) {
          setError(t(e.message));
        }
      }
    };

    const onVoid = () => {
      const p = read(db, 'account.payment', row.paymentId);
      if (p && confirm(t('Void this check?'))) {
        try {
          commit(voidCheck(db, p));
        } catch (e) {
          setError(t(e.message));
        }
      }
    };

    return (
      <tr key={row.key} className={selected.has(row.key) ? 'selected' : ''}>
        <td className="check" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Check ${row.checkNumber}`}
            checked={selected.has(row.key)}
            onChange={() => toggleRow(row.key)}
          />
        </td>
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
          <div className="btn-group sm" style={{ display: 'inline-flex', gap: '4px' }}>
            {isToPrint && (
              <button type="button" className="btn sm" onClick={onPrintToPrint} title={t('Print Check')}>{t('Print')}</button>
            )}
            {!isToPrint && canPrint && (
              <a href={printUrl} className="btn sm" title={t('Print Check')}>{t('Print')}</a>
            )}
            {canVoid && (
              <button type="button" className="btn sm danger" onClick={onVoid} title={t('Void Check')}>{t('Void')}</button>
            )}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <main className="action report-page">
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="control-panel">
        <h1 className="cp-title">{t('Checks')}</h1>
        <div className="cp-actions search-filters">
          {selected.size > 0 && (
            <div className="btn-group sm bulk-actions" style={{ display: 'inline-flex', gap: '4px' }}>
              <button
                type="button"
                className="btn sm"
                onClick={onBulkPrint}
                title={t('Print Checks')}
                aria-label={t('Print Checks')}
              >
                {t('Print')}
              </button>
              <button
                type="button"
                className="btn sm danger"
                onClick={onBulkVoid}
                title={t('Void Checks')}
                aria-label={t('Void Checks')}
              >
                {t('Void')}
              </button>
            </div>
          )}
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
            <option value="to_print">{t('To Print')}</option>
            <option value="printed">{t('Printed')}</option>
            <option value="voided">{t('Voided')}</option>
            {CHECK_REGISTER_STATES.filter((s) => !['Voided', 'Issued', 'Posted'].includes(s)).map((s) => (
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
              {rows.length > 0 && (
                <th className="check">
                  <input
                    type="checkbox"
                    aria-label={t('Select all')}
                    checked={allOn}
                    onChange={toggleAll}
                  />
                </th>
              )}
              {(rows.length ? ['Check Number', 'Date', 'Payment', 'Vendor', 'Amount', 'Status', 'Actions'] : ['Check Number', 'Date', 'Payment', 'Vendor', 'Amount', 'Status']).map((label) => (
                <th key={label}>{t(label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!rows.length ? (
              <tr><td colSpan={7} className="empty">{t('No checks yet.')}</td></tr>
            ) : !filtered.length ? (
              <tr><td colSpan={8} className="empty">{t('No matching checks found.')}</td></tr>
            ) : grouped ? (
              Array.from(grouped.entries()).map(([date, groupRows]) => (
                <Fragment key={date}>
                  <tr className="rep-section">
                    <td colSpan={8}><b>{date || t('No Date')}</b> ({groupRows.length} {t('checks')})</td>
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
