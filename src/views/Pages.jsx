// Barcode scanning, Shop Floor and the cross-app Overview dashboard.
import { useRef, useState } from 'react';
import { models, today } from '../models/index.js';
import { postNote, read, search, write } from '../orm.js';
import { profitAndLoss } from '../models/ledger.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { Graph } from './Graph.jsx';
import { companyViewDb } from '../companyView.js';
import { companySum } from '../models/money.js';

/** Scan (or type) a product reference/name, then count stock — mirrors a warehouse scanner flow. */
export function Barcode() {
  const db = useDb();
  const [code, setCode] = useState('');
  const [productId, setProductId] = useState(null);
  const [counted, setCounted] = useState(0);
  const [message, setMessage] = useState(null);
  const input = useRef(null);
  const product = productId && read(db, 'product', productId);

  const scan = () => {
    const q = code.trim().toLowerCase();
    if (!q) return;
    const found = search(db, 'product').find((p) => p.barcode?.toLowerCase() === q || p.default_code?.toLowerCase() === q)
      ?? search(db, 'product').find((p) => p.name.toLowerCase().includes(q));
    setCode('');
    if (!found) { setMessage(t('No product found for "{q}"', { q })); return; }
    if (found.id === productId) setCounted((c) => c + 1);
    else { setProductId(found.id); setCounted(1); }
    setMessage(null);
  };
  const apply = () => {
    const before = product.qty_available;
    const next = write(getDb(), 'product', product.id, { qty_available: counted });
    commit(postNote(next, 'product', product.id, `Inventory adjustment: ${before} → ${counted}`));
    setMessage(t('Stock of {name} set to {qty}', { name: product.name, qty: counted }));
    setProductId(null);
    input.current?.focus();
  };

  return (
    <main className="action barcode">
      <section className="sheet barcode-card">
        <div className="barcode-icon" aria-hidden="true">▮▯▮▮▯▮▯▮</div>
        <h1>{t('Scan a product')}</h1>
        <input ref={input} autoFocus value={code} placeholder={t('Barcode or reference, then Enter')} aria-label={t('Barcode')}
          onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') scan(); }} />
        {message && <p role="status" className="muted">{message}</p>}
        {product && (
          <div className="barcode-product">
            <h2>{product.name}</h2>
            <p className="muted">{product.default_code} · {t('On Hand')}: <b>{product.qty_available}</b></p>
            <div className="row barcode-count">
              <button type="button" className="round" aria-label="−" onClick={() => setCounted((c) => Math.max(0, c - 1))}>−</button>
              <input type="number" min="0" aria-label={t('Counted Quantity')} value={counted} onChange={(e) => setCounted(Math.max(0, Number(e.target.value) || 0))} />
              <button type="button" className="round" aria-label="+" onClick={() => setCounted((c) => c + 1)}>+</button>
            </div>
            <button type="button" className="btn primary" onClick={apply}>{t('Apply Count')}</button>
          </div>
        )}
      </section>
    </main>
  );
}

/** Operator view of confirmed manufacturing orders with a one-tap Produce. */
export function ShopFloor() {
  const db = useDb();
  const [error, setError] = useState(null);
  const orders = search(db, 'mrp.production').filter((o) => ['confirmed', 'progress'].includes(o.state));
  const produce = models['mrp.production'].form.buttons.find((b) => b.label === 'Produce');
  const run = (o) => {
    try {
      commit(produce.run(getDb(), read(getDb(), 'mrp.production', o.id)).db);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <main className="action">
      <div className="control-panel"><h1 className="cp-title">{t('Shop Floor')}</h1></div>
      {error && <div className="alert" role="alert" style={{ margin: '0 16px 12px' }}>{error}</div>}
      <div className="kanban-grid">
        {orders.map((o) => {
          const bom = read(db, 'mrp.bom', o.bom_id);
          return (
            <article key={o.id} className="card shopfloor">
              <div className="card-head"><strong>{o.name}</strong><span className="spacer" /><span className="badge">{o.date_deadline}</span></div>
              <div className="big-qty">{o.product_qty} × {read(db, 'product', o.product_id)?.name}</div>
              <ul className="components">
                {(bom?.components ?? []).map((c) => {
                  const p = read(db, 'product', c.product_id);
                  const need = (c.qty * o.product_qty) / (bom.product_qty || 1);
                  return <li key={c.product_id} className={p && p.qty_available < need ? 'short' : ''}>{p?.name}: {need} / {p?.qty_available}</li>;
                })}
              </ul>
              <button type="button" className="btn primary" onClick={() => run(o)}>{t('Produce')}</button>
            </article>
          );
        })}
        {!orders.length && <p className="empty">{t('Nothing to produce. Confirm a manufacturing order first.')}</p>}
      </div>
    </main>
  );
}

// Foreign-currency documents are converted to the company currency before they are added up.
const sum = (db, recs, f) => companySum(db, recs, f);

/** One page of headline numbers across apps; every tile links to the underlying list. */
export function Overview() {
  const db = companyViewDb(useDb());
  const month = today().slice(0, 7);
  const orders = search(db, 'sale.order').filter((o) => o.state === 'sale');
  const leads = search(db, 'crm.lead').filter((l) => l.stage_id !== 'won');
  const invoices = search(db, 'account.move').filter((m) => m.move_type === 'out_invoice' && m.state === 'posted');
  const pnl = profitAndLoss(db, { from: today().slice(0, 4) + '-01-01', to: today().slice(0, 4) + '-12-31' });
  const tiles = [
    ['Sales this month', money(sum(db, orders.filter((o) => o.date_order?.startsWith(month)), 'amount_total')), '#/sales/orders?view=list'],
    ['Open pipeline', money(sum(db, leads, 'expected_revenue')), '#/crm/pipeline'],
    ['Receivable', money(sum(db, invoices, 'amount_residual')), '#/accounting/invoices?view=list'],
    ['Net income (year)', money(pnl.net), '#/accounting/pnl'],
    ['Open tickets', String(search(db, 'helpdesk.ticket').filter((x) => x.stage_id !== 'solved').length), '#/helpdesk/tickets'],
    ['Products below minimum', String(search(db, 'product').filter((p) => p.type === 'goods' && p.qty_available < p.reorder_min).length), '#/inventory/stock?view=list'],
    ['Employees', String(search(db, 'hr.employee').length), '#/employees/employees'],
    ['Open tasks', String(search(db, 'project.task').filter((x) => x.stage_id !== 'done').length), '#/project/tasks'],
  ];
  return (
    <main className="action dashboard">
      <div className="control-panel"><h1 className="cp-title">{t('Overview')}</h1></div>
      <div className="kpis">
        {tiles.map(([label, value, href]) => <a key={label} className="kpi" href={href}><span>{t(label)}</span><b>{value}</b></a>)}
      </div>
      <div className="dash-grid two">
        <section className="panel"><h2>{t('Sales by month')}</h2><Graph db={db} model="sale.order" records={orders} groupBy={['date_order']} /></section>
        <section className="panel"><h2>{t('Pipeline by stage')}</h2><Graph db={db} model="crm.lead" records={leads} groupBy={['stage_id']} /></section>
      </div>
    </main>
  );
}
