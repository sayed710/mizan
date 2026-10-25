import { create, postNote, read, write } from '../orm.js';
import { amounts, nextName, productLines, today } from './common.js';
import { ACCOUNT_TYPES, invoiceLines, isBalanced, journalId, postEntry } from './ledger.js';
import { moveDeleteGuard, moveGuard } from './finance.js';
import { toCompany } from './currency.js';
import { dueDate, earlyDiscount } from './terms.js';
import { syncInvoicedQty } from './sales.js';

const isInvoice = (r) => r.move_type !== 'entry';
const isRefund = (r) => r.move_type === 'out_refund';
const total = (r) => (isInvoice(r) ? amounts(r.invoice_line_ids).total : (r.line_ids ?? []).reduce((s, l) => s + (Number(l.debit) || 0), 0));
const residual = (r) => (isInvoice(r) ? Math.max(0, Math.round((total(r) - (Number(r.amount_paid) || 0)) * 100) / 100) : 0);
const paymentState = (r) => {
  if (r.state !== 'posted' || !isInvoice(r)) return 'not_paid';
  if (residual(r) === 0) return 'paid';
  return (Number(r.amount_paid) || 0) > 0 ? 'partial' : 'not_paid';
};
const money = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const PREFIX = { out_invoice: 'INV', out_refund: 'RINV', in_invoice: 'BILL', entry: 'MISC' };

/** Post a draft move: invoices get their journal items generated; manual entries must balance. */
export function postMove(db, id) {
  const r = read(db, 'account.move', id);
  const year = (r.invoice_date ?? today()).slice(0, 4);
  const name = r.name && r.name !== '/' ? r.name : nextName(db, 'account.move', `${PREFIX[r.move_type]}/${year}/`);
  if (!isInvoice(r)) {
    if (!isBalanced(r.line_ids)) throw new Error('Journal entry is not balanced: total debit must equal total credit');
    return write(db, 'account.move', id, { state: 'posted', name });
  }
  if (!r.partner_id) throw new Error('Partner is required');
  if (!(r.invoice_line_ids ?? []).length) throw new Error('Add at least one invoice line');
  const journal = journalId(db, r.move_type === 'in_invoice' ? 'BILL' : 'INV');
  return write(db, 'account.move', id, { state: 'posted', name, journal_id: journal, line_ids: invoiceLines(db, { ...r, name }) });
}

/** Record a payment: bank entry against receivable/payable + paid amount on the invoice. */
export function payMove(db, id, amount, date = today()) {
  const r = read(db, 'account.move', id);
  const value = Math.min(amount, residual(r));
  if (!(value > 0)) return db;
  const sale = r.move_type === 'out_invoice';
  // Bank moves at today's rate, the receivable/payable at the invoice rate; the gap is an exchange difference.
  // ponytail: partial foreign payments can leave a cent of company-currency rounding on the receivable.
  const bank = toCompany(db, r.currency_id, value, date);
  const open = toCompany(db, r.currency_id, value, r.invoice_date ?? date);
  const diff = Math.round((sale ? bank - open : open - bank) * 100) / 100;
  const fx = diff > 0 ? [{ account: '450100', credit: diff }] : diff < 0 ? [{ account: '690100', debit: -diff }] : [];
  const { db: withEntry, id: paymentMove } = postEntry(db, {
    journal: 'BNK1', date, ref: `Payment ${r.name}`,
    lines: sale
      ? [{ account: '101401', debit: bank, partner_id: r.partner_id }, { account: '121000', credit: open, partner_id: r.partner_id }, ...fx]
      : [{ account: '211000', debit: open, partner_id: r.partner_id }, { account: '101401', credit: bank, partner_id: r.partner_id }, ...fx],
  });
  const payments = [...(r.payments ?? []), { date, amount: value, move_id: paymentMove }];
  const next = write(withEntry, 'account.move', id, { amount_paid: (Number(r.amount_paid) || 0) + value, payment_date: date, payments });
  return postNote(next, 'account.move', id, `Payment of ${money(value)} registered`);
}

/** Draft credit note reversing a posted customer invoice. */
function creditNote(db, r) {
  const { db: next, id } = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: r.partner_id, invoice_origin: r.name, invoice_date: today(), invoice_date_due: today(),
    invoice_line_ids: r.invoice_line_ids.map((l) => ({ ...l })), ref: `Reversal of ${r.name}`, currency_id: r.currency_id ?? null,
  });
  return { db: next, go: `#/accounting/credit-notes/${id}` };
}

/** Early-payment discount available on `date` for an unpaid invoice (0 when its term has none or the window passed). */
export function discountAvailable(db, r, date = today()) {
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  return term && !(Number(r.amount_paid) > 0) ? earlyDiscount(term, total(r), r.invoice_date, date) : 0;
}

/** Pay `amount`; when it settles the invoice net of an early-payment discount, book the discount too. */
export function payWithDiscount(db, id, amount, date = today()) {
  const r = read(db, 'account.move', id);
  const due = residual(r);
  const paid = payMove(db, id, amount, date);
  const gap = Math.round((due - amount) * 100) / 100;
  const discount = Math.min(discountAvailable(db, r, date), gap);
  if (!(gap > 0) || discount < gap - 0.005) return paid;
  const sale = r.move_type === 'out_invoice';
  const value = toCompany(db, r.currency_id, discount, r.invoice_date ?? date);
  const { db: booked } = postEntry(paid, {
    journal: 'MISC', date, ref: `Early payment discount ${r.name}`,
    lines: sale
      ? [{ account: '690200', debit: value, partner_id: r.partner_id }, { account: '121000', credit: value, partner_id: r.partner_id }]
      : [{ account: '211000', debit: value, partner_id: r.partner_id }, { account: '450200', credit: value, partner_id: r.partner_id }],
  });
  const after = read(booked, 'account.move', id);
  return postNote(write(booked, 'account.move', id, { amount_paid: (Number(after.amount_paid) || 0) + discount }), 'account.move', id, `Early payment discount of ${money(discount)} applied`);
}

function registerPayment(db, r) {
  const due = Math.round((residual(r) - discountAvailable(db, r)) * 100) / 100;
  const input = prompt(`Payment amount (due ${money(due)})`, String(due));
  const amount = Number(input);
  if (input == null || !(amount > 0)) return { db };
  return { db: payWithDiscount(db, r.id, amount) };
}

const termDue = (db, r) => {
  const term = read(db, 'account.payment.term', r.invoice_payment_term_id);
  return term && r.invoice_date ? { invoice_date_due: dueDate(term, r.invoice_date) } : {};
};

const invoiceLineBase = productLines('Invoice Lines', 'list_price');
const invoiceLineField = { ...invoiceLineBase, fields: { name: { type: 'char', label: 'Label' }, ...invoiceLineBase.fields, account_id: { type: 'many2one', relation: 'account.account', label: 'Account' } } };

const lineItem = {
  type: 'one2many',
  label: 'Journal Items',
  fields: {
    account_id: { type: 'many2one', relation: 'account.account', label: 'Account' },
    partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
    name: { type: 'char', label: 'Label' },
    debit: { type: 'monetary', label: 'Debit' },
    credit: { type: 'monetary', label: 'Credit' },
  },
  newLine: () => ({ account_id: null, partner_id: null, name: '', debit: 0, credit: 0 }),
};

export const accountingModels = {
  'account.account': {
    label: 'Chart of Accounts',
    fields: {
      code: { type: 'char', label: 'Code', required: true },
      name: { type: 'char', label: 'Account Name', required: true },
      account_type: { type: 'selection', label: 'Type', options: ACCOUNT_TYPES },
      reconcile: { type: 'boolean', label: 'Allow Reconciliation' },
    },
    defaults: () => ({ account_type: 'expense' }),
    groupBys: ['account_type'],
    kanban: { title: 'name', lines: ['code', 'account_type'] },
    list: ['code', 'name', 'account_type'],
    views: ['list', 'kanban'],
    form: {
      title: 'name',
      groups: [['code', 'account_type'], ['reconcile']],
    },
  },

  'account.journal': {
    label: 'Journals',
    fields: {
      name: { type: 'char', label: 'Journal Name', required: true },
      code: { type: 'char', label: 'Short Code', required: true },
      type: { type: 'selection', label: 'Type', options: [['sale', 'Sales'], ['purchase', 'Purchase'], ['bank', 'Bank'], ['cash', 'Cash'], ['general', 'Miscellaneous']] },
      default_account_id: { type: 'many2one', relation: 'account.account', label: 'Default Account' },
    },
    defaults: () => ({ type: 'general' }),
    kanban: { title: 'name', lines: ['code', 'type'], counter: { label: 'Entries', model: 'account.move', field: 'journal_id' } },
    list: ['code', 'name', 'type', 'default_account_id'],
    form: {
      title: 'name',
      smart: [{ label: 'Entries', model: 'account.move', field: 'journal_id', target: 'accounting/entries' }],
      groups: [['code', 'type'], ['default_account_id']],
    },
  },

  'account.move': {
    label: 'Invoices',
    guard: moveGuard,
    protectDelete: moveDeleteGuard,
    audited: (db) => db.settings?.audit_trail === true,
    onUnlink: (db, r) => syncInvoicedQty(db, r),
    // The partner's payment term becomes the default; the term and invoice date drive the due date.
    onchange: (r, key, db) => {
      if (key === 'partner_id' && r.partner_id) {
        const term = read(db, 'res.partner', r.partner_id)?.property_payment_term_id;
        return term ? { invoice_payment_term_id: term, ...termDue(db, { ...r, invoice_payment_term_id: term }) } : {};
      }
      return ['invoice_payment_term_id', 'invoice_date'].includes(key) ? termDue(db, r) : {};
    },
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      move_type: { type: 'selection', label: 'Type', readonly: true, options: [['out_invoice', 'Customer Invoice'], ['out_refund', 'Credit Note'], ['in_invoice', 'Vendor Bill'], ['entry', 'Journal Entry']] },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      ref: { type: 'char', label: 'Reference' },
      invoice_date: { type: 'date', label: 'Date' },
      invoice_date_due: { type: 'date', label: 'Due Date' },
      invoice_origin: { type: 'char', label: 'Source Document', readonly: true },
      payment_reference: { type: 'char', label: 'Payment Reference' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency' },
      invoice_payment_term_id: { type: 'many2one', relation: 'account.payment.term', label: 'Payment Terms' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled']] },
      invoice_line_ids: invoiceLineField,
      payments: {
        type: 'one2many', label: 'Payments', readonly: true,
        fields: { date: { type: 'date', label: 'Paid on' }, amount: { type: 'monetary', label: 'Amount' }, move_id: { type: 'many2one', relation: 'account.move', label: 'Payment' } },
        newLine: () => ({ date: today(), amount: 0, move_id: null }),
      },
      line_ids: lineItem,
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
    defaults: () => ({ name: '/', move_type: 'out_invoice', state: 'draft', invoice_date: today(), invoice_line_ids: [], line_ids: [], amount_paid: 0 }),
    filters: [
      [{ id: 'draft', label: 'Draft', fn: (r) => r.state === 'draft' }, { id: 'posted', label: 'Posted', fn: (r) => r.state === 'posted' }],
      [
        { id: 'unpaid', label: 'Not Paid', fn: (r) => r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid' },
        { id: 'overdue', label: 'Overdue', fn: (r) => r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid' && r.invoice_date_due < today() },
      ],
    ],
    groupBys: ['partner_id', 'journal_id', 'state', 'payment_state', 'invoice_date', 'invoice_date_due'],
    views: ['list', 'kanban', 'graph', 'pivot', 'calendar'],
    kanban: { title: 'name', lines: ['partner_id', 'amount_total', 'invoice_date_due'], badge: 'payment_state' },
    list: ['name', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_untaxed', 'amount_total', 'amount_residual', 'payment_state'],
    listDecoration: (r) => (r.state === 'draft' ? 'info' : r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid' && r.invoice_date_due < today() ? 'danger' : null),
    graph: { groupBy: 'invoice_date', measure: 'amount_total' },
    pivot: { row: 'partner_id', col: 'payment_state', measure: 'amount_total' },
    calendar: { date: 'invoice_date_due' },
    form: {
      statusbar: 'state',
      statusbarHide: ['cancel'],
      lockedWhen: (r) => r.state !== 'draft',
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postMove(db, r.id) }) },
        // Server-only: Claude reads an uploaded bill (image/PDF) into this draft.
        { label: 'Digitize Document', upload: 'image/*,application/pdf', server: '/api/integrations/digitize', requires: 'ai', when: (r) => r.state === 'draft' && r.move_type === 'in_invoice' },
        { label: 'Register Payment', primary: true, when: (r) => r.state === 'posted' && isInvoice(r) && paymentState(r) !== 'paid', run: registerPayment },
        { label: 'Send by Email', email: 'document', when: (r) => r.state === 'posted' && isInvoice(r), run: (db) => ({ db }) },
        { label: 'Credit Note', when: (r) => r.state === 'posted' && r.move_type === 'out_invoice', run: creditNote },
        { label: 'Print', when: (r) => r.state === 'posted' && isInvoice(r), run: (db, r) => ({ db, go: `#/print/account.move/${r.id}` }) },
        { label: 'Reset to Draft', when: (r) => r.state !== 'draft' && !(Number(r.amount_paid) > 0), vals: { state: 'draft' } },
        { label: 'Cancel', when: (r) => r.state === 'draft', run: (db, r) => ({ db: syncInvoicedQty(write(db, 'account.move', r.id, { state: 'cancel' }), r) }) },
      ],
      ribbon: (r) => (r.state === 'cancel' ? 'Cancelled' : paymentState(r) === 'paid' ? 'Paid' : paymentState(r) === 'partial' ? 'Partial' : null),
      subtitle: (r) => ({ in_invoice: 'Vendor Bill', out_refund: 'Credit Note', entry: 'Journal Entry' })[r.move_type] ?? 'Customer Invoice',
      title: 'name',
      groups: [['partner_id', 'ref', 'invoice_origin'], ['invoice_date', 'invoice_payment_term_id', 'invoice_date_due', 'journal_id', 'currency_id', 'payment_date']],
      tabs: (r) => (isInvoice(r)
        ? [{ label: 'Invoice Lines', fields: ['invoice_line_ids'] }, { label: 'Journal Items', fields: ['line_ids'], readonly: true }, { label: 'Payments', fields: ['payments'], readonly: true }, { label: 'Other Info', fields: ['narration'] }]
        : [{ label: 'Journal Items', fields: ['line_ids'] }]),
      footer: (r) => (isInvoice(r) ? ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual'] : ['amount_total']),
      chatter: true,
    },
  },
};
