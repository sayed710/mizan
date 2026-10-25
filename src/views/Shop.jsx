// Public eCommerce (#/shop…): product grid, product page, cart, checkout steps, confirmation and order status.
// Catalog filtering runs on the published data with the shared logic of models/shop.js; prices are always computed by the server.
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { SORTS, productVariants, shopProducts } from '../models/shop.js';

const PER_PAGE = 12;
const CART_KEY = 'mizan-shop-cart';
const LAST_ORDER_KEY = 'mizan-shop-last-order';
const SORT_LABELS = { featured: 'Featured', newest: 'Newest', name: 'Name', price_asc: 'Price: low to high', price_desc: 'Price: high to low' };
const RIBBON_LABELS = { sale: 'Sale', new: 'New', sold_out: 'Sold out' };

/** "#/shop/product/3?x=1" → { page: 'product', arg: '3', params }. Everything outside #/shop/… is the grid. */
export function parseShopRoute(hash) {
  const [path, query = ''] = String(hash ?? '').replace(/^#\/shop\/?/, '').split('?');
  const [page = '', arg = ''] = path.split('/').map((p) => decodeURIComponent(p));
  return { page: page || 'grid', arg, params: new URLSearchParams(query) };
}

const go = (hash) => { location.hash = hash; };
const gridHash = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null && !(params.page === 1 && v === 1)));
  return `#/shop${q.toString() ? `?${q}` : ''}`;
};

/** A JSON value kept in localStorage (try/catch: blocked storage keeps it in memory only). */
export function useStored(key, initial) {
  const [value, setValue] = useState(() => {
    try { return JSON.parse(localStorage.getItem(key)) ?? initial; } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: kept for this page only */ }
  }, [key, value]);
  return [value, setValue];
}

/** Cart lines [{ product_id, qty }] with add/set helpers; quantities stay between 1 and 1000. */
export function useCart() {
  const [lines, setLines] = useStored(CART_KEY, []);
  const safe = Array.isArray(lines) ? lines : [];
  const clamp = (q) => Math.min(1000, Math.max(1, Math.floor(q) || 1));
  return {
    lines: safe,
    count: safe.reduce((s, l) => s + (Number(l.qty) || 0), 0),
    add: (id, qty = 1) => setLines(safe.some((l) => l.product_id === id)
      ? safe.map((l) => (l.product_id === id ? { ...l, qty: clamp(l.qty + qty) } : l))
      : [...safe, { product_id: id, qty: clamp(qty) }]),
    set: (id, qty) => setLines(qty < 1 ? safe.filter((l) => l.product_id !== id) : safe.map((l) => (l.product_id === id ? { ...l, qty: clamp(qty) } : l))),
    clear: () => setLines([]),
  };
}

const post = (path, body) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

/** Server-priced cart (POST /api/public/cart), refreshed when the cart or options change. */
function useCartTotals(lines, options) {
  const [state, setState] = useState({ totals: null, error: null });
  const key = JSON.stringify([lines, options]);
  useEffect(() => {
    if (!lines.length) { setState({ totals: null, error: null }); return undefined; }
    let live = true;
    post('/api/public/cart', { lines, ...options })
      .then((r) => live && setState(r.ok ? { totals: r.data, error: null } : { totals: null, error: r.data.error ?? t('Could not compute the cart') }))
      .catch(() => live && setState({ totals: null, error: t('Could not compute the cart') }));
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Thumb({ product, large = false }) {
  return product?.image
    ? <img className={large ? 'shop-photo' : 'shop-thumb-img'} src={product.image} alt={product.name} />
    : <div className={large ? 'shop-photo shop-thumb' : 'shop-thumb'} aria-hidden="true">{product?.name?.[0] ?? '?'}</div>;
}

function Paragraphs({ text = '' }) {
  return text.split(/\n{2,}/).filter(Boolean).map((block, i) => (block.startsWith('## ') ? <h3 key={i}>{block.slice(3)}</h3> : <p key={i}>{block}</p>));
}

function Grid({ catalog, site, route, cart, wishlist, compare }) {
  const p = route.params;
  const query = { category: p.get('category') ?? '', search: p.get('search') ?? '', sort: SORTS.includes(p.get('sort')) ? p.get('sort') : 'featured', page: Number(p.get('page')) || 1 };
  const result = shopProducts(catalog, { ...query, category: query.category ? Number(query.category) : null, perPage: PER_PAGE });
  const hasVariants = (id) => site.products.some((v) => v.variant_of === id);
  const depth = (c) => c.display_name.split(' / ').length - 1;
  return (
    <div className="shop-layout">
      <aside className="shop-sidebar" aria-label={t('Categories')}>
        <h3>{t('Categories')}</h3>
        <ul>
          <li><a href={gridHash({ ...query, category: '', page: 1 })} aria-current={!query.category ? 'page' : undefined}>{t('All products')}</a></li>
          {site.categories.map((c) => (
            <li key={c.id} style={{ paddingInlineStart: depth(c) * 12 }}>
              <a href={gridHash({ ...query, category: c.id, page: 1 })} aria-current={String(c.id) === query.category ? 'page' : undefined}>{c.name}</a>
            </li>
          ))}
        </ul>
      </aside>
      <section className="shop-main">
        <div className="shop-toolbar">
          <form role="search" onSubmit={(e) => { e.preventDefault(); go(gridHash({ ...query, search: new FormData(e.currentTarget).get('search'), page: 1 })); }}>
            <input name="search" type="search" defaultValue={query.search} placeholder={t('Search…')} aria-label={t('Search products')} />
            <button type="submit" className="btn">{t('Search')}</button>
          </form>
          <label>{t('Sort by')}
            <select value={query.sort} onChange={(e) => go(gridHash({ ...query, sort: e.target.value, page: 1 }))}>
              {SORTS.map((s) => <option key={s} value={s}>{t(SORT_LABELS[s])}</option>)}
            </select>
          </label>
          {wishlist.length > 0 && <a className="btn sm" href="#/shop/wishlist">{t('Wishlist')} ({wishlist.length})</a>}
          {compare.length > 0 && <a className="btn sm" href="#/shop/compare">{t('Compare')} ({compare.length})</a>}
        </div>
        {!result.items.length && <p className="muted">{t('No product matches your search.')}</p>}
        <div className="shop-products">
          {result.items.map((prod) => (
            <article key={prod.id} className="shop-card">
              <a href={`#/shop/product/${prod.id}`} className="shop-card-link">
                {prod.ribbon && <span className={`shop-ribbon ${prod.ribbon}`}>{t(RIBBON_LABELS[prod.ribbon])}</span>}
                <Thumb product={prod} />
                <h3>{prod.name}</h3>
              </a>
              <p className="price">{money(prod.list_price)}</p>
              {hasVariants(prod.id)
                ? <a className="btn" href={`#/shop/product/${prod.id}`}>{t('Choose options')}</a>
                : <button type="button" className="btn primary" onClick={() => cart.add(prod.id)}>{t('Add to cart')}</button>}
            </article>
          ))}
        </div>
        {result.pages > 1 && (
          <nav className="shop-pager" aria-label={t('Pages')}>
            {Array.from({ length: result.pages }, (_, i) => i + 1).map((n) => (
              <a key={n} className="btn sm" href={gridHash({ ...query, page: n })} aria-current={n === result.page ? 'page' : undefined}>{n}</a>
            ))}
          </nav>
        )}
      </section>
    </div>
  );
}

function ProductPage({ catalog, site, id, cart, wishlist, setWishlist, compare, setCompare }) {
  const template = site.products.find((p) => p.id === id && !p.variant_of);
  const { attributes, variants } = useMemo(() => (template ? productVariants(catalog, template) : { attributes: [], variants: [] }), [catalog, template]);
  const [picked, setPicked] = useState(() => variants[0]?.values ?? attributes.map(([, values]) => values[0]));
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  if (!template) return <p className="alert">{t('This product is not available.')}</p>;
  const variant = variants.length ? variants.find((v) => v.values.join('|') === picked.join('|')) : null;
  const selected = variant ? site.products.find((p) => p.id === variant.id) : template;
  const buyable = !variants.length || !!variant;
  const category = site.categories.find((c) => c.id === template.public_categ_ids[0]?.category_id);
  const gallery = [template, ...variants.map((v) => site.products.find((p) => p.id === v.id))].filter((p) => p?.image);
  const toggle = (list, setList) => setList(list.includes(template.id) ? list.filter((x) => x !== template.id) : [...list, template.id]);
  return (
    <article className="shop-product">
      <nav className="shop-crumbs" aria-label={t('Breadcrumb')}>
        <a href="#/shop">{t('All products')}</a>
        {category && <> / <a href={gridHash({ category: category.id })}>{category.name}</a></>}
        {' / '}<span aria-current="page">{template.name}</span>
      </nav>
      <div className="shop-detail">
        <div className="shop-gallery">
          <Thumb product={selected?.image ? selected : template} large />
          {gallery.length > 1 && <div className="shop-gallery-thumbs">{gallery.map((p) => <Thumb key={p.id} product={p} />)}</div>}
        </div>
        <div className="shop-buy">
          <h1>{template.name}</h1>
          <p className="price">{buyable ? money(selected.list_price) : '—'}</p>
          {attributes.map(([name, values], i) => (
            <fieldset key={name} className="shop-attribute">
              <legend>{name}</legend>
              {values.map((v) => (
                <label key={v}>
                  <input type="radio" name={`attr-${i}`} value={v} checked={picked[i] === v} onChange={() => { setPicked(picked.map((x, j) => (j === i ? v : x))); setAdded(false); }} />
                  {v}
                </label>
              ))}
            </fieldset>
          ))}
          {!buyable && <p className="alert" role="alert">{t('This combination is not available.')}</p>}
          <div className="shop-qty">
            <button type="button" className="btn" aria-label={t('Decrease quantity')} onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
            <input type="number" min={1} max={1000} value={qty} aria-label={t('Quantity')} onChange={(e) => setQty(Math.min(1000, Math.max(1, Math.floor(Number(e.target.value)) || 1)))} />
            <button type="button" className="btn" aria-label={t('Increase quantity')} onClick={() => setQty(Math.min(1000, qty + 1))}>+</button>
          </div>
          <div className="shop-actions">
            <button type="button" className="btn primary" disabled={!buyable} onClick={() => { cart.add(selected.id, qty); setAdded(true); }}>{t('Add to cart')}</button>
            <button type="button" className="btn" aria-pressed={wishlist.includes(template.id)} onClick={() => toggle(wishlist, setWishlist)}>♡ {t('Add to wishlist')}</button>
            <button type="button" className="btn" aria-pressed={compare.includes(template.id)} onClick={() => toggle(compare, setCompare)}>⇄ {t('Add to compare')}</button>
          </div>
          {added && <p role="status">{t('Added to your cart.')} <a href="#/shop/cart">{t('View cart')}</a></p>}
        </div>
      </div>
      {template.website_description && <section className="shop-description"><h2>{t('Description')}</h2><Paragraphs text={template.website_description} /></section>}
      {attributes.length > 0 && (
        <section className="shop-specs">
          <h2>{t('Specifications')}</h2>
          <table><tbody>{attributes.map(([name, values]) => <tr key={name}><th scope="row">{name}</th><td>{values.join(', ')}</td></tr>)}</tbody></table>
        </section>
      )}
    </article>
  );
}

function Summary({ totals }) {
  if (!totals) return null;
  return (
    <dl className="shop-summary">
      <dt>{t('Subtotal')}</dt><dd>{money(totals.untaxed)}</dd>
      {totals.delivery > 0 && <><dt>{t('Delivery')}</dt><dd>{money(totals.delivery)}</dd></>}
      <dt>{t('Taxes')}</dt><dd>{money(totals.tax)}</dd>
      <dt className="total">{t('Total')}</dt><dd className="total">{money(totals.total)}</dd>
    </dl>
  );
}

function CartPage({ site, cart, pricelist }) {
  const { totals, error } = useCartTotals(cart.lines, { pricelist });
  const name = (id) => site.products.find((p) => p.id === id)?.name ?? t('Unavailable product');
  if (!cart.lines.length) return <div className="shop-empty"><h2>{t('Your cart is empty')}</h2><a className="btn primary" href="#/shop">{t('Continue shopping')}</a></div>;
  return (
    <section className="shop-cart-page">
      <h1>{t('Your Cart')}</h1>
      <table className="shop-lines">
        <thead><tr><th>{t('Product')}</th><th>{t('Price')}</th><th>{t('Quantity')}</th><th>{t('Subtotal')}</th><th><span className="sr-only">{t('Remove')}</span></th></tr></thead>
        <tbody>
          {cart.lines.map((l) => {
            const priced = totals?.lines.find((x) => x.product_id === l.product_id);
            return (
              <tr key={l.product_id}>
                <td><a href={`#/shop/product/${site.products.find((p) => p.id === l.product_id)?.variant_of ?? l.product_id}`}>{name(l.product_id)}</a></td>
                <td>{priced ? money(priced.price_unit) : '…'}</td>
                <td>
                  <div className="shop-qty">
                    <button type="button" className="btn sm" aria-label={t('Decrease quantity')} onClick={() => cart.set(l.product_id, l.qty - 1)}>−</button>
                    <span>{l.qty}</span>
                    <button type="button" className="btn sm" aria-label={t('Increase quantity')} onClick={() => cart.set(l.product_id, l.qty + 1)}>+</button>
                  </div>
                </td>
                <td>{priced ? money(priced.subtotal) : '…'}</td>
                <td><button type="button" className="btn sm" onClick={() => cart.set(l.product_id, 0)}>{t('Remove')}</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="alert" role="alert">{error}</p>}
      <Summary totals={totals} />
      <div className="shop-actions">
        <a className="btn" href="#/shop">{t('Continue shopping')}</a>
        <a className="btn primary" href="#/shop/checkout" aria-disabled={!totals}>{t('Checkout')}</a>
      </div>
    </section>
  );
}

const STEPS = ['Address', 'Delivery Method', 'Payment', 'Confirmation'];
const ADDRESS_FIELDS = [['name', 'Name', 'text', true, 120], ['email', 'Email', 'email', true, 254], ['phone', 'Phone', 'tel', false, 40], ['street', 'Street', 'text', true, 120], ['city', 'City', 'text', true, 80], ['zip', 'Zip', 'text', false, 20], ['country', 'Country', 'text', true, 80]];

function Progress({ step }) {
  return (
    <ol className="shop-progress">
      {STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step ? 'current' : ''} aria-current={i === step ? 'step' : undefined}>{t(s)}</li>)}
    </ol>
  );
}

function Checkout({ site, cart, pricelist }) {
  const [step, setStep] = useState(0);
  const [address, setAddress] = useState(Object.fromEntries(ADDRESS_FIELDS.map(([k]) => [k, ''])));
  const [carrierId, setCarrierId] = useState(site.carriers[0]?.id ?? null);
  const [provider, setProvider] = useState(site.providers[0]?.code ?? '');
  const [state, setState] = useState({ busy: false, error: null });
  const { totals, error } = useCartTotals(cart.lines, { pricelist, carrier_id: step > 0 ? carrierId : null, country: address.country });
  if (!cart.lines.length) return <div className="shop-empty"><h2>{t('Your cart is empty')}</h2><a className="btn primary" href="#/shop">{t('Continue shopping')}</a></div>;

  const placeOrder = async () => {
    setState({ busy: true, error: null });
    const r = await post('/api/public/order', { ...address, lines: cart.lines, carrier_id: carrierId, provider_code: provider, pricelist }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok) { setState({ busy: false, error: r.data.error ?? t('Could not place the order') }); return; }
    try { localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ order: r.data.order, token: r.data.access_token })); } catch { /* the status link below still works */ }
    cart.clear();
    go(`#/shop/confirmation?order=${encodeURIComponent(r.data.order)}&token=${encodeURIComponent(r.data.access_token)}`);
  };
  const chosen = site.providers.find((p) => p.code === provider);
  return (
    <section className="shop-checkout">
      <Progress step={step} />
      <div className="shop-checkout-body">
        <div>
          {step === 0 && (
            <form className="checkout" onSubmit={(e) => { e.preventDefault(); setStep(site.carriers.length ? 1 : 2); }}>
              <h2>{t('Address')}</h2>
              {ADDRESS_FIELDS.map(([k, label, type, required, max]) => (
                <label key={k}>{t(label)}<input name={k} type={type} required={required} maxLength={max} value={address[k]} autoComplete={k === 'zip' ? 'postal-code' : k === 'street' ? 'street-address' : k === 'country' ? 'country-name' : k}
                  onChange={(e) => setAddress({ ...address, [k]: e.target.value })} /></label>
              ))}
              <button type="submit" className="btn primary">{t('Next')}</button>
            </form>
          )}
          {step === 1 && (
            <form className="checkout" onSubmit={(e) => { e.preventDefault(); setStep(2); }}>
              <fieldset className="shop-choices">
                <legend>{t('Delivery Method')}</legend>
                {(totals?.carriers ?? site.carriers).map((c) => (
                  <label key={c.id}><input type="radio" name="carrier" required checked={carrierId === c.id} disabled={c.price === null} onChange={() => setCarrierId(c.id)} />
                    <span>{c.name}</span><b>{c.price == null ? (c.price === null ? t('Not available') : '…') : c.price ? money(c.price) : t('Free')}</b></label>
                ))}
              </fieldset>
              <div className="shop-actions"><button type="button" className="btn" onClick={() => setStep(0)}>{t('Back')}</button><button type="submit" className="btn primary">{t('Next')}</button></div>
            </form>
          )}
          {step === 2 && (
            <form className="checkout" onSubmit={(e) => { e.preventDefault(); placeOrder(); }}>
              <fieldset className="shop-choices">
                <legend>{t('Payment')}</legend>
                {site.providers.map((p) => (
                  <label key={p.code}><input type="radio" name="provider" required checked={provider === p.code} onChange={() => setProvider(p.code)} /><span>{t(p.name)}</span></label>
                ))}
              </fieldset>
              {chosen?.pending_msg && <p className="shop-instructions">{chosen.pending_msg}</p>}
              {state.error && <div className="alert" role="alert">{state.error}</div>}
              <div className="shop-actions">
                <button type="button" className="btn" onClick={() => setStep(site.carriers.length ? 1 : 0)}>{t('Back')}</button>
                <button type="submit" className="btn primary" disabled={state.busy || !totals}>{chosen?.code === 'demo' ? t('Pay Now') : t('Confirm Order')}</button>
              </div>
            </form>
          )}
        </div>
        <aside className="shop-order-box">
          <h3>{t('Order overview')}</h3>
          {cart.lines.map((l) => <div key={l.product_id}>{l.qty} × {site.products.find((p) => p.id === l.product_id)?.name ?? t('Unavailable product')}</div>)}
          {error && <p className="alert" role="alert">{error}</p>}
          <Summary totals={totals} />
        </aside>
      </div>
    </section>
  );
}

/** Confirmation and order status pages: fetched with the visitor's token. */
function OrderStatus({ name, token, confirmation }) {
  const [state, setState] = useState({ order: null, error: null });
  useEffect(() => {
    if (!name || !token) { setState({ order: null, error: t('Order not found') }); return; }
    fetch(`/api/public/order-status?${new URLSearchParams({ order: name, token })}`)
      .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then((r) => setState(r.ok ? { order: r.data, error: null } : { order: null, error: r.data.error ?? t('Order not found') }))
      .catch(() => setState({ order: null, error: t('The website is not available right now.') }));
  }, [name, token]);
  if (state.error) return <p className="alert" role="alert">{state.error}</p>;
  const o = state.order;
  if (!o) return <p className="muted">…</p>;
  const paid = o.payment_state === 'paid';
  return (
    <section className="shop-confirmation">
      {confirmation && <Progress step={3} />}
      <h1>{confirmation ? t('Thank you for your order!') : t('Order {name}', { name: o.order })}</h1>
      <p role="status">{t('Order {name}', { name: o.order })} · {o.state === 'sale' ? t('Confirmed') : t('Awaiting payment')}{paid ? ` · ${t('Paid')}` : ''}</p>
      {o.provider && <p className="shop-instructions">{paid ? o.provider.done_msg : o.provider.pending_msg}</p>}
      <table className="shop-lines">
        <thead><tr><th>{t('Product')}</th><th>{t('Quantity')}</th><th>{t('Price')}</th><th>{t('Subtotal')}</th></tr></thead>
        <tbody>{o.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td>{l.qty}</td><td>{money(l.price_unit)}</td><td>{money(l.subtotal)}</td></tr>)}</tbody>
      </table>
      <Summary totals={{ untaxed: o.untaxed, tax: o.tax, total: o.total, delivery: 0 }} />
      {confirmation && <p><a href={`#/shop/order/${encodeURIComponent(o.order)}?token=${encodeURIComponent(token)}`}>{t('Bookmark your order status page')}</a></p>}
    </section>
  );
}

function SavedList({ site, ids, setIds, title, compareTable, cart }) {
  const items = ids.map((id) => site.products.find((p) => p.id === id)).filter(Boolean);
  if (!items.length) return <div className="shop-empty"><h2>{title}</h2><p className="muted">{t('Nothing here yet.')}</p><a className="btn" href="#/shop">{t('Continue shopping')}</a></div>;
  const names = [...new Set(items.flatMap((p) => productVariants({ records: { product: site.products } }, p).attributes.map(([n]) => n)))];
  const valuesOf = (p, n) => productVariants({ records: { product: site.products } }, p).attributes.find(([x]) => x === n)?.[1].join(', ') ?? '—';
  return (
    <section>
      <h1>{title}</h1>
      <div className="shop-table-scroll">
        <table className="shop-lines">
          <thead><tr><th>{t('Product')}</th><th>{t('Price')}</th>{compareTable && names.map((n) => <th key={n}>{n}</th>)}<th><span className="sr-only">{t('Actions')}</span></th></tr></thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td><a href={`#/shop/product/${p.id}`}>{p.name}</a></td>
                <td>{money(p.list_price)}</td>
                {compareTable && names.map((n) => <td key={n}>{valuesOf(p, n)}</td>)}
                <td className="shop-actions">
                  {!site.products.some((v) => v.variant_of === p.id) && <button type="button" className="btn sm primary" onClick={() => cart.add(p.id)}>{t('Add to cart')}</button>}
                  <button type="button" className="btn sm" onClick={() => setIds(ids.filter((x) => x !== p.id))}>{t('Remove')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The shop pages of the public site; `route` comes from parseShopRoute(location.hash). */
export function Shop({ site, route, cart, pricelist }) {
  const catalog = useMemo(() => ({ records: { product: site.products, 'product.public.category': site.categories }, seq: {}, messages: [], settings: {} }), [site]);
  const [wishlist, setWishlist] = useStored('mizan-shop-wishlist', []);
  const [compare, setCompare] = useStored('mizan-shop-compare', []);
  const lists = { wishlist: Array.isArray(wishlist) ? wishlist : [], compare: Array.isArray(compare) ? compare : [] };
  const lastOrder = () => { try { return JSON.parse(localStorage.getItem(LAST_ORDER_KEY)) ?? {}; } catch { return {}; } };
  let page;
  switch (route.page) {
    case 'product': page = <ProductPage key={route.arg} catalog={catalog} site={site} id={Number(route.arg)} cart={cart} wishlist={lists.wishlist} setWishlist={setWishlist} compare={lists.compare} setCompare={setCompare} />; break;
    case 'cart': page = <CartPage site={site} cart={cart} pricelist={pricelist} />; break;
    case 'checkout': page = <Checkout site={site} cart={cart} pricelist={pricelist} />; break;
    case 'confirmation': page = <OrderStatus name={route.params.get('order') ?? lastOrder().order} token={route.params.get('token') ?? lastOrder().token} confirmation />; break;
    case 'order': page = <OrderStatus name={route.arg} token={route.params.get('token')} />; break;
    case 'wishlist': page = <SavedList site={site} ids={lists.wishlist} setIds={setWishlist} title={t('Wishlist')} cart={cart} />; break;
    case 'compare': page = <SavedList site={site} ids={lists.compare} setIds={setCompare} title={t('Compare')} compareTable cart={cart} />; break;
    default: page = <Grid catalog={catalog} site={site} route={route} cart={cart} wishlist={lists.wishlist} compare={lists.compare} />;
  }
  return <div className="shop">{page}</div>;
}
