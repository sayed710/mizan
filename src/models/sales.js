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

/** Create a ready transfer (delivery or receipt) for the stockable lines of an order; no-op when nothing to move. */
export function createPicking(db, { type, partner_id, origin, lines, link }) {
  const moves = (lines ?? []).filter((l) => read(db, 'product', l.product_id)?.type === 'goods').map((l) => ({ product_id: l.product_id, qty: Number(l.qty) || 0 }));
  if (!moves.length) return db;
  return create(db, 'stock.picking', { picking_type: type, partner_id, origin, move_ids: moves, state: 'ready', ...link }).db;
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

/** "Color: Red, Blue; Size: S, M" → [['Red','Blue'], ['S','M']] (empty groups ignored). */
export const parseAttributes = (text = '') => String(text).split(';')
  .map((part) => (part.includes(':') ? part.split(':')[1] : part).split(',').map((v) => v.trim()).filter(Boolean))
  .filter((values) => values.length);

/** Create one product per combination of attribute values (skips combinations that already exist). */
export function generateVariants(db, template) {
  const combos = parseAttributes(template.attributes).reduce((acc, values) => acc.flatMap((c) => values.map((v) => [...c, v])), [[]]);
  const existing = new Set((db.records.product ?? []).filter((p) => p.variant_of === template.id).map((p) => (p.variant_values ?? []).join('|')));
  return combos.filter((c) => !existing.has(c.join('|'))).reduce((acc, values, i) => create(acc, 'product', {
    name: `${template.name} (${values.join(', ')})`,
    default_code: template.default_code ? `${template.default_code}-${String(i + 1).padStart(2, '0')}` : '',
    type: template.type, categ: template.categ, uom: template.uom, list_price: template.list_price, cost: template.cost,
    qty_available: 0, reorder_min: 0, variant_of: template.id, variant_values: values,
  }).db, db);
}

const orderState = (labels) => ({ type: 'selection', label: 'Status', tracking: true, options: labels });

export const salesModels = {
  'stock.picking': {
    label: 'Transfers',
    fields: {
      name: { type: 'char', label: 'Reference', readonly: true },
      picking_type: { type: 'selection', label: 'Operation Type', options: [['incoming', 'Receipt'], ['outgoing', 'Delivery'], ['internal', 'Internal Transfer']] },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      origin: { type: 'char', label: 'Source Document' },
      scheduled_date: { type: 'date', label: 'Scheduled Date' },
      date_done: { type: 'date', label: 'Effective Date', readonly: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      purchase_id: { type: 'many2one', relation: 'purchase.order', label: 'Purchase Order', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['ready', 'Ready'], ['done', 'Done'], ['cancel', 'Cancelled']] },
      move_ids: {
        type: 'one2many',
        label: 'Operations',
        fields: { product_id: { type: 'many2one', relation: 'product', label: 'Product' }, qty: { type: 'float', label: 'Quantity' } },
        newLine: () => ({ product_id: null, qty: 1 }),
      },
    },
    defaults: (id) => ({ name: `WH/${pad(id)}`, picking_type: 'outgoing', scheduled_date: today(), state: 'draft', move_ids: [] }),
    filters: [
      [{ id: 'receipts', label: 'Receipts', fn: (r) => r.picking_type === 'incoming' }, { id: 'deliveries', label: 'Deliveries', fn: (r) => r.picking_type === 'outgoing' }],
      [{ id: 'ready', label: 'Ready', fn: (r) => r.state === 'ready' }, { id: 'late', label: 'Late', fn: (r) => r.state === 'ready' && r.scheduled_date < today() }],
    ],
    groupBys: ['picking_type', 'state', 'partner_id', 'scheduled_date'],
    kanban: { groupBy: 'state', title: 'name', lines: ['partner_id', 'origin', 'scheduled_date'], badge: 'picking_type' },
    list: ['name', 'partner_id', 'origin', 'scheduled_date', 'picking_type', 'state'],
    views: ['list', 'kanban', 'calendar'],
    calendar: { date: 'scheduled_date' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => ['done', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Mark as Todo', primary: true, vals: { state: 'ready' }, when: (r) => r.state === 'draft' },
        {
          label: 'Validate', primary: true, when: (r) => r.state === 'ready',
          run: (db, r) => {
            const sign = r.picking_type === 'incoming' ? 1 : r.picking_type === 'outgoing' ? -1 : 0;
            let next = write(moveStock(db, r.move_ids, sign), 'stock.picking', r.id, { state: 'done', date_done: today() });
            if (r.purchase_id) next = write(next, 'purchase.order', r.purchase_id, { receipt_done: true });
            return { db: next };
          },
        },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => ['draft', 'ready'].includes(r.state) },
      ],
      title: 'name',
      groups: [['partner_id', 'picking_type', 'origin'], ['scheduled_date', 'date_done']],
      tabs: [{ label: 'Operations', fields: ['move_ids'] }],
      chatter: true,
    },
  },

  product: {
    label: 'Products',
    fields: {
      name: { type: 'char', label: 'Product Name', required: true },
      default_code: { type: 'char', label: 'Internal Reference' },
      type: { type: 'selection', label: 'Product Type', options: [['goods', 'Goods'], ['service', 'Service']] },
      categ: { type: 'char', label: 'Category' },
      uom: { type: 'selection', label: 'Unit of Measure', options: [['unit', 'Units'], ['kg', 'kg'], ['m', 'm'], ['l', 'L'], ['hour', 'Hours'], ['box', 'Box']] },
      attributes: { type: 'char', label: 'Attributes' },
      variant_of: { type: 'many2one', relation: 'product', label: 'Variant of', readonly: true },
      variant_values: { type: 'tags', label: 'Variant Values', readonly: true },
      list_price: { type: 'monetary', label: 'Sales Price' },
      cost: { type: 'monetary', label: 'Cost' },
      qty_available: { type: 'float', label: 'On Hand', readonly: true },
      reorder_min: { type: 'float', label: 'Min. Quantity' },
      website_published: { type: 'boolean', label: 'Sold Online' },
    },
    defaults: () => ({ type: 'goods', uom: 'unit', list_price: 0, cost: 0, qty_available: 0, reorder_min: 0 }),
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
        { label: 'Generate Variants', when: (r) => !r.variant_of && parseAttributes(r.attributes).length, run: (db, r) => ({ db: generateVariants(db, r) }) },
      ],
      smart: [{ label: 'Variants', model: 'product', field: 'variant_of', target: 'inventory/products' }],
      groups: [['default_code', 'type', 'categ', 'uom'], ['list_price', 'cost', 'qty_available', 'reorder_min'], ['attributes', 'variant_of', 'variant_values']],
      chatter: true,
    },
  },

  'sale.order': {
    label: 'Quotations',
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer', required: true },
      pricelist_id: { type: 'many2one', relation: 'product.pricelist', label: 'Pricelist' },
      date_order: { type: 'date', label: 'Order Date' },
      validity_date: { type: 'date', label: 'Expiration' },
      user: { type: 'char', label: 'Salesperson' },
      source: { type: 'selection', label: 'Source', readonly: true, options: [['backend', 'Backend'], ['website', 'Website']] },
      state: orderState([['draft', 'Quotation'], ['sent', 'Quotation Sent'], ['sale', 'Sales Order'], ['cancel', 'Cancelled']]),
      order_line: productLines('Order Lines', 'list_price'),
      ...amountFields('order_line'),
    },
    onchange: (r, key, db) => {
      if (key !== 'partner_id' || !r.partner_id) return {};
      const p = (db.records['res.partner'] ?? []).find((x) => x.id === r.partner_id);
      return p ? { pricelist_id: p.pricelist_id ?? null } : {};
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
        { label: 'Send by Email', email: 'document', vals: { state: 'sent' }, when: (r) => ['draft', 'sent'].includes(r.state) },
        { label: 'Print', run: (db, r) => ({ db, go: `#/print/sale.order/${r.id}` }) },
        {
          label: 'Confirm',
          primary: true,
          when: (r) => ['draft', 'sent'].includes(r.state),
          run: (db, r) => ({ db: createPicking(write(db, 'sale.order', r.id, { state: 'sale' }), { type: 'outgoing', partner_id: r.partner_id, origin: r.name, lines: r.order_line, link: { sale_id: r.id } }) }),
        },
        { label: 'Create Invoice', primary: true, when: (r) => r.state === 'sale', run: (db, r) => invoiceFrom(db, r, 'out_invoice', 'sale_id') },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => !['cancel', 'sale'].includes(r.state) },
      ],
      smart: [
        { label: 'Delivery', model: 'stock.picking', field: 'sale_id', target: 'inventory/transfers' },
        { label: 'Invoices', model: 'account.move', field: 'sale_id', target: 'accounting/invoices' },
      ],
      title: 'name',
      groups: [['partner_id', 'pricelist_id'], ['date_order', 'validity_date', 'user']],
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
        { label: 'Send RFQ', email: 'document', vals: { state: 'sent' }, when: (r) => ['draft', 'sent'].includes(r.state) },
        { label: 'Print', run: (db, r) => ({ db, go: `#/print/purchase.order/${r.id}` }) },
        {
          label: 'Confirm Order', primary: true, when: (r) => ['draft', 'sent'].includes(r.state),
          run: (db, r) => ({ db: createPicking(write(db, 'purchase.order', r.id, { state: 'purchase' }), { type: 'incoming', partner_id: r.partner_id, origin: r.name, lines: r.order_line, link: { purchase_id: r.id } }) }),
        },
        { label: 'Create Bill', when: (r) => r.state === 'purchase', run: (db, r) => invoiceFrom(db, r, 'in_invoice', 'purchase_id') },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => !['cancel', 'purchase'].includes(r.state) },
      ],
      smart: [
        { label: 'Receipt', model: 'stock.picking', field: 'purchase_id', target: 'inventory/transfers' },
        { label: 'Bills', model: 'account.move', field: 'purchase_id', target: 'accounting/bills' },
      ],
      ribbon: (r) => (r.receipt_done ? 'Received' : null),
      title: 'name',
      groups: [['partner_id'], ['date_order', 'date_planned']],
      tabs: [{ label: 'Products', fields: ['order_line'] }],
      footer: ['amount_untaxed', 'amount_tax', 'amount_total'],
      chatter: true,
    },
  },
};
