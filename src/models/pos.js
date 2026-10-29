// Point of Sale sessions (opening/closing cash control), paying and refunding orders.
import { create, read, search, write } from '../orm.js';
import { amounts, nextName, today } from './common.js';
import { deliver, moveValued } from './valuation.js';
import { invoiceLines, journalId, postEntry } from './ledger.js';
import { fiscalPositionFor, productTax } from './taxes.js';
import { convertPrice, lineToStockQty, uomForLegacy } from './uom.js';
import { cashRound, round } from '../money.js';
import { priceFor } from './pricelist.js';

const CASH = '101501';
const BANK = '101401';

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
  const fp = fiscalPositionId ? read(db, 'account.fiscal.position', fiscalPositionId) : fiscalPositionFor(db, partnerId);
  const tax = productTax(db, p, 'sale', fp) ?? { tax: p?.sale_tax ?? 14 };
  const uom_id = l.uom_id || p?.uom_id;
  const stock = p?.uom_id ?? uomForLegacy(db, p?.uom ?? 'unit')?.id;
  const rawPrice = pricelistId ? priceFor(db, pricelistId, l.product_id, l.qty, p?.list_price ?? 0) : (p?.list_price ?? 0);
  const price = uom_id && stock ? convertPrice(db, rawPrice, stock, uom_id) : rawPrice;
  return { product_id: l.product_id, qty: l.qty, ...(uom_id ? { uom_id } : {}), price_unit: price, discount: Number(l.discount ?? 0), ...tax };
});

/**
 * The sale (or refund) entry of a POS order, booked like a customer invoice: income per product account and
 * tax per tax account (both through the fiscal position), with the drawer or bank instead of the receivable.
 * The customer pays on the spot, so cash-basis taxes are due at once.
 */
function saleEntry(db, lines, { method, split, partner_id, refund }) {
  const move = {
    move_type: refund ? 'out_refund' : 'out_invoice', partner_id, fiscal_position_id: fiscalPositionFor(db, partner_id), name: 'POS',
    invoice_line_ids: lines.map((l) => ({ ...l, tax_cash_basis: false })),
  };
  const receivable = (db.records['account.account'] ?? []).find((a) => a.code === '121000')?.id;
  if (!receivable) throw new Error('POS needs a receivable counterpart account (121000)');
  const code = (id) => read(db, 'account.account', id)?.code;
  const pay = method === 'cash' ? CASH : BANK;
  const entries = invoiceLines(db, move).map((l) => ({
    account: l.account_id === receivable ? pay : code(l.account_id), debit: l.debit, credit: l.credit, partner_id, name: l.name,
    ...(l.tax_name ? { tax_name: l.tax_name, tax_base: l.tax_base, ...(l.tax_zero ? { tax_zero: true } : {}), tax_side: 'sale' } : {}),
  }));
  // Income and tax groups are rounded one by one, so their sum can differ by a cent from the tender actually
  // collected (receipt and session totals). The payment account takes the tender; the cent goes to a visible line.
  const tender = round(amounts(lines).total);
  const paid = entries.find((e) => e.account === pay);
  const booked = paid ? paid.debit || paid.credit : 0;
  const diff = round(tender - booked);
  const tenderLines = (entries) => !split?.length ? entries : [
    ...entries.filter((e) => e !== paid && e.account !== pay),
    ...split.map((p) => ({ account: p.method === 'cash' ? CASH : BANK, debit: refund ? 0 : p.amount, credit: refund ? p.amount : 0, partner_id })),
  ];
  if (!paid || !diff) return tenderLines(entries);
  const collectedMore = refund ? diff < 0 : diff > 0; // more cash in (or less out) than revenue: other income
  const gap = collectedMore ? { account: '450000', credit: Math.abs(diff), name: 'Rounding' } : { account: '690000', debit: Math.abs(diff), name: 'Rounding' };
  return tenderLines([...entries.map((e) => (e === paid ? { ...e, debit: paid.debit ? tender : 0, credit: paid.credit ? tender : 0 } : e)), { ...gap, partner_id }]);
}

/** The posted POS entry of an order, when it exists. */
const entryOfOrder = (db, order) => search(db, 'account.move').find((m) => m.state === 'posted' && m.ref === order.name && m.journal_id === journalId(db, 'POSS'));

/** A refund undoes what the sale booked: the same accounts the other way round, whatever the products and fiscal position say today. */
function reversalEntry(db, original, { partner_id }) {
  const entry = entryOfOrder(db, original);
  if (!entry) return null;
  const code = (id) => read(db, 'account.account', id)?.code;
  return entry.line_ids.map((l) => ({ account: code(l.account_id), debit: l.credit, credit: l.debit, partner_id: l.partner_id ?? partner_id, name: l.name, ...(l.tax_name ? { tax_name: l.tax_name, tax_base: l.tax_zero ? -l.tax_base : l.tax_base, ...(l.tax_zero ? { tax_zero: true } : {}), ...(l.tax_side ? { tax_side: l.tax_side } : {}) } : {}) }));
}

/** Book a paid order (or a refund, when `refund_of` is set) in the open session: stock moves and the sale/refund entry. */
/** How an order was paid, per method ('cash' or 'bank'): its split tender when it has one, else the whole total. */
export const tendersOf = (order, db = null) => (order.payment_ids?.length
  ? order.payment_ids.map((p) => {
      let method = 'cash';
      if (p.payment_method_id && db) {
        const type = read(db, 'pos.payment.method', p.payment_method_id)?.type;
        method = type === 'cash' ? 'cash' : (type === 'bank' ? 'bank' : type);
      } else if (p.method) {
        method = p.method === 'cash' ? 'cash' : (p.method === 'bank' || p.method === 'card' ? 'bank' : p.method);
      }
      return { method, amount: Number(p.amount) || 0 };
    })
  : [{
      method: (() => {
        const type = (order.payment_method_id && db ? read(db, 'pos.payment.method', order.payment_method_id)?.type : null) ?? order.payment_method;
        return type === 'cash' ? 'cash' : (type === 'bank' || type === 'card' ? 'bank' : type);
      })(),
      amount: amounts(order.lines).total,
    }]);

/**
 * Book a paid (or refunded) order: stock out (in), one entry with the money per method, the revenue and the tax.
 * `payments` splits the money between methods ([{method, amount}] summing to the total); otherwise all goes to `method`.
 */
export function payOrder(db, { lines, method, payments = null, partner_id = null, refund_of = null, config_id = null, preset_id = null }) {
  const session = openSession(db);
  if (!session) throw new Error('Open a session first');
  if (!lines.length) throw new Error('The order is empty');
  if (lines.some((l) => !Number.isFinite(Number(l.qty)) || Number(l.qty) <= 0)) throw new Error('Cart quantity must be finite and positive');
  if (lines.some((l) => !Number.isFinite(Number(l.discount ?? 0)) || Number(l.discount ?? 0) < 0 || Number(l.discount ?? 0) > 100)) throw new Error('Cart discount must be between 0 and 100');
  const original = refund_of ? read(db, 'pos.order', refund_of) : null;
  if (refund_of && (!original || JSON.stringify(lines) !== JSON.stringify(original.lines))) throw new Error('Only a full order refund is supported; partial refunds are not supported');
  const resolvedConfigId = config_id ?? session.config_id ?? (search(db, 'pos.config')[0]?.id ?? null);
  const config = resolvedConfigId ? read(db, 'pos.config', resolvedConfigId) : null;

  if (preset_id) {
    const preset = read(db, 'pos.preset', preset_id);
    if (preset) {
      if (preset.identification === 'name') {
        const p = partner_id ? read(db, 'res.partner', partner_id) : null;
        if (!p?.name) throw new Error('A customer name is required');
      } else if (preset.identification === 'address') {
        const p = partner_id ? read(db, 'res.partner', partner_id) : null;
        const hasAddress = Boolean(p && (p.street || p.city || p.contact_address || p.zip));
        if (!hasAddress) throw new Error('Customer address is required');
      }
    }
  }
  const total = amounts(lines);
  const rounding = config?.cash_rounding && config?.rounding_method_id ? read(db, 'account.cash.rounding', config.rounding_method_id) : null;

  const rawPayments = payments ?? [{ payment_method_id: method, amount: total.total }];
  const isCash = rawPayments.some((p) => {
    if (p.payment_method_id) {
      return read(db, 'pos.payment.method', p.payment_method_id)?.type === 'cash';
    }
    return p.method === 'cash';
  });
  const shouldRound = Boolean(rounding && (!config?.only_round_cash_method || isCash));
  const expectedTotal = shouldRound ? cashRound(total.total, rounding.rounding, rounding.rounding_method) : round(total.total);
  const roundingDiff = shouldRound ? round(expectedTotal - total.total) : 0;

  const recordPayments = (payments ?? [{ payment_method_id: method, amount: expectedTotal }]).map((p) => ({ ...p, payment_method_id: Number(p.payment_method_id) || null }));
  const useRecords = recordPayments.some((p) => p.payment_method_id);
  if (useRecords) {
    for (const p of recordPayments) {
      const m = read(db, 'pos.payment.method', p.payment_method_id);
      if (!m || m.active === false || (m.company_id ?? 1) !== (session.company_id ?? 1) || (resolvedConfigId && m.config_ids?.length && !m.config_ids.includes(resolvedConfigId))) throw new Error('Invalid payment method');
      if (m.type === 'pay_later' && !partner_id) throw new Error('A customer is required for pay later');
      if (!(Number(p.amount) > 0)) throw new Error('Invalid payment amount');
      if (m.type !== 'pay_later' && !read(db, 'account.journal', m.journal_id)) throw new Error('Payment journal is required');
    }
    if (round(recordPayments.reduce((s, p) => s + Number(p.amount), 0)) !== round(expectedTotal)) throw new Error('The payments must add up to the order total');
  }
  const split = (payments ?? []).filter((p) => Number(p.amount) > 0).map((p) => ({ method: p.method === 'cash' ? 'cash' : 'bank', amount: round(Number(p.amount)) }));
  if (split.length && round(split.reduce((s, p) => s + p.amount, 0)) !== round(expectedTotal)) throw new Error('The payments must add up to the order total');
  const { db: next, id } = create(db, 'pos.order', {
    partner_id,
    payment_method: useRecords ? (read(db, 'pos.payment.method', recordPayments[0].payment_method_id).type === 'cash' ? 'cash' : 'card') : method,
    ...(useRecords ? { payment_method_id: recordPayments[0].payment_method_id, payment_ids: recordPayments, config_id: resolvedConfigId } : {}),
    lines,
    session_id: session.id,
    state: refund_of ? 'refund' : 'paid',
    refund_of,
    preset_id: preset_id ?? null,
    rounding_difference: roundingDiff,
    ...(!useRecords && split.length ? { payment_ids: split } : {}),
  });
  const name = read(next, 'pos.order', id).name;
  const sign = refund_of ? -1 : 1;
  let stocked = next;
  const costs = [];
  for (const [index, l] of lines.entries()) {
    const p = read(stocked, 'product', l.product_id);
    if (p?.type !== 'goods' || !l.qty) continue;
    const qty = lineToStockQty(stocked, l, p);
    if (!refund_of && p.valuation !== 'manual_periodic') {
      const out = deliver(stocked, p.id, qty, { reference: name });
      stocked = out.db;
      costs.push({ index, unit_cost: out.value / qty });
    } else {
      const unit_cost = original?.stock_costs?.find((c) => c.index === index)?.unit_cost ?? p.cost;
      stocked = moveValued(stocked, [{ ...l, qty, unit_cost }], -sign, { reference: name, counterpart: '500000' });
    }
  }
  stocked = write(stocked, 'pos.order', id, { stock_costs: costs });
  if (round(total.total) === 0) return { db: stocked, id };
  if (useRecords) {
    const sale = invoiceLines(stocked, { move_type: refund_of ? 'out_refund' : 'out_invoice', partner_id, fiscal_position_id: fiscalPositionFor(db, partner_id), name, invoice_line_ids: lines.map((l) => ({ ...l, tax_cash_basis: false })) });
    const counterpart = (db.records['account.account'] ?? []).find((a) => a.code === '121000')?.id;
    const profitAcc = (rounding?.profit_account_id && read(db, 'account.account', rounding.profit_account_id)?.code) || '450000';
    const lossAcc = (rounding?.loss_account_id && read(db, 'account.account', rounding.loss_account_id)?.code) || '690000';
    const saleLines = [
      ...sale.filter((l) => l.account_id !== counterpart),
      ...recordPayments.map((p) => ({ account_id: read(db, 'pos.payment.method', p.payment_method_id).receivable_account_id || counterpart, partner_id, debit: refund_of ? 0 : Number(p.amount), credit: refund_of ? Number(p.amount) : 0 })),
    ];
    if (roundingDiff !== 0) {
      const isProfit = (refund_of ? -roundingDiff : roundingDiff) > 0;
      const acc = isProfit ? profitAcc : lossAcc;
      const amt = Math.abs(roundingDiff);
      saleLines.push(isProfit ? { account: acc, credit: amt, partner_id, name: 'Cash Rounding' } : { account: acc, debit: amt, partner_id, name: 'Cash Rounding' });
    }
    let booked = postEntry(stocked, { journal: 'POSS', ref: name, lines: saleLines.map((l) => ({ ...l, account: l.account ?? read(stocked, 'account.account', l.account_id)?.code })) }).db;
    for (const p of recordPayments) {
      const m = read(booked, 'pos.payment.method', p.payment_method_id);
      if (m.type === 'pay_later') continue;
      const journal = read(booked, 'account.journal', m.journal_id);
      const account = read(booked, 'account.account', m.outstanding_account_id || journal.default_account_id)?.code;
      const receivable = read(booked, 'account.account', m.receivable_account_id)?.code ?? '121000';
      if (!account) throw new Error('Payment account is required');
      const amount = Number(p.amount);
      booked = postEntry(booked, { journal: journal.code, ref: name, lines: refund_of ? [{ account, credit: amount, partner_id }, { account: receivable, debit: amount, partner_id }] : [{ account, debit: amount, partner_id }, { account: receivable, credit: amount, partner_id }] }).db;
    }
    return { db: booked, id };
  }
  const { db: booked } = postEntry(stocked, { journal: 'POSS', ref: name, lines: (original && reversalEntry(db, original, { partner_id })) ?? saleEntry(stocked, lines, { method, split, partner_id, refund: !!refund_of }) });
  return { db: booked, id };
}

/** Durable retry identity is stored with the booking; a changed catalog never reprices an already-paid cart. */
export function payCart(db, { cart = [], method, payments = null, partner_id = null, request_key = null, config_id = null, preset_id = null }) {
  const normalized = cart.map((l) => ({ product_id: Number(l.product_id), qty: Number(l.qty), discount: Number(l.discount ?? 0), ...(l.uom_id ? { uom_id: Number(l.uom_id) } : {}) }));
  const fingerprint = JSON.stringify([normalized, method, payments, partner_id, config_id, preset_id]);
  if (request_key !== null && (typeof request_key !== 'string' || !/^[\w:-]{8,200}$/.test(request_key))) throw new Error('Invalid payment request key');
  const prior = request_key && search(db, 'pos.order').find((o) => o.request_key === request_key);
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new Error('This request key was already used for a different payment');
    return { db, id: prior.id };
  }
  const preset = preset_id ? read(db, 'pos.preset', Number(preset_id)) : null;
  const lines = priceLines(db, normalized, partner_id, { pricelistId: preset?.pricelist_id ?? null, fiscalPositionId: preset?.fiscal_position_id ?? null });
  const out = payOrder(db, { lines, method, payments, partner_id, config_id: Number(config_id) || null, preset_id: Number(preset_id) || null });
  return request_key ? { ...out, db: write(out.db, 'pos.order', out.id, { request_key, request_fingerprint: fingerprint }) } : out;
}

/** Refund a paid order in full (stock comes back, money goes out the way it came in). */
export function refundOrder(db, order) {
  if (order.state !== 'paid') throw new Error('Only paid orders can be refunded');
  if (search(db, 'pos.order').some((o) => o.refund_of === order.id)) throw new Error('This order was already refunded');
  const { db: next, id } = payOrder(db, { lines: order.lines, method: order.payment_method_id ?? order.payment_method, payments: order.payment_ids?.length ? order.payment_ids : null, partner_id: order.partner_id, refund_of: order.id, config_id: order.config_id, preset_id: order.preset_id });
  return { db: write(next, 'pos.order', order.id, { state: 'refunded' }), id };
}

/** Session totals by payment method (refunds negative) and the cash expected in the drawer. */
export function sessionTotals(db, session) {
  const orders = search(db, 'pos.order').filter((o) => o.session_id === session.id);
  const sum = (method) => round(orders.reduce((s, o) => s + (o.state === 'refund' ? -1 : 1) * tendersOf(o, db).filter((t) => t.method === method).reduce((a, t) => a + t.amount, 0), 0));
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
    journal: 'POSS', ref: `${session.name} cash difference`,
    lines: difference > 0 ? [{ account: CASH, debit: difference }, { account: '450000', credit: difference }] : [{ account: '690000', debit: -difference }, { account: CASH, credit: -difference }],
  }).db : db;
  return write(booked, 'pos.session', session.id, { state: 'closed', stop_at: today(), total_cash: cash, total_card: card, cash_expected: expected, cash_end: counted, cash_difference: difference });
}

export const posModels = {
  'pos.session': {
    label: 'Sessions',
    fields: {
      name: { type: 'char', label: 'Session', readonly: true },
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
