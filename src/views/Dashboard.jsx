import { search } from '../orm.js';
import { today } from '../models/index.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { Graph } from './Graph.jsx';
import { journalCards } from '../models/finance.js';
import { statementLinesWithoutJournal } from '../models/bank.js';
import { companyViewDb } from '../companyView.js';
import { invoiceKpis } from '../dashboardKpis.js';
import { RateNote } from './RateNote.jsx';
import { journalCardListUrl } from './journalDashboard.js';

/** Journal card: the journal's figures and the shortcuts Odoo puts on it. */
function JournalCard({ card }) {
  const list = journalCardListUrl(card);
  if (card.kind === 'sale' || card.kind === 'purchase') {
    const sale = card.kind === 'sale';
    const [actionLabel, actionHref] = sale ? ['New Invoice', '#/accounting/invoices/new'] : ['New Bill', '#/accounting/bills/new'];
    const empty = !card.entries && !card.draft;
    const rows = [
      ['To Validate', card.draft, card.draftAmount, `${list}&filter=draft`],
      [sale ? 'Unpaid' : 'To Pay', card.unpaid, card.unpaidAmount, `${list}&filter=unpaid`],
      ['Late', card.late, card.lateAmount, `${list}&filter=overdue`],
    ];
    return (
      <section className="panel journal-card">
        <h2><a href={list}>{card.journal.name}</a></h2>
        {empty ? (
          <p className="journal-empty muted">{t(sale ? 'Create your first invoice.' : 'Create your first bill.')}</p>
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
          <p className="journal-empty muted">{t('No transactions yet.')}</p>
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
      <div className="journal-cards">{journalCards(db).map((c) => <JournalCard key={c.journal.id} card={c} />)}</div>
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
