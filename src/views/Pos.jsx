import { useRef, useState } from 'react';
import { round } from '../money.js';
import { read, search } from '../orm.js';
import { amounts } from '../models/common.js';
import { closeSession, openSession, payOrder, posOrderTotal, priceLines, sessionTotals, startSession } from '../models/pos.js';
import { posCategories, posPaymentMethods, posProducts } from '../models/posplus.js';
import { commit, getDb, isServer, serverAction, useDb } from '../store.js';
import { t } from '../i18n.js';
import { money } from '../ui.jsx';
import { relationCandidates } from '../companyView.js';

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
  const availablePresets = (config?.available_preset_ids ?? []).map((id) => read(db, 'pos.preset', id)).filter(Boolean);
  const [presetSelection, setPresetSelection] = useState(null);
  const presetId = presetSelection?.configId === configId && availablePresets.some((p) => p.id === presetSelection.id)
    ? presetSelection.id : (config?.default_preset_id ?? availablePresets[0]?.id ?? null);
  const preset = presetId ? read(db, 'pos.preset', presetId) : null;

  // Payment methods for this config
  const paymentMethods = posPaymentMethods(db, configId);
  const [splitPayments, setSplitPayments] = useState([]);

  // Categories hierarchy filtered by config
  const allCategories = posCategories(db, configId);
  const rootCategories = allCategories.filter((c) => !c.parent_id);
  const subCategories = selectedCatId ? allCategories.filter((c) => c.parent_id === selectedCatId) : [];

  // Breadcrumbs
  const breadcrumbs = [];
  let curr = selectedCatId ? read(db, 'pos.category', selectedCatId) : null;
  while (curr) {
    breadcrumbs.unshift(curr);
    curr = curr.parent_id ? read(db, 'pos.category', curr.parent_id) : null;
  }

  const shown = posProducts(db, { configId, selectedCatId, query });

  const lines = priceLines(db, cart, Number(partner) || null, { pricelistId: preset?.pricelist_id ?? null, fiscalPositionId: preset?.fiscal_position_id ?? null });
  const total = amounts(lines);

  // Cash rounding
  const rounding = config?.cash_rounding && config?.rounding_method_id ? read(db, 'account.cash.rounding', config.rounding_method_id) : null;
  const { roundedTotal: payableTotal, roundingDifference } = posOrderTotal(db, lines, { configId, payments: splitPayments });
  const paidSoFar = round(splitPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const remaining = round(payableTotal - paidSoFar);
  const validPayments = splitPayments.length > 0 && splitPayments.every((p) => {
    const amount = Number(p.amount);
    return p.amount !== '' && Number.isFinite(amount) && (payableTotal === 0 ? amount === 0 : payableTotal < 0 ? amount < 0 : amount > 0);
  });

  const addPayment = (method) => {
    requestKey.current = null;
    const next = [...splitPayments, { payment_method_id: method.id, amount: 0 }];
    const nextTotal = posOrderTotal(db, lines, { configId, payments: next }).roundedTotal;
    next[next.length - 1].amount = round(nextTotal - paidSoFar);
    setSplitPayments(next);
  };

  const add = (id) => {
    if (inFlight.current) return;
    requestKey.current = null;
    const delta = preset?.is_return ? -1 : 1;
    setCart((c) => (c.some((l) => l.product_id === id)
      ? c.map((l) => (l.product_id === id ? { ...l, qty: l.qty + delta } : l))
      : [...c, { product_id: id, qty: delta }]));
  };
  const setQty = (id, qty) => {
    if (inFlight.current) return;
    requestKey.current = null;
    setCart((c) => (qty === 0 ? c.filter((l) => l.product_id !== id) : c.map((l) => (l.product_id === id ? { ...l, qty } : l))));
  };

  const pay = async (methodOrPayments) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    requestKey.current ??= crypto.randomUUID();
    const partner_id = Number(partner) || null;
    const isSplit = Array.isArray(methodOrPayments);
    const methodRecord = !isSplit ? methodOrPayments : null;
    const methodId = methodRecord ? (typeof methodRecord === 'object' && methodRecord?.id ? methodRecord.id : methodRecord) : null;
    const methodType = methodRecord ? (typeof methodRecord === 'object' && methodRecord?.type ? methodRecord.type : (methodRecord === 'cash' ? 'cash' : 'bank')) : null;

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

    if (isSplit) {
      for (const p of methodOrPayments) {
        const m = read(db, 'pos.payment.method', p.payment_method_id);
        if (m?.type === 'pay_later' && !partner_id) {
          alert(t('A customer is required for pay later'));
          inFlight.current = false;
          setPending(false);
          return;
        }
      }
    } else if (methodType === 'pay_later' && !partner_id) {
      alert(t('A customer is required for pay later'));
      inFlight.current = false;
      setPending(false);
      return;
    }

    const { roundedTotal: finalAmount } = posOrderTotal(db, lines, { configId, method: methodId, payments: isSplit ? methodOrPayments : null });

    let receipt;
    try {
      if (isServer()) {
        receipt = await serverAction('/api/pos/pay', {
          lines: cart,
          method: methodId,
          payments: isSplit ? methodOrPayments : undefined,
          partner_id,
          config_id: config?.id ?? null,
          preset_id: presetId ?? null,
          request_key: requestKey.current,
        });
        if (receipt?.ok === false) throw new Error(receipt.error);
      } else {
        const { db: booked, id, total } = payOrder(getDb(), {
          lines,
          method: methodId,
          payments: isSplit ? methodOrPayments : null,
          partner_id,
          config_id: config?.id ?? null,
          preset_id: presetId ?? null,
        });
        commit(booked);
        receipt = { id, name: read(booked, 'pos.order', id).name, total: total ?? round(read(booked, 'pos.order', id).amount_total + (Number(read(booked, 'pos.order', id).rounding_difference) || 0)) };
      }
    } catch (e) {
      alert(e.message);
      return;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
    requestKey.current = null;
    const methodName = isSplit
      ? methodOrPayments.map((p) => read(db, 'pos.payment.method', p.payment_method_id)?.name).filter(Boolean).join(', ')
      : (typeof methodRecord === 'object' && methodRecord !== null ? methodRecord.name : (methodRecord || 'Cash'));
    setReceipt({
      ...receipt,
      total: receipt?.total ?? finalAmount,
      method: methodName,
    });
    setCart([]);
    setPartner('');
    setSplitPayments([]);
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
                onClick={() => {
                  if (inFlight.current) return;
                  requestKey.current = null;
                  if (Boolean(preset?.is_return) !== Boolean(p.is_return)) {
                    setCart((current) => current.map((line) => ({ ...line, qty: -line.qty })));
                    setSplitPayments((current) => current.map((payment) => ({
                      ...payment, amount: payment.amount === '' ? '' : -Number(payment.amount),
                    })));
                  }
                  setPresetSelection({ configId, id: p.id });
                }}
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
          <div className="grand"><dt>{t('Total')}</dt><dd>{money(payableTotal)}</dd></div>
        </dl>
        <div className="pos-pay" aria-busy={pending}>
          <div className="split-tender-panel">
            <div className="split-tender-methods">
              {paymentMethods.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="chip"
                  disabled={pending || !lines.length || (splitPayments.length > 0 && Math.abs(remaining) < 0.005)}
                  onClick={() => addPayment(m)}
                >
                  {t(m.name)}
                </button>
              ))}
            </div>
            {splitPayments.length > 0 && (
              <ul className="pos-split-lines">
                {splitPayments.map((p, idx) => {
                  const method = read(db, 'pos.payment.method', p.payment_method_id);
                  return (
                    <li key={idx} className="row">
                      <span>{method?.name}</span>
                      <input
                        type="number"
                        step="0.01"
                        aria-label={t('{method} amount', { method: method?.name })}
                        disabled={pending}
                        value={p.amount}
                        onChange={(e) => {
                          requestKey.current = null;
                          const value = e.target.value;
                          setSplitPayments((current) => current.map((item, i) => i === idx ? { ...item, amount: value } : item));
                        }}
                      />
                      <button
                        type="button"
                        className="round"
                        aria-label={t('Remove {method}', { method: method?.name })}
                        disabled={pending}
                        onClick={() => {
                          requestKey.current = null;
                          setSplitPayments((current) => current.filter((_, i) => i !== idx));
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="split-summary">
              <div><span>{t('Paid')}</span><b>{money(paidSoFar)}</b></div>
              <div><span>{t('Remaining')}</span><b>{money(remaining)}</b></div>
            </div>
            <button
              type="button"
              className="btn primary"
              disabled={pending || !lines.length || !validPayments || Math.abs(remaining) > 0.005}
              onClick={() => pay(splitPayments.map((p) => ({ ...p, amount: round(Number(p.amount)) })))}
            >
              {t('Validate')}
            </button>
          </div>
          {!paymentMethods.length && <div className="muted">{t('No payment methods configured.')}</div>}
        </div>
      </aside>
    </main>
  );
}
