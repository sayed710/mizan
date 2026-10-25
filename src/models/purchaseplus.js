import { create, read, search, write, postNote } from '../orm.js';
import { today, pad, amounts } from './common.js';
import { salesModels } from './sales.js';
import { vendorPrice } from './routes.js';

export { vendorPrice };

const draft = (r) => ['draft', 'sent'].includes(r.state);
const orders = (db, id) => search(db, 'purchase.order').filter((p) => p.requisition_id === id);
const agreement = (db, id) => {
  const r = read(db, 'purchase.requisition', id);
  if (!r) throw new Error('Purchase agreement not found');
  return r;
};

/** Select a vendor price by validity, quantity, sequence and price. */

/** Return a new order with matching vendor prices, preserving unmatched lines. */
export function applyVendorPrices(db, order) {
  return { ...order, order_line: (order.order_line ?? []).map((l) => {
    const price = vendorPrice(db, l.product_id, { partnerId: order.partner_id, qty: l.qty, date: order.date_order });
    return price ? { ...l, price_unit: price.price } : { ...l };
  }) };
}

/** Return agreement lines with ordered and remaining quantities from confirmed POs. */
export function remainingQty(db, requisitionId) {
  const r = agreement(db, requisitionId);
  const confirmed = orders(db, r.id).filter((p) => p.state === 'purchase');
  return (r.line_ids ?? []).map((l) => {
    const qty_ordered = confirmed.flatMap((p) => p.order_line ?? []).filter((p) => p.product_id === l.product_id)
      .reduce((sum, p) => sum + Number(p.qty || 0), 0);
    return { ...l, qty_ordered, remaining: Math.max(0, Number(l.product_qty) - qty_ordered) };
  });
}

/** Confirm a valid draft agreement. */
export function confirmRequisition(db, id) {
  const r = agreement(db, id);
  if (r.state !== 'draft') throw new Error('Only draft agreements can be confirmed');
  if (!['blanket', 'tender'].includes(r.type)) throw new Error('Select an agreement type');
  if (r.date_start && r.date_end && r.date_start > r.date_end) throw new Error('End date must follow start date');
  if (!r.line_ids?.length || r.line_ids.some((l) => !read(db, 'product', l.product_id) || !(Number(l.product_qty) > 0))) throw new Error('Add products with positive quantities');
  if (new Set(r.line_ids.map((l) => l.product_id)).size !== r.line_ids.length) throw new Error('Use one agreement line per product');
  if (r.type === 'blanket' && !read(db, 'res.partner', r.vendor_id)) throw new Error('A blanket order needs a vendor');
  if (r.type === 'blanket' && r.line_ids.some((l) => !(Number(l.price_unit) > 0))) throw new Error('A blanket order needs positive prices');
  return write(db, 'purchase.requisition', id, { state: 'ongoing' });
}

/** Create a quotation for remaining blanket quantities or the full tender. */
export function newQuotationFromRequisition(db, requisitionId, { partnerId } = {}) {
  const r = agreement(db, requisitionId);
  if (r.state !== 'ongoing') throw new Error('Confirm the agreement before creating quotations');
  if (r.type === 'blanket' && partnerId && partnerId !== r.vendor_id) throw new Error('Use the blanket order vendor');
  const vendor = r.type === 'blanket' ? r.vendor_id : partnerId;
  if (!read(db, 'res.partner', vendor)) throw new Error('Select a valid vendor');
  const lines = remainingQty(db, r.id).map((l) => {
    const qty = r.type === 'blanket' ? l.remaining : Number(l.product_qty);
    const price = vendorPrice(db, l.product_id, { partnerId: vendor, qty, date: today() });
    return { product_id: l.product_id, qty, price_unit: r.type === 'blanket' ? Number(l.price_unit) : price?.price ?? read(db, 'product', l.product_id)?.cost ?? 0, tax: read(db, 'product', l.product_id)?.purchase_tax ?? 14 };
  }).filter((l) => l.qty > 0);
  if (!lines.length) throw new Error('No quantity remains to order');
  const out = create(db, 'purchase.order', { partner_id: vendor, requisition_id: r.id, origin: r.name, order_line: lines });
  return { db: syncAgreement(out.db, r.id), id: out.id };
}

/** Compare active quotations per product; ties all receive the best-price flag. */
export function compareAlternatives(db, requisitionId) {
  const r = agreement(db, requisitionId);
  return (r.line_ids ?? []).map((l) => {
    const alternatives = orders(db, r.id).filter((p) => p.state !== 'cancel').flatMap((p) => (p.order_line ?? []).filter((x) => x.product_id === l.product_id).map((x) => ({
      po_id: p.id, partner_id: p.partner_id, price: Number(x.price_unit), total: amounts([x]).total,
      delay: vendorPrice(db, x.product_id, { partnerId: p.partner_id, qty: x.qty, date: p.date_order })?.delay ?? null,
    })));
    const best = Math.min(...alternatives.map((a) => a.price));
    return { product_id: l.product_id, alternatives: alternatives.map((a) => ({ ...a, best: a.price === best })) };
  });
}

const syncAgreement = (db, id) => write(db, 'purchase.requisition', id, {
  line_ids: remainingQty(db, id).map(({ remaining, ...l }) => l),
  purchase_ids: orders(db, id).map((p) => ({ purchase_id: p.id })),
});

const confirmOrder = (db, r) => {
  if (!draft(r)) throw new Error('Only draft quotations can be confirmed');
  if (r.requisition_id) {
    const req = agreement(db, r.requisition_id);
    if (req.state !== 'ongoing') throw new Error('The agreement must be ongoing');
    if (req.type === 'blanket') {
      if (r.partner_id !== req.vendor_id) throw new Error('Use the blanket order vendor');
      const remaining = remainingQty(db, req.id);
      const products = new Set((r.order_line ?? []).map((l) => l.product_id));
      for (const product of products) {
        const qty = r.order_line.filter((l) => l.product_id === product).reduce((sum, l) => sum + Number(l.qty), 0);
        if (!(qty > 0) || qty > (remaining.find((l) => l.product_id === product)?.remaining ?? 0)) throw new Error('Quantity exceeds the blanket order remaining quantity');
      }
    }
  }
  const out = salesModels['purchase.order'].form.buttons.find((b) => b.label === 'Confirm Order').run(db, r);
  return { ...out, db: r.requisition_id ? syncAgreement(out.db, r.requisition_id) : out.db };
};

/** Confirm the selected tender quotation and cancel its draft alternatives. */
export function chooseAlternative(db, poId) {
  const po = read(db, 'purchase.order', poId);
  if (!po?.requisition_id || agreement(db, po.requisition_id).type !== 'tender') throw new Error('Select a tender quotation');
  if (orders(db, po.requisition_id).some((p) => p.state === 'purchase')) throw new Error('An alternative has already been chosen');
  const confirmed = confirmOrder(db, po).db;
  return orders(confirmed, po.requisition_id).filter((p) => p.id !== poId && draft(p))
    .reduce((next, p) => write(next, 'purchase.order', p.id, { state: 'cancel' }), confirmed);
}

/** Close an ongoing agreement, optionally forcing closure with open blanket RFQs. */
export function closeRequisition(db, id, { force = false } = {}) {
  const r = agreement(db, id);
  if (r.state !== 'ongoing') throw new Error('Only ongoing agreements can be closed');
  if (!force && r.type === 'blanket' && orders(db, id).some(draft)) throw new Error('Resolve draft quotations before closing the blanket order');
  return write(db, 'purchase.requisition', id, { state: 'done' });
}

/** Close ongoing agreements strictly past their end date. */
export function blanketExpiryCheck(db, date = today()) {
  return search(db, 'purchase.requisition').filter((r) => r.state === 'ongoing' && r.date_end && r.date_end < date)
    .reduce((next, r) => closeRequisition(next, r.id, { force: true }), db);
}

const purchase = salesModels['purchase.order'];

export const purchasePlusModels = {
  'product.supplierinfo': {
    label: 'Vendor Pricelists',
    fields: {
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      min_qty: { type: 'float', label: 'Minimum Quantity' },
      price: { type: 'monetary', label: 'Price', required: true },
      currency: { type: 'char', label: 'Currency' },
      delay: { type: 'integer', label: 'Lead Days' },
      date_start: { type: 'date', label: 'Start Date' },
      date_end: { type: 'date', label: 'End Date' },
      sequence: { type: 'integer', label: 'Sequence' },
    },
    defaults: () => ({ min_qty: 0, price: 0, currency: 'USD', delay: 0, sequence: 10 }),
    list: ['partner_id', 'product_id', 'min_qty', 'price', 'currency', 'delay', 'date_start', 'date_end', 'sequence'],
    form: { title: 'product_id', groups: [['partner_id', 'product_id'], ['min_qty', 'price', 'currency', 'delay'], ['date_start', 'date_end', 'sequence']] },
  },
  'purchase.requisition': {
    label: 'Purchase Agreements',
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      type: { type: 'selection', label: 'Agreement Type', options: [['blanket', 'Blanket Order'], ['tender', 'Call for Tenders']] },
      vendor_id: { type: 'many2one', relation: 'res.partner', label: 'Vendor' },
      date_start: { type: 'date', label: 'Start Date' },
      date_end: { type: 'date', label: 'End Date' },
      line_ids: { type: 'one2many', label: 'Products', fields: {
        product_id: { type: 'many2one', relation: 'product', label: 'Product' },
        product_qty: { type: 'float', label: 'Quantity' },
        price_unit: { type: 'monetary', label: 'Unit Price' },
        qty_ordered: { type: 'float', label: 'Ordered Quantity', readonly: true },
      }, newLine: () => ({ product_qty: 1, price_unit: 0, qty_ordered: 0 }) },
      purchase_ids: { type: 'one2many', label: 'Quotations', readonly: true, fields: { purchase_id: { type: 'many2one', relation: 'purchase.order', label: 'Quotation' } } },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['ongoing', 'Ongoing'], ['done', 'Closed'], ['cancel', 'Cancelled']] },
    },
    defaults: (id) => ({ name: 'PA' + pad(id), type: 'blanket', date_start: today(), state: 'draft', line_ids: [], purchase_ids: [] }),
    list: ['name', 'type', 'vendor_id', 'date_start', 'date_end', 'state'],
    kanban: { title: 'name', lines: ['type', 'vendor_id', 'date_end'], badge: 'state' },
    form: {
      title: 'name', statusbar: 'state', lockedWhen: (r) => r.state !== 'draft',
      groups: [['type', 'vendor_id'], ['date_start', 'date_end']],
      tabs: [{ label: 'Products', fields: ['line_ids'] }, { label: 'Quotations', fields: ['purchase_ids'] }],
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: confirmRequisition(db, r.id) }) },
        { label: 'New Quotation', when: (r) => r.state === 'ongoing', run: (db, r) => {
          const vendor = r.type === 'tender' ? prompt('Vendor ID') : r.vendor_id;
          if (vendor == null) return { db };
          const out = newQuotationFromRequisition(db, r.id, { partnerId: Number(vendor) });
          return { db: out.db, go: `#/purchase/rfq/${out.id}` };
        } },
        { label: 'Compare', when: (r) => r.type === 'tender', run: (db, r) => {
          const rows = compareAlternatives(db, r.id).flatMap((p) => p.alternatives.map((a) => `${read(db, 'product', p.product_id)?.name}: ${read(db, 'res.partner', a.partner_id)?.name}, price ${a.price}, total ${a.total}, lead days ${a.delay ?? 'unknown'}${a.best ? ' (best price)' : ''}`));
          return { db: postNote(db, 'purchase.requisition', r.id, rows.join('\n') || 'No alternatives to compare') };
        } },
        { label: 'Close', when: (r) => r.state === 'ongoing', run: (db, r) => ({ db: closeRequisition(db, r.id) }) },
        { label: 'Cancel', when: (r) => ['draft', 'ongoing'].includes(r.state), vals: { state: 'cancel' } },
      ],
      smart: [{ label: 'Quotations', model: 'purchase.order', field: 'requisition_id', target: 'purchase/rfq' }], chatter: true,
    },
  },
  'purchase.order': {
    ...purchase,
    fields: { ...purchase.fields, requisition_id: { type: 'many2one', relation: 'purchase.requisition', label: 'Purchase Agreement' } },
    form: {
      ...purchase.form,
      groups: [...purchase.form.groups, ['requisition_id']],
      buttons: [...purchase.form.buttons.map((b) => b.label === 'Confirm Order' ? { ...b, run: confirmOrder } : b),
        { label: 'Choose Alternative', when: (r) => !!r.requisition_id && draft(r), run: (db, r) => ({ db: chooseAlternative(db, r.id) }) }],
      smart: [...purchase.form.smart, { label: 'Alternatives', model: 'purchase.order', field: 'requisition_id', key: 'requisition_id', target: 'purchase/rfq' }],
    },
  },
};
