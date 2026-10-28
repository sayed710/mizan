// Customer and vendor payments: posted with their own bank entry and applied to the partner's open invoices.
import { create, postNote, read, search, write } from '../orm.js';
import { nextName, today } from './common.js';
import { paymentJournal, postEntry } from './ledger.js';
import { payMove, releaseCashBasis } from './accounting.js';
import { datedLockDelete, datedLockGuard, paymentInvariant } from './finance.js';
import { round } from '../money.js';

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
    const released = releaseCashBasis(acc.db, m, take / m.amount_total, date, { final: take >= m.amount_residual });
    const next = write(released, 'account.move', m.id, { amount_paid: round((Number(m.amount_paid) || 0) + take), payment_date: date, payments: [...(m.payments ?? []), { date, amount: take, move_id: moveId, company_amount: take }] });
    return { db: postNote(next, 'account.move', m.id, `Payment ${name} applied: ${take}`), left: round(acc.left - take) };
  }, { db: booked, left: amount });
  return write(applied, 'account.payment', p.id, { name, state: 'posted', move_id: moveId, unapplied: left });
}

/**
 * Reverse a posted payment (FLOW-017): a mirror entry is posted on `date`, and what the payment settled becomes due
 * again, cash-basis taxes included. Payments made by a bank reconciliation stay, since the bank line still matches them.
 */
export function reversePayment(db, p, date = today()) {
  if (p.state !== 'posted' || !p.move_id) throw new Error('Only posted payments can be reversed');
  const entry = read(db, 'account.move', p.move_id);
  const fromBank = p.invoice_id && search(db, 'account.bank.statement.line')
    .some((l) => l.state === 'reconciled' && (l.payment_move_id ? l.payment_move_id === p.move_id
      // Legacy rows cannot disambiguate two identical payments: retain their conservative refusal until relinked.
      : l.move_id === p.invoice_id && l.date === p.date && round(Math.abs(l.amount)) === round(p.amount)));
  if (fromBank) throw new Error('This payment comes from a reconciled bank transaction and cannot be reversed here');
  const sources = new Set([entry.id]);
  for (const m of search(db, 'account.move')) for (const x of m.payments ?? []) {
    if (x.discount && !x.reversed && x.payment_move_id === p.move_id) sources.add(x.move_id);
  }
  let booked = db;
  const reversals = new Map();
  for (const id of sources) {
    const source = read(booked, 'account.move', id);
    const code = read(booked, 'account.journal', source.journal_id)?.code ?? 'BNK1';
    const made = create(booked, 'account.move', {
      move_type: 'entry', state: 'posted', journal_id: source.journal_id, invoice_date: date, ref: `Reversal of ${source.name}`, reversed_entry_id: source.id, partner_id: source.partner_id ?? null,
      name: nextName(booked, 'account.move', `${code}/${date.slice(0, 4)}/`), company_id: source.company_id ?? 1,
      line_ids: (source.line_ids ?? []).map((l) => ({ ...l, debit: l.credit, credit: l.debit, name: `Reversal: ${l.name ?? ''}`.trim() })),
    });
    booked = made.db;
    reversals.set(id, made.id);
  }
  const settled = search(booked, 'account.move').filter((m) => (m.payments ?? []).some((x) => sources.has(x.move_id) && !x.reversed));
  const reopened = settled.reduce((acc, m) => {
    const amount = round((m.payments ?? []).filter((x) => sources.has(x.move_id) && !x.reversed).reduce((sum, x) => sum + Number(x.amount), 0));
    const payments = m.payments.map((x) => sources.has(x.move_id) && !x.reversed ? { ...x, reversed: true, reversal_move_id: reversals.get(x.move_id) } : x);
    const released = releaseCashBasis(acc, m, -amount / m.amount_total, date);
    const next = write(released, 'account.move', m.id, { amount_paid: round((Number(m.amount_paid) || 0) - amount), payments, payment_date: payments.filter((x) => !x.reversed).at(-1)?.date ?? null });
    return postNote(next, 'account.move', m.id, `Payment ${p.name} reversed: ${amount}`);
  }, booked);
  const reversal = read(reopened, 'account.move', reversals.get(entry.id));
  let next = write(reopened, 'account.payment', p.id, { state: 'reversed', unapplied: 0 });
  if (p.sale_id) {
    const remaining = round(search(next, 'account.payment').filter((x) => x.sale_id === p.sale_id && x.state === 'posted').reduce((sum, x) => sum + Number(x.amount), 0));
    next = write(next, 'sale.order', p.sale_id, { amount_paid: remaining, payment_state: remaining > 0 ? 'paid' : 'pending' });
  }
  for (const batch of search(next, 'account.batch.payment').filter((b) => b.lines?.some((l) => l.payment_id === p.id))) {
    next = write(next, 'account.batch.payment', batch.id, { lines: batch.lines.map((l) => l.payment_id === p.id ? { ...l, cancelled: true } : l) });
  }
  return postNote(next, 'account.payment', p.id, `Reversed by ${reversal.name}`);
}

const STATES = [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled'], ['reversed', 'Reversed']];

export const payModels = {
  'account.payment': {
    label: 'Payments',
    guard: datedLockGuard(['name', 'amount', 'date', 'state', 'partner_id', 'partner_type', 'journal_id', 'move_id', 'invoice_id', 'payment_type', 'memo', 'unapplied', 'company_id', 'active'], (p) => p.state === 'posted'),
    protectDelete: datedLockDelete((p) => p.state === 'posted'),
    invariant: paymentInvariant,
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
        { label: 'Reverse', when: (r) => r.state === 'posted', run: (db, r) => ({ db: reversePayment(db, read(db, 'account.payment', r.id)) }) },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['payment_type', 'partner_type', 'partner_id', 'amount', 'journal_id'], ['date', 'memo', 'invoice_id', 'move_id', 'unapplied']],
      chatter: true,
    },
  },
};
