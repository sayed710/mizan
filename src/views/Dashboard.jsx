import { search } from '../orm.js';
import { today } from '../models/index.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { Graph } from './Graph.jsx';
import { journalCards } from '../models/finance.js';
import { statementLinesWithoutJournal } from '../models/bank.js';
import { companyViewDb } from '../companyView.js';
import { currentCompany } from '../models/company.js';
import { invoiceKpis } from '../dashboardKpis.js';
import { RateNote } from './RateNote.jsx';
import { journalCardListUrl } from './journalDashboard.js';
import { importAccept, importModelFile } from './importModelFile.js';

const STEP_ICONS = {
  company: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16M6 20V5h12v15M10 9h1M13 9h1M10 13h1M13 13h1M10 20v-3h4v3" />
    </svg>
  ),
  tax: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18" />
      <circle cx="7.5" cy="7.5" r="2" />
      <circle cx="16.5" cy="16.5" r="2" />
    </svg>
  ),
  bill: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4h7l4 4v12H7zM14 4v4h4M10 12h5M10 16h5" />
    </svg>
  ),
};

function OnboardingStep({ href, icon, label }) {
  return (
    <a className="journal-onboarding-step" href={href}>
      <span className="journal-onboarding-icon" aria-hidden="true">{STEP_ICONS[icon]}</span>
      <span>{t(label)}</span>
    </a>
  );
}

/** Journal card: the journal's figures and the shortcuts Odoo puts on it. */
function JournalCard({ card, companyId }) {
  // A journal whose card cannot be computed keeps its title and shows why, so the rest of the dashboard still renders.
  if (card.kind === 'error') {
    return (
      <section className="panel journal-card journal-card-error">
        <h2>{card.journal.name}</h2>
        <p className="journal-error" role="alert">{t(card.error)}</p>
      </section>
    );
  }
  const list = journalCardListUrl(card);
  if (card.kind === 'sale' || card.kind === 'purchase') {
    const sale = card.kind === 'sale';
    const [actionLabel, actionHref] = sale ? ['New Invoice', '#/accounting/invoices/new'] : ['New Bill', '#/accounting/bills/new'];
    const empty = !card.postedDocuments && !card.draft;
    const rows = [
      ['To Validate', card.draft, card.draftAmount, `${list}&filter=draft`],
      [sale ? 'Unpaid' : 'To Pay', card.unpaid, card.unpaidAmount, `${list}&filter=unpaid`],
      ['Late', card.late, card.lateAmount, `${list}&filter=overdue`],
    ];
    return (
      <section className="panel journal-card">
        <h2><a href={list}>{card.journal.name}</a></h2>
        {empty ? (
          <p className="journal-empty muted">{t(sale ? 'Get paid online and send your invoices.' : 'Record your vendor bills and pay them easily.')}</p>
        ) : (
          <dl>
            {rows.map(([label, count, amount, href]) => (
              <div key={label}>
                <dt><a href={href}>{count} {t(label)}</a></dt>
                <dd><a href={href}>{money(amount)}</a></dd>
              </div>
            ))}
          </dl>
        )}
        <RateNote count={card.unratedCount} />
        <a className="btn primary sm" href={actionHref}>{t(actionLabel)}</a>
        {empty && (
          sale ? (
            <div className="journal-onboarding">
              <OnboardingStep href={`#/open/res.company/${companyId}`} icon="company" label="Set up your company" />
              <span className="journal-onboarding-sep muted">{t('and')}</span>
              <OnboardingStep href="#/accounting/taxes" icon="tax" label="Configure taxes" />
            </div>
          ) : (
            <div className="journal-onboarding journal-onboarding-single">
              <span className="journal-onboarding-sep muted">{t('or')}</span>
              <OnboardingStep href="#/accounting/bills/new" icon="bill" label="Create a vendor bill manually" />
            </div>
          )
        )}
        {!empty && (
          <Graph
            data={card.monthlyTotals.map((m) => ({ label: m.month, shortLabel: m.month.slice(5), value: m.total }))}
            formatValue={money}
            compact
          />
        )}
      </section>
    );
  }
  if (card.kind === 'bank' || card.kind === 'cash') {
    const empty = !card.hasPosted && !card.toReconcile;
    return (
      <section className="panel journal-card">
        <h2><a href={list}>{card.journal.name}</a></h2>
        {empty ? (
          card.kind === 'bank' ? (
            <>
              <p className="journal-empty muted">{t('Import your bank statements to reconcile them.')}</p>
              <label className="btn primary sm">
                {t('Import Statement')}
                <input
                  type="file"
                  accept={importAccept('account.bank.statement.line')}
                  hidden
                  onChange={(e) => {
                    if (e.target.files[0]) importModelFile('account.bank.statement.line', { journal_id: card.journal.id }, e.target.files[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            </>
          ) : (
            <>
              <p className="journal-empty muted">{t('Record your cash transactions.')}</p>
              <a className="btn primary sm" href={list}>{t('Cash Transactions')}</a>
            </>
          )
        ) : (
          <>
            <dl>
              <div><dt>{t('Balance')}</dt><dd>{money(card.balance)}</dd></div>
              {card.kind === 'bank' && card.hasOutstandingAccounts && (
                <div><dt>{card.outstandingCount} {t('Outstanding Payments')}</dt><dd>{money(card.outstandingBalance)}</dd></div>
              )}
              {card.miscCount > 0 && (
                <div><dt>{card.miscCount} {t('Misc. Operations')}</dt><dd>{money(card.miscBalance)}</dd></div>
              )}
            </dl>
            <RateNote count={card.unratedCount} />
            {card.kind === 'bank' && card.toReconcile > 0 && (
              <a className="btn primary sm" href={list}>{card.toReconcile} {t('To Reconcile')}</a>
            )}
          </>
        )}
      </section>
    );
  }
  return (
    <section className="panel journal-card">
      <h2><a href={list}>{card.journal.name}</a></h2>
      <dl>
        <div><dt>{t('Posted Entries')}</dt><dd>{card.entries}</dd></div>
        <div><dt>{t('Drafts')}</dt><dd>{card.draft}</dd></div>
      </dl>
    </section>
  );
}

/** Invoicing overview: KPI tiles (each links to the matching list) + journal cards + monthly invoiced chart. */
export function Dashboard() {
  const db = companyViewDb(useDb());
  const activeCompanyId = currentCompany(db);
  const invoices = search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice');
  const kpi = invoiceKpis(db, today().slice(0, 7));
  const byPartner = kpi.topCustomers;
  const withoutJournal = statementLinesWithoutJournal(db).length;

  const tiles = [
    ['Invoiced this month', money(kpi.invoicedThisMonth), '#/accounting/invoices?view=list&filter=posted'],
    ['Receivable', money(kpi.receivable), '#/accounting/invoices?view=list&filter=unpaid'],
    ['Payable', money(kpi.payable), '#/accounting/bills?view=list&filter=unpaid'],
    ['Overdue invoices', String(kpi.overdue), '#/accounting/invoices?view=list&filter=overdue'],
    ['To reconcile', String(search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check').length), '#/accounting/bank'],
    ...(withoutJournal ? [['Bank transactions without a journal', String(withoutJournal), '#/accounting/bank?view=list&filter=unassigned']] : []),
  ];

  return (
    <main className="action dashboard">
      <div className="control-panel"><h1 className="cp-title">{t('Dashboard')}</h1></div>
      <RateNote count={kpi.unratedCount} />
      <div className="kpis">
        {tiles.map(([label, value, href]) => (
          <a key={label} className="kpi" href={href}>
            <span>{t(label)}</span>
            <b>{value}</b>
          </a>
        ))}
      </div>
      <div className="journal-cards">{journalCards(db).map((c) => <JournalCard key={c.journal.id} card={c} companyId={c.journal.company_id ?? activeCompanyId} />)}</div>
      <div className="dash-grid">
        <section className="panel">
          <h2>{t('Monthly invoiced')}</h2>
          <Graph db={db} model="account.move" records={invoices} groupBy={['invoice_date']} />
        </section>
        <section className="panel">
          <h2>{t('Top customers')}</h2>
          <ol className="ranking">
            {byPartner.map(([pid, total]) => (
              <li key={pid}>
                <a href={`#/accounting/invoices?view=list&rel=partner_id:${pid}`}>{db.records['res.partner'].find((p) => p.id === Number(pid))?.name}</a>
                <b>{money(total)}</b>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
