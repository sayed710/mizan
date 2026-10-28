import { search } from '../orm.js';
import { today } from '../models/index.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { Graph } from './Graph.jsx';
import { journalCards } from '../models/finance.js';
import { companyViewDb } from '../companyView.js';
import { invoiceKpis } from '../dashboardKpis.js';

const LINKS = { sale: 'invoices', purchase: 'bills', bank: 'bank', cash: 'entries', general: 'entries' };

/** Journal card: the journal's figures and the shortcuts Odoo puts on it. */
function JournalCard({ card }) {
  const list = `#/accounting/${LINKS[card.kind]}`;
  const figures = {
    sale: [['To Validate', card.draft], ['Unpaid', `${card.unpaid} · ${money(card.unpaidAmount)}`], ['Late', card.late]],
    purchase: [['To Validate', card.draft], ['To Pay', `${card.unpaid} · ${money(card.unpaidAmount)}`], ['Late', card.late]],
    bank: [['Balance', money(card.balance)], ['To Reconcile', `${card.toReconcile} · ${money(card.toReconcileAmount)}`]],
    cash: [['Balance', money(card.balance)]],
    general: [['Posted Entries', card.entries], ['Drafts', card.draft]],
  }[card.kind];
  const action = { INV: ['New Invoice', '#/accounting/invoices/new'], BILL: ['New Bill', '#/accounting/bills/new'], BNK1: ['Reconcile', '#/accounting/bank'] }[card.journal.code];
  return (
    <section className="panel journal-card">
      <h2><a href={list}>{card.journal.name}</a></h2>
      <dl>{figures.map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>)}</dl>
      {action && <a className="btn primary sm" href={action[1]}>{t(action[0])}</a>}
    </section>
  );
}

/** Invoicing overview: KPI tiles (each links to the matching list) + monthly invoiced chart. */
export function Dashboard() {
  const db = companyViewDb(useDb());
  const invoices = search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice');
  const kpi = invoiceKpis(db, today().slice(0, 7));
  const byPartner = kpi.topCustomers;

  const tiles = [
    ['Invoiced this month', money(kpi.invoicedThisMonth), '#/accounting/invoices?view=list&filter=posted'],
    ['Receivable', money(kpi.receivable), '#/accounting/invoices?view=list&filter=unpaid'],
    ['Payable', money(kpi.payable), '#/accounting/bills?view=list&filter=unpaid'],
    ['Overdue invoices', String(kpi.overdue), '#/accounting/invoices?view=list&filter=overdue'],
    ['To reconcile', String(search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check').length), '#/accounting/bank'],
  ];

  return (
    <main className="action dashboard">
      <div className="control-panel"><h1 className="cp-title">{t('Dashboard')}</h1></div>
      <div className="journal-cards">{journalCards(db).map((c) => <JournalCard key={c.journal.id} card={c} />)}</div>
      <div className="kpis">
        {tiles.map(([label, value, href]) => (
          <a key={label} className="kpi" href={href}>
            <span>{t(label)}</span>
            <b>{value}</b>
          </a>
        ))}
      </div>
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
