// Transfer operations: availability/reservation, validation of done quantities with backorders, and returns.
import { create, getActiveCompany, read, search, write } from '../orm.js';
import { today } from './common.js';
import { lineToStockQty } from './uom.js';
import { defaultStockLocationId } from './stock-location.js';

const doneQty = (l) => (l.quantity == null || l.quantity === '' ? Number(l.qty) || 0 : Number(l.quantity) || 0);
const isGoods = (db, l) => read(db, 'product', l.product_id)?.type === 'goods';

/** Free default-location stock after reservations in the active company. */
export function freeQty(db, productId, exceptPickingId = null, exceptMoId = null) {
  const company = getActiveCompany() ?? db.settings?.current_company_id ?? 1;
  const location = defaultStockLocationId(db, company);
  const quants = (db.records['stock.quant'] ?? []).filter((q) => q.product_id === productId);
  const onHand = quants.length ? quants.filter((q) => (q.company_id ?? 1) === company && q.location_id === location).reduce((sum, q) => sum + q.quantity, 0)
    : company === (read(db, 'product', productId)?.company_id ?? 1) ? Number(read(db, 'product', productId)?.qty_available) || 0 : 0;
  if (quants.length) {
    const allocation = quantReservationMap(db, productId, company, { exceptPickingId, exceptMoId });
    const held = quants.filter((q) => (q.company_id ?? 1) === company && q.location_id === location).reduce((sum, q) => sum + (allocation.get(q.id) || 0), 0);
    return Math.min(onHand, Number(read(db, 'product', productId)?.qty_available) || 0) - held;
  }
  const reserved = (db.records['stock.picking'] ?? []).filter((p) => p.id !== exceptPickingId && (p.company_id ?? 1) === company && ['outgoing', 'internal'].includes(p.picking_type) && p.state === 'ready' && (p.location_id ?? location) === location)
    .flatMap((p) => p.move_ids ?? []).filter((m) => m.product_id === productId).reduce((sum, m) => sum + (Number(m.qty) || 0), 0);
  const components = (db.records['mrp.production'] ?? []).filter((mo) => mo.id !== exceptMoId && (mo.company_id ?? 1) === company && ['confirmed', 'progress'].includes(mo.state) && mo.components_availability === 'available')
    .flatMap((mo) => mo.move_raw ?? []).filter((m) => m.product_id === productId).reduce((sum, m) => sum + (Number(m.to_consume) || 0), 0);
  return Math.min(onHand, Number(read(db, 'product', productId)?.qty_available) || 0) - reserved - components;
}

/** Assign each open reservation once to matching company, location and lot quants. */
export function quantReservationMap(db, productId, company, { exceptPickingId = null, exceptMoId = null } = {}) {
  const product = read(db, 'product', productId);
  const defaultLocation = defaultStockLocationId(db, company);
  const quants = (db.records['stock.quant'] ?? []).filter((q) => q.product_id === productId && (q.company_id ?? 1) === company).sort((a, b) => a.id - b.id);
  const reserved = new Map(quants.map((q) => [q.id, 0]));
  const demands = [];
  for (const picking of db.records['stock.picking'] ?? []) {
    if (picking.id === exceptPickingId || (picking.company_id ?? 1) !== company || picking.state !== 'ready' || !['outgoing', 'internal'].includes(picking.picking_type)) continue;
    for (const line of picking.move_ids ?? []) if (line.product_id === productId) demands.push({ qty: Number(line.qty) || 0, location: picking.location_id ?? defaultLocation, lot: ['lot', 'serial'].includes(product?.tracking) ? line.lot_name : null });
  }
  for (const mo of db.records['mrp.production'] ?? []) {
    if (mo.id === exceptMoId || (mo.company_id ?? 1) !== company || !['confirmed', 'progress'].includes(mo.state) || mo.components_availability !== 'available') continue;
    for (const line of mo.move_raw ?? []) if (line.product_id === productId) demands.push({ qty: Number(line.to_consume) || 0, location: defaultLocation, lot: null });
  }
  demands.sort((a, b) => Number(!!b.lot) - Number(!!a.lot));
  for (const demand of demands) {
    let left = demand.qty;
    for (const q of quants) {
      if ((demand.location && q.location_id !== demand.location) || (demand.lot && read(db, 'stock.lot', q.lot_id)?.name !== demand.lot)) continue;
      const take = Math.min(left, Math.max(0, q.quantity - reserved.get(q.id)));
      reserved.set(q.id, reserved.get(q.id) + take); left -= take;
      if (left <= 1e-8) break;
    }
  }
  return reserved;
}

/** Free stock for a specific transfer, respecting company, source location and lot. */
function freeForPicking(db, picking, productId, lotName) {
  const company = picking.company_id ?? getActiveCompany() ?? 1;
  const product = read(db, 'product', productId);
  if (!['lot', 'serial'].includes(product?.tracking)) lotName = null;
  const all = (db.records['stock.quant'] ?? []).filter((q) => q.product_id === productId);
  const defaultLocation = defaultStockLocationId(db, company);
  const source = picking.location_id ?? defaultLocation;
  if (!all.length) {
    if (source !== defaultLocation || lotName) return 0;
    return freeQty(db, productId, picking.id);
  }
  const reserved = quantReservationMap(db, productId, company, { exceptPickingId: picking.id });
  return all.filter((q) => (q.company_id ?? 1) === company && q.location_id === source && (!lotName || read(db, 'stock.lot', q.lot_id)?.name === lotName))
    .reduce((sum, q) => sum + q.quantity - (reserved.get(q.id) || 0), 0);
}

/** Quantities on MTO moves must be supplied by this sale's own procurement. */
function procurementAvailable(db, picking, line) {
  if (!picking.sale_id || picking.return_of || !['outgoing', 'internal'].includes(picking.picking_type) || !Number.isInteger(line.so_line)) return Infinity;
  const order = read(db, 'sale.order', picking.sale_id);
  const saleLine = order?.order_line?.[line.so_line];
  const product = read(db, 'product', line.product_id);
  const route = line.procurement_route ?? product?.route;
  if (!saleLine || !['mto_buy', 'mto_make'].includes(route)) return Infinity;
  const supplied = route === 'mto_buy'
    ? (db.records['purchase.order'] ?? []).filter((po) => po.sale_id === order.id && po.state === 'purchase').flatMap((po) => po.order_line ?? [])
      .filter((l) => l.so_line === line.so_line && l.product_id === product.id)
      .reduce((sum, l) => sum + lineToStockQty(db, { ...l, qty: Number(l.qty_delivered) || 0 }, product), 0)
    : (db.records['mrp.production'] ?? []).filter((mo) => mo.sale_id === order.id && mo.so_line === line.so_line && mo.state === 'done').reduce((sum, mo) => sum + Number(mo.product_qty || 0), 0);
  const delivered = lineToStockQty(db, { ...saleLine, qty: Number(saleLine.qty_delivered) || 0 }, product);
  return Math.max(0, supplied - delivered);
}

/** Allocate constrained lots first, then unrestricted demand from the same product balance. */
function pickingShortage(db, picking, moveLines) {
  const demands = new Map();
  for (const l of moveLines.filter((l) => isGoods(db, l))) {
    const lotName = ['lot', 'serial'].includes(read(db, 'product', l.product_id)?.tracking) ? l.lot_name : null;
    const key = `${l.product_id}|${lotName || ''}`;
    const demand = demands.get(key) ?? { product_id: l.product_id, lot_name: lotName, qty: 0 };
    demand.qty += Number(l.qty) || 0; demands.set(key, demand);
  }
  const lines = [...demands.values()].sort((a, b) => Number(!!b.lot_name) - Number(!!a.lot_name));
  const remaining = new Map();
  let allocated = 0, short = null;
  for (const line of lines) {
    if (!remaining.has(line.product_id)) remaining.set(line.product_id, Math.max(0, freeForPicking(db, picking, line.product_id, null)));
    const free = line.lot_name ? Math.min(remaining.get(line.product_id), Math.max(0, freeForPicking(db, picking, line.product_id, line.lot_name))) : remaining.get(line.product_id);
    const take = Math.min(Math.max(0, line.qty), free);
    remaining.set(line.product_id, remaining.get(line.product_id) - take);
    allocated += take;
    if (line.qty > take + 1e-8 && !short) short = line;
  }
  return { short, allocated };
}

/** Availability for outgoing and internal transfers at their source. */
export function pickingAvailability(db, picking) {
  if (!['outgoing', 'internal'].includes(picking.picking_type)) return 'available';
  if ((picking.move_ids ?? []).some((l) => Number(l.qty) > procurementAvailable(db, picking, l) + 1e-8)) return 'none';
  const { short, allocated } = pickingShortage(db, picking, picking.move_ids ?? []);
  return !short ? 'available' : allocated > 0 ? 'partial' : 'none';
}

/** Mark as To Do / Check Availability: ready when the stock is there, otherwise waiting. */
export function reservePicking(db, picking) {
  if (!['draft', 'waiting', 'ready'].includes(picking.state)) throw new Error('Only open transfers can be reserved');
  if (!(picking.move_ids ?? []).length) throw new Error('Add at least one product to the transfer');
  return write(db, 'stock.picking', picking.id, { state: pickingAvailability(db, picking) === 'available' ? 'ready' : 'waiting' });
}

/**
 * Validate with the done quantities (a line's `quantity`, else its demand). Anything left becomes a backorder
 * transfer when `backorder` is true; otherwise the rest is dropped. Returns { db, done, backorderId }.
 * `apply(db, picking, sign)` moves stock and may return { db, move_ids } to supply updated done lines.
 */
export function validatePicking(db, picking, { backorder = true, apply, date = today() }) {
  if (!['ready', 'waiting', 'draft'].includes(picking.state)) throw new Error('This transfer is already processed');
  const lines = picking.move_ids ?? [];
  const done = lines.map((l) => ({ ...l, qty: doneQty(l) })).filter((l) => l.qty > 0);
  if (!done.length) throw new Error('Set the quantities done before validating (or cancel the transfer)');
  if (lines.some((l) => doneQty(l) < 0)) throw new Error('Quantities cannot be negative');
  if (done.some((l) => l.qty > procurementAvailable(db, picking, l) + 1e-8)) throw new Error('The order replenishment must be received or produced before delivery');
  const rest = lines.map((l) => ({ ...l, qty: (Number(l.qty) || 0) - doneQty(l), quantity: null })).filter((l) => l.qty > 0);
  const sign = picking.picking_type === 'incoming' ? 1 : picking.picking_type === 'outgoing' ? -1 : 0;
  // Stock reserved for other transfers or manufacturing orders cannot be shipped by this one.
  if (sign < 0 || picking.picking_type === 'internal') {
    const { short } = pickingShortage(db, picking, done);
    if (short && short.lot_name && ['lot', 'serial'].includes(read(db, 'product', short.product_id)?.tracking) && !(db.records['stock.lot'] ?? []).some((lot) => lot.name === short.lot_name && lot.product_id === short.product_id && (lot.company_id ?? 1) === (picking.company_id ?? 1))) throw new Error(`Lot ${short.lot_name} is not in stock`);
    if (short) throw new Error(`Not enough free stock for ${read(db, 'product', short.product_id)?.name ?? 'a product'}: the rest is reserved for other operations`);
  }
  const applied = apply(db, { ...picking, move_ids: done }, sign);
  const appliedDone = applied.move_ids ?? done;
  let next = write(applied.db ?? applied, 'stock.picking', picking.id, {
    state: 'done', date_done: date, move_ids: appliedDone.map(({ quantity, ...l }) => l),
  });
  let backorderId = null;
  if (rest.length && backorder) {
    const res = create(next, 'stock.picking', {
      company_id: picking.company_id ?? 1, picking_type: picking.picking_type, partner_id: picking.partner_id ?? null, origin: picking.origin ?? '', scheduled_date: picking.scheduled_date ?? date,
      sale_id: picking.sale_id ?? null, purchase_id: picking.purchase_id ?? null, carrier_id: picking.carrier_id ?? null,
      location_id: picking.location_id ?? null, location_dest_id: picking.location_dest_id ?? null, backorder_id: picking.id, return_of: picking.return_of ?? null, move_ids: rest, state: 'draft',
    });
    next = reservePicking(res.db, read(res.db, 'stock.picking', res.id));
    backorderId = res.id;
  }
  return { db: next, done: appliedDone, backorderId };
}

const lotKey = (l) => `${l.product_id}|${l.lot_name ?? ''}`;

/** Per product, what a done transfer still has to return: its quantities minus those of its other returns. */
export function returnableQty(db, picking) {
  const left = new Map();
  for (const l of picking.move_ids ?? []) left.set(l.product_id, (left.get(l.product_id) ?? 0) + (Number(l.qty) || 0));
  for (const l of returnsOf(db, picking).flatMap((p) => p.move_ids ?? [])) left.set(l.product_id, (left.get(l.product_id) ?? 0) - (Number(l.qty) || 0));
  return left;
}
const returnsOf = (db, picking) => search(db, 'stock.picking').filter((p) => p.return_of === picking.id && p.state !== 'cancel');

/**
 * Reverse a done transfer: what is not returned yet, the other way, ready to process. It stays linked to the
 * order, so validating it takes the quantities back off the order's delivered quantities.
 */
export function returnPicking(db, picking) {
  if (picking.state !== 'done') throw new Error('Only done transfers can be returned');
  if (picking.return_of) throw new Error('A return cannot be returned; create a new transfer instead');
  const left = returnableQty(db, picking);
  // What earlier returns took, by product and lot, so a lot that was returned is not offered again.
  const byLot = new Map();
  for (const l of returnsOf(db, picking).flatMap((p) => p.move_ids ?? [])) byLot.set(lotKey(l), (byLot.get(lotKey(l)) ?? 0) + (Number(l.qty) || 0));
  const move_ids = (picking.move_ids ?? []).map((l) => {
    const free = Math.max(0, (Number(l.qty) || 0) - (byLot.get(lotKey(l)) ?? 0));
    byLot.set(lotKey(l), Math.max(0, (byLot.get(lotKey(l)) ?? 0) - (Number(l.qty) || 0)));
    const qty = Math.max(0, Math.min(free, left.get(l.product_id) ?? 0));
    left.set(l.product_id, (left.get(l.product_id) ?? 0) - qty);
    return { product_id: l.product_id, qty, lot_name: l.lot_name ?? '', lot_id: l.lot_id ?? null, ...(Number.isInteger(l.so_line) ? { so_line: l.so_line } : {}), ...(Number.isInteger(l.po_line) ? { po_line: l.po_line } : {}) };
  }).filter((l) => l.qty > 0);
  if (!move_ids.length) throw new Error('Everything in this transfer has already been returned');
  const type = picking.picking_type === 'dropship' ? 'dropship' : picking.picking_type === 'outgoing' ? 'incoming' : picking.picking_type === 'incoming' ? 'outgoing' : 'internal';
  const res = create(db, 'stock.picking', {
    company_id: picking.company_id ?? 1, picking_type: type, partner_id: picking.partner_id ?? null, origin: `Return of ${picking.name}`, scheduled_date: today(),
    location_id: picking.location_dest_id ?? null, location_dest_id: picking.location_id ?? null, return_of: picking.id,
    sale_id: picking.sale_id ?? null, purchase_id: picking.purchase_id ?? null, move_ids, state: 'draft',
  });
  return { db: reservePicking(res.db, read(res.db, 'stock.picking', res.id)), id: res.id };
}
