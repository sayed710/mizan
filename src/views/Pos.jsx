import { useRef, useState } from 'react';
import { read, search } from '../orm.js';
import { amounts } from '../models/common.js';
import { closeSession, openSession, payOrder, priceLines, sessionTotals, startSession } from '../models/pos.js';
import { commit, getDb, isServer, serverAction, useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { relationCandidates, viewRecords } from '../companyView.js';
import { cashRound, round } from '../money.js';

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

/** Touch-friendly register: product grid → cart → dynamic payment methods, presets, category hierarchy. */
export function Pos() {
  const db = useDb();
  const [cart, setCart] = useState([]);
  const [query, setQuery] = useState('');
  const [selectedCatId, setSelectedCatId] = useState(null);
  const [partner, setPartner] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const requestKey = useRef(null);

  const session = openSession(db);
  const configId = session?.config_id ?? (search(db, 'pos.config')[0]?.id ?? null);
  const config = configId ? read(db, 'pos.config', configId) : null;

  // Available Presets
  const availablePresets = config?.available_preset_ids?.length
    ? config.available_preset_ids.map((id) => read(db, 'pos.preset', id)).filter(Boolean)
    : (search(db, 'pos.preset') ?? []);
  const [presetId, setPresetId] = useState(config?.default_preset_id ?? (availablePresets[0]?.id ?? null));
  const preset = presetId ? read(db, 'pos.preset', presetId) : null;

  // Payment methods for this config
  const allPaymentMethods = search(db, 'pos.payment.method') ?? [];
  const configMethods = allPaymentMethods.filter((m) => m.active !== false && (m.company_id ?? 1) === (config?.company_id ?? 1) && (!m.config_ids?.length || m.config_ids.includes(configId)));
  const paymentMethods = configMethods.length ? configMethods : [{ id: 'cash', name: 'Cash', type: 'cash' }, { id: 'card', name: 'Card', type: 'bank' }];

  // Categories hierarchy filtered by config
  const allCategories = (search(db, 'pos.category') ?? []).filter((c) => c.active !== false && (!c.pos_config_ids?.length || c.pos_config_ids.includes(configId)));
  const rootCategories = allCategories.filter((c) => !c.parent_id);
  const subCategories = selectedCatId ? allCategories.filter((c) => c.parent_id === selectedCatId) : [];

  // Breadcrumbs
  const breadcrumbs = [];
  let curr = selectedCatId ? read(db, 'pos.category', selectedCatId) : null;
  while (curr) {
    breadcrumbs.unshift(curr);
    curr = curr.parent_id ? read(db, 'pos.category', curr.parent_id) : null;
  }

  // Descendant categories for product filtering
  const getDescendantCatIds = (catId) => {
    const ids = new Set([catId]);
    const addChildren = (pid) => {
      for (const c of allCategories) {
        if (c.parent_id === pid && !ids.has(c.id)) {
          ids.add(c.id);
          addChildren(c.id);
        }
      }
    };
    addChildren(catId);
    return ids;
  };

  const activeCatIds = selectedCatId ? getDescendantCatIds(selectedCatId) : null;
  const currentCat = selectedCatId ? read(db, 'pos.category', selectedCatId) : null;

  const products = viewRecords(db, 'product').filter((p) => p.available_in_pos !== false && p.sale_ok !== false);
  const shown = products.filter((p) => {
    if (query && !p.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (!selectedCatId) return true;
    return (p.pos_categ_ids ?? []).some((id) => activeCatIds.has(id)) || p.categ === currentCat?.name;
  });

  const lines = priceLines(db, cart, Number(partner) || null, { pricelistId: preset?.pricelist_id ?? null, fiscalPositionId: preset?.fiscal_position_id ?? null });
  const total = amounts(lines);

  // Cash rounding
  const rounding = config?.cash_rounding && config?.rounding_method_id ? read(db, 'account.cash.rounding', config.rounding_method_id) : null;
  const isDefaultCash = paymentMethods[0]?.type === 'cash';
  const shouldRoundDefault = Boolean(rounding && (!config?.only_round_cash_method || isDefaultCash));
  const payableTotal = shouldRoundDefault ? cashRound(total.total, rounding.rounding, rounding.rounding_method) : total.total;
  const roundingDifference = round(payableTotal - total.total);

  const add = (id) => {
    if (inFlight.current) return;
    requestKey.current = null;
    setCart((c) => (c.some((l) => l.product_id === id)
      ? c.map((l) => (l.product_id === id ? { ...l, qty: l.qty + 1 } : l))
      : [...c, { product_id: id, qty: 1 }]));
  };
  const setQty = (id, qty) => {
    if (inFlight.current) return;
    requestKey.current = null;
    setCart((c) => (qty <= 0 ? c.filter((l) => l.product_id !== id) : c.map((l) => (l.product_id === id ? { ...l, qty } : l))));
  };

  const pay = async (methodRecord) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    requestKey.current ??= crypto.randomUUID();
    const partner_id = Number(partner) || null;
    const methodId = typeof methodRecord === 'object' && methodRecord?.id ? methodRecord.id : methodRecord;
    const methodType = typeof methodRecord === 'object' && methodRecord?.type ? methodRecord.type : (methodRecord === 'cash' ? 'cash' : 'bank');

    if (preset) {
      if (preset.identification === 'name' && !partner_id) {
        alert(t('A customer name is required'));
        inFlight.current = false;
        setPending(false);
        return;
      }
      if (preset.identification === 'address') {
        const p = partner_id ? read(db, 'res.partner', partner_id) : null;
        const hasAddress = Boolean(p && (p.street || p.city || p.contact_address || p.zip));
        if (!hasAddress) {
          alert(t('Customer address is required'));
          inFlight.current = false;
          setPending(false);
          return;
        }
      }
    }

    if (methodType === 'pay_later' && !partner_id) {
      alert(t('A customer is required for pay later'));
      inFlight.current = false;
      setPending(false);
      return;
    }

    const isCash = methodType === 'cash';
    const shouldRound = Boolean(rounding && (!config?.only_round_cash_method || isCash));
    const finalAmount = shouldRound ? cashRound(total.total, rounding.rounding, rounding.rounding_method) : total.total;

    let receipt;
    try {
      if (isServer()) {
        receipt = await serverAction('/api/pos/pay', {
          lines: cart,
          method: methodId,
          partner_id,
          config_id: config?.id ?? null,
          preset_id: presetId ?? null,
          request_key: requestKey.current,
        });
        if (receipt?.ok === false) throw new Error(receipt.error);
      } else {
        const { db: booked, id } = payOrder(getDb(), {
          lines,
          method: methodId,
          partner_id,
          config_id: config?.id ?? null,
          preset_id: presetId ?? null,
        });
        commit(booked);
        receipt = { id, name: read(booked, 'pos.order', id).name, total: read(booked, 'pos.order', id).amount_total };
      }
    } catch (e) {
      alert(e.message);
      return;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
    requestKey.current = null;
    setReceipt({
      ...receipt,
      total: receipt?.total ?? finalAmount,
      method: typeof methodRecord === 'object' && methodRecord !== null ? methodRecord.name : (methodRecord || 'Cash'),
    });
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
          <p className="muted">{t(receipt.method)}</p>
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
          <button type="button" className={`chip ${!selectedCatId ? 'on' : ''}`} onClick={() => setSelectedCatId(null)}>{t('All')}</button>
          {breadcrumbs.map((c) => (
            <button key={c.id} type="button" className="chip on" onClick={() => setSelectedCatId(c.id)}>
              {c.name}
            </button>
          ))}
          {(!selectedCatId ? rootCategories : subCategories).map((c) => (
            <button key={c.id} type="button" className="chip" onClick={() => setSelectedCatId(c.id)}>
              {c.name}
            </button>
          ))}
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
        {availablePresets.length > 0 && (
          <div className="pos-presets row wrap" style={{ gap: '4px' }}>
            {availablePresets.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={pending}
                className={`chip ${presetId === p.id ? 'on' : ''}`}
                onClick={() => { requestKey.current = null; setPresetId(p.id); }}
              >
                {t(p.name)}
              </button>
            ))}
          </div>
        )}
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
          {rounding && roundingDifference !== 0 && (
            <div><dt>{t('Rounding')}</dt><dd>{money(roundingDifference)}</dd></div>
          )}
          <div className="grand"><dt>{t('Total')}</dt><dd>{money(rounding ? payableTotal : total.total)}</dd></div>
        </dl>
        <div className="pos-pay" aria-busy={pending}>
          {paymentMethods.map((m) => (
            <button
              key={m.id}
              type="button"
              className="btn primary"
              disabled={pending || !lines.length}
              onClick={() => pay(m)}
            >
              {t(m.name)}
            </button>
          ))}
        </div>
      </aside>
    </main>
  );
}
