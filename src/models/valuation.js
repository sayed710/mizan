// Stock valuation and physical inventory over warehouse-wide product quantities.
import { create, getActiveCompany, postNote, read, search, setActiveCompany, write } from '../orm.js';
import { nextName, today } from './common.js';
import { accountId, postEntry } from './ledger.js';
import { moveStock, salesModels } from './sales.js';
import { allocateCents, round } from '../money.js';
import { productProperty } from './productconfig-helpers.js';

const layers = (db, id) => search(db, 'stock.valuation.layer').filter((l) => l.product_id === id);
const quantity = (ls) => ls.reduce((s, l) => s + l.quantity, 0);
const valueOf = (ls) => round(ls.reduce((s, l) => s + l.value, 0));
// Product totals are shared across companies; scoped valuation must consume only that company's stock.
const stockQuantity = (db, p) => {
  const company = getActiveCompany();
  const qs = (db.records['stock.quant'] ?? []).filter((q) => q.product_id === p.id);
  if (company && qs.length) return qs.filter((q) => (q.company_id ?? 1) === company).reduce((s, q) => s + q.quantity, 0);
  if (company && company !== (p.company_id ?? 1)) return 0;
  return Number(p.qty_available) || 0;
};
const product = (db, id) => {
  const p = read(db, 'product', id);
  if (!p || p.type !== 'goods') throw new Error('Select a stockable product');
  return p;
};
const nonnegative = (n, label) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`${label} must be a nonnegative number`);
};

function prepare(db, id, date) {
  const p = product(db, id);
  const parsed = new Date(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Enter a valid valuation date');
  const ls = layers(db, id);
  if (ls.some((l) => l.date > date)) throw new Error('Valuation date cannot precede an existing layer');
  const owned = stockQuantity(db, p) + Number(p.qty_rented || 0);
  if (ls.length && Math.abs(quantity(ls) - owned) > 1e-8) throw new Error('Stock changed outside valuation; reconcile quantities first');
  if (ls.length || !stockQuantity(db, p)) return db;
  if (stockQuantity(db, p) < 0) throw new Error('Reconcile negative opening stock before valuation');
  return openingStock(db, [id], date);
}

const OPENING_EQUITY = '301000';

/**
 * Value stock that exists without layers (seeded, imported or typed in) as opening layers, and post their value
 * once to the stock account against opening equity so the valuation report and the ledger agree.
 */
function openingStock(db, ids, date) {
  let next = db;
  const opened = [];
  for (const id of ids) {
    const p = product(next, id);
    const qty = stockQuantity(next, p);
    const value = round(qty * (Number(p.cost) || 0));
    const res = create(next, 'stock.valuation.layer', {
      product_id: id, date: '0001-01-01', quantity: qty, unit_cost: Number(p.cost) || 0,
      value, remaining_qty: qty, remaining_value: value, kind: 'adjustment',
      description: 'Opening stock', reference: 'Opening stock', opening: true,
    });
    next = res.db;
    if (!['manual_periodic', 'periodic'].includes(productProperty(next, p, 'property_valuation')) && value) opened.push({ id: res.id, value, account: read(next, 'account.account', productProperty(next, p, 'property_stock_valuation_account_id'))?.code || '110100', journal: read(next, 'account.journal', productProperty(next, p, 'property_stock_journal'))?.code || 'MISC' });
  }
  if (!accountId(next, OPENING_EQUITY)) return next;
  const groups = new Map();
  for (const item of opened) { const key = JSON.stringify([item.account, item.journal]); groups.set(key, [...(groups.get(key) ?? []), item]); }
  for (const items of groups.values()) {
    const total = round(items.reduce((s, item) => s + item.value, 0));
    if (!total || !accountId(next, items[0].account)) continue;
    const entry = postEntry(next, { journal: items[0].journal, date, ref: 'Opening stock', lines: [{ account: items[0].account, debit: total }, { account: OPENING_EQUITY, credit: total }] });
    next = items.reduce((acc, item) => write(acc, 'stock.valuation.layer', item.id, { move_id: entry.id }), entry.db);
  }
  return next;
}

/** Open (and post) the stock of every stockable product that has quantities but no valuation layers yet. */
export function postOpeningStock(db, date = today()) {
  const ids = search(db, 'product').filter((p) => p.type === 'goods' && Number(p.qty_available) > 0 && !layers(db, p.id).length).map((p) => p.id);
  return ids.length ? openingStock(db, ids, date) : db;
}

/** Product costing policy; categories are free text, so policy lives on the product. */
export function costMethod(db, productId) {
  const method = productProperty(db, product(db, productId), 'property_cost_method') ?? 'standard';
  if (!['standard', 'average', 'fifo'].includes(method)) throw new Error('Select a valid costing method');
  return method;
}

/** Post a layer once; periodic valuation creates no entry, and opening layers are posted when they are opened. */
export function postValuation(db, layerId) {
  const l = read(db, 'stock.valuation.layer', layerId);
  if (!l) throw new Error('Valuation layer not found');
  if (l.move_id || l.opening || ['manual_periodic', 'periodic'].includes(productProperty(db, product(db, l.product_id), 'property_valuation'))) return db;
  const diff = Number(l.price_difference) || 0;
  if (!l.value && !diff) return db;
  const line = (account, amount) => ({ account, ...(amount >= 0 ? { debit: amount } : { credit: -amount }) });
  const counterpart = l.counterpart || (l.kind === 'in' ? '110200' : l.kind === 'out' ? '500000' : '600000');
  const p = product(db, l.product_id);
  const stockAccount = read(db, 'account.account', productProperty(db, p, 'property_stock_valuation_account_id'))?.code || '110100';
  const lines = [line(stockAccount, l.value), line(counterpart, -round(l.value + diff)), ...(diff ? [line('600000', diff)] : [])];
  if (lines.some((x) => !accountId(db, x.account))) throw new Error('Configure stock valuation accounts first');
  const journal = read(db, 'account.journal', productProperty(db, p, 'property_stock_journal'))?.code || 'MISC';
  const entry = postEntry(db, { journal, date: l.date, ref: l.reference || l.description, lines });
  return write(entry.db, 'stock.valuation.layer', l.id, { move_id: entry.id });
}

function addLayer(db, vals) {
  // Unset options stay out of the record so saved data round-trips through JSON.
  const result = create(db, 'stock.valuation.layer', Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== undefined)));
  return postValuation(result.db, result.id);
}

/**
 * Receive and increase stock. Standard costing always values at the standard price and books the gap to the
 * actual cost (purchase price, production cost, refund cost) as a variance, so the standard never drifts.
 */
export function receive(db, productId, qty, unitCost, { date = today(), reference = '', counterpart, pickingId, stockLine } = {}) {
  nonnegative(qty, 'Quantity');
  nonnegative(unitCost, 'Unit cost');
  if (!qty) throw new Error('Receive a positive quantity');
  let next = prepare(db, productId, date);
  const p = product(next, productId);
  const method = costMethod(next, productId);
  const standard = method === 'standard';
  const cost = standard ? Number(p.cost) || 0 : unitCost;
  const value = round(qty * cost);
  const onHand = stockQuantity(next, p);
  if (!standard) next = write(next, 'product', productId, {
    cost: method === 'average' ? (valueOf(layers(next, productId)) + value) / (onHand + qty) : unitCost,
  });
  next = moveStock(next, [{ ...stockLine, product_id: productId, qty }], 1);
  return addLayer(next, { product_id: productId, date, reference, description: reference || 'Receipt',
    quantity: qty, unit_cost: cost, value, remaining_qty: qty, remaining_value: value,
    price_difference: standard ? round(qty * unitCost) - value : 0, kind: 'in', counterpart, picking_id: pickingId });
}

function consume(db, productId, qty, method) {
  const p = product(db, productId);
  if (qty > stockQuantity(db, p) + 1e-8) throw new Error('Not enough stock to deliver');
  const available = layers(db, productId).filter((l) => l.remaining_qty > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  let next = db;
  let left = qty;
  let value = 0;
  let weight = 0;
  const onHand = stockQuantity(db, p);
  const remainingValue = round(available.reduce((s, l) => s + l.remaining_value, 0));
  const target = Math.abs(qty - onHand) < 1e-8 ? remainingValue : round(qty * (Number(p.cost) || 0));
  for (const [i, l] of available.entries()) {
    const take = method === 'fifo' ? Math.min(left, l.remaining_qty) : l.remaining_qty * qty / onHand;
    weight += remainingValue ? l.remaining_value / remainingValue : l.remaining_qty / onHand;
    const amount = method !== 'fifo'
      ? round((i === available.length - 1 ? target : round(target * weight)) - value)
      : take >= l.remaining_qty - 1e-8 ? l.remaining_value : round(l.remaining_value * take / l.remaining_qty);
    next = write(next, 'stock.valuation.layer', l.id, { remaining_qty: Math.max(0, l.remaining_qty - take), remaining_value: round(l.remaining_value - amount) });
    value += amount;
    left -= take;
    if (method === 'fifo' && left <= 1e-8) break;
  }
  return { db: next, value: round(value) };
}

/** Deliver at FIFO/average/standard cost; insufficient stock is refused, including negative stock. */
export function deliver(db, productId, qty, { date = today(), reference = '', counterpart, pickingId, stockLine } = {}) {
  nonnegative(qty, 'Quantity');
  if (!qty) throw new Error('Deliver a positive quantity');
  const next = prepare(db, productId, date);
  const method = costMethod(next, productId);
  const used = consume(next, productId, qty, method);
  const value = used.value;
  const stocked = moveStock(used.db, [{ ...stockLine, product_id: productId, qty }], -1);
  return { db: addLayer(stocked, { product_id: productId, date, reference, description: reference || 'Delivery',
    quantity: -qty, unit_cost: value / qty, value: -value, kind: 'out', counterpart, picking_id: pickingId }), value };
}

/** Move goods once, retaining quantity-only behavior for periodic products. */
export function moveValued(db, lines, sign, options = {}) {
  return lines.reduce((next, l) => {
    const p = read(next, 'product', l.product_id);
    const qty = Number(l.qty) || 0;
    if (!p || p.type !== 'goods' || !qty || !sign) return next;
    if (['manual_periodic', 'periodic'].includes(productProperty(next, p, 'property_valuation'))) {
      // Periodic products carry no cost layers, but on-hand quantities still cannot go negative.
      if (sign < 0 && qty * -sign > (Number(p.qty_available) || 0) + 1e-8) throw new Error('Not enough stock to deliver');
      return moveStock(next, [{ ...l, ...options.stockLine, picking_id: options.pickingId ?? options.stockLine?.picking_id ?? l.picking_id }], sign);
    }
    const spec = { ...options, ...l.valuation_options, stockLine: { ...l, ...options.stockLine } };
    return sign > 0 ? receive(next, p.id, qty, l.unit_cost ?? p.cost ?? 0, spec) : deliver(next, p.id, qty, spec).db;
  }, db);
}

/** Capitalize an already-posted additional cost without posting it twice. */
export function capitalizeStock(db, productId, amount, { date = today(), reference = '', moveId } = {}) {
  nonnegative(amount, 'Additional cost');
  amount = round(amount);
  let next = prepare(db, productId, date);
  const p = product(next, productId);
  const remaining = layers(next, productId).filter((l) => l.remaining_qty > 0);
  if (!(p.qty_available > 0)) throw new Error('Stock is required to capitalize additional costs');
  const shares = remaining.length ? allocateCents(amount, remaining.map((l) => l.remaining_qty)) : [];
  for (const [i, l] of remaining.entries()) {
    next = write(next, 'stock.valuation.layer', l.id, { remaining_value: round(l.remaining_value + shares[i]) });
  }
  next = write(next, 'product', p.id, { cost: round((Number(p.cost) || 0) + amount / p.qty_available) });
  return create(next, 'stock.valuation.layer', { product_id: p.id, date, reference, description: reference,
    quantity: 0, value: amount, unit_cost: 0, kind: 'landed', move_id: moveId }).db;
}

/** Set on-hand value to quantity times the new cost without rewriting historical layer values. */
export function revalue(db, productId, newUnitCost, { date = today() } = {}) {
  nonnegative(newUnitCost, 'Unit cost');
  let next = prepare(db, productId, date);
  const qty = Number(product(next, productId).qty_available) || 0;
  const target = round(qty * newUnitCost);
  const ls = layers(next, productId);
  const remaining = ls.filter((l) => l.remaining_qty > 0);
  const oldValue = remaining.reduce((s, l) => s + l.remaining_value, 0);
  let allocated = 0;
  let weight = 0;
  for (const [i, l] of remaining.entries()) {
    weight += oldValue ? l.remaining_value / oldValue : l.remaining_qty / qty;
    const value = i === remaining.length - 1 ? round(target - allocated)
      : round(round(target * weight) - allocated);
    allocated += value;
    next = write(next, 'stock.valuation.layer', l.id, { remaining_value: value });
  }
  next = write(next, 'product', productId, { cost: newUnitCost });
  return addLayer(next, { product_id: productId, date, quantity: 0, unit_cost: newUnitCost,
    value: round(target - valueOf(ls)), description: 'Stock revaluation', kind: 'revaluation' });
}

/** Per-product layer totals at a date, including implicit legacy opening stock until first valued. */
export function valuationReport(db, { at = today() } = {}) {
  return Object.fromEntries(search(db, 'product').filter((p) => p.type === 'goods').map((p) => {
    const all = layers(db, p.id);
    const ls = all.filter((l) => l.date <= at);
    const qty = all.length ? quantity(ls) : Number(p.qty_available) || 0;
    const value = all.length ? valueOf(ls) : round(qty * (Number(p.cost) || 0));
    return [p.id, { qty, value, unitCost: qty ? value / qty : 0 }];
  }));
}

/** Snapshot selected goods for a physical inventory, defaulting counted quantities to theoretical. */
export function startCount(db, { productIds, date = today() } = {}) {
  const ids = productIds ?? search(db, 'product').filter((p) => p.type === 'goods').map((p) => p.id);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Select distinct stockable products');
  const line_ids = ids.map((id) => {
    const p = product(db, id);
    return { product_id: id, theoretical_qty: Number(p.qty_available) || 0, counted_qty: Number(p.qty_available) || 0 };
  });
  return create(db, 'stock.inventory.count', { name: nextName(db, 'stock.inventory.count', 'INV/'), date, line_ids, state: 'in_progress' });
}

/** Apply inventory gains/losses once; intervening stock movements require a fresh count. */
/** Set a product's on-hand quantity as a one-line physical inventory, so the change is valued and posted. */
export function adjustQuantity(db, productId, newQty, { date = today(), reference } = {}) {
  const started = startCount(db, { productIds: [productId], date });
  const count = read(started.db, 'stock.inventory.count', started.id);
  const counted = write(started.db, 'stock.inventory.count', started.id, {
    ...(reference ? { name: reference } : {}),
    line_ids: count.line_ids.map((l) => ({ ...l, counted_qty: Number(newQty) })),
  });
  return applyCount(counted, started.id);
}

/**
 * A scanner count of one product: refuses when the stock moved since `observed` was read, and books the count,
 * valuation layer and journal entry under `company` (the one the counter works in), not the default company.
 */
export function countProduct(db, { productId, counted, observed, company }) {
  const p = product(db, productId);
  if (observed != null && Number(observed) !== p.qty_available) throw new Error(`Stock of ${p.name} changed to ${p.qty_available} since you started counting; scan it again`);
  const before = p.qty_available;
  setActiveCompany(company);
  try {
    return postNote(adjustQuantity(db, productId, counted), 'product', productId, `Inventory adjustment: ${before} → ${counted}`);
  } finally {
    setActiveCompany(null);
  }
}

export function applyCount(db, countId, { stockLine, pickingId } = {}) {
  const count = read(db, 'stock.inventory.count', countId);
  if (!count || count.state !== 'in_progress') throw new Error('Only an inventory in progress can be applied');
  if (!count.line_ids.length || new Set(count.line_ids.map((l) => l.product_id)).size !== count.line_ids.length) throw new Error('Select distinct stockable products');
  let next = db;
  for (const l of count.line_ids) {
    nonnegative(l.counted_qty, 'Counted quantity');
    if (product(next, l.product_id).qty_available !== l.theoretical_qty) throw new Error('Stock changed since this count started; start a fresh count');
    next = prepare(next, l.product_id, count.date);
    const difference = l.counted_qty - l.theoretical_qty;
    if (!difference) continue;
    const p = product(next, l.product_id);
    let value = round(difference * (Number(p.cost) || 0));
    if (difference < 0) {
      const used = consume(next, p.id, -difference, costMethod(next, p.id));
      next = used.db;
      value = -used.value;
    }
    next = moveStock(next, [{ ...stockLine, product_id: p.id, qty: difference }], 1);
    next = addLayer(next, { product_id: p.id, date: count.date, reference: count.name, description: 'Physical inventory',
      quantity: difference, unit_cost: value / difference, value, kind: 'adjustment', picking_id: pickingId,
      remaining_qty: Math.max(0, difference), remaining_value: difference > 0 ? value : 0 });
  }
  return write(next, 'stock.inventory.count', countId, { state: 'done' });
}

const number = (label, readonly = false) => ({ type: 'float', label, readonly });
const money = (label) => ({ type: 'monetary', label, readonly: true });
const relation = (model, label) => ({ type: 'many2one', relation: model, label });

export const valuationModels = {
  get product() {
    return {
    ...salesModels.product,
    fields: {
      ...salesModels.product.fields,
      cost_method: { type: 'selection', label: 'Costing Method', options: [['standard', 'Standard Price'], ['average', 'Average Cost'], ['fifo', 'FIFO']] },
      valuation: { type: 'selection', label: 'Inventory Valuation', options: [['manual_periodic', 'Manual Periodic'], ['real_time', 'Automated']] },
    },
    defaults: (id) => ({ ...salesModels.product.defaults?.(id), cost_method: 'standard', valuation: 'real_time' }),
    form: { ...salesModels.product.form, groups: [...salesModels.product.form.groups, ['cost_method', 'valuation']] },
    };
  },
  'stock.valuation.layer': {
    label: 'Stock Valuation',
    fields: {
      product_id: { ...relation('product', 'Product'), required: true },
      date: { type: 'date', label: 'Date' }, quantity: number('Quantity', true), unit_cost: money('Unit Cost'), value: money('Value'),
      remaining_qty: number('Remaining Quantity', true), remaining_value: money('Remaining Value'),
      description: { type: 'char', label: 'Description' }, picking_id: relation('stock.picking', 'Transfer'),
      reference: { type: 'char', label: 'Reference' }, move_id: { ...relation('account.move', 'Journal Entry'), readonly: true },
      price_difference: money('Price Difference'), opening: { type: 'boolean', label: 'Opening Balance', readonly: true },
      kind: { type: 'selection', label: 'Kind', options: [['in', 'Receipt'], ['out', 'Delivery'], ['adjustment', 'Inventory Adjustment'], ['revaluation', 'Revaluation'], ['landed', 'Landed Cost']] },
    },
    defaults: () => ({ date: today(), remaining_qty: 0, remaining_value: 0 }),
    guard: (db, before, layer) => before && ['product_id', 'company_id', 'picking_id', 'date', 'quantity', 'value', 'unit_cost', 'kind', 'opening'].some((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(layer[key] ?? null)) ? 'Stock valuation history cannot be changed' : null,
    protectDelete: () => 'Stock valuation history cannot be deleted',
    list: ['date', 'product_id', 'quantity', 'unit_cost', 'value', 'remaining_qty', 'remaining_value', 'reference', 'move_id'],
    form: { title: 'description', lockedWhen: () => true, groups: [['product_id', 'date', 'kind', 'reference', 'picking_id'], ['quantity', 'unit_cost', 'value', 'remaining_qty', 'remaining_value', 'move_id']] },
  },
  'stock.inventory.count': {
    label: 'Physical Inventory',
    fields: {
      name: { type: 'char', label: 'Reference', required: true }, date: { type: 'date', label: 'Date' },
      line_ids: { type: 'one2many', label: 'Inventory Lines', fields: {
        product_id: relation('product', 'Product'), theoretical_qty: number('Theoretical Quantity', true), counted_qty: number('Counted Quantity'),
        difference: { ...number('Difference', true), compute: (r) => Number(r.counted_qty) - Number(r.theoretical_qty) },
      }, newLine: () => ({ product_id: null, theoretical_qty: 0, counted_qty: 0 }) },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['in_progress', 'In Progress'], ['done', 'Done']] },
    },
    defaults: (id) => ({ name: `INV/${String(id).padStart(5, '0')}`, date: today(), state: 'draft', line_ids: [] }),
    list: ['date', 'name', 'state'],
    form: { title: 'name', statusbar: 'state', lockedWhen: (r) => r.state === 'done', groups: [['date']], tabs: [{ label: 'Count', fields: ['line_ids'] }], chatter: true,
      buttons: [
        { label: 'Start Count', primary: true, when: (r) => r.state === 'draft', run: (db, r) => {
          const ids = r.line_ids.length ? r.line_ids.map((l) => l.product_id) : search(db, 'product').filter((p) => p.type === 'goods').map((p) => p.id);
          if (new Set(ids).size !== ids.length) throw new Error('Select distinct stockable products');
          const line_ids = ids.map((id) => { const p = product(db, id); return { product_id: id, theoretical_qty: p.qty_available, counted_qty: p.qty_available }; });
          return { db: write(db, 'stock.inventory.count', r.id, { state: 'in_progress', line_ids }) };
        } },
        { label: 'Apply', primary: true, when: (r) => r.state === 'in_progress', run: (db, r) => ({ db: applyCount(db, r.id) }) },
      ],
    },
  },
};
