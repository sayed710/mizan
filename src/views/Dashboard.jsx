import { search } from '../orm.js';
import { today } from '../models/index.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { Graph } from './Graph.jsx';
import { journalCards } from '../models/finance.js';
import { companyViewDb } from '../companyView.js';
import { companyAmount, companySum } from '../models/money.js';

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

// Documents in other currencies are converted to the company currency before they are added up.
const sum = (db, recs, f) => companySum(db, recs, f);

/** Invoicing overview: KPI tiles (each links to the matching list) + monthly invoiced chart. */
export function Dashboard() {
  const db = companyViewDb(useDb());
  const posted = search(db, 'account.move').filter((m) => m.state === 'posted');
  const invoices = posted.filter((m) => m.move_type === 'out_invoice');
  const bills = posted.filter((m) => m.move_type === 'in_invoice');
  const month = today().slice(0, 7);
  const overdue = invoices.filter((m) => m.payment_state !== 'paid' && m.invoice_date_due < today());
  const byPartner = Object.entries(
    invoices.reduce((acc, m) => ({ ...acc, [m.partner_id]: (acc[m.partner_id] ?? 0) + companyAmount(db, m, 'amount_total') }), {}),
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const tiles = [
    ['Invoiced this month', money(sum(db, invoices.filter((m) => m.invoice_date?.startsWith(month)), 'amount_total')), '#/accounting/invoices?view=list'],
    ['Receivable', money(sum(db, invoices, 'amount_residual')), '#/accounting/invoices?view=list'],
    ['Payable', money(sum(db, bills, 'amount_residual')), '#/accounting/bills?view=list'],
    ['Overdue invoices', String(overdue.length), '#/accounting/invoices?view=list'],
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
