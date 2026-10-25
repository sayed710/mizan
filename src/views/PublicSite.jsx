// Public website (no login): published pages + shop, served from /api/public/* on the Mizan server.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { money, setCurrency } from '../ui.jsx';
import { matchRule } from '../models/livechat.js';

/** Name/email/phone form posting to a public endpoint, with an optional choice and date/time; shows the server's answer. */
function VisitorForm({ action, path, extra, choices, dateTime }) {
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
      {dateTime && <><label>{t('Date')}<input name="date" type="date" required /></label><label>{t('Time')}<input name="time" type="time" required /></label></>}
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
          {site.events?.length > 0 && <button type="button" aria-current={slug === 'events' ? 'page' : undefined} onClick={() => { setSlug('events'); setStep('browse'); }}>{t('Events')}</button>}
          {site.appointments?.length > 0 && <button type="button" aria-current={slug === 'appointments' ? 'page' : undefined} onClick={() => { setSlug('appointments'); setStep('browse'); }}>{t('Appointments')}</button>}
          {site.jobs?.length > 0 && <button type="button" aria-current={slug === 'jobs' ? 'page' : undefined} onClick={() => { setSlug('jobs'); setStep('browse'); setApplied(false); }}>{t('Jobs')}</button>}
        </nav>
        <a className="btn sm" href="#/">{t('Log in')}</a>
      </header>
      <div className="site-body">
        {step === 'done' && <div className="site-thanks" role="status"><h2>{t('Thank you!')}</h2><p>{t('Your order {name} has been received.', { name: result })}</p></div>}
        {slug === 'events' && site.events.map((e) => (
          <article key={e.id} className="shop-item job">
            <h3>{e.name}</h3>
            <p className="muted">{e.date_begin}{e.location ? ` · ${e.location}` : ''}</p>
            <p>{e.description}</p>
            <VisitorForm action={t('Register')} path="/api/public/register" extra={{ event_id: e.id }}
              choices={e.tickets.length ? { name: 'ticket', label: t('Ticket'), options: e.tickets.map((tk) => [tk.name, `${tk.name}${tk.price ? ` (${tk.price})` : ''}`]) } : null} />
          </article>
        ))}
        {slug === 'appointments' && site.appointments.map((a) => (
          <article key={a.id} className="shop-item job">
            <h3>{a.name}</h3>
            <p className="muted">{a.duration} h{a.location ? ` · ${a.location}` : ''}</p>
            <p>{a.description}</p>
            <VisitorForm action={t('Book')} path="/api/public/book" extra={{ type_id: a.id }} dateTime />
          </article>
        ))}
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
      {site.livechat && <LiveChat info={site.livechat} />}
      <footer className="site-footer">© {new Date().getFullYear()} {site.company}</footer>
    </main>
  );
}
