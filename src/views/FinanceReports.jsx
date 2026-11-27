import { Fragment, useState } from 'react';
import { read, search } from '../orm.js';
import { cashFlow, customerStatement, executiveSummary, fiscalReport, groupTrialBalanceRows, partnerLedger, reportAmountsVisible, trialBalance } from '../models/reports.js';
import { currentCompany } from '../models/company.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { formatCurrency } from '../money.js';
import { toggleReportFold, toggleAllReportFolds } from './reportFold.js';
import { ReportFoldAll } from './FinancialReportPrint.jsx';
import { reportMoney } from './reportCompany.jsx';
import { statementUrl } from '../statementNavigation.js';
import { reportJournalItemsHref } from './reportDrill.js';

const num = (v, fmtMoney = money) => <td className="num">{fmtMoney(v)}</td>;
const pct = (v) => (v == null ? '—' : `${v}%`);

export function TrialBalance({ db, period, periods, companyId, analyticAccountIds, showInitialBalance = true, showEndBalance = true, hideZeroLines = false, groupBy = '', money: moneyProp }) {
  const fmtMoney = moneyProp ?? reportMoney(db, companyId);
  const company_id = companyId && companyId !== 'all' ? Number(companyId) : null;
  const reports = (periods ?? [period]).map((p) => trialBalance(db, { ...p, reviewMode: period.reviewMode, company_id, analyticAccountIds, includeZeroRows: true }));
  const rowsByReport = reports.map((report) => new Map(report.rows.map((row) => [row.account.id, row])));
  const accounts = new Map(reports.flatMap((report) => report.rows.map((row) => [row.account.id, row.account])));
  const rows = [...accounts.values()].sort((a, b) => a.code.localeCompare(b.code));
  const keys = [
    ...(showInitialBalance ? ['initial'] : []),
    'debit',
    'credit',
    ...(showEndBalance ? ['end'] : []),
  ];
  const visibleRows = rows.filter((account) => reportAmountsVisible(rowsByReport.flatMap((byAccount) => keys.map((key) => byAccount.get(account.id)?.[key] ?? 0)), hideZeroLines));
  const [closedGroups, setClosedGroups] = useState(() => new Set());
  const toggleGroup = (key) => setClosedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const renderAccountRow = (r, indent = 0) => (
    <tr key={r.id} className="rep-detail">
      <td style={indent ? { paddingInlineStart: `${indent * 1.5 + 0.75}rem` } : undefined}>
        <a href={`#/open/account.account/${r.id}`}>{r.code} {r.name}</a>
      </td>
      {rowsByReport.flatMap((byAccount, index) => {
        const row = byAccount.get(r.id);
        return keys.map((key) => <td key={`${index}-${key}`} className="num"><a href={reportJournalItemsHref({ accountId: r.id, period: { ...(periods ?? [period])[index], reviewMode: period.reviewMode, journalIds: period.journalIds, analyticAccountIds }, companyId, column: key, trialOpening: key === 'initial' || key === 'end' })}>{fmtMoney(row?.[key] ?? 0)}</a></td>);
      })}
    </tr>
  );
  const groups = groupBy ? groupTrialBalanceRows(db, visibleRows, rowsByReport, keys, groupBy) : [];
  return (
    <tbody>
      {groupBy ? groups.map((group) => {
        if (group.ancestors?.some((key) => closedGroups.has(key))) return null;
        const open = !closedGroups.has(group.key);
        return (
          <Fragment key={group.key}>
            <tr className="rep-section" onClick={() => toggleGroup(group.key)} aria-expanded={open} style={{ cursor: 'pointer' }}>
              <td style={group.depth ? { paddingInlineStart: `${group.depth * 1.5 + 0.75}rem` } : undefined}>
                <span className="caret">{(group.accounts.length || group.hasChildren) ? (open ? '▾' : '▸') : ''}</span> {t(group.name)}
              </td>
              {group.periodTotals.flatMap((periodSum, index) => keys.map((key) => (
                <td key={`${index}-${key}`} className="num">{fmtMoney(periodSum[key] ?? 0)}</td>
              )))}
            </tr>
            {open && group.accounts.map((r) => renderAccountRow(r, group.depth + 1))}
          </Fragment>
        );
      }) : visibleRows.map((r) => renderAccountRow(r))}
      <tr className="rep-total strong"><td>{t('Total')}</td>{reports.flatMap((report, index) => keys.map((key) => <td key={`${index}-${key}`} className="num">{fmtMoney(report.totals[key])}</td>))}</tr>
    </tbody>
  );
}

function FiscalCategoryRows({ rows, periods, companyId, money: fmtMoney = money }) {
  const [open, setOpen] = useState(false);
  const row = rows.find(Boolean);
  const name = row.category ? row.category.name : t('Uncategorized');
  const accounts = new Map(rows.flatMap((group) => (group?.accounts ?? []).map((line) => [line.account.id, line.account])));
  const accountsByPeriod = rows.map((group) => new Map((group?.accounts ?? []).map((line) => [line.account.id, line])));
  const cells = (values, accountId) => values.flatMap((value, index) => ['debit', 'credit', 'balance'].map((key) => <td key={`${index}-${key}`} className="num">{accountId ? <a href={reportJournalItemsHref({ accountId, period: periods[index], companyId, column: key })}>{fmtMoney(value?.[key] ?? 0)}</a> : fmtMoney(value?.[key] ?? 0)}</td>));
  return <>
    <tr className="rep-section"><td><button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {name}</button></td>{cells(rows)}</tr>
    {open && [...accounts.values()].map((account) => <tr key={account.id} className="rep-detail"><td><a href={`#/open/account.account/${account.id}`}>{account.code} {account.name}</a></td>{cells(accountsByPeriod.map((byAccount) => byAccount.get(account.id)), account.id)}</tr>)}
  </>;
}

export function FiscalReport({ db, period, periods, companyId, analyticAccountIds, money: moneyProp }) {
  const effectiveCompanyId = companyId && companyId !== 'all' ? Number(companyId) : (period?.company_id ?? null);
  const fmtMoney = moneyProp ?? reportMoney(db, effectiveCompanyId);
  const reports = (periods ?? [period]).map((p) => fiscalReport(db, { ...p, reviewMode: period?.reviewMode, company_id: effectiveCompanyId, analyticAccountIds }));
  const rowsByReport = reports.map((report) => new Map(report.rows.map((row) => [row.category?.id ?? 'uncategorized', row])));
  const groups = new Map(reports.flatMap((report) => report.rows.map((row) => [row.category?.id ?? 'uncategorized', row])));
  return <tbody>
    {[...groups.keys()].map((id) => <FiscalCategoryRows key={id} rows={rowsByReport.map((byCategory) => byCategory.get(id))} periods={(periods ?? [period]).map((p) => ({ ...p, reviewMode: period.reviewMode, journalIds: period.journalIds, analyticAccountIds }))} companyId={effectiveCompanyId} money={fmtMoney} />)}
    <tr className="rep-total strong"><td>{t('Total')}</td>{reports.flatMap((report, index) => ['debit', 'credit', 'balance'].map((key) => <td key={`${index}-${key}`} className="num">{fmtMoney(report.totals[key])}</td>))}</tr>
  </tbody>;
}

/** Build full unpaged, unfolded export rows and column types for Partner Ledger CSV/XLSX export. */
export function partnerLedgerExportRows(db, { period, companyId, analyticAccountIds, partnerIds, unreconciledOnly, showJournalAccount = false, accountType, firstCol = 'Partner', money: moneyProp } = {}) {
  const fmtMoney = moneyProp ?? reportMoney(db, companyId);
  const company_id = companyId && companyId !== 'all' ? Number(companyId) : null;
  const rowsData = partnerLedger(db, { ...period, company_id, analyticAccountIds, partnerIds, unreconciledOnly }, accountType);
  const headers = [
    t(firstCol),
    ...(showJournalAccount ? [t('Journal'), t('Account')] : []),
    t('Due Date'),
    t('Matching'),
    t('Label'),
    t('Initial Balance'),
    t('Debit'),
    t('Credit'),
    t('End Balance'),
    t('Amount Currency'),
  ];
  const columnTypes = [
    'text',
    ...(showJournalAccount ? ['text', 'text'] : []),
    'text',
    'text',
    'text',
    'number',
    'number',
    'number',
    'number',
    'number',
  ];
  const rows = [headers];
  for (const p of rowsData) {
    const partnerName = p.partner_id ? (read(db, 'res.partner', p.partner_id)?.name ?? '') : t('Unknown');
    rows.push([
      partnerName,
      ...(showJournalAccount ? ['', ''] : []),
      '', '', '',
      fmtMoney(p.initial),
      fmtMoney(p.debit),
      fmtMoney(p.credit),
      fmtMoney(p.end),
      '',
    ]);
    for (const l of p.lines) {
      const journal = l.journal_id ? read(db, 'account.journal', l.journal_id) : null;
      const account = l.account_id ? read(db, 'account.account', l.account_id) : null;
      rows.push([
        `${l.date} · ${l.move_name}`,
        ...(showJournalAccount ? [journal?.code ?? '', account ? `${account.code} ${account.name}` : ''] : []),
        l.dueDate ?? '',
        l.matchingNumber ?? '',
        `${l.label}${l.ref ? ` · ${l.ref}` : ''}`,
        '',
        fmtMoney(l.debit),
        fmtMoney(l.credit),
        fmtMoney(l.balance),
        l.currency_id ? formatCurrency(l.amount_currency, read(db, 'res.currency', l.currency_id)) : '',
      ]);
    }
  }
  rows.push([
    t('Total'),
    ...(showJournalAccount ? ['', ''] : []),
    '', '', '',
    ...['initial', 'debit', 'credit', 'end'].map((k) => fmtMoney(rowsData.reduce((s, r) => s + r[k], 0))),
    '',
  ]);
  return { rows, columnTypes };
}

/** One partner: a clickable summary row that unfolds its entries with the running balance. */
function PartnerRows({ db, p, period, companyId, analyticAccountIds, kind, unreconciledOnly, showJournalAccount = false, isPrinting = false, money: fmtMoney = money }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(80);
  const expanded = isPrinting || open;
  const visibleLines = isPrinting ? p.lines : p.lines.slice(0, limit);
  return (
    <>
      <tr className="rep-section" onClick={() => setOpen(!open)} aria-expanded={open}>
        <td><span className="caret">{p.lines.length ? (open ? '▾' : '▸') : ''}</span> {p.partner_id ? read(db, 'res.partner', p.partner_id)?.name : t('Unknown')} {kind !== 'payable' && p.partner_id && companyId && <a href={statementUrl([p.partner_id], { companyId, ...period })} onClick={(e) => e.stopPropagation()}>{t('Customer Statement')}</a>}</td>
        {showJournalAccount && <><td /><td /></>}
        <td /><td /><td />
        {['initial', 'debit', 'credit', 'end'].map((column) => <td key={column} className="num"><a onClick={(e) => e.stopPropagation()} href={reportJournalItemsHref({ partnerId: p.partner_id, period: { ...period, analyticAccountIds }, companyId, column, accountType: kind ?? 'receivable', unreconciledOnly })}>{fmtMoney(p[column])}</a></td>)}<td />
      </tr>
      {expanded && visibleLines.map((l, i) => {
        const journal = l.journal_id ? read(db, 'account.journal', l.journal_id) : null;
        const account = l.account_id ? read(db, 'account.account', l.account_id) : null;
        return (
          <tr key={i} className="rep-detail">
            <td><a href={`#/open/account.move/${l.move_id}`}>{l.date} · {l.move_name}</a></td>
            {showJournalAccount && (
              <>
                <td>{journal?.code ?? ''}</td>
                <td>{account ? `${account.code} ${account.name}` : ''}</td>
              </>
            )}
            <td>{l.dueDate}</td>
            <td>{l.matchingNumber ?? ''}</td>
            <td>{l.label}{l.ref ? ` · ${l.ref}` : ''}</td>
            <td />
            {num(l.debit, fmtMoney)}{num(l.credit, fmtMoney)}{num(l.balance, fmtMoney)}
            <td className="num">{l.currency_id ? formatCurrency(l.amount_currency, read(db, 'res.currency', l.currency_id)) : ''}</td>
          </tr>
        );
      })}
      {!isPrinting && open && p.lines.length > limit && <tr className="no-export"><td colSpan={showJournalAccount ? 11 : 9}><button type="button" className="btn sm" onClick={() => setLimit((n) => n + 80)}>{t('Load more...')}</button></td></tr>}
    </>
  );
}

export function PartnerLedger(props) {
  if (typeof props === 'string') {
    const kind = props;
    return function PartnerLedgerBody(innerProps) {
      return <PartnerLedger {...innerProps} accountType={innerProps.accountType ?? kind} />;
    };
  }
  const { db, period, companyId, analyticAccountIds, partnerIds, unreconciledOnly, showJournalAccount = false, isPrinting = false, accountType, money: moneyProp } = props;
  const fmtMoney = moneyProp ?? reportMoney(db, companyId);
  const company_id = companyId && companyId !== 'all' ? Number(companyId) : null;
  const rows = partnerLedger(db, { ...period, company_id, analyticAccountIds, partnerIds, unreconciledOnly }, accountType);
  return (
    <tbody>
      {rows.map((p) => <PartnerRows key={p.partner_id ?? 'none'} db={db} p={p} period={period} companyId={company_id} analyticAccountIds={analyticAccountIds} kind={accountType} unreconciledOnly={unreconciledOnly} showJournalAccount={showJournalAccount} isPrinting={isPrinting} money={fmtMoney} />)}
      <tr className="rep-total strong"><td>{t('Total')}</td>{showJournalAccount && <><td /><td /></>}<td /><td /><td />{['initial', 'debit', 'credit', 'end'].map((k) => <td key={k} className="num">{fmtMoney(rows.reduce((s, r) => s + r[k], 0))}</td>)}<td /></tr>
    </tbody>
  );
}

export function CustomerStatement({ db, period, companyId, initialPartnerId, fixedPartner = false, onPartnerChange, money: moneyProp }) {
  const [partnerId, setPartnerId] = useState(initialPartnerId ?? '');
  const partners = search(db, 'res.partner', { includeArchived: true }).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const selected = partners.some((p) => p.id === Number(partnerId)) ? Number(partnerId) : null;
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : (period?.company_id ?? currentCompany(db));
  const fmtMoney = moneyProp ?? reportMoney(db, currentCo);
  const statementDb = (db.settings?.current_company_id ?? 1) === currentCo ? db : { ...db, settings: { ...db.settings, current_company_id: currentCo } };
  const statement = selected ? customerStatement(statementDb, selected, { ...period, company_id: currentCo }) : null;
  return <tbody>
    <tr><td colSpan={5}>{fixedPartner ? <b>{partners.find((p) => p.id === selected)?.name}</b> : <label>{t('Customer')} <select aria-label={t('Customer')} value={selected ?? ''} onChange={(e) => { setPartnerId(e.target.value); onPartnerChange?.(Number(e.target.value) || null); }}>
      <option value="">{t('Select a customer')}</option>
      {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select></label>}</td></tr>
    {statement && <>
      <tr className="rep-section"><td>{t('Opening Balance')}</td><td /><td /><td />{num(statement.opening, fmtMoney)}</tr>
      {statement.lines.map((line, i) => <tr key={i} className="rep-detail"><td><a href={`#/open/account.move/${line.move_id}`}>{line.date} · {line.move_name}{line.ref ? ` · ${line.ref}` : ''}</a></td><td>{line.dueDate}</td>{num(line.debit, fmtMoney)}{num(line.credit, fmtMoney)}{num(line.balance, fmtMoney)}</tr>)}
      <tr className="rep-total strong"><td>{t('Closing Balance')}</td><td /><td /><td />{num(statement.closing, fmtMoney)}</tr>
    </>}
  </tbody>;
}

export function CashFlow({ db, period, companyId, analyticAccountIds, money: moneyProp }) {
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : period?.company_id;
  const fmtMoney = moneyProp ?? reportMoney(db, currentCo);
  const [open, setOpen] = useState(() => new Set());
  const r = cashFlow(db, currentCo ? { ...period, company_id: currentCo, analyticAccountIds } : { ...period, analyticAccountIds });
  const keys = ['operating', 'investing', 'financing', ...((r.unclassified !== 0 || r.lines.some((l) => l.section === 'unclassified')) ? ['unclassified'] : [])];
  const section = (key, title) => (
    <>
      <tr className="rep-section"><td><button type="button" className="btn sm" aria-expanded={open.has(key)} onClick={() => setOpen((prev) => toggleReportFold(prev, key))}><span className="caret">{open.has(key) ? '▾' : '▸'}</span> {t(title)}</button></td>{num(r[key], fmtMoney)}</tr>
      {r.lines.filter((l) => l.section === key).map((l) => (
        <tr key={`${key}-${l.account.id}`} className={open.has(key) ? "rep-detail" : "rep-detail report-folded-row"}><td><a href={`#/open/account.account/${l.account.id}`}>{l.account.code} {l.account.name}</a></td><td className="num"><a href={reportJournalItemsHref({ period: { ...period, analyticAccountIds }, companyId: currentCo, cashFlowAccount: l.account.id })}>{fmtMoney(l.amount)}</a></td></tr>
      ))}
    </>
  );
  return (
    <tbody>
      <tr className="no-export"><td colSpan={2}><ReportFoldAll keys={keys} open={open} onToggle={() => setOpen((prev) => toggleAllReportFolds(prev, keys))} /></td></tr>
      <tr className="rep-total"><td>{t('Cash at the beginning of the period')}</td>{num(r.opening, fmtMoney)}</tr>
      {section('operating', 'Operating Activities')}
      {section('investing', 'Investing Activities')}
      {section('financing', 'Financing Activities')}
      {(r.unclassified !== 0 || r.lines.some((l) => l.section === 'unclassified')) && section('unclassified', 'Unclassified')}
      <tr className="rep-total"><td>{t('Net Change in Cash')}</td>{num(r.net, fmtMoney)}</tr>
      <tr className="rep-total strong"><td>{t('Cash at the end of the period')}</td>{num(r.closing, fmtMoney)}</tr>
    </tbody>
  );
}

export function ExecutiveSummary({ db, period, companyId, analyticAccountIds, money: moneyProp }) {
  const currentCo = (companyId && companyId !== 'all') ? Number(companyId) : period?.company_id;
  const fmtMoney = moneyProp ?? reportMoney(db, currentCo);
  const s = executiveSummary(db, { ...period, ...(currentCo ? { company_id: currentCo } : {}), analyticAccountIds });
  const formatCell = (row) => {
    if (row.format === 'pct') return pct(row.value);
    if (row.format === 'ratio') return row.value == null ? '—' : Number(row.value).toFixed(2);
    return fmtMoney(row.value);
  };
  return (
    <tbody>
      {s.sections.map((section) => (
        <Fragment key={section.key}>
          <tr className="rep-section">
            <td>{t(section.title)}</td>
            <td />
          </tr>
          {section.rows.map((row) => (
            <tr key={row.key} className={row.strong ? 'rep-detail rep-total' : 'rep-detail'}>
              <td>{t(row.label)}</td>
              <td className="num">{formatCell(row)}</td>
            </tr>
          ))}
        </Fragment>
      ))}
    </tbody>
  );
}
