// Located stock is maintained by the same quantity path as valuation; counts never write on-hand directly.
import { create, getActiveCompany, read, search, setActiveCompany, write } from '../orm.js';
import { today } from './common.js';
import { applyCount, startCount } from './valuation.js';
import { applyLots } from './logistics.js';
import { closedYearLock, lockDateFor } from './finance.js';
import { uomForLegacy } from './uom.js';
import { quantReservationMap } from './picking.js';

const companyOf = (db) => getActiveCompany() ?? db.settings?.current_company_id ?? 1;
const records = (db, model) => db.records[model] ?? [];
const companyRows = (db, model, company) => records(db, model).filter((r) => (r.company_id ?? 1) === company);

function defaultLocation(db, company) {
  const wh = companyRows(db, 'stock.warehouse', company).find((w) => w.lot_stock_id);
  const loc = wh && read(db, 'stock.location', wh.lot_stock_id) || companyRows(db, 'stock.location', company).find((l) => l.usage === 'internal');
  if (loc) return { db, id: loc.id };
  return create(db, 'stock.location', { name: 'Stock', usage: 'internal', company_id: company });
}

function change(db, product_id, location_id, lot_id, company_id, delta) {
  const q = companyRows(db, 'stock.quant', company_id).find((r) => r.product_id === product_id && r.location_id === location_id && (r.lot_id || null) === (lot_id || null));
  return q ? write(db, 'stock.quant', q.id, { quantity: q.quantity + delta })
    : create(db, 'stock.quant', { product_id, location_id, lot_id: lot_id || null, company_id, quantity: delta }).db;
}

/** One-time upgrade: preserve located done-move history and allocate unlocated legacy opening stock. */
export function ensureQuants(db, productIds) {
  let next = db;
  for (const p of records(db, 'product').filter((p) => p.type === 'goods' && (!productIds || productIds.includes(p.id)))) {
    if (records(next, 'stock.quant').some((q) => q.product_id === p.id)) continue;
    const done = records(next, 'stock.picking').filter((r) => r.state === 'done');
    for (const picking of done) for (const line of (picking.move_ids ?? []).filter((l) => l.product_id === p.id)) {
      const company = picking.company_id ?? 1;
      const lot = companyRows(next, 'stock.lot', company).find((l) => l.product_id === p.id && l.name === line.lot_name);
      for (const [loc, sign] of [[picking.location_id, -1], [picking.location_dest_id, 1]]) {
        if (read(next, 'stock.location', loc)?.usage === 'internal') next = change(next, p.id, loc, lot?.id, company, sign * Number(line.qty));
      }
    }
    const located = records(next, 'stock.quant').filter((q) => q.product_id === p.id).reduce((s, q) => s + q.quantity, 0);
    let residual = Number(p.qty_available || 0) - located;
    // Legacy lot balances may predate located moves. Preserve their identities without inventing more stock.
    if (p.tracking && p.tracking !== 'none') for (const lot of records(next, 'stock.lot').filter((l) => l.product_id === p.id)) {
      const assigned = records(next, 'stock.quant').filter((q) => q.product_id === p.id && q.lot_id === lot.id).reduce((s, q) => s + q.quantity, 0);
      const missing = Math.min(Math.max(0, residual), Math.max(0, Number(lot.qty || 0) - assigned));
      if (!missing) continue;
      const loc = defaultLocation(next, lot.company_id ?? 1);
      next = change(loc.db, p.id, loc.id, lot.id, lot.company_id ?? 1, missing);
      residual -= missing;
    }
    if (residual || !records(next, 'stock.quant').some((q) => q.product_id === p.id)) {
      const company = p.company_id || 1;
      const loc = defaultLocation(next, company);
      next = change(loc.db, p.id, loc.id, null, company, residual);
    }
  }
  return next;
}

/** Quantity primitive for valuation, manufacturing, rentals and legacy callers. */
export function moveQuantStock(db, lines, sign) {
  let next = ensureQuants(db, lines.map((l) => l.product_id));
  for (const l of lines) {
    const p = read(next, 'product', l.product_id);
    if (!p || p.type !== 'goods') continue;
    const company = l.company_id ?? companyOf(next);
    const loc = l.location_id ? { db: next, id: l.location_id } : defaultLocation(next, company);
    const location = read(loc.db, 'stock.location', loc.id);
    if (location?.usage !== 'internal' || (location.company_id ?? 1) !== company) throw new Error('Select an internal location in the same company');
    next = loc.db;
    const lot = l.lot_id || (['lot', 'serial'].includes(p.tracking) && l.lot_name ? companyRows(next, 'stock.lot', company).find((r) => r.product_id === p.id && r.name === l.lot_name)?.id : null);
    const selectedLot = lot && read(next, 'stock.lot', lot);
    if (['lot', 'serial'].includes(p.tracking) && l.lot_name && !lot) throw new Error(`Lot ${l.lot_name} is not in stock for this company`);
    if (lot && (!selectedLot || selectedLot.product_id !== p.id || (selectedLot.company_id ?? 1) !== company || (l.lot_name && selectedLot.name !== l.lot_name))) throw new Error('Select a lot for this product and company');
    const q = companyRows(next, 'stock.quant', company).find((r) => r.product_id === p.id && r.location_id === loc.id && (r.lot_id || null) === (lot || null));
    if (sign * Number(l.qty || 0) < 0 && (Number(q?.quantity) || 0) + sign * Number(l.qty || 0) < -1e-8) throw new Error('Not enough stock at the source location');
    next = change(next, p.id, loc.id, lot, company, sign * Number(l.qty || 0));
    const total = records(next, 'stock.quant').filter((q) => q.product_id === p.id).reduce((s, q) => s + q.quantity, 0);
    next = write(next, 'product', p.id, { qty_available: total });
  }
  return next;
}

/** Internal transfers have no boundary valuation or lot-total change. */
export function transferQuants(db, picking) {
  let next = db;
  for (const line of picking.move_ids ?? []) {
    const product = read(next, 'product', line.product_id);
    if (['lot', 'serial'].includes(product?.tracking) && !line.lot_name) throw new Error(`${product.name} is tracked: enter a lot/serial number`);
    if (product?.tracking === 'serial' && Number(line.qty) !== 1) throw new Error(`${product.name}: one line per serial number (quantity 1)`);
    next = moveQuantStock(next, [{ ...line, location_id: picking.location_id, company_id: picking.company_id }], -1);
    next = moveQuantStock(next, [{ ...line, location_id: picking.location_dest_id, company_id: picking.company_id }], 1);
  }
  return next;
}

function selectedRows(db, ids) {
  const visible = search(db, 'stock.quant').filter((q) => q.company_id === companyOf(db));
  if (ids?.length && ids.some((id) => !visible.some((q) => q.id === id))) throw new Error('Quant is not accessible in this company');
  return ids?.length ? visible.filter((q) => ids.includes(q.id)) : visible;
}
export function clearInventory(db, ids) {
  return selectedRows(db, ids).reduce((next, q) => write(next, 'stock.quant', q.id, { inventory_quantity: null, inventory_quantity_set: false, inventory_revision: null }), db);
}
function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}
export function requestCount(db, ids, { date = today(), user_id = null } = {}) {
  if (!validDate(date)) throw new Error('Enter a valid count date');
  if (user_id && !companyRows(db, 'hr.employee', companyOf(db)).some((u) => u.id === user_id)) throw new Error('Select an existing counter');
  return selectedRows(db, ids).reduce((next, q) => write(next, 'stock.quant', q.id, { inventory_date: date, user_id }), db);
}

/** Reuse count valuation (FIFO/average/standard and accounting guards), with the quant's location and lot. */
export function applyInventory(db, ids, { date = today() } = {}) {
  if (!validDate(date)) throw new Error('Enter a valid count date');
  if (date <= [lockDateFor(db.settings), closedYearLock(db)].sort().at(-1)) throw new Error('The accounting period is locked');
  const rows = selectedRows(db, ids).filter((q) => q.inventory_quantity_set);
  if (rows.some((q) => q.inventory_revision == null || q.inventory_revision !== (q.stock_revision ?? 0))) throw new Error('Stock changed since this count was recorded; count it again');
  const previousCompany = getActiveCompany();
  setActiveCompany(companyOf(db));
  try {
    let next = db;
    for (const row of rows) {
      const q = read(next, 'stock.quant', row.id);
      const difference = q.inventory_quantity - q.quantity;
      if (difference) {
        let adjustment = companyRows(next, 'stock.location', q.company_id).find((l) => l.usage === 'inventory');
        if (!adjustment) {
          const loc = create(next, 'stock.location', { name: 'Inventory Adjustment', usage: 'inventory', company_id: q.company_id });
          next = loc.db;
          adjustment = read(next, 'stock.location', loc.id);
        }
        const lot = read(next, 'stock.lot', q.lot_id);
        const move = create(next, 'stock.picking', { picking_type: difference > 0 ? 'incoming' : 'outgoing', state: 'done', date_done: date,
          origin: 'Physical Inventory', company_id: q.company_id,
          location_id: difference > 0 ? adjustment.id : q.location_id, location_dest_id: difference > 0 ? q.location_id : adjustment.id,
          move_ids: [{ product_id: q.product_id, qty: Math.abs(difference), lot_name: lot?.name || '' }] });
        next = applyLots(move.db, read(move.db, 'stock.picking', move.id), Math.sign(difference));
        const count = startCount(next, { productIds: [q.product_id], date });
        const p = read(count.db, 'product', q.product_id);
        next = write(count.db, 'stock.inventory.count', count.id, { line_ids: [{ product_id: p.id, theoretical_qty: p.qty_available, counted_qty: p.qty_available + difference }] });
        next = applyCount(next, count.id, { stockLine: { location_id: q.location_id, lot_id: q.lot_id, company_id: q.company_id }, pickingId: move.id });
      }
      next = clearInventory(next, [q.id]);
      next = write(next, 'stock.quant', q.id, { inventory_date: null, user_id: null });
    }
    return next;
  } finally { setActiveCompany(previousCompany); }
}

function reserved(db, q) {
  return quantReservationMap(db, q.product_id, q.company_id ?? 1).get(q.id) || 0;
}
const relation = (relation, label, readonly = false) => ({ type: 'many2one', relation, label, readonly });
export const quantModels = {
  'stock.quant': {
    label: 'Physical Inventory', views: ['list'],
    fields: {
      name: { type: 'char', label: 'Product', compute: (q, db) => read(db, 'product', q.product_id)?.name || '' },
      product_id: { ...relation('product', 'Product'), required: true },
      location_id: { ...relation('stock.location', 'Location'), required: true },
      lot_id: relation('stock.lot', 'Lot/Serial Number'),
      quantity: { type: 'float', label: 'On Hand', readonly: true },
      reserved_quantity: { type: 'float', label: 'Reserved Quantity', readonly: true, compute: (q, db) => reserved(db, q) },
      available_quantity: { type: 'float', label: 'Available Quantity', compute: (q, db) => q.quantity - reserved(db, q) },
      uom_id: { ...relation('uom.uom', 'Unit of Measure', true), compute: (q, db) => {
        const p = read(db, 'product', q.product_id);
        return p?.uom_id ?? uomForLegacy(db, p?.uom || 'unit')?.id;
      } },
      company_id: relation('res.company', 'Company', true),
      tracking: { type: 'selection', label: 'Tracking', options: [['none', 'No Tracking'], ['lot', 'By Lots'], ['serial', 'By Unique Serial Number']], compute: (q, db) => read(db, 'product', q.product_id)?.tracking || 'none' },
      inventory_quantity: { type: 'float', label: 'Counted Quantity' },
      inventory_diff_quantity: { type: 'float', label: 'Difference', compute: (q) => q.inventory_quantity_set ? Number(q.inventory_quantity) - q.quantity : 0 },
      inventory_date: { type: 'date', label: 'Scheduled Count Date' },
      user_id: relation('hr.employee', 'Counter'),
      inventory_quantity_set: { type: 'boolean', label: 'Count Set', readonly: true },
      stock_revision: { type: 'integer', label: 'On Hand', readonly: true, hidden: true },
      inventory_revision: { type: 'integer', label: 'Count Set', readonly: true, hidden: true },
    },
    defaults: () => ({ quantity: 0, stock_revision: 0, inventory_quantity: null, inventory_quantity_set: false, inventory_revision: null }),
    onchange: (r, key) => key === 'inventory_quantity' ? { inventory_quantity_set: r.inventory_quantity != null && r.inventory_quantity !== '', inventory_revision: r.inventory_quantity != null && r.inventory_quantity !== '' ? (r.stock_revision ?? 0) : null }
      : key === 'quantity' ? { stock_revision: (r.stock_revision ?? 0) + 1 } : {},
    guard: (db, before, q) => {
      const loc = read(db, 'stock.location', q.location_id);
      if (!loc || loc.usage !== 'internal' || (loc.company_id ?? 1) !== q.company_id) return 'Select an internal location in the same company';
      if (read(db, 'product', q.product_id)?.type !== 'goods') return 'Select a stockable product';
      const lot = read(db, 'stock.lot', q.lot_id);
      if (q.lot_id && (!lot || lot.product_id !== q.product_id || (lot.company_id ?? 1) !== q.company_id)) return 'Select a lot for this product and company';
      if (q.user_id && !companyRows(db, 'hr.employee', q.company_id).some((u) => u.id === q.user_id)) return 'Select an existing counter';
      if (records(db, 'stock.quant').some((r) => r.id !== q.id && r.company_id === q.company_id && r.product_id === q.product_id && r.location_id === q.location_id && (r.lot_id || null) === (q.lot_id || null))) return 'A quant already exists for this product, location and lot';
      if (before && ['product_id', 'location_id', 'lot_id', 'company_id'].some((k) => before[k] !== q[k])) return 'Quant identity cannot change';
      if (!Number.isFinite(q.quantity)) return 'On-hand quantity must be finite';
      if (q.inventory_quantity != null && (typeof q.inventory_quantity !== 'number' || !Number.isFinite(q.inventory_quantity) || q.inventory_quantity < 0)) return 'Counted quantity must be a nonnegative number';
      if (q.inventory_date && !validDate(q.inventory_date)) return 'Enter a valid count date';
      if (q.inventory_quantity_set && q.inventory_quantity == null) return 'Enter a counted quantity';
      return null;
    },
    protectDelete: () => 'Quants are maintained by stock movements',
    invariant: (db, q) => Math.abs(records(db, 'stock.quant').filter((r) => r.product_id === q.product_id).reduce((s, r) => s + r.quantity, 0)
      - Number(read(db, 'product', q.product_id)?.qty_available || 0)) > 1e-8 ? 'Quants must match the product on-hand quantity' : null,
    list: ['product_id', 'location_id', 'lot_id', 'quantity', 'inventory_quantity', 'inventory_diff_quantity', 'inventory_date', 'user_id'],
    editableList: ['inventory_quantity', 'inventory_date', 'user_id'],
    groupBys: ['location_id', 'product_id'],
    filters: [[{ id: 'to_count', label: 'To Count', fn: (q) => !!q.inventory_date && q.inventory_date <= today() }], [{ id: 'to_apply', label: 'To Apply', fn: (q) => !!q.inventory_quantity_set }]],
    listActions: [
      { label: 'Apply', run: (db, ids) => applyInventory(db, ids) },
      { label: 'Clear', run: clearInventory },
      { label: 'Request a count', run: (db, ids, options) => requestCount(db, ids, options) },
    ],
    form: { title: 'name', groups: [['product_id', 'location_id', 'lot_id'], ['quantity', 'reserved_quantity', 'available_quantity'], ['inventory_quantity', 'inventory_diff_quantity', 'inventory_date', 'user_id']], buttons: [
      { label: 'Apply', run: (db, q) => ({ db: applyInventory(db, [q.id]) }) },
      { label: 'Clear', run: (db, q) => ({ db: clearInventory(db, [q.id]) }) },
      { label: 'Request a count', run: (db, q) => ({ db: requestCount(db, [q.id], { date: q.inventory_date || today(), user_id: q.user_id }) }) },
    ] },
  },
};
