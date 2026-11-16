import { Fragment, useEffect, useRef, useState } from 'react';
import { read, search, write } from '../orm.js';
import { today } from '../models/common.js';
import { depreciationReport } from '../models/assets.js';
import { filterByAnalytic, journalItems } from '../models/ledger.js';
import { agedBalance, agedReportDate, analyticActualLines, analyticActuals, analyticReportAmount, followUps, followUpCompanies, followUpLevel, followUpText, formatFollowUpTotals, levelChannel, logManualFollowUp, openManualFollowUp, taxReport, taxesByTax, taxesByGrid } from '../models/finance.js';
import { reportingBookedAmount } from '../models/money.js';
import { budgetReport } from '../models/analyticplus.js';
import { currentCompany } from '../models/company.js';
import { checkInalterability } from '../models/hash_chain.js';
import { journalAudit } from '../models/journal_audit.js';
import { commit, companiesOf, getDb, isServer, listAuditAll, useDb } from '../store.js';
import { AUDIT_MODELS, auditTrailToCsv, collectAuditTrailRows } from '../models/auditTrail.js';
import { PAGE_SIZE, pageWindow } from './paging.js';
import { valuationReport } from '../models/valuation.js';
import { CashFlow, CustomerStatement, ExecutiveSummary, FiscalReport, PartnerLedger, TrialBalance } from './FinanceReports.jsx';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { downloadCsv, downloadXml, tableToRows } from '../csv.js';
import { TAX_RETURN_TEMPLATES, resolveTaxReturnTemplate, taxReturnBoxes, taxReturnToCsv, taxReturnToXml } from '../models/taxExport.js';
import { AgedDetailRow } from './aged-detail-row.js';
import { budgetCurrency, BudgetMoneyCell } from './budget-currency.js';
import { cashflowColumns, periodsFor } from './reportCompare.js';
import { DEFAULT_REPORT_PERIOD, PERIODS, reportPage } from './reportNavigation.js';
export { PERIODS };
import { UnrealizedCurrencies } from './UnrealizedCurrencies.jsx';
import { SalesReview } from './SalesReview.jsx';
import { JournalItems } from './JournalItems.jsx';
import { LoansAnalysis } from './LoansAnalysis.jsx';
import { Checks } from './Checks.jsx';
import { CashflowAnalysis } from './CashflowAnalysis.jsx';
import { CompanySelect, reportCompanyScope } from './reportCompany.jsx';
import { ConfigurableReportPage } from './ConfigurableReport.jsx';

// Periods are defined in reportNavigation.js and re-exported above.

function ComparisonCells({ values, variance, showVariance = true }) {
  const cells = values.map((value, i) => <td key={i} className="num">{money(value)}</td>);
  if (!showVariance) return <>{cells}</>;
  const previous = values.at(-2);
  const amount = variance?.amount ?? Math.round((values.at(-1) - previous) * 100) / 100;
  const pct = variance ? variance.pct : previous ? Math.round(amount / Math.abs(previous) * 10000) / 100 : null;
  return <>{cells}<td className="num">{money(amount)}</td><td className="num">{pct == null ? t('n/a') : `${pct}${t('%')}`}</td></>;
}

function Section({ title, total, rows, sign = 1, totals, variance, showVariance = true }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="rep-section" onClick={() => setOpen(!open)} aria-expanded={open}>
        <td><span className="caret">{rows?.length ? (open ? '▾' : '▸') : ''}</span> {t(title)}</td>
        {totals ? <ComparisonCells values={totals} variance={variance} showVariance={showVariance} /> : <td className="num">{money(sign * total)}</td>}
      </tr>
      {open && rows?.map((r) => (
        <tr key={r.account.id} className="rep-detail">
          <td><a href={`#/open/account.account/${r.account.id}`}>{r.account.code} {r.account.name}</a></td>
          {totals ? <ComparisonCells values={r.values} showVariance={showVariance} /> : <td className="num">{money(r.balance)}</td>}
        </tr>
      ))}
    </>
  );
}

const Total = ({ label, value, strong, values, variance, showVariance = true }) => (
  <tr className={`rep-total ${strong ? 'strong' : ''}`}><td>{t(label)}</td>{values ? <ComparisonCells values={values} variance={variance} showVariance={showVariance} /> : <td className="num">{money(value)}</td>}</tr>
);

function Comparison({ data }) {
  const showVariance = Boolean(data.variance);
  const section = (i) => <Section key={data.sections[i].title} {...data.sections[i]} variance={data.variance?.[i]} showVariance={showVariance} />;
  const total = (i) => <Total key={data.totals[i].label} {...data.totals[i]} variance={data.variance?.[data.sections.length + i]} showVariance={showVariance} />;
  return <tbody>{[...data.sections.map((_, i) => section(i)), ...data.totals.map((_, i) => total(i))]}</tbody>;
}

function Ledger({ db, period, analyticAccountIds }) {
  const items = filterByAnalytic(journalItems(db, period), analyticAccountIds);
  const opening = period.from ? filterByAnalytic(journalItems(db, { to: period.from }), analyticAccountIds).filter((l) => l.date < period.from) : [];
  const accounts = [...new Set([...items, ...opening].map((l) => l.account_id))]
    .map((id) => read(db, 'account.account', id)).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code));
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Lines of every allowed company are translated into the active company's currency before being shown.
  const booked = (l, amount) => reportingBookedAmount(db, l, amount);
  const debitOf = (l) => booked(l, Number(l.debit) || 0);
  const creditOf = (l) => booked(l, Number(l.credit) || 0);
  const bal = (ls) => ls.reduce((s, l) => s + debitOf(l) - creditOf(l), 0);
  return (
    <tbody>
      {accounts.map((a) => {
        const lines = items.filter((l) => l.account_id === a.id).sort((x, y) => x.date.localeCompare(y.date));
        const start = bal(opening.filter((l) => l.account_id === a.id));
        let running = start;
        return [
          <tr key={a.id} className="rep-section" onClick={() => toggle(a.id)} aria-expanded={open.has(a.id)}>
            <td><span className="caret">{open.has(a.id) ? '▾' : '▸'}</span> {a.code} {a.name}</td>
            <td className="num">{money(lines.reduce((s, l) => s + debitOf(l), 0))}</td>
            <td className="num">{money(lines.reduce((s, l) => s + creditOf(l), 0))}</td>
            <td className="num">{money(start + bal(lines))}</td>
          </tr>,
          ...(open.has(a.id) ? [
            <tr key={`${a.id}-open`} className="rep-detail"><td>{t('Initial Balance')}</td><td /><td /><td className="num">{money(start)}</td></tr>,
            ...lines.map((l, i) => {
              running += debitOf(l) - creditOf(l);
              return (
                <tr key={`${a.id}-${i}`} className="rep-detail">
                  <td><a href={`#/open/account.move/${l.move_id}`}>{l.date} · {l.move_name}</a> <span className="muted">{l.name}</span></td>
                  <td className="num">{l.debit ? money(debitOf(l)) : ''}</td>
                  <td className="num">{l.credit ? money(creditOf(l)) : ''}</td>
                  <td className="num">{money(running)}</td>
                </tr>
              );
            }),
          ] : []),
        ];
      })}
    </tbody>
  );
}

const partnerName = (db, id) => read(db, 'res.partner', id)?.name ?? '—';

export function resolveTaxReportTemplate(db, companyId, companies = null) {
  if (companyId && companyId !== 'all') {
    const template = resolveTaxReturnTemplate(db, { company_id: Number(companyId) });
    return TAX_RETURN_TEMPLATES[template]?.mode === 'boxes' ? template : null;
  }
  const scopeCompanies = companies ?? (db.settings?.allowed_company_ids
    ? companiesOf(db).filter((c) => db.settings.allowed_company_ids.includes(c.id))
    : companiesOf(db));
  const templates = new Set(scopeCompanies.map((c) => resolveTaxReturnTemplate(db, { company_id: c.id })));
  if (templates.size === 1) {
    const single = [...templates][0];
    return TAX_RETURN_TEMPLATES[single]?.mode === 'boxes' ? single : null;
  }
  return null;
}

export function TaxReportTable({ db, period, returnRecord = null }) {
  const safeBase = String(returnRecord?.name || 'tax-return').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return (
    <div className="list-wrap">
      {returnRecord && (
        <div className="row" style={{ marginBottom: 8 }}>
          <button type="button" className="btn sm" onClick={() => downloadCsv(`${safeBase}.csv`, taxReturnToCsv(db, returnRecord))}>{t('Export CSV')}</button>
          <button type="button" className="btn sm" onClick={() => downloadXml(`${safeBase}.xml`, taxReturnToXml(db, returnRecord))}>{t('Export XML')}</button>
        </div>
      )}
      <table className="list report">
        <thead>
          <tr>
            <th />
            <th className="num">{t('Base')}</th>
            <th className="num">{t('Tax')}</th>
          </tr>
        </thead>
        <Tax db={db} period={period} variant="generic" />
      </table>
    </div>
  );
}

export function Tax({ db, period, companyId = 'all', variant = null }) {
  const effectiveCompanyId = companyId && companyId !== 'all' ? Number(companyId) : (period?.company_id ?? null);
  const effectivePeriod = effectiveCompanyId ? { ...period, company_id: effectiveCompanyId } : period;
  const countryTemplateKey = resolveTaxReportTemplate(db, companyId);
  const activeVariant = variant ?? (countryTemplateKey ?? 'generic');

  if (activeVariant !== 'generic') {
    const { boxes } = taxReturnBoxes(db, { ...effectivePeriod, tax_return_template: activeVariant });
    const templateSpec = TAX_RETURN_TEMPLATES[activeVariant];
    const payableCode = templateSpec?.boxes?.find((b) => b.kind === 'net_payable')?.code;
    return (
      <tbody>
        {boxes.map((b) => (
          <tr key={b.code} className={b.kind === 'total' ? `rep-total ${b.code === payableCode ? 'strong' : ''}` : 'rep-detail'}>
            <td>{b.code}</td>
            <td>{t(b.label)}</td>
            <td className="num">{money(b.base)}</td>
            <td className="num">{money(b.tax)}</td>
          </tr>
        ))}
      </tbody>
    );
  }

  const r = taxReport(db, effectivePeriod);
  const byTax = taxesByTax(db, effectivePeriod);
  const grids = taxesByGrid(db, effectivePeriod);
  const side = (key, title) => (
    <>
      <tr className="rep-section"><td>{t(title)}</td><td /><td /></tr>
      {byTax.filter((x) => x.side === key).map((x) => (
        <tr key={x.name} className="rep-detail"><td>{x.name}</td><td className="num">{money(x.base)}</td><td className="num">{money(x.tax)}</td></tr>
      ))}
    </>
  );
  const line = (label, value, strong) => <tr className={`rep-total ${strong ? 'strong' : ''}`}><td>{t(label)}</td><td /><td className="num">{money(value)}</td></tr>;
  return (
    <tbody>
      {side('sale', 'Sales')}
      {side('purchase', 'Purchases')}
      {grids.length > 0 && <tr className="rep-section"><td>{t('Tax Grids')}</td><td /><td /></tr>}
      {grids.map((x) => <tr key={x.id} className="rep-detail"><td>{x.name}</td><td className="num">{money(x.base)}</td><td className="num">{money(x.tax)}</td></tr>)}
      {line('Output Tax', r.output)}
      {line('Input Tax', r.input)}
      {line('Tax Payable', r.payable, true)}
    </tbody>
  );
}

const Aged = (kind) => function AgedBody({ db, period, companyId }) {
  const company = companyId && companyId !== 'all' ? Number(companyId) : null;
  const { buckets, rows } = agedBalance(db, kind, agedReportDate(period.to), company);
  const [open, setOpen] = useState(() => new Set());
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return (
    <tbody>
      {rows.map((r) => <Fragment key={r.partner_id}>
        <tr className="rep-detail">
          <td><button type="button" className="btn sm" aria-expanded={open.has(r.partner_id)} onClick={() => setOpen((prev) => { const next = new Set(prev); if (next.has(r.partner_id)) next.delete(r.partner_id); else next.add(r.partner_id); return next; })}>{open.has(r.partner_id) ? '▾' : '▸'}</button> <a href={`#/open/res.partner/${r.partner_id}`}>{partnerName(db, r.partner_id)}</a></td>
          {buckets.map(([k]) => <td key={k} className="num">{r[k] ? money(r[k]) : ''}</td>)}
          <td className="num">{money(r.total)}</td>
        </tr>
        {open.has(r.partner_id) && r.invoices.map((detail) => <AgedDetailRow key={detail.move_id} buckets={buckets} detail={detail} money={money} />)}
      </Fragment>)}
      <tr className="rep-total strong"><td>{t('Total')}</td>{buckets.map(([k]) => <td key={k} className="num">{money(sum(k))}</td>)}<td className="num">{money(sum('total'))}</td></tr>
    </tbody>
  );
};

function FollowUpActions({ db, reminder, companyId }) {
  const email = read(db, 'res.partner', reminder.partner_id)?.email?.trim();
  const channel = levelChannel(followUpLevel(db, reminder));
  const manualChannel = ['sms', 'phone', 'letter'].includes(channel) ? channel : 'email';
  const options = { scope: db, reminder, companyId };
  return <>
    {email && <><a className="btn sm" href={`mailto:${email}?subject=${encodeURIComponent(t('Payment reminder'))}&body=${encodeURIComponent(followUpText(db, reminder))}`}
      onClick={() => commit(openManualFollowUp(getDb(), reminder.partner_id, today(), options))}>{t('Open Reminder in Mail App')}</a>{' '}</>}
    {(manualChannel !== 'email' || email) &&
      <button type="button" className="btn sm" onClick={() => commit(logManualFollowUp(getDb(), reminder.partner_id, today(), { ...options, channel: manualChannel }))}>{t('Confirm Sent')}</button>}
  </>;
}

export function FollowUps({ db, sourceDb, companyId = 'all' }) {
  const settingsAllowed = (sourceDb ?? db).settings?.allowed_company_ids ?? [currentCompany(sourceDb ?? db)];
  const allowed = companyId === 'all'
    ? settingsAllowed
    : settingsAllowed.filter((id) => id === Number(companyId));
  const multiCompany = allowed.length > 1;

  const allFollowUps = followUps(db);
  const companyGroups = new Map();
  for (const f of allFollowUps) {
    for (const part of followUpCompanies(f)) {
      const cId = part.company_id ?? part.invoices[0]?.company_id ?? 1;
      if (!companyGroups.has(cId)) companyGroups.set(cId, []);
      companyGroups.get(cId).push(part);
    }
  }

  if (multiCompany) {
    const sections = allowed
      .map((cId) => ({
        company: read(sourceDb ?? db, 'res.company', cId) ?? { id: cId, name: `Company ${cId}` },
        items: companyGroups.get(cId) ?? [],
      }))
      .filter((sec) => sec.items.length > 0);

    return (
      <tbody>
        {sections.map(({ company, items }) => (
          <Fragment key={company.id}>
            <tr className="rep-section">
              <td colSpan={3}><strong>{company.name}</strong></td>
            </tr>
            {items.map((f) => {
              return (
                <tr key={`${company.id}-${f.partner_id}`} className="rep-detail">
                  <td>
                    <a href={`#/open/res.partner/${f.partner_id}`}>{partnerName(db, f.partner_id)}</a>{' '}
                    <span className="muted">{f.invoices.map((m) => m.name).join(', ')}</span>{' '}
                    <FollowUpActions db={db} reminder={f} companyId={company.id} />
                  </td>
                  <td className="num">{f.oldest}</td>
                  <td className="num">{formatFollowUpTotals(f)}</td>
                </tr>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    );
  }

  const singleCompanyId = allowed[0] ?? currentCompany(db);
  const singleItems = companyGroups.get(singleCompanyId) ?? [];

  return (
    <tbody>
      {singleItems.map((f) => {
        return (
          <tr key={f.partner_id} className="rep-detail">
            <td>
              <a href={`#/open/res.partner/${f.partner_id}`}>{partnerName(db, f.partner_id)}</a>{' '}
              <span className="muted">{f.invoices.map((m) => m.name).join(', ')}</span>{' '}
              <FollowUpActions db={db} reminder={f} companyId={singleCompanyId} />
            </td>
            <td className="num">{f.oldest}</td>
            <td className="num">{formatFollowUpTotals(f)}</td>
          </tr>
        );
      })}
    </tbody>
  );
}

function Budget({ db, period }) {
  const availableCompanies = companiesOf(db);
  const lineLabel = (l) => {
    const analytic = read(db, 'account.analytic.account', l.analytic_account_id)?.name;
    const acc = read(db, 'account.account', l.account_id);
    const general = acc ? `${acc.code} ${acc.name}` : l.general_account;
    return [analytic, general].filter(Boolean).join(' · ') || '—';
  };
  const selectCompany = (budgetId, value) => {
    const companyId = Number(value);
    if (!companyId || !availableCompanies.some((company) => company.id === companyId)) return;
    commit(write(getDb(), 'account.budget', budgetId, { company_id: companyId }));
  };
  return (
    <tbody>
      {search(db, 'account.budget').filter((b) => !['draft', 'cancel'].includes(b.state) && (!period.from || !b.date_to || b.date_to >= period.from) && (!period.to || !b.date_from || b.date_from <= period.to)).flatMap((b) => {
        const company = b.company_id ? read(db, 'res.company', b.company_id) : null;
        const companyMissing = !company;
        let currency = null;
        let reportLines = [];
        let reportError = null;
        if (!companyMissing) {
          try {
            currency = budgetCurrency(db, company.id);
            if (b.lines?.length) reportLines = budgetReport(db, b.id, today(), { period, company_id: company.id });
          } catch (error) {
            reportError = error instanceof Error ? error.message : String(error);
          }
        }
        return [
          <tr key={b.id} className="rep-section"><td colSpan={6}>
            <a href={`#/open/account.budget/${b.id}`}>{b.name}</a>
            {companyMissing
              ? <label className="inline-select">{t('Company')}
                <select aria-label={`${t('Company')} for ${b.name}`} value="" onChange={(event) => selectCompany(b.id, event.target.value)}>
                  <option value="">{t('Select a company')}</option>
                  {availableCompanies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              : <span className="muted"> · {company.name}</span>}
          </td></tr>,
          ...(companyMissing ? [<tr key={`${b.id}-company-required`}><td colSpan={6} className="muted">{t('Select a company to show this budget report.')}</td></tr>] : []),
          ...(reportError ? [<tr key={`${b.id}-report-error`}><td colSpan={6} className="muted" role="alert">{reportError}</td></tr>] : []),
          ...reportLines.map((l, i) => (
            <Fragment key={`${b.id}-${i}`}>
              <tr className="rep-detail">
                <td>{lineLabel(l)}</td>
                <BudgetMoneyCell value={l.planned} currency={currency} money={money} />
                <BudgetMoneyCell value={l.practical} currency={currency} money={money} />
                <BudgetMoneyCell value={l.committed} currency={currency} money={money} />
                <BudgetMoneyCell value={l.variance} currency={currency} money={money} />
                <td className="num">{l.planned ? `${l.achievement}%` : ''}</td>
              </tr>
              {l.analytic_lines.map((item) => <tr className="rep-detail" key={item.id}>
                <td>{Number.isInteger(item.id) ? <a href={`#/open/account.analytic.line/${item.id}`}>{item.name || item.date}</a> : (item.name || item.date)}{item.move_id && <>{' · '}<a href={`#/open/account.move/${item.move_id}`}>{read(db, 'account.move', item.move_id)?.name ?? item.move_id}</a></>}</td>
                <td /><BudgetMoneyCell value={item.amount} currency={currency} money={money} /><td /><td /><td />
              </tr>)}
              {l.commitment_lines.map((item, index) => <tr className="rep-detail" key={`purchase-${item.purchase_id}-${index}`}>
                <td><a href={`#/open/purchase.order/${item.purchase_id}`}>{read(db, 'purchase.order', item.purchase_id)?.name}</a></td>
                <td /><td /><BudgetMoneyCell value={item.amount} currency={currency} money={money} /><td /><td />
              </tr>)}
            </Fragment>
          )),
        ];
      })}
    </tbody>
  );
}

function Analytic({ db, period }) {
  const actual = analyticActuals(db, period);
  const lines = analyticActualLines(db, period);
  return (
    <tbody>
      {search(db, 'account.analytic.account', { includeArchived: true }).filter((a) => a.active !== false || actual.has(a.id)).map((a) => <Fragment key={a.id}>
        <Total label={a.name} value={actual.get(a.id) ?? 0} />
        {lines.filter((line) => line.account_id === a.id).map((line) => <tr key={line.id} className="rep-detail">
          <td><a href={`#/open/account.analytic.line/${line.id}`}>{line.name || line.date}</a>{line.move_id && <>{' · '}<a href={`#/open/account.move/${line.move_id}`}>{read(db, 'account.move', line.move_id)?.name ?? line.move_id}</a></>}</td>
          <td className="num">{money(analyticReportAmount(db, line))}</td>
        </tr>)}
      </Fragment>)}
    </tbody>
  );
}

function AuditTrail({ db, rows, loading, denied }) {
  if (loading) return <tbody><tr><td className="muted">{t('Loading…')}</td></tr></tbody>;
  if (denied) return <tbody><tr><td className="muted">{t('Only administrators can read the audit trail')}</td></tr></tbody>;
  return <AuditRows db={db} rows={rows} />;
}

function AuditRows({ db, rows }) {
  return (
    <tbody>
      {rows.map((m) => (
        <tr key={m.id} className="rep-detail">
          <td><a href={`#/open/${m.model || 'account.move'}/${m.res_id}`}>{m.recordName ?? read(db, m.model || 'account.move', m.res_id)?.name ?? `#${m.res_id}`}</a> <span className="muted">{m.body}</span></td>
          <td className="num">{m.author}</td>
          <td className="num">{String(m.date ?? '').slice(0, 16).replace('T', ' ')}</td>
        </tr>
      ))}
    </tbody>
  );
}

/** Stock value per product from its valuation layers (revaluations and landed costs included), largest first. */
function Valuation({ db }) {
  const report = valuationReport(db);
  const rows = Object.entries(report).filter(([, v]) => v.qty)
    .map(([id, v]) => ({ p: { ...read(db, 'product', Number(id)), qty_available: v.qty, cost: v.unitCost }, value: v.value })).sort((a, b) => b.value - a.value);
  return (
    <tbody>
      {rows.map(({ p, value }) => (
        <tr key={p.id} className="rep-detail">
          <td><a href={`#/open/product/${p.id}`}>{p.default_code ? `[${p.default_code}] ` : ''}{p.name}</a></td>
          <td className="num">{p.qty_available}</td>
          <td className="num">{money(p.cost)}</td>
          <td className="num">{money(value)}</td>
        </tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td><td /><td /><td className="num">{money(rows.reduce((s, r) => s + r.value, 0))}</td></tr>
    </tbody>
  );
}

// Per asset: depreciation posted in the period, accumulated to its end, and the resulting book value.
function Depreciation({ db, period, companyId }) {
  const { rows, totals } = depreciationReport(db, period, companyId);
  return (
    <tbody>
      {rows.map(({ a, original, inPeriod, accumulated, book }) => (
        <tr key={a.id} className="rep-detail">
          <td><a href={`#/open/account.asset/${a.id}`}>{a.name}</a></td>
          <td>{a.acquisition_date}</td>
          <td className="num">{money(original)}</td>
          <td className="num">{money(inPeriod)}</td>
          <td className="num">{money(accumulated)}</td>
          <td className="num">{money(book)}</td>
        </tr>
      ))}
      <tr className="rep-total strong"><td>{t('Total')}</td><td /><td className="num">{money(totals.original)}</td><td className="num">{money(totals.inPeriod)}</td><td className="num">{money(totals.accumulated)}</td><td className="num">{money(totals.book)}</td></tr>
    </tbody>
  );
}

function JournalAudit({ db, period, companyId }) {
  const groups = journalAudit(db, { ...period, companyId: companyId === 'all' ? null : Number(companyId) });
  if (!groups.length) return <tbody><tr><td colSpan={7} className="muted">{t('No posted entries for this period.')}</td></tr></tbody>;
  return <tbody>{groups.map(({ journal, items, debit, credit, taxes }) => <Fragment key={journal.id}>
    <tr className="rep-section"><td colSpan={5}><strong>{journal.name} ({journal.code})</strong></td><td className="num">{money(debit)}</td><td className="num">{money(credit)}</td></tr>
    {items.map(({ move, line, date }, i) => {
      const account = read(db, 'account.account', line.account_id);
      return <tr key={`${move.id}-${i}`} className="rep-detail"><td>{date}</td><td><a href={`#/open/account.move/${move.id}`}>{move.name}</a></td><td>{read(db, 'res.partner', line.partner_id ?? move.partner_id)?.name ?? ''}</td><td>{account ? `${account.code} ${account.name}` : ''}</td><td>{line.name}</td><td className="num">{line.debit ? money(line.debit) : ''}</td><td className="num">{line.credit ? money(line.credit) : ''}</td></tr>;
    })}
    <tr className="rep-total strong"><td colSpan={5}>{t('Total')} - {journal.name}</td><td className="num">{money(debit)}</td><td className="num">{money(credit)}</td></tr>
    {taxes.length > 0 && <><tr className="rep-section"><td colSpan={3}>{t('Tax Summary')} - {journal.name}</td><td>{t('Tax')}</td><td>{t('Base')}</td><td colSpan={2}>{t('Tax Amount')}</td></tr>{taxes.map((tax) => <tr key={tax.tax_id ?? 'unidentified-tax'}><td colSpan={3} /><td>{tax.name}</td><td className="num">{money(tax.base)}</td><td colSpan={2} className="num">{money(tax.tax)}</td></tr>)}</>}
  </Fragment>)}</tbody>;
}

function InalterabilityCheck({ db, companyId }) {
  const allowed = db.settings?.allowed_company_ids ?? [currentCompany(db)];
  const selected = companyId === 'all' ? allowed : allowed.filter((id) => id === Number(companyId));
  const results = selected.flatMap((id) => checkInalterability(db, { companyId: id }));

  if (!results.length) {
    return <tbody><tr><td colSpan={4} className="muted">{t('No restricted journals configured.')}</td></tr></tbody>;
  }

  return (
    <tbody>
      {results.map((r) => (
        <tr key={`${r.journal_id}-${r.company_id}`} className={`rep-detail ${r.status === 'corrupted' ? 'rep-corrupted' : ''}`}>
          <td><strong>{r.journal_name} ({r.journal_code})</strong>{r.company_id && companiesOf(db).length > 1 ? ` \u2014 ${read(db, 'res.company', r.company_id)?.name ?? r.company_id}` : ''}</td>
          <td>{r.first_move ?? '—'}</td>
          <td>{r.last_move ?? '—'}</td>
          <td>
            {r.status === 'ok' ? (
              <span className="badge badge-success" style={{ color: '#16a34a', fontWeight: 600 }}>{t(r.message)}</span>
            ) : (
              <span className="badge badge-danger" style={{ color: '#dc2626', fontWeight: 600 }}>{r.status === 'unanchored' ? t('Secure chain has no independent head') : t('Corrupted at entry {name}', { name: r.corrupted_move?.name ?? r.last_move ?? '' })}</span>
            )}
          </td>
        </tr>
      ))}
    </tbody>
  );
}

const REPORTS = {
  trial: { title: 'Trial Balance', Body: TrialBalance, cols: ['Initial Balance', 'Debit', 'Credit', 'End Balance'] },
  fiscal: { title: 'Fiscal Report', Body: FiscalReport, cols: ['Debit', 'Credit', 'Balance'] },
  partnerReceivable: { title: 'Partner Ledger', Body: PartnerLedger('receivable'), cols: ['Initial Balance', 'Debit', 'Credit', 'End Balance', 'Amount Currency'] },
  customerStatement: { title: 'Customer Statement', Body: CustomerStatement, cols: ['Debit', 'Credit', 'Balance'] },
  partnerPayable: { title: 'Partner Ledger (Payable)', Body: PartnerLedger('payable'), cols: ['Initial Balance', 'Debit', 'Credit', 'End Balance', 'Amount Currency'] },
  cashflow: { title: 'Cash Flow Statement', Body: CashFlow, cols: ['Balance'] },
  executive: { title: 'Executive Summary', Body: ExecutiveSummary, cols: ['Value'] },
  depreciation: { title: 'Depreciation Schedule', Body: Depreciation, cols: ['Acquisition Date', 'Original Value', 'Depreciation', 'Cumulative Depreciation', 'Book Value'] },
  valuation: { title: 'Stock Valuation', Body: Valuation, cols: ['On Hand', 'Unit Cost', 'Total Value'] },
  audit: { title: 'Audit Trail', Body: AuditTrail, cols: ['Author', 'Date'] },
  tax: { title: 'Tax Report', Body: Tax, cols: ['Base', 'Tax'] },
  agedReceivable: { title: 'Aged Receivable', Body: Aged('receivable'), cols: ['Not due', '1-30', '31-60', '61-90', 'Older', 'Total'] },
  agedPayable: { title: 'Aged Payable', Body: Aged('payable'), cols: ['Not due', '1-30', '31-60', '61-90', 'Older', 'Total'] },
  followups: { title: 'Follow-up Reports', Body: FollowUps, cols: ['Oldest Due', 'Overdue'] },
  budget: { title: 'Budget vs Actual', Body: Budget, cols: ['Planned', 'Actual', 'Committed', 'Variance', 'Achievement'] },
  analytic: { title: 'Analytic Report', Body: Analytic, cols: ['Balance'] },
  pnl: { title: 'Profit and Loss', cols: ['Balance'] },
  balance: { title: 'Balance Sheet', cols: ['Balance'] },
  ledger: { title: 'General Ledger', Body: Ledger, cols: ['Debit', 'Credit', 'Balance'] },
  journalAudit: { title: 'Journal Audit', Body: JournalAudit, firstCol: 'Date', cols: ['Number', 'Partner', 'Account', 'Label', 'Debit', 'Credit'] },
  inalterability: { title: 'Data Inalterability Check', Body: InalterabilityCheck, firstCol: 'Journal', cols: ['First Secured Entry', 'Last Secured Entry', 'Status'] },
};

/** Financial reports computed live from posted journal items. */
export function Reports({ leaf, id }) {
  if (leaf.report === 'configurable') return <ConfigurableReportPage id={id} />;
  if (leaf.report === 'pnl' || leaf.report === 'balance') {
    return <ConfigurableReportPage key={leaf.report} statementKind={leaf.report} title={REPORTS[leaf.report].title} />;
  }
  const component = ['journalItems', 'unreconciledItems'].includes(leaf.report) ? JournalItems
    : leaf.report === 'unrealizedCurrencies' ? UnrealizedCurrencies
    : leaf.report === 'checks' ? Checks
    : leaf.report === 'loansAnalysis' ? LoansAnalysis
    : leaf.report === 'cashflowAnalysis' ? CashflowAnalysis
      : ['invoicesToBeIssued', 'invoicedNotDelivered'].includes(leaf.report) ? SalesReview : ReportPage;
  return reportPage(leaf, component);
}

function ReportPage({ leaf }) {
  const sourceDb = useDb();
  const [companyId, setCompanyId] = useState('all');
  const { companyDb, availableCompanies, companies, selectedCompany } = reportCompanyScope(sourceDb, companyId, { allowAll: leaf.report !== 'customerStatement' });
  const [periodKey, setPeriodKey] = useState(DEFAULT_REPORT_PERIOD);
  const [comparison, setComparison] = useState('none');
  const [ledgerId, setLedgerId] = useState('');
  const [journalId, setJournalId] = useState('');
  const [horizontalGroupId, setHorizontalGroupId] = useState('');
  const [analyticAccountIds, setAnalyticAccountIds] = useState([]);
  const ledgerReports = ['pnl', 'balance', 'ledger', 'trial', 'journalAudit'];
  const ledgers = search(companyDb, 'account.journal.group').sort((a, b) => (a.sequence ?? 10) - (b.sequence ?? 10));
  const ledger = ledgerReports.includes(leaf.report) ? ledgers.find((item) => item.id === Number(ledgerId)) : null;
  const availableJournals = ledger ? search(companyDb, 'account.journal').filter((j) => (ledger.journal_ids ?? []).includes(j.id)) : search(companyDb, 'account.journal');
  const targetJournalIds = journalId
    ? [Number(journalId)]
    : ledger
      ? (ledger.journal_ids ?? [])
      : null;
  const db = targetJournalIds
    ? {
        ...companyDb,
        records: {
          ...companyDb.records,
          'account.move': (companyDb.records['account.move'] ?? []).filter((move) =>
            (!ledger || (move.company_id ?? 1) === ledger.company_id) && targetJournalIds.includes(move.journal_id)
          ),
        },
      }
    : companyDb;
  const [customPeriod, setCustomPeriod] = useState({ from: today().slice(0, 4) + '-01-01', to: today() });
  const { title, Body, cols, firstCol } = REPORTS[leaf.report];
  const countryTemplateKey = leaf.report === 'tax' ? resolveTaxReportTemplate(companyDb, selectedCompany, companies) : null;
  const countryTemplate = countryTemplateKey ? TAX_RETURN_TEMPLATES[countryTemplateKey] : null;
  const [taxVariant, setTaxVariant] = useState(null);
  const [taxVariantCompany, setTaxVariantCompany] = useState(selectedCompany);
  if (taxVariantCompany !== selectedCompany) {
    setTaxVariantCompany(selectedCompany);
    setTaxVariant(null);
  }
  const activeTaxVariant = (taxVariant && (taxVariant === 'generic' || taxVariant === countryTemplateKey))
    ? taxVariant
    : (countryTemplateKey ?? 'generic');
  const isTaxBoxes = leaf.report === 'tax' && activeTaxVariant !== 'generic';
  const reportCols = isTaxBoxes ? ['Description', 'Base', 'Tax'] : cols;
  const reportFirstCol = isTaxBoxes ? 'Box' : firstCol;
  const period = periodKey === 'custom' ? customPeriod : PERIODS[periodKey]();
  const comparable = ['pnl', 'balance', 'cashflow'].includes(leaf.report) && !['all', 'custom'].includes(periodKey);
  const showAnalyticFilter = ['pnl', 'balance', 'cashflow', 'ledger', 'partnerReceivable', 'partnerPayable', 'trial', 'fiscal', 'executive'].includes(leaf.report);
  const horizontalGroups = [];
  const periods = comparable && comparison !== 'none' ? periodsFor(periodKey, comparison, today()) : null;
  const analyticAccounts = showAnalyticFilter ? search(companyDb, 'account.analytic.account') : [];
  const data = periods && leaf.report === 'cashflow'
    ? cashflowColumns(db, periods, {
      analyticAccountIds, ...(selectedCompany !== 'all' ? { company_id: Number(selectedCompany) } : {}),
    })
    : null;
  const tableRef = useRef(null);
  const isAudit = leaf.report === 'audit';
  const [serverAuditLog, setServerAuditLog] = useState(undefined);
  const [auditPage, setAuditPage] = useState({ key: '', offset: 0 });
  const auditScopeKey = JSON.stringify(sourceDb.settings?.allowed_company_ids ?? [sourceDb.settings?.current_company_id ?? 1]);
  useEffect(() => {
    let active = true;
    if (isAudit && isServer()) {
      setServerAuditLog(undefined);
      listAuditAll(AUDIT_MODELS).then((rows) => { if (active) setServerAuditLog(rows); });
    }
    return () => { active = false; };
  }, [isAudit, auditScopeKey]);
  const auditAllRows = isAudit && (!isServer() || Array.isArray(serverAuditLog))
    ? collectAuditTrailRows(db, sourceDb, period, isServer() ? serverAuditLog : null)
    : [];
  const auditPageKey = `${auditScopeKey}:${periodKey}:${period.from ?? ''}:${period.to ?? ''}`;
  const auditOffset = auditPage.key === auditPageKey ? auditPage.offset : 0;
  const auditWin = pageWindow(auditAllRows.length, auditOffset, PAGE_SIZE);
  const auditPagedRows = auditAllRows.slice(auditWin.start, auditWin.end);
  const exportCsv = () => {
    if (isAudit) {
      downloadCsv('audit.csv', auditTrailToCsv(auditAllRows));
      return;
    }
    downloadCsv(`${leaf.report || 'report'}.csv`, tableToRows(tableRef.current));
  };
  return (
    <main className="action report-page">
      <div className="control-panel">
        <h1 className="cp-title">{t(title)}</h1>
        {leaf.report !== 'inalterability' && <label className="inline-select">
          {t('Period')}
          <select value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
            <option value="month">{t('This Month')}</option>
            <option value="quarter">{t('This Quarter')}</option>
            <option value="year">{t('This Year')}</option>
            <option value="all">{t('All Dates')}</option>
            {['journalAudit', 'customerStatement', 'fiscal', 'pnl', 'balance', 'ledger', 'trial', 'tax', 'cashflow', 'executive', 'depreciation', 'analytic', 'budget'].includes(leaf.report) && <option value="custom">{t('Custom Period')}</option>}
          </select>
        </label>}
        {periodKey === 'custom' && <><label>{t('From')}<input type="date" value={customPeriod.from} onChange={(e) => setCustomPeriod({ ...customPeriod, from: e.target.value })} /></label><label>{t('To')}<input type="date" value={customPeriod.to} onChange={(e) => setCustomPeriod({ ...customPeriod, to: e.target.value })} /></label></>}
        {ledgerReports.includes(leaf.report) && <label className="inline-select">{t('Ledger')}
          <select aria-label={t('Ledger')} value={ledger ? String(ledger.id) : ''} onChange={(e) => { setLedgerId(e.target.value); setJournalId(''); }}>
            <option value="">{t('All Ledgers')}</option>
            {ledgers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
        {ledgerReports.includes(leaf.report) && <label className="inline-select">{t('Journals')}
          <select aria-label={t('Journals')} value={journalId} onChange={(e) => setJournalId(e.target.value)}>
            <option value="">{t('All Journals')}</option>
            {availableJournals.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}
          </select>
        </label>}
        {(['journalAudit', 'inalterability', 'cashflow', 'depreciation', 'tax'].includes(leaf.report) ? availableCompanies.length > 1 : leaf.report === 'customerStatement' && companies.length > 1) && (
          <CompanySelect companies={companies} value={selectedCompany} onChange={setCompanyId} allowAll={leaf.report !== 'customerStatement'} />
        )}
        {leaf.report === 'tax' && countryTemplate && (
          <label className="inline-select">
            {t('Variant')}
            <select aria-label={t('Variant')} value={activeTaxVariant} onChange={(e) => setTaxVariant(e.target.value)}>
              <option value={countryTemplateKey}>{t(countryTemplate.label)}</option>
              <option value="generic">{t('Generic')}</option>
            </select>
          </label>
        )}
        {showAnalyticFilter && analyticAccounts.length > 0 && (
          <label className="inline-select">
            {t('Analytic Accounts')}
            <select aria-label={t('Analytic Accounts')} multiple value={analyticAccountIds} onChange={(e) => {
              const selected = Array.from(e.target.selectedOptions).map((o) => Number(o.value));
              setAnalyticAccountIds(selected);
            }}>
              {analyticAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        {comparable && <label className="inline-select">
          {t('Comparison')}
          <select value={comparison} onChange={(e) => { setComparison(e.target.value); if (e.target.value !== 'none') setHorizontalGroupId(''); }}>
            <option value="none">{t('No comparison')}</option>
            <option value="previous">{t('Previous Period')}</option>
            <option value="lastYear">{t('Same Period Last Year')}</option>
            <option value="last3">{t('Last 3 Periods')}</option>
          </select>
        </label>}
        {comparable && horizontalGroups.length > 0 && <label className="inline-select">
          {t('Horizontal Group')}
          <select aria-label={t('Horizontal Group')} value={horizontalGroupId} onChange={(e) => { setHorizontalGroupId(e.target.value); if (e.target.value) setComparison('none'); }}>
            <option value="">{t('None')}</option>
            {horizontalGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>}
        <span className="muted">{leaf.report === 'inalterability' ? t('Chain verification always covers all secured entries.') : (period.from ? `${period.from} → ${period.to}` : `≤ ${period.to}`)}</span>
        <span className="spacer" />
        {isAudit && (
          <span className="pager" role="group" aria-label={t('Pager')}>
            <span aria-live="polite">{auditWin.label} / {auditWin.total}</span>
            <button type="button" className="btn sm" aria-label={t('Previous page')} disabled={auditWin.prev == null} onClick={() => setAuditPage({ key: auditPageKey, offset: auditWin.prev })}>‹</button>
            <button type="button" className="btn sm" aria-label={t('Next page')} disabled={auditWin.next == null} onClick={() => setAuditPage({ key: auditPageKey, offset: auditWin.next })}>›</button>
          </span>
        )}
        <button type="button" className="btn sm" onClick={() => window.print()}>{t('Print')}</button>
        <button type="button" className="btn sm" onClick={exportCsv}>{t('Download CSV')}</button>
      </div>
      <div className="list-wrap">
        <table className="list report" ref={tableRef}>
          <thead><tr><th>{t(reportFirstCol ?? '')}</th>{(data ? [...data.headers, ...(data.variance ? ['Variance', '%'] : [])] : reportCols).map((c) => <th key={c} className={c === 'Description' ? undefined : 'num'}>{data ? c.split(' ').map((part) => t(part)).join(' ') : t(c)}</th>)}</tr></thead>
          {data ? <Comparison key={leaf.report} data={data} report={leaf.report} /> : isAudit ? <AuditTrail db={db} rows={auditPagedRows} loading={isServer() && serverAuditLog === undefined} denied={isServer() && serverAuditLog === null} /> : <Body db={db} sourceDb={sourceDb} period={period} companyId={selectedCompany} analyticAccountIds={analyticAccountIds} variant={activeTaxVariant} />}
        </table>
      </div>
    </main>
  );
}
