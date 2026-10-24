import { useState } from 'react';
import { create, read, search } from '../orm.js';
import { amounts } from '../models/common.js';
import { moveStock } from '../models/sales.js';
import { postEntry } from '../models/ledger.js';
import { commit, getDb, useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';

const TAX = 14;

/** Touch-friendly register: product grid → cart → cash/card payment creates a pos.order and moves stock. */
export function Pos() {
  const db = useDb();
  const [cart, setCart] = useState([]);
  const [query, setQuery] = useState('');
  const [categ, setCateg] = useState(null);
  const [partner, setPartner] = useState('');
  const [receipt, setReceipt] = useState(null);

  const products = search(db, 'product');
  const categories = [...new Set(products.map((p) => p.categ).filter(Boolean))];
  const shown = products.filter((p) => (!categ || p.categ === categ) && p.name.toLowerCase().includes(query.toLowerCase()));
  const lines = cart.map((l) => ({ ...l, price_unit: read(db, 'product', l.product_id)?.list_price ?? 0, tax: TAX }));
  const total = amounts(lines);

  const add = (id) => setCart((c) => (c.some((l) => l.product_id === id)
    ? c.map((l) => (l.product_id === id ? { ...l, qty: l.qty + 1 } : l))
    : [...c, { product_id: id, qty: 1 }]));
  const setQty = (id, qty) => setCart((c) => (qty <= 0 ? c.filter((l) => l.product_id !== id) : c.map((l) => (l.product_id === id ? { ...l, qty } : l))));

  const pay = (method) => {
    const { db: next, id } = create(getDb(), 'pos.order', { partner_id: Number(partner) || null, payment_method: method, lines });
    const { db: booked } = postEntry(moveStock(next, lines, -1), {
      journal: 'POSS', ref: read(next, 'pos.order', id).name,
      lines: [
        { account: method === 'cash' ? '101501' : '101401', debit: total.total },
        { account: '400000', credit: total.untaxed },
        ...(total.tax ? [{ account: '251000', credit: total.tax }] : []),
      ],
    });
    commit(booked);
    setReceipt({ id, name: read(next, 'pos.order', id).name, total: total.total, method });
    setCart([]);
    setPartner('');
  };

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
            <button key={p.id} type="button" className="pos-tile" onClick={() => add(p.id)}>
              <span className="pos-initial" aria-hidden="true">{p.name[0]}</span>
              <span className="pos-name">{p.name}</span>
              <span className="pos-price">{money(p.list_price)}</span>
              {p.type === 'goods' && <span className={`pos-stock ${p.qty_available <= 0 ? 'out' : ''}`}>{p.qty_available}</span>}
            </button>
          ))}
        </div>
      </section>
      <aside className="pos-cart" aria-label={t('Order')}>
        <select aria-label={t('Customer')} value={partner} onChange={(e) => setPartner(e.target.value)}>
          <option value="">{t('Customer')}…</option>
          {search(db, 'res.partner').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
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
        <div className="pos-pay">
          <button type="button" className="btn primary" disabled={!lines.length} onClick={() => pay('cash')}>{t('Cash')}</button>
          <button type="button" className="btn primary" disabled={!lines.length} onClick={() => pay('card')}>{t('Card')}</button>
        </div>
      </aside>
    </main>
  );
}
