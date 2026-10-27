// Transfer operations: availability/reservation, validation of done quantities with backorders, and returns.
import { create, read, search, write } from '../orm.js';
import { today } from './common.js';

const doneQty = (l) => (l.quantity == null || l.quantity === '' ? Number(l.qty) || 0 : Number(l.quantity) || 0);
const isGoods = (db, l) => read(db, 'product', l.product_id)?.type === 'goods';

/**
 * Stock still free for a product: on hand minus what ready outgoing transfers and manufacturing orders
 * with available components already reserved (the picking or MO being checked excluded).
 * ponytail: one warehouse-wide figure; per-location reservation would need quants per location.
 */
export function freeQty(db, productId, exceptPickingId = null, exceptMoId = null) {
  const onHand = Number(read(db, 'product', productId)?.qty_available) || 0;
  const reserved = search(db, 'stock.picking')
    .filter((p) => p.id !== exceptPickingId && p.picking_type === 'outgoing' && p.state === 'ready')
    .flatMap((p) => p.move_ids ?? []).filter((m) => m.product_id === productId).reduce((s, m) => s + (Number(m.qty) || 0), 0);
  const components = search(db, 'mrp.production')
    .filter((mo) => mo.id !== exceptMoId && mo.state === 'confirmed' && mo.components_availability === 'available')
    .flatMap((mo) => mo.move_raw ?? []).filter((m) => m.product_id === productId).reduce((s, m) => s + (Number(m.to_consume) || 0), 0);
  return onHand - reserved - components;
}

/** 'available' when every goods line of an outgoing transfer is covered by free stock, else 'partial' or 'none'. */
export function pickingAvailability(db, picking) {
  if (picking.picking_type !== 'outgoing') return 'available';
  const lines = (picking.move_ids ?? []).filter((l) => isGoods(db, l));
  const covered = lines.filter((l) => freeQty(db, l.product_id, picking.id) >= (Number(l.qty) || 0)).length;
  if (covered === lines.length) return 'available';
  return lines.some((l) => freeQty(db, l.product_id, picking.id) > 0) ? 'partial' : 'none';
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
 * `apply(db, lines, sign)` moves the stock (lots, quantities); it is injected to keep this module free of sales logic.
 */
export function validatePicking(db, picking, { backorder = true, apply, date = today() }) {
  if (!['ready', 'waiting', 'draft'].includes(picking.state)) throw new Error('This transfer is already processed');
  const lines = picking.move_ids ?? [];
  const done = lines.map((l) => ({ ...l, qty: doneQty(l) })).filter((l) => l.qty > 0);
  if (!done.length) throw new Error('Set the quantities done before validating (or cancel the transfer)');
  if (lines.some((l) => doneQty(l) < 0)) throw new Error('Quantities cannot be negative');
  const rest = lines.map((l) => ({ ...l, qty: (Number(l.qty) || 0) - doneQty(l), quantity: null })).filter((l) => l.qty > 0);
  const sign = picking.picking_type === 'incoming' ? 1 : picking.picking_type === 'outgoing' ? -1 : 0;
  // Stock reserved for other transfers or manufacturing orders cannot be shipped by this one.
  if (sign < 0) {
    const short = done.find((l) => isGoods(db, l) && l.qty > freeQty(db, l.product_id, picking.id) + 1e-8);
    if (short) throw new Error(`Not enough free stock for ${read(db, 'product', short.product_id)?.name ?? 'a product'}: the rest is reserved for other operations`);
  }
  let next = write(apply(db, { ...picking, move_ids: done }, sign), 'stock.picking', picking.id, {
    state: 'done', date_done: date, move_ids: done.map(({ quantity, ...l }) => l),
  });
  let backorderId = null;
  if (rest.length && backorder) {
    const res = create(next, 'stock.picking', {
      picking_type: picking.picking_type, partner_id: picking.partner_id ?? null, origin: picking.origin ?? '', scheduled_date: picking.scheduled_date ?? date,
      sale_id: picking.sale_id ?? null, purchase_id: picking.purchase_id ?? null, carrier_id: picking.carrier_id ?? null,
      location_id: picking.location_id ?? null, location_dest_id: picking.location_dest_id ?? null, backorder_id: picking.id, move_ids: rest, state: 'draft',
    });
    next = reservePicking(res.db, read(res.db, 'stock.picking', res.id));
    backorderId = res.id;
  }
  return { db: next, done, backorderId };
}

/** Reverse a done transfer: same products and quantities the other way, ready to process. */
export function returnPicking(db, picking) {
  if (picking.state !== 'done') throw new Error('Only done transfers can be returned');
  const type = picking.picking_type === 'outgoing' ? 'incoming' : picking.picking_type === 'incoming' ? 'outgoing' : 'internal';
  const res = create(db, 'stock.picking', {
    picking_type: type, partner_id: picking.partner_id ?? null, origin: `Return of ${picking.name}`, scheduled_date: today(),
    location_id: picking.location_dest_id ?? null, location_dest_id: picking.location_id ?? null, return_of: picking.id,
    move_ids: (picking.move_ids ?? []).map((l) => ({ product_id: l.product_id, qty: Number(l.qty) || 0, lot_name: l.lot_name ?? '' })), state: 'draft',
  });
  return { db: reservePicking(res.db, read(res.db, 'stock.picking', res.id)), id: res.id };
}
