import { create, read, search, write } from '../orm.js';
import { adjustQuantity, moveValued } from './valuation.js';
import { addShipping, applyLots, shippingPrice } from './logistics.js';
import { procure } from './routes.js';
import { createOrderTransfers } from './warehouse.js';
import { checkCreditLimit } from './finance.js';
import { pickingAvailability, reservePicking, returnableQty, returnPicking, validatePicking } from './picking.js';
import { canValidatePicking, createChecks } from './qualityplus.js';
import { applicablePrograms, applyCode, computeRewardLines, consumeOrderCodes } from './loyalty.js';
import { dueDate } from './terms.js';
import { convert, convertPrice, uomForLegacy } from './uom.js';
import { rateAt } from './currency.js';
import { fiscalPositionFor } from './taxes.js';
import { addDays, amounts, amountFields, monthFilters, pad, productLines, today } from './common.js';

/** Adjust on-hand quantity of stockable products by `sign` × line quantity. */
export function moveStock(db, lines = [], sign) {
  return lines.reduce((acc, l) => {
    const p = read(acc, 'product', l.product_id);
    if (!p || p.type !== 'goods') return acc;
    return write(acc, 'product', p.id, { qty_available: (Number(p.qty_available) || 0) + sign * (Number(l.qty) || 0) });
  }, db);
}

/** Create a ready transfer (delivery or receipt) for the stockable lines of an order; no-op when nothing to move. */
export function createPicking(db, args) {
  return createOrderTransfers(db, args);
}

const stockUnitOf = (db, l) => {
  const p = read(db, 'product', l.product_id);
  return p?.uom_id ?? uomForLegacy(db, p?.uom ?? 'unit')?.id;
};
/** An order-line quantity in the product's stock unit (and back), unrounded. */
const toStock = (db, l, qty) => (l.uom_id ? convert(db, qty, l.uom_id, stockUnitOf(db, l), { round: false }) : qty);
const fromStock = (db, l, qty) => (l.uom_id ? convert(db, qty, stockUnitOf(db, l), l.uom_id, { round: false }) : qty);
/** The order line a stock move came from (moves of order transfers carry `so_line`), when it still matches. */
const sourceLine = (order, m) => (Number.isInteger(m.so_line) && order.order_line[m.so_line]?.product_id === m.product_id ? m.so_line : null);

/**
 * Add per-product quantities to the order lines' `field` (qty_delivered / qty_invoiced). A delivered move goes to the
 * line it came from; everything else fills the matching lines in order.
 * ponytail: invoices carry no line link, so two invoiced lines of the same product share the quantity first-come.
 */
function addLineQty(db, model, order, field, moves) {
  const left = new Map();
  const lines = order.order_line.map((l) => ({ ...l }));
  const room = (l) => toStock(db, l, (Number(l.qty) || 0) - (Number(l[field]) || 0));
  const put = (l, take) => { l[field] = (Number(l[field]) || 0) + fromStock(db, l, take); };
  for (const m of moves) {
    const qty = Number(m.qty) || 0;
    const ix = field === 'qty_delivered' ? sourceLine(order, m) : null;
    if (ix == null) { left.set(m.product_id, (left.get(m.product_id) ?? 0) + (field === 'qty_invoiced' ? toStock(db, m, qty) : qty)); continue; }
    const take = Math.max(0, Math.min(room(lines[ix]), qty));
    if (take) put(lines[ix], take);
    if (qty - take > 1e-9) left.set(m.product_id, (left.get(m.product_id) ?? 0) + qty - take);
  }
  for (const l of lines) {
    const take = Math.max(0, Math.min(room(l), left.get(l.product_id) ?? 0));
    left.set(l.product_id, (left.get(l.product_id) ?? 0) - take);
    if (take) put(l, take);
  }
  return write(db, model, order.id, { order_line: lines });
}

/**
 * Take returned quantities (stock units) back off the order lines' `field`: from the line each move came from, and
 * anything unlinked from the last matching line backwards.
 */
function removeLineQty(db, model, order, field, moves) {
  const left = new Map();
  const lines = order.order_line.map((l) => ({ ...l }));
  const have = (l) => toStock(db, l, Number(l[field]) || 0);
  const take = (l, qty) => { l[field] = (Number(l[field]) || 0) - fromStock(db, l, qty); };
  for (const m of moves) {
    const qty = Number(m.qty) || 0;
    const ix = sourceLine(order, m);
    const here = ix == null ? 0 : Math.min(have(lines[ix]), qty);
    if (here) take(lines[ix], here);
    if (qty - here > 1e-9) left.set(m.product_id, (left.get(m.product_id) ?? 0) + qty - here);
  }
  for (const l of [...lines].reverse()) {
    const n = Math.min(have(l), left.get(l.product_id) ?? 0);
    left.set(l.product_id, (left.get(l.product_id) ?? 0) - n);
    if (n) take(l, n);
  }
  return write(db, model, order.id, { order_line: lines });
}

/** Per product, the order quantity not delivered yet, in stock units. */
function undelivered(db, order) {
  const left = new Map();
  for (const l of order.order_line ?? []) {
    const p = read(db, 'product', l.product_id);
    const stock = p?.uom_id ?? uomForLegacy(db, p?.uom ?? 'unit')?.id;
    const qty = Math.max(0, (Number(l.qty) || 0) - (Number(l.qty_delivered) || 0));
    left.set(l.product_id, (left.get(l.product_id) ?? 0) + (l.uom_id ? convert(db, qty, l.uom_id, stock) : qty)); // rounded up like the transfer demand
  }
  return left;
}

/**
 * Why a transfer cannot be validated with these done quantities: a delivery may not ship more than its sales order
 * still has to deliver, and returns of one transfer may not exceed what it moved.
 */
export function overDeliveryError(db, picking) {
  const done = new Map();
  for (const l of picking.move_ids ?? []) {
    const qty = l.quantity == null || l.quantity === '' ? Number(l.qty) || 0 : Number(l.quantity) || 0;
    done.set(l.product_id, (done.get(l.product_id) ?? 0) + qty);
  }
  const name = (id) => read(db, 'product', id)?.name ?? `#${id}`;
  if (picking.return_of) {
    const original = read(db, 'stock.picking', picking.return_of);
    const left = original ? returnableQty(db, original) : new Map();
    // returnableQty already counts this return's demand; its done quantity must fit what that leaves plus the demand.
    for (const l of picking.move_ids ?? []) left.set(l.product_id, (left.get(l.product_id) ?? 0) + (Number(l.qty) || 0));
    const over = [...done].find(([id, qty]) => qty > (left.get(id) ?? 0) + 1e-9);
    return over ? `Returning ${over[1]} ${name(over[0])} is more than ${original?.name ?? 'the original transfer'} has left to return (${left.get(over[0]) ?? 0})` : null;
  }
  const order = picking.picking_type === 'outgoing' && picking.sale_id && read(db, 'sale.order', picking.sale_id);
  if (!order) return null;
  const left = undelivered(db, order);
  const over = [...done].find(([id, qty]) => qty > (left.get(id) ?? 0) + 1e-9);
  return over ? `Delivering ${over[1]} ${name(over[0])} is more than ${order.name} still has to deliver (${left.get(over[0]) ?? 0})` : null;
}

/** Recompute an order's invoiced quantities from its invoices/bills that are not cancelled (`move` is one of them). */
export function syncInvoicedQty(db, move) {
  const [model, field] = move.sale_id ? ['sale.order', 'sale_id'] : move.purchase_id ? ['purchase.order', 'purchase_id'] : [];
  const order = model && read(db, model, move[field]);
  if (!order) return db;
  const moves = search(db, 'account.move').filter((m) => m[field] === order.id && m.state !== 'cancel');
  const reset = write(db, model, order.id, { order_line: order.order_line.map((l) => ({ ...l, qty_invoiced: 0 })) });
  return addLineQty(reset, model, read(reset, model, order.id), 'qty_invoiced', moves.flatMap((m) => m.invoice_line_ids ?? []));
}

/** Invoice/bill what is not invoiced yet (ordered quantities) and return where to go. */
function invoiceFrom(db, order, moveType, originField) {
  const invoiceable = (l) => (read(db, 'product', l.product_id)?.invoice_policy === 'delivery' ? Number(l.qty_delivered) || 0 : Number(l.qty) || 0);
  const lines = order.order_line
    .map((l) => ({ ...l, qty: invoiceable(l) - (Number(l.qty_invoiced) || 0) }))
    .filter((l) => l.qty > 0)
    .map(({ qty_invoiced, qty_delivered, ...l }) => l);
  if (!lines.length) throw new Error('Nothing left to invoice: everything ordered or delivered is already invoiced');
  const term = read(db, 'account.payment.term', order.payment_term_id);
  const { db: next, id } = create(db, 'account.move', {
    move_type: moveType,
    partner_id: order.partner_invoice_id ?? order.partner_id,
    invoice_date: today(),
    invoice_payment_term_id: term?.id ?? null,
    invoice_date_due: term ? dueDate(term, today()) : addDays(today(), 30),
    invoice_origin: order.name,
    fiscal_position_id: order.fiscal_position_id ?? null,
    [originField]: order.id,
    invoice_line_ids: lines,
  });
  return { db: syncInvoicedQty(next, read(next, 'account.move', id)), go: `#/accounting/${moveType === 'out_invoice' ? 'invoices' : 'bills'}/${id}` };
}

const orderLines = (label, priceField = 'list_price') => {
  const base = productLines(label, priceField);
  return { ...base, fields: { ...base.fields, qty_delivered: { type: 'float', label: 'Delivered', readonly: true }, qty_invoiced: { type: 'float', label: 'Invoiced', readonly: true } } };
};
const invoiceStatus = (r, confirmed) => {
  if (r.state !== confirmed) return 'no';
  return (r.order_line ?? []).every((l) => (Number(l.qty_invoiced) || 0) >= (Number(l.qty) || 0)) ? 'invoiced' : 'to_invoice';
};
const INVOICE_STATUS = [['no', 'Nothing to Invoice'], ['to_invoice', 'To Invoice'], ['invoiced', 'Fully Invoiced']];

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
    type: template.type, categ: template.categ, uom: template.uom, ...(template.uom_id ? { uom_id: template.uom_id } : {}), ...(template.uom_po_id ? { uom_po_id: template.uom_po_id } : {}), list_price: template.list_price, cost: template.cost,
    qty_available: 0, reorder_min: 0, variant_of: template.id, variant_values: values,
  }).db, db);
}

/** Fallback without the WhatsApp API: open a wa.me chat with the order summary prefilled. */
export function openWhatsApp(db, r) {
  const partner = r.email !== undefined && r.phone !== undefined && !r.partner_id ? r : read(db, 'res.partner', r.partner_id);
  const phone = String(partner?.phone ?? '').replace(/[^\d]/g, '');
  if (!phone) throw new Error('The contact has no phone number');
  const text = r.name && r.amount_total != null ? `${r.name}: ${Number(r.amount_total).toFixed(2)}` : '';
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  return { db };
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
      carrier_id: { type: 'many2one', relation: 'delivery.carrier', label: 'Carrier' },
      location_id: { type: 'many2one', relation: 'stock.location', label: 'Source Location' },
      location_dest_id: { type: 'many2one', relation: 'stock.location', label: 'Destination Location' },
      carrier_tracking_ref: { type: 'char', label: 'Tracking Reference' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['waiting', 'Waiting'], ['ready', 'Ready'], ['done', 'Done'], ['cancel', 'Cancelled']] },
      priority: { type: 'priority', label: 'Priority' },
      backorder_id: { type: 'many2one', relation: 'stock.picking', label: 'Back Order of', readonly: true },
      return_of: { type: 'many2one', relation: 'stock.picking', label: 'Return of', readonly: true },
      note: { type: 'text', label: 'Note' },
      move_ids: {
        type: 'one2many',
        label: 'Operations',
        // qty is the demand; quantity is what was actually done (empty = all of the demand).
        fields: { product_id: { type: 'many2one', relation: 'product', label: 'Product' }, qty: { type: 'float', label: 'Demand' }, quantity: { type: 'float', label: 'Quantity' }, lot_name: { type: 'char', label: 'Lot/Serial Number' }, expiration_date: { type: 'date', label: 'Expiration Date' }, so_line: { type: 'integer', label: 'Order Line', hidden: true } },
        newLine: () => ({ product_id: null, qty: 1, quantity: null, lot_name: '' }),
      },
    },
    defaults: (id) => ({ name: `WH/${pad(id)}`, picking_type: 'outgoing', scheduled_date: today(), state: 'draft', move_ids: [] }),
    filters: [
      [{ id: 'receipts', label: 'Receipts', fn: (r) => r.picking_type === 'incoming' }, { id: 'deliveries', label: 'Deliveries', fn: (r) => r.picking_type === 'outgoing' }],
      [{ id: 'ready', label: 'Ready', fn: (r) => r.state === 'ready' }, { id: 'waiting', label: 'Waiting', fn: (r) => r.state === 'waiting' }, { id: 'late', label: 'Late', fn: (r) => ['ready', 'waiting'].includes(r.state) && r.scheduled_date < today() }, { id: 'backorders', label: 'Backorders', fn: (r) => !!r.backorder_id }],
    ],
    groupBys: ['picking_type', 'state', 'partner_id', 'scheduled_date'],
    kanban: { groupBy: 'state', title: 'name', lines: ['partner_id', 'origin', 'scheduled_date'], badge: 'picking_type', priority: 'priority' },
    list: ['name', 'partner_id', 'origin', 'scheduled_date', 'picking_type', 'state'],
    views: ['list', 'kanban', 'calendar'],
    calendar: { date: 'scheduled_date' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => ['done', 'cancel'].includes(r.state),
      buttons: [
        // Planning a transfer also creates the quality checks its control points require.
        { label: 'Mark as Todo', primary: true, when: (r) => r.state === 'draft', run: (db, r) => { const reserved = reservePicking(db, r); return { db: createChecks(reserved, read(reserved, 'stock.picking', r.id)) }; } },
        { label: 'Check Availability', primary: true, when: (r) => r.state === 'waiting', run: (db, r) => ({ db: reservePicking(db, r) }) },
        {
          // Done quantities below the demand ask whether the rest becomes a backorder (Odoo's backorder wizard).
          label: 'Validate', primary: true, when: (r) => ['ready', 'waiting'].includes(r.state),
          run: (db, r) => {
            const quality = canValidatePicking(db, r);
            if (!quality.ok) throw new Error(`${quality.pending} quality check(s) still to do before validating`);
            const over = overDeliveryError(db, r);
            if (over) throw new Error(over);
            const partial = (r.move_ids ?? []).some((l) => l.quantity != null && l.quantity !== '' && Number(l.quantity) < Number(l.qty));
            const backorder = !partial || typeof confirm !== 'function' || confirm('Create a backorder for the remaining quantities?');
            const out = validatePicking(db, r, { backorder, apply: (d, p, sign) => {
              const original = p.return_of ? read(d, 'stock.picking', p.return_of) : null;
              const po = read(d, 'purchase.order', p.purchase_id) || search(d, 'purchase.order').find((o) => o.name === p.origin);
              // Receipts are valued in the receiving company's currency, so a foreign purchase price is converted at the receipt date.
              const poRate = po ? rateAt(d, po.currency_id, today(), po.company_id) : 1;
              const purchase = (po?.order_line ?? []).map((l) => {
                const product = read(d, 'product', l.product_id);
                const stock = product?.uom_id ?? uomForLegacy(d, product?.uom ?? 'unit')?.id;
                const remaining = Math.max(0, Number(l.qty) - (Number(l.qty_delivered) || 0));
                return { ...l, remaining: l.uom_id ? convert(d, remaining, l.uom_id, stock, { round: false }) : remaining,
                  price_unit: (l.uom_id ? convertPrice(d, l.price_unit, l.uom_id, stock) : Number(l.price_unit)) / poRate };
              });
              const lines = p.move_ids.map((m) => {
                const source = original && search(d, 'stock.valuation.layer').filter((l) => l.picking_id === original.id && l.product_id === m.product_id && !l.opening);
                const qty = source?.reduce((s, l) => s + Math.abs(l.quantity), 0);
                let left = Number(m.qty);
                let value = 0;
                for (const l of purchase.filter((l) => l.product_id === m.product_id)) {
                  const take = Math.min(left, l.remaining);
                  value += take * Number(l.price_unit);
                  l.remaining -= take;
                  left -= take;
                }
                const unit_cost = qty ? source.reduce((s, l) => s + Math.abs(l.value), 0) / qty
                  : po ? (value + left * (Number(read(d, 'product', m.product_id)?.cost) || 0)) / Number(m.qty) : undefined;
                return { ...m, unit_cost, valuation_options: original ? { counterpart: sign > 0 ? '500000' : '110200', actualCost: true } : {} };
              });
              return moveValued(applyLots(d, p, sign || 0), lines, sign, { reference: p.name, pickingId: p.id });
            } });
            let next = out.db;
            if (r.purchase_id && !r.return_of && !out.backorderId) next = write(next, 'purchase.order', r.purchase_id, { receipt_done: true });
            const order = r.sale_id ? read(next, 'sale.order', r.sale_id) : r.purchase_id ? read(next, 'purchase.order', r.purchase_id) : null;
            // A return takes its quantities back off the order; anything else adds to what was delivered.
            if (order) next = (r.return_of ? removeLineQty : addLineQty)(next, r.sale_id ? 'sale.order' : 'purchase.order', order, 'qty_delivered', out.done);
            return { db: next };
          },
        },
        { label: 'Return', when: (r) => r.state === 'done', run: (db, r) => { const out = returnPicking(db, r); return { db: out.db, go: `#/inventory/transfers/${out.id}` }; } },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => ['draft', 'waiting', 'ready'].includes(r.state) },
      ],
      title: 'name',
      groups: [['partner_id', 'picking_type', 'origin', 'location_id', 'location_dest_id'], ['scheduled_date', 'date_done', 'priority', 'carrier_id', 'carrier_tracking_ref', 'backorder_id', 'return_of']],
      tabs: [{ label: 'Operations', fields: ['move_ids'] }, { label: 'Note', fields: ['note'] }],
      ribbon: (r) => (r.state === 'waiting' ? 'Waiting' : null),
      chatter: true,
    },
  },

  product: {
    label: 'Products',
    fields: {
      name: { type: 'char', label: 'Product Name', required: true },
      default_code: { type: 'char', label: 'Internal Reference' },
      barcode: { type: 'char', label: 'Barcode' },
      sale_ok: { type: 'boolean', label: 'Can be Sold' },
      purchase_ok: { type: 'boolean', label: 'Can be Purchased' },
      available_in_pos: { type: 'boolean', label: 'Available in POS' },
      can_be_expensed: { type: 'boolean', label: 'Can be Expensed' },
      invoice_policy: { type: 'selection', label: 'Invoicing Policy', options: [['order', 'Ordered quantities'], ['delivery', 'Delivered quantities']] },
      sale_tax: { type: 'float', label: 'Sales Tax %' },
      purchase_tax: { type: 'float', label: 'Purchase Tax %' },
      tax_id: { type: 'many2one', relation: 'account.tax', label: 'Sales Taxes' },
      supplier_tax_id: { type: 'many2one', relation: 'account.tax', label: 'Purchase Taxes' },
      property_account_income_id: { type: 'many2one', relation: 'account.account', label: 'Income Account' },
      property_account_expense_id: { type: 'many2one', relation: 'account.account', label: 'Expense Account' },
      description: { type: 'text', label: 'Internal Notes' },
      type: { type: 'selection', label: 'Product Type', options: [['goods', 'Goods'], ['service', 'Service']] },
      categ: { type: 'char', label: 'Category' },
      weight: { type: 'float', label: 'Weight (kg)' },
      route: { type: 'selection', label: 'Route', options: [['stock', 'From Stock'], ['mto_buy', 'Buy on Order'], ['mto_make', 'Manufacture on Order'], ['dropship', 'Dropship']] },
      vendor_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor' },
      tracking: { type: 'selection', label: 'Tracking', options: [['none', 'No Tracking'], ['lot', 'By Lots'], ['serial', 'By Unique Serial Number']] },
      uom: { type: 'selection', label: 'Unit of Measure', options: [['unit', 'Units'], ['kg', 'kg'], ['m', 'm'], ['l', 'L'], ['hour', 'Hours'], ['box', 'Box']] },
      uom_id: { type: 'many2one', relation: 'uom.uom', label: 'Stock / Sales Unit' },
      uom_po_id: { type: 'many2one', relation: 'uom.uom', label: 'Purchase Unit' },
      attributes: { type: 'char', label: 'Attributes' },
      variant_of: { type: 'many2one', relation: 'product', label: 'Variant of', readonly: true },
      variant_values: { type: 'tags', label: 'Variant Values', readonly: true },
      list_price: { type: 'monetary', label: 'Sales Price' },
      cost: { type: 'monetary', label: 'Cost' },
      qty_available: { type: 'float', label: 'On Hand', readonly: true },
      reorder_min: { type: 'float', label: 'Min. Quantity' },
      reorder_max: { type: 'float', label: 'Max. Quantity' },
      website_published: { type: 'boolean', label: 'Sold Online' },
    },
    guard: (db, before, r) => {
      if (!r.uom_po_id) return null;
      const stock = r.uom_id ? read(db, 'uom.uom', r.uom_id) : uomForLegacy(db, r.uom ?? 'unit');
      const purchase = read(db, 'uom.uom', r.uom_po_id);
      return !stock || !purchase ? 'Select existing stock and purchase units of measure'
        : stock.category_id !== purchase.category_id ? 'Stock and purchase units must belong to the same category' : null;
    },
    defaults: () => ({ type: 'goods', uom: 'unit', list_price: 0, cost: 0, qty_available: 0, reorder_min: 0, sale_ok: true, purchase_ok: true, invoice_policy: 'order', sale_tax: 14, purchase_tax: 14 }),
    filters: [
      [{ id: 'goods', label: 'Goods', fn: (r) => r.type === 'goods' }, { id: 'services', label: 'Services', fn: (r) => r.type === 'service' }],
      [{ id: 'low', label: 'Below Minimum', fn: (r) => r.type === 'goods' && r.qty_available < r.reorder_min }],
      [{ id: 'sale_ok', label: 'Can be Sold', fn: (r) => r.sale_ok !== false }, { id: 'purchase_ok', label: 'Can be Purchased', fn: (r) => r.purchase_ok !== false }, { id: 'pos', label: 'Available in POS', fn: (r) => r.available_in_pos }],
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
            if (qty == null || Number.isNaN(Number(qty)) || Number(qty) < 0) return { db };
            // An inventory adjustment, so stock valuation follows the new quantity.
            return { db: adjustQuantity(db, r.id, Number(qty), { reference: `Quantity update: ${r.name}` }) };
          },
          when: (r) => r.type === 'goods',
        },
        { label: 'Generate Variants', when: (r) => !r.variant_of && parseAttributes(r.attributes).length, run: (db, r) => ({ db: generateVariants(db, r) }) },
      ],
      smart: [{ label: 'Variants', model: 'product', field: 'variant_of', target: 'inventory/products' }],
      groups: [['sale_ok', 'purchase_ok', 'available_in_pos', 'can_be_expensed'], ['default_code', 'barcode', 'type', 'categ', 'uom', 'uom_id', 'uom_po_id', 'weight', 'tracking'], ['list_price', 'sale_tax', 'cost', 'purchase_tax', 'invoice_policy', 'qty_available', 'reorder_min', 'reorder_max', 'route', 'vendor_id'], ['attributes', 'variant_of', 'variant_values']],
      tabs: [{ label: 'Accounting', fields: ['property_account_income_id', 'property_account_expense_id'] }, { label: 'Internal Notes', fields: ['description'] }],
      chatter: true,
    },
  },

  'sale.order': {
    label: 'Quotations',
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer', required: true },
      partner_invoice_id: { type: 'many2one', relation: 'res.partner', label: 'Invoice Address' },
      partner_shipping_id: { type: 'many2one', relation: 'res.partner', label: 'Delivery Address' },
      pricelist_id: { type: 'many2one', relation: 'product.pricelist', label: 'Pricelist' },
      payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Payment Terms' },
      fiscal_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position' },
      carrier_id: { type: 'many2one', relation: 'delivery.carrier', label: 'Delivery Method' },
      date_order: { type: 'date', label: 'Order Date' },
      commitment_date: { type: 'date', label: 'Promised Delivery' },
      note: { type: 'text', label: 'Terms and Conditions' },
      invoice_status: { type: 'selection', label: 'Invoice Status', options: INVOICE_STATUS, compute: (r) => invoiceStatus(r, 'sale') },
      validity_date: { type: 'date', label: 'Expiration' },
      user: { type: 'char', label: 'Salesperson' },
      source: { type: 'selection', label: 'Source', readonly: true, options: [['backend', 'Backend'], ['website', 'Website'], ['marketplace', 'Marketplace']] },
      client_order_ref: { type: 'char', label: 'Customer Reference', readonly: true },
      connector_id: { type: 'many2one', relation: 'marketplace.connector', label: 'Marketplace', readonly: true },
      opportunity_id: { type: 'many2one', relation: 'crm.lead', label: 'Opportunity', readonly: true },
      state: orderState([['draft', 'Quotation'], ['sent', 'Quotation Sent'], ['sale', 'Sales Order'], ['cancel', 'Cancelled']]),
      order_line: orderLines('Order Lines'),
      ...amountFields('order_line'),
    },
    onchange: (r, key, db) => {
      if (key !== 'partner_id' || !r.partner_id) return {};
      const p = (db.records['res.partner'] ?? []).find((x) => x.id === r.partner_id);
      return p ? { pricelist_id: p.pricelist_id ?? null, payment_term_id: p.property_payment_term_id ?? null, partner_invoice_id: p.id, partner_shipping_id: p.id, fiscal_position_id: fiscalPositionFor(db, p.id) } : {};
    },
    defaults: (id) => ({ name: 'S' + pad(id), date_order: today(), validity_date: addDays(today(), 30), user: 'Admin', state: 'draft', order_line: [] }),
    filters: [
      [{ id: 'quotations', label: 'Quotations', fn: (r) => ['draft', 'sent'].includes(r.state) }, { id: 'orders', label: 'Sales Orders', fn: (r) => r.state === 'sale' }],
      monthFilters('date_order'),
    ],
    groupBys: ['state', 'invoice_status', 'partner_id', 'user', 'date_order'],
    views: ['list', 'kanban', 'graph', 'pivot', 'calendar'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total'], badge: 'state' },
    list: ['name', 'date_order', 'partner_id', 'user', 'amount_total', 'invoice_status', 'state'],
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
        { label: 'WhatsApp', server: '/api/integrations/whatsapp', requires: 'whatsapp', run: (db, r) => openWhatsApp(db, r) },
        {
          // Promotion, discount code, coupon or gift card code typed by the salesperson.
          label: 'Apply Coupon', when: (r) => ['draft', 'sent'].includes(r.state),
          run: (db, r) => {
            const code = prompt('Promotion, coupon or gift card code')?.trim();
            if (!code) return { db };
            const uses = r.loyalty_uses ?? [];
            if (uses.some((u) => u.code === code)) throw new Error('This code is already applied to this order');
            const applied = applyCode(db, r, code, { channel: 'sale' });
            const gift = read(db, 'loyalty.program', applied.programId)?.program_type === 'gift_card';
            // Recorded now, consumed when the order is confirmed.
            const use = { code, programId: applied.programId, cardCode: applied.card?.code, gift, spent: applied.pointsSpent };
            return { db: write(db, 'sale.order', r.id, { order_line: applied.lines, loyalty_uses: [...uses, use] }) };
          },
        },
        {
          // Automatic promotions the order qualifies for (Odoo's "Promotions" button).
          label: 'Promotions', when: (r) => ['draft', 'sent'].includes(r.state),
          run: (db, r) => {
            const programs = applicablePrograms(db, r, { lines: r.order_line ?? [], partnerId: r.partner_id, channel: 'sale' }).filter((p) => p.trigger !== 'with_code' && ['promotion', 'buy_x_get_y'].includes(p.program_type));
            if (!programs.length) throw new Error('No promotion applies to this order');
            const added = programs.flatMap((p) => (p.reward_ids ?? []).flatMap((rw) => computeRewardLines(db, p, rw, r.order_line ?? [])));
            return { db: write(db, 'sale.order', r.id, { order_line: [...(r.order_line ?? []), ...added] }) };
          },
        },
        {
          label: 'Add Shipping', when: (r) => r.carrier_id && ['draft', 'sent'].includes(r.state),
          // API carriers are quoted by the server; fixed/rule carriers are computed here.
          server: '/api/integrations/shipping-rate', requires: 'shipping_api',
          run: (db, r) => {
            const carrier = read(db, 'delivery.carrier', r.carrier_id);
            return { db: addShipping(db, r, shippingPrice(db, carrier, r)) };
          },
        },
        {
          label: 'Confirm',
          primary: true,
          when: (r) => ['draft', 'sent'].includes(r.state),
          // Routes first (MTO buy/make, dropship), then a delivery for what ships from our stock.
          run: (db, r) => {
            checkCreditLimit(db, r.partner_id, amounts(r.order_line).total);
            const { db: procured, stockLines } = procure(write(consumeOrderCodes(db, r), 'sale.order', r.id, { state: 'sale' }), r);
            return { db: createPicking(procured, { type: 'outgoing', partner_id: r.partner_shipping_id ?? r.partner_id, origin: r.name, lines: stockLines, link: { sale_id: r.id }, carrier_id: r.carrier_id ?? null, scheduled_date: r.commitment_date }) };
          },
        },
        { label: 'Create Invoice', primary: true, when: (r) => r.state === 'sale' && invoiceStatus(r, 'sale') === 'to_invoice', run: (db, r) => invoiceFrom(db, r, 'out_invoice', 'sale_id') },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => !['cancel', 'sale'].includes(r.state) },
      ],
      smart: [
        { label: 'Delivery', model: 'stock.picking', field: 'sale_id', target: 'inventory/transfers' },
        { label: 'Invoices', model: 'account.move', field: 'sale_id', target: 'accounting/invoices' },
      ],
      title: 'name',
      groups: [['partner_id', 'partner_invoice_id', 'partner_shipping_id', 'pricelist_id', 'carrier_id'], ['date_order', 'validity_date', 'payment_term_id', 'commitment_date', 'user']],
      tabs: [{ label: 'Order Lines', fields: ['order_line'] }, { label: 'Notes', fields: ['note'] }],
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
      payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Payment Terms' },
      fiscal_position_id: { type: 'many2one', relation: 'account.fiscal.position', label: 'Fiscal Position' },
      invoice_status: { type: 'selection', label: 'Billing Status', options: INVOICE_STATUS, compute: (r) => invoiceStatus(r, 'purchase') },
      origin: { type: 'char', label: 'Source Document', readonly: true },
      dropship_partner_id: { type: 'many2one', relation: 'res.partner', label: 'Dropship Address', readonly: true },
      order_line: orderLines('Products', 'cost'),
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
          // Dropship orders go vendor → customer directly: no receipt into our stock.
          run: (db, r) => {
            const confirmed = write(db, 'purchase.order', r.id, { state: 'purchase', ...(r.dropship_partner_id ? { receipt_done: true } : {}) });
            return { db: r.dropship_partner_id ? confirmed : createPicking(confirmed, { type: 'incoming', partner_id: r.partner_id, origin: r.name, lines: r.order_line, link: { purchase_id: r.id } }) };
          },
        },
        { label: 'Create Bill', when: (r) => r.state === 'purchase' && invoiceStatus(r, 'purchase') === 'to_invoice', run: (db, r) => invoiceFrom(db, r, 'in_invoice', 'purchase_id') },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => !['cancel', 'purchase'].includes(r.state) },
      ],
      smart: [
        { label: 'Receipt', model: 'stock.picking', field: 'purchase_id', target: 'inventory/transfers' },
        { label: 'Bills', model: 'account.move', field: 'purchase_id', target: 'accounting/bills' },
      ],
      ribbon: (r) => (r.receipt_done ? 'Received' : null),
      title: 'name',
      groups: [['partner_id', 'origin', 'dropship_partner_id'], ['date_order', 'date_planned']],
      tabs: [{ label: 'Products', fields: ['order_line'] }],
      footer: ['amount_untaxed', 'amount_tax', 'amount_total'],
      chatter: true,
    },
  },
};
