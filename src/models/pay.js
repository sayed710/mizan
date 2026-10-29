// Customer and vendor payments: posted with their own bank entry and applied to the partner's open invoices.
import { create, postNote, read, search, write } from '../orm.js';
import { nextName, today } from './common.js';
import { paymentJournal, postEntry } from './ledger.js';
import { payMove, releaseCashBasis } from './accounting.js';
import { datedLockDelete, datedLockGuard, paymentInvariant } from './finance.js';
import { round } from '../money.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';

// Which open documents a payment settles, by direction and partner side.
const amountMismatch = (a, b) => round(Number(a) - b) !== 0;
const SETTLES = { customer: { inbound: ['out_invoice'], outbound: ['out_refund'] }, supplier: { inbound: ['in_refund'], outbound: ['in_invoice'] } };

/**
 * Post a draft payment. With an invoice it pays that invoice; otherwise one entry is booked for the whole amount
 * and applied to the partner's open documents, oldest due first. Any rest stays as an outstanding credit.
 */
export function postPayment(db, p) {
  if (p.state !== 'draft') throw new Error('Only draft payments can be confirmed');
  if (!p.partner_id) throw new Error('Set the partner');
  if (!(Number(p.amount) > 0)) throw new Error('The amount must be positive');
  let currentPayment = p;
  if (!p.invoice_id && p.payment_type === 'outbound' && p.partner_type === 'supplier') {
    const resolvedBankId = resolveAndValidateRecipientBank(db, p.partner_id, p.partner_bank_id);
    if (resolvedBankId && resolvedBankId !== p.partner_bank_id) {
      currentPayment = { ...p, partner_bank_id: resolvedBankId };
      db = write(db, 'account.payment', p.id, { partner_bank_id: resolvedBankId });
    }
  }
  const date = currentPayment.date ?? today();
  if (currentPayment.invoice_id) return payMove(db, currentPayment.invoice_id, Number(currentPayment.amount), date, { paymentId: currentPayment.id, journalId: currentPayment.journal_id });
  const via = paymentJournal(db, currentPayment.journal_id);
  const name = currentPayment.name && currentPayment.name !== '/' ? currentPayment.name : nextName(db, 'account.payment', `P${via.code}/${date.slice(0, 4)}/`);
  const isTaxOrDirect = currentPayment.is_tax_payment || currentPayment.return_id || currentPayment.destination_account_id || currentPayment.destination_account_code;
  const open = isTaxOrDirect
    ? []
    : search(db, 'account.move')
        .filter((m) => m.state === 'posted' && m.partner_id === currentPayment.partner_id && m.amount_residual > 0 && SETTLES[currentPayment.partner_type]?.[currentPayment.payment_type]?.includes(m.move_type)
          && (!currentPayment.partner_bank_id || !m.partner_bank_id || m.partner_bank_id === currentPayment.partner_bank_id))
        .sort((a, b) => (a.invoice_date_due ?? '').localeCompare(b.invoice_date_due ?? ''));
  const inbound = currentPayment.payment_type === 'inbound';
  let taxClosing = null;
  if (currentPayment.return_id || currentPayment.is_tax_payment) {
    const ret = read(db, 'account.return', currentPayment.return_id);
    if (!ret || ret.state !== 'submitted' || (ret.company_id ?? 1) !== (currentPayment.company_id ?? 1)) throw new Error('A submitted tax return is required for settlement');
    const expected = round(Number(ret.total_amount_to_pay) || 0);
    if (!expected || inbound !== (expected < 0) || amountMismatch(currentPayment.amount, Math.abs(expected))) throw new Error('Payment must match the tax return obligation');
    const matches = (ret.closing_move_ids ?? []).flatMap((id) => {
      const move = read(db, 'account.move', id);
      if (!move || move.state !== 'posted' || (move.company_id ?? 1) !== (ret.company_id ?? 1)) return [];
      return (move.line_ids ?? []).map((line, index) => ({ move, line, index })).filter(({ line }) =>
        line.account_id === currentPayment.destination_account_id && line.partner_id === currentPayment.partner_id
        && round((Number(line.credit) || 0) - (Number(line.debit) || 0)) === expected);
    });
    if (matches.length !== 1 || (matches[0].move.payments ?? []).some((p) => !p.reversed)) throw new Error('An unsettled tax closing obligation is required');
    taxClosing = matches[0];
  }
  const counterpart = currentPayment.destination_account_code
    || (currentPayment.destination_account_id ? read(db, 'account.account', currentPayment.destination_account_id)?.code : null)
    || (currentPayment.partner_type === 'supplier' ? '211000' : '121000');
  const amount = round(Number(currentPayment.amount));
  const { db: booked, id: moveId } = postEntry(db, {
    journal: via.code, date, ref: currentPayment.memo || name,
    lines: inbound
      ? [{ account: via.account, debit: amount, partner_id: currentPayment.partner_id }, { account: counterpart, credit: amount, partner_id: currentPayment.partner_id }]
      : [{ account: counterpart, debit: amount, partner_id: currentPayment.partner_id }, { account: via.account, credit: amount, partner_id: currentPayment.partner_id }],
    company: currentPayment.company_id ?? 1,
    is_tax_payment: Boolean(currentPayment.is_tax_payment || currentPayment.return_id),
    tax_return_id: currentPayment.return_id ?? null,
  });
  // ponytail: applied in company currency at face value; foreign-currency invoices should be paid from the invoice.
  const { db: applied, left } = open.reduce((acc, m) => {
    const take = round(Math.min(acc.left, m.amount_residual));
    if (!(take > 0)) return acc;
    const released = releaseCashBasis(acc.db, m, take / m.amount_total, date, { final: take >= m.amount_residual });
    const next = write(released, 'account.move', m.id, { amount_paid: round((Number(m.amount_paid) || 0) + take), payment_date: date, payments: [...(m.payments ?? []), { date, amount: take, move_id: moveId, company_amount: take }], ...(!m.partner_bank_id && currentPayment.partner_bank_id ? { partner_bank_id: currentPayment.partner_bank_id } : {}) });
    return { db: postNote(next, 'account.move', m.id, `Payment ${name} applied: ${take}`), left: round(acc.left - take) };
  }, { db: booked, left: amount });
  const settled = taxClosing ? write(applied, 'account.move', taxClosing.move.id, {
    amount_paid: amount,
    payment_date: date,
    payments: [...(taxClosing.move.payments ?? []), { date, amount, move_id: moveId, company_amount: amount, line_index: taxClosing.index }],
  }) : applied;
  return write(settled, 'account.payment', currentPayment.id, { name, state: 'posted', move_id: moveId, unapplied: taxClosing ? 0 : left });
}

/**
 * Reverse a posted payment (FLOW-017): a mirror entry is posted on `date`, and what the payment settled becomes due
 * again, cash-basis taxes included. Payments made by a bank reconciliation stay, since the bank line still matches them.
 */
export function reversePayment(db, p, date = today()) {
  if (p.state !== 'posted' || !p.move_id) throw new Error('Only posted payments can be reversed');
  if (p.return_id || p.is_tax_payment) throw new Error('Tax return payments cannot be reversed independently');
  const entry = read(db, 'account.move', p.move_id);
  const fromBank = p.invoice_id && search(db, 'account.bank.statement.line')
    .some((l) => l.state === 'reconciled' && l.move_id === p.invoice_id && l.date === p.date && round(Math.abs(l.amount)) === round(p.amount));
  if (fromBank) throw new Error('This payment comes from a reconciled bank transaction and cannot be reversed here');
  const code = read(db, 'account.journal', entry.journal_id)?.code ?? 'BNK1';
  const { db: booked, id: reversalId } = create(db, 'account.move', {
    move_type: 'entry', state: 'posted', journal_id: entry.journal_id, invoice_date: date, ref: `Reversal of ${entry.name}`, reversed_entry_id: entry.id, partner_id: entry.partner_id ?? null,
    name: nextName(db, 'account.move', `${code}/${date.slice(0, 4)}/`),
    line_ids: (entry.line_ids ?? []).map((l) => ({ ...l, debit: l.credit, credit: l.debit, name: `Reversal: ${l.name ?? ''}`.trim() })),
  });
  const settled = search(booked, 'account.move').filter((m) => (m.payments ?? []).some((x) => x.move_id === p.move_id));
  const reopened = settled.reduce((acc, m) => {
    const amount = round((m.payments ?? []).filter((x) => x.move_id === p.move_id).reduce((sum, x) => sum + Number(x.amount), 0));
    const payments = m.payments.map((x) => x.move_id === p.move_id ? { ...x, reversed: true, reversal_move_id: reversalId } : x);
    const released = releaseCashBasis(acc, m, -amount / m.amount_total, date);
    const next = write(released, 'account.move', m.id, { amount_paid: round((Number(m.amount_paid) || 0) - amount), payments, payment_date: payments.filter((x) => !x.reversed).at(-1)?.date ?? null });
    return postNote(next, 'account.move', m.id, `Payment ${p.name} reversed: ${amount}`);
  }, booked);
  const reversal = read(reopened, 'account.move', reversalId);
  return postNote(write(reopened, 'account.payment', p.id, { state: 'reversed', unapplied: 0 }), 'account.payment', p.id, `Reversed by ${reversal.name}`);
}

const STATES = [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled'], ['reversed', 'Reversed']];

export const payModels = {
  'account.payment': {
    label: 'Payments',
    guard: datedLockGuard(['name', 'amount', 'date', 'state', 'partner_id', 'partner_bank_id', 'partner_type', 'journal_id', 'move_id', 'invoice_id', 'payment_type', 'memo', 'unapplied', 'company_id', 'active'], (p) => p.state === 'posted'),
    protectDelete: datedLockDelete((p) => p.state === 'posted'),
    invariant: paymentInvariant,
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      payment_type: { type: 'selection', label: 'Payment Type', options: [['inbound', 'Receive'], ['outbound', 'Send']] },
      partner_type: { type: 'selection', label: 'Partner Type', options: [['customer', 'Customer'], ['supplier', 'Vendor']] },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      partner_bank_id: { type: 'many2one', relation: 'res.partner.bank', label: 'Recipient Bank Account' },
      amount: { type: 'monetary', label: 'Amount' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      date: { type: 'date', label: 'Date' },
      memo: { type: 'char', label: 'Memo' },
      destination_account_id: { type: 'many2one', relation: 'account.account', label: 'Destination Account' },
      destination_account_code: { type: 'char', label: 'Destination Account Code', hidden: true },
      is_tax_payment: { type: 'boolean', label: 'Tax Payment', hidden: true },
      return_id: { type: 'many2one', relation: 'account.return', label: 'Tax Return', readonly: true },
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
