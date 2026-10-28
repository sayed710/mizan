// Scrap (stock written off from inventory, a transfer or a manufacturing order) and Unbuild (a product back into its components).
import { read, write } from '../orm.js';
import { pad, today } from './common.js';
import { deliver, moveValued } from './valuation.js';
import { explode } from './more.js';
import { round as round2 } from '../money.js';


/** Write off a quantity: stock goes down and its value (at cost) is booked as a loss against stock valuation. */
export function validateScrap(db, scrap, date = today()) {
  if (scrap.state === 'done') throw new Error('This scrap is already done');
  const product = read(db, 'product', scrap.product_id);
  const qty = Number(scrap.scrap_qty) || 0;
  if (!product) throw new Error('Choose a product to scrap');
  if (!(qty > 0)) throw new Error('The quantity to scrap must be positive');
  if (product.type === 'goods' && (Number(product.qty_available) || 0) < qty) throw new Error(`Only ${Number(product.qty_available) || 0} ${product.name} in stock`);
  const automated = product.type === 'goods' && product.valuation !== 'manual_periodic';
  const out = automated ? deliver(db, product.id, qty, { date, reference: `Scrap ${scrap.name}: ${product.name}`, counterpart: '600000' }) : null;
  const value = out?.value ?? round2(qty * (Number(product.cost) || 0));
  const next = out?.db ?? moveValued(db, [{ product_id: product.id, qty }], -1);
  const moveId = out ? next.records['stock.valuation.layer'].at(-1).move_id ?? null : null;
  return write(next, 'stock.scrap', scrap.id, { state: 'done', date_done: date, scrap_value: value, move_id: moveId });
}

/** Unbuild: consume the finished product and put its components back in stock, per its bill of materials. */
export function unbuild(db, order, date = today()) {
  if (order.state === 'done') throw new Error('This unbuild order is already done');
  const product = read(db, 'product', order.product_id);
  const qty = Number(order.product_qty) || 0;
  if (!(qty > 0)) throw new Error('The quantity to unbuild must be positive');
  if (product?.type === 'goods' && (Number(product.qty_available) || 0) < qty) throw new Error(`Only ${Number(product.qty_available) || 0} ${product.name} in stock`);
  const { move_raw } = explode(db, { bom_id: order.bom_id, product_qty: qty });
  const back = move_raw.map((m) => ({ product_id: m.product_id, qty: round2(m.to_consume) }));
  const next = moveValued(moveValued(db, [{ product_id: order.product_id, qty }], -1, { date, reference: order.name, counterpart: '600000' }), back, 1, { date, reference: order.name, counterpart: '600000' });
  return write(next, 'mrp.unbuild', order.id, { state: 'done', date_done: date, components: back });
}

export const mrpModels = {
  'stock.scrap': {
    label: 'Scrap Orders',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      scrap_qty: { type: 'float', label: 'Quantity' },
      lot_name: { type: 'char', label: 'Lot/Serial Number' },
      origin: { type: 'char', label: 'Source Document' },
      picking_id: { type: 'many2one', relation: 'stock.picking', label: 'Transfer' },
      production_id: { type: 'many2one', relation: 'mrp.production', label: 'Manufacturing Order' },
      reason: { type: 'char', label: 'Scrap Reason' },
      scrap_value: { type: 'monetary', label: 'Value', readonly: true },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      date_done: { type: 'date', label: 'Date', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['done', 'Done']] },
    },
    defaults: (id) => ({ name: `SP/${pad(id)}`, scrap_qty: 1, state: 'draft' }),
    groupBys: ['product_id', 'state'],
    kanban: { title: 'name', lines: ['product_id', 'scrap_qty', 'reason'], badge: 'state' },
    list: ['date_done', 'name', 'product_id', 'scrap_qty', 'scrap_value', 'origin', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'done',
      buttons: [{ label: 'Validate', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: validateScrap(db, r) }) }],
      title: 'name',
      groups: [['product_id', 'scrap_qty', 'lot_name', 'reason'], ['origin', 'picking_id', 'production_id', 'scrap_value', 'move_id', 'date_done']],
      chatter: true,
    },
  },

  'mrp.unbuild': {
    label: 'Unbuild Orders',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      bom_id: { type: 'many2one', relation: 'mrp.bom', label: 'Bill of Materials', required: true },
      product_qty: { type: 'float', label: 'Quantity' },
      production_id: { type: 'many2one', relation: 'mrp.production', label: 'Manufacturing Order' },
      components: {
        type: 'one2many', label: 'Recovered Components', readonly: true,
        fields: { product_id: { type: 'many2one', relation: 'product', label: 'Product' }, qty: { type: 'float', label: 'Quantity' } },
        newLine: () => ({ product_id: null, qty: 0 }),
      },
      date_done: { type: 'date', label: 'Date', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['done', 'Done']] },
    },
    defaults: (id) => ({ name: `UB/${pad(id)}`, product_qty: 1, state: 'draft', components: [] }),
    onchange: (r, key, db) => {
      if (key !== 'product_id' || !r.product_id) return {};
      const bom = (db.records['mrp.bom'] ?? []).find((b) => b.product_id === r.product_id);
      return bom ? { bom_id: bom.id } : {};
    },
    kanban: { title: 'name', lines: ['product_id', 'product_qty'], badge: 'state' },
    list: ['date_done', 'name', 'product_id', 'product_qty', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'done',
      buttons: [{ label: 'Unbuild', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: unbuild(db, r) }) }],
      title: 'name',
      groups: [['product_id', 'bom_id', 'product_qty'], ['production_id', 'date_done']],
      tabs: [{ label: 'Recovered Components', fields: ['components'] }],
      chatter: true,
    },
  },
};
