// Customer and vendor payments: posted with their own bank entry and applied to the partner's open invoices.
import { create, postNote, read, search, write } from '../orm.js';
import { nextName, today, validDate } from './common.js';
import { journalId, outstandingAccount, paymentJournal, postEntry } from './ledger.js';
import { payMove, releaseCashBasis } from './accounting.js';
import { datedLockDelete, datedLockGuard, paymentInvariant, settlementFxError } from './finance.js';
import { postAnalytic } from './analyticplus.js';
import { companyCurrencyRecord, documentCurrency, round, roundCurrency } from '../money.js';
import { rateAt } from './currency.js';
import { settlementCompanyAmount } from './settlement.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';
import { exchangeAccount } from './exchange-account.js';
import { isPaymentMatched } from './bank.js';

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
  if (!Number.isFinite(Number(p.amount)) || !(Number(p.amount) > 0)) throw new Error('The amount must be a finite positive number');
  let currentPayment = p;
  if (!p.invoice_id && p.payment_type === 'outbound' && p.partner_type === 'supplier') {
    const resolvedBankId = resolveAndValidateRecipientBank(db, p.partner_id, p.partner_bank_id, { companyId: p.company_id ?? 1 });
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
        .filter((m) => m.state === 'posted' && m.partner_id === currentPayment.partner_id && (m.company_id ?? 1) === (currentPayment.company_id ?? 1) && m.invoice_date <= date && m.amount_residual > 0 && SETTLES[currentPayment.partner_type]?.[currentPayment.payment_type]?.includes(m.move_type)
          && (!currentPayment.partner_bank_id || !m.partner_bank_id || m.partner_bank_id === currentPayment.partner_bank_id))
        .sort((a, b) => (a.invoice_date_due ?? '').localeCompare(b.invoice_date_due ?? ''));
  const inbound = currentPayment.payment_type === 'inbound';
  const journal = read(db, 'account.journal', currentPayment.journal_id ?? journalId(db, via.code, currentPayment.company_id ?? 1));
  const outstanding = outstandingAccount(db, journal, currentPayment.company_id ?? 1, inbound);
  const liquidity = outstanding ?? via.account;
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
  const companyCurrency = companyCurrencyRecord(db, currentPayment.company_id);
  const companyRound = (n) => roundCurrency(n, companyCurrency);
  const amount = companyRound(Number(currentPayment.amount));
  const { db: booked, id: moveId } = postEntry(db, {
    journal: via.code, journal_id: journal?.id, date, ref: currentPayment.memo || name,
    lines: inbound
      ? [{ account: liquidity, debit: amount, partner_id: currentPayment.partner_id }, { account: counterpart, credit: amount, partner_id: currentPayment.partner_id }]
      : [{ account: counterpart, debit: amount, partner_id: currentPayment.partner_id }, { account: liquidity, credit: amount, partner_id: currentPayment.partner_id }],
    company: currentPayment.company_id ?? 1,
    is_tax_payment: Boolean(currentPayment.is_tax_payment || currentPayment.return_id),
    tax_return_id: currentPayment.return_id ?? null,
  });
  // Register the source before allocations so all callers can derive its currency semantics.
  const registered = write(booked, 'account.payment', p.id, { name, state: 'posted', move_id: moveId, outstanding_account_id: outstanding, unapplied: amount });
  // Apply a company-currency payment against the recorded company balance of each document.
  const { db: applied, left } = open.reduce((acc, m) => {
    if (!(acc.left > 0)) return acc;
    const rate = rateAt(acc.db, m.currency_id, date, m.company_id);
    const docCurrency = documentCurrency(acc.db, m);
    const step = Number(docCurrency?.rounding ?? 0.01);
    const take = Math.min(m.amount_residual, Number((Math.floor((acc.left * rate / step) + 1e-9) * step).toPrecision(15)));
    const cashAmount = companyRound(take / rate);
    const companyAmount = settlementCompanyAmount(acc.db, m, take);
    if (!(take > 0) || !(cashAmount > 0) || cashAmount > acc.left) return acc;
    const diff = companyRound((cashAmount - companyAmount) * (inbound ? 1 : -1));
    let withFx = acc.db;
    let fxMove = null;
    if (diff) {
      const fx = postEntry(withFx, { journal: 'MISC', company: p.company_id ?? 1, date, ref: `Exchange difference ${name}`,
        lines: diff > 0
          ? [{ account: counterpart, debit: diff, partner_id: p.partner_id }, { account: exchangeAccount(withFx, p.company_id, diff), credit: diff }]
          : [{ account: counterpart, credit: -diff, partner_id: p.partner_id }, { account: exchangeAccount(withFx, p.company_id, diff), debit: -diff }] });
      withFx = { ...fx.db, records: { ...fx.db.records, 'account.move': fx.db.records['account.move'].map((entry) => entry.id === fx.id ? { ...entry, fx_payment_move_id: moveId, fx_invoice_id: m.id } : entry) } }; fxMove = fx.id;
    }
    const released = releaseCashBasis(withFx, m, take / m.amount_total, date, { final: take >= m.amount_residual });
    const next = write(released.db, 'account.move', m.id, { amount_paid: roundCurrency((Number(m.amount_paid) || 0) + take, docCurrency), payment_date: date, payments: [...(m.payments ?? []), { date, amount: take, move_id: moveId, company_amount: companyAmount, payment_company_amount: cashAmount, cash_basis_move_id: released.id, ...(fxMove ? { payment_fx_move_id: fxMove } : {}) }], ...(!m.partner_bank_id && currentPayment.partner_bank_id ? { partner_bank_id: currentPayment.partner_bank_id } : {}) });
    return { db: postNote(next, 'account.move', m.id, `Payment ${name} applied: ${take}`), left: companyRound(acc.left - cashAmount) };
  }, { db: registered, left: amount });
  const settled = taxClosing ? write(applied, 'account.move', taxClosing.move.id, {
    amount_paid: amount, payment_date: date,
    payments: [...(taxClosing.move.payments ?? []), { date, amount, move_id: moveId, company_amount: amount, line_index: taxClosing.index }],
  }) : applied;
  return write(settled, 'account.payment', p.id, { name, state: 'posted', move_id: moveId, unapplied: taxClosing ? 0 : left });
}

/** Post a linked mirror of an existing entry (optionally in a chosen journal/date, or reverse-and-create a new draft). */
export function reverseEntry(db, source, dateOrOptions = today(), extraOptions = {}) {
  const opts = typeof dateOrOptions === 'object' && dateOrOptions !== null && !Array.isArray(dateOrOptions)
    ? dateOrOptions
    : { ...(extraOptions ?? {}), ...(typeof dateOrOptions === 'string' ? { date: dateOrOptions } : {}) };
  const date = opts.date ?? opts.invoice_date ?? today();
  const sourceDate = source?.invoice_date ?? source?.date ?? '';
  if (!source || source.state !== 'posted' || source.move_type !== 'entry' || !validDate(date) || date < sourceDate) {
    throw new Error('A posted entry and valid reversal date are required');
  }
  if (search(db, 'account.move').some((m) => m.state === 'posted' && m.reversed_entry_id === source.id)) {
    throw new Error('This entry has already been reversed');
  }
  const mode = opts.mode ?? (opts.reverse_and_create ? 'modify' : 'reverse');
  if (!['reverse', 'modify'].includes(mode)) throw new Error('Choose a valid reversal mode');
  const companyId = source.company_id ?? 1;
  let targetJournalId = opts.journal_id ?? source.journal_id ?? null;
  if (!targetJournalId && opts.journal) {
    targetJournalId = typeof opts.journal === 'number' ? opts.journal : (journalId(db, opts.journal, companyId) ?? journalId(db, opts.journal));
  }
  const journalRec = targetJournalId ? read(db, 'account.journal', targetJournalId) : null;
  if (targetJournalId && !journalRec) throw new Error('Selected journal does not exist');
  if (journalRec?.company_id && journalRec.company_id !== companyId) throw new Error('Journal belongs to another company');
  const code = journalRec?.code ?? 'BNK1';
  const reason = String(opts.reason ?? '').trim();
  const ref = reason ? `Reversal of ${source.name}, ${reason}` : `Reversal of ${source.name}`;
  const created = create(db, 'account.move', {
    move_type: 'entry',
    state: 'posted',
    journal_id: targetJournalId,
    invoice_date: date,
    date,
    ref,
    reversed_entry_id: source.id,
    partner_id: source.partner_id ?? null,
    name: nextName(db, 'account.move', `${code}/${date.slice(0, 4)}/`),
    company_id: companyId,
    line_ids: (source.line_ids ?? []).map((l) => ({
      ...l,
      debit: l.credit,
      credit: l.debit,
      ...(l.currency_id ? { amount_currency: -(Number(l.amount_currency) || 0) } : {}),
      ...(l.tax_zero ? { tax_base: -(Number(l.tax_base) || 0) } : {}),
      name: `Reversal: ${l.name ?? ''}`.trim(),
    })),
  });
  let next = postAnalytic(created.db, created.id);
  const currentSource = read(next, 'account.move', source.id);
  if (currentSource && !currentSource.inalterable_hash) {
    next = write(next, 'account.move', source.id, { reversal_move_id: created.id });
  }
  next = postNote(next, 'account.move', source.id, `Reversed by ${read(next, 'account.move', created.id).name}`);
  if (mode === 'modify') {
    const draft = create(next, 'account.move', {
      move_type: 'entry',
      state: 'draft',
      name: '/',
      journal_id: targetJournalId,
      invoice_date: date,
      date,
      ref: source.ref ?? '',
      partner_id: source.partner_id ?? null,
      company_id: companyId,
      ...(source.currency_id ? { currency_id: source.currency_id } : {}),
      line_ids: (source.line_ids ?? []).map((l) => ({ ...l })),
    });
    return { db: draft.db, id: draft.id, reversal_id: created.id, go: `#/accounting/entries/${draft.id}` };
  }
  return { db: next, id: created.id, go: `#/accounting/entries/${created.id}` };
}

/** Reverse the exact cash-basis entry released by a settlement. */
function reverseCashBasis(db, allocation, invoice, date) {
  if (!allocation.cash_basis_move_id) return db;
  const original = read(db, 'account.move', allocation.cash_basis_move_id);
  if (!original) throw new Error('Cash-basis release for payment not found');
  const lines = original.line_ids.map((l) => ({
    ...l, account: read(db, 'account.account', l.account_id)?.code, debit: l.credit, credit: l.debit,
    tax_base: (l.tax_base_signed || !(Number(l.debit) || Number(l.credit)) ? -1 : 1) * (Number(l.tax_base) || 0),
  }));
  const company = read(db, 'res.company', invoice.company_id ?? 1) ? (invoice.company_id ?? 1) : null;
  const reversal = postEntry(db, { journal: 'MISC', date, ref: `Cash basis taxes ${invoice.name}`, lines, company });
  return write(reversal.db, 'account.move', reversal.id, { reversed_entry_id: original.id });
}

/** Reverse a write-off settlement without changing unrelated invoice applications. */
export function reverseWriteoff(db, invoiceId, moveId, date) {
  const invoice = read(db, 'account.move', invoiceId);
  const row = (invoice?.payments ?? []).find((p) => p.move_id === moveId && !p.reversed);
  if (!row) throw new Error('The linked write-off settlement is missing');
  const reversed = reverseEntry(db, read(db, 'account.move', moveId), date);
  const released = reverseCashBasis(reversed.db, row, invoice, date);
  const payments = invoice.payments.map((p) => p === row ? { ...p, reversed: true, reversal_move_id: reversed.id, reversal_date: date } : p);
  return write(released, 'account.move', invoiceId, { amount_paid: roundCurrency((Number(invoice.amount_paid) || 0) - Number(row.amount), documentCurrency(db, invoice)), payments, payment_date: payments.filter((p) => !p.reversed).at(-1)?.date ?? null });
}

/**
 * Reverse a posted payment (FLOW-017): a mirror entry is posted on `date`, and what the payment settled becomes due
 * again, cash-basis taxes included. Payments made by a bank reconciliation stay, since the bank line still matches them.
 */
export function reversePayment(db, p, date = today()) {
  if (p.state !== 'posted' || !p.move_id) throw new Error('Only posted payments can be reversed');
  if (p.return_id || p.is_tax_payment) throw new Error('Tax return payments cannot be reversed independently');
  const entry = read(db, 'account.move', p.move_id);
  const fromBank = isPaymentMatched(db, p);
  const missingBankLink = p.invoice_id && search(db, 'account.bank.statement.line').some((l) => l.state === 'reconciled' && l.move_id === p.invoice_id && !l.payment_move_id);
  if (missingBankLink) throw new Error('Cannot reverse payment: the reconciled bank transaction is missing its payment link; repair it first');
  if (fromBank) throw new Error('This payment is linked to a reconciled bank transaction; unreconcile the transaction before reversing it');
  // A posted legacy line without payment identity could represent any payment of its linked invoice.
  // Do not guess from amount or reference; require the missing link to be repaired first.
  const missingBatchLink = (db.records['account.batch.payment'] ?? []).some((batch) => batch.state === 'posted'
    && (batch.lines ?? []).some((line) => !line.cancelled && !line.payment_id
      && p.invoice_id && line.move_id === p.invoice_id));
  if (missingBatchLink) throw new Error('Cannot reverse payment: a posted batch line is missing its payment_id; repair the payment link first');
  if (date < (p.date ?? entry.invoice_date)) throw new Error('Reversal date cannot be before the payment date');
  for (const m of search(db, 'account.move')) for (const x of m.payments ?? []) {
    if (x.move_id === entry.id && !x.reversed) {
      const error = settlementFxError(db, m, x);
      if (error) throw new Error(error);
    }
  }
  const sources = new Set([entry.id]);
  for (const m of search(db, 'account.move')) for (const x of m.payments ?? []) {
    if (x.discount && !x.reversed && x.payment_move_id === p.move_id) sources.add(x.move_id);
    if (!x.reversed && x.move_id === p.move_id && x.payment_fx_move_id) sources.add(x.payment_fx_move_id);
  }
  if (search(db, 'account.move').some((m) => (m.payments ?? []).some((x) => sources.has(x.move_id) && !x.reversed && x.date > date))) throw new Error('Reversal date cannot be before an application date');
  let booked = db;
  const reversals = new Map();
  for (const id of sources) {
    const source = read(booked, 'account.move', id);
    const made = reverseEntry(booked, source, date);
    booked = made.db;
    reversals.set(id, made.id);
  }
  const settled = search(booked, 'account.move').filter((m) => (m.payments ?? []).some((x) => sources.has(x.move_id) && !x.reversed));
  const reopened = settled.reduce((acc, m) => {
    const active = (m.payments ?? []).filter((x) => sources.has(x.move_id) && !x.reversed);
    const docCurrency = documentCurrency(acc, m);
    const amount = roundCurrency(active.reduce((sum, x) => sum + Number(x.amount), 0), docCurrency);
    const payments = m.payments.map((x) => sources.has(x.move_id) && !x.reversed ? { ...x, reversed: true, reversal_move_id: reversals.get(x.move_id), reversal_date: date } : x);
    let released = acc;
    for (const allocation of active) {
      if (Object.hasOwn(allocation, 'cash_basis_move_id')) {
        released = reverseCashBasis(released, allocation, m, date);
      }
    }
    const legacy = active.filter((x) => !Object.hasOwn(x, 'cash_basis_move_id') && !x.discount);
    const legacyAmount = roundCurrency(legacy.reduce((sum, x) => sum + Number(x.amount), 0), docCurrency);
    if (legacy.length && m.amount_total) {
      released = releaseCashBasis(released, m, -legacyAmount / m.amount_total, date).db;
    }
    const next = write(released, 'account.move', m.id, { amount_paid: roundCurrency((Number(m.amount_paid) || 0) - amount, docCurrency), payments, payment_date: payments.filter((x) => !x.reversed).at(-1)?.date ?? null });
    return postNote(next, 'account.move', m.id, `Payment ${p.name} reversed: ${amount}`);
  }, booked);
  const reversal = read(reopened, 'account.move', reversals.get(entry.id));
  let next = write(reopened, 'account.payment', p.id, { state: 'reversed', unapplied: 0 });
  if (p.sale_id) {
    const remaining = round(search(next, 'account.payment').filter((x) => x.sale_id === p.sale_id && x.state === 'posted').reduce((sum, x) => sum + Number(x.amount), 0));
    next = write(next, 'sale.order', p.sale_id, { amount_paid: remaining, payment_state: remaining > 0 ? 'paid' : 'pending' });
  }
  for (const batch of (next.records['account.batch.payment'] ?? []).filter((b) => b.state === 'posted' && b.lines?.some((l) => l.payment_id === p.id))) {
    next = write(next, 'account.batch.payment', batch.id, { lines: batch.lines.map((l) => l.payment_id === p.id ? { ...l, cancelled: true } : l) });
  }
  return postNote(next, 'account.payment', p.id, `Reversed by ${reversal.name}`);
}

/** Every check number a journal has ever consumed: issued, printed on a batch line, or voided by a reprint. */
const consumedCheckNumbers = (db, journalId) => {
  const payments = (db.records['account.payment'] ?? []).filter((p) => p.journal_id === journalId);
  const ids = new Set(payments.map((p) => p.id));
  const fromBatches = (db.records['account.batch.payment'] ?? []).flatMap((b) => (b.lines ?? []).filter((l) => ids.has(l.payment_id)).map((l) => l.check_number));
  return [...payments.map((p) => p.check_number), ...payments.flatMap((p) => (p.voided_check_numbers ?? []).map((v) => v.check_number)), ...fromBatches]
    .filter((n) => Number.isSafeInteger(n) && n > 0);
};

/** First check number a journal may print next: its "Next Check Number" setting, pushed past every number already consumed. */
export function nextCheckNumber(db, journalId, requested = 0) {
  const journal = read(db, 'account.journal', journalId);
  return consumedCheckNumbers(db, journalId).reduce((next, n) => Math.max(next, n + 1), Number(requested || journal?.check_next_number || 1));
}

/** Reprint an issued check on a fresh number: the old number is voided (kept on the payment, never reused). */
export function reprintCheck(db, payment) {
  const p = read(db, 'account.payment', payment.id) ?? payment;
  if (p.check_number == null || p.payment_type !== 'outbound') throw new Error('Only issued checks can be reprinted');
  if (p.state !== 'posted') throw new Error('Only posted checks can be reprinted');
  const number = nextCheckNumber(db, p.journal_id);
  let next = write(db, 'account.payment', p.id, { check_number: number, voided_check_numbers: [...(p.voided_check_numbers ?? []), { check_number: p.check_number, date: today() }] });
  for (const batch of (next.records['account.batch.payment'] ?? []).filter((b) => b.lines?.some((l) => l.payment_id === p.id))) {
    next = write(next, 'account.batch.payment', batch.id, { lines: batch.lines.map((l) => l.payment_id === p.id ? { ...l, check_number: number } : l) });
  }
  next = write(next, 'account.journal', p.journal_id, { check_next_number: number + 1 });
  return postNote(next, 'account.payment', p.id, `Check ${p.check_number} voided, reprinted as ${number}`);
}

const STATES = [['draft', 'Draft'], ['posted', 'Posted'], ['cancel', 'Cancelled'], ['reversed', 'Reversed']];

export const payModels = {
  'account.payment': {
    label: 'Payments',
    guard: (db, before, after, ctx) => (before?.check_number != null && (before.journal_id !== after.journal_id || (before.check_number !== after.check_number && !(after.voided_check_numbers ?? []).some((v) => v.check_number === before.check_number) )) ? 'Issued check numbers cannot be changed' : null) ?? datedLockGuard(['name', 'amount', 'currency_id', 'date', 'state', 'partner_id', 'partner_bank_id', 'partner_type', 'journal_id', 'move_id', 'invoice_id', 'payment_type', 'memo', 'unapplied', 'company_id', 'active'], (p) => p.state === 'posted')(db, before, after, ctx),
    protectDelete: (db, payment, staged) => payment.check_number != null ? 'Issued checks cannot be deleted' : datedLockDelete((p) => p.state === 'posted')(db, payment, staged),
    invariant: paymentInvariant,
    fields: {
      name: { type: 'char', label: 'Number', readonly: true },
      payment_type: { type: 'selection', label: 'Payment Type', options: [['inbound', 'Receive'], ['outbound', 'Send']] },
      partner_type: { type: 'selection', label: 'Partner Type', options: [['customer', 'Customer'], ['supplier', 'Vendor']] },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Partner' },
      partner_bank_id: { type: 'many2one', relation: 'res.partner.bank', label: 'Recipient Bank Account' },
      amount: { type: 'monetary', label: 'Amount' },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', readonly: true },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      check_number: { type: 'integer', label: 'Check Number', readonly: true },
      voided_check_numbers: { type: 'one2many', label: 'Voided Checks', readonly: true, fields: { check_number: { type: 'integer', label: 'Check Number' }, date: { type: 'date', label: 'Date' } } },
      date: { type: 'date', label: 'Date' },
      memo: { type: 'char', label: 'Memo' },
      destination_account_id: { type: 'many2one', relation: 'account.account', label: 'Destination Account' },
      destination_account_code: { type: 'char', label: 'Destination Account Code', hidden: true },
      is_tax_payment: { type: 'boolean', label: 'Tax Payment', hidden: true },
      return_id: { type: 'many2one', relation: 'account.return', label: 'Tax Return', readonly: true },
      invoice_id: { type: 'many2one', relation: 'account.move', label: 'Invoice' },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Journal Entry', readonly: true },
      outstanding_account_id: { type: 'many2one', relation: 'account.account', label: 'Outstanding Account', readonly: true, hidden: true },
      sale_id: { type: 'many2one', relation: 'sale.order', label: 'Sales Order', readonly: true },
      unapplied: { type: 'monetary', label: 'Outstanding Credit', readonly: true, currency: 'company' },
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
        { label: 'Reprint Check', when: (r) => r.state === 'posted' && r.check_number != null, run: (db, r) => ({ db: reprintCheck(db, r) }) },
        { label: 'Cancel', when: (r) => r.state === 'draft', vals: { state: 'cancel' } },
      ],
      title: 'name',
      groups: [['payment_type', 'partner_type', 'partner_id', 'amount', 'journal_id'], ['date', 'memo', 'invoice_id', 'move_id', 'unapplied']],
      chatter: true,
    },
  },
};
