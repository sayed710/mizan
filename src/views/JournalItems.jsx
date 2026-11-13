import { Fragment, useState } from 'react';
import { companyViewDb } from '../companyView.js';
import { analyticEligibleAccount, isLiquidityJournal, isReconcilableAccount, journalItems, matchedMoveIds } from '../models/ledger.js';
import { hasMultiCurrency, reportingBookedOrNull } from '../models/money.js';
import { RateNote } from './RateNote.jsx';
import { read } from '../orm.js';
import { commit, companiesOf, getDb, useDb } from '../store.js';
import { reconcileJournalItems, unreconcileJournalItems, writeoffJournalItem } from '../models/pay.js';
import { monthFilters, parseAmount, today } from '../models/common.js';
import { money, OptionalColsMenu, useOptionalColumns } from '../ui.jsx';
import { t } from '../i18n.js';
import { companyCurrencyRecord, findCompanyCurrencyRecord, roundCurrency } from '../money.js';

const OPTIONAL_STORAGE_KEY = 'mizan-report-cols:journalItems';

const ITEM_COLUMNS = [
  { key: 'invoice_date', label: 'Invoice Date', optional: 'hide' },
  { key: 'date', label: 'Date', optional: false },
  { key: 'company_id', label: 'Company', optional: 'hide', multiCompanyOnly: true },
  { key: 'journal_id', label: 'Journal', optional: 'hide' },
  { key: 'move_id', label: 'Journal Entry', optional: false },
  { key: 'account_id', label: 'Account', optional: false },
  { key: 'partner_id', label: 'Partner', optional: 'show' },
  { key: 'ref', label: 'Reference', optional: 'hide' },
  { key: 'product_id', label: 'Product', optional: 'hide' },
  { key: 'name', label: 'Label', optional: 'show' },
  { key: 'analytic_distribution', label: 'Analytic Distribution', optional: 'hide' },
  { key: 'taxes', label: 'Taxes', optional: 'hide' },
  { key: 'amount_currency', label: 'In Currency', numeric: true, optional: 'hide', multiCurrencyOnly: true },
  { key: 'currency_id', label: 'Currency', optional: 'hide', multiCurrencyOnly: true },
  { key: 'debit', label: 'Debit', numeric: true, optional: false, sum: 'Total Debit' },
  { key: 'credit', label: 'Credit', numeric: true, optional: false, sum: 'Total Credit' },
  { key: 'tax_grids', label: 'Tax Grids', optional: 'hide' },
  { key: 'discount_date', label: 'Discount Date', optional: 'hide' },
  { key: 'discount_amount_currency', label: 'Discount Amount', numeric: true, optional: 'hide' },
  { key: 'tax_line_id', label: 'Originator Tax', optional: 'hide' },
  { key: 'date_maturity', label: 'Due Date', optional: 'hide' },
  { key: 'balance', label: 'Balance', numeric: true, optional: 'hide', sum: 'Total Balance' },
  { key: 'matching', label: 'Matching', optional: 'show' },
  { key: 'amount_residual', label: 'Residual', numeric: true, optional: 'hide', sum: 'Total Residual' },
  { key: 'amount_residual_currency', label: 'Residual in Currency', numeric: true, optional: 'hide', multiCurrencyOnly: true },
];

const GROUP_OPTIONS = [
  { key: 'move', label: 'Journal Entry' },
  { key: 'account', label: 'Account' },
  { key: 'partner', label: 'Partner' },
  { key: 'journal', label: 'Journal' },
  { key: 'date', label: 'Date' },
  { key: 'invoice_date', label: 'Invoice Date' },
  { key: 'taxes', label: 'Taxes' },
  { key: 'tax_grids', label: 'Tax Grid' },
  { key: 'matching', label: 'Matching' },
];

const isProfitAndLoss = (account) => analyticEligibleAccount(account) || ['expense_depreciation'].includes(account?.account_type);

const ITEM_FILTER_GROUPS = [
  [
    { id: 'unposted', label: 'Unposted', fn: (line) => line.move_state === 'draft' },
    { id: 'posted', label: 'Posted', fn: (line) => line.move_state === 'posted' },
  ],
  [
    { id: 'not_secured', label: 'Not Secured', fn: (line) => line.move_state === 'posted' && !line.inalterable_hash },
  ],
  [
    { id: 'unreconciled', label: 'Unreconciled', fn: (line) => isReconcilableAccount(line._account) && line.reconciled !== true && Math.abs(line.balance) > 1e-9 },
    { id: 'with_residual', label: 'With residual', fn: (line) => isReconcilableAccount(line._account) && Math.abs(line.amount_residual ?? 0) > 1e-9 },
  ],
  [
    { id: 'sales', label: 'Sales', fn: (line) => line._journal?.type === 'sale' },
    { id: 'purchases', label: 'Purchases', fn: (line) => line._journal?.type === 'purchase' },
    { id: 'bank', label: 'Bank', fn: (line) => line._journal?.type === 'bank' },
    { id: 'cash', label: 'Cash', fn: (line) => line._journal?.type === 'cash' },
    { id: 'credit', label: 'Credit', fn: (line) => line._journal?.type === 'credit' },
    { id: 'misc', label: 'Miscellaneous', fn: (line) => line._journal?.type === 'general' },
  ],
  [
    { id: 'payable', label: 'Payable', fn: (line) => line._account?.account_type === 'liability_payable' },
    { id: 'receivable', label: 'Receivable', fn: (line) => line._account?.account_type === 'asset_receivable' },
    { id: 'pl', label: 'P&L Accounts', fn: (line) => isProfitAndLoss(line._account) },
  ],
  monthFilters('date', 'Date'),
  monthFilters('invoice_date', 'Invoice Date'),
];

const defaultFiltersForMode = (mode) => (mode === 'draft' ? ['unposted'] : mode === 'unreconciled' ? ['posted', 'unreconciled'] : ['posted']);

function formatMonthLabel(monthKey) {
  if (!monthKey) return t('Undefined');
  return new Date(`${monthKey}-01T00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function lineIds(line, key, altKey = null) {
  const raw = line[key] ?? (altKey ? line[altKey] : null);
  return Array.isArray(raw) ? raw.filter(Boolean) : (raw ? [raw] : []);
}

function formatAnalyticDistribution(db, line) {
  const entries = line.analytic_distribution && typeof line.analytic_distribution === 'object'
    ? Object.entries(line.analytic_distribution)
    : line.analytic_account_id
      ? [[line.analytic_account_id, 100]]
      : [];
  return entries
    .map(([id, pct]) => {
      const acc = read(db, 'account.analytic.account', Number(id));
      const label = acc?.name ?? String(id);
      return `${label}: ${pct}%`;
    })
    .join(', ');
}

function resolveLineTaxInfo(db, line, move) {
  const isTaxLine = (line.tax_id != null || Boolean(line.tax_name)) && !line.tax_zero && !line.tax_grid_base;
  if (isTaxLine) {
    return {
      taxIds: [],
      taxes: '',
      originatorTax: read(db, 'account.tax', line.tax_id)?.name ?? line.tax_name ?? '',
    };
  }
  const explicitIds = lineIds(line, 'tax_ids', line.tax_zero ? 'tax_id' : null);
  const collected = new Set(explicitIds);
  if (!collected.size && line.invoice_sources?.length && move?.invoice_line_ids?.length) {
    const sourceSet = new Set(line.invoice_sources.map((s) => s.line_id).filter(Boolean));
    for (const invLine of move.invoice_line_ids) {
      if (sourceSet.size && !sourceSet.has(invLine.id)) continue;
      for (const tid of lineIds(invLine, 'tax_ids', 'tax_id')) collected.add(tid);
    }
  }
  const taxIds = [...collected];
  const resolvedNames = taxIds.map((id) => read(db, 'account.tax', id)?.name).filter(Boolean).join(', ');
  return {
    taxIds,
    taxes: resolvedNames || (line.tax_zero && line.tax_name ? line.tax_name : ''),
    originatorTax: '',
  };
}

function matchesItemSearch(line, rawQuery) {
  const trimmed = rawQuery.trim();
  if (!trimmed) return true;
  const q = trimmed.toLowerCase();
  const parsedAmount = parseAmount(trimmed);
  if (Number.isFinite(parsedAmount)) {
    const d = Number(line.debit) || 0;
    const c = Number(line.credit) || 0;
    if (Math.abs(d - parsedAmount) < 1e-9 || Math.abs(c - parsedAmount) < 1e-9) return true;
  }
  return [line.name, line.ref, line.account, line._account?.display_name, line.partner, line.move_name]
    .some((value) => String(value ?? '').toLowerCase().includes(q));
}

function groupKeyForLine(line, group) {
  if (group === 'date') return line.date ? line.date.slice(0, 7) : '';
  if (group === 'invoice_date') return line.invoice_date ? line.invoice_date.slice(0, 7) : '';
  if (group === 'taxes') return line.taxKey;
  if (group === 'tax_grids') return line.gridKey;
  if (group === 'matching') return line.matchingText;
  if (group) return line[`${group}_id`] ?? null;
  return null;
}

function cellClassName(col, line, todayDate) {
  const classes = [];
  if (col.numeric) classes.push('num');
  if ((col.key === 'debit' || col.key === 'credit') && Math.abs(Number(line[col.key]) || 0) < 1e-9) classes.push('muted');
  if (col.key === 'date_maturity' && line.date_maturity && !line.reconciled && line.date_maturity < todayDate) classes.push('danger');
  return classes.length ? classes.join(' ') : undefined;
}

export function JournalItems({ leaf = {} } = {}) {
  const db = companyViewDb(useDb());
  const mode = leaf.reviewMode ?? 'posted';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [activeFilters, setActiveFilters] = useState(() => defaultFiltersForMode(mode));
  const [optionalState, isVisible, toggleCol] = useOptionalColumns(OPTIONAL_STORAGE_KEY);
  const [selected, setSelected] = useState([]);
  const [action, setAction] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [journalId, setJournalId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyOf = (line) => JSON.stringify([line.move_id, line.line_identity]);
  const toggleFilter = (id) => setActiveFilters((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const run = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const visible = new Set(journalItems(companyViewDb(getDb())).map(keyOf));
      if (selected.some((item) => !visible.has(keyOf(item)))) throw new Error('The selected items are no longer visible; refresh the selection');
      const execute = { Reconcile: reconcileJournalItems, Unreconcile: unreconcileJournalItems, 'Write Off': writeoffJournalItem }[action];
      const result = execute(getDb(), selected, { date, amount: amount === '' ? null : Number(amount), journalId: Number(journalId), accountId: Number(accountId), label });
      if ((await commit(result)).ok) { setSelected([]); setAction(''); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const name = (model, id) => read(db, model, id)?.name ?? '';
  const names = (model, ids) => ids.map((id) => name(model, id)).filter(Boolean).join(', ');
  const title = mode === 'unreconciled' ? 'Unreconciled' : mode === 'draft' ? 'Draft Entries' : 'Journal Items';
  // The account form's Balance button opens this report scoped to that account (#/...?account=ID),
  // and Reconciled items smart button scopes it to the matched reconciliation set (#/...?reconciled_of=ID).
  const hashParams = new URLSearchParams((globalThis.location?.hash ?? '').split('?')[1] ?? '');
  const accountFilter = Number(hashParams.get('account')) || null;
  const reconciledOf = Number(hashParams.get('reconciled_of')) || null;
  // Same company scope as accountBalance: the account's company, else the reconciled move's, else current one.
  const filterAccount = accountFilter ? read(db, 'account.account', accountFilter) : null;
  const filterMove = reconciledOf ? read(db, 'account.move', reconciledOf) : null;
  const filterCompany = filterAccount
    ? (filterAccount.company_id ?? db.settings?.current_company_id ?? 1)
    : filterMove
      ? (filterMove.company_id ?? db.settings?.current_company_id ?? 1)
      : null;
  const matchedMoves = reconciledOf ? matchedMoveIds(db, reconciledOf) : null;
  const multiCompany = companiesOf(db).length > 1;
  const multiCurrency = hasMultiCurrency(db);
  const enriched = journalItems(db, { from, to, reviewMode: 'all', ...(filterCompany ? { company_id: filterCompany } : {}) })
    .filter((line) => (!accountFilter || line.account_id === accountFilter) && (!matchedMoves || (matchedMoves.has(line.move_id) && line.reconciled)))
    .map((line) => {
      const move = read(db, 'account.move', line.move_id);
      const lineCompanyCurr = findCompanyCurrencyRecord(db, line.company_id);
      const isForeign = Boolean(line.currency_id && lineCompanyCurr && line.currency_id !== lineCompanyCurr.id);
      const { taxIds, taxes, originatorTax } = resolveLineTaxInfo(db, line, move);
      const gridIds = lineIds(line, 'tax_tag_ids', 'tag_ids');
      const matchingText = line.matching_number ?? (line.reconciled ? t('Reconciled') : '');
      return {
        ...line,
        _account: read(db, 'account.account', line.account_id),
        _journal: read(db, 'account.journal', line.journal_id),
        _companyCurrency: lineCompanyCurr,
        _isForeign: isForeign,
        _currency: isForeign ? read(db, 'res.currency', line.currency_id) : null,
        account: name('account.account', line.account_id),
        partner: name('res.partner', line.partner_id),
        journal: name('account.journal', line.journal_id),
        product: name('product', line.product_id),
        analytic_distribution_label: formatAnalyticDistribution(db, line),
        taxKey: taxIds.slice().sort((a, b) => a - b).join(','),
        taxes,
        originator_tax: originatorTax,
        gridKey: gridIds.slice().sort((a, b) => a - b).join(','),
        tax_grids: names('account.account.tag', gridIds),
        matchingText,
        company: name('res.company', line.company_id),
        balance: (Number(line.debit) || 0) - (Number(line.credit) || 0),
      };
    });
  const activeGroups = ITEM_FILTER_GROUPS
    .map((g) => g.filter((f) => activeFilters.includes(f.id)))
    .filter((g) => g.length);
  const rows = enriched
    .filter((line) => activeGroups.every((g) => g.some((f) => f.fn(line))))
    .filter((line) => matchesItemSearch(line, query));

  const groups = new Map();
  for (const line of rows) {
    const key = groupKeyForLine(line, group);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  const groupTitle = (key, lines) => {
    if (group === 'move') return lines[0].move_name || t('Undefined');
    if (group === 'date' || group === 'invoice_date') return formatMonthLabel(key);
    if (group === 'taxes') return lines[0].taxes || t('Undefined');
    if (group === 'tax_grids') return lines[0].tax_grids || t('Undefined');
    if (group === 'matching') return lines[0].matchingText || t('Undefined');
    return lines[0][group] || t('Undefined');
  };

  const availableCols = ITEM_COLUMNS.filter((c) => (!c.multiCompanyOnly || multiCompany) && (!c.multiCurrencyOnly || multiCurrency));
  const visibleCols = availableCols.filter((c) => !c.optional || isVisible(c.key, c.optional !== 'hide'));
  const optionalCols = availableCols.filter((c) => c.optional);
  const sumCurrency = companyCurrencyRecord(db, filterCompany ?? db.settings?.current_company_id);
  // Lines of a company whose currency has no rate to the reporting currency are left out of the totals and counted.
  const unratedLines = rows.filter((l) => reportingBookedOrNull(db, l, 1) == null).length;
  const sumField = (lines, field) => roundCurrency(lines.reduce((acc, l) => acc + (reportingBookedOrNull(db, l, Number(l[field]) || 0) ?? 0), 0), sumCurrency);
  const totalDebit = sumField(rows, 'debit');
  const totalCredit = sumField(rows, 'credit');
  const totalBalance = roundCurrency(totalDebit - totalCredit, sumCurrency);
  const totalResidual = sumField(rows, 'amount_residual');
  const todayDate = today();

  const renderCell = (line, col) => {
    switch (col.key) {
      case 'invoice_date': return line.invoice_date ?? '';
      case 'date': return line.date ?? '';
      case 'company_id': return line.company;
      case 'journal_id': return line.journal;
      case 'move_id': return <a href={`#/accounting/entries/${line.move_id}`}>{line.move_name}</a>;
      case 'account_id': return line.account;
      case 'partner_id': return line.partner;
      case 'ref': return line.ref ?? '';
      case 'product_id': return line.product;
      case 'name': return line.name ?? '';
      case 'analytic_distribution': return line.analytic_distribution_label;
      case 'taxes': return line.taxes;
      case 'amount_currency': return line._isForeign && line.amount_currency != null ? money(line.amount_currency, null, line._currency) : '';
      case 'currency_id': return line._isForeign ? (line._currency?.name ?? '') : '';
      case 'debit': return money(line.debit || 0, null, line._companyCurrency);
      case 'credit': return money(line.credit || 0, null, line._companyCurrency);
      case 'tax_grids': return line.tax_grids;
      case 'discount_date': return line.discount_date ?? '';
      case 'discount_amount_currency': return line.discount_amount_currency != null ? money(line.discount_amount_currency, null, line._isForeign ? line._currency : line._companyCurrency) : '';
      case 'tax_line_id': return line.originator_tax;
      case 'date_maturity': return line.date_maturity ?? '';
      case 'balance': return money(line.balance, null, line._companyCurrency);
      case 'matching': return line.matchingText;
      case 'amount_residual': return line.amount_residual != null ? money(line.amount_residual, null, line._companyCurrency) : '';
      case 'amount_residual_currency': return line._isForeign && line.amount_residual_currency != null ? money(line.amount_residual_currency, null, line._currency) : '';
      default: return '';
    }
  };

  return <main className="action report-page">
    <div className="control-panel"><h1 className="cp-title">{t(title)}</h1>
      {accountFilter && <span className="facet">{t('Account')}: {read(db, 'account.account', accountFilter)?.display_name ?? read(db, 'account.account', accountFilter)?.name} <a href="#/accounting/journal-items" aria-label={t('Remove')}>×</a></span>}
      <label>{t('From')} <input aria-label={t('From')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>{t('To')} <input aria-label={t('To')} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label>{t('Search')} <input aria-label={t('Search')} placeholder={t('Journal Item')} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <label>{t('Group By')} <select aria-label={t('Group By')} value={group} onChange={(e) => setGroup(e.target.value)}>
        <option value="">{t('None')}</option>{GROUP_OPTIONS.map((opt) => <option key={opt.key} value={opt.key}>{t(opt.label)}</option>)}
      </select></label>
    </div>
    <div className="control-panel" role="group" aria-label={t('Filters')}>
      {ITEM_FILTER_GROUPS.map((grp, gi) => <Fragment key={gi}>
        {gi > 0 && <span className="filter-sep" aria-hidden="true">|</span>}
        {grp.map((f) => <button key={f.id} type="button" className={`btn sm${activeFilters.includes(f.id) ? ' active' : ''}`} aria-pressed={activeFilters.includes(f.id)} onClick={() => toggleFilter(f.id)}>{t(f.label)}</button>)}
      </Fragment>)}
    </div>
    {mode !== 'draft' && <div className="control-panel">
      <span>{t('{n} selected', { n: selected.length })}</span>
      {['Reconcile', 'Unreconcile', 'Write Off'].map((btn) => <button type="button" className="btn" key={btn} disabled={!selected.length || busy} onClick={() => { setAction(btn); setError(''); }}>{t(btn)}</button>)}
    </div>}
    {action && <form onSubmit={run} className="control-panel" aria-label={t(action)}>
      <h2>{t(action)}</h2>
      {action === 'Unreconcile' && <p>{t('This removes the matching: payments stay posted and their credit becomes available again. Write-offs and direct bank matches are reversed on the selected date.')}</p>}
      <label>{t('Date')} <input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {action !== 'Unreconcile' && <label>{t('Amount in Invoice Currency')} <input required={action === 'Write Off'} type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('Available balance')} /></label>}
      {action === 'Write Off' && <>
        <label>{t('Journal')} <select required value={journalId} onChange={(e) => setJournalId(e.target.value)}><option value="">{t('Select a journal')}</option>{(db.records['account.journal'] ?? []).filter((j) => isLiquidityJournal(j)).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}</select></label>
        <label>{t('Write-off Account')} <select required value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">{t('Select an account')}</option>{(db.records['account.account'] ?? []).filter((a) => a.active !== false && !a.deprecated && !['asset_receivable', 'liability_payable', 'off_balance'].includes(a.account_type)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>{t('Write-off Label')} <input required value={label} onChange={(e) => setLabel(e.target.value)} /></label>
      </>}
      <button className="btn primary" disabled={busy}>{t('Confirm')}</button><button type="button" className="btn" disabled={busy} onClick={() => setAction('')}>{t('Cancel')}</button>
      {error && <p role="alert">{t(error)}</p>}
    </form>}
    <div className="list-wrap"><table className="list report"><thead><tr><th>{t('Select')}</th>{visibleCols.map((col) => <th key={col.key} className={col.numeric ? 'num' : undefined}>{t(col.label)}</th>)}<th className="o2m-cols-th"><OptionalColsMenu items={optionalCols.map((c) => ({ key: c.key, label: c.label, defaultVisible: c.optional !== 'hide' }))} optionalState={optionalState} onToggle={toggleCol} /></th></tr></thead>
      <tbody>{[...groups.entries()].map(([key, lines]) => <Fragment key={String(key ?? 'none')}>
        {group && <tr className="group-row"><th /><th colSpan={visibleCols.length}>{groupTitle(key, lines)} <span className="count">({lines.length})</span></th><th /></tr>}
        {lines.map((line) => <tr key={keyOf(line)} className={line.move_state === 'draft' ? 'info' : undefined}>
          <td><input type="checkbox" aria-label={t('Select journal item {entry}: {account} — {label}', { entry: line.move_name, account: line.account, label: line.name })} disabled={line.move_state === 'draft' || busy} checked={selected.some((item) => keyOf(item) === keyOf(line))} onChange={(e) => setSelected(e.target.checked ? [...selected, { move_id: line.move_id, line_identity: line.line_identity }] : selected.filter((item) => keyOf(item) !== keyOf(line)))} /></td>
          {visibleCols.map((col) => <td key={col.key} className={cellClassName(col, line, todayDate)}>{renderCell(line, col)}</td>)}
          <td className="o2m-cols-td" />
        </tr>)}
      </Fragment>)}</tbody>
      {rows.length > 0 && <tfoot><tr>
        <td />
        {visibleCols.map((col) => {
          const sumValue = col.key === 'debit' ? totalDebit : col.key === 'credit' ? totalCredit : col.key === 'balance' ? totalBalance : col.key === 'amount_residual' ? totalResidual : null;
          const tip = col.numeric && unratedLines ? t('Excludes {n} documents in a currency with no exchange rate', { n: unratedLines }) : (col.sum ? t(col.sum) : undefined);
          return <td key={col.key} className={col.numeric ? 'num' : undefined} title={tip} aria-label={col.sum ? t(col.sum) : undefined}>
            {sumValue != null ? money(sumValue) : ''}
            {col.key === 'debit' && <RateNote count={unratedLines} />}
          </td>;
        })}
        <td className="o2m-cols-td" />
      </tr></tfoot>}
    </table></div>
  </main>;
}
