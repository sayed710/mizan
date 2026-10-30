// Point of Sale sessions (opening/closing cash control), paying and refunding orders.
import { create, read, search, write } from '../orm.js';
import { amounts, nextName, today } from './common.js';
import { deliver, isPeriodicValuation, moveValued, reverseReceipt } from './valuation.js';
import { accountId, invoiceLines, postEntry } from './ledger.js';
import { fiscalPositionFor, productTax } from './taxes.js';
import { convertPrice, lineToStockQty, uomForLegacy } from './uom.js';
import { cashRound, round } from '../money.js';
import { priceFor } from './pricelist.js';

const CASH = '101501';
export const openSession = (db) => search(db, 'pos.session').find((s) => s.state === 'opened') ?? null;

/** Open the register with the counted opening cash. */
export function startSession(db, openingCash = 0, configId = null) {
  if (openSession(db)) throw new Error('A session is already open');
  const config = configId ? read(db, 'pos.config', configId) : (search(db, 'pos.config')[0] ?? null);
  return create(db, 'pos.session', {
    name: nextName(db, 'pos.session', 'POS/S/'),
    state: 'opened',
    start_at: today(),
    cash_start: round(Number(openingCash) || 0),
    config_id: config?.id ?? (configId || null),
    company_id: config?.company_id ?? 1,
  });
}

/**
 * Lines of a cart priced from the products: sales price and the product's sales tax record
 * (price-included or not), mapped through the customer's fiscal position.
 */
export const priceLines = (db, cart, partnerId = null, { pricelistId = null, fiscalPositionId = null } = {}) => cart.map((l) => {
  const p = read(db, 'product', l.product_id);
  const fp = fiscalPositionId || fiscalPositionFor(db, partnerId);
  const tax = productTax(db, p, 'sale', fp) ?? { tax: p?.sale_tax ?? 14 };
  const uom_id = l.uom_id || p?.uom_id;
  const stock = p?.uom_id ?? uomForLegacy(db, p?.uom ?? 'unit')?.id;
  const rawPrice = pricelistId ? priceFor(db, pricelistId, l.product_id, Math.abs(l.qty), p?.list_price ?? 0) : (p?.list_price ?? 0);
  const price = uom_id && stock ? convertPrice(db, rawPrice, stock, uom_id) : rawPrice;
  return { product_id: l.product_id, qty: l.qty, ...(uom_id ? { uom_id } : {}), price_unit: price, discount: Number(l.discount ?? 0), ...tax };
});

// Resolve both configured tenders and, when requested, historical ID-based tenders.
function matchMethod(db, methods, candidate, allowHistorical = false) {
  const cand = typeof candidate === 'string' && /^\d+$/.test(candidate) ? Number(candidate) : candidate;
  if (typeof cand === 'number') {
    return methods.find((m) => m.id === cand) ?? (allowHistorical ? read(db, 'pos.payment.method', cand) : null);
  }
  const str = String(cand ?? '').toLowerCase();
  const targetType = ({ cash: 'cash', card: 'bank', bank: 'bank' })[str] ?? str;
  return methods.find((m) => m.name?.toLowerCase() === str) ?? methods.find((m) => m.type === targetType) ?? (allowHistorical ? (db?.records['pos.payment.method'] ?? []).find((m) => m.name?.toLowerCase() === str || m.type === targetType) : null);
}

function tenderType(method) {
  return method?.type === 'cash' ? 'cash' : (method?.type === 'bank' ? 'bank' : method?.type);
}

function paymentError(payments, fallback = 'Invalid payment method') {
  return payments ? 'Invalid payments' : fallback;
}

/** How an order was paid, per method ('cash' or 'bank'): its split tender when it has one, else the whole total. */
export const tendersOf = (order, db = null) => (order.payment_ids?.length
  ? order.payment_ids.map((p) => {
      let method = 'cash';
      if (p.payment_method_id && db) {
        method = tenderType(matchMethod(db, [], p.payment_method_id, true));
      } else if (p.method) {
        method = p.method === 'cash' ? 'cash' : (p.method === 'bank' || p.method === 'card' ? 'bank' : p.method);
      }
      return { method, amount: Number(p.amount) || 0 };
    })
  : [{
      method: (() => {
        const type = (order.payment_method_id && db ? matchMethod(db, [], order.payment_method_id, true)?.type : null) ?? order.payment_method;
        return type === 'cash' ? 'cash' : (type === 'bank' || type === 'card' ? 'bank' : type);
      })(),
      amount: amounts(order.lines).total,
    }]);

export function posOrderTotal(db, lines, { configId = null, method = null, payments = null } = {}) {
  const total = amounts(lines);
  const config = configId ? read(db, 'pos.config', configId) : null;
  const rounding = config?.cash_rounding && config?.rounding_method_id ? read(db, 'account.cash.rounding', config.rounding_method_id) : null;
  if (!rounding) {
    return { ...total, roundedTotal: round(total.total), roundingDifference: 0, isCash: false };
  }
  const rawPayments = payments ?? [{ payment_method_id: method, amount: total.total }];
  const isCash = rawPayments.some((p) => {
    if (typeof method === 'object' && method?.type && p.payment_method_id === method) return method.type === 'cash';
    const value = p.payment_method_id ?? p.method ?? method;
    const match = matchMethod(db, posPaymentMethods(db, configId), value, true);
    return match ? match.type === 'cash' : String(value ?? '').toLowerCase() === 'cash';
  });
  const shouldRound = Boolean(!config?.only_round_cash_method || isCash);
  const roundedTotal = shouldRound ? cashRound(total.total, rounding.rounding, rounding.rounding_method) : round(total.total);
  const roundingDifference = shouldRound ? round(roundedTotal - total.total) : 0;
  return { ...total, roundedTotal, roundingDifference, isCash };
}

export function posPaymentMethods(db, configId) {
  const config = configId ? read(db, 'pos.config', configId) : null;
  const compId = config?.company_id ?? 1;
  const methods = (db?.records['pos.payment.method'] ?? []).filter((m) => m.active !== false && (m.company_id ?? 1) === compId);
  if (!config) return methods;
  if (config.payment_method_ids != null) {
    const configuredIds = new Set();
    for (const p of config.payment_method_ids) {
      if (typeof p === 'number') {
        configuredIds.add(p);
      } else if (p && typeof p === 'object') {
        const id = p.payment_method_id ?? p.id;
        if (id) {
          configuredIds.add(id);
        } else if (p.name || p.journal) {
          const match = methods.find((m) => m.name?.toLowerCase() === p.name?.toLowerCase() || m.type === (p.journal === 'cash' ? 'cash' : 'bank'));
          if (match) configuredIds.add(match.id);
        }
      }
    }
    return methods.filter((m) => configuredIds.has(m.id));
  }
  return methods.filter((m) => (m.config_ids ?? []).includes(configId));
}

/** The company an order belongs to, resolving from order, session, config or entries. */
export function orderCompany(db, order) {
  if (!order) return 1;
  if (order.company_id != null) return order.company_id;
  if (order.session_id) {
    const session = read(db, 'pos.session', order.session_id);
    if (session?.company_id != null) return session.company_id;
  }
  if (order.config_id) {
    const config = read(db, 'pos.config', order.config_id);
    if (config?.company_id != null) return config.company_id;
  }
  if (order.accounting_entries?.length) {
    for (const entry of order.accounting_entries) {
      if (entry?.move_id) {
        const move = read(db, 'account.move', entry.move_id);
        if (move?.company_id != null) return move.company_id;
      }
    }
  }
  return 1;
}

export function resolvePosConfigAndPreset(db, {
  session = null,
  config_id = null,
  preset_id = null,
  refund_of = null,
  original = null,
  lines = null,
  partner_id = null,
} = {}) {
  const sess = session !== null ? session : openSession(db);
  if (!sess) throw new Error('Open a session first');

  const orig = original ?? (refund_of ? read(db, 'pos.order', Number(refund_of)) : null);
  if (orig) {
    const origCompany = orderCompany(db, orig);
    if ((sess.company_id ?? 1) !== origCompany) {
      throw new Error('POS session company does not match the order company');
    }
    if (sess.config_id && orig.config_id && sess.config_id !== orig.config_id) {
      throw new Error('POS configuration does not match the session');
    }
  }

  const rawConfigId = config_id != null && config_id !== '' ? Number(config_id) : null;
  const resolvedConfigId = rawConfigId ?? orig?.config_id ?? sess.config_id ?? (search(db, 'pos.config')[0]?.id ?? null);
  const config = resolvedConfigId ? read(db, 'pos.config', resolvedConfigId) : null;

  if (sess.config_id && resolvedConfigId !== sess.config_id) {
    throw new Error('POS configuration does not match the session');
  }
  if (config && (config.company_id ?? 1) !== (sess.company_id ?? 1)) {
    throw new Error('POS configuration does not match the session');
  }

  const rawPresetId = preset_id != null && preset_id !== '' ? Number(preset_id) : null;
  const effectivePresetId = !refund_of ? (rawPresetId ?? config?.default_preset_id ?? null) : (orig?.preset_id ?? null);

  if (!refund_of) {
    if (config?.available_preset_ids?.length && !effectivePresetId) {
      throw new Error('Select an available preset');
    }
    if (effectivePresetId && (!config?.available_preset_ids?.includes(effectivePresetId) || !read(db, 'pos.preset', effectivePresetId))) {
      throw new Error('Select an available preset');
    }
  }

  const preset = !orig && effectivePresetId ? read(db, 'pos.preset', effectivePresetId) : null;
  const isReturn = orig
    ? (orig.preset_snapshot?.is_return ?? (Array.isArray(lines) && lines.length ? lines.every((l) => Number(l.qty) < 0) : false))
    : Boolean(preset?.is_return);

  const effectivePartnerId = partner_id ?? orig?.partner_id ?? null;

  const presetSnapshot = orig ? (orig.preset_snapshot ?? {
    is_return: isReturn,
    identification: null,
    pricelist_id: null,
    fiscal_position_id: orig.fiscal_position_id ?? null,
  }) : {
    is_return: isReturn,
    identification: preset?.identification ?? 'none',
    pricelist_id: preset?.pricelist_id ?? null,
    fiscal_position_id: preset?.fiscal_position_id ?? fiscalPositionFor(db, effectivePartnerId) ?? null,
  };

  return {
    session: sess,
    config,
    resolvedConfigId,
    effectivePresetId,
    preset,
    presetSnapshot,
    isReturn,
    original: orig,
    effectivePartnerId,
  };
}

export function validatePosProducts(db, lines, configCompId, { allowAdjustments = false } = {}) {
  for (const line of lines) {
    // Restaurant loyalty and gift-card discounts are server-generated productless lines.
    if (allowAdjustments && !line.product_id && Number(line.price_unit) < 0) continue;
    if (line.is_tip && !line.product_id) continue;
    if (line.payment_rounding && !line.product_id) continue;
    const product = read(db, 'product', line.product_id);
    if (!product || product.active === false || product.available_in_pos === false || product.sale_ok === false || (product.company_id != null && product.company_id !== configCompId)) {
      throw new Error('Product is not available in POS');
    }
  }
}

function validateRefundSource(db, { lines, refund_of, config_id, session }) {
  const original = refund_of ? read(db, 'pos.order', Number(refund_of)) : null;
  if (refund_of && (!original || JSON.stringify(lines) !== JSON.stringify(original.lines))) {
    throw new Error('Only a full order refund is supported; partial refunds are not supported');
  }
  if (refund_of) {
    if (search(db, 'pos.order').some((o) => o.refund_of === original.id)) throw new Error('This order was already refunded');
    if (original.state !== 'paid') throw new Error('Only paid orders can be refunded');
    const origCompany = orderCompany(db, original);
    if ((session.company_id ?? 1) !== origCompany) {
      throw new Error('POS session company does not match the order company');
    }
    if (session.config_id && original.config_id && session.config_id !== original.config_id) {
      throw new Error('POS configuration does not match the session');
    }
    if (config_id && session.config_id && Number(config_id) !== session.config_id) {
      throw new Error('POS configuration does not match the session');
    }
    if (original.config_id && config_id && Number(config_id) !== original.config_id) {
      throw new Error('POS configuration does not match the session');
    }
  }
  return original;
}

function originalTenders(db, original, enabledMethods, expectedTotal) {
  if (!original) return null;
  if (Array.isArray(original.payment_ids) && original.payment_ids.length > 0) {
    return original.payment_ids.map((p) => {
      const match = matchMethod(db, enabledMethods, p.payment_method_id ?? p.method, true);
      const methodType = tenderType(match) ?? p.method;
      return {
        payment_method_id: match?.id ?? (typeof p.payment_method_id === 'number' ? p.payment_method_id : null),
        method: methodType,
        amount: round(Number(p.amount) || 0),
      };
    });
  }
  const match = matchMethod(db, enabledMethods, original.payment_method_id ?? original.payment_method, true);
  const methodType = tenderType(match) ?? original.payment_method;
  return [{
    payment_method_id: match?.id ?? (typeof original.payment_method_id === 'number' ? original.payment_method_id : null),
    method: methodType,
    amount: expectedTotal,
  }];
}

function resolveRefundTenders(db, { original, payments, method, enabledMethods, recordedOriginalTenders }) {
  const rawTenders = original.payment_ids?.length ? original.payment_ids : [{ payment_method_id: original.payment_method_id }];
  const matchesRecorded = (rec, raw, match) => raw.payment_method_id != null
    ? String(match.id) === String(raw.payment_method_id)
    : rec.method === tenderType(match);
  if (payments !== null && payments !== undefined) {
    if (!Array.isArray(payments) || payments.length !== recordedOriginalTenders.length) {
      throw new Error('Invalid payments: refund tenders must match the original order');
    }
    const remaining = recordedOriginalTenders.map((rec, i) => ({ rec, raw: rawTenders[i] }));
    for (const p of payments) {
      if (!p) throw new Error('Invalid payments: refund tenders must match the original order');
      const cand = p.payment_method_id ?? p.method;
      const match = matchMethod(db, enabledMethods, cand, true);
      if (!match) throw new Error('Invalid payments: refund tenders must match the original order');
      const pAmt = round(Number(p.amount));
      const idx = remaining.findIndex(({ rec, raw }) => {
        const methodMatches = matchesRecorded(rec, raw, match);
        const amtMatches = pAmt === rec.amount || pAmt === -rec.amount;
        return methodMatches && amtMatches;
      });
      if (idx === -1) {
        throw new Error('Invalid payments: refund tenders must match the original order');
      }
      remaining.splice(idx, 1);
    }
  } else if (method !== null && method !== undefined) {
    if (recordedOriginalTenders.length !== 1) {
      throw new Error('Invalid payment method: refund tenders must match the original order');
    }
    const match = matchMethod(db, enabledMethods, method, true);
    const rec = recordedOriginalTenders[0];
    const methodMatches = match && matchesRecorded(rec, rawTenders[0], match);
    if (!methodMatches) {
      throw new Error('Invalid payment method: refund tenders must match the original order');
    }
  }
  return recordedOriginalTenders;
}

function resolveNewOrderTenders(db, { payments, method, expectedTotal, enabledMethods, session, effectivePartnerId, isReturn }) {
  if (payments !== null && payments !== undefined && (!Array.isArray(payments) || !payments.length)) {
    throw new Error('Invalid payments');
  }
  const rawPayments = payments ?? [{ payment_method_id: typeof method === 'number' ? method : null, method: typeof method === 'string' ? method : undefined, amount: expectedTotal }];
  if (!rawPayments.length) throw new Error(paymentError(payments));

  const resolvedPayments = rawPayments.map((p) => {
    if (!p) throw new Error(paymentError(payments));
    const cand = p.payment_method_id ?? p.method;
    const match = matchMethod(db, enabledMethods, cand, false);
    if (!match || match.active === false || (match.company_id ?? 1) !== (session.company_id ?? 1)) {
      throw new Error(paymentError(payments));
    }
    if (match.type === 'pay_later' && !effectivePartnerId) {
      throw new Error('A customer is required for pay later');
    }
    if (match.type !== 'pay_later' && !read(db, 'account.journal', match.journal_id)) {
      throw new Error('Payment journal is required');
    }
    const amt = Number(p.amount);
    if (!Number.isFinite(amt)) throw new Error(paymentError(payments, 'Invalid payment amount'));
    if (round(expectedTotal) !== 0) {
      if (Math.abs(amt) === 0) throw new Error(paymentError(payments, 'Invalid payment amount'));
      if (isReturn ? amt > 0 : amt < 0) throw new Error(paymentError(payments, 'Invalid payment amount'));
    } else if (round(amt) !== 0 || Math.abs(amt) !== 0) {
      throw new Error(paymentError(payments, 'Invalid payment amount'));
    }
    return {
      payment_method_id: match.id,
      method: tenderType(match),
      amount: round(amt),
    };
  });

  if (round(resolvedPayments.reduce((s, p) => s + p.amount, 0)) !== round(expectedTotal)) {
    throw new Error('The payments must add up to the order total');
  }
  return resolvedPayments;
}

function validateReturnValuation(db, { original, lines, session }) {
  if (!original) return;
  for (const [index, l] of lines.entries()) {
    const p = read(db, 'product', l.product_id);
    if (p?.type !== 'goods' || !l.qty) continue;
    const qty = lineToStockQty(db, l, p);
    const periodic = isPeriodicValuation(db, p);
    if (qty < 0) {
      const retLayer = original.return_layers?.find((c) => c.index === index);
      if (!retLayer?.layer_id) {
        if (!periodic) throw new Error('Original return valuation provenance was not found; historical orders require manual refund');
      } else {
        const layer = read(db, 'stock.valuation.layer', retLayer.layer_id);
        if (!layer || layer.kind !== 'in' || (layer.company_id ?? 1) !== (session.company_id ?? 1) || !(layer.quantity > 0)) {
          throw new Error('Original return valuation layer was not found');
        }
        if (Math.abs(layer.remaining_qty - layer.quantity) > 1e-8 || round(layer.remaining_value - layer.value) !== 0) {
          throw new Error('Returned stock has been consumed or revalued; reconcile it before cancellation');
        }
      }
    }
  }
}

function validateCheckoutAccounting(db, { original, total, expectedTotal, session, resolvedPayments }) {
  if (original) {
    if (round(total.total) !== 0) {
      const valuationMoveIds = new Set(
        (db.records['stock.valuation.layer'] ?? [])
          .map((l) => l.move_id)
          .filter(Boolean)
      );
      const ids = original.accounting_entries?.map((entry) => entry.move_id);
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) {
        throw new Error('Original POS entries were not found; historical orders require manual refund');
      }
      const entries = ids.map((moveId) => read(db, 'account.move', moveId));
      if (entries.some((m) => !m || m.state !== 'posted' || (m.company_id ?? 1) !== (session.company_id ?? 1) || valuationMoveIds.has(m.id))) {
        throw new Error('Original POS entries are invalid');
      }
      for (const entry of entries) {
        const journal = read(db, 'account.journal', entry.journal_id);
        if (!journal) throw new Error('Original POS journal was not found');
      }
    }
  } else if (round(expectedTotal) !== 0) {
    const counterpart = accountId(db, '121000', session.company_id);
    if (!counterpart) throw new Error('POS needs a receivable counterpart account (121000)');
    for (const p of resolvedPayments) {
      const m = read(db, 'pos.payment.method', p.payment_method_id);
      if (m && m.type !== 'pay_later') {
        const journal = read(db, 'account.journal', m.journal_id);
        const account = read(db, 'account.account', m.outstanding_account_id || journal?.default_account_id)?.code;
        if (!account) throw new Error('Payment account is required');
      }
    }
  }
}

export function resolvePosOrderCheckout(db, { lines, method, payments = null, partner_id = null, refund_of = null, config_id = null, preset_id = null }) {
  const session = openSession(db);
  if (!session) throw new Error('Open a session first');
  if (!Array.isArray(lines) || !lines.length) throw new Error('The order is empty');

  const original = validateRefundSource(db, { lines, refund_of, config_id, session });

  const {
    config,
    resolvedConfigId,
    preset,
    effectivePresetId,
    presetSnapshot,
    isReturn,
    effectivePartnerId,
  } = resolvePosConfigAndPreset(db, {
    session,
    config_id,
    preset_id,
    refund_of,
    original,
    lines,
    partner_id,
  });

  // Validate line quantities and discounts
  if (lines.some((l) => !l || !Number.isFinite(Number(l.qty)) || (isReturn ? Number(l.qty) >= 0 : Number(l.qty) <= 0) || !Number.isFinite(Number(l.discount ?? 0)) || Number(l.discount ?? 0) < 0 || Number(l.discount ?? 0) > 100)) {
    throw new Error(isReturn ? 'Return cart quantity must be negative' : 'Invalid cart quantities or discounts');
  }

  // Validate product availability and company
  if (!original) {
    const configCompId = config?.company_id ?? session.company_id ?? 1;
    validatePosProducts(db, lines, configCompId, { allowAdjustments: true });
  }

  // Customer identification
  if (preset) {
    if (preset.identification === 'name') {
      const p = effectivePartnerId ? read(db, 'res.partner', effectivePartnerId) : null;
      if (!p?.name) throw new Error('A customer name is required');
    } else if (preset.identification === 'address') {
      const p = effectivePartnerId ? read(db, 'res.partner', effectivePartnerId) : null;
      const hasAddress = Boolean(p && (p.street || p.city || p.contact_address || p.zip));
      if (!hasAddress) throw new Error('Customer address is required');
    }
  }

  const total = amounts(lines);
  const calculated = original ? null : posOrderTotal(db, lines, { configId: resolvedConfigId, method, payments });
  const expectedTotal = original ? round(total.total + (Number(original.rounding_difference) || 0)) : calculated.roundedTotal;
  const roundingDiff = original ? Number(original.rounding_difference) || 0 : calculated.roundingDifference;

  const enabledMethods = posPaymentMethods(db, resolvedConfigId);

  const recordedOriginalTenders = originalTenders(db, original, enabledMethods, expectedTotal);

  const resolvedPayments = original
    ? resolveRefundTenders(db, { original, payments, method, enabledMethods, recordedOriginalTenders })
    : resolveNewOrderTenders(db, { payments, method, expectedTotal, enabledMethods, session, effectivePartnerId, isReturn });

  validateReturnValuation(db, { original, lines, session });
  validateCheckoutAccounting(db, { original, total, expectedTotal, session, resolvedPayments });

  return {
    session,
    config,
    resolvedConfigId,
    preset,
    effectivePresetId,
    presetSnapshot,
    isReturn,
    total,
    expectedTotal,
    roundingDiff,
    resolvedPayments,
    original,
    effectivePartnerId,
  };
}

function moveOrderStock(db, { next, id, name, lines, refund_of, original, session }) {
  const sign = refund_of ? -1 : 1;
  const returnLayers = [];
  let stocked = next;
  const costs = [];
  for (const [index, l] of lines.entries()) {
    const p = read(stocked, 'product', l.product_id);
    if (p?.type !== 'goods' || !l.qty) continue;
    const qty = lineToStockQty(stocked, l, p);
    const periodic = isPeriodicValuation(stocked, p);
    if (original && qty < 0 && original.return_layers?.find((c) => c.index === index)?.layer_id) {
      stocked = reverseReceipt(stocked, original.return_layers.find((c) => c.index === index).layer_id, { reference: name, company_id: session.company_id });
    } else if (original && qty < 0 && (!periodic || !original.return_layers?.some((c) => c.index === index))) {
      throw new Error('Original return valuation provenance was not found; historical orders require manual refund');
    } else if (!refund_of && !periodic && qty > 0) {
      const out = deliver(stocked, p.id, qty, { reference: name, company_id: session.company_id });
      stocked = out.db;
      costs.push({ index, unit_cost: out.value / qty });
    } else {
      const unit_cost = original?.stock_costs?.find((c) => c.index === index)?.unit_cost ?? p.cost;
      const before = new Set((stocked.records['stock.valuation.layer'] ?? []).map((layer) => layer.id));
      stocked = moveValued(stocked, [{ ...l, qty: Math.abs(qty), unit_cost }], qty < 0 ? sign : -sign, { reference: name, counterpart: '500000', company_id: session.company_id });
      if (!original && qty < 0) {
        const layer = (stocked.records['stock.valuation.layer'] ?? []).find((item) => !before.has(item.id) && item.kind === 'in' && item.product_id === p.id);
        returnLayers.push({ index, layer_id: layer?.id ?? null });
      }
    }
  }
  stocked = write(stocked, 'pos.order', id, { stock_costs: costs, return_layers: returnLayers });
  return stocked;
}

function reverseOrderEntries(db, { stocked, original, session, name, id, expectedTotal }) {
  const valuationMoveIds = new Set(
    (db.records['stock.valuation.layer'] ?? [])
      .map((l) => l.move_id)
      .filter(Boolean)
  );
  const ids = original.accounting_entries?.map((entry) => entry.move_id);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('Original POS entries were not found; historical orders require manual refund');
  const entries = ids.map((moveId) => read(db, 'account.move', moveId));
  if (entries.some((m) => !m || m.state !== 'posted' || (m.company_id ?? 1) !== (session.company_id ?? 1) || valuationMoveIds.has(m.id))) throw new Error('Original POS entries are invalid');
  let reversed = stocked;
  const reversedIds = [];
  for (const entry of entries) {
    const journal = read(db, 'account.journal', entry.journal_id);
    if (!journal) throw new Error('Original POS journal was not found');
    const lines = entry.line_ids.map((l) => ({ ...l, debit: l.credit, credit: l.debit, ...(l.tax_zero ? { tax_base: -(Number(l.tax_base) || 0) } : {}) }));
    const result = postEntry(reversed, { journal: journal.code, journal_id: journal.id, company: session.company_id, ref: name, lines });
    reversed = result.db;
    reversedIds.push(result.id);
  }
  reversed = write(reversed, 'pos.order', original.id, { state: 'refunded' });
  return { db: write(reversed, 'pos.order', id, { accounting_entries: reversedIds.map((move_id) => ({ move_id })) }), id, name, total: expectedTotal };
}

function postOrderEntries(db, { stocked, lines, refund_of, session, partner_id, presetSnapshot, name, rounding, resolvedPayments, roundingDiff, isReturn, id, expectedTotal }) {
  const sale = invoiceLines(stocked, {
    move_type: refund_of ? 'out_refund' : 'out_invoice',
    company_id: session.company_id,
    partner_id,
    fiscal_position_id: presetSnapshot.fiscal_position_id,
    name,
    invoice_line_ids: lines.map((l) => ({ ...l, tax_cash_basis: false })),
  });
  const counterpart = accountId(db, '121000', session.company_id);
  if (!counterpart) throw new Error('POS needs a receivable counterpart account (121000)');
  const profitAcc = (rounding?.profit_account_id && read(db, 'account.account', rounding.profit_account_id)?.code) || '450000';
  const lossAcc = (rounding?.loss_account_id && read(db, 'account.account', rounding.loss_account_id)?.code) || '690000';
  const saleLines = [
    ...sale.filter((l) => l.account_id !== counterpart),
    ...resolvedPayments.map((p) => ({
      account_id: read(db, 'pos.payment.method', p.payment_method_id).receivable_account_id || counterpart,
      partner_id,
      debit: (refund_of || isReturn || Number(p.amount) < 0) ? 0 : Math.abs(Number(p.amount)),
      credit: (refund_of || isReturn || Number(p.amount) < 0) ? Math.abs(Number(p.amount)) : 0,
    })),
  ];
  if (roundingDiff !== 0) {
    const isProfit = (refund_of ? -roundingDiff : roundingDiff) > 0;
    const acc = isProfit ? profitAcc : lossAcc;
    const amt = Math.abs(roundingDiff);
    saleLines.push(isProfit ? { account: acc, credit: amt, partner_id, name: 'Cash Rounding' } : { account: acc, debit: amt, partner_id, name: 'Cash Rounding' });
  }
  const saleEntry = postEntry(stocked, { journal: 'POSS', company: session.company_id, ref: name, lines: saleLines.map((l) => ({ ...l, account: l.account ?? read(stocked, 'account.account', l.account_id)?.code })) });
  let booked = saleEntry.db;
  const moveIds = [saleEntry.id];
  for (const p of resolvedPayments) {
    const m = read(booked, 'pos.payment.method', p.payment_method_id);
    if (m.type === 'pay_later') continue;
    const journal = read(booked, 'account.journal', m.journal_id);
    const account = read(booked, 'account.account', m.outstanding_account_id || journal.default_account_id)?.code;
    const receivable = read(booked, 'account.account', m.receivable_account_id)?.code ?? '121000';
    if (!account) throw new Error('Payment account is required');
    const amount = Number(p.amount);
    const isOutbound = refund_of || isReturn || amount < 0;
    const tenderEntry = postEntry(booked, {
      journal: journal.code,
      journal_id: journal.id,
      company: session.company_id,
      ref: name,
      lines: isOutbound
        ? [{ account, credit: Math.abs(amount), partner_id }, { account: receivable, debit: Math.abs(amount), partner_id }]
        : [{ account, debit: Math.abs(amount), partner_id }, { account: receivable, credit: Math.abs(amount), partner_id }],
    });
    booked = tenderEntry.db;
    moveIds.push(tenderEntry.id);
  }
  return { db: write(booked, 'pos.order', id, { accounting_entries: moveIds.map((move_id) => ({ move_id })) }), id, name, total: expectedTotal };
}

/**
 * Book a paid (or refunded) order: stock out (in), one entry with the money per method, the revenue and the tax.
 * `payments` splits the money between methods ([{method, amount}] summing to the total); otherwise all goes to `method`.
 */
export function payOrder(db, { lines, method, payments = null, partner_id = null, refund_of = null, config_id = null, preset_id = null }) {
  const checkout = resolvePosOrderCheckout(db, { lines, method, payments, partner_id, refund_of, config_id, preset_id });
  const { session, config, resolvedConfigId, presetSnapshot, effectivePresetId, isReturn, total, expectedTotal, roundingDiff, resolvedPayments, original, effectivePartnerId } = checkout;

  const rounding = config?.cash_rounding && config?.rounding_method_id ? read(db, 'account.cash.rounding', config.rounding_method_id) : null;
  const primaryMethod = read(db, 'pos.payment.method', resolvedPayments[0].payment_method_id);
  const orderPaymentMethod = primaryMethod ? (primaryMethod.type === 'cash' ? 'cash' : (primaryMethod.type === 'bank' ? 'card' : primaryMethod.type)) : resolvedPayments[0].method;
  const primaryMethodId = primaryMethod?.id ?? resolvedPayments[0].payment_method_id ?? null;

  const { db: next, id } = create(db, 'pos.order', {
    partner_id: effectivePartnerId,
    payment_method: orderPaymentMethod,
    payment_method_id: primaryMethodId,
    payment_ids: resolvedPayments,
    config_id: resolvedConfigId,
    company_id: session.company_id ?? 1,
    lines,
    session_id: session.id,
    state: refund_of ? 'refund' : 'paid',
    refund_of,
    preset_id: effectivePresetId,
    preset_snapshot: presetSnapshot,
    fiscal_position_id: presetSnapshot.fiscal_position_id,
    rounding_difference: roundingDiff,
    accounting_entries: [],
  });
  const name = read(next, 'pos.order', id).name;
  let stocked = moveOrderStock(db, { next, id, name, lines, refund_of, original, session });
  if (round(total.total) === 0) {
    if (original) stocked = write(stocked, 'pos.order', original.id, { state: 'refunded' });
    return { db: stocked, id, name, total: expectedTotal };
  }

  if (original) return reverseOrderEntries(db, { stocked, original, session, name, id, expectedTotal });

  return postOrderEntries(db, { stocked, lines, refund_of, session, partner_id, presetSnapshot, name, rounding, resolvedPayments, roundingDiff, isReturn, id, expectedTotal });
}

/** Durable retry identity is stored with the booking; a changed catalog never reprices an already-paid cart. */
export function payCart(db, { cart = [], lines: inputLines = null, method, payments = null, partner_id = null, request_key = null, config_id = null, preset_id = null, refund_of = null }) {
  const original = refund_of ? read(db, 'pos.order', Number(refund_of)) : null;
  const rawCart = inputLines ?? cart;
  const normalized = original ? original.lines : rawCart.map((l) => ({ product_id: Number(l.product_id), qty: Number(l.qty), discount: Number(l.discount ?? 0), ...(l.uom_id ? { uom_id: Number(l.uom_id) } : {}) }));
  const fingerprint = JSON.stringify([normalized, method, payments, partner_id, config_id, preset_id, refund_of]);
  if (request_key !== null && (typeof request_key !== 'string' || !/^[\w:-]{8,200}$/.test(request_key))) throw new Error('Invalid payment request key');
  const prior = request_key && search(db, 'pos.order').find((o) => o.request_key === request_key);
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new Error('This request key was already used for a different payment');
    const order = read(db, 'pos.order', prior.id);
    const total = round(order.amount_total + (Number(order.rounding_difference) || 0));
    return { db, id: prior.id, name: order.name, total };
  }
  const resolved = resolvePosConfigAndPreset(db, {
    config_id,
    preset_id,
    refund_of,
    original,
    lines: normalized,
    partner_id,
  });
  if (!original) {
    if (!Array.isArray(rawCart) || !rawCart.length) throw new Error('Invalid cart quantities or discounts');
    for (const l of rawCart) {
      if (!l || !Number.isFinite(Number(l.qty)) || (resolved.isReturn ? Number(l.qty) >= 0 : Number(l.qty) <= 0) || !Number.isFinite(Number(l.discount ?? 0)) || Number(l.discount ?? 0) < 0 || Number(l.discount ?? 0) > 100) {
        throw new Error(resolved.isReturn ? 'Return cart quantity must be negative' : 'Invalid cart quantities or discounts');
      }
    }
    const session = openSession(db);
    const configCompId = resolved.config?.company_id ?? session?.company_id ?? 1;
    validatePosProducts(db, normalized, configCompId);
  }
  const lines = original ? original.lines : priceLines(db, normalized, resolved.effectivePartnerId, {
    pricelistId: resolved.presetSnapshot.pricelist_id,
    fiscalPositionId: resolved.presetSnapshot.fiscal_position_id,
  });
  const out = payOrder(db, {
    lines,
    method,
    payments,
    partner_id: resolved.effectivePartnerId,
    config_id: resolved.resolvedConfigId,
    preset_id: resolved.effectivePresetId,
    refund_of: refund_of ? Number(refund_of) : null,
  });
  return request_key ? { ...out, db: write(out.db, 'pos.order', out.id, { request_key, request_fingerprint: fingerprint }) } : out;
}

/** Refund a paid order in full (stock comes back, money goes out the way it came in). */
export function refundOrder(db, order) {
  if (!order) throw new Error('Order not found');
  const session = openSession(db);
  if (!session) throw new Error('Open a session first');
  if (order.state !== 'paid') throw new Error('Only paid orders can be refunded');
  if (search(db, 'pos.order').some((o) => o.refund_of === order.id)) throw new Error('This order was already refunded');
  const orderComp = orderCompany(db, order);
  if ((session.company_id ?? 1) !== orderComp) {
    throw new Error('POS session company does not match the order company');
  }
  if (session.config_id && order.config_id && session.config_id !== order.config_id) {
    throw new Error('POS configuration does not match the session');
  }
  const out = payOrder(db, { lines: order.lines, method: order.payment_method_id ?? order.payment_method, payments: order.payment_ids?.length ? order.payment_ids : null, partner_id: order.partner_id, refund_of: order.id, config_id: order.config_id, preset_id: order.preset_id });
  return { ...out, db: write(out.db, 'pos.order', order.id, { state: 'refunded' }) };
}

/** Session totals by payment method (refunds negative) and the cash expected in the drawer. */
export function sessionTotals(db, session) {
  const orders = search(db, 'pos.order').filter((o) => o.session_id === session.id);
  const sum = (method) => round(orders.reduce((s, o) => {
    // Reversals retain the original signed tenders, so invert them once.
    const sign = o.refund_of || o.state === 'refund' ? -1 : 1;
    return s + sign * tendersOf(o, db).filter((t) => t.method === method).reduce((a, t) => a + t.amount, 0);
  }, 0));
  const cash = sum('cash');
  return { orders: orders.length, cash, card: sum('bank'), expected: round((Number(session.cash_start) || 0) + cash) };
}

/** Close with the counted cash; a difference is booked as a cash gain or loss. */
export function closeSession(db, session, countedCash) {
  if (session.state !== 'opened') throw new Error('The session is not open');
  const { cash, card, expected } = sessionTotals(db, session);
  const counted = round(Number(countedCash) || 0);
  const difference = round(counted - expected);
  const booked = difference ? postEntry(db, {
    journal: 'POSS', company: session.company_id, ref: `${session.name} cash difference`,
    lines: difference > 0 ? [{ account: CASH, debit: difference }, { account: '450000', credit: difference }] : [{ account: '690000', debit: -difference }, { account: CASH, credit: -difference }],
  }).db : db;
  return write(booked, 'pos.session', session.id, { state: 'closed', stop_at: today(), total_cash: cash, total_card: card, cash_expected: expected, cash_end: counted, cash_difference: difference });
}

export const posModels = {
  'pos.session': {
    label: 'Sessions',
    fields: {
      name: { type: 'char', label: 'Session', readonly: true },
      config_id: { type: 'many2one', relation: 'pos.config', label: 'Point of Sale' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['opened', 'In Progress'], ['closed', 'Closed']] },
      start_at: { type: 'date', label: 'Opening Date', readonly: true },
      stop_at: { type: 'date', label: 'Closing Date', readonly: true },
      cash_start: { type: 'monetary', label: 'Opening Cash' },
      total_cash: { type: 'monetary', label: 'Cash Payments', readonly: true },
      total_card: { type: 'monetary', label: 'Card Payments', readonly: true },
      cash_expected: { type: 'monetary', label: 'Expected Cash', readonly: true },
      cash_end: { type: 'monetary', label: 'Counted Cash', readonly: true },
      cash_difference: { type: 'monetary', label: 'Difference', readonly: true },
    },
    defaults: () => ({ state: 'opened', start_at: today(), cash_start: 0 }),
    kanban: { title: 'name', lines: ['start_at', 'cash_expected'], badge: 'state' },
    list: ['name', 'start_at', 'stop_at', 'total_cash', 'total_card', 'cash_difference', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: () => true,
      smart: [{ label: 'Orders', model: 'pos.order', field: 'session_id', target: 'pos/orders' }],
      buttons: [{
        label: 'Close Session', primary: true, when: (r) => r.state === 'opened',
        run: (db, r) => {
          const { expected } = sessionTotals(db, r);
          const counted = prompt(`Counted cash in the drawer (expected ${expected})`, String(expected));
          return { db: counted == null ? db : closeSession(db, r, counted) };
        },
      }],
      title: 'name',
      groups: [['start_at', 'stop_at', 'cash_start'], ['total_cash', 'total_card', 'cash_expected', 'cash_end', 'cash_difference']],
      chatter: true,
    },
  },
};
