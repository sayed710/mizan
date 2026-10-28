import { useRef, useState } from 'react';
import { read } from '../orm.js';
import { amounts } from '../models/common.js';
import { closeSession, openSession, payOrder, priceLines, sessionTotals, startSession } from '../models/pos.js';
import { commit, getDb, isServer, serverAction, useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { relationCandidates, viewRecords } from '../companyView.js';

/** No open session: count the opening cash and start one. */
function OpenSession() {
  const [cash, setCash] = useState('0');
  return (
    <main className="pos pos-done">
      <form className="sheet receipt" onSubmit={(e) => { e.preventDefault(); commit(startSession(getDb(), cash).db); }}>
        <h2>{t('Opening Cash Control')}</h2>
        <label>{t('Opening Cash')} <input type="number" step="0.01" min="0" value={cash} onChange={(e) => setCash(e.target.value)} autoFocus /></label>
        <button type="submit" className="btn primary">{t('Open Session')}</button>
      </form>
    </main>
  );
}

/** Touch-friendly register: product grid → cart → cash/card payment creates a pos.order and moves stock. */
export function Pos() {
  const db = useDb();
  const [cart, setCart] = useState([]);
  const [query, setQuery] = useState('');
  const [categ, setCateg] = useState(null);
  const [partner, setPartner] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const requestKey = useRef(null);

  const session = openSession(db);
  const products = viewRecords(db, 'product').filter((p) => p.available_in_pos !== false && p.sale_ok !== false);
  const categories = [...new Set(products.map((p) => p.categ).filter(Boolean))];
  const shown = products.filter((p) => (!categ || p.categ === categ) && p.name.toLowerCase().includes(query.toLowerCase()));
  const lines = priceLines(db, cart, Number(partner) || null);
  const total = amounts(lines);

  const add = (id) => {
    if (inFlight.current) return;
    requestKey.current = null;
    setCart((c) => c.some((l) => l.product_id === id) ? c.map((l) => l.product_id === id ? { ...l, qty: l.qty + 1 } : l) : [...c, { product_id: id, qty: 1 }]);
  };
  const setQty = (id, qty) => {
    if (inFlight.current) return;
    requestKey.current = null;
    setCart((c) => qty <= 0 ? c.filter((l) => l.product_id !== id) : c.map((l) => l.product_id === id ? { ...l, qty } : l));
  };

  const pay = async (method) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    requestKey.current ??= crypto.randomUUID();
    const partner_id = Number(partner) || null;
    let receipt;
    try {
      if (isServer()) {
        receipt = await serverAction('/api/pos/pay', { lines: cart, method, partner_id, request_key: requestKey.current });
        if (receipt?.ok === false) throw new Error(receipt.error);
      } else {
        const { db: booked, id } = payOrder(getDb(), { lines, method, partner_id });
        commit(booked);
        receipt = { id, name: read(booked, 'pos.order', id).name, total: read(booked, 'pos.order', id).amount_total };
      }
    } catch (e) {
      alert(e.message);
      return;
    } finally { inFlight.current = false; setPending(false); }
    requestKey.current = null;
    setReceipt({ ...receipt, method });
    setCart([]);
    setPartner('');
  };
  const close = () => {
    const { expected } = sessionTotals(getDb(), session);
    const counted = prompt(t('Counted cash in the drawer (expected {n})', { n: expected }), String(expected));
    if (counted == null) return;
    if (isServer()) serverAction('/api/pos/close', { session_id: session.id, counted }).catch((e) => alert(e.message));
    else commit(closeSession(getDb(), session, counted));
  };

  if (!session) return <OpenSession />;

  if (receipt) {
    return (
      <main className="pos pos-done">
        <div className="sheet receipt" role="status">
          <h2>{receipt.name}</h2>
          <p className="big">{money(receipt.total)}</p>
          <p className="muted">{t(receipt.method === 'cash' ? 'Cash' : 'Card')}</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => window.print()}>{t('Print')}</button>
            <a className="btn" href={`#/pos/orders/${receipt.id}`}>{t('Orders')}</a>
            <button type="button" className="btn primary" autoFocus onClick={() => setReceipt(null)}>{t('New Order')}</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="pos">
      <section className="pos-products">
        <div className="pos-filters">
          <input type="search" placeholder={t('Search products...')} aria-label={t('Search products...')} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="button" className={`chip ${!categ ? 'on' : ''}`} onClick={() => setCateg(null)}>{t('All')}</button>
          {categories.map((c) => <button key={c} type="button" className={`chip ${categ === c ? 'on' : ''}`} onClick={() => setCateg(c)}>{c}</button>)}
        </div>
        <div className="pos-grid">
          {shown.map((p) => (
            <button key={p.id} type="button" className="pos-tile" disabled={pending} onClick={() => add(p.id)}>
              <span className="pos-initial" aria-hidden="true">{p.name[0]}</span>
              <span className="pos-name">{p.name}</span>
              <span className="pos-price">{money(p.list_price)}</span>
              {p.type === 'goods' && <span className={`pos-stock ${p.qty_available <= 0 ? 'out' : ''}`}>{p.qty_available}</span>}
            </button>
          ))}
        </div>
      </section>
      <aside className="pos-cart" aria-label={t('Order')}>
        <div className="row">
          <span className="muted grow">{session.name}</span>
          <button type="button" className="btn sm" disabled={pending} onClick={close}>{t('Close Session')}</button>
        </div>
        <select aria-label={t('Customer')} disabled={pending} value={partner} onChange={(e) => { requestKey.current = null; setPartner(e.target.value); }}>
          <option value="">{t('Customer')}…</option>
          {relationCandidates(db, 'res.partner', partner).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <ul className="pos-lines">
          {lines.map((l) => (
            <li key={l.product_id}>
              <span className="grow">{read(db, 'product', l.product_id)?.name}</span>
              <button type="button" className="round" aria-label="−" onClick={() => setQty(l.product_id, l.qty - 1)}>−</button>
              <b>{l.qty}</b>
              <button type="button" className="round" aria-label="+" onClick={() => setQty(l.product_id, l.qty + 1)}>+</button>
              <span className="pos-line-total">{money(l.qty * l.price_unit)}</span>
            </li>
          ))}
          {!lines.length && <li className="muted">{t('Add products to start an order.')}</li>}
        </ul>
        <dl className="totals">
          <div><dt>{t('Untaxed Amount')}</dt><dd>{money(total.untaxed)}</dd></div>
          <div><dt>{t('Taxes')}</dt><dd>{money(total.tax)}</dd></div>
          <div className="grand"><dt>{t('Total')}</dt><dd>{money(total.total)}</dd></div>
        </dl>
        <div className="pos-pay" aria-busy={pending}>
          <button type="button" className="btn primary" disabled={pending || !lines.length} onClick={() => pay('cash')}>{t('Cash')}</button>
          <button type="button" className="btn primary" disabled={pending || !lines.length} onClick={() => pay('card')}>{t('Card')}</button>
        </div>
      </aside>
    </main>
  );
}
