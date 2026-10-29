// Reordering rules (stock.warehouse.orderpoint) for automated and manual replenishment.
import { create, read, search, write } from '../orm.js';
import { addDays, pad, today } from './common.js';
import { vendorPrice } from './routes.js';
import { ensureMainWarehouse } from './warehouse.js';

export function childLocationIds(db, rootLocationId) {
  const ids = new Set([rootLocationId]);
  const all = db.records['stock.location'] ?? [];
  let size;
  do {
    size = ids.size;
    for (const l of all) {
      if (ids.has(l.parent_id)) ids.add(l.id);
    }
  } while (size !== ids.size);
  return ids;
}

/** Total on-hand quantity for this rule's product from internal quants at location and children. */
export function getOnHand(db, op) {
  const childIds = childLocationIds(db, op.location_id);
  const internalLocs = new Set(
    [...childIds].filter((id) => read(db, 'stock.location', id)?.usage === 'internal'),
  );
  const prodQuants = (db.records['stock.quant'] ?? []).filter((q) => q.product_id === op.product_id);
  if (!prodQuants.length) {
    const wh = op.warehouse_id ? read(db, 'stock.warehouse', op.warehouse_id) : null;
    if (!wh || op.location_id === wh.lot_stock_id) {
      const p = read(db, 'product', op.product_id);
      return Number(p?.qty_available) || 0;
    }
    return 0;
  }
  const quants = prodQuants.filter(
    (q) =>
      internalLocs.has(q.location_id) &&
      (!op.company_id || !q.company_id || q.company_id === op.company_id),
  );
  return quants.reduce((sum, q) => sum + (Number(q.quantity) || 0), 0);
}

/** Forecast quantity = on hand + incoming confirmed receipts or MOs - outgoing reserved or confirmed deliveries. */
export function getForecast(db, op) {
  const onHand = getOnHand(db, op);
  const childIds = childLocationIds(db, op.location_id);
  const wh = op.warehouse_id ? read(db, 'stock.warehouse', op.warehouse_id) : null;
  const isWhStockLoc = wh && wh.lot_stock_id === op.location_id;

  // Incoming confirmed receipts (stock.picking incoming in waiting/ready)
  const incomingPickings = (db.records['stock.picking'] ?? []).filter((p) => {
    if (p.picking_type !== 'incoming' || !['waiting', 'ready'].includes(p.state)) return false;
    if (op.company_id && p.company_id && p.company_id !== op.company_id) return false;
    return childIds.has(p.location_dest_id) || (isWhStockLoc && (p.warehouse_id === op.warehouse_id || !p.location_dest_id));
  });
  let incomingReceiptQty = 0;
  for (const p of incomingPickings) {
    for (const m of p.move_ids ?? []) {
      if (m.product_id === op.product_id) incomingReceiptQty += Number(m.qty) || 0;
    }
  }

  // Incoming confirmed manufacturing orders (mrp.production in confirmed/progress)
  const incomingMos = (db.records['mrp.production'] ?? []).filter((mo) => {
    if (mo.product_id !== op.product_id || !['confirmed', 'progress'].includes(mo.state)) return false;
    if (op.company_id && mo.company_id && mo.company_id !== op.company_id) return false;
    return true;
  });
  const incomingMoQty = incomingMos.reduce((sum, mo) => sum + (Number(mo.product_qty) || 0), 0);

  // Outgoing reserved or confirmed deliveries (stock.picking outgoing in waiting/ready)
  const outgoingPickings = (db.records['stock.picking'] ?? []).filter((p) => {
    if (p.picking_type !== 'outgoing' || !['waiting', 'ready'].includes(p.state)) return false;
    if (op.company_id && p.company_id && p.company_id !== op.company_id) return false;
    return childIds.has(p.location_id) || (isWhStockLoc && (p.warehouse_id === op.warehouse_id || !p.location_id));
  });
  let outgoingDeliveryQty = 0;
  for (const p of outgoingPickings) {
    for (const m of p.move_ids ?? []) {
      if (m.product_id === op.product_id) outgoingDeliveryQty += Number(m.qty) || 0;
    }
  }

  return onHand + incomingReceiptQty + incomingMoQty - outgoingDeliveryQty;
}

/** How much brings forecast up to max, rounded up to vendor min quantity or packaging. */
export function computeQtyToOrder(db, op) {
  const forecast = getForecast(db, op);
  const min = Number(op.product_min_qty) || 0;
  const max = Math.max(Number(op.product_max_qty) || 0, min);
  if (forecast >= min) return 0;

  let needed = max - forecast;

  // Vendor minimum quantity check
  const suppliers = (db.records['product.supplierinfo'] ?? []).filter((s) => s.product_id === op.product_id);
  const prod = read(db, 'product', op.product_id);
  if (suppliers.length > 0) {
    let vendorMin = 0;
    if (prod?.vendor_id) {
      const match = suppliers.find((s) => s.partner_id === prod.vendor_id);
      vendorMin = Number(match?.min_qty) || 0;
    }
    if (!vendorMin) {
      vendorMin = Math.min(...suppliers.map((s) => Number(s.min_qty) || 0));
    }
    if (vendorMin > 0) needed = Math.max(needed, vendorMin);
  }

  // Packaging rounding check
  const packagings = (db.records['product.packaging'] ?? [])
    .filter((pk) => pk.product_id === op.product_id && Number(pk.qty) > 0)
    .sort((a, b) => Number(a.qty) - Number(b.qty));
  if (packagings.length > 0) {
    const packQty = Number(packagings[0].qty);
    needed = Math.ceil(needed / packQty) * packQty;
  }

  return needed;
}

/** Execute ordering for a set of orderpoint IDs (Buy or Manufacture). */
export function orderOrderpoints(db, ids) {
  let next = db;
  for (const id of ids) {
    const op = read(next, 'stock.warehouse.orderpoint', id);
    if (!op || op.active === false) continue;
    const qty = op.qty_to_order_manual != null && op.qty_to_order_manual !== ''
      ? Number(op.qty_to_order_manual)
      : computeQtyToOrder(next, op);
    if (!(qty > 0)) continue;

    const prod = read(next, 'product', op.product_id);
    const route = op.route_id || (prod?.route === 'mto_make' ? 'manufacture' : 'buy');

    if (route === 'manufacture') {
      const bom = search(next, 'mrp.bom').find((b) => b.product_id === op.product_id);
      if (!bom) throw new Error(`${prod?.name || 'Product'}: create a bill of materials to manufacture`);
      next = create(next, 'mrp.production', {
        product_id: op.product_id,
        bom_id: bom.id,
        product_qty: qty,
        state: 'draft',
        origin: 'Replenishment',
        company_id: op.company_id ?? 1,
      }).db;
    } else {
      // Buy route: creates or extends draft RFQ for the vendor
      const suppliers = search(next, 'product.supplierinfo').filter((s) => s.product_id === op.product_id);
      let best = vendorPrice(next, op.product_id, { qty });
      if (!best && !prod?.vendor_id && suppliers.length > 0) {
        const minSupp = Math.min(...suppliers.map((s) => Number(s.min_qty) || 0));
        best = vendorPrice(next, op.product_id, { qty: Math.max(qty, minSupp) });
      }
      const vendor = best?.partner_id ?? prod?.vendor_id;
      if (!vendor) continue; // no valid vendor

      const priceUnit = best?.price ?? (Number(prod?.cost) || 0);
      const tax = prod?.purchase_tax ?? 14;

      // Check for existing draft RFQ to extend/merge
      const existingRfq = search(next, 'purchase.order').find(
        (po) => po.partner_id === vendor && po.state === 'draft' && po.origin === 'Replenishment' && (!op.company_id || po.company_id === op.company_id),
      );

      if (existingRfq) {
        const lines = [...(existingRfq.order_line ?? [])];
        const lineIdx = lines.findIndex((l) => l.product_id === op.product_id);
        if (lineIdx >= 0) {
          const line = lines[lineIdx];
          const newQty = Math.max(Number(line.qty) || 0, qty);
          const newPrice = vendorPrice(next, op.product_id, { partnerId: vendor, qty: newQty })?.price ?? line.price_unit;
          lines[lineIdx] = { ...line, qty: newQty, price_unit: newPrice };
        } else {
          lines.push({ product_id: op.product_id, qty, price_unit: priceUnit, tax });
        }
        const vals = {
          order_line: lines,
          ...(existingRfq.origin ? {} : { origin: 'Replenishment' }),
        };
        next = write(next, 'purchase.order', existingRfq.id, vals);
      } else {
        next = create(next, 'purchase.order', {
          partner_id: vendor,
          order_line: [{ product_id: op.product_id, qty, price_unit: priceUnit, tax }],
          origin: 'Replenishment',
          company_id: op.company_id ?? 1,
        }).db;
      }
    }

    // Clear manual quantity after ordering
    next = write(next, 'stock.warehouse.orderpoint', op.id, { qty_to_order_manual: null });
  }
  return next;
}

/** Snooze orderpoints until a specific duration or date. */
export function snoozeOrderpoint(db, ids, duration = '1_day', at = today()) {
  let until;
  if (duration === '1_day' || duration === '1 day' || duration === 1) {
    until = addDays(at, 1);
  } else if (duration === '1_week' || duration === '1 week' || duration === 7) {
    until = addDays(at, 7);
  } else if (duration === '1_month' || duration === '1 month' || duration === 30) {
    until = addDays(at, 30);
  } else if (typeof duration === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(duration)) {
    until = duration;
  } else {
    until = addDays(at, 1);
  }
  return ids.reduce((d, id) => write(d, 'stock.warehouse.orderpoint', id, { snoozed_until: until }), db);
}

/** Switch manual orderpoints to auto. */
export function automateOrderpoint(db, ids) {
  return ids.reduce((d, id) => write(d, 'stock.warehouse.orderpoint', id, { trigger: 'auto' }), db);
}

/** Ensure an orderpoint exists for a product with legacy reorder_min/max on the main warehouse stock location. */
export function syncProductOrderpoint(db, prod) {
  const min = Number(prod.reorder_min) || 0;
  const max = Number(prod.reorder_max) || 0;
  if (min <= 0 && max <= 0) return db;

  let next = ensureMainWarehouse(db);
  const wh = search(next, 'stock.warehouse').find((w) => w.code === 'WH') ?? search(next, 'stock.warehouse')[0];
  if (!wh?.lot_stock_id) return next;

  // Find any existing quant for this product in this company
  const anyQuant = (next.records['stock.quant'] ?? []).find(
    (q) => q.product_id === prod.id && (q.company_id ?? 1) === (prod.company_id ?? 1),
  );

  let locId = wh.lot_stock_id;
  if (anyQuant) {
    locId = anyQuant.location_id;
    if (prod.qty_available != null && anyQuant.quantity !== Number(prod.qty_available)) {
      next = write(next, 'stock.quant', anyQuant.id, { quantity: Number(prod.qty_available) });
    }
  } else if (prod.qty_available != null) {
    next = create(next, 'stock.quant', {
      product_id: prod.id,
      location_id: locId,
      quantity: Number(prod.qty_available),
      company_id: prod.company_id ?? 1,
    }).db;
  }

  const existing = (next.records['stock.warehouse.orderpoint'] ?? []).find(
    (o) => o.product_id === prod.id && o.location_id === locId && (o.company_id ?? 1) === (prod.company_id ?? 1),
  );

  const bom = search(next, 'mrp.bom').find((b) => b.product_id === prod.id);
  const route = prod.route === 'mto_make' || bom ? 'manufacture' : 'buy';

  if (!existing) {
    const seq = (next.seq?.['stock.warehouse.orderpoint'] ?? 0) + 1;
    next = create(next, 'stock.warehouse.orderpoint', {
      name: `OP/${pad(seq)}`,
      product_id: prod.id,
      warehouse_id: wh.id,
      location_id: locId,
      product_min_qty: min,
      product_max_qty: Math.max(max, min),
      trigger: 'auto',
      route_id: route,
      company_id: prod.company_id ?? 1,
      active: true,
    }).db;
  } else {
    next = write(next, 'stock.warehouse.orderpoint', existing.id, {
      product_min_qty: min,
      product_max_qty: Math.max(max, min),
    });
  }
  return next;
}

/** Migrate all legacy product reorder_min/reorder_max fields to warehouse orderpoints. */
export function migrateOrderpoints(db) {
  let next = ensureMainWarehouse(db);
  const goods = (next.records.product ?? []).filter(
    (p) => p.type === 'goods' && ((Number(p.reorder_min) || 0) > 0 || (Number(p.reorder_max) || 0) > 0),
  );
  for (const p of goods) {
    next = syncProductOrderpoint(next, p);
  }
  // Clear legacy fields on products
  if (goods.length > 0) {
    const updated = (next.records.product ?? []).map((p) => {
      if (p.reorder_min == null && p.reorder_max == null) return p;
      const { reorder_min, reorder_max, ...rest } = p;
      return rest;
    });
    next = { ...next, records: { ...next.records, product: updated } };
  }
  return next;
}

export const orderpointModels = {
  'stock.warehouse.orderpoint': {
    label: 'Reordering Rules',
    fields: {
      name: { type: 'char', label: 'Orderpoint', readonly: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      warehouse_id: { type: 'many2one', relation: 'stock.warehouse', label: 'Warehouse', required: true },
      location_id: { type: 'many2one', relation: 'stock.location', label: 'Location', required: true },
      product_min_qty: { type: 'float', label: 'Min Quantity', required: true },
      product_max_qty: { type: 'float', label: 'Max Quantity', required: true },
      daily_demand: { type: 'float', label: 'Daily Demand' },
      min_max_based_on: {
        type: 'selection',
        label: 'Based On',
        options: [
          ['one_week', 'One Week'],
          ['one_month', 'One Month'],
          ['three_months', 'Three Months'],
          ['one_year', 'One Year'],
          ['custom', 'Custom'],
        ],
      },
      min_max_based_on_factor: { type: 'float', label: 'Based on Factor' },
      replenishment_uom_id: {
        type: 'many2one',
        relation: 'uom.uom',
        label: 'Unit of Measure',
        readonly: true,
        compute: (r, db) => read(db, 'product', r.product_id)?.uom_id ?? null,
      },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', readonly: true },
      route_id: {
        type: 'selection',
        label: 'Route',
        options: [
          ['buy', 'Buy'],
          ['manufacture', 'Manufacture'],
        ],
      },
      trigger: {
        type: 'selection',
        label: 'Trigger',
        options: [
          ['auto', 'Auto'],
          ['manual', 'Manual'],
        ],
      },
      active: { type: 'boolean', label: 'Active' },
      snoozed_until: { type: 'date', label: 'Snoozed Until' },
      deadline_date: { type: 'date', label: 'Deadline' },
      qty_to_order_computed: {
        type: 'float',
        label: 'To Order (to max)',
        readonly: true,
        compute: (r, db) => computeQtyToOrder(db, r),
      },
      qty_to_order_manual: { type: 'float', label: 'To Order (Manual)' },
      qty_to_order: {
        type: 'float',
        label: 'Quantity to Order',
        readonly: true,
        compute: (r, db) =>
          r.qty_to_order_manual != null && r.qty_to_order_manual !== ''
            ? Number(r.qty_to_order_manual)
            : computeQtyToOrder(db, r),
      },
      qty_on_hand: {
        type: 'float',
        label: 'On Hand',
        readonly: true,
        compute: (r, db) => getOnHand(db, r),
      },
      qty_forecast: {
        type: 'float',
        label: 'Forecast',
        readonly: true,
        compute: (r, db) => getForecast(db, r),
      },
    },
    defaults: (id, db) => {
      const wh = db ? search(db, 'stock.warehouse').find((w) => w.code === 'WH') ?? search(db, 'stock.warehouse')[0] : null;
      return {
        name: `OP/${pad(id)}`,
        trigger: 'auto',
        active: true,
        product_min_qty: 0,
        product_max_qty: 0,
        daily_demand: 0,
        min_max_based_on: 'custom',
        min_max_based_on_factor: 1,
        qty_to_order_manual: null,
        warehouse_id: wh?.id ?? 1,
        location_id: wh?.lot_stock_id ?? null,
        route_id: 'buy',
        company_id: db ? (db.settings?.current_company_id ?? 1) : 1,
      };
    },
    onchange: (r, key, db) => {
      if (key === 'product_id' && r.product_id) {
        const p = read(db, 'product', r.product_id);
        const bom = search(db, 'mrp.bom').find((b) => b.product_id === r.product_id);
        const route = p?.route === 'mto_make' || bom ? 'manufacture' : 'buy';
        return {
          route_id: route,
          replenishment_uom_id: p?.uom_id ?? null,
        };
      }
      return {};
    },
    guard: (db, before, r) => {
      if (read(db, 'product', r.product_id)?.type !== 'goods') return 'Select a stockable product';
      const loc = read(db, 'stock.location', r.location_id);
      if (!loc || loc.usage !== 'internal' || (r.company_id && loc.company_id && loc.company_id !== r.company_id)) {
        return 'Select an internal location in the same company';
      }
      if (!read(db, 'stock.warehouse', r.warehouse_id)) return 'Select an existing warehouse';
      if (!Number.isFinite(Number(r.product_min_qty)) || Number(r.product_min_qty) < 0) return 'Min quantity must be a nonnegative number';
      if (!Number.isFinite(Number(r.product_max_qty)) || Number(r.product_max_qty) < 0) return 'Max quantity must be a nonnegative number';
      const duplicate = (db.records['stock.warehouse.orderpoint'] ?? []).find(
        (op) =>
          op.id !== r.id &&
          op.product_id === r.product_id &&
          op.location_id === r.location_id &&
          (op.company_id ?? 1) === (r.company_id ?? 1),
      );
      if (duplicate) return 'A reordering rule already exists for this product and location';
      return null;
    },
    list: [
      'product_id',
      'qty_on_hand',
      'qty_forecast',
      'route_id',
      'trigger',
      'product_min_qty',
      'product_max_qty',
      'replenishment_uom_id',
      'qty_to_order_computed',
      'qty_to_order_manual',
      'deadline_date',
    ],
    editableList: ['qty_to_order_manual', 'product_min_qty', 'product_max_qty', 'route_id', 'trigger'],
    groupBys: ['warehouse_id', 'location_id', 'product_id', 'trigger'],
    filters: [
      [
        { id: 'manual', label: 'Trigger: Manual', fn: (r) => r.trigger === 'manual' },
        { id: 'auto', label: 'Trigger: Auto', fn: (r) => r.trigger === 'auto' },
      ],
      [
        {
          id: 'to_reorder',
          label: 'To Reorder',
          fn: (r) =>
            r.qty_to_order_manual != null && r.qty_to_order_manual !== ''
              ? Number(r.qty_to_order_manual) > 0
              : r.qty_to_order_computed > 0 || r.qty_forecast < r.product_min_qty,
        },
      ],
      [
        { id: 'snoozed', label: 'Snoozed', fn: (r) => Boolean(r.snoozed_until && r.snoozed_until > today()) },
        { id: 'not_snoozed', label: 'Not Snoozed', fn: (r) => !r.snoozed_until || r.snoozed_until <= today() },
      ],
    ],
    defaultFilters: ['not_snoozed'],
    listActions: [
      { label: 'Order', run: (db, ids) => orderOrderpoints(db, ids) },
      { label: 'Automate', run: (db, ids) => automateOrderpoint(db, ids) },
      { label: 'Snooze', run: (db, ids, duration) => snoozeOrderpoint(db, ids, duration) },
      {
        label: 'Forecast Report',
        run: (db, ids) => {
          const first = ids?.length === 1 ? read(db, 'stock.warehouse.orderpoint', ids[0]) : null;
          return {
            db,
            go: first ? `#/inventory/report?product_id=${first.product_id}` : '#/inventory/report',
          };
        },
      },
    ],
    form: {
      title: 'name',
      groups: [
        ['product_id', 'location_id', 'warehouse_id', 'route_id', 'trigger', 'active'],
        ['product_min_qty', 'product_max_qty', 'qty_to_order_manual', 'deadline_date', 'snoozed_until'],
        ['qty_on_hand', 'qty_forecast', 'qty_to_order_computed', 'qty_to_order', 'replenishment_uom_id'],
      ],
      buttons: [
        { label: 'Order', primary: true, run: (db, r) => ({ db: orderOrderpoints(db, [r.id]) }) },
        { label: 'Automate', when: (r) => r.trigger === 'manual', run: (db, r) => ({ db: automateOrderpoint(db, [r.id]) }) },
        {
          label: 'Snooze',
          ask: [{ label: 'Snooze for (1 day, 1 week, 1 month, or YYYY-MM-DD)', default: () => '1 day' }],
          run: (db, r, [duration]) => ({ db: snoozeOrderpoint(db, [r.id], duration || '1 day') }),
        },
        { label: 'Forecast Report', run: (db, r) => ({ db, go: `#/inventory/report?product_id=${r.product_id}` }) },
      ],
      chatter: true,
    },
  },
};
