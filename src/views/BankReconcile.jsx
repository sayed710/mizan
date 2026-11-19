// Two-pane bank reconciliation widget: unreconciled statement lines on the left, matching/payment/manual tabs on the right.
import { useEffect, useMemo, useState } from 'react';
import { companyViewDb } from '../companyView.js';
import { read, search } from '../orm.js';
import { commit, getDb, useDb } from '../store.js';
import { companyFilter } from '../models/company.js';
import { isLiquidityJournal } from '../models/ledger.js';
import {
  bookToAccount,
  candidates,
  eligibleCounterpart,
  eligiblePayments,
  matchError,
  matchPayment,
  reconcileWith,
  setStatementLinePartner,
  statementCompanyAmount,
} from '../models/bank.js';
import { applyRule, isAutoRule, isMatchingRule } from '../models/reconcile.js';
import { t } from '../i18n.js';
import { documentCurrency, findCompanyCurrencyRecord } from '../money.js';
import { display, money } from '../ui.jsx';

/** Format `amount` using `currency` (falling back to the active company currency when null). */
const formatInCurrency = (amount, currency) => money(amount, currency?.name ?? null, currency ?? null);
const fmtDate = (value) => display(null, { type: 'date' }, value);

/** Whether a rule acts as a quick-action writeoff button for manual execution in the widget. */
const isWriteoffButtonModel = (rule) => Boolean(rule && !isMatchingRule(rule) && !isAutoRule(rule));

const TABS = [
  { id: 'candidates', label: 'Counterpart Candidates' },
  { id: 'payments', label: 'Outstanding Payments' },
  { id: 'manual', label: 'Manual Operation' },
];

/** Read optional journal query parameter from the active hash route. */
function initialJournalFromHash() {
  const query = (globalThis.location?.hash ?? '').split('?')[1] ?? '';
  const id = Number(new URLSearchParams(query).get('journal'));
  return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

/** Two-pane bank reconciliation workspace matching statement lines against candidates, payments, or manual entries. */
export function BankReconcile() {
  const storeDb = useDb();
  const db = companyViewDb(storeDb);
  const [journalFilter, setJournalFilter] = useState(initialJournalFromHash);
  const [selectedLineId, setSelectedLineId] = useState(null);
  const [activeTab, setActiveTab] = useState('candidates');
  const [selectedCandidateId, setSelectedCandidateId] = useState(null);
  const [selectedPaymentIds, setSelectedPaymentIds] = useState([]);
  const [manualAccountId, setManualAccountId] = useState('');
  const [manualLabel, setManualLabel] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [writeoffAccountId, setWriteoffAccountId] = useState('');
  const [writeoffLabel, setWriteoffLabel] = useState('');
  const [writeoffAmount, setWriteoffAmount] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const journals = useMemo(
    () => companyFilter(db, search(db, 'account.journal').filter((j) => isLiquidityJournal(j)), 'account.journal'),
    [db],
  );

  const openLines = useMemo(
    () => companyFilter(db, search(db, 'account.bank.statement.line'), 'account.bank.statement.line')
      .filter((l) => l.state === 'to_check' && (!journalFilter || String(l.journal_id) === journalFilter))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id),
    [db, journalFilter],
  );

  const selectedLine = useMemo(
    () => openLines.find((l) => l.id === selectedLineId) ?? openLines[0] ?? null,
    [openLines, selectedLineId],
  );

  const selectedLineKey = selectedLine?.id ?? null;
  const selectedCounterpartId = selectedLine?.counterpart_account_id ? String(selectedLine.counterpart_account_id) : '';
  const selectedPaymentRef = selectedLine?.payment_ref ?? '';
  const selectedOpenAmount = selectedLine ? (selectedLine.open_amount ?? statementCompanyAmount(db, selectedLine)) : null;

  // Synchronize manual form defaults whenever the active statement line changes.
  useEffect(() => {
    if (selectedLineKey == null) return;
    setSelectedCandidateId(null);
    setSelectedPaymentIds([]);
    setManualAccountId(selectedCounterpartId);
    setManualLabel(selectedPaymentRef);
    setManualAmount(selectedOpenAmount != null ? String(selectedOpenAmount) : '');
    setWriteoffAccountId('');
    setWriteoffLabel('');
    setWriteoffAmount('');
    setError('');
  }, [selectedLineKey, selectedCounterpartId, selectedPaymentRef, selectedOpenAmount]);

  const candidateMoves = useMemo(
    () => (selectedLine ? candidates(db, selectedLine) : []),
    [db, selectedLine],
  );

  const outstandingPayments = useMemo(
    () => (selectedLine ? eligiblePayments(db, selectedLine) : []),
    [db, selectedLine],
  );

  const counterpartAccounts = useMemo(() => {
    if (!selectedLine) return [];
    const company = selectedLine.company_id ?? 1;
    return (db.records['account.account'] ?? []).filter((a) => eligibleCounterpart(a, company));
  }, [db, selectedLine]);

  const partners = useMemo(
    () => companyFilter(db, search(db, 'res.partner'), 'res.partner')
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [db],
  );

  const quickActionModels = useMemo(() => {
    if (!selectedLine) return [];
    const lineCompany = selectedLine.company_id ?? 1;
    const allModels = companyFilter(db, search(db, 'account.reconcile.model'), 'account.reconcile.model');
    return allModels
      .filter((r) => r.active !== false
        && (!r.company_id || r.company_id === lineCompany)
        && (!Array.isArray(r.match_journal_ids) || r.match_journal_ids.length === 0 || r.match_journal_ids.includes(selectedLine.journal_id))
        && isWriteoffButtonModel(r))
      .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0) || (a.id ?? 0) - (b.id ?? 0));
  }, [db, selectedLine]);

  const selectLine = (line) => {
    setSelectedLineId(line.id);
    setError('');
  };

  const handlePartnerChange = async (partnerId) => {
    if (!selectedLine) return;
    setError('');
    setBusy(true);
    try {
      const currentDb = getDb();
      const nextDb = setStatementLinePartner(currentDb, selectedLine.id, partnerId ? Number(partnerId) : null);
      await commit(nextDb);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleApplyModel = async (model) => {
    if (!selectedLine) return;
    setError('');
    setBusy(true);
    try {
      const currentDb = getDb();
      const freshLine = read(currentDb, 'account.bank.statement.line', selectedLine.id);
      if (!freshLine || freshLine.state !== 'to_check') {
        throw new Error('This bank transaction is already reconciled');
      }
      const nextDb = applyRule(currentDb, model, freshLine);
      const res = await commit(nextDb);
      if (res.ok) {
        setSelectedLineId(null);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const togglePaymentSelection = (paymentId) => {
    setSelectedPaymentIds((prev) => (prev.includes(paymentId) ? prev.filter((id) => id !== paymentId) : [...prev, paymentId]));
  };

  const lineWriteoffFields = (line) => {
    if (!writeoffAccountId && !writeoffLabel && !writeoffAmount) return line;
    return {
      ...line,
      writeoff_account_id: writeoffAccountId ? Number(writeoffAccountId) : null,
      writeoff_label: writeoffLabel,
      writeoff_amount: writeoffAmount !== '' ? Number(writeoffAmount) : null,
    };
  };

  /** Validate the active reconciliation tab using the canonical bank reconciliation functions. */
  const validate = async () => {
    if (!selectedLine) return;
    setError('');
    setBusy(true);
    try {
      const currentDb = getDb();
      const freshLine = read(currentDb, 'account.bank.statement.line', selectedLine.id);
      if (!freshLine || freshLine.state !== 'to_check') {
        throw new Error('This bank transaction is already reconciled');
      }
      let nextDb;
      if (activeTab === 'candidates') {
        const chosenId = selectedCandidateId ?? candidateMoves[0]?.id;
        if (!chosenId) throw new Error('Select a counterpart candidate to reconcile');
        nextDb = reconcileWith(currentDb, lineWriteoffFields(freshLine), chosenId);
      } else if (activeTab === 'payments') {
        if (!selectedPaymentIds.length) throw new Error('Select at least one outstanding payment to match');
        const prepared = lineWriteoffFields({
          ...freshLine,
          payment_id: selectedPaymentIds.length === 1 ? selectedPaymentIds[0] : null,
          payment_ids: selectedPaymentIds,
        });
        nextDb = matchPayment(currentDb, prepared).db;
      } else {
        if (!manualAccountId) throw new Error('Select a counterpart account for the manual operation');
        const amountNum = manualAmount === '' ? null : Number(manualAmount);
        nextDb = bookToAccount(currentDb, {
          ...freshLine,
          counterpart_account_id: Number(manualAccountId),
        }, { label: manualLabel, amount: amountNum }).db;
      }
      const res = await commit(nextDb);
      if (res.ok) {
        setSelectedLineId(null);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const partnerName = (id) => (id ? read(db, 'res.partner', id)?.name ?? '' : '');
  const journalName = (id) => (id ? read(db, 'account.journal', id)?.name ?? '' : '');
  const openBalance = (line) => (Number(line.amount) < 0 ? -1 : 1) * (line.open_amount ?? statementCompanyAmount(db, line));

  /** Accessible name for a bank reconciliation line item. */
  const lineAriaLabel = (label, partner, amount) => (partner
    ? t('{label}, {partner}, {amount}', { label, partner, amount })
    : t('{label}, {amount}', { label, amount }));

  const selectedLineCurrency = selectedLine
    ? documentCurrency(db, {
      ...selectedLine,
      currency_id: read(db, 'account.journal', selectedLine.journal_id)?.currency_id ?? selectedLine.currency_id,
    })
    : null;

  return (
    <div className="page bank-reconcile-page">
      <div className="control-panel">
        <h1>{t('Bank Reconciliation')}</h1>
        <label className="inline-select">
          {t('Journal')}
          <select aria-label={t('Journal')} value={journalFilter} onChange={(e) => { setJournalFilter(e.target.value); setSelectedLineId(null); }}>
            <option value="">{t('All Journals')}</option>
            {journals.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </label>
        <a className="btn sm" href="#/accounting/bank">{t('Bank Transactions')}</a>
      </div>

      <div className="bank-reconcile-layout">
        <section className="panel bank-reconcile-left" aria-label={t('Unreconciled Transactions')}>
          <h2>{t('Unreconciled Transactions')}</h2>
          {openLines.length === 0 ? (
            <p className="muted">{t('All bank transactions are reconciled.')}</p>
          ) : (
            <div className="bank-reconcile-lines">
              {openLines.map((line) => {
                const isSelected = selectedLine?.id === line.id;
                return (
                  <button
                    key={line.id}
                    type="button"
                    className={`bank-reconcile-line-item${isSelected ? ' active' : ''}`}
                    aria-pressed={isSelected}
                    aria-label={lineAriaLabel(line.payment_ref || t('Statement Line'), partnerName(line.partner_id), formatInCurrency(openBalance(line), findCompanyCurrencyRecord(db, line.company_id ?? null)))}
                    onClick={() => selectLine(line)}
                  >
                    <div className="bank-reconcile-line-top">
                      <strong>{line.payment_ref || t('Statement Line')}</strong>
                      <span>{formatInCurrency(openBalance(line), findCompanyCurrencyRecord(db, line.company_id ?? null))}</span>
                    </div>
                    <div className="bank-reconcile-line-meta muted">
                      <span>{fmtDate(line.date)}</span>
                      <span>{journalName(line.journal_id)}</span>
                      {line.partner_id && <span>{partnerName(line.partner_id)}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel bank-reconcile-right" aria-label={t('Reconcile Line')}>
          {!selectedLine ? (
            <p className="muted">{t('Select a bank transaction on the left to reconcile.')}</p>
          ) : (
            <>
              <header className="bank-reconcile-summary">
                <div>
                  <h2>{selectedLine.payment_ref || t('Statement Line')}</h2>
                  <div className="bank-reconcile-line-meta muted">
                    <span>{fmtDate(selectedLine.date)} · {journalName(selectedLine.journal_id)}</span>
                    <label className="inline-select">
                      {t('Partner')}
                      <select
                        aria-label={t('Partner')}
                        disabled={busy}
                        value={selectedLine.partner_id ? String(selectedLine.partner_id) : ''}
                        onChange={(e) => handlePartnerChange(e.target.value)}
                      >
                        <option value="">{t('No Partner')}</option>
                        {partners.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                <div className="bank-reconcile-amounts">
                  <span>{t('Statement Amount')}: <strong>{formatInCurrency(selectedLine.amount, selectedLineCurrency)}</strong></span>
                  <span>{t('Open Balance')}: <strong>{formatInCurrency(openBalance(selectedLine), findCompanyCurrencyRecord(db, selectedLine.company_id ?? null))}</strong></span>
                </div>
              </header>

              {quickActionModels.length > 0 && (
                <div className="bank-reconcile-quick-actions" role="toolbar" aria-label={t('Quick Actions')}>
                  {quickActionModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => handleApplyModel(model)}
                    >
                      {model.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="tabs" role="tablist">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    onClick={() => { setActiveTab(tab.id); setError(''); }}
                  >
                    {t(tab.label)}
                  </button>
                ))}
              </div>

              <div className="tab-panel" role="tabpanel">
                {activeTab === 'candidates' && (
                  <div className="bank-reconcile-candidates">
                    {candidateMoves.length === 0 ? (
                      <p className="muted">{t('No open counterpart items match this statement line.')}</p>
                    ) : (
                      <div className="bank-reconcile-lines">
                        {candidateMoves.map((move) => {
                          const isSelected = selectedCandidateId === move.id;
                          const err = matchError(db, selectedLine, move);
                          return (
                            <button
                              key={move.id}
                              type="button"
                              className={`bank-reconcile-line-item${isSelected ? ' active' : ''}`}
                              aria-pressed={isSelected}
                              disabled={Boolean(err)}
                              aria-label={lineAriaLabel(move.name, partnerName(move.partner_id), formatInCurrency(move.amount_residual, documentCurrency(db, move)))}
                              onClick={() => setSelectedCandidateId(move.id)}
                            >
                              <div className="bank-reconcile-line-top">
                                <strong>{move.name}</strong>
                                <span>{formatInCurrency(move.amount_residual, documentCurrency(db, move))}</span>
                              </div>
                              <div className="bank-reconcile-line-meta muted">
                                <span>{fmtDate(move.invoice_date)}</span>
                                <span>{partnerName(move.partner_id)}</span>
                                {err && <span className="danger">{t(err)}</span>}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {candidateMoves.length > 0 && (
                      <div className="bank-reconcile-writeoff-fields">
                        <label htmlFor={`writeoff-account-${activeTab}`}>{t('Write-off Account')}</label>
                        <select id={`writeoff-account-${activeTab}`} aria-label={t('Write-off Account')} value={writeoffAccountId} onChange={(e) => setWriteoffAccountId(e.target.value)}>
                          <option value="">{t('None')}</option>
                          {counterpartAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                        </select>
                        {writeoffAccountId && <>
                          <label>{t('Write-off Label')} <input aria-label={t('Write-off Label')} value={writeoffLabel} onChange={(e) => setWriteoffLabel(e.target.value)} /></label>
                          <label>{t('Write-off Amount')} <input aria-label={t('Write-off Amount')} type="number" step="any" min="0" value={writeoffAmount} onChange={(e) => setWriteoffAmount(e.target.value)} /></label>
                        </>}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'payments' && (
                  <div className="bank-reconcile-payments">
                    {outstandingPayments.length === 0 ? (
                      <p className="muted">{t('No unmatched outstanding payments match this transaction.')}</p>
                    ) : (
                      <div className="bank-reconcile-lines">
                        {outstandingPayments.map((payment) => {
                          const isSelected = selectedPaymentIds.includes(payment.id);
                          return (
                            <button
                              key={payment.id}
                              type="button"
                              className={`bank-reconcile-line-item${isSelected ? ' active' : ''}`}
                              aria-pressed={isSelected}
                              aria-label={lineAriaLabel(payment.name, partnerName(payment.partner_id), formatInCurrency(payment.amount, documentCurrency(db, payment)))}
                              onClick={() => togglePaymentSelection(payment.id)}
                            >
                              <div className="bank-reconcile-line-top">
                                <strong>{payment.name}</strong>
                                <span>{formatInCurrency(payment.amount, documentCurrency(db, payment))}</span>
                              </div>
                              <div className="bank-reconcile-line-meta muted">
                                <span>{fmtDate(payment.date)}</span>
                                <span>{partnerName(payment.partner_id)}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {outstandingPayments.length > 0 && (
                      <div className="bank-reconcile-writeoff-fields">
                        <label htmlFor={`writeoff-account-${activeTab}`}>{t('Write-off Account')}</label>
                        <select id={`writeoff-account-${activeTab}`} aria-label={t('Write-off Account')} value={writeoffAccountId} onChange={(e) => setWriteoffAccountId(e.target.value)}>
                          <option value="">{t('None')}</option>
                          {counterpartAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                        </select>
                        {writeoffAccountId && <>
                          <label>{t('Write-off Label')} <input aria-label={t('Write-off Label')} value={writeoffLabel} onChange={(e) => setWriteoffLabel(e.target.value)} /></label>
                          <label>{t('Write-off Amount')} <input aria-label={t('Write-off Amount')} type="number" step="any" min="0" value={writeoffAmount} onChange={(e) => setWriteoffAmount(e.target.value)} /></label>
                        </>}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'manual' && (
                  <div className="bank-reconcile-manual">
                    <label>
                      {t('Counterpart Account')}
                      <select aria-label={t('Counterpart Account')} value={manualAccountId} onChange={(e) => setManualAccountId(e.target.value)}>
                        <option value="">{t('Select an account')}</option>
                        {counterpartAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                      </select>
                    </label>
                    <label>
                      {t('Label')}
                      <input aria-label={t('Label')} value={manualLabel} onChange={(e) => setManualLabel(e.target.value)} />
                    </label>
                    <label>
                      {t('Amount')}
                      <input aria-label={t('Amount')} type="number" step="any" min="0" value={manualAmount} onChange={(e) => setManualAmount(e.target.value)} />
                    </label>
                  </div>
                )}
              </div>

              {error && <p role="alert">{t(error)}</p>}
              <div className="control-panel">
                <button type="button" className="btn primary" disabled={busy} onClick={validate}>{t('Validate')}</button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
