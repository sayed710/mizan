import { useEffect, useState } from 'react';
import { read } from '../orm.js';
import { today } from '../models/common.js';
import { addressLines, currentCompany } from '../models/company.js';
import { followUpLetter, logManualFollowUp } from '../models/finance.js';
import { formatCurrency } from '../money.js';
import { commit, getDb, getUser, isServer, serverAction, useDb } from '../store.js';
import { t } from '../i18n.js';
import { appOpen } from '../access.js';
import { ReportPrintView } from './ReportPrintView.jsx';

const money = (amount, currency) => `${formatCurrency(amount, currency, '')} ${currency.name}`;
const totals = (list) => list.map(({ amount, currency }) => money(amount, currency)).join(', ') || '0';

export function FollowUpWizard({ partnerId, companyId, onClose }) {
  const db = useDb();
  const partner = read(db, 'res.partner', Number(partnerId));
  const company = Number(companyId ?? currentCompany(db));
  const canEmail = appOpen(db, getUser(), 'accounting');
  const [email, setEmail] = useState(canEmail && Boolean(partner?.email?.trim()));
  const [print, setPrint] = useState(!canEmail);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (email && !canEmail) { setError(t('No access to account.move')); return; }
    if (!email && !print) { setError(t('Select Email or Print.')); return; }
    setBusy(true);
    let printWindow = null;
    try {
      // Validate letter requirements before committing or opening print window.
      if (print) {
        followUpLetter(getDb(), Number(partnerId), company, today());
      }
      const next = logManualFollowUp(getDb(), Number(partnerId), today(), { companyId: company, channel: email ? 'email' : 'letter', ignoreNextActionDate: true });
      if (print) {
        printWindow = window.open('about:blank', '_blank');
        if (!printWindow) throw new Error(t('The print window was blocked.'));
      }
      if (email) {
        if (!isServer()) throw new Error(t('Email requires the server.'));
        const result = await serverAction('/api/mail/followup', { partnerId: Number(partnerId), companyId: company });
        if (!result.ok) throw new Error(result.error ?? t('Action failed'));
        if (result.message || result.refreshError) alert(result.message ?? result.refreshError);
      } else {
        const result = await commit(next, { quiet: true });
        if (!result.ok) throw new Error(result.error);
      }
      if (printWindow) printWindow.location.href = `${location.origin}${location.pathname}${location.search}#/print/followup/${partnerId}?company=${company}`;
      onClose();
    } catch (e) {
      if (printWindow) printWindow.close();
      setError(t(e.message));
    } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label={t('Send Follow-up')}>
    <h2>{t('Send Follow-up')}</h2>
    {canEmail && <><label><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> {t('Email')}</label>{' '}</>}
    <label><input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} /> {t('Print')}</label>
    {error && <p role="alert">{error}</p>}
    <div><button type="button" className="btn primary" disabled={busy} onClick={submit}>{t('Send')}</button>{' '}
      <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('Cancel')}</button></div>
  </div></div>;
}

export function FollowUpLetter({ partnerId, companyId }) {
  const db = useDb();
  const company = read(db, 'res.company', Number(companyId ?? currentCompany(db)));
  const partner = read(db, 'res.partner', Number(partnerId));
  let letter;
  let error;
  try { letter = followUpLetter(db, Number(partnerId), Number(companyId ?? currentCompany(db))); } catch (e) { error = t(e.message); }
  const canPrint = Boolean(letter && company && partner);
  useEffect(() => {
    if (!canPrint) return undefined;
    const timer = setTimeout(() => window.print(), 300);
    return () => clearTimeout(timer);
  }, [canPrint]);
  if (!letter || !company || !partner) return <main className="action"><p role="alert">{error ?? t('Record not found.')}</p></main>;
  return <ReportPrintView company={company} title={t('Follow-up Letter')} autoPrint={false}>
    <address><b>{partner.name}</b>{addressLines(partner, t('Tax ID')).map((line, i) => <div key={i}>{line}</div>)}</address>
    <p style={{ whiteSpace: 'pre-line' }}>{letter.level.message}</p>
    <table className="rep-table"><thead><tr>{['Invoice', 'Invoice Date', 'Due Date', 'Residual', 'Overdue'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
      <tbody>{letter.invoices.map((m) => <tr key={m.id ? `${m.move_type ?? 'move'}-${m.id}` : m.name}><td>{m.name}</td><td>{m.invoice_date}</td><td>{m.invoice_date_due}</td><td>{money(m.amount_residual, m.followup_currency)}</td><td>{m.overdue ? t('Overdue') : ''}</td></tr>)}</tbody></table>
    <p><b>{t('Total Due')}: {totals(letter.due)}</b></p><p><b>{t('Total Overdue')}: {totals(letter.overdue)}</b></p>
  </ReportPrintView>;
}
