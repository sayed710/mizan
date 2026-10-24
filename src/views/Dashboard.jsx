import { search } from '../orm.js';
import { today } from '../models/index.js';
import { useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { Graph } from './Graph.jsx';

const sum = (recs, f) => recs.reduce((s, r) => s + (Number(r[f]) || 0), 0);

/** Invoicing overview: KPI tiles (each links to the matching list) + monthly invoiced chart. */
export function Dashboard() {
  const db = useDb();
  const posted = search(db, 'account.move').filter((m) => m.state === 'posted');
  const invoices = posted.filter((m) => m.move_type === 'out_invoice');
  const bills = posted.filter((m) => m.move_type === 'in_invoice');
  const month = today().slice(0, 7);
  const overdue = invoices.filter((m) => m.payment_state !== 'paid' && m.invoice_date_due < today());
  const byPartner = Object.entries(
    invoices.reduce((acc, m) => ({ ...acc, [m.partner_id]: (acc[m.partner_id] ?? 0) + m.amount_total }), {}),
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const tiles = [
    ['Invoiced this month', money(sum(invoices.filter((m) => m.invoice_date?.startsWith(month)), 'amount_total')), '#/accounting/invoices?view=list'],
    ['Receivable', money(sum(invoices, 'amount_residual')), '#/accounting/invoices?view=list'],
    ['Payable', money(sum(bills, 'amount_residual')), '#/accounting/bills?view=list'],
    ['Overdue invoices', String(overdue.length), '#/accounting/invoices?view=list'],
    ['To reconcile', String(search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check').length), '#/accounting/bank'],
  ];

  return (
    <main className="action dashboard">
      <div className="control-panel"><h1 className="cp-title">{t('Dashboard')}</h1></div>
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
