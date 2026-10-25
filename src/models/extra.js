// Email Marketing, Sign, Documents, Planning, Rental, Appointments.
import { create, read, search, write } from '../orm.js';
import { addDays, pad, today } from './common.js';
import { moveStock } from './sales.js';

const state = (options, label = 'Status') => ({ type: 'selection', label, tracking: true, options });
const days = (a, b) => (a && b ? Math.max(1, Math.round((new Date(b) - new Date(a)) / 864e5)) : 1);

/** ponytail: sending is simulated (counts recipients, no SMTP); plug a mail transport into the server to deliver for real. */
function sendMailing(db, m) {
  const recipients = search(db, 'mailing.contact').filter((c) => c.list_id === m.list_id && !c.opt_out && c.email);
  if (!recipients.length) throw new Error('The mailing list has no subscribed recipients');
  return { db: write(db, 'mailing.mailing', m.id, { state: 'sent', sent_date: today(), sent: recipients.length, delivered: recipients.length }) };
}

function signDocument(db, r) {
  const name = prompt('Type your full name to sign', read(db, 'res.partner', r.partner_id)?.name ?? '');
  if (!name?.trim()) return { db };
  return { db: write(db, 'sign.request', r.id, { state: 'signed', signature: name.trim(), sign_date: today() }) };
}

/** Late days past the planned return (actual return date, or today while still out). */
const lateDays = (r, at = today()) => (r.return_date ? Math.max(0, Math.round((new Date(r.actual_return_date ?? at) - new Date(r.return_date)) / 864e5)) : 0);
const lateFee = (r, at) => Math.round(lateDays(r, at) * (Number(r.qty) || 0) * (Number(r.price_per_day) || 0) * (Number(r.late_fee_factor) || 0) * 100) / 100;

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
  return write(db, 'sale.rental', r.id, { state: 'reserved' });
}

/** Invoice the late fee accrued since the last invoice (rental returned after being invoiced). */
function lateFeeInvoice(db, r) {
  const delta = Math.round((lateFee(r) - (Number(r.late_fee_invoiced) || 0)) * 100) / 100;
  if (!(delta > 0)) throw new Error('No additional late fee to invoice');
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: r.partner_id, invoice_origin: r.name, invoice_date: today(), invoice_date_due: addDays(today(), 15),
    invoice_line_ids: [{ product_id: r.product_id, name: `Late return (${lateDays(r)} day(s))`, qty: 1, price_unit: delta, tax: 14 }],
  });
  return { db: write(next, 'sale.rental', r.id, { late_fee_invoiced: lateFee(r) }), go: `#/accounting/invoices/${id}` };
}

function rentalInvoice(db, r) {
  const fee = lateFee(r);
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: r.partner_id, invoice_origin: r.name, invoice_date: today(), invoice_date_due: addDays(today(), 15),
    invoice_line_ids: [
      { product_id: r.product_id, name: 'Rental', qty: r.qty * days(r.pickup_date, r.return_date), price_unit: r.price_per_day, tax: 14 },
      ...(fee ? [{ product_id: r.product_id, name: `Late return (${lateDays(r)} day(s))`, qty: 1, price_unit: fee, tax: 14 }] : []),
    ],
  });
  return { db: write(next, 'sale.rental', r.id, { invoiced: true, late_fee_invoiced: fee }), go: `#/accounting/invoices/${id}` };
}

/** A booking must fall inside one of the type's weekly slots (when it defines any) and respect the slot capacity. */
export function bookingGuard(db, b) {
  if (b.state === 'cancel') return null;
  const type = read(db, 'appointment.type', b.type_id);
  if (!type) return null;
  const weekday = String(new Date(`${b.date}T00:00:00`).getDay());
  const slots = type.slot_ids ?? [];
  if (slots.length && !slots.some((s) => s.weekday === weekday && (!b.time || (b.time >= s.start && b.time < s.end)))) return `${type.name} is not available at that time`;
  const minutes = (t) => (/^\d{2}:\d{2}$/.test(t ?? '') ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
  const length = Math.max(1, Math.round((Number(type.duration) || 1) * 60));
  const start = minutes(b.time);
  const overlaps = (x) => (start == null || minutes(x.time) == null ? x.time === b.time : minutes(x.time) < start + length && start < minutes(x.time) + length);
  const same = (db.records['appointment.booking'] ?? []).filter((x) => x.id !== b.id && x.type_id === b.type_id && x.date === b.date && x.state !== 'cancel' && overlaps(x));
  return same.length >= (Number(type.capacity) || 1) ? 'This slot is already booked' : null;
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

  'mailing.list': {
    label: 'Mailing Lists',
    fields: { name: { type: 'char', label: 'Mailing List', required: true } },
    kanban: { title: 'name', lines: [], counter: { label: 'Contacts', model: 'mailing.contact', field: 'list_id' } },
    list: ['name'],
    form: { title: 'name', smart: [{ label: 'Contacts', model: 'mailing.contact', field: 'list_id', target: 'marketing/contacts' }], groups: [[], []] },
  },

  'mailing.contact': {
    label: 'Mailing Contacts',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      email: { type: 'char', label: 'Email', required: true },
      phone: { type: 'char', label: 'Mobile' },
      list_id: { type: 'many2one', relation: 'mailing.list', label: 'Mailing List' },
      opt_out: { type: 'boolean', label: 'Opted Out' },
    },
    filters: [[{ id: 'subscribed', label: 'Subscribed', fn: (r) => !r.opt_out }, { id: 'optout', label: 'Opted Out', fn: (r) => r.opt_out }]],
    groupBys: ['list_id', 'opt_out'],
    kanban: { title: 'name', lines: ['email', 'list_id'], avatar: true },
    list: ['name', 'email', 'list_id', 'opt_out'],
    views: ['list', 'kanban'],
    form: { title: 'name', groups: [['email', 'list_id'], ['opt_out']] },
  },

  'mailing.mailing': {
    label: 'Mailings',
    fields: {
      subject: { type: 'char', label: 'Subject', required: true },
      list_id: { type: 'many2one', relation: 'mailing.list', label: 'Recipients' },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Responsible' },
      body: { type: 'text', label: 'Mail Body' },
      state: state([['draft', 'Draft'], ['scheduled', 'Scheduled'], ['sent', 'Sent']]),
      schedule_date: { type: 'date', label: 'Scheduled for' },
      sent_date: { type: 'date', label: 'Sent on', readonly: true },
      sent: { type: 'integer', label: 'Sent', readonly: true },
      delivered: { type: 'integer', label: 'Delivered', readonly: true },
      opened: { type: 'integer', label: 'Opened', readonly: true },
      clicked: { type: 'integer', label: 'Clicked', readonly: true },
      replied: { type: 'integer', label: 'Replied', readonly: true },
    },
    defaults: () => ({ state: 'draft', user_id: 1, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0 }),
    groupBys: ['state', 'list_id', 'user_id', 'sent_date'],
    kanban: { groupBy: 'state', title: 'subject', lines: ['list_id', 'sent', 'sent_date'], badge: 'user_id' },
    list: ['sent_date', 'subject', 'user_id', 'sent', 'delivered', 'opened', 'clicked', 'replied', 'state'],
    views: ['list', 'kanban', 'calendar', 'graph'],
    calendar: { date: 'schedule_date' },
    graph: { groupBy: 'list_id', measure: 'sent' },
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'sent',
      buttons: [
        { label: 'Send', email: 'mailing', primary: true, when: (r) => r.state !== 'sent', run: sendMailing },
        { label: 'Schedule', when: (r) => r.state === 'draft', vals: { state: 'scheduled', schedule_date: addDays(today(), 1) } },
      ],
      title: 'subject',
      groups: [['list_id', 'user_id', 'schedule_date'], ['sent_date', 'sent', 'delivered', 'opened']],
      tabs: [{ label: 'Mail Body', fields: ['body'] }],
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
    },
    defaults: () => ({ state: 'draft', deadline: addDays(today(), 14) }),
    filters: [[{ id: 'to_sign', label: 'To Sign', fn: (r) => r.state === 'sent' }, { id: 'signed', label: 'Signed', fn: (r) => r.state === 'signed' }]],
    groupBys: ['state', 'partner_id'],
    kanban: { groupBy: 'state', title: 'name', lines: ['partner_id', 'deadline'] },
    list: ['name', 'partner_id', 'deadline', 'sign_date', 'state'],
    form: {
      statusbar: 'state',
      statusbarHide: ['canceled'],
      lockedWhen: (r) => r.state === 'signed',
      buttons: [
        { label: 'Send', primary: true, vals: { state: 'sent' }, when: (r) => r.state === 'draft' },
        { label: 'Sign Now', primary: true, when: (r) => r.state === 'sent', run: signDocument },
        { label: 'Cancel', vals: { state: 'canceled' }, when: (r) => ['draft', 'sent'].includes(r.state) },
      ],
      ribbon: (r) => (r.state === 'signed' ? 'Signed' : null),
      title: 'name',
      groups: [['partner_id', 'deadline'], ['signature', 'sign_date']],
      tabs: [{ label: 'Document Content', fields: ['body'] }],
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
    },
    defaults: () => ({ folder: 'inbox', owner_id: 1, tag_ids: [], create_date: today() }),
    groupBys: ['folder', 'owner_id', 'partner_id', 'create_date'],
    kanban: { groupBy: 'folder', title: 'name', lines: ['owner_id', 'create_date'], tags: 'tag_ids' },
    list: ['name', 'folder', 'owner_id', 'partner_id', 'create_date'],
    form: { title: 'name', groups: [['folder', 'file', 'tag_ids'], ['owner_id', 'partner_id', 'create_date']], chatter: true },
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
    },
    defaults: () => ({ name: 'Shift', start: today(), allocated_hours: 8, role: 'sales', state: 'draft' }),
    filters: [[{ id: 'open', label: 'Open Shifts', fn: (r) => !r.employee_id }, { id: 'published', label: 'Published', fn: (r) => r.state === 'published' }]],
    groupBys: ['employee_id', 'role', 'start', 'state'],
    kanban: { groupBy: 'employee_id', title: 'name', lines: ['start', 'allocated_hours', 'role'], badge: 'state' },
    list: ['start', 'employee_id', 'role', 'name', 'allocated_hours', 'state'],
    views: ['gantt', 'calendar', 'kanban', 'list', 'pivot'],
    gantt: { start: 'start', stop: 'end', row: 'employee_id', color: 'state', hours: 'allocated_hours' },
    calendar: { date: 'start' },
    pivot: { row: 'employee_id', col: 'role', measure: 'allocated_hours' },
    form: {
      statusbar: 'state',
      buttons: [{ label: 'Publish', primary: true, vals: { state: 'published' }, when: (r) => r.state === 'draft' }],
      title: 'name',
      groups: [['employee_id', 'role'], ['start', 'end', 'allocated_hours']],
      tabs: [{ label: 'Note', fields: ['note'] }],
      chatter: true,
    },
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
      amount_total: { type: 'monetary', label: 'Total', compute: (r) => (Number(r.qty) || 0) * (Number(r.price_per_day) || 0) * days(r.pickup_date, r.return_date) },
      actual_return_date: { type: 'date', label: 'Returned on', readonly: true },
      late_fee_factor: { type: 'float', label: 'Late Fee (× daily price)' },
      late_fee: { type: 'monetary', label: 'Late Fee', compute: (r) => lateFee(r) },
      deposit: { type: 'monetary', label: 'Security Deposit' },
      late_fee_invoiced: { type: 'monetary', label: 'Late Fee Invoiced', readonly: true },
      state: state([['quotation', 'Quotation'], ['reserved', 'Reserved'], ['picked', 'Picked-up'], ['returned', 'Returned'], ['cancel', 'Cancelled']]),
      invoiced: { type: 'boolean', label: 'Invoiced', readonly: true },
    },
    defaults: (id) => ({ name: 'R' + pad(id), qty: 1, state: 'quotation', pickup_date: today(), return_date: addDays(today(), 3), price_per_day: 0, late_fee_factor: 1.5, deposit: 0, invoiced: false }),
    filters: [
      [
        { id: 'pickups', label: 'Pickups', fn: (r) => r.state === 'reserved' && r.pickup_date <= today() },
        { id: 'returns', label: 'Returns', fn: (r) => r.state === 'picked' && r.return_date <= today() },
        { id: 'late', label: 'Late', fn: (r) => r.state === 'picked' && r.return_date < today() },
      ],
      [{ id: 'to_invoice', label: 'To Invoice', fn: (r) => ['picked', 'returned'].includes(r.state) && !r.invoiced }],
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
        { label: 'Pickup', primary: true, when: (r) => r.state === 'reserved', run: (db, r) => ({ db: write(moveStock(db, [{ product_id: r.product_id, qty: r.qty }], -1), 'sale.rental', r.id, { state: 'picked' }) }) },
        { label: 'Return', primary: true, when: (r) => r.state === 'picked', run: (db, r) => ({ db: write(moveStock(db, [{ product_id: r.product_id, qty: r.qty }], 1), 'sale.rental', r.id, { state: 'returned', actual_return_date: today() }) }) },
        { label: 'Create Invoice', when: (r) => ['picked', 'returned'].includes(r.state) && !r.invoiced, run: rentalInvoice },
        { label: 'Invoice Late Fee', when: (r) => r.state === 'returned' && r.invoiced && lateFee(r) > (Number(r.late_fee_invoiced) || 0), run: lateFeeInvoice },
        { label: 'Cancel', vals: { state: 'cancel' }, when: (r) => ['quotation', 'reserved'].includes(r.state) },
      ],
      ribbon: (r) => (r.state === 'picked' && r.return_date < today() ? 'Late' : null),
      title: 'name',
      groups: [['partner_id', 'product_id', 'qty', 'deposit'], ['pickup_date', 'return_date', 'actual_return_date', 'price_per_day', 'amount_total', 'late_fee_factor', 'late_fee']],
      chatter: true,
    },
  },

  'appointment.type': {
    label: 'Appointment Types',
    fields: {
      name: { type: 'char', label: 'Appointment Title', required: true },
      duration: { type: 'float', label: 'Duration (hours)' },
      location: { type: 'char', label: 'Location' },
      user_id: { type: 'many2one', relation: 'hr.employee', label: 'Host' },
      description: { type: 'text', label: 'Introduction Message' },
      capacity: { type: 'integer', label: 'Bookings per Slot' },
      is_published: { type: 'boolean', label: 'Published on Website' },
      slot_ids: {
        type: 'one2many', label: 'Availabilities',
        fields: {
          weekday: { type: 'selection', label: 'Day', options: [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']] },
          start: { type: 'char', label: 'From (HH:MM)' }, end: { type: 'char', label: 'To (HH:MM)' },
        },
        newLine: () => ({ weekday: '1', start: '09:00', end: '17:00' }),
      },
    },
    defaults: () => ({ duration: 1, user_id: 1, capacity: 1, slot_ids: [] }),
    kanban: { title: 'name', lines: ['duration', 'location', 'user_id'], counter: { label: 'Bookings', model: 'appointment.booking', field: 'type_id' } },
    list: ['name', 'duration', 'location', 'user_id'],
    form: {
      title: 'name',
      smart: [{ label: 'Bookings', model: 'appointment.booking', field: 'type_id', target: 'appointments/bookings' }],
      groups: [['duration', 'location'], ['user_id', 'capacity', 'is_published']],
      tabs: [{ label: 'Availabilities', fields: ['slot_ids'] }, { label: 'Introduction Message', fields: ['description'] }],
    },
  },

  'appointment.booking': {
    label: 'Bookings',
    fields: {
      name: { type: 'char', label: 'Booked by', required: true },
      type_id: { type: 'many2one', relation: 'appointment.type', label: 'Appointment', required: true },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      date: { type: 'date', label: 'Date', required: true },
      time: { type: 'char', label: 'Time' },
      state: state([['booked', 'Booked'], ['done', 'Attended'], ['no_show', 'No Show'], ['cancel', 'Cancelled']]),
    },
    defaults: () => ({ date: addDays(today(), 1), time: '10:00', state: 'booked' }),
    guard: (db, before, after) => bookingGuard(db, after),
    groupBys: ['type_id', 'state', 'date'],
    kanban: { groupBy: 'state', title: 'name', lines: ['type_id', 'date', 'time'] },
    list: ['date', 'time', 'name', 'type_id', 'partner_id', 'state'],
    views: ['calendar', 'list', 'kanban'],
    calendar: { date: 'date', time: 'time' },
    form: {
      statusbar: 'state',
      statusbarClickable: true,
      title: 'name',
      groups: [['type_id', 'partner_id'], ['date', 'time']],
      chatter: true,
    },
  },
};
