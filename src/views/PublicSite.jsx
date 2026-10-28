// Public website (no login): published pages + shop, served from /api/public/* on the Mizan server.
// Hash routes: #/shop… (Shop.jsx), #/shop/page/<slug>, #/shop/events, #/shop/appointments[/<id>] (Appointments.jsx), #/shop/jobs, #/shop/blog…, #/shop/forum… (Blog.jsx).
import { useEffect, useRef, useState } from 'react';
import { lang, t } from '../i18n.js';
import { setCurrency } from '../ui.jsx';
import { matchRule } from '../models/livechat.js';
import { Shop, parseShopRoute, useCart, useStored } from './Shop.jsx';
import { Blog, Forum } from './Blog.jsx';
import { Appointments } from './Appointments.jsx';
import { pageFor } from '../models/websiteplus.js';
import { SiteMenu, usePageMeta } from './Website.jsx';

/** Name/email/phone form posting to a public endpoint, with an optional choice; shows the server's answer. */
function VisitorForm({ action, path, extra, choices }) {
  const [state, setState] = useState({ open: false, done: false, error: null });
  if (state.done) return <p role="status">{t('Thank you! We will confirm by email.')}</p>;
  if (!state.open) return <button type="button" className="btn primary" onClick={() => setState({ ...state, open: true })}>{action}</button>;
  return (
    <form className="checkout" onSubmit={async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      const r = await post(path, { ...extra, ...f });
      setState(r.ok ? { ...state, done: true } : { ...state, error: r.data.error });
    }}>
      <label>{t('Name')}<input name="name" required maxLength={120} /></label>
      <label>{t('Email')}<input name="email" type="email" required /></label>
      <label>{t('Phone')}<input name="phone" type="tel" /></label>
      {choices && <label>{choices.label}<select name={choices.name}>{choices.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
      {state.error && <div className="alert" role="alert">{state.error}</div>}
      <button type="submit" className="btn primary">{action}</button>
    </form>
  );
}

const post = (path, body) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

const CHAT_POLL_MS = 3000;
const CHAT_STYLE = { position: 'fixed', insetBlockEnd: 16, insetInlineEnd: 16, zIndex: 50, maxInlineSize: 'calc(100vw - 32px)' };
const PANEL_STYLE = { inlineSize: 320, maxInlineSize: '100%', background: 'var(--surface, #fff)', border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 12, boxShadow: '0 4px 16px rgba(0,0,0,.15)' };

/** Floating live chat: name/email, then messages polled every 3 seconds, then a 5-star rating once closed. */
function LiveChat({ info }) {
  const action = matchRule(info, location.href, '');
  const [open, setOpen] = useState(action === 'auto_popup');
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState({ stage: 'open', rated: false });
  const [error, setError] = useState(null);
  const since = useRef('');

  useEffect(() => {
    if (!open || !chat) return undefined;
    const tick = () => fetch(`/api/public/livechat/poll?${new URLSearchParams({ ...chat, since: since.current })}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        if (d.messages.length) { since.current = d.messages.at(-1).date; setMessages((m) => [...m, ...d.messages]); }
        setStatus({ stage: d.stage, rated: d.rated });
      })
      .catch(() => { /* offline: try again on the next tick */ });
    tick();
    const timer = setInterval(tick, CHAT_POLL_MS);
    return () => clearInterval(timer);
  }, [open, chat]);

  if (action === 'hide_button') return null;
  if (!open) return <div style={CHAT_STYLE}><button type="button" className="btn primary" onClick={() => setOpen(true)}>{info.button_text || t('Chat with us')}</button></div>;

  const send = async (path, body) => {
    const r = await post(path, { ...chat, ...body });
    setError(r.ok ? null : r.data.error ?? t('Could not send the message'));
    return r;
  };
  return (
    <section style={CHAT_STYLE} aria-label={t('Live Chat')}>
      <div style={PANEL_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>{info.name}</b>
          <button type="button" className="btn sm" aria-label={t('Close')} onClick={() => setOpen(false)}>×</button>
        </div>
        {!chat ? (
          <form className="checkout" onSubmit={async (e) => {
            e.preventDefault();
            const f = Object.fromEntries(new FormData(e.currentTarget));
            const r = await post('/api/public/livechat/start', { ...f, url: location.href });
            if (r.ok) setChat({ sessionId: r.data.sessionId, token: r.data.token }); else setError(r.data.error);
          }}>
            <label>{t('Name')}<input name="name" required maxLength={120} /></label>
            <label>{t('Email')}<input name="email" type="email" required /></label>
            {error && <div className="alert" role="alert">{error}</div>}
            <button type="submit" className="btn primary">{t('Start chatting')}</button>
          </form>
        ) : (
          <>
            <div role="log" aria-live="polite" style={{ maxBlockSize: 260, overflowY: 'auto', margin: '8px 0' }}>
              {messages.map((m, i) => (
                <p key={i} style={{ textAlign: m.author === 'visitor' ? 'end' : 'start', margin: '4px 0' }}>
                  <small className="muted">{m.author === 'visitor' ? t('You') : m.author === 'bot' ? t('Bot') : t('Operator')}</small><br />{m.body}
                </p>
              ))}
            </div>
            {error && <div className="alert" role="alert">{error}</div>}
            {status.stage !== 'closed' ? (
              <form style={{ display: 'flex', gap: 4 }} onSubmit={async (e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.body;
                if ((await send('/api/public/livechat/message', { body: input.value })).ok) input.value = '';
              }}>
                <input name="body" required maxLength={2000} aria-label={t('Message')} style={{ flex: 1 }} />
                <button type="submit" className="btn primary">{t('Send')}</button>
              </form>
            ) : status.rated ? <p role="status">{t('Thank you for your feedback!')}</p> : (
              <form className="checkout" onSubmit={async (e) => {
                e.preventDefault();
                const f = Object.fromEntries(new FormData(e.currentTarget));
                if ((await send('/api/public/livechat/rate', { rating: Number(f.rating), comment: f.comment })).ok) setStatus({ ...status, rated: true });
              }}>
                <fieldset>
                  <legend>{t('How was this conversation?')}</legend>
                  {[1, 2, 3, 4, 5].map((n) => <label key={n}><input type="radio" name="rating" value={n} required aria-label={`${n} ★`} />{'★'.repeat(n)}</label>)}
                </fieldset>
                <label>{t('Comment')}<textarea name="comment" maxLength={1000} /></label>
                <button type="submit" className="btn primary">{t('Rate')}</button>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Content({ text = '' }) {
  return text.split(/\n{2,}/).map((block, i) => {
    if (block.startsWith('## ')) return <h3 key={i}>{block.slice(3)}</h3>;
    if (block.startsWith('# ')) return <h2 key={i}>{block.slice(2)}</h2>;
    return <p key={i}>{block}</p>;
  });
}

const SITE_PAGES = ['page', 'events', 'appointments', 'jobs', 'blog', 'forum'];

/** Current location.hash, updated on navigation. */
function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const update = () => { setHash(location.hash); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return hash;
}

/** Header: pages, Shop, Events…, Blog, Help, then search, pricelist, cart count, Sign in and Contact Us. */
function SiteHeader({ site, route, cartCount, pricelist, setPricelist }) {
  const link = (href, label, current) => <a key={href} href={href} aria-current={current ? 'page' : undefined}>{label}</a>;
  const contact = site.pages.find((p) => p.slug === 'contact');
  return (
    <header className="site-nav shop-header">
      <a className="site-brand" href={site.pages[0] ? `#/shop/page/${encodeURIComponent(site.pages[0].slug)}` : '#/shop'}><b>{site.company}</b></a>
      <nav aria-label={t('Website')}>
        {site.menus?.length ? <SiteMenu items={site.menus} /> : site.pages.filter((p) => p.slug !== 'contact').map((p) => link(`/${p.slug.replace(/^\/+|\/+$/g, '')}`, pageFor(null, p, lang).name, route.page === 'page' && route.arg === p.slug))}
        {link('#/shop', t('Shop'), !SITE_PAGES.includes(route.page))}
        {site.events?.length > 0 && link('#/shop/events', t('Events'), route.page === 'events')}
        {site.appointments?.length > 0 && link('#/shop/appointments', t('Appointments'), route.page === 'appointments')}
        {site.jobs?.length > 0 && link('#/shop/jobs', t('Jobs'), route.page === 'jobs')}
        {site.posts?.length > 0 && link('#/shop/blog', t('Blog'), route.page === 'blog')}
        {site.forums?.length > 0 && link(`#/shop/forum?forum=${site.forums[0].id}`, t('Help'), route.page === 'forum')}
      </nav>
      <div className="shop-header-tools">
        <form role="search" onSubmit={(e) => { e.preventDefault(); location.hash = `#/shop?${new URLSearchParams({ search: new FormData(e.currentTarget).get('search') })}`; }}>
          <input name="search" type="search" placeholder={t('Search…')} aria-label={t('Search products')} />
        </form>
        {site.pricelists?.length > 0 && (
          <select aria-label={t('Pricelist')} value={pricelist ?? ''} onChange={(e) => setPricelist(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{site.currency}</option>
            {site.pricelists.map((p) => <option key={p.id} value={p.id}>{p.name} ({site.currency})</option>)}
          </select>
        )}
        <a className="shop-cart-link" href="#/shop/cart" aria-label={t('Cart ({count})', { count: cartCount })}>{t('Cart')} <span className="shop-badge">{cartCount}</span></a>
        <a className="btn sm" href="/#/">{t('Sign in')}</a>
        {contact && <a className="btn sm primary" href="#/shop/page/contact">{t('Contact Us')}</a>}
      </div>
    </header>
  );
}

export function PublicSite() {
  const [site, setSite] = useState(null);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(null);
  const [applied, setApplied] = useState(false);
  const cart = useCart();
  const [pricelist, setPricelist] = useStored('mizan-shop-pricelist', null);
  const route = parseShopRoute(useHash());
  const original = route.page === 'page' && site?.pages.find((p) => p.slug.replace(/^\/+|\/+$/g, '') === route.arg);
  const page = original && pageFor(null, original, lang);
  usePageMeta(page);

  useEffect(() => {
    const source = location.pathname !== '/' ? `${location.pathname}?website_data=1` : '/api/public/site';
    fetch(source).then((r) => r.json()).then((s) => {
      setCurrency(s.currency);
      setSite(s);
    }).catch(() => setError(t('The website is not available right now.')));
  }, []);

  if (error && !site) return <main className="site"><div className="site-body"><p className="alert">{error}</p></div></main>;
  if (!site) return <main className="site"><div className="site-body muted">…</div></main>;

  const validPricelist = site.pricelists?.some((p) => p.id === pricelist) ? pricelist : null;

  return (
    <main className="site">
      {page?.header_visible !== false && <SiteHeader site={site} route={route} cartCount={cart.count} pricelist={validPricelist} setPricelist={setPricelist} />}
      <div className="site-body">
        {route.page === 'events' && site.events.map((e) => (
          <article key={e.id} className="shop-item job">
            <h3>{e.name}</h3>
            <p className="muted">{e.date_begin}{e.location ? ` · ${e.location}` : ''}</p>
            <p>{e.description}</p>
            <VisitorForm action={t('Register')} path="/api/public/register" extra={{ event_id: e.id }}
              choices={e.tickets.length ? { name: 'ticket', label: t('Ticket'), options: e.tickets.map((tk) => [tk.name, `${tk.name}${tk.price ? ` (${tk.price})` : ''}`]) } : null} />
          </article>
        ))}
        {route.page === 'appointments' && <Appointments site={site} route={route} />}
        {route.page === 'jobs' && (applied ? <div className="site-thanks" role="status"><h2>{t('Thank you!')}</h2><p>{t('Your application was received.')}</p></div> : (
          <>
            <h2>{t('Jobs')}</h2>
            {site.jobs.map((j) => (
              <article key={j.id} className="shop-item job">
                <h3>{j.name}</h3>
                <p>{j.description}</p>
                {(applying ?? Number(route.params.get('job'))) === j.id ? (
                  <form className="checkout" onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const r = await post('/api/public/apply', { job_id: j.id, name: f.get('name'), email: f.get('email'), phone: f.get('phone'), motivation: f.get('motivation'), ref: route.params.get('ref') || undefined });
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
        {route.page === 'page' && (page ? <article className="site-page"><h1>{page.name}</h1><Content text={page.content} /></article> : <p className="alert">{t('Page not found')}</p>)}
        {route.page === 'blog' && <Blog site={site} route={route} />}
        {route.page === 'forum' && <Forum site={site} route={route} />}
        {!SITE_PAGES.includes(route.page) && <Shop site={site} route={route} cart={cart} pricelist={validPricelist} />}
      </div>
      {site.livechat && <LiveChat info={site.livechat} />}
      {page?.footer_visible !== false && <footer className="site-footer">© {new Date().getFullYear()} {site.company}</footer>}
    </main>
  );
}
