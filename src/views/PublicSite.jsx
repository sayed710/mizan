// Public website (no login): published pages + shop, served from /api/public/* on the Mizan server.
import { useEffect, useState } from 'react';
import { t } from '../i18n.js';
import { money, setCurrency } from '../ui.jsx';

const post = (path, body) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

function Content({ text = '' }) {
  return text.split(/\n{2,}/).map((block, i) => {
    if (block.startsWith('## ')) return <h3 key={i}>{block.slice(3)}</h3>;
    if (block.startsWith('# ')) return <h2 key={i}>{block.slice(2)}</h2>;
    return <p key={i}>{block}</p>;
  });
}

export function PublicSite() {
  const [site, setSite] = useState(null);
  const [slug, setSlug] = useState(null);
  const [cart, setCart] = useState({});
  const [form, setForm] = useState({ name: '', email: '', phone: '', city: '' });
  const [step, setStep] = useState('browse');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    fetch('/api/public/site').then((r) => r.json()).then((s) => {
      setCurrency(s.currency);
      setSite(s);
      setSlug(s.pages[0]?.slug ?? 'shop');
    }).catch(() => setError(t('The website is not available right now.')));
  }, []);

  if (error && !site) return <main className="site"><div className="site-body"><p className="alert">{error}</p></div></main>;
  if (!site) return <main className="site"><div className="site-body muted">…</div></main>;

  const product = (id) => site.products.find((p) => p.id === Number(id));
  const lines = Object.entries(cart).map(([id, qty]) => ({ product_id: Number(id), qty }));
  const total = lines.reduce((s, l) => s + l.qty * (product(l.product_id)?.price ?? 0) * 1.14, 0);
  const page = site.pages.find((p) => p.slug === slug);

  const checkout = async (e) => {
    e.preventDefault();
    setError(null);
    const r = await post('/api/public/order', { ...form, lines });
    if (!r.ok) { setError(r.data.error ?? t('Could not place the order')); return; }
    setResult(r.data.order);
    setCart({});
    setStep('done');
  };

  return (
    <main className="site">
      <header className="site-nav">
        <b className="site-brand">{site.company}</b>
        <nav>
          {site.pages.map((p) => <button key={p.slug} type="button" aria-current={slug === p.slug ? 'page' : undefined} onClick={() => { setSlug(p.slug); setStep('browse'); }}>{p.name}</button>)}
          <button type="button" aria-current={slug === 'shop' ? 'page' : undefined} onClick={() => { setSlug('shop'); setStep('browse'); }}>{t('Shop')}</button>
          {site.jobs?.length > 0 && <button type="button" aria-current={slug === 'jobs' ? 'page' : undefined} onClick={() => { setSlug('jobs'); setStep('browse'); setApplied(false); }}>{t('Jobs')}</button>}
        </nav>
        <a className="btn sm" href="#/">{t('Log in')}</a>
      </header>
      <div className="site-body">
        {step === 'done' && <div className="site-thanks" role="status"><h2>{t('Thank you!')}</h2><p>{t('Your order {name} has been received.', { name: result })}</p></div>}
        {slug === 'jobs' && (applied ? <div className="site-thanks" role="status"><h2>{t('Thank you!')}</h2><p>{t('Your application was received.')}</p></div> : (
          <>
            <h2>{t('Jobs')}</h2>
            {site.jobs.map((j) => (
              <article key={j.id} className="shop-item job">
                <h3>{j.name}</h3>
                <p>{j.description}</p>
                {applying === j.id ? (
                  <form className="checkout" onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const r = await post('/api/public/apply', { job_id: j.id, name: f.get('name'), email: f.get('email'), phone: f.get('phone'), motivation: f.get('motivation') });
                    if (r.ok) setApplied(true); else setError(r.data.error);
                  }}>
                    <label>{t('Name')}<input name="name" required maxLength={120} /></label>
                    <label>{t('Email')}<input name="email" type="email" required /></label>
                    <label>{t('Phone')}<input name="phone" type="tel" /></label>
                    <label>{t('Why you?')}<textarea name="motivation" maxLength={5000} /></label>
                    {error && <div className="alert" role="alert">{error}</div>}
                    <button type="submit" className="btn primary">{t('Apply')}</button>
                  </form>
                ) : <button type="button" className="btn primary" onClick={() => setApplying(j.id)}>{t('Apply')}</button>}
              </article>
            ))}
          </>
        ))}
        {step !== 'done' && slug !== 'shop' && slug !== 'jobs' && page && <article className="site-page"><h1>{page.name}</h1><Content text={page.content} /></article>}
        {step === 'browse' && slug === 'shop' && (
          <>
            <h2>{t('Shop')}</h2>
            <div className="shop-grid">
              {site.products.map((p) => (
                <article key={p.id} className="shop-item">
                  <div className="shop-thumb" aria-hidden="true">{p.name[0]}</div>
                  <h3>{p.name}</h3>
                  <p className="price">{money(p.price)}</p>
                  <button type="button" className="btn primary" onClick={() => setCart({ ...cart, [p.id]: (cart[p.id] ?? 0) + 1 })}>{t('Add to Cart')}</button>
                </article>
              ))}
            </div>
            {lines.length > 0 && (
              <aside className="shop-cart">
                <h3>{t('Your Cart')}</h3>
                {lines.map((l) => <div key={l.product_id}>{l.qty} × {product(l.product_id)?.name}</div>)}
                <button type="button" className="btn primary" onClick={() => setStep('checkout')}>{t('Checkout')}</button>
              </aside>
            )}
          </>
        )}
        {step === 'checkout' && (
          <form className="checkout" onSubmit={checkout}>
            <h2>{t('Checkout')}</h2>
            <p>{t('Total')}: <b>{money(total)}</b></p>
            {[['name', 'Name', 'text', true], ['email', 'Email', 'email', true], ['phone', 'Phone', 'tel', false], ['city', 'City', 'text', false]].map(([k, label, type, req]) => (
              <label key={k}>{t(label)}<input type={type} required={req} maxLength={120} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>
            ))}
            {error && <div className="alert" role="alert">{error}</div>}
            <button type="submit" className="btn primary">{t('Place Order')}</button>
          </form>
        )}
      </div>
      <footer className="site-footer">© {new Date().getFullYear()} {site.company}</footer>
    </main>
  );
}
