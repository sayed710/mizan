// Repairs with warranty pricing, valued parts, labour and customer receipts.
import { create, read, search, write, postNote } from '../orm.js';
import { apps2Models } from './apps2.js';
import { addDays, amounts, today } from './common.js';
import { createPicking } from './sales.js';
import { moveValued } from './valuation.js';

const round = (n) => Math.round(n * 100) / 100;
const warranty = (r) => !!r.under_warranty && (!r.guarantee_limit || (r.repair_date || r.schedule_date) <= r.guarantee_limit);
const free = (r, l) => warranty(r) || (!!l.warranty_free && !l.warranty_applied);
const repair = (db, id) => {
  const r = read(db, 'repair.order', id);
  if (!r) throw new Error('Repair order not found');
  return r;
};
const dated = (date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime()) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid repair date');
  return date;
};
const flags = (r) => ({ parts: (r.parts ?? []).map((l) => ({ ...l, warranty_free: free(r, l), warranty_applied: warranty(r) })) });

function checkParts(db, r) {
  const required = new Map();
  for (const l of r.parts ?? []) {
    const p = read(db, 'product', l.product_id);
    if (!p || p.type !== 'goods') throw new Error('Select a stockable product for each part');
    if (!(Number(l.qty) > 0) || !Number.isFinite(Number(l.qty))) throw new Error('Part quantities must be positive');
    if (!['add', 'remove'].includes(l.type ?? 'add')) throw new Error('Select Add or Remove for each part');
    if ((l.type ?? 'add') === 'add') required.set(p.id, (required.get(p.id) ?? 0) + Number(l.qty));
  }
  for (const [id, qty] of required) {
    const p = read(db, 'product', id);
    if (qty > Number(p.qty_available || 0)) throw new Error(`${p.name}: not enough stock for this repair`);
  }
  for (const l of r.operations ?? []) {
    if (l.product_id && read(db, 'product', l.product_id)?.type !== 'service') throw new Error('Select a service product for labour');
    if (!Number.isFinite(Number(l.hours)) || Number(l.hours) < 0 || !Number.isFinite(Number(l.price_unit)) || Number(l.price_unit) < 0) throw new Error('Labour hours and prices must be nonnegative');
  }
}

function checkLot(db, r) {
  const p = read(db, 'product', r.product_id);
  if (!p) throw new Error('Select a product to repair');
  const lot = r.lot_id && read(db, 'stock.lot', r.lot_id);
  if (p.tracking && p.tracking !== 'none' && !lot) throw new Error('A lot/serial number is required for this tracked product');
  if (r.lot_id && (!lot || lot.product_id !== p.id)) throw new Error('Select a lot belonging to the product to repair');
}

/** Confirm a quotation after checking its lot and aggregate replacement stock. */
export function confirmRepair(db, id, date = today()) {
  const r = repair(db, id);
  if (r.state !== 'draft') throw new Error('Only a new repair can be confirmed');
  checkLot(db, r);
  checkParts(db, r);
  return write(db, 'repair.order', id, { ...flags(r), state: 'confirmed', confirm_date: dated(date) });
}

/** Start a confirmed repair without consuming parts yet. */
export function startRepair(db, id, date = today()) {
  const r = repair(db, id);
  if (r.state !== 'confirmed') throw new Error('Confirm the repair before starting it');
  if (r.confirm_date && date < r.confirm_date) throw new Error('Repair cannot start before confirmation');
  checkLot(db, r);
  return write(db, 'repair.order', id, { state: 'progress', start_date: dated(date), repair_date: date });
}

/** Finish once, consuming added parts and receiving removed parts through valuation. */
export function endRepair(db, id, date = today()) {
  const r = repair(db, id);
  if (r.state === 'done') return db;
  if (r.state !== 'progress') throw new Error('Start the repair before ending it');
  dated(date);
  if (date < (r.start_date || r.confirm_date || date)) throw new Error('Repair cannot end before it starts');
  checkLot(db, r);
  checkParts(db, r);
  const options = { date, reference: r.name };
  let next = moveValued(db, (r.parts ?? []).filter((l) => l.type !== 'remove'), -1, options);
  next = moveValued(next, (r.parts ?? []).filter((l) => l.type === 'remove'), 1, options);
  return write(next, 'repair.order', id, { ...flags({ ...r, repair_date: date }), state: 'done', repair_date: date, done_date: date });
}

/** Create one ready customer return receipt, retaining its lot without moving stock yet. */
export function receiveProduct(db, id) {
  const r = repair(db, id);
  if (r.picking_id) return db;
  if (r.state === 'cancel') throw new Error('A cancelled repair cannot receive a product');
  checkLot(db, r);
  if (read(db, 'product', r.product_id)?.type !== 'goods') throw new Error('Only a stockable product can be received');
  if (!r.partner_id) throw new Error('Select a customer before receiving the product');
  let next = createPicking(db, { type: 'incoming', partner_id: r.partner_id, origin: r.name,
    lines: [{ product_id: r.product_id, qty: 1 }], link: { repair_id: id }, scheduled_date: r.schedule_date });
  const picking = search(next, 'stock.picking').find((p) => p.repair_id === id);
  const lot = r.lot_id && read(next, 'stock.lot', r.lot_id);
  next = write(next, 'stock.picking', picking.id, { move_ids: picking.move_ids.map((l) => ({ ...l, lot_id: r.lot_id || null, lot_name: lot?.name || '' })) });
  return write(next, 'repair.order', id, { picking_id: picking.id });
}

/** Mark the quotation sent and record a chatter note once. */
export function sendQuotation(db, id) {
  const r = repair(db, id);
  if (!['draft', 'confirmed'].includes(r.state)) throw new Error('Only a quotation can be sent');
  if (r.quotation_sent) return db;
  return postNote(write(db, 'repair.order', id, { quotation_sent: true }), 'repair.order', id, 'Repair quotation sent to the customer.');
}

function billable(r) {
  return {
    parts: (r.parts ?? []).filter((l) => l.type !== 'remove' && !free(r, l)).map((l) => ({ ...l })),
    operations: (r.operations ?? []).filter((l) => !free(r, l)).map((l) => ({ ...l, qty: Number(l.hours) || 0 })),
  };
}

function totals(r) {
  const lines = billable(r);
  return { parts: amounts(lines.parts).untaxed, operations: amounts(lines.operations).untaxed, ...amounts([...lines.parts, ...lines.operations]) };
}

/** Billable parts and labour at the repair date, with inclusive warranty expiry. */
export function repairTotal(db, id) {
  return totals(repair(db, id));
}

/** Create one draft customer invoice; pass true to allow invoicing before completion. */
export function createInvoice(db, id, beforeRepair = false) {
  const r = repair(db, id);
  if (r.invoice_id) return { db, invoiceId: r.invoice_id };
  if (r.invoiced) throw new Error('This repair has already been invoiced');
  if (r.state === 'cancel' || (r.state !== 'done' && !beforeRepair)) throw new Error('Finish the repair before creating an invoice');
  if (!r.partner_id) throw new Error('Select a customer before invoicing');
  checkParts(db, { ...r, parts: [] });
  const lines = billable(r);
  const invoice_line_ids = [...lines.parts, ...lines.operations];
  if (!invoice_line_ids.length) throw new Error('There are no billable repair lines');
  const result = create(db, 'account.move', { move_type: 'out_invoice', state: 'draft', partner_id: r.partner_id,
    invoice_origin: r.name, repair_id: id, invoice_date: today(), invoice_date_due: addDays(today(), 15), invoice_line_ids });
  return { db: write(result.db, 'repair.order', id, { invoice_id: result.id, invoiced: true }), invoiceId: result.id };
}

/** Inclusive scheduled-date report: state counts, completed duration in days and untaxed revenue. */
export function repairAnalysis(db, { from, to } = {}) {
  const orders = search(db, 'repair.order').filter((r) => (!from || r.schedule_date >= from) && (!to || r.schedule_date <= to));
  const counts = Object.fromEntries(['draft', 'confirmed', 'progress', 'done', 'cancel'].map((s) => [s, orders.filter((r) => r.state === s).length]));
  const completed = orders.filter((r) => r.state === 'done' && r.confirm_date && r.done_date);
  const averageDuration = completed.length ? completed.reduce((sum, r) => sum + (new Date(r.done_date) - new Date(r.confirm_date)) / 86400000, 0) / completed.length : 0;
  const revenue = round(orders.filter((r) => r.state === 'done').reduce((sum, r) => sum + totals(r).untaxed, 0));
  return { counts, averageDuration, revenue };
}

const relation = (relation, label) => ({ type: 'many2one', relation, label });
export const repairPlusModels = {
  get 'repair.order'() {
    const base = apps2Models['repair.order'];
    const parts = base.fields.parts;
    return {
      ...base,
      fields: {
        ...base.fields,
        lot_id: relation('stock.lot', 'Lot/Serial Number'), under_warranty: { type: 'boolean', label: 'Under Warranty' },
        guarantee_limit: { type: 'date', label: 'Warranty Expiry' }, sale_order_id: relation('sale.order', 'Sales Order'),
        picking_id: { ...relation('stock.picking', 'Customer Receipt'), readonly: true },
        invoice_id: { ...relation('account.move', 'Invoice'), readonly: true },
        quotation_sent: { type: 'boolean', label: 'Quotation Sent', readonly: true },
        tag_ids: { type: 'tags', label: 'Tags' }, priority: { type: 'selection', label: 'Priority', options: [['0', 'Normal'], ['1', 'Urgent']] },
        confirm_date: { type: 'date', label: 'Confirmed On', readonly: true }, start_date: { type: 'date', label: 'Started On', readonly: true },
        done_date: { type: 'date', label: 'Completed On', readonly: true }, repair_date: { type: 'date', label: 'Repair Date', readonly: true },
        parts: { ...parts, fields: { ...parts.fields,
          type: { type: 'selection', label: 'Type', options: [['add', 'Add'], ['remove', 'Remove']] },
          warranty_free: { type: 'boolean', label: 'Warranty Free', readonly: true },
          warranty_applied: { type: 'boolean', label: 'Warranty Applied', hidden: true },
        }, newLine: () => ({ ...parts.newLine(), type: 'add', warranty_free: false }),
        onchange: (l, key, db, r) => ({ ...parts.onchange(l, key, db, r), warranty_free: free(r, l), warranty_applied: warranty(r) }) },
        operations: { type: 'one2many', label: 'Labour', fields: {
          name: { type: 'char', label: 'Description' }, product_id: relation('product', 'Service'),
          hours: { type: 'float', label: 'Hours' }, price_unit: { type: 'monetary', label: 'Hourly Rate' },
        }, newLine: () => ({ name: '', product_id: null, hours: 1, price_unit: 0 }) },
        amount_untaxed: { ...base.fields.amount_untaxed, compute: (r) => totals(r).untaxed },
        amount_tax: { ...base.fields.amount_tax, compute: (r) => totals(r).tax },
        amount_total: { ...base.fields.amount_total, compute: (r) => totals(r).total },
      },
      defaults: (id) => ({ ...base.defaults(id), under_warranty: false, quotation_sent: false, tag_ids: [], priority: '0', operations: [] }),
      onchange: (r, key) => ['under_warranty', 'guarantee_limit', 'schedule_date', 'repair_date', 'parts'].includes(key) ? flags(r) : {},
      kanban: { ...base.kanban, lines: [...base.kanban.lines, 'priority'], badge: 'state' },
      form: { ...base.form,
        groups: [['product_id', 'lot_id', 'partner_id', 'sale_order_id', 'picking_id'], ['user_id', 'schedule_date', 'priority', 'tag_ids', 'under_warranty', 'guarantee_limit', 'quotation_sent', 'invoice_id']],
        tabs: [{ label: 'Parts', fields: ['parts'] }, { label: 'Operations', fields: ['operations'] }, { label: 'Internal Notes', fields: ['internal_notes'] }],
        buttons: [
          { label: 'Send Quotation', when: (r) => ['draft', 'confirmed'].includes(r.state) && !r.quotation_sent, run: (db, r) => ({ db: sendQuotation(db, r.id) }) },
          { label: 'Confirm Repair', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: confirmRepair(db, r.id) }) },
          { label: 'Receive Product', when: (r) => r.state !== 'cancel' && !r.picking_id, run: (db, r) => ({ db: receiveProduct(db, r.id) }) },
          { label: 'Start Repair', primary: true, vals: { state: 'progress' }, when: (r) => r.state === 'confirmed', run: (db, r) => ({ db: startRepair(db, r.id) }) },
          { label: 'End Repair', primary: true, when: (r) => r.state === 'progress', run: (db, r) => ({ db: endRepair(db, r.id) }) },
          { label: 'Create Invoice', when: (r) => r.state === 'done' && !r.invoiced && r.partner_id, run: (db, r) => {
            const result = createInvoice(db, r.id);
            return { db: result.db, go: `#/accounting/invoices/${result.invoiceId}` };
          } },
          ...base.form.buttons.filter((b) => b.label === 'Cancel'),
        ],
      },
    };
  },
};
