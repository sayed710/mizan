// Sign, Documents, Planning, Rental (Appointments live in appointments.js).
import { create, read, write } from '../orm.js';
import { addDays, pad, subtotal, today } from './common.js';
import { moveStock } from './sales.js';
import { bestPrice, rentalHours } from './rentalpricing.js';
import { round } from '../money.js';

const state = (options, label = 'Status') => ({ type: 'selection', label, tracking: true, options });
const days = (a, b) => (a && b ? Math.max(1, Math.round((new Date(b) - new Date(a)) / 864e5)) : 1);
const hasRentalRules = (db, productId) => (db.records['rental.pricing'] ?? []).some((rule) => rule.active !== false && rule.product_id === productId);
const rentalPrice = (db, r) => bestPrice(db, r.product_id, rentalHours(r.pickup_date, r.return_date)).price;

/** Turn a document into work elsewhere and link it back (bill to digitize, signature request, task). */
function documentTo(db, d, model, vals, target, note) {
  if (d.res_model) throw new Error('This document is already linked to a record');
  const { db: next, id } = create(db, model, vals);
  return { db: write(next, 'documents.document', d.id, { res_model: model, res_id: id, folder: d.folder === 'inbox' ? note : d.folder }), go: `#/${target}/${id}` };
}

/** Signers in signing order; a request without lines is signed by its single signer. */
const signersOf = (r) => ((r.signer_ids ?? []).length ? r.signer_ids : [{ partner_id: r.partner_id, role: 'signer', signed: false }]);
export const nextSigner = (r) => signersOf(r).findIndex((s) => !s.signed);

/** The next signer types their name; the document is signed once everyone has. */
export function applySignature(db, r, name, date = today(), at = nextSigner(r)) {
  if (r.state !== 'sent') throw new Error('Send the document before signing');
  if (r.deadline && date > r.deadline) throw new Error('This signature request has expired');
  const i = at;
  if (i < 0 || !name?.trim()) return db;
  const signer_ids = signersOf(r).map((s, k) => (k === i ? { ...s, signed: true, signature: name.trim(), sign_date: date } : s));
  const done = signer_ids.every((s) => s.signed);
  return write(db, 'sign.request', r.id, { signer_ids, ...(done ? { state: 'signed', signature: signer_ids.map((s) => s.signature).join(', '), sign_date: date } : {}) });
}

function signDocument(db, r) {
  const signer = signersOf(r)[nextSigner(r)];
  // Typed by whoever signs, never prefilled with the signer's name.
  const name = prompt(`Type your full name to sign${signer?.partner_id ? ` (signer: ${read(db, 'res.partner', signer.partner_id)?.name ?? ''})` : ''}`, '');
  return { db: name == null ? db : applySignature(db, r, name) };
}

/** Rented units leave the shelf but stay company stock (qty_rented), so valuation is unchanged. */
const rentOut = (db, r, sign) => {
  const p = read(db, 'product', r.product_id);
  const moved = moveStock(db, [{ product_id: r.product_id, qty: r.qty }], -sign);
  return p?.type === 'goods' ? write(moved, 'product', p.id, { qty_rented: Math.max(0, (Number(p.qty_rented) || 0) + sign * (Number(r.qty) || 0)) }) : moved;
};

/** Late days past the planned return (actual return date, or today while still out). */
const lateDays = (r, at = today()) => (r.return_date ? Math.max(0, Math.round((new Date(r.actual_return_date ?? at) - new Date(r.return_date)) / 864e5)) : 0);
const lateFee = (r, at) => Math.round(lateDays(r, at) * (Number(r.qty) || 0) * (Number(r.price_per_day) || 0) * (Number(r.late_fee_factor) || 0) * 100) / 100;

/** Keep legacy billing flags, but derive new charges from live, linked invoice lines. */
const rentalCharges = (db, r) => (db.records['account.move'] ?? [])
  .filter((m) => m.state !== 'cancel' && m.move_type === 'out_invoice' && (m.company_id ?? 1) === (r.company_id ?? 1))
  .flatMap((m) => (m.invoice_line_ids ?? []).filter((l) => l.rental_id === r.id));
const billedRental = (db, r) => Boolean(r.invoiced || rentalCharges(db, r).some((l) => l.rental_charge === 'rental'));
const billedLateFee = (db, r) => round((Number(r.late_fee_invoiced) || 0) + rentalCharges(db, r)
  .filter((l) => l.rental_charge === 'late').reduce((sum, l) => sum + subtotal(l), 0));

/** Units of the product reserved or out on other rentals overlapping [from, to]. */
export function rentedQty(db, productId, from, to, excludeId) {
  return (db.records['sale.rental'] ?? [])
    .filter((o) => o.id !== excludeId && o.product_id === productId && ['reserved', 'picked'].includes(o.state) && o.pickup_date <= to && (o.state === 'picked' && !o.actual_return_date ? '9999-12-31' : o.actual_return_date ?? o.return_date) >= from)
    .reduce((s, o) => s + (Number(o.qty) || 0), 0);
}

/** Reserve only what the stock can cover for the whole period. */
function confirmRental(db, r) {
  const product = read(db, 'product', r.product_id);
  if (r.return_date < r.pickup_date) throw new Error('The return date must be after the pickup date');
  const onHand = Number(product?.qty_available) || 0;
  const busy = rentedQty(db, r.product_id, r.pickup_date, r.return_date, r.id);
  // Units already picked up are no longer on hand, so add them back before comparing.
  const out = (db.records['sale.rental'] ?? []).filter((o) => o.id !== r.id && o.product_id === r.product_id && o.state === 'picked').reduce((s, o) => s + (Number(o.qty) || 0), 0);
  if (product?.type === 'goods' && busy + (Number(r.qty) || 0) > onHand + out) throw new Error(`Only ${Math.max(0, onHand + out - busy)} ${product.name} available for these dates`);
  const rental_unit_price = hasRentalRules(db, r.product_id) ? rentalPrice(db, r) : null;
  return write(db, 'sale.rental', r.id, { state: 'reserved', rental_unit_price });
}

/** Invoice the late fee accrued since the last invoice (rental returned after being invoiced). */
function lateFeeInvoice(db, r) {
  r = read(db, 'sale.rental', r.id);
  if (r.legacy_billing_review) throw new Error('Review legacy billing before invoicing this rental');
  const delta = Math.round((lateFee(r) - r.billing_late_fee) * 100) / 100;
  if (!(delta > 0)) throw new Error('No additional late fee to invoice');
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: r.partner_id, invoice_origin: r.name, invoice_date: today(), invoice_date_due: addDays(today(), 15),
    invoice_line_ids: [{ product_id: r.product_id, name: `Late return (${lateDays(r)} day(s))`, qty: 1, price_unit: delta, tax: 14, rental_id: r.id, rental_charge: 'late' }],
  });
  return { db: next, go: `#/accounting/invoices/${id}` };
}

function rentalInvoice(db, r) {
  r = read(db, 'sale.rental', r.id);
  if (r.legacy_billing_review) throw new Error('Review legacy billing before invoicing this rental');
  if (r.billing_invoiced) throw new Error('This rental is already invoiced');
  const fee = lateFee(r);
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: r.partner_id, invoice_origin: r.name, invoice_date: today(), invoice_date_due: addDays(today(), 15),
    invoice_line_ids: [
      { product_id: r.product_id, name: 'Rental', qty: r.rental_unit_price == null ? r.qty * days(r.pickup_date, r.return_date) : r.qty, price_unit: r.rental_unit_price ?? r.price_per_day, tax: 14, rental_id: r.id, rental_charge: 'rental' },
      ...(fee ? [{ product_id: r.product_id, name: `Late return (${lateDays(r)} day(s))`, qty: 1, price_unit: fee, tax: 14, rental_id: r.id, rental_charge: 'late' }] : []),
    ],
  });
  return { db: next, go: `#/accounting/invoices/${id}` };
}

/** Why a shift clashes: another shift of the same resource on overlapping days, or approved time off. */
export function shiftConflict(db, s) {
  if (!s.employee_id || !s.start) return '';
  const end = s.end || s.start;
  const overlap = (a, b, c, d) => a <= d && c <= b;
  const shift = (db.records['planning.slot'] ?? []).find((o) => o.id !== s.id && o.employee_id === s.employee_id && overlap(o.start, o.end || o.start, s.start, end));
  if (shift) return `Overlaps ${shift.name} (${shift.start})`;
  const leave = (db.records['hr.leave'] ?? []).find((l) => l.state === 'validate' && l.employee_id === s.employee_id && overlap(l.date_from, l.date_to, s.start, end));
  return leave ? `On time off (${leave.date_from} → ${leave.date_to})` : '';
}

/** Duplicate a shift one week later as a draft. */
function copyNextWeek(db, s) {
  const { db: next, id } = create(db, 'planning.slot', { ...s, id: undefined, start: addDays(s.start, 7), end: s.end ? addDays(s.end, 7) : null, state: 'draft' });
  return { db: next, go: `#/planning/schedule/${id}` };
}

export const extraModels = {
  'website.page': {
    label: 'Pages',
    fields: {
      name: { type: 'char', label: 'Page Title', required: true },
      slug: { type: 'char', label: 'URL', required: true },
      sequence: { type: 'integer', label: 'Menu Order' },
      is_published: { type: 'boolean', label: 'Published' },
      content: { type: 'text', label: 'Content' },
    },
    defaults: () => ({ sequence: 10, is_published: false }),
    filters: [[{ id: 'published', label: 'Published', fn: (r) => r.is_published }]],
    kanban: { title: 'name', lines: ['slug'], badge: 'is_published' },
    list: ['sequence', 'name', 'slug', 'is_published'],
    views: ['list', 'kanban'],
    form: {
      buttons: [
        { label: 'Publish', primary: true, vals: { is_published: true }, when: (r) => !r.is_published },
        { label: 'Unpublish', vals: { is_published: false }, when: (r) => r.is_published },
        { label: 'View Website', run: (db) => ({ db, go: '#/website/site' }) },
      ],
      title: 'name',
      groups: [['slug', 'sequence'], ['is_published']],
      tabs: [{ label: 'Content', fields: ['content'] }],
      chatter: true,
    },
  },

  'sign.request': {
    label: 'Documents to Sign',
    fields: {
      name: { type: 'char', label: 'Document', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Signer', required: true },
      body: { type: 'text', label: 'Document Content' },
      state: state([['draft', 'Draft'], ['sent', 'To Sign'], ['signed', 'Signed'], ['canceled', 'Cancelled']]),
      signature: { type: 'char', label: 'Signature', readonly: true },
      sign_date: { type: 'date', label: 'Signed on', readonly: true },
      deadline: { type: 'date', label: 'Valid Until' },
      signer_ids: {
        type: 'one2many', label: 'Signers',
        fields: {
          partner_id: { type: 'many2one', relation: 'res.partner', label: 'Signer' },
          role: { type: 'selection', label: 'Role', options: [['signer', 'Signer'], ['customer', 'Customer'], ['employee', 'Employee'], ['witness', 'Witness']] },
          signed: { type: 'boolean', label: 'Signed', readonly: true },
          signature: { type: 'char', label: 'Signature', readonly: true },
          sign_date: { type: 'date', label: 'Signed on', readonly: true },
        },
        newLine: () => ({ partner_id: null, role: 'signer', signed: false }),
      },
      progress: { type: 'char', label: 'Signatures', compute: (r) => `${signersOf(r).filter((s) => s.signed).length} / ${signersOf(r).length}` },
    },
    defaults: () => ({ state: 'draft', deadline: addDays(today(), 14), signer_ids: [] }),
    filters: [[{ id: 'to_sign', label: 'To Sign', fn: (r) => r.state === 'sent' }, { id: 'signed', label: 'Signed', fn: (r) => r.state === 'signed' }, { id: 'expired', label: 'Expired', fn: (r) => r.state === 'sent' && r.deadline && r.deadline < today() }]],
    groupBys: ['state', 'partner_id'],
    kanban: { groupBy: 'state', title: 'name', lines: ['partner_id', 'deadline'] },
    list: ['name', 'partner_id', 'progress', 'deadline', 'sign_date', 'state'],
    form: {
      statusbar: 'state',
      statusbarHide: ['canceled'],
      lockedWhen: (r) => ['sent', 'signed'].includes(r.state),
      buttons: [
        { label: 'Send', primary: true, vals: { state: 'sent' }, when: (r) => r.state === 'draft' },
        { label: 'Sign Now', primary: true, when: (r) => r.state === 'sent', run: signDocument },
        { label: 'Cancel', vals: { state: 'canceled' }, when: (r) => ['draft', 'sent'].includes(r.state) },
      ],
      ribbon: (r) => (r.state === 'signed' ? 'Signed' : null),
      title: 'name',
      groups: [['partner_id', 'deadline', 'progress'], ['signature', 'sign_date']],
      tabs: [{ label: 'Document Content', fields: ['body'] }, { label: 'Signers', fields: ['signer_ids'] }],
      chatter: true,
    },
  },

  'documents.document': {
    label: 'Documents',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      folder: { type: 'selection', label: 'Workspace', options: [['finance', 'Finance'], ['hr', 'HR'], ['marketing', 'Marketing'], ['legal', 'Legal'], ['inbox', 'Inbox']] },
      file: { type: 'binary', label: 'File' },
      owner_id: { type: 'many2one', relation: 'hr.employee', label: 'Owner' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      tag_ids: { type: 'tags', label: 'Tags' },
      create_date: { type: 'date', label: 'Created on', readonly: true },
      is_request: { type: 'boolean', label: 'Requested Document', readonly: true },
      request_deadline: { type: 'date', label: 'Request Due Date' },
      description: { type: 'text', label: 'Description' },
      locked: { type: 'boolean', label: 'Locked', readonly: true },
      res_model: { type: 'char', label: 'Linked Model', readonly: true },
      res_id: { type: 'integer', label: 'Linked Record', readonly: true },
    },
    defaults: () => ({ folder: 'inbox', owner_id: 1, tag_ids: [], create_date: today() }),
    // Uploading the file fulfils a request.
    onchange: (r, key) => (key === 'file' && r.file && r.is_request ? { is_request: false } : {}),
    filters: [[
      { id: 'requests', label: 'Requested', fn: (r) => r.is_request && !r.file },
      { id: 'overdue', label: 'Overdue Requests', fn: (r) => r.is_request && !r.file && r.request_deadline && r.request_deadline < today() },
      { id: 'unlinked', label: 'Not Linked', fn: (r) => !r.res_model },
    ]],
    groupBys: ['folder', 'owner_id', 'partner_id', 'create_date'],
    kanban: { groupBy: 'folder', title: 'name', lines: ['owner_id', 'create_date'], tags: 'tag_ids' },
    list: ['name', 'folder', 'owner_id', 'partner_id', 'create_date'],
    form: {
      lockedWhen: (r) => r.locked,
      buttons: [
        { label: 'Create Vendor Bill', when: (r) => r.file && !r.res_model, run: (db, r) => documentTo(db, r, 'account.move', { move_type: 'in_invoice', partner_id: r.partner_id ?? null, ref: r.name, invoice_line_ids: [] }, 'accounting/bills', 'finance') },
        { label: 'Request Signature', when: (r) => r.file && !r.res_model && r.partner_id, run: (db, r) => documentTo(db, r, 'sign.request', { name: r.name, partner_id: r.partner_id, body: r.description ?? '' }, 'sign/documents', 'legal') },
        { label: 'Create Task', when: (r) => !r.res_model, run: (db, r) => documentTo(db, r, 'project.task', { name: r.name, description: r.description ?? '' }, 'project/tasks', r.folder) },
        { label: 'Lock', when: (r) => !r.locked, vals: { locked: true } },
        { label: 'Unlock', when: (r) => r.locked, vals: { locked: false } },
      ],
      ribbon: (r) => (r.is_request && !r.file ? 'Requested' : r.locked ? 'Locked' : null),
      title: 'name',
      groups: [['folder', 'file', 'tag_ids', 'request_deadline'], ['owner_id', 'partner_id', 'create_date', 'res_model', 'res_id']],
      tabs: [{ label: 'Description', fields: ['description'] }],
      chatter: true,
    },
  },

  'planning.slot': {
    label: 'Shifts',
    fields: {
      name: { type: 'char', label: 'Shift', required: true },
      employee_id: { type: 'many2one', relation: 'hr.employee', label: 'Resource' },
      role: { type: 'selection', label: 'Role', options: [['sales', 'Salesperson'], ['support', 'Support'], ['install', 'Installer'], ['warehouse', 'Warehouse']] },
      start: { type: 'date', label: 'Start Date', required: true },
      end: { type: 'date', label: 'End Date' },
      allocated_hours: { type: 'float', label: 'Allocated Hours' },
      state: state([['draft', 'Draft'], ['published', 'Published']]),
      note: { type: 'text', label: 'Note' },
      template_id: { type: 'many2one', relation: 'planning.template', label: 'Template' },
      conflict: { type: 'char', label: 'Conflict', readonly: true },
    },
    defaults: () => ({ name: 'Shift', start: today(), allocated_hours: 8, role: 'sales', state: 'draft' }),
    // A template fills role/hours/name; any change to who or when re-checks conflicts.
    onchange: (r, key, db) => {
      const tpl = key === 'template_id' && r.template_id ? read(db, 'planning.template', r.template_id) : null;
      const filled = tpl ? { name: tpl.name, role: tpl.role ?? r.role, allocated_hours: Number(tpl.duration) || r.allocated_hours } : {};
      return ['employee_id', 'start', 'end', 'template_id'].includes(key) ? { ...filled, conflict: shiftConflict(db, { ...r, ...filled }) } : {};
    },
    filters: [[
      { id: 'open', label: 'Open Shifts', fn: (r) => !r.employee_id },
      { id: 'published', label: 'Published', fn: (r) => r.state === 'published' },
      { id: 'conflicts', label: 'Conflicts', fn: (r) => !!r.conflict },
    ]],
    listDecoration: (r) => (r.conflict ? 'danger' : null),
    groupBys: ['employee_id', 'role', 'start', 'state'],
    kanban: { groupBy: 'employee_id', title: 'name', lines: ['start', 'allocated_hours', 'role'], badge: 'state' },
    list: ['start', 'employee_id', 'role', 'name', 'allocated_hours', 'state'],
    views: ['gantt', 'calendar', 'kanban', 'list', 'pivot'],
    gantt: { start: 'start', stop: 'end', row: 'employee_id', color: 'state', hours: 'allocated_hours' },
    calendar: { date: 'start' },
    pivot: { row: 'employee_id', col: 'role', measure: 'allocated_hours' },
    form: {
      statusbar: 'state',
      buttons: [
        { label: 'Publish', primary: true, vals: { state: 'published' }, when: (r) => r.state === 'draft' },
        { label: 'Take Shift', primary: true, when: (r) => !r.employee_id && r.state === 'published', run: (db, r) => ({ db: write(db, 'planning.slot', r.id, { employee_id: 1, conflict: shiftConflict(db, { ...r, employee_id: 1 }) }) }) },
        { label: 'Copy to Next Week', run: copyNextWeek },
      ],
      title: 'name',
      groups: [['employee_id', 'role', 'template_id'], ['start', 'end', 'allocated_hours', 'conflict']],
      tabs: [{ label: 'Note', fields: ['note'] }],
      chatter: true,
    },
  },

  'planning.template': {
    label: 'Shift Templates',
    fields: {
      name: { type: 'char', label: 'Template', required: true },
      role: { type: 'selection', label: 'Role', options: [['sales', 'Salesperson'], ['support', 'Support'], ['install', 'Installer'], ['warehouse', 'Warehouse']] },
      start_time: { type: 'char', label: 'Start (HH:MM)' },
      duration: { type: 'float', label: 'Duration (hours)' },
    },
    defaults: () => ({ start_time: '09:00', duration: 8, role: 'sales' }),
    kanban: { title: 'name', lines: ['role', 'start_time', 'duration'] },
    list: ['name', 'role', 'start_time', 'duration'],
    form: { title: 'name', groups: [['role'], ['start_time', 'duration']] },
  },

  'sale.rental': {
    label: 'Rental Orders',
    fields: {
      name: { type: 'char', label: 'Order Reference', readonly: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Customer', required: true },
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      qty: { type: 'float', label: 'Quantity' },
      pickup_date: { type: 'date', label: 'Pick up Date' },
      return_date: { type: 'date', label: 'Return Date' },
      price_per_day: { type: 'monetary', label: 'Price per Day' },
      rental_unit_price: { type: 'monetary', label: 'Unit Price', readonly: true, hidden: true },
      amount_total: { type: 'monetary', label: 'Total', compute: (r, db) => {
        const rulePrice = r.rental_unit_price == null && r.state === 'quotation' && r.product_id && r.pickup_date && r.return_date && r.return_date >= r.pickup_date && hasRentalRules(db, r.product_id) ? rentalPrice(db, r) : null;
        return round((Number(r.qty) || 0) * (r.rental_unit_price ?? rulePrice ?? ((Number(r.price_per_day) || 0) * days(r.pickup_date, r.return_date))));
      } },
      actual_return_date: { type: 'date', label: 'Returned on', readonly: true },
      late_fee_factor: { type: 'float', label: 'Late Fee (× daily price)' },
      late_fee: { type: 'monetary', label: 'Late Fee', compute: (r) => lateFee(r) },
      deposit: { type: 'monetary', label: 'Security Deposit' },
      late_fee_invoiced: { type: 'monetary', label: 'Late Fee Invoiced', readonly: true },
      billing_late_fee: { type: 'monetary', label: 'Late Fee Invoiced', readonly: true, compute: (r, db) => billedLateFee(db, r) },
      state: state([['quotation', 'Quotation'], ['reserved', 'Reserved'], ['picked', 'Picked-up'], ['returned', 'Returned'], ['cancel', 'Cancelled']]),
      invoiced: { type: 'boolean', label: 'Invoiced', readonly: true },
      billing_invoiced: { type: 'boolean', label: 'Invoiced', readonly: true, compute: (r, db) => billedRental(db, r) },
      legacy_billing_review: { type: 'boolean', label: 'Legacy Billing Needs Review', readonly: true },
      legacy_billing_review_note: { type: 'text', label: 'Legacy Billing Review Note', readonly: true },
    },
    defaults: (id) => ({ name: 'R' + pad(id), qty: 1, state: 'quotation', pickup_date: today(), return_date: addDays(today(), 3), price_per_day: 0, late_fee_factor: 1.5, deposit: 0, invoiced: false }),
    filters: [
      [
        { id: 'pickups', label: 'Pickups', fn: (r) => r.state === 'reserved' && r.pickup_date <= today() },
        { id: 'returns', label: 'Returns', fn: (r) => r.state === 'picked' && r.return_date <= today() },
        { id: 'late', label: 'Late', fn: (r) => r.state === 'picked' && r.return_date < today() },
      ],
      [{ id: 'to_invoice', label: 'To Invoice', fn: (r) => ['picked', 'returned'].includes(r.state) && !r.billing_invoiced && !r.legacy_billing_review },
        { id: 'billing_review', label: 'Billing Needs Review', fn: (r) => r.legacy_billing_review }],
    ],
    groupBys: ['state', 'partner_id', 'product_id', 'pickup_date'],
    kanban: { groupBy: 'state', title: 'name', lines: ['partner_id', 'product_id', 'return_date', 'amount_total'] },
    list: ['name', 'partner_id', 'state', 'pickup_date', 'return_date', 'amount_total'],
    listDecoration: (r) => (r.state === 'picked' && r.return_date < today() ? 'danger' : null),
    views: ['list', 'kanban', 'gantt', 'calendar', 'pivot', 'graph'],
    gantt: { start: 'pickup_date', stop: 'return_date', row: 'product_id', color: 'state', title: 'name' },
    calendar: { date: 'pickup_date' },
    pivot: { row: 'product_id', col: 'state', measure: 'amount_total' },
    graph: { groupBy: 'product_id', measure: 'amount_total' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => ['returned', 'cancel'].includes(r.state),
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'quotation', run: (db, r) => ({ db: confirmRental(db, r) }) },
        { label: 'Pickup', primary: true, when: (r) => r.state === 'reserved', run: (db, r) => ({ db: write(rentOut(db, r, 1), 'sale.rental', r.id, { state: 'picked' }) }) },
        { label: 'Return', primary: true, when: (r) => r.state === 'picked', run: (db, r) => ({ db: write(rentOut(db, r, -1), 'sale.rental', r.id, { state: 'returned', actual_return_date: today() }) }) },
        { label: 'Create Invoice', when: (r) => ['picked', 'returned'].includes(r.state) && !r.billing_invoiced && !r.legacy_billing_review, run: rentalInvoice },
        { label: 'Invoice Late Fee', when: (r) => r.state === 'returned' && r.billing_invoiced && !r.legacy_billing_review && lateFee(r) > r.billing_late_fee, run: lateFeeInvoice },
        { label: 'Reconcile Legacy Billing', when: (r) => r.legacy_billing_review, wizard: (db, r) => ({ title: 'Reconcile Legacy Billing', fields: [
          { name: 'invoiced', type: 'selection', label: 'Was the rental invoiced?', required: true, options: [['yes', 'Yes'], ['no', 'No']] },
          { name: 'late_fee_invoiced', type: 'monetary', label: 'Legacy late fee invoiced (excluding linked charges)', required: true, default: Number(r.late_fee_invoiced) || 0 },
          { name: 'note', type: 'text', label: 'Evidence or explanation', required: true },
        ] }), run: (db, r, values = {}) => {
          const late = Number(values.late_fee_invoiced);
          const note = String(values.note ?? '').trim();
          if (!['yes', 'no'].includes(values.invoiced) || values.late_fee_invoiced == null || values.late_fee_invoiced === '' || !Number.isFinite(late) || late < 0 || !note) throw new Error('Choose the billing status, enter the late fee and explain the review');
          return { db: write(db, 'sale.rental', r.id, { invoiced: values.invoiced === 'yes', late_fee_invoiced: round(late), legacy_billing_review: false,
            legacy_billing_review_note: note, legacy_billing_before_review: { invoiced: r.invoiced, late_fee_invoiced: r.late_fee_invoiced } }) };
        } },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => ['quotation', 'reserved'].includes(r.state) },
      ],
      ribbon: (r) => (r.state === 'picked' && r.return_date < today() ? 'Late' : null),
      title: 'name',
      groups: [['partner_id', 'product_id', 'qty', 'deposit'], ['pickup_date', 'return_date', 'actual_return_date', 'price_per_day', 'amount_total', 'late_fee_factor', 'late_fee'], ['legacy_billing_review', 'legacy_billing_review_note']],
      chatter: true,
    },
  },
};
