import { postNote, write } from '../orm.js';
import { amounts, nextName, productLines, today } from './common.js';

const total = (r) => amounts(r.invoice_line_ids).total;
const residual = (r) => Math.max(0, Math.round((total(r) - (Number(r.amount_paid) || 0)) * 100) / 100);
const paymentState = (r) => {
  if (r.state !== 'posted') return 'not_paid';
  if (residual(r) === 0) return 'paid';
  return (Number(r.amount_paid) || 0) > 0 ? 'partial' : 'not_paid';
};
const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Post a draft move: assign its INV/BILL sequence number. */
function post(db, r) {
  const prefix = `${r.move_type === 'in_invoice' ? 'BILL' : 'INV'}/${(r.invoice_date ?? today()).slice(0, 4)}/`;
  return { db: write(db, 'account.move', r.id, { state: 'posted', name: nextName(db, 'account.move', prefix) }) };
}

function registerPayment(db, r) {
  const due = residual(r);
  const input = prompt(`Payment amount (due ${money(due)})`, String(due));
  const amount = Number(input);
  if (input == null || !(amount > 0)) return { db };
  const paid = Math.min(total(r), (Number(r.amount_paid) || 0) + amount);
  const next = write(db, 'account.move', r.id, { amount_paid: paid, payment_date: today() });
  return { db: postNote(next, 'account.move', r.id, `Payment of ${money(amount)} registered`) };
}

export const accountingModels = {
  'account.move': {
    label: 'Invoices',
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      move_type: { type: 'selection', label: 'Type', readonly: true, options: [['out_invoice', 'Customer Invoice'], ['in_invoice', 'Vendor Bill']] },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner', required: true },
      invoice_date: { type: 'date', label: 'Invoice Date' },
      invoice_date_due: { type: 'date', label: 'Due Date' },
      invoice_origin: { type: 'char', label: 'Source Document', readonly: true },
      payment_reference: { type: 'char', label: 'Payment Reference' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled']] },
      invoice_line_ids: productLines('Invoice Lines', 'list_price'),
      amount_untaxed: { type: 'monetary', label: 'Tax Excluded', compute: (r) => amounts(r.invoice_line_ids).untaxed },
      amount_tax: { type: 'monetary', label: 'Taxes', compute: (r) => amounts(r.invoice_line_ids).tax },
      amount_total: { type: 'monetary', label: 'Total', compute: total },
      amount_paid: { type: 'monetary', label: 'Paid', readonly: true },
      amount_residual: { type: 'monetary', label: 'Amount Due', compute: residual },
      payment_state: {
        type: 'selection',
        label: 'Payment Status',
        compute: paymentState,
        options: [['not_paid', 'Not Paid'], ['partial', 'Partially Paid'], ['paid', 'Paid']],
      },
      payment_date: { type: 'date', label: 'Paid on', readonly: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      purchase_id: { type: 'many2one', relation: 'purchase.order', label: 'Purchase Order', readonly: true },
      narration: { type: 'text', label: 'Terms and Conditions' },
    },
    defaults: () => ({ name: '/', move_type: 'out_invoice', state: 'draft', invoice_date: today(), invoice_line_ids: [], amount_paid: 0 }),
    filters: [
      [{ id: 'draft', label: 'Draft', fn: (r) => r.state === 'draft' }, { id: 'posted', label: 'Posted', fn: (r) => r.state === 'posted' }],
      [
        { id: 'unpaid', label: 'Not Paid', fn: (r) => r.state === 'posted' && paymentState(r) !== 'paid' },
        { id: 'overdue', label: 'Overdue', fn: (r) => r.state === 'posted' && paymentState(r) !== 'paid' && r.invoice_date_due < today() },
      ],
    ],
    groupBys: ['partner_id', 'state', 'payment_state', 'invoice_date', 'invoice_date_due'],
    views: ['list', 'kanban', 'graph', 'pivot', 'calendar'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total', 'invoice_date_due'], badge: 'payment_state' },
    list: ['name', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_untaxed', 'amount_total', 'amount_residual', 'payment_state'],
    listDecoration: (r) => (r.state === 'draft' ? 'info' : r.state === 'posted' && paymentState(r) !== 'paid' && r.invoice_date_due < today() ? 'danger' : null),
    graph: { groupBy: 'invoice_date', measure: 'amount_total' },
    pivot: { row: 'partner_id', col: 'payment_state', measure: 'amount_total' },
    calendar: { date: 'invoice_date_due' },
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state !== 'draft',
      statusbarHide: ['cancel'],
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: post },
        { label: 'Register Payment', primary: true, when: (r) => r.state === 'posted' && paymentState(r) !== 'paid', run: registerPayment },
        { label: 'Print', when: (r) => r.state === 'posted', run: (db) => { window.print(); return { db }; } },
        { label: 'Reset to Draft', when: (r) => r.state !== 'draft' && !(Number(r.amount_paid) > 0), vals: { state: 'draft' } },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      ribbon: (r) => (r.state === 'cancel' ? 'Cancelled' : paymentState(r) === 'paid' ? 'Paid' : paymentState(r) === 'partial' ? 'Partial' : null),
      subtitle: (r) => (r.move_type === 'in_invoice' ? 'Vendor Bill' : 'Customer Invoice'),
      title: 'name',
      groups: [['partner_id', 'payment_reference', 'invoice_origin'], ['invoice_date', 'invoice_date_due', 'payment_date']],
      tabs: [{ label: 'Invoice Lines', fields: ['invoice_line_ids'] }, { label: 'Other Info', fields: ['narration'] }],
      footer: ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual'],
      chatter: true,
    },
  },
};
