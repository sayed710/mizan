// Warehouse routes reuse transfer validation and boundary valuation.
import { create, read, search, write } from '../orm.js';
import { salesModels } from './sales.js';
import { validatePicking } from './picking.js';
import { canValidatePicking } from './qualityplus.js';
import { locationStock } from './routes.js';
import { lineToStockQty } from './uom.js';
import { pad } from './common.js';

const locations = [
  ['lot_stock_id', 'Stock'], ['wh_input_stock_loc_id', 'Input'],
  ['wh_qc_stock_loc_id', 'Quality Control'], ['wh_pack_stock_loc_id', 'Packing Zone'], ['wh_output_stock_loc_id', 'Output'],
];
const relation = (model, label) => ({ type: 'many2one', relation: model, label });
const warehouses = (db) => search(db, 'stock.warehouse', { includeArchived: true });
const warehouse = (db, id) => {
  const r = read(db, 'stock.warehouse', id);
  if (!r) throw new Error('Select an existing warehouse');
  return r;
};

/** Create each warehouse's internal locations once, reusing existing seed locations. */
export function ensureWarehouseLocations(db, warehouseId) {
  const wh = warehouse(db, warehouseId);
  let next = db;
  let root = search(next, 'stock.location').find((l) => l.name === wh.code && l.usage === 'view');
  if (!root) {
    const res = create(next, 'stock.location', { name: wh.code, usage: 'view' });
    next = res.db;
    root = read(next, 'stock.location', res.id);
  }
  const vals = {};
  for (const [field, label] of locations) {
    const existing = wh[field] && read(next, 'stock.location', wh[field]);
    if (existing) continue;
    let loc = search(next, 'stock.location').find((l) => l.name === `${wh.code}/${label}` && l.parent_id === root.id && l.usage === 'internal');
    if (!loc) {
      const res = create(next, 'stock.location', { name: `${wh.code}/${label}`, parent_id: root.id, usage: 'internal' });
      next = res.db;
      loc = read(next, 'stock.location', res.id);
    }
    vals[field] = loc.id;
  }
  return ensureExternalLocations(Object.keys(vals).length ? write(next, 'stock.warehouse', wh.id, vals) : next);
}

/** Ensure the main WH warehouse and its locations exist without changing legacy stock. */
export function ensureMainWarehouse(db) {
  const wh = warehouses(db).find((w) => w.code === 'WH');
  const res = wh ? { db, id: wh.id } : create(db, 'stock.warehouse', { name: 'Main Warehouse', code: 'WH' });
  return ensureWarehouseLocations(res.db, res.id);
}

function external(db, name) {
  return search(db, 'stock.location').find((l) => l.name === name && l.usage === 'view')?.id;
}

function checkLines(db, lines) {
  if (!lines?.length) throw new Error('Add at least one stockable product');
  for (const l of lines) {
    if (read(db, 'product', l.product_id)?.type !== 'goods') throw new Error('Select a stockable product');
    if (!Number.isFinite(Number(l.qty)) || Number(l.qty) <= 0) throw new Error('Enter a positive finite quantity');
  }
}

/** Ordered location-to-location picking specs for an initialized warehouse. */
export function planTransfers(db, warehouseId, type, lines) {
  const wh = warehouse(db, warehouseId);
  if (wh.active === false) throw new Error('This warehouse is archived');
  checkLines(db, lines);
  let path;
  if (type === 'incoming') {
    path = [external(db, 'Vendors'), ...(wh.reception_steps === 'one_step' ? [] : [wh.wh_input_stock_loc_id]),
      ...(wh.reception_steps === 'three_steps' ? [wh.wh_qc_stock_loc_id] : []), wh.lot_stock_id];
  } else if (type === 'outgoing') {
    path = [wh.lot_stock_id, ...(wh.delivery_steps === 'pick_pack_ship' ? [wh.wh_pack_stock_loc_id] : []),
      ...(wh.delivery_steps === 'ship_only' ? [] : [wh.wh_output_stock_loc_id]), external(db, 'Customers')];
  } else throw new Error('Select a receipt or delivery route');
  if (path.some((id) => !id)) throw new Error('Initialize the warehouse and external locations first');
  return path.slice(1).map((location_dest_id, i) => ({
    warehouse_id: wh.id, location_id: path[i], location_dest_id,
    picking_type: type === 'incoming' && i === 0 ? 'incoming' : type === 'outgoing' && i === path.length - 2 ? 'outgoing' : 'internal',
    move_ids: lines.map((l) => ({ ...l })),
  }));
}

function ensureExternalLocations(db) {
  return ['Vendors', 'Customers'].reduce((next, name) => external(next, name) ? next
    : create(next, 'stock.location', { name, usage: 'view' }).db, db);
}

function createChain(db, specs, vals, predecessor = null) {
  let next = db;
  let previous = predecessor;
  for (const spec of specs) {
    const res = create(next, 'stock.picking', { ...vals, ...spec, warehouse_route: true,
      name: `${warehouse(next, spec.warehouse_id).code}/${spec.picking_type === 'internal' ? 'INT' : spec.picking_type === 'incoming' ? 'IN' : 'OUT'}/${pad((next.seq['stock.picking'] ?? 0) + 1)}`,
      state: previous ? 'waiting' : 'ready', move_orig_picking_id: previous,
    });
    next = res.db;
    previous = res.id;
  }
  return next;
}

/** Create an order's ready/waiting chain, or the exact legacy transfer when no warehouse exists. */
export function createOrderTransfers(db, { type, partner_id, origin, lines, link, carrier_id = null, scheduled_date, warehouse_id }) {
  const moves = (lines ?? []).filter((l) => read(db, 'product', l.product_id)?.type === 'goods')
    .map((l) => ({ product_id: l.product_id, qty: lineToStockQty(db, l, read(db, 'product', l.product_id)) }));
  if (!moves.length) return db;
  const order = link?.sale_id ? read(db, 'sale.order', link.sale_id) : link?.purchase_id ? read(db, 'purchase.order', link.purchase_id) : null;
  const id = warehouse_id ?? order?.warehouse_id ?? (db.records['stock.warehouse'] ?? []).find((w) => w.code === 'WH' && w.active !== false)?.id;
  const vals = { partner_id, origin, carrier_id, ...(scheduled_date ? { scheduled_date } : {}), ...link };
  if (!id) return create(db, 'stock.picking', { ...vals, picking_type: type, move_ids: moves, state: 'ready' }).db;
  const next = ensureWarehouseLocations(db, id);
  return createChain(next, planTransfers(next, id, type, moves), vals);
}

function successors(db, id) {
  const specs = [];
  let previous = id;
  const seen = new Set([id]);
  for (;;) {
    const p = search(db, 'stock.picking').find((r) => r.move_orig_picking_id === previous && r.state === 'waiting');
    if (!p || seen.has(p.id)) return specs;
    seen.add(p.id);
    specs.push(p);
    previous = p.id;
  }
}

/** Validate a routed step, release only its done quantities, and route any backorder separately. */
export function validateWarehousePicking(db, picking) {
  const r = read(db, 'stock.picking', picking.id);
  if (!r) throw new Error('Transfer not found');
  if (r.move_orig_picking_id && read(db, 'stock.picking', r.move_orig_picking_id)?.state !== 'done') throw new Error('Validate the preceding transfer first');
  checkLines(db, r.move_ids);
  if (r.picking_type === 'internal') {
    const quality = canValidatePicking(db, r);
    if (!quality.ok) throw new Error(`${quality.pending} quality check(s) still to do before validating`);
  }
  if ((r.move_ids ?? []).some((l) => !Number.isFinite(Number(l.quantity ?? l.qty)) || Number(l.quantity ?? l.qty) > Number(l.qty))) throw new Error('Done quantities must be finite and cannot exceed demand');
  const suffix = successors(db, r.id);
  const before = new Set(search(db, 'stock.picking').map((p) => p.id));
  const baseValidate = salesModels['stock.picking'].form.buttons.find((b) => b.label === 'Validate');
  let next = r.picking_type === 'internal'
    ? validatePicking(db, r, { apply: (d) => d }).db
    : baseValidate.run(db, r).db;
  const done = read(next, 'stock.picking', r.id).move_ids;
  if (suffix.length) next = write(next, 'stock.picking', suffix[0].id, { state: 'ready', move_ids: done.map((l) => ({ ...l })) });
  const bo = search(next, 'stock.picking').find((p) => !before.has(p.id) && p.backorder_id === r.id);
  if (bo) {
    next = write(next, 'stock.picking', bo.id, { warehouse_id: r.warehouse_id, warehouse_route: r.warehouse_route,
      move_orig_picking_id: r.move_orig_picking_id ?? null });
    const specs = suffix.map((p) => ({ warehouse_id: p.warehouse_id, location_id: p.location_id, location_dest_id: p.location_dest_id,
      picking_type: p.picking_type, move_ids: bo.move_ids.map((l) => ({ ...l })) }));
    next = createChain(next, specs, { partner_id: r.partner_id, origin: r.origin, sale_id: r.sale_id, purchase_id: r.purchase_id,
      carrier_id: r.carrier_id, scheduled_date: r.scheduled_date }, bo.id);
  }
  return next;
}

/** Create a ready internal resupply; validation moves location stock but never company stock. */
export function resupplyTransfer(db, fromWarehouseId, toWarehouseId, lines) {
  if (fromWarehouseId === toWarehouseId) throw new Error('Select two different warehouses');
  checkLines(db, lines);
  const next = ensureWarehouseLocations(ensureWarehouseLocations(db, fromWarehouseId), toWarehouseId);
  if (warehouse(next, fromWarehouseId).active === false || warehouse(next, toWarehouseId).active === false) throw new Error('This warehouse is archived');
  return createChain(next, [{ warehouse_id: fromWarehouseId, picking_type: 'internal',
    location_id: warehouse(next, fromWarehouseId).lot_stock_id, location_dest_id: warehouse(next, toWarehouseId).lot_stock_id,
    move_ids: lines.map((l) => ({ ...l })),
  }], { origin: 'Inter-warehouse resupply' });
}

/** Sum located stock in all internal warehouse locations and their descendants. */
export function warehouseQty(db, productId, warehouseId) {
  const wh = warehouse(db, warehouseId);
  const root = read(db, 'stock.location', wh.lot_stock_id)?.parent_id;
  const ids = new Set([root, ...locations.map(([field]) => wh[field])].filter(Boolean));
  const all = search(db, 'stock.location');
  let size;
  do {
    size = ids.size;
    for (const l of all) if (ids.has(l.parent_id)) ids.add(l.id);
  } while (size !== ids.size);
  return locationStock(db, productId).filter((l) => ids.has(l.location_id)).reduce((sum, l) => sum + l.qty, 0);
}

export const warehouseModels = {
  'stock.warehouse': {
    label: 'Warehouses',
    fields: {
      name: { type: 'char', label: 'Warehouse', required: true }, code: { type: 'char', label: 'Short Name', required: true },
      partner_id: relation('res.partner', 'Address'),
      reception_steps: { type: 'selection', label: 'Incoming Shipments', options: [['one_step', 'Receive in one step'], ['two_steps', 'Receive then stock'], ['three_steps', 'Receive, quality, then stock']] },
      delivery_steps: { type: 'selection', label: 'Outgoing Shipments', options: [['ship_only', 'Deliver in one step'], ['pick_ship', 'Pick then ship'], ['pick_pack_ship', 'Pick, pack, then ship']] },
      ...Object.fromEntries(locations.map(([field, label]) => [field, { ...relation('stock.location', label), readonly: true }])),
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ reception_steps: 'one_step', delivery_steps: 'ship_only', active: true }),
    guard: (db, before, r) => typeof r.code !== 'string' || !/^[A-Za-z0-9_-]{1,10}$/.test(r.code) ? 'Use a short warehouse code (1–10 letters, digits, hyphens or underscores)'
      : warehouses(db).some((w) => w.id !== r.id && w.code.toUpperCase() === r.code.toUpperCase()) ? 'Warehouse code must be unique'
        : !['one_step', 'two_steps', 'three_steps'].includes(r.reception_steps) || !['ship_only', 'pick_ship', 'pick_pack_ship'].includes(r.delivery_steps) ? 'Select valid warehouse steps' : null,
    list: ['name', 'code', 'partner_id', 'reception_steps', 'delivery_steps', 'active'],
    form: { title: 'name', groups: [['code', 'partner_id', 'active'], ['reception_steps', 'delivery_steps'], locations.map(([field]) => field)],
      buttons: [
        { label: 'Initialize Locations', primary: true, run: (db, r) => ({ db: ensureWarehouseLocations(db, r.id) }) },
        {
          label: 'Resupply From Warehouse',
          ask: [{ label: 'Source warehouse (name or code)' }, { label: 'Product (name or internal reference)' }, { label: 'Quantity', type: 'number' }],
          run: (db, r, [source, productName, qty]) => {
            const from = search(db, 'stock.warehouse').find((w) => [w.name, w.code].some((v) => v && v.toLowerCase() === source.toLowerCase()));
            const product = search(db, 'product').find((p) => [p.name, p.default_code].some((v) => v && v.toLowerCase() === productName.toLowerCase()));
            if (!from) throw new Error('No warehouse with that name or code');
            if (!product) throw new Error('No product with that name or reference');
            return { db: resupplyTransfer(db, from.id, r.id, [{ product_id: product.id, qty }]) };
          },
        },
      ], chatter: true },
  },
  get 'stock.picking'() {
    const base = salesModels['stock.picking'];
    return { ...base, fields: { ...base.fields, warehouse_id: relation('stock.warehouse', 'Warehouse'),
      warehouse_route: { type: 'boolean', label: 'Warehouse Route', readonly: true, hidden: true },
      move_orig_picking_id: { ...relation('stock.picking', 'Preceding Transfer'), readonly: true } },
    form: { ...base.form, groups: [...base.form.groups, ['warehouse_id', 'move_orig_picking_id']],
      buttons: base.form.buttons.map((b) => b.label === 'Validate' ? { ...b, run: (db, r) => r.warehouse_route || r.picking_type === 'internal'
        ? { db: validateWarehousePicking(db, r) } : b.run(db, r) } : { ...b, run: (db, r) => {
        if (r.move_orig_picking_id && read(db, 'stock.picking', r.move_orig_picking_id)?.state !== 'done') throw new Error('Validate the preceding transfer first');
        return b.run(db, r);
      } }),
    } };
  },
};
