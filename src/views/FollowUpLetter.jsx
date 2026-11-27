import { useEffect, useRef, useState } from 'react';
import { read } from '../orm.js';
import { today, validDate } from '../models/common.js';
import { addressLines, currentCompany } from '../models/company.js';
import { followUpCompanies, followUpLevel, followUpLetter, followUps, followUpText, logManualFollowUp, processFollowUps } from '../models/finance.js';
import { whatsappPhone } from '../models/whatsapp.js';
import { formatCurrency } from '../money.js';
import { commit, getDb, getUser, isServer, serverAction, useDb } from '../store.js';
import { t } from '../i18n.js';
import { appOpen } from '../access.js';
import { sendTarget } from './documentSend.js';
import { ReportPrintView } from './ReportPrintView.jsx';
import { handleDialogKeyDown } from './Wizard.jsx';

const money = (amount, currency) => `${formatCurrency(amount, currency, '')} ${currency.name}`;
const totals = (list) => list.map(({ amount, currency }) => money(amount, currency)).join(', ') || '0';

const ACTION_LABELS = {
  email: 'Email',
  letter: 'Letter',
  sms: 'SMS',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  activity: 'Activity',
};

const summarizeBatchResults = (results) => ({
  total: results.length,
  processed: results.filter((r) => r.status === 'processed').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  failed: results.filter((r) => r.status === 'failed').length,
  emailed: results.filter((r) => r.actions.includes('email')).length,
  letters: results.filter((r) => r.actions.includes('letter')).length,
  sms: results.filter((r) => r.actions.includes('sms')).length,
  phone: results.filter((r) => r.actions.includes('phone')).length,
  activities: results.filter((r) => r.actions.includes('activity')).length,
  letterPartnerIds: results.filter((r) => r.actions.includes('letter')).map((r) => r.partnerId),
  refreshPending: results.filter((r) => r.refreshError).length,
  recordingFailures: results.filter((r) => r.delivered).length,
});

/** Execute batch follow-ups for `targets` (`[{ partnerId, companyId }]`), reusing server email and local commit paths. */
export async function runBatchFollowUpsAction(targets) {
  if (!targets?.length) throw new Error('Select at least one customer first');
  const effectiveAt = today();
  const results = [];

  if (!isServer()) {
    const byCompany = new Map();
    for (const item of targets) {
      const cId = Number(item.companyId ?? currentCompany(getDb()));
      if (!byCompany.has(cId)) byCompany.set(cId, []);
      byCompany.get(cId).push(Number(item.partnerId));
    }
    let nextDb = getDb();
    for (const [cId, partnerIds] of byCompany.entries()) {
      const res = await processFollowUps(nextDb, partnerIds, { companyId: cId, at: effectiveAt });
      nextDb = res.db;
      results.push(...res.results);
    }
    if (nextDb !== getDb()) {
      const saved = await commit(nextDb, { quiet: true });
      if (saved && saved.ok === false) throw new Error(saved.error ?? 'Could not save changes');
    }
    return { results, summary: summarizeBatchResults(results) };
  }

  for (const item of targets) {
    const partnerId = Number(item.partnerId);
    const cId = Number(item.companyId ?? currentCompany(getDb()));
    const beforeDb = getDb();
    const res = await processFollowUps(beforeDb, [partnerId], {
      companyId: cId,
      at: effectiveAt,
      deliverEmail: async (_email, ctx) => {
        if (ctx.db !== getDb()) {
          const pre = await commit(ctx.db, { quiet: true });
          if (pre && pre.ok === false) throw new Error(pre.error ?? 'Could not save changes');
        }
        const mailRes = await serverAction('/api/mail/followup', {
          partnerId: ctx.partner.id,
          companyId: ctx.companyId,
          joinInvoices: ctx.level?.join_invoices !== false,
          ...(ctx.pendingLetter ? { pendingLetter: true } : {}),
        });
        if (!mailRes.ok) throw new Error(mailRes.error ?? 'Action failed');
        // The email is already sent and recorded server-side: a failed refresh must not read as a failed send.
        return { serverHandled: true, db: getDb(), ...(mailRes.refreshError ? { refreshError: mailRes.refreshError } : {}) };
      },
    });
    if (!res.results.some((r) => r.refreshError || r.delivered) && res.db !== getDb()) {
      const saved = await commit(res.db, { quiet: true });
      if (saved && saved.ok === false) throw new Error(saved.error ?? 'Could not save changes');
    }
    results.push(...res.results);
    if (res.results.some((r) => r.refreshError || r.delivered)) {
      // Local follow-up state is stale: continuing would re-send to customers that were already reminded.
      for (const rest of targets.slice(targets.indexOf(item) + 1)) {
        const restId = Number(rest.partnerId);
        results.push({
          partnerId: restId,
          partnerName: read(getDb(), 'res.partner', restId)?.name ?? `#${restId}`,
          companyId: Number(rest.companyId ?? currentCompany(getDb())),
          status: 'skipped',
          reason: 'Reload the database before processing this customer',
          actions: [],
        });
      }
      break;
    }
  }
  return { results, summary: summarizeBatchResults(results) };
}

export function FollowUpBatchResultModal({ report, onClose }) {
  const box = useRef(null);
  const [confirmed, setConfirmed] = useState(() => new Set());
  const pendingRef = useRef(new Set());
  const [pending, setPending] = useState(() => new Set());
  const [error, setError] = useState('');
  useEffect(() => {
    box.current?.querySelector('button')?.focus();
  }, []);
  if (!report) return null;
  const { results, summary } = report;
  // Letters and calls advance the follow-up level only once the operator confirms them.
  const confirmManual = async (r, channel) => {
    const key = `${r.companyId ?? 1}-${r.partnerId}-${channel}`;
    if (pendingRef.current.has(key) || confirmed.has(key)) return;
    pendingRef.current.add(key);
    setPending(new Set(pendingRef.current));
    try {
      const next = logManualFollowUp(getDb(), r.partnerId, today(), { companyId: r.companyId ?? 1, channel, ignoreNextActionDate: true });
      const saved = await commit(next, { quiet: true });
      if (saved && saved.ok === false) throw new Error(saved.error ?? 'Could not save changes');
      setConfirmed((prev) => new Set(prev).add(key));
      setError('');
    } catch (e) {
      setError(t(e.message));
    } finally {
      pendingRef.current.delete(key);
      setPending(new Set(pendingRef.current));
    }
  };
  const lettersByCompany = new Map();
  for (const r of results) {
    if (!r.actions.includes('letter')) continue;
    const cId = r.companyId ?? 1;
    if (!lettersByCompany.has(cId)) lettersByCompany.set(cId, []);
    lettersByCompany.get(cId).push(r.partnerId);
  }
  const openLetters = () => {
    for (const [cId, ids] of lettersByCompany.entries()) {
      const url = `${location.origin}${location.pathname}${location.search}#/print/followup/${ids.join(',')}?company=${cId}`;
      const win = window.open?.(url, '_blank');
      if (!win) location.hash = `#/print/followup/${ids.join(',')}?company=${cId}`;
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="modal" role="dialog" aria-modal="true" aria-label={t('Follow-up Processing Report')} onKeyDown={(e) => handleDialogKeyDown(e, box.current, onClose)}>
        <h2>{t('Follow-up Processing Report')}</h2>
        <p aria-live="polite">
          {t('Processed')}: <b>{summary.processed}</b> · {t('Skipped')}: <b>{summary.skipped}</b> · {t('Failed')}: <b>{summary.failed}</b>
        </p>
        {summary.refreshPending > 0 && (
          <p role="alert">
            {t('The email was sent, but the database could not be refreshed. Reload the database to see the updated follow-up status; do not send it again.')}{' '}
            <button type="button" className="btn sm" onClick={() => location.reload()}>{t('Reload')}</button>
          </p>
        )}
        {summary.recordingFailures > 0 && <p role="alert">{t('The email was delivered but could not be recorded. Do not send it again; resolve the recording failure before continuing.')}</p>}
        {error && <p role="alert">{error}</p>}
        <table className="list">
          <thead>
            <tr>
              <th>{t('Customer')}</th>
              <th>{t('Level')}</th>
              <th>{t('Status')}</th>
              <th>{t('Actions')}</th>
              <th>{t('Details')}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={`${r.companyId ?? 1}-${r.partnerId}`}>
                <td>{r.partnerName}</td>
                <td>{r.levelName ?? '—'}</td>
                <td>{t(r.status === 'processed' ? 'Processed' : r.status === 'skipped' ? 'Skipped' : 'Failed')}</td>
                <td>
                  {r.actions.length ? r.actions.map((a) => t(ACTION_LABELS[a] ?? a)).join(', ') : '—'}
                  {(r.pendingManual ?? []).map((channel) => {
                    const key = `${r.companyId ?? 1}-${r.partnerId}-${channel}`;
                    return confirmed.has(key)
                      ? <div key={channel}>{t(channel === 'letter' ? 'Letter printed' : 'Call done')}</div>
                      : <div key={channel}><button type="button" className="btn sm" disabled={pending.has(key)} onClick={() => confirmManual(r, channel)}>{t(channel === 'letter' ? 'Mark letter as printed' : 'Mark call as done')}</button></div>;
                  })}
                </td>
                <td>{r.nextActionDate ? `${t(r.reason)} (${r.nextActionDate})` : (r.reason ? t(r.reason) : '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: '0.75rem' }}>
          {lettersByCompany.size > 0 && (
            <>
              <button type="button" className="btn primary" onClick={openLetters}>{t('Print Letters')}</button>{' '}
            </>
          )}
          <button type="button" className="btn" onClick={onClose}>{t('Close')}</button>
        </div>
      </div>
    </div>
  );
}

export function FollowUpWizard({ partnerId, companyId, onClose }) {
  const db = useDb();
  const actionDate = today();
  const partner = read(db, 'res.partner', Number(partnerId));
  const company = Number(companyId ?? currentCompany(db));
  const reminder = partner
    ? followUps(db, actionDate, { companyId: company, ignoreNextActionDate: true })
      .flatMap(followUpCompanies)
      .find((f) => f.partner_id === Number(partnerId) && f.company_id === company) ?? null
    : null;
  const level = reminder ? followUpLevel(db, reminder, actionDate) : null;
  const canEmail = appOpen(db, getUser(), 'accounting');
  const canWhatsApp = sendTarget({ server: '/api/integrations/whatsapp', requires: 'whatsapp' }).live;
  const hasPhone = Boolean(String(partner?.mobile || partner?.phone || '').trim());
  const [email, setEmail] = useState(canEmail && Boolean(partner?.email?.trim()) && (level ? Boolean(level.send_email) : true));
  const [print, setPrint] = useState(level ? Boolean(level.print_letter || (!level.send_email && !level.send_sms && level.channel === 'letter')) : !canEmail);
  const [sms, setSms] = useState(Boolean(level?.send_sms && hasPhone));
  const [joinInvoices, setJoinInvoices] = useState(level ? level.join_invoices !== false : true);
  const [whatsapp, setWhatsapp] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const completedRef = useRef({ key: null, channels: new Set(), waDelivered: false, levelTransitioned: false });
  const submit = async () => {
    if (email && !canEmail) { setError(t('No access to account.move')); return; }
    if (!email && !print && !sms && !whatsapp) { setError(t('Select at least one follow-up action.')); return; }
    const stateKey = `${partnerId}:${company}`;
    if (completedRef.current.key !== stateKey) {
      completedRef.current = { key: stateKey, channels: new Set(), waDelivered: false, levelTransitioned: false };
    }
    const completed = completedRef.current;
    setBusy(true);
    let printWindow = null;
    try {
      const currentDb = getDb();
      const currentPartner = read(currentDb, 'res.partner', Number(partnerId));
      // Validate letter/level requirements and channel prerequisites before committing or opening print window.
      const letter = followUpLetter(currentDb, Number(partnerId), company, actionDate);
      if (email && !completed.channels.has('email') && !currentPartner?.email?.trim()) throw new Error('A customer email address is required to send an email reminder');
      if (email && !completed.channels.has('email') && !isServer()) throw new Error('Email requires the server.');
      if (sms && !completed.channels.has('sms') && !String(currentPartner?.mobile || currentPartner?.phone || '').trim()) throw new Error('The customer has no mobile or phone number.');
      if (whatsapp && !completed.channels.has('whatsapp') && !canWhatsApp) throw new Error('WhatsApp integration is not configured.');
      if (whatsapp && !completed.channels.has('whatsapp') && !whatsappPhone(currentPartner?.mobile || currentPartner?.phone)) {
        throw new Error('The contact has no international phone number (e.g. +20 100 123 4567)');
      }

      if (print && !completed.channels.has('letter')) {
        printWindow = window.open('about:blank', '_blank');
        if (!printWindow) throw new Error(t('The print window was blocked.'));
      }

      if (email && !completed.channels.has('email')) {
        const result = await serverAction('/api/mail/followup', {
          partnerId: Number(partnerId),
          companyId: company,
          joinInvoices,
        });
        if (!result.ok) throw new Error(result.error ?? t('Action failed'));
        if (result.message || result.refreshError) alert(result.message ?? result.refreshError);
        completed.channels.add('email');
        completed.levelTransitioned = true;
      }
      if (whatsapp && !completed.channels.has('whatsapp')) {
        if (!completed.waDelivered) {
          const waText = `${letter.message ? `${letter.message}\n` : ''}${followUpText(getDb(), letter.reminder)}`.trim();
          const waRes = await serverAction('/api/integrations/whatsapp', { model: 'res.partner', id: Number(partnerId), text: waText });
          if (waRes && waRes.ok === false) throw new Error(waRes.error ?? t('Action failed'));
          completed.waDelivered = true;
        }
        const nextWa = logManualFollowUp(getDb(), Number(partnerId), actionDate, {
          companyId: company,
          channel: 'whatsapp',
          ignoreNextActionDate: true,
          advanceLevel: !completed.levelTransitioned,
        });
        const waSaved = await commit(nextWa, { quiet: true });
        if (waSaved && waSaved.ok === false) throw new Error(waSaved.error ?? 'Could not save changes');
        completed.channels.add('whatsapp');
        completed.levelTransitioned = true;
      }
      if (sms && !completed.channels.has('sms')) {
        const nextSms = logManualFollowUp(getDb(), Number(partnerId), actionDate, {
          companyId: company,
          channel: 'sms',
          ignoreNextActionDate: true,
          advanceLevel: !completed.levelTransitioned,
        });
        const smsSaved = await commit(nextSms, { quiet: true });
        if (smsSaved && smsSaved.ok === false) throw new Error(smsSaved.error ?? 'Could not save changes');
        completed.channels.add('sms');
        completed.levelTransitioned = true;
      }
      if (print && !completed.channels.has('letter')) {
        const nextPrint = logManualFollowUp(getDb(), Number(partnerId), actionDate, {
          companyId: company,
          channel: 'letter',
          ignoreNextActionDate: true,
          advanceLevel: !completed.levelTransitioned,
        });
        const result = await commit(nextPrint, { quiet: true });
        if (result && result.ok === false) throw new Error(result.error ?? 'Could not save changes');
        completed.channels.add('letter');
        completed.levelTransitioned = true;
      }
      if (printWindow) {
        printWindow.location.href = `${location.origin}${location.pathname}${location.search}#/print/followup/${partnerId}?company=${company}`;
      }
      onClose();
    } catch (e) {
      if (printWindow) printWindow.close();
      const succeeded = [...completed.channels].map((ch) => t(ACTION_LABELS[ch] ?? ch));
      setError(succeeded.length
        ? t('Succeeded: {channels}. Error: {error}', { channels: succeeded.join(', '), error: t(e.message) })
        : t(e.message));
    } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label={t('Send Follow-up')}>
    <h2>{t('Send Follow-up')}</h2>
    {canEmail && <><label><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> {t('Email')}</label>{' '}</>}
    <label><input type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} /> {t('Print')}</label>{' '}
    <label><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /> {t('SMS')}</label>{' '}
    <label><input type="checkbox" checked={joinInvoices} disabled={!email} onChange={(e) => setJoinInvoices(e.target.checked)} /> {t('Attach Invoices')}</label>
    {canWhatsApp && <>{' '}<label><input type="checkbox" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} /> {t('WhatsApp')}</label></>}
    {error && <p role="alert">{error}</p>}
    <div><button type="button" className="btn primary" disabled={busy} onClick={submit}>{t('Send')}</button>{' '}
      <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('Cancel')}</button></div>
  </div></div>;
}

function FollowUpLetterContent({ partner, letter }) {
  return (
    <>
      <address><b>{partner.name}</b>{addressLines(partner, t('Tax ID')).map((line, i) => <div key={i}>{line}</div>)}</address>
      <p style={{ whiteSpace: 'pre-line' }}>{letter.message ?? letter.level.message}</p>
      <table className="rep-table"><thead><tr>{['Invoice', 'Invoice Date', 'Due Date', 'Residual', 'Overdue'].map((label) => <th key={label}>{t(label)}</th>)}</tr></thead>
        <tbody>{letter.invoices.map((m) => <tr key={m.id ? `${m.move_type ?? 'move'}-${m.id}` : m.name}><td>{m.name}</td><td>{m.invoice_date}</td><td>{m.invoice_date_due}</td><td>{money(m.amount_residual, m.followup_currency)}</td><td>{m.overdue ? t('Overdue') : ''}</td></tr>)}</tbody></table>
      <p><b>{t('Total Due')}: {totals(letter.due)}</b></p><p><b>{t('Total Overdue')}: {totals(letter.overdue)}</b></p>
    </>
  );
}

export function FollowUpLetter({ partnerId, companyId, at = null }) {
  const db = useDb();
  const effectiveAt = at && validDate(at) ? at : today();
  const cId = Number(companyId ?? currentCompany(db));
  const company = read(db, 'res.company', cId);
  const ids = String(partnerId ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  const items = ids.map((id) => {
    const partner = read(db, 'res.partner', id);
    let letter = null;
    let error = null;
    try { letter = followUpLetter(db, id, cId, effectiveAt); } catch (e) { error = t(e.message); }
    return { id, partner, letter, error };
  });
  const isBatch = items.length > 1;
  const single = items[0];
  const canPrint = isBatch
    ? Boolean(company && items.some((x) => x.letter && x.partner))
    : Boolean(single?.letter && company && single?.partner);
  useEffect(() => {
    if (!canPrint) return undefined;
    const timer = setTimeout(() => window.print(), 300);
    return () => clearTimeout(timer);
  }, [canPrint]);
  if (!company || (!isBatch && (!single?.letter || !single?.partner))) {
    return <main className="action"><p role="alert">{single?.error ?? t('Record not found.')}</p></main>;
  }
  if (isBatch) {
    const documents = items.map((item) => ({
      key: item.id,
      content: item.letter && item.partner
        ? <FollowUpLetterContent partner={item.partner} letter={item.letter} />
        : <p role="alert">{item.error ?? t('Record not found.')}</p>,
    }));
    return <ReportPrintView company={company} title={t('Follow-up Letter')} autoPrint={false} documents={documents} />;
  }
  return (
    <ReportPrintView company={company} title={t('Follow-up Letter')} autoPrint={false}>
      <FollowUpLetterContent partner={single.partner} letter={single.letter} />
    </ReportPrintView>
  );
}
