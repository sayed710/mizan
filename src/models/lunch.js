// Lunch: vendors with opening days and an order deadline, employee wallets (cash moves), orders, alerts.
import { create, read, search, write } from '../orm.js';
import { today } from './common.js';

const pad = (n) => String(n).padStart(2, '0');
const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const round = (n) => Math.round(n * 100) / 100;
const employee = (label = 'Employee') => ({ type: 'many2one', relation: 'hr.employee', label });

export const WEEKDAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
const dayKey = (d) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
const dayFields = Object.fromEntries(WEEKDAYS.map(([k, label]) => [k, { type: 'boolean', label }]));
const workWeek = () => Object.fromEntries(WEEKDAYS.map(([k]) => [k, !['sat', 'sun'].includes(k)]));

const PAID = ['confirmed', 'received'];
const OPEN = ['new', 'ordered'];

/** Vendor of a product: its supplier_id, else a vendor whose name matches the legacy `vendor` text. */
const supplierOf = (db, product) => (product?.supplier_id ? read(db, 'lunch.supplier', product.supplier_id)
  : search(db, 'lunch.supplier').find((s) => product?.vendor && s.name === product.vendor)) ?? null;
const orderSupplierId = (db, o) => o.supplier_id ?? supplierOf(db, read(db, 'lunch.product', o.product_id))?.id ?? null;

/** Price of an order: the stored price, else the product price × quantity. */
export const orderPrice = (db, o) => (o.price != null && o.price !== ''
  ? Number(o.price) : round((Number(read(db, 'lunch.product', o.product_id)?.price) || 0) * (Number(o.quantity) || 0)));

/** Wallet balance of an employee: the sum of their cash moves. */
export const balance = (db, employeeId) =>
  round(search(db, 'lunch.cashmove').filter((m) => m.employee_id === employeeId).reduce((s, m) => s + (Number(m.amount) || 0), 0));

/** Whether a product can be ordered at `at`: available, vendor open that weekday and before its deadline. */
export function canOrder(db, product, at = new Date()) {
  if (!product) return { ok: false, reason: 'Choose a product' };
  if (product.is_available === false) return { ok: false, reason: 'This product is not available' };
  const vendor = supplierOf(db, product);
  if (!vendor) return { ok: true, reason: null };
  if (!vendor[dayKey(at)]) return { ok: false, reason: `${vendor.name} does not deliver today` };
  if (vendor.order_deadline && timeOf(at) >= vendor.order_deadline) return { ok: false, reason: `Orders for ${vendor.name} close at ${vendor.order_deadline}` };
  return { ok: true, reason: null };
}

/** Refuse when the wallet, less the open orders other than `ignoreId`, would go below -overdraft (setting lunch_overdraft, default 0). */
function checkWallet(db, employeeId, price, ignoreId = null) {
  const pending = search(db, 'lunch.order').filter((o) => o.id !== ignoreId && o.employee_id === employeeId && OPEN.includes(o.stage_id)).reduce((s, o) => s + orderPrice(db, o), 0);
  const overdraft = Number(db.settings?.lunch_overdraft) || 0;
  if (balance(db, employeeId) - pending - price < -overdraft) throw new Error('Your lunch account does not have enough money for this order');
}

/**
 * Place an order in state 'new'; returns { db, id }. Refuses when the vendor cannot take it or when the wallet,
 * less the orders not paid yet, would go below -overdraft (setting lunch_overdraft, default 0).
 */
export function orderLunch(db, { employeeId, productId, quantity = 1, note = '', at = new Date() }) {
  const product = read(db, 'lunch.product', productId);
  const check = canOrder(db, product, at);
  if (!check.ok) throw new Error(check.reason);
  const price = round((Number(product.price) || 0) * Number(quantity));
  checkWallet(db, employeeId, price);
  return create(db, 'lunch.order', {
    product_id: productId, employee_id: employeeId, date: dateOf(at), quantity: Number(quantity), note, price,
    supplier_id: supplierOf(db, product)?.id ?? null, stage_id: 'new',
  });
}

/** Send a vendor's orders of the day: its 'new' orders on `date` become 'ordered'. */
export const confirmOrders = (db, supplierId, date = today()) => search(db, 'lunch.order')
  .filter((o) => o.stage_id === 'new' && o.date === date && orderSupplierId(db, o) === supplierId)
  .reduce((acc, o) => write(acc, 'lunch.order', o.id, { stage_id: 'ordered' }), db);

/** Mark orders received and debit their price once (cancelled orders are skipped). */
export const receiveOrders = (db, ids) => ids.reduce((acc, id) => {
  const o = read(acc, 'lunch.order', id);
  if (!o || o.stage_id === 'cancelled') return acc;
  const paid = search(acc, 'lunch.cashmove').some((m) => m.order_id === id && Number(m.amount) < 0);
  const next = paid ? acc : create(acc, 'lunch.cashmove', {
    employee_id: o.employee_id, date: o.date ?? today(), amount: -orderPrice(acc, o), description: `Lunch: ${read(acc, 'lunch.product', o.product_id)?.name ?? ''}`, order_id: id,
  }).db;
  return o.stage_id === 'confirmed' ? next : write(next, 'lunch.order', id, { stage_id: 'confirmed' });
}, db);

/** Cancel an order not received yet; any payment linked to it is refunded. */
export function cancelOrder(db, id) {
  const o = read(db, 'lunch.order', id);
  if (!o) throw new Error(`Lunch order #${id} not found`);
  if (PAID.includes(o.stage_id)) throw new Error('Received orders cannot be cancelled');
  const net = round(search(db, 'lunch.cashmove').filter((m) => m.order_id === id).reduce((s, m) => s + (Number(m.amount) || 0), 0));
  const next = net < 0 ? create(db, 'lunch.cashmove', { employee_id: o.employee_id, date: today(), amount: -net, description: 'Refund: cancelled lunch order', order_id: id }).db : db;
  return write(next, 'lunch.order', id, { stage_id: 'cancelled' });
}

/** Active alerts shown on `at`: enabled for that weekday and not past their show-until date. */
export const activeAlerts = (db, at = new Date()) =>
  search(db, 'lunch.alert').filter((a) => a[dayKey(at)] && (!a.show_until || a.show_until >= dateOf(at)));

/** What to call in per vendor on `date`: products × quantities of the orders not cancelled. */
export function vendorSummary(db, date = today()) {
  const groups = new Map();
  for (const o of search(db, 'lunch.order').filter((x) => x.date === date && x.stage_id !== 'cancelled')) {
    const product = read(db, 'lunch.product', o.product_id);
    const sid = orderSupplierId(db, o);
    const key = sid ?? `v:${product?.vendor ?? ''}`;
    const g = groups.get(key) ?? { supplier_id: sid, vendor: (sid && read(db, 'lunch.supplier', sid)?.name) || product?.vendor || '', lines: [], total: 0 };
    const line = g.lines.find((l) => l.product_id === o.product_id);
    const qty = Number(o.quantity) || 0;
    groups.set(key, {
      ...g,
      lines: line ? g.lines.map((l) => (l === line ? { ...l, quantity: l.quantity + qty } : l)) : [...g.lines, { product_id: o.product_id, product: product?.name ?? '', quantity: qty }],
      total: round(g.total + orderPrice(db, o)),
    });
  }
  return [...groups.values()];
}

const orderGuard = (db, before, after) => (Number(after.quantity) <= 0 ? 'The quantity must be greater than zero' : null);

const orderOnchange = (r, key, db) => {
  if (!['product_id', 'quantity'].includes(key)) return {};
  const product = read(db, 'lunch.product', r.product_id);
  return { price: round((Number(product?.price) || 0) * (Number(r.quantity) || 0)), supplier_id: supplierOf(db, product)?.id ?? null };
};

export const lunchModels = {
  'lunch.supplier': {
    label: 'Vendors',
    fields: {
      name: { type: 'char', label: 'Vendor', required: true },
      phone: { type: 'char', label: 'Phone' },
      email: { type: 'char', label: 'Email' },
      ...dayFields,
      order_deadline: { type: 'char', label: 'Order Deadline (HH:MM)' },
      send_by: { type: 'selection', label: 'Send Order By', options: [['phone', 'Phone'], ['mail', 'Email']] },
      delivery: { type: 'selection', label: 'Delivery', options: [['delivery', 'Delivery'], ['pickup', 'No Delivery']] },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ ...workWeek(), order_deadline: '10:30', send_by: 'phone', delivery: 'delivery', active: true }),
    guard: (db, before, after) => (after.order_deadline && !/^([01]\d|2[0-3]):[0-5]\d$/.test(after.order_deadline) ? 'The order deadline must be HH:MM' : null),
    groupBys: ['send_by', 'delivery'],
    kanban: { title: 'name', lines: ['phone', 'order_deadline'] },
    list: ['name', 'phone', 'email', 'order_deadline', 'send_by', 'delivery'],
    views: ['list', 'kanban'],
    form: {
      title: 'name',
      buttons: [{ label: 'Send Orders', primary: true, run: (db, r) => ({ db: confirmOrders(db, r.id, today()) }) }],
      groups: [['phone', 'email', 'send_by', 'delivery'], ['order_deadline', ...WEEKDAYS.map(([k]) => k)]],
      smart: [{ label: 'Products', model: 'lunch.product', field: 'supplier_id', target: 'lunch/products' }],
      chatter: true,
    },
  },

  'lunch.product': {
    label: 'Lunch Products',
    fields: {
      name: { type: 'char', label: 'Product Name', required: true },
      supplier_id: { type: 'many2one', relation: 'lunch.supplier', label: 'Vendor' },
      vendor: { type: 'char', label: 'Vendor Name' },
      price: { type: 'monetary', label: 'Price' },
      category: { type: 'selection', label: 'Category', options: [['sandwich', 'Sandwich'], ['pizza', 'Pizza'], ['salad', 'Salad'], ['drink', 'Drinks']] },
      description: { type: 'text', label: 'Description' },
      is_available: { type: 'boolean', label: 'Available' },
      is_new: { type: 'boolean', label: 'New' },
      favorite_employee_ids: { type: 'tags', label: 'Favorite of' },
    },
    defaults: () => ({ category: 'sandwich', price: 0, is_available: true, is_new: false, favorite_employee_ids: [] }),
    onchange: (r, key, db) => (key === 'supplier_id' && r.supplier_id ? { vendor: read(db, 'lunch.supplier', r.supplier_id)?.name ?? '' } : {}),
    groupBys: ['category', 'supplier_id', 'vendor'],
    filters: [[{ id: 'available', label: 'Available', fn: (r) => r.is_available !== false }, { id: 'new', label: 'New', fn: (r) => r.is_new }]],
    kanban: { title: 'name', lines: ['price', 'vendor', 'category'], avatar: true },
    list: ['name', 'category', 'vendor', 'price', 'is_available'],
    views: ['kanban', 'list'],
    form: { title: 'name', groups: [['category', 'supplier_id', 'vendor', 'price'], ['is_available', 'is_new', 'favorite_employee_ids']], tabs: [{ label: 'Description', fields: ['description'] }], chatter: true },
  },

  'lunch.order': {
    label: 'Lunch Orders',
    fields: {
      name: { type: 'char', label: 'Reference', compute: (r) => `Lunch ${r.date ?? ''}` },
      product_id: { type: 'many2one', relation: 'lunch.product', label: 'Product', required: true },
      employee_id: employee('User'),
      date: { type: 'date', label: 'Order Date' },
      quantity: { type: 'float', label: 'Quantity' },
      note: { type: 'char', label: 'Notes' },
      toppings: { type: 'char', label: 'Extras' },
      price: { type: 'monetary', label: 'Total', readonly: true },
      supplier_id: { type: 'many2one', relation: 'lunch.supplier', label: 'Vendor', readonly: true },
      stage_id: { type: 'selection', label: 'Status', tracking: true, options: [['new', 'To Order'], ['ordered', 'Ordered'], ['confirmed', 'Received'], ['received', 'Received'], ['cancelled', 'Cancelled']] },
    },
    defaults: () => ({ date: today(), quantity: 1, employee_id: 1, stage_id: 'new' }),
    guard: orderGuard,
    onchange: orderOnchange,
    groupBys: ['date', 'employee_id', 'product_id', 'supplier_id', 'stage_id'],
    kanban: { groupBy: 'date', title: 'name', lines: ['product_id', 'employee_id', 'price', 'stage_id'] },
    list: ['date', 'employee_id', 'product_id', 'supplier_id', 'quantity', 'price', 'note', 'stage_id'],
    views: ['kanban', 'list', 'pivot'],
    pivot: { row: 'employee_id', measure: 'price' },
    form: {
      statusbar: 'stage_id',
      statusbarHide: ['received'],
      buttons: [
        {
          label: 'Order', primary: true, when: (r) => r.stage_id === 'new',
          run: (db, r) => {
            const check = canOrder(db, read(db, 'lunch.product', r.product_id));
            if (!check.ok) throw new Error(check.reason);
            checkWallet(db, r.employee_id, orderPrice(db, r), r.id);
            return { db: write(db, 'lunch.order', r.id, { stage_id: 'ordered' }) };
          },
        },
        { label: 'Mark Received', when: (r) => OPEN.includes(r.stage_id), run: (db, r) => ({ db: receiveOrders(db, [r.id]) }) },
        { label: 'Cancel', when: (r) => OPEN.includes(r.stage_id), run: (db, r) => ({ db: cancelOrder(db, r.id) }) },
      ],
      lockedWhen: (r) => [...PAID, 'cancelled'].includes(r.stage_id),
      title: 'name',
      groups: [['product_id', 'quantity', 'toppings', 'note'], ['employee_id', 'date', 'supplier_id', 'price']],
      chatter: true,
    },
  },

  'lunch.cashmove': {
    label: 'Cash Moves',
    fields: {
      employee_id: employee('User'),
      date: { type: 'date', label: 'Date' },
      amount: { type: 'monetary', label: 'Amount' },
      description: { type: 'char', label: 'Description' },
      order_id: { type: 'many2one', relation: 'lunch.order', label: 'Order', readonly: true },
    },
    defaults: () => ({ date: today(), amount: 0 }),
    groupBys: ['employee_id', 'date'],
    filters: [[{ id: 'topup', label: 'Top-ups', fn: (r) => Number(r.amount) > 0 }, { id: 'payment', label: 'Payments', fn: (r) => Number(r.amount) < 0 }]],
    kanban: { title: 'description', lines: ['employee_id', 'date', 'amount'] },
    list: ['date', 'employee_id', 'description', 'amount'],
    views: ['list', 'pivot'],
    pivot: { row: 'employee_id', measure: 'amount' },
    form: { title: 'description', groups: [['employee_id', 'amount'], ['date', 'order_id']], chatter: true },
  },

  'lunch.alert': {
    label: 'Alerts',
    fields: {
      name: { type: 'char', label: 'Alert Name', required: true },
      message: { type: 'text', label: 'Message' },
      active: { type: 'boolean', label: 'Active' },
      show_until: { type: 'date', label: 'Show Until' },
      ...dayFields,
      mode: { type: 'selection', label: 'Display', options: [['alert', 'Alert in app'], ['chat', 'Chat notification']] },
    },
    defaults: () => ({ ...workWeek(), active: true, mode: 'alert' }),
    groupBys: ['mode'],
    kanban: { title: 'name', lines: ['mode', 'show_until'] },
    list: ['name', 'mode', 'show_until'],
    views: ['list', 'kanban'],
    form: { title: 'name', groups: [['mode', 'show_until'], WEEKDAYS.map(([k]) => k)], tabs: [{ label: 'Message', fields: ['message'] }], chatter: true },
  },
};
