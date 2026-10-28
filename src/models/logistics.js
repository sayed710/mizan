// Delivery methods, lots & serial numbers, phone calls, IoT devices.
import { create, read, search, write } from '../orm.js';
import { today } from './common.js';
import { round } from '../money.js';


/** Total weight (kg) of an order's lines. */
export const orderWeight = (db, lines = []) => round(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(read(db, 'product', l.product_id)?.weight) || 0), 0));

/**
 * Shipping price for an order with a carrier: fixed price, or the first weight rule that fits;
 * free above `free_over` (order untaxed amount). API carriers are priced by the server.
 */
export function shippingPrice(db, carrier, order) {
  if (carrier.free_over > 0 && (order.amount_untaxed ?? 0) >= carrier.free_over) return 0;
  if (carrier.delivery_type === 'fixed') return Number(carrier.fixed_price) || 0;
  if (carrier.delivery_type === 'rules') {
    const w = orderWeight(db, order.order_line);
    const rule = [...(carrier.rules ?? [])].sort((a, b) => a.max_weight - b.max_weight).find((r) => w <= r.max_weight);
    if (!rule) throw new Error(`No ${carrier.name} rule covers ${w} kg`);
    return Number(rule.price) || 0;
  }
  throw new Error('This carrier is priced through its API (server integration)');
}

/** Add (or replace) the shipping line on a quotation. */
export function addShipping(db, order, price) {
  const ship = search(db, 'product').find((p) => p.default_code === 'SHIP');
  if (!ship) throw new Error('Create a service product with reference SHIP for shipping lines');
  const lines = (order.order_line ?? []).filter((l) => l.product_id !== ship.id);
  return write(db, 'sale.order', order.id, { order_line: [...lines, { product_id: ship.id, qty: 1, price_unit: round(price), discount: 0, tax: 14 }] });
}

/**
 * Validate lots on a transfer: tracked products need a lot/serial per line; serials are unique units.
 * Incoming creates/raises lots, outgoing lowers them. Returns the new db.
 */
export function applyLots(db, picking, sign) {
  let next = db;
  for (const m of picking.move_ids ?? []) {
    const product = read(next, 'product', m.product_id);
    if (!product || !product.tracking || product.tracking === 'none') continue;
    if (!m.lot_name) throw new Error(`${product.name} is tracked: enter a lot/serial number`);
    if (product.tracking === 'serial' && Number(m.qty) !== 1) throw new Error(`${product.name}: one line per serial number (quantity 1)`);
    const lot = search(next, 'stock.lot').find((l) => l.product_id === product.id && l.name === m.lot_name);
    if (!lot) {
      if (sign < 0) throw new Error(`Lot ${m.lot_name} of ${product.name} is not in stock`);
      next = create(next, 'stock.lot', { name: m.lot_name, product_id: product.id, qty: Number(m.qty), expiration_date: m.expiration_date || null }).db;
    } else {
      const qty = (Number(lot.qty) || 0) + sign * Number(m.qty);
      if (qty < 0) throw new Error(`Lot ${m.lot_name} has only ${lot.qty} units`);
      if (product.tracking === 'serial' && qty > 1) throw new Error(`Serial ${m.lot_name} is already in stock`);
      next = write(next, 'stock.lot', lot.id, { qty });
    }
  }
  return next;
}

export const logisticsModels = {
  'marketplace.connector': {
    label: 'Marketplace Connectors',
    fields: {
      name: { type: 'char', label: 'Connector', required: true },
      platform: { type: 'selection', label: 'Platform', options: [['amazon', 'Amazon'], ['noon', 'Noon'], ['shopee', 'Shopee'], ['lazada', 'Lazada'], ['tiktok', 'TikTok Shop'], ['jumia', 'Jumia'], ['custom', 'Custom feed']] },
      feed_url: { type: 'char', label: 'Orders Feed URL (https)' },
      last_sync: { type: 'char', label: 'Last Sync', readonly: true },
      last_count: { type: 'integer', label: 'Orders Imported Last Sync', readonly: true },
    },
    defaults: () => ({ platform: 'amazon' }),
    kanban: { title: 'name', lines: ['platform', 'last_sync', 'last_count'] },
    list: ['name', 'platform', 'last_sync', 'last_count'],
    form: {
      buttons: [{ label: 'Sync Orders', primary: true, server: '/api/integrations/marketplace-sync', requires: 'marketplace', run: () => { throw new Error('Order sync runs on the Mizan server (npm start)'); } }],
      title: 'name',
      smart: [{ label: 'Orders', model: 'sale.order', field: 'connector_id', target: 'sales/quotations' }],
      groups: [['platform', 'feed_url'], ['last_sync', 'last_count']],
      chatter: true,
    },
  },
  'delivery.carrier': {
    label: 'Delivery Methods',
    fields: {
      name: { type: 'char', label: 'Delivery Method', required: true },
      delivery_type: { type: 'selection', label: 'Provider', options: [['fixed', 'Fixed Price'], ['rules', 'Based on Rules'], ['api', 'Carrier API (DHL, FedEx, Aramex…)']] },
      fixed_price: { type: 'monetary', label: 'Fixed Price' },
      free_over: { type: 'monetary', label: 'Free if order amount is above' },
      rules: {
        type: 'one2many',
        label: 'Pricing Rules',
        fields: { max_weight: { type: 'float', label: 'Up to (kg)' }, price: { type: 'monetary', label: 'Price' } },
        newLine: () => ({ max_weight: 10, price: 0 }),
      },
      api_url: { type: 'char', label: 'Rate API URL' },
      tracking_url: { type: 'char', label: 'Tracking URL ({ref})' },
    },
    defaults: () => ({ delivery_type: 'fixed', fixed_price: 0, free_over: 0, rules: [] }),
    kanban: { title: 'name', lines: ['delivery_type', 'fixed_price'] },
    list: ['name', 'delivery_type', 'fixed_price', 'free_over'],
    form: { title: 'name', groups: [['delivery_type', 'fixed_price', 'free_over'], ['api_url', 'tracking_url']], tabs: [{ label: 'Pricing Rules', fields: ['rules'] }] },
  },

  'stock.lot': {
    label: 'Lots/Serial Numbers',
    fields: {
      name: { type: 'char', label: 'Lot/Serial Number', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      qty: { type: 'float', label: 'On Hand', readonly: true },
      expiration_date: { type: 'date', label: 'Expiration Date' },
      expired: { type: 'boolean', label: 'Expired', compute: (r) => !!r.expiration_date && r.expiration_date < today() },
    },
    defaults: () => ({ qty: 0 }),
    filters: [[{ id: 'in_stock', label: 'In Stock', fn: (r) => r.qty > 0 }, { id: 'expired', label: 'Expired', fn: (r) => r.expiration_date && r.expiration_date < today() }]],
    groupBys: ['product_id', 'expiration_date'],
    kanban: { title: 'name', lines: ['product_id', 'qty', 'expiration_date'] },
    list: ['name', 'product_id', 'qty', 'expiration_date', 'expired'],
    listDecoration: (r) => (r.expiration_date && r.expiration_date < today() ? 'danger' : null),
    views: ['list', 'kanban'],
    form: { title: 'name', groups: [['product_id', 'qty'], ['expiration_date', 'expired']], chatter: true },
  },

  'phone.call': {
    label: 'Calls',
    fields: {
      name: { type: 'char', label: 'Subject', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      phone: { type: 'char', label: 'Phone Number' },
      direction: { type: 'selection', label: 'Direction', options: [['out', 'Outgoing'], ['in', 'Incoming'], ['missed', 'Missed']] },
      date: { type: 'date', label: 'Date' },
      duration: { type: 'float', label: 'Duration (min)' },
      notes: { type: 'text', label: 'Notes' },
    },
    defaults: () => ({ direction: 'out', date: today(), duration: 0 }),
    onchange: (r, key, db) => (key === 'partner_id' && r.partner_id ? { phone: read(db, 'res.partner', r.partner_id)?.phone ?? '' } : {}),
    groupBys: ['direction', 'partner_id', 'date'],
    kanban: { groupBy: 'direction', title: 'name', lines: ['partner_id', 'phone', 'date'] },
    list: ['date', 'direction', 'partner_id', 'phone', 'name', 'duration'],
    views: ['list', 'kanban', 'calendar'],
    calendar: { date: 'date' },
    form: {
      buttons: [{ label: 'Call', primary: true, when: (r) => r.phone, run: (db, r) => { window.location.href = `tel:${String(r.phone).replace(/[^\d+]/g, '')}`; return { db }; } }],
      title: 'name',
      groups: [['partner_id', 'phone', 'direction'], ['date', 'duration']],
      tabs: [{ label: 'Notes', fields: ['notes'] }],
      chatter: true,
    },
  },

  'iot.device': {
    label: 'IoT Devices',
    fields: {
      name: { type: 'char', label: 'Device Name', required: true },
      device_type: { type: 'selection', label: 'Type', options: [['scale', 'Scale'], ['sensor', 'Sensor'], ['printer', 'Printer'], ['scanner', 'Scanner'], ['meter', 'Meter']] },
      location: { type: 'char', label: 'Location' },
      token_hash: { type: 'char', label: 'Token (hash)', readonly: true },
      last_value: { type: 'float', label: 'Last Value', readonly: true },
      unit: { type: 'char', label: 'Unit' },
      last_seen: { type: 'char', label: 'Last Seen', readonly: true },
    },
    defaults: () => ({ device_type: 'sensor' }),
    kanban: { title: 'name', lines: ['device_type', 'last_value', 'last_seen'] },
    list: ['name', 'device_type', 'location', 'last_value', 'unit', 'last_seen'],
    form: {
      buttons: [{ label: 'Generate Token', server: '/api/iot/token', requires: 'server', run: (db) => ({ db }) }],
      title: 'name',
      groups: [['device_type', 'location', 'unit'], ['last_value', 'last_seen', 'token_hash']],
      chatter: true,
    },
  },
};
