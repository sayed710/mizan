import { create, read, write } from '../orm.js';
import { addDays, amountFields, monthFilters, pad, productLines, today } from './common.js';

/** Adjust on-hand quantity of stockable products by `sign` × line quantity. */
export function moveStock(db, lines = [], sign) {
  return lines.reduce((acc, l) => {
    const p = read(acc, 'product', l.product_id);
    if (!p || p.type !== 'goods') return acc;
    return write(acc, 'product', p.id, { qty_available: (Number(p.qty_available) || 0) + sign * (Number(l.qty) || 0) });
  }, db);
}

/** Create a draft invoice/bill from order lines and return where to go. */
function invoiceFrom(db, order, moveType, originField) {
  const { db: next, id } = create(db, 'account.move', {
    move_type: moveType,
    partner_id: order.partner_id,
    invoice_date: today(),
    invoice_date_due: addDays(today(), 30),
    invoice_origin: order.name,
    [originField]: order.id,
    invoice_line_ids: order.order_line.map((l) => ({ ...l })),
  });
  return { db: next, go: `#/accounting/${moveType === 'out_invoice' ? 'invoices' : 'bills'}/${id}` };
}

const orderState = (labels) => ({ type: 'selection', label: 'Status', tracking: true, options: labels });

export const salesModels = {
  product: {
    label: 'Products',
    fields: {
      name: { type: 'char', label: 'Product Name', required: true },
      default_code: { type: 'char', label: 'Internal Reference' },
      type: { type: 'selection', label: 'Product Type', options: [['goods', 'Goods'], ['service', 'Service']] },
      categ: { type: 'char', label: 'Category' },
      list_price: { type: 'monetary', label: 'Sales Price' },
      cost: { type: 'monetary', label: 'Cost' },
      qty_available: { type: 'float', label: 'On Hand', readonly: true },
      reorder_min: { type: 'float', label: 'Min. Quantity' },
      website_published: { type: 'boolean', label: 'Sold Online' },
    },
    defaults: () => ({ type: 'goods', list_price: 0, cost: 0, qty_available: 0, reorder_min: 0 }),
    filters: [
      [{ id: 'goods', label: 'Goods', fn: (r) => r.type === 'goods' }, { id: 'services', label: 'Services', fn: (r) => r.type === 'service' }],
      [{ id: 'low', label: 'Below Minimum', fn: (r) => r.type === 'goods' && r.qty_available < r.reorder_min }],
    ],
    groupBys: ['type', 'categ'],
    kanban: { title: 'name', lines: ['list_price', 'qty_available'], avatar: true },
    list: ['default_code', 'name', 'categ', 'type', 'list_price', 'cost', 'qty_available'],
    graph: { groupBy: 'categ', measure: 'qty_available' },
    pivot: { row: 'categ', col: 'type', measure: 'qty_available' },
    form: {
      title: 'name',
      buttons: [
        {
          label: 'Update Quantity',
          run: (db, r) => {
            const qty = prompt('New on-hand quantity', String(r.qty_available ?? 0));
            if (qty == null || Number.isNaN(Number(qty))) return { db };
            return { db: write(db, 'product', r.id, { qty_available: Number(qty) }) };
          },
          when: (r) => r.type === 'goods',
        },
      ],
      groups: [['default_code', 'type', 'categ'], ['list_price', 'cost', 'qty_available', 'reorder_min']],
      chatter: true,
    },
  },

  'sale.order': {
    label: 'Quotations',
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer', required: true },
      date_order: { type: 'date', label: 'Order Date' },
      validity_date: { type: 'date', label: 'Expiration' },
      user: { type: 'char', label: 'Salesperson' },
      source: { type: 'selection', label: 'Source', readonly: true, options: [['backend', 'Backend'], ['website', 'Website']] },
      state: orderState([['draft', 'Quotation'], ['sent', 'Quotation Sent'], ['sale', 'Sales Order'], ['cancel', 'Cancelled']]),
      order_line: productLines('Order Lines', 'list_price'),
      ...amountFields('order_line'),
    },
    defaults: (id) => ({ name: 'S' + pad(id), date_order: today(), validity_date: addDays(today(), 30), user: 'Admin', state: 'draft', order_line: [] }),
    filters: [
      [{ id: 'quotations', label: 'Quotations', fn: (r) => ['draft', 'sent'].includes(r.state) }, { id: 'orders', label: 'Sales Orders', fn: (r) => r.state === 'sale' }],
      monthFilters('date_order'),
    ],
    groupBys: ['state', 'partner_id', 'user', 'date_order'],
    views: ['list', 'kanban', 'graph', 'pivot', 'calendar'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total'], badge: 'state' },
    list: ['name', 'date_order', 'partner_id', 'user', 'amount_total', 'state'],
    graph: { groupBy: 'date_order', measure: 'amount_total' },
    pivot: { row: 'partner_id', col: 'state', measure: 'amount_total' },
    calendar: { date: 'date_order' },
    form: {
      statusbar: 'state',
      lockedWhen: (r) => !['draft', 'sent'].includes(r.state),
      statusbarHide: ['cancel'],
      buttons: [
        { label: 'Send by Email', vals: { state: 'sent' }, when: (r) => r.state === 'draft' },
        { label: 'Print', run: (db, r) => ({ db, go: `#/print/sale.order/${r.id}` }) },
        {
          label: 'Confirm',
          primary: true,
          when: (r) => ['draft', 'sent'].includes(r.state),
          run: (db, r) => ({ db: moveStock(write(db, 'sale.order', r.id, { state: 'sale' }), r.order_line, -1) }),
        },
        { label: 'Create Invoice', primary: true, when: (r) => r.state === 'sale', run: (db, r) => invoiceFrom(db, r, 'out_invoice', 'sale_id') },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => !['cancel', 'sale'].includes(r.state) },
      ],
      smart: [{ label: 'Invoices', model: 'account.move', field: 'sale_id', target: 'accounting/invoices' }],
      title: 'name',
      groups: [['partner_id'], ['date_order', 'validity_date', 'user']],
      tabs: [{ label: 'Order Lines', fields: ['order_line'] }],
      footer: ['amount_untaxed', 'amount_tax', 'amount_total'],
      chatter: true,
    },
  },

  'purchase.order': {
    label: 'Requests for Quotation',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor', required: true },
      date_order: { type: 'date', label: 'Order Deadline' },
      date_planned: { type: 'date', label: 'Expected Arrival' },
      state: orderState([['draft', 'RFQ'], ['sent', 'RFQ Sent'], ['purchase', 'Purchase Order'], ['cancel', 'Cancelled']]),
      receipt_done: { type: 'boolean', label: 'Received', readonly: true },
      order_line: productLines('Products', 'cost'),
      ...amountFields('order_line'),
    },
    defaults: (id) => ({ name: 'P' + pad(id), date_order: today(), date_planned: addDays(today(), 7), state: 'draft', order_line: [], receipt_done: false }),
    filters: [
      [{ id: 'rfq', label: 'RFQs', fn: (r) => ['draft', 'sent'].includes(r.state) }, { id: 'po', label: 'Purchase Orders', fn: (r) => r.state === 'purchase' }],
      [{ id: 'to_receive', label: 'To Receive', fn: (r) => r.state === 'purchase' && !r.receipt_done }],
    ],
    groupBys: ['state', 'partner_id', 'date_order'],
    views: ['list', 'kanban', 'graph', 'pivot', 'calendar'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total'], badge: 'state' },
    list: ['name', 'partner_id', 'date_order', 'date_planned', 'amount_total', 'state'],
    graph: { groupBy: 'partner_id', measure: 'amount_total' },
    pivot: { row: 'partner_id', col: 'state', measure: 'amount_total' },
    calendar: { date: 'date_planned' },
    form: {
      statusbar: 'state',
      lockedWhen: (r) => !['draft', 'sent'].includes(r.state),
      statusbarHide: ['cancel'],
      buttons: [
        { label: 'Send RFQ', vals: { state: 'sent' }, when: (r) => r.state === 'draft' },
        { label: 'Print', run: (db, r) => ({ db, go: `#/print/purchase.order/${r.id}` }) },
        { label: 'Confirm Order', primary: true, vals: { state: 'purchase' }, when: (r) => ['draft', 'sent'].includes(r.state) },
        {
          label: 'Receive Products',
          primary: true,
          when: (r) => r.state === 'purchase' && !r.receipt_done,
          run: (db, r) => ({ db: moveStock(write(db, 'purchase.order', r.id, { receipt_done: true }), r.order_line, 1) }),
        },
        { label: 'Create Bill', when: (r) => r.state === 'purchase', run: (db, r) => invoiceFrom(db, r, 'in_invoice', 'purchase_id') },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => !['cancel', 'purchase'].includes(r.state) },
      ],
      smart: [{ label: 'Bills', model: 'account.move', field: 'purchase_id', target: 'accounting/bills' }],
      ribbon: (r) => (r.receipt_done ? 'Received' : null),
      title: 'name',
      groups: [['partner_id'], ['date_order', 'date_planned']],
      tabs: [{ label: 'Products', fields: ['order_line'] }],
      footer: ['amount_untaxed', 'amount_tax', 'amount_total'],
      chatter: true,
    },
  },
};
