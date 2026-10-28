// Procurement routes (make-to-order buy/manufacture, dropship), storage locations and landed costs.
import { create, read, search, write } from '../orm.js';
import { today } from './common.js';
import { postEntry } from './ledger.js';
import { capitalizeStock } from './valuation.js';
import { round } from '../money.js';


/**
 * On sale confirmation, apply each product's route:
 * - stock (default): served from stock by the delivery order;
 * - mto_buy: an RFQ to the product vendor for the missing quantity;
 * - mto_make: a manufacturing order (with the product's BoM) for the missing quantity;
 * - dropship: an RFQ to the vendor shipped straight to the customer (no delivery from our stock).
 * Returns { db, stockLines } where stockLines still go through our warehouse.
 */
export function procure(db, order) {
  let next = db;
  const stockLines = [];
  const rfqs = new Map(); // vendor → lines, for MTO buy and dropship (kept separate)
  for (const line of order.order_line ?? []) {
    const p = read(next, 'product', line.product_id);
    if (!p || p.type !== 'goods') { stockLines.push(line); continue; }
    const route = p.route ?? 'stock';
    const missing = Math.max(0, (Number(line.qty) || 0) - Math.max(0, Number(p.qty_available) || 0));
    if (route === 'dropship') {
      if (!p.vendor_id) throw new Error(`${p.name}: set a vendor to dropship`);
      const key = `drop:${p.vendor_id}`;
      rfqs.set(key, [...(rfqs.get(key) ?? []), { product_id: p.id, qty: line.qty, price_unit: p.cost, tax: 14 }]);
      continue;
    }
    stockLines.push(line);
    if (!missing) continue;
    if (route === 'mto_buy') {
      if (!p.vendor_id) throw new Error(`${p.name}: set a vendor to buy on order`);
      const key = `buy:${p.vendor_id}`;
      rfqs.set(key, [...(rfqs.get(key) ?? []), { product_id: p.id, qty: missing, price_unit: p.cost, tax: 14 }]);
    } else if (route === 'mto_make') {
      const bom = search(next, 'mrp.bom').find((b) => b.product_id === p.id);
      if (!bom) throw new Error(`${p.name}: create a bill of materials to manufacture on order`);
      next = create(next, 'mrp.production', { product_id: p.id, bom_id: bom.id, product_qty: missing, state: 'draft', origin: order.name }).db;
    }
  }
  for (const [key, lines] of rfqs) {
    const [kind, vendor] = key.split(':');
    next = create(next, 'purchase.order', {
      partner_id: Number(vendor), order_line: lines, origin: order.name,
      dropship_partner_id: kind === 'drop' ? order.partner_id : null,
    }).db;
  }
  return { db: next, stockLines };
}

/** Best vendor pricelist line for a product: valid dates, min quantity, then sequence and price. */
export function vendorPrice(db, productId, { partnerId, qty = 1, date = today() } = {}) {
  const info = search(db, 'product.supplierinfo').filter((s) => s.product_id === productId && (!partnerId || s.partner_id === partnerId)
    && Number(s.min_qty ?? 0) <= qty && (!s.date_start || s.date_start <= date) && (!s.date_end || s.date_end >= date))
    .sort((a, b) => Number(a.sequence ?? 10) - Number(b.sequence ?? 10) || Number(a.price) - Number(b.price) || a.id - b.id)[0];
  return info ? { price: Number(info.price), delay: Number(info.delay ?? 0), partner_id: info.partner_id } : null;
}

/**
 * Reordering rules: a bought product whose forecast (on hand + quantities on open RFQs/POs not yet received)
 * falls below its minimum gets one draft RFQ line to its vendor up to the maximum (or the minimum).
 */
export function replenish(db) {
  const incoming = new Map();
  for (const po of search(db, 'purchase.order').filter((p) => p.state !== 'cancel' && !p.receipt_done && !p.dropship_partner_id)) {
    for (const l of po.order_line ?? []) incoming.set(l.product_id, (incoming.get(l.product_id) ?? 0) + (Number(l.qty) || 0) - (Number(l.qty_delivered) || 0));
  }
  const suppliers = (id) => search(db, 'product.supplierinfo').filter((s) => s.product_id === id);
  const needs = search(db, 'product').filter((p) => p.type === 'goods' && (p.vendor_id || suppliers(p.id).length) && p.purchase_ok !== false && Number(p.reorder_min) > 0)
    .map((p) => {
      const forecast = (Number(p.qty_available) || 0) + (incoming.get(p.id) ?? 0);
      const target = Math.max(Number(p.reorder_max) || 0, Number(p.reorder_min));
      return forecast < Number(p.reorder_min) ? { p, qty: target - forecast } : null;
    }).filter(Boolean);
  const byVendor = new Map();
  // A vendor pricelist line wins over the product's default vendor and cost.
  for (const n of needs) {
    let qty = n.qty;
    let best = vendorPrice(db, n.p.id, { qty });
    if (!best && !n.p.vendor_id) {
      // Without a default vendor, order up to the smallest vendor minimum quantity.
      qty = Math.max(qty, Math.min(...suppliers(n.p.id).map((s) => Number(s.min_qty) || 0)));
      best = vendorPrice(db, n.p.id, { qty });
    }
    const vendor = best?.partner_id ?? n.p.vendor_id;
    if (!vendor) continue; // only out-of-date pricelist lines: nothing valid to order from
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), { product_id: n.p.id, qty, price_unit: best?.price ?? n.p.cost, tax: n.p.purchase_tax ?? 14 }]);
  }
  return [...byVendor].reduce((acc, [vendor, lines]) => create(acc, 'purchase.order', { partner_id: vendor, order_line: lines, origin: 'Replenishment' }).db, db);
}

/** Distribute landed costs over the received products by quantity and raise their (average) cost. */
export function applyLandedCost(db, lc) {
  if (lc.state === 'done') throw new Error('These landed costs are already posted');
  const picking = read(db, 'stock.picking', lc.picking_id);
  if (!picking || picking.state !== 'done' || picking.picking_type !== 'incoming') throw new Error('Select a validated receipt');
  const total = (lc.cost_lines ?? []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const units = (picking.move_ids ?? []).reduce((s, m) => s + (Number(m.qty) || 0), 0);
  if (!(total > 0) || !(units > 0)) throw new Error('Nothing to allocate');
  let allocated = 0;
  const allocations = picking.move_ids.map((m, i) => {
    const amount = i === picking.move_ids.length - 1 ? round(total - allocated) : round(total * Number(m.qty) / units);
    allocated = round(allocated + amount);
    return { ...m, amount };
  });
  const automated = allocations.filter((m) => {
    const p = read(db, 'product', m.product_id);
    return p?.type === 'goods' && p.valuation !== 'manual_periodic';
  }).reduce((s, m) => s + m.amount, 0);
  const entry = automated ? postEntry(db, {
    journal: 'MISC', ref: `Landed costs ${picking.name}`,
    lines: [{ account: '110100', debit: automated }, { account: '211000', credit: automated }],
  }) : { db, id: null };
  let next = entry.db;
  for (const m of allocations) {
    const p = read(next, 'product', m.product_id);
    if (!p) continue;
    const share = m.amount;
    const onHand = Math.max(Number(p.qty_available) || 0, Number(m.qty) || 0);
    next = p.type === 'goods' && p.valuation !== 'manual_periodic'
      ? capitalizeStock(next, p.id, share, { reference: `Landed costs ${picking.name}`, moveId: entry.id })
      : write(next, 'product', p.id, { cost: round((Number(p.cost) || 0) + share / onHand) });
  }
  return write(next, 'stock.landed.cost', lc.id, { state: 'done', amount_total: total });
}

/** On-hand per location from validated transfers that carry locations (incoming adds to dest, outgoing removes from source). */
export function locationStock(db, productId) {
  const by = new Map();
  for (const p of search(db, 'stock.picking').filter((x) => x.state === 'done')) {
    for (const m of (p.move_ids ?? []).filter((x) => x.product_id === productId)) {
      if (p.location_dest_id) by.set(p.location_dest_id, (by.get(p.location_dest_id) ?? 0) + Number(m.qty));
      if (p.location_id) by.set(p.location_id, (by.get(p.location_id) ?? 0) - Number(m.qty));
    }
  }
  return [...by].filter(([, q]) => q !== 0).map(([location_id, qty]) => ({ location_id, qty }));
}

export const routeModels = {
  'stock.location': {
    label: 'Locations',
    fields: {
      name: { type: 'char', label: 'Location Name', required: true },
      parent_id: { type: 'many2one', relation: 'stock.location', label: 'Parent Location' },
      usage: { type: 'selection', label: 'Location Type', options: [['internal', 'Internal'], ['view', 'View'], ['transit', 'Transit'], ['inventory', 'Inventory Adjustment']] },
      barcode: { type: 'char', label: 'Barcode' },
    },
    defaults: () => ({ usage: 'internal' }),
    kanban: { title: 'name', lines: ['parent_id', 'usage'] },
    list: ['name', 'parent_id', 'usage', 'barcode'],
    form: { title: 'name', groups: [['parent_id', 'usage'], ['barcode']], chatter: true },
  },

  'stock.landed.cost': {
    label: 'Landed Costs',
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      picking_id: { type: 'many2one', relation: 'stock.picking', label: 'Receipt', required: true },
      date: { type: 'date', label: 'Date' },
      cost_lines: {
        type: 'one2many',
        label: 'Additional Costs',
        fields: { name: { type: 'char', label: 'Description' }, amount: { type: 'monetary', label: 'Cost' } },
        newLine: () => ({ name: 'Freight', amount: 0 }),
      },
      amount_total: { type: 'monetary', label: 'Total', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['done', 'Posted']] },
    },
    defaults: () => ({ date: today(), state: 'draft', cost_lines: [] }),
    kanban: { title: 'name', lines: ['picking_id', 'amount_total'], badge: 'state' },
    list: ['date', 'name', 'picking_id', 'amount_total', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'done',
      buttons: [{ label: 'Validate', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: applyLandedCost(db, r) }) }],
      title: 'name',
      groups: [['picking_id'], ['date', 'amount_total']],
      tabs: [{ label: 'Additional Costs', fields: ['cost_lines'] }],
      chatter: true,
    },
  },
};
