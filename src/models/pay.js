// Customer and vendor payments: posted with their own bank entry and applied to the partner's open invoices.
import { postNote, read, search, write } from '../orm.js';
import { nextName, today } from './common.js';
import { paymentJournal, postEntry } from './ledger.js';
import { payMove, releaseCashBasis } from './accounting.js';

const round = (n) => Math.round(n * 100) / 100;
// Which open documents a payment settles, by direction and partner side.
const SETTLES = { customer: { inbound: ['out_invoice'], outbound: ['out_refund'] }, supplier: { inbound: ['in_refund'], outbound: ['in_invoice'] } };

/**
 * Post a draft payment. With an invoice it pays that invoice; otherwise one entry is booked for the whole amount
 * and applied to the partner's open documents, oldest due first. Any rest stays as an outstanding credit.
 */
export function postPayment(db, p) {
  if (p.state !== 'draft') throw new Error('Only draft payments can be confirmed');
  if (!p.partner_id) throw new Error('Set the partner');
  if (!(Number(p.amount) > 0)) throw new Error('The amount must be positive');
  const date = p.date ?? today();
  if (p.invoice_id) return payMove(db, p.invoice_id, Number(p.amount), date, { paymentId: p.id, journalId: p.journal_id });
  const via = paymentJournal(db, p.journal_id);
  const name = p.name && p.name !== '/' ? p.name : nextName(db, 'account.payment', `P${via.code}/${date.slice(0, 4)}/`);
  const open = search(db, 'account.move')
    .filter((m) => m.state === 'posted' && m.partner_id === p.partner_id && m.amount_residual > 0 && SETTLES[p.partner_type]?.[p.payment_type]?.includes(m.move_type))
    .sort((a, b) => (a.invoice_date_due ?? '').localeCompare(b.invoice_date_due ?? ''));
  const inbound = p.payment_type === 'inbound';
  const counterpart = p.partner_type === 'supplier' ? '211000' : '121000';
  const amount = round(Number(p.amount));
  const { db: booked, id: moveId } = postEntry(db, {
    journal: via.code, date, ref: p.memo || name,
    lines: inbound
      ? [{ account: via.account, debit: amount, partner_id: p.partner_id }, { account: counterpart, credit: amount, partner_id: p.partner_id }]
      : [{ account: counterpart, debit: amount, partner_id: p.partner_id }, { account: via.account, credit: amount, partner_id: p.partner_id }],
  });
  // ponytail: applied in company currency at face value; foreign-currency invoices should be paid from the invoice.
  const { db: applied, left } = open.reduce((acc, m) => {
    const take = round(Math.min(acc.left, m.amount_residual));
    if (!(take > 0)) return acc;
    const released = releaseCashBasis(acc.db, m, take / m.amount_total, date);
    const next = write(released, 'account.move', m.id, { amount_paid: round((Number(m.amount_paid) || 0) + take), payment_date: date, payments: [...(m.payments ?? []), { date, amount: take, move_id: moveId }] });
    return { db: postNote(next, 'account.move', m.id, `Payment ${name} applied: ${take}`), left: round(acc.left - take) };
  }, { db: booked, left: amount });
  return write(applied, 'account.payment', p.id, { name, state: 'posted', move_id: moveId, unapplied: left });
}

const STATES = [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled']];

export const payModels = {
  'account.payment': {
    label: 'Payments',
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      payment_type: { type: 'selection', label: 'Payment Type', options: [['inbound', 'Receive'], ['outbound', 'Send']] },
      partner_type: { type: 'selection', label: 'Partner Type', options: [['customer', 'Customer'], ['supplier', 'Vendor']] },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      amount: { type: 'monetary', label: 'Amount' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      date: { type: 'date', label: 'Date' },
      memo: { type: 'char', label: 'Memo' },
      invoice_id: { type: 'many2one', relation: 'account.move', label: 'Invoice' },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      unapplied: { type: 'monetary', label: 'Outstanding Credit', readonly: true },
      state: { type: 'selection', label: 'Status', tracking: true, options: STATES },
    },
    defaults: () => ({ name: '/', payment_type: 'inbound', partner_type: 'customer', date: today(), state: 'draft', amount: 0 }),
    groupBys: ['partner_id', 'payment_type', 'state', 'date'],
    filters: [[{ id: 'in', label: 'Customer Payments', fn: (r) => r.payment_type === 'inbound' }, { id: 'out', label: 'Vendor Payments', fn: (r) => r.payment_type === 'outbound' }]],
    kanban: { title: 'name', lines: ['partner_id', 'amount', 'date'], badge: 'state' },
    list: ['date', 'name', 'partner_id', 'memo', 'payment_type', 'amount', 'state'],
    graph: { groupBy: 'date', measure: 'amount' },
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state !== 'draft',
      buttons: [
        { label: 'Confirm', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postPayment(db, read(db, 'account.payment', r.id)) }) },
        { label: 'Journal Entry', when: (r) => r.move_id, run: (db, r) => ({ db, go: `#/accounting/entries/${r.move_id}` }) },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['payment_type', 'partner_type', 'partner_id', 'amount', 'journal_id'], ['date', 'memo', 'invoice_id', 'move_id', 'unapplied']],
      chatter: true,
    },
  },
};
