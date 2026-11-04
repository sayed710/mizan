// Website: published pages + an online shop whose checkout creates a customer and a quotation.
import { useEffect, useState } from 'react';
import { create, read, search } from '../orm.js';
import { commit, currentCompany, getDb, useDb } from '../store.js';
import { lang, t } from '../i18n.js';
import { money } from '../ui.jsx';
import { menuTree, pageFor, resolveUrl } from '../models/websiteplus.js';

/** Nested native links remain keyboard accessible; only HTTP and local destinations are navigable. */
export function SiteMenu({ items, onPage }) {
  return <ul>{items.map((item) => {
    const href = /^(https?:\/\/|\/(?!\/)|#)/i.test(item.href) ? item.href : '#';
    return <li key={item.id}><a href={href} target={item.new_window ? '_blank' : undefined} rel={item.new_window ? 'noopener' : undefined} onClick={onPage && !item.new_window ? (e) => {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && onPage(href)) e.preventDefault();
    } : undefined}>{item.name}</a>{item.children?.length > 0 && <SiteMenu items={item.children} onPage={onPage} />}</li>;
  })}</ul>;
}

/** Apply page SEO while mounted and restore the host application's metadata on navigation. */
export function usePageMeta(page) {
  const title = page?.website_meta_title || page?.name;
  const description = page?.website_meta_description ?? '';
  useEffect(() => {
    if (!title) return undefined;
    const previousTitle = document.title;
    let meta = document.querySelector('meta[name="description"]');
    const existed = !!meta;
    const previous = meta?.getAttribute('content');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.append(meta); }
    document.title = title;
    meta.setAttribute('content', description);
    return () => {
      document.title = previousTitle;
      if (!existed) meta.remove(); else if (previous === null) meta.removeAttribute('content'); else meta.setAttribute('content', previous);
    };
  }, [title, description]);
}

/** Very small text format: "# " heading, "## " subheading, blank line = new paragraph. Rendered as text (no HTML injection). */
function Content({ text = '' }) {
  return text.split(/\n{2,}/).map((block, i) => {
    if (block.startsWith('## ')) return <h3 key={i}>{block.slice(3)}</h3>;
    if (block.startsWith('# ')) return <h2 key={i}>{block.slice(2)}</h2>;
    return <p key={i}>{block}</p>;
  });
}

function Shop({ db, cart, setCart, onCheckout }) {
  const products = search(db, 'product').filter((p) => p.list_price > 0 && p.website_published !== false);
  return (
    <>
      <h2>{t('Shop')}</h2>
      <div className="shop-grid">
        {products.map((p) => (
          <article key={p.id} className="shop-item">
            <div className="shop-thumb" aria-hidden="true">{p.name[0]}</div>
            <h3>{p.name}</h3>
            <p className="price">{money(p.list_price)}</p>
            <button type="button" className="btn primary" onClick={() => setCart({ ...cart, [p.id]: (cart[p.id] ?? 0) + 1 })}>{t('Add to Cart')}</button>
          </article>
        ))}
      </div>
      {Object.keys(cart).length > 0 && (
        <aside className="shop-cart">
          <h3>{t('Your Cart')}</h3>
          {Object.entries(cart).map(([id, qty]) => <div key={id}>{qty} × {read(db, 'product', Number(id))?.name}</div>)}
          <button type="button" className="btn primary" onClick={onCheckout}>{t('Checkout')}</button>
        </aside>
      )}
    </>
  );
}

function Checkout({ db, cart, onDone }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', city: '' });
  const [error, setError] = useState(null);
  const lines = Object.entries(cart).map(([id, qty]) => ({ product_id: Number(id), qty, price_unit: read(db, 'product', Number(id)).list_price, tax: 14 }));
  const total = lines.reduce((s, l) => s + l.qty * l.price_unit * 1.14, 0);
  const submit = (e) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) { setError(t('Enter a valid email address')); return; }
    const existing = search(getDb(), 'res.partner').find((p) => p.email?.toLowerCase() === form.email.toLowerCase());
    let next = getDb();
    let partnerId = existing?.id;
    if (!partnerId) {
      const res = create(next, 'res.partner', { name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim(), city: form.city.trim(), tag_ids: ['Website'] });
      next = res.db;
      partnerId = res.id;
    }
    const order = create(next, 'sale.order', { partner_id: partnerId, order_line: lines, state: 'sent', source: 'website' });
    commit(order.db);
    onDone(read(order.db, 'sale.order', order.id).name);
  };
  const field = (k, label, type = 'text') => (
    <label>{t(label)}<input type={type} required={k !== 'phone' && k !== 'city'} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
  );
  return (
    <form className="checkout" onSubmit={submit}>
      <h2>{t('Checkout')}</h2>
      <p>{t('Total')}: <b>{money(total)}</b></p>
      {field('name', 'Name')}
      {field('email', 'Email', 'email')}
      {field('phone', 'Phone', 'tel')}
      {field('city', 'City')}
      {error && <div className="alert" role="alert">{error}</div>}
      <button type="submit" className="btn primary">{t('Place Order')}</button>
    </form>
  );
}

export const websiteCompany = (db) => read(db, 'res.company', 1) ?? currentCompany(db);

export function Website() {
  const db = useDb();
  const company = websiteCompany(db);
  const pages = search(db, 'website.page').filter((p) => !!resolveUrl(db, p.slug)).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const [slug, setSlug] = useState(() => location.pathname !== '/' ? decodeURIComponent(location.pathname).replace(/^\/+|\/+$/g, '') : pages[0]?.slug ?? 'shop');
  const [cart, setCart] = useState({});
  const [step, setStep] = useState('browse');
  const [done, setDone] = useState(null);
  const original = pages.find((p) => p.slug.replace(/^\/+|\/+$/g, '') === slug);
  const page = original && pageFor(db, original, lang);
  const menus = menuTree(db);
  usePageMeta(page);
  const go = (s) => { setSlug(s); setStep('browse'); setDone(null); };

  return (
    <main className="site">
      {page?.header_visible !== false && <header className="site-nav">
        <b className="site-brand">{company.name}</b>
        <nav aria-label={t('Website')}>
          {menus.length ? <SiteMenu items={menus} onPage={(href) => {
            const target = pages.find((p) => `/${p.slug.replace(/^\/+|\/+$/g, '')}` === href);
            if (!target) return false;
            go(target.slug); return true;
          }} /> : pages.map((p) => <button key={p.id} type="button" aria-current={slug === p.slug ? 'page' : undefined} onClick={() => go(p.slug)}>{pageFor(db, p, lang).name}</button>)}
          <button type="button" aria-current={slug === 'shop' ? 'page' : undefined} onClick={() => go('shop')}>{t('Shop')}</button>
        </nav>
        <a className="btn sm" href="#/website/pages">{t('Edit Pages')}</a>
      </header>}
      <div className="site-body">
        {done && <div className="site-thanks" role="status"><h2>{t('Thank you!')}</h2><p>{t('Your order {name} has been received.', { name: done })}</p></div>}
        {!done && slug === 'shop' && step === 'browse' && <Shop db={db} cart={cart} setCart={setCart} onCheckout={() => setStep('checkout')} />}
        {!done && slug === 'shop' && step === 'checkout' && <Checkout db={db} cart={cart} onDone={(name) => { setDone(name); setCart({}); }} />}
        {!done && slug !== 'shop' && (page ? <article className="site-page"><h1>{page.name}</h1><Content text={page.content} /></article> : <p className="alert">{t('Page not found')}</p>)}
      </div>
      {page?.footer_visible !== false && <footer className="site-footer">© {new Date().getFullYear()} {company.name}</footer>}
    </main>
  );
}
