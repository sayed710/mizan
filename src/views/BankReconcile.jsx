// Two-pane bank reconciliation widget: unreconciled statement lines on the left, matching/payment/manual tabs on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import { companyViewDb } from '../companyView.js';
import { read, search, unlink } from '../orm.js';
import { downloadCsv } from '../csv.js';
import { currentCompany, documentCompany } from '../models/company.js';
import { ReportPrintView } from './ReportPrintView.jsx';
import { commit, getDb, getUser, isServer, serverAction, useDb } from '../store.js';
import { companyFilter } from '../models/company.js';
import { isLiquidityJournal } from '../models/ledger.js';
import {
  batchLineTotal,
  bookToAccount,
  candidates,
  eligibleBatches,
  eligibleCounterpart,
  eligiblePayments,
  matchError,
  matchPayment,
  reconcileWith,
  setStatementLinePartner,
  setStatementLineReview,
  statementCounterpartAccount,
  unreconcile,
  statementCompanyAmount,
} from '../models/bank.js';
import { applyRule, autoReconcile, isWriteoffButtonModel, mapStatementPartner, ruleMatches, sameCommercialPartner } from '../models/reconcile.js';
import { statementCurrency, statementLineOrder } from '../models/bankstatement.js';
import { t } from '../i18n.js';
import { documentCurrency, findCompanyCurrencyRecord } from '../money.js';
import { display, menuKeys, money, useDismiss } from '../ui.jsx';

/** Format `amount` using `currency` (falling back to the active company currency when null). */
const formatInCurrency = (amount, currency) => money(amount, currency?.name ?? null, currency ?? null);
const fmtDate = (value) => display(null, { type: 'date' }, value);

const TABS = [
  { id: 'candidates', label: 'Counterpart Candidates' },
  { id: 'payments', label: 'Outstanding Payments' },
  { id: 'batches', label: 'Batches' },
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
  const [statementFilter, setStatementFilter] = useState('');
  const [selectedLineId, setSelectedLineId] = useState(null);
  const [activeTab, setActiveTab] = useState('candidates');
  const [selectedCandidateIds, setSelectedCandidateIds] = useState(() => new Set());
  const [selectedPaymentIds, setSelectedPaymentIds] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState(null);
  const [manualAccountId, setManualAccountId] = useState('');
  const [manualTaxIds, setManualTaxIds] = useState([]);
  const [manualLabel, setManualLabel] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [writeoffAccountId, setWriteoffAccountId] = useState('');
  const [writeoffLabel, setWriteoffLabel] = useState('');
  const [writeoffAmount, setWriteoffAmount] = useState('');
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showReconciled, setShowReconciled] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [modelsMenuOpen, setModelsMenuOpen] = useState(false);
  const modelsMenuRef = useRef(null);
  const manualAccountRef = useRef(null);
  const billUploadRef = useRef(null);
  useDismiss(modelsMenuOpen, () => setModelsMenuOpen(false), modelsMenuRef);

  const journals = useMemo(
    () => companyFilter(db, search(db, 'account.journal').filter((j) => isLiquidityJournal(j)), 'account.journal'),
    [db],
  );

  const statements = useMemo(
    () => companyFilter(db, search(db, 'account.bank.statement'), 'account.bank.statement')
      .filter((s) => !journalFilter || String(s.journal_id) === journalFilter)
      .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.id - a.id),
    [db, journalFilter],
  );

  const hasStatementFilter = Boolean(statementFilter && statements.some((s) => String(s.id) === statementFilter));

  const openLines = useMemo(
    () => companyFilter(db, search(db, 'account.bank.statement.line'), 'account.bank.statement.line')
      .filter((l) => (showReconciled || l.state === 'to_check')
        && (!journalFilter || String(l.journal_id) === journalFilter)
        && (!hasStatementFilter || String(l.statement_id) === statementFilter))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id - b.id),
    [db, journalFilter, hasStatementFilter, statementFilter, showReconciled],
  );

  const selectedLine = useMemo(
    () => openLines.find((l) => l.id === selectedLineId) ?? openLines[0] ?? null,
    [openLines, selectedLineId],
  );

  const selectedStatement = useMemo(() => {
    const id = hasStatementFilter ? Number(statementFilter) : selectedLine?.statement_id;
    return id ? read(db, 'account.bank.statement', id) : null;
  }, [db, selectedLine?.statement_id, hasStatementFilter, statementFilter]);

  const selectedLineKey = selectedLine?.id ?? null;
  const selectedCounterpartId = selectedLine?.counterpart_account_id ? String(selectedLine.counterpart_account_id) : '';
  const selectedPaymentRef = selectedLine?.payment_ref ?? '';
  const selectedOpenAmount = selectedLine ? (selectedLine.open_amount ?? statementCompanyAmount(db, selectedLine)) : null;

  // Synchronize manual form defaults whenever the active statement line changes.
  useEffect(() => {
    if (selectedLineKey == null) return;
    setSelectedCandidateIds(new Set());
    setSelectedPaymentIds([]);
    setSelectedBatchId(null);
    setManualAccountId(selectedCounterpartId);
    setManualTaxIds([]);
    setManualLabel(selectedPaymentRef);
    setManualAmount(selectedOpenAmount != null ? String(selectedOpenAmount) : '');
    setWriteoffAccountId('');
    setWriteoffLabel('');
    setWriteoffAmount('');
    setError('');
    setStatusMessage('');
  }, [selectedLineKey, selectedCounterpartId, selectedPaymentRef, selectedOpenAmount]);

  const statementRows = useMemo(() => selectedStatement ? companyFilter(db, search(db, 'account.bank.statement.line'), 'account.bank.statement.line')
    .filter((line) => line.statement_id === selectedStatement.id)
    .sort(statementLineOrder) : [], [db, selectedStatement]);

  const candidateMoves = useMemo(
    () => (selectedLine ? candidates(db, selectedLine) : []),
    [db, selectedLine],
  );

  const firstSelectedMove = useMemo(() => {
    for (const id of selectedCandidateIds) {
      const m = read(db, 'account.move', id);
      if (m) return m;
    }
    return null;
  }, [db, selectedCandidateIds]);

  const outstandingPayments = useMemo(
    () => (selectedLine ? eligiblePayments(db, selectedLine) : []),
    [db, selectedLine],
  );

  const batchPayments = useMemo(
    () => (selectedLine ? eligibleBatches(db, selectedLine) : []),
    [db, selectedLine],
  );

  const counterpartAccounts = useMemo(() => {
    if (!selectedLine) return [];
    const company = selectedLine.company_id ?? 1;
    return (db.records['account.account'] ?? []).filter((a) => eligibleCounterpart(a, company));
  }, [db, selectedLine]);

  const taxes = useMemo(() => {
    if (!selectedLine) return [];
    const company = selectedLine.company_id ?? 1;
    const expectedUse = (Number(selectedLine.amount) || 0) > 0 ? 'sale' : 'purchase';
    return (db.records['account.tax'] ?? [])
      .filter((t) => t.active !== false && (!t.company_id || t.company_id === company) && t.type_tax_use === expectedUse)
      .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0) || (a.name ?? '').localeCompare(b.name ?? ''));
  }, [db, selectedLine]);

  const partners = useMemo(() => {
    const lineCompany = selectedLine?.company_id ?? 1;
    const activePartners = (search(db, 'res.partner') ?? []).filter(
      (p) => !p.company_id || p.company_id === lineCompany,
    );
    const currentPartnerId = selectedLine?.partner_id;
    if (currentPartnerId && !activePartners.some((p) => p.id === currentPartnerId)) {
      const currentPartner = read(db, 'res.partner', currentPartnerId);
      if (currentPartner) {
        return [...activePartners, currentPartner].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
      }
    }
    return activePartners.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [db, selectedLine]);

  const quickActionModels = useMemo(() => {
    if (!selectedLine) return [];
    const mappedDb = mapStatementPartner(db, selectedLine);
    const lineForRules = read(mappedDb, 'account.bank.statement.line', selectedLine.id) ?? selectedLine;
    return (search(mappedDb, 'account.reconcile.model') ?? [])
      .filter((r) => isWriteoffButtonModel(r) && ruleMatches(r, lineForRules))
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
      // applyRule maps the partner first when the line has none.
      let nextDb = applyRule(currentDb, model, freshLine);
      if (freshLine.review_requested && read(nextDb, 'account.bank.statement.line', freshLine.id)?.bank_move_id) nextDb = setStatementLineReview(nextDb, freshLine.id, true);
      const res = await commit(nextDb);
      if (res.ok) {
        const afterLine = read(nextDb, 'account.bank.statement.line', selectedLine.id);
        if (!afterLine || afterLine.state === 'reconciled') {
          setSelectedLineId(null);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleCandidateSelection = (candidateId) => {
    setSelectedCandidateIds((prev) => {
      const next = new Set(prev);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
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
      writeoff_analytic_distribution: null,
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
        const chosenIds = selectedCandidateIds.size > 0
          ? Array.from(selectedCandidateIds)
          : (candidateMoves[0]?.id ? [candidateMoves[0].id] : []);
        if (!chosenIds.length) throw new Error('Select a counterpart candidate to reconcile');
        nextDb = reconcileWith(currentDb, lineWriteoffFields(freshLine), chosenIds.length === 1 ? chosenIds[0] : chosenIds);
      } else if (activeTab === 'payments') {
        if (!selectedPaymentIds.length) throw new Error('Select at least one outstanding payment to match');
        const prepared = lineWriteoffFields({
          ...freshLine,
          payment_id: selectedPaymentIds.length === 1 ? selectedPaymentIds[0] : null,
          payment_ids: selectedPaymentIds,
        });
        nextDb = matchPayment(currentDb, prepared).db;
      } else if (activeTab === 'batches') {
        if (!selectedBatchId) throw new Error('Select a batch payment to match');
        const prepared = lineWriteoffFields({
          ...freshLine,
          batch_payment_id: selectedBatchId,
        });
        nextDb = matchPayment(currentDb, prepared).db;
      } else {
        if (!manualAccountId) throw new Error('Select a counterpart account for the manual operation');
        const amountNum = manualAmount === '' ? null : Number(manualAmount);
        nextDb = bookToAccount(currentDb, {
          ...freshLine,
          counterpart_account_id: Number(manualAccountId),
        }, { label: manualLabel, amount: amountNum, tax_ids: manualTaxIds }).db;
      }
      if (freshLine.review_requested && read(nextDb, 'account.bank.statement.line', freshLine.id)?.bank_move_id) nextDb = setStatementLineReview(nextDb, freshLine.id, true);
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

  const runLineAction = async (action) => {
    if (!selectedLine) return;
    setError('');
    setBusy(true);
    try {
      const current = getDb();
      const line = read(current, 'account.bank.statement.line', selectedLine.id);
      if (!line) throw new Error('Bank transaction does not exist');
      let next = current;
      if (action === 'reset') {
        if (line.bank_move_id || line.state === 'reconciled') {
          const review = Boolean(read(current, 'account.move', line.bank_move_id)?.to_check);
          next = setStatementLineReview(unreconcile(current, line).db, line.id, review);
        }
        setManualAccountId(line.counterpart_account_id ? String(line.counterpart_account_id) : '');
        setManualTaxIds([]);
        setManualLabel(line.payment_ref ?? '');
        setManualAmount(String(line.open_amount ?? statementCompanyAmount(current, line)));
        setSelectedCandidateIds(new Set());
        setSelectedPaymentIds([]);
        setSelectedBatchId(null);
        setWriteoffAccountId('');
        setWriteoffLabel('');
        setWriteoffAmount('');
      } else if (action === 'delete') {
        if (!globalThis.confirm(t('Delete this bank transaction?'))) return;
        next = unlink(current, 'account.bank.statement.line', [line.id]);
      } else {
        next = setStatementLineReview(current, line.id, action === 'review');
      }
      const result = await commit(next);
      if (result.ok && action === 'delete') setSelectedLineId(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleAutoReconcile = async () => {
    const visibleIds = openLines.filter((l) => l.state === 'to_check').map((l) => l.id);
    if (!visibleIds.length) return;
    setError('');
    setStatusMessage('');
    setBusy(true);
    try {
      const currentDb = getDb();
      const nextDb = autoReconcile(currentDb, { lineIds: visibleIds });
      const res = await commit(nextDb);
      if (res.ok && selectedLine) {
        const afterLine = read(nextDb, 'account.bank.statement.line', selectedLine.id);
        if (!afterLine || afterLine.state === 'reconciled') setSelectedLineId(null);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleSetAccount = () => {
    setActiveTab('manual');
    setError('');
    manualAccountRef.current?.focus?.();
  };

  const handleUploadBills = () => {
    setError('');
    setStatusMessage('');
    if (!isServer() || !getUser()?.integrations?.ai) {
      setError('This needs the server with AI enabled');
      return;
    }
    billUploadRef.current?.click();
  };

  const handleBillFileChange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      setError('');
      setStatusMessage('');
      setBusy(true);
      try {
        const currentDb = getDb();
        const companyId = selectedLine?.company_id ?? currentCompany(currentDb)?.id ?? 1;
        const out = await serverAction('/api/integrations/digitize-new-bill', {
          company_id: companyId,
          ...(selectedLine?.partner_id ? { partner_id: selectedLine.partner_id } : {}),
          file: { name: f.name, type: f.type, data: String(reader.result).split(',')[1] },
        });
        if (out?.ok === false) throw new Error(out.error || 'Could not save changes');
        setStatusMessage(out?.message || t('Vendor bill created and digitized'));
      } catch (err) {
        setError(t(err instanceof Error ? err.message : String(err)));
      } finally {
        setBusy(false);
      }
    };
    reader.readAsDataURL(f);
  };

  const chooseCounterpart = (kind) => {
    try {
      const accountId = statementCounterpartAccount(getDb(), selectedLine, kind);
      setManualAccountId(String(accountId));
      setManualTaxIds([]);
      setActiveTab('manual');
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };

  const partnerName = (id) => (id ? read(db, 'res.partner', id)?.name ?? '' : '');
  const journalName = (id) => (id ? read(db, 'account.journal', id)?.name ?? '' : '');
  const openBalance = (line) => line.state === 'reconciled' ? 0 : (Number(line.amount) < 0 ? -1 : 1) * (line.open_amount ?? statementCompanyAmount(db, line));

  /** Accessible name for a bank reconciliation line item. */
  const lineAriaLabel = (label, partner, amount) => (partner
    ? t('{label}, {partner}, {amount}', { label, partner, amount })
    : t('{label}, {amount}', { label, amount }));

  const needsReview = selectedLine?.bank_move_id ? Boolean(read(db, 'account.move', selectedLine.bank_move_id)?.to_check) : Boolean(selectedLine?.review_requested);

  const selectedLineCurrency = selectedLine
    ? documentCurrency(db, {
      ...selectedLine,
      currency_id: read(db, 'account.journal', selectedLine.journal_id)?.currency_id ?? selectedLine.currency_id,
    })
    : null;

  const partnerQuery = selectedLine?.partner_id ? `&rel=partner_id:${selectedLine.partner_id}` : '';
  const salesHref = `#/accounting/invoices?view=list&filter=unpaid${partnerQuery}`;
  const purchasesHref = `#/accounting/bills?view=list&filter=unpaid${partnerQuery}`;
  const hasOpenVisible = openLines.some((l) => l.state === 'to_check');

  const writeoffFieldsBlock = (
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
  );

  const statementExportRows = selectedStatement ? [
    [t('Statement'), selectedStatement.name],
    [t('Starting Balance'), selectedStatement.balance_start ?? 0],
    [t('Ending Balance'), selectedStatement.balance_end_real ?? 0],
    [t('Date'), t('Label'), t('Partner'), t('Reference'), t('Amount'), t('Status')],
    ...statementRows.map((line) => [line.date, line.payment_ref, partnerName(line.partner_id), line.ref, Number(line.amount), t(line.state === 'reconciled' ? 'Matched' : 'Not Matched')]),
  ] : [];
  if (isPrinting && selectedStatement) return <ReportPrintView active company={documentCompany(db, selectedStatement)} title={t('Bank Statement')} subtitle={selectedStatement.name} onBack={() => setIsPrinting(false)} autoPrint={false}>
    <p>{t('Starting Balance')}: {formatInCurrency(selectedStatement.balance_start, statementCurrency(db, selectedStatement))} · {t('Ending Balance')}: {formatInCurrency(selectedStatement.balance_end_real, statementCurrency(db, selectedStatement))}</p>
    <div className="list-wrap"><table className="list report"><thead><tr>{statementExportRows[3].map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{statementExportRows.slice(4).map((row, index) => <tr key={statementRows[index].id}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody></table></div>
  </ReportPrintView>;

  return (
    <div className="page bank-reconcile-page">
      <input ref={billUploadRef} type="file" accept="image/*,application/pdf" hidden onChange={handleBillFileChange} />
      <div className="control-panel">
        <h1>{t('Bank Reconciliation')}</h1>
        <label className="inline-select">
          {t('Journal')}
          <select aria-label={t('Journal')} value={journalFilter} onChange={(e) => { setJournalFilter(e.target.value); setStatementFilter(''); setSelectedLineId(null); }}>
            <option value="">{t('All Journals')}</option>
            {journals.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
        </label>
        <label className="inline-select">
          {t('Statement')}
          <select aria-label={t('Statement')} value={statementFilter} onChange={(e) => { setStatementFilter(e.target.value); setSelectedLineId(null); }}>
            <option value="">{t('All Statements')}</option>
            {statements.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={showReconciled} onChange={(e) => { setShowReconciled(e.target.checked); setSelectedLineId(null); }} /> {t('Show Reconciled')}</label>
        <button type="button" className="btn sm" disabled={busy || !hasOpenVisible} onClick={handleAutoReconcile}>{t('Auto-Reconcile')}</button>
        <button type="button" className="btn sm" disabled={!selectedStatement} onClick={() => setIsPrinting(true)}>{t('Print Statement')}</button>
        <button type="button" className="btn sm" disabled={!selectedStatement} onClick={() => downloadCsv('bank-statement.csv', statementExportRows)}>{t('Export Statement')}</button>
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
                        disabled={busy || selectedLine.state === 'reconciled'}
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
                {selectedStatement && (
                  <div className="bank-reconcile-statement-card">
                    <div className="bank-reconcile-statement-header">
                      <span>{t('Statement')}: <strong>{selectedStatement.name}</strong></span>
                      {!selectedStatement.is_valid && (
                        <span className="badge badge-danger">{t('Invalid')}</span>
                      )}
                      {!selectedStatement.is_complete && (
                        <span className="badge badge-warning">{t('Incomplete')}</span>
                      )}
                    </div>
                    <div className="bank-reconcile-statement-balances muted">
                      <span>{t('Starting Balance')}: <strong>{formatInCurrency(selectedStatement.balance_start, selectedLineCurrency)}</strong></span>
                      <span>{t('Ending Balance')}: <strong>{formatInCurrency(selectedStatement.balance_end, selectedLineCurrency)}</strong></span>
                      <span>{t('Real Ending Balance')}: <strong>{formatInCurrency(selectedStatement.balance_end_real, selectedLineCurrency)}</strong></span>
                    </div>
                  </div>
                )}
              </header>

              <div className="control-panel">
                <button type="button" className="btn sm" disabled={busy} onClick={() => runLineAction('reset')}>{t('Reset')}</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => runLineAction(needsReview ? 'checked' : 'review')}>{t(needsReview ? 'Set as Checked' : 'To Check')}</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => runLineAction('delete')}>{t('Delete line')}</button>
              </div>
              {selectedLine.state !== 'reconciled' && <div className="control-panel">
                <button type="button" className="btn sm" disabled={busy} onClick={() => chooseCounterpart('receivable')}>{t('Receivable')}</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => chooseCounterpart('payable')}>{t('Payable')}</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => chooseCounterpart('transfer')}>{t('Internal Transfer')}</button>
                <button type="button" className="btn sm" disabled={busy} onClick={handleSetAccount}>{t('Set Account')}</button>
                <a className="btn sm" href={salesHref}>{t('Sales')}</a>
                <a className="btn sm" href={purchasesHref}>{t('Purchases')}</a>
                <button type="button" className="btn sm" disabled={busy} onClick={() => { setActiveTab('batches'); setError(''); }}>{t('Batches')}</button>
                <button type="button" className="btn sm" disabled={busy} onClick={handleUploadBills}>{t('Upload bills')}</button>
              </div>}
              {selectedLine.state !== 'reconciled' && (
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
                  <div className="nav-group actions-menu" ref={modelsMenuRef}>
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={t('More')}
                      aria-haspopup="menu"
                      aria-expanded={modelsMenuOpen}
                      onClick={() => setModelsMenuOpen((v) => !v)}
                    >
                      ⋯
                    </button>
                    {modelsMenuOpen && (
                      <div className="nav-dropdown" role="menu" onKeyDown={menuKeys}>
                        <a role="menuitem" href="#/accounting/reconcile-models" onClick={() => setModelsMenuOpen(false)}>
                          {t('Manage Models')}
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedLine.state !== 'reconciled' && <>
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
                          const isSelected = selectedCandidateIds.has(move.id);
                          const err = matchError(db, selectedLine, move);
                          const partnerMismatch = Boolean(firstSelectedMove && !sameCommercialPartner(db, firstSelectedMove.partner_id, move.partner_id));
                          return (
                            <button
                              key={move.id}
                              type="button"
                              className={`bank-reconcile-line-item${isSelected ? ' active' : ''}`}
                              aria-pressed={isSelected}
                              disabled={Boolean(err || (!isSelected && partnerMismatch))}
                              aria-label={lineAriaLabel(move.name, partnerName(move.partner_id), formatInCurrency(move.amount_residual, documentCurrency(db, move)))}
                              onClick={() => toggleCandidateSelection(move.id)}
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
                    {candidateMoves.length > 0 && writeoffFieldsBlock}
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
                    {outstandingPayments.length > 0 && writeoffFieldsBlock}
                  </div>
                )}

                {activeTab === 'batches' && (
                  <div className="bank-reconcile-batches">
                    {batchPayments.length === 0 ? (
                      <p className="muted">{t('No unmatched batch payments match this transaction.')}</p>
                    ) : (
                      <div className="bank-reconcile-lines">
                        {batchPayments.map((batch) => {
                          const isSelected = selectedBatchId === batch.id;
                          const activeLines = (batch.lines ?? []).filter((l) => !l.cancelled && l.payment_id);
                          const total = batchLineTotal(db, batch);
                          const firstPayment = activeLines[0]?.payment_id ? read(db, 'account.payment', activeLines[0].payment_id) : null;
                          const batchCurr = documentCurrency(db, {
                            ...batch,
                            currency_id: batch.currency_id ?? read(db, 'account.journal', batch.journal_id)?.currency_id ?? firstPayment?.currency_id,
                          });
                          return (
                            <button
                              key={batch.id}
                              type="button"
                              className={`bank-reconcile-line-item${isSelected ? ' active' : ''}`}
                              aria-pressed={isSelected}
                              aria-label={lineAriaLabel(batch.name, journalName(batch.journal_id), formatInCurrency(total, batchCurr))}
                              onClick={() => setSelectedBatchId((prev) => (prev === batch.id ? null : batch.id))}
                            >
                              <div className="bank-reconcile-line-top">
                                <strong>{batch.name}</strong>
                                <span>{formatInCurrency(total, batchCurr)}</span>
                              </div>
                              <div className="bank-reconcile-line-meta muted">
                                <span>{fmtDate(batch.date)}</span>
                                {batch.journal_id && <span>{journalName(batch.journal_id)}</span>}
                                <span>{t('{n} payment(s)', { n: activeLines.length })}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {batchPayments.length > 0 && writeoffFieldsBlock}
                  </div>
                )}

                {activeTab === 'manual' && (
                  <div className="bank-reconcile-manual">
                    <label>
                      {t('Counterpart Account')}
                      <select ref={manualAccountRef} aria-label={t('Counterpart Account')} value={manualAccountId} onChange={(e) => setManualAccountId(e.target.value)}>
                        <option value="">{t('Select an account')}</option>
                        {manualAccountId && !counterpartAccounts.some((a) => String(a.id) === manualAccountId) && <option value={manualAccountId}>{read(db, 'account.account', Number(manualAccountId))?.name}</option>}
                        {counterpartAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                      </select>
                    </label>
                    <label>
                      {t('Taxes')}
                      <select
                        multiple
                        aria-label={t('Taxes')}
                        value={manualTaxIds.map(String)}
                        onChange={(e) => {
                          const options = e.target.selectedOptions
                            ? Array.from(e.target.selectedOptions)
                            : (Array.isArray(e.target.value) ? e.target.value.map((v) => ({ value: v })) : [{ value: e.target.value }]);
                          const selected = options.map((o) => Number(o.value)).filter(Boolean);
                          setManualTaxIds(selected);
                        }}
                      >
                        {taxes.map((tx) => <option key={tx.id} value={tx.id}>{tx.name}</option>)}
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

              <div className="control-panel">
                <button type="button" className="btn primary" disabled={busy} onClick={validate}>{t('Validate')}</button>
              </div>
              </>}
              {statusMessage && <p role="status">{statusMessage}</p>}
              {error && <p role="alert">{t(error)}</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
