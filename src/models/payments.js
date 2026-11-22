// Batch payments: pay several invoices in one operation; outbound batches also number and print checks.
import { create, read, search, write } from '../orm.js';
import { nextName, today, validDate } from './common.js';
import { discountAvailable, payMove, payWithDiscount } from './accounting.js';
import { cents, round, roundCurrency, documentCurrency, companyCurrencyRecord, formatCurrency } from '../money.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';
import { defaultPaymentJournalId, isLiquidityJournal, paymentJournal } from './ledger.js';
import { journalMethodLines } from './paymentmethod.js';
import { customerPaymentView, vendorPaymentView, payModels, paymentPaysByCheck, printBatchChecks, nextCheckNumber } from './pay.js';
import { isPaymentMatched } from './bank.js';
import { recipientBankCompanyError } from './company.js';

const MOVE_TYPE = { inbound: 'out_invoice', outbound: 'in_invoice' };
const TYPE_LABEL = { out_invoice: 'customer invoice', in_invoice: 'vendor bill' };

export const CHECK_REGISTER_STATES = ['Posted', 'Issued', 'Voided', 'Reversed', 'Cancelled'];

/** Normalize posted batch checks and individual check payment history for the register. */
export function checkRegisterRows(db, batches = db.records['account.batch.payment'] ?? [], payments = db.records['account.payment'] ?? []) {
  const postedBatches = batches.filter((batch) => batch.state === 'posted' && batch.batch_type === 'outbound');
  const batchedPaymentIds = new Set(postedBatches.flatMap((batch) => (batch.lines ?? []).map((line) => line.payment_id).filter(Boolean)));
  const batchRows = postedBatches.flatMap((batch) => (batch.lines ?? []).flatMap((line, index) => {
    if (line.check_number == null) return [];
    const payment = read(db, 'account.payment', line.payment_id);
    const current = {
      key: `batch-${batch.id}-${index}`,
      checkNumber: line.check_number,
      date: batch.date,
      paymentId: line.payment_id,
      invoiceId: line.move_id,
      batchId: batch.id,
      amount: line.amount,
      state: line.cancelled ? 'Cancelled' : payment?.state === 'posted' ? 'Posted' : payment?.state === 'cancel' ? 'Cancelled' : 'Unknown',
    };
    const voided = (payment?.voided_check_numbers ?? []).map((item, voidIndex) => ({
      key: `batch-${batch.id}-${index}-voided-${voidIndex}`,
      checkNumber: item.check_number,
      date: item.date ?? batch.date,
      paymentId: line.payment_id,
      invoiceId: line.move_id,
      batchId: batch.id,
      amount: line.amount,
      state: 'Voided',
    }));
    return [current, ...voided];
  }));
  const individualRows = payments
    .filter((payment) => ['posted', 'reversed'].includes(payment.state) && payment.payment_type === 'outbound' && payment.check_number != null && !batchedPaymentIds.has(payment.id))
    .flatMap((payment) => {
      const voided = payment.voided_check_numbers ?? [];
      const rows = voided.map((item, index) => ({
        key: `payment-${payment.id}-voided-${index}`,
        checkNumber: item.check_number,
        date: item.date ?? payment.date,
        paymentId: payment.id,
        amount: payment.amount,
        state: 'Voided',
      }));
      if (!voided.some((item) => item.check_number === payment.check_number)) {
        rows.push({
          key: `payment-${payment.id}-issued`,
          checkNumber: payment.check_number,
          date: payment.date,
          paymentId: payment.id,
          amount: payment.amount,
          state: payment.state === 'reversed' ? 'Reversed' : 'Issued',
        });
      }
      return rows;
    });
  return [...batchRows, ...individualRows];
}

export function batchCurrency(db, batch) {
  const lines = batch.lines ?? [];
  if (!lines.length) {
    const companyId = batch.company_id ?? read(db, 'account.journal', batch.journal_id)?.company_id;
    const currency = companyId ? companyCurrencyRecord(db, companyId) : null;
    return currency ? { id: currency.id, currency, error: null } : { id: null, currency: null, error: 'Configure a company currency before adding invoices to the batch' };
  }
  const currencies = [];
  for (const line of lines) {
    const record = line.payment_id ? read(db, 'account.payment', line.payment_id) : read(db, 'account.move', line.move_id);
    if (!record) return { id: null, currency: null, error: 'Select an existing invoice or payment on every batch line' };
    const currency = documentCurrency(db, record);
    if (!currency) return { id: null, currency: null, error: 'Configure a currency for every company before adding invoices to the batch' };
    currencies.push(currency);
  }
  const ids = new Set(currencies.map((currency) => currency.id));
  if (ids.size !== 1) return { id: null, currency: null, error: 'Batch invoices must use the same currency; a mixed-currency total is unavailable' };
  return { id: currencies[0].id, currency: currencies[0], error: null };
}

/** Replace the batch lines with every posted, still-open invoice of the matching type, at its residual. */
export function fillOpenInvoices(db, batch) {
  const selectedJournal = batch.journal_id ? read(db, 'account.journal', batch.journal_id) : null;
  const company = selectedJournal?.company_id ?? batch.company_id;
  if (!company || !read(db, 'res.company', company)) throw new Error('Select a company for the batch');
  const journalConfig = paymentJournal(db, batch.journal_id, company);
  const journal = read(db, 'account.journal', journalConfig.id);
  const configuredCurrency = journal.currency_id ? read(db, 'res.currency', journal.currency_id) : companyCurrencyRecord(db, company);
  if (!configuredCurrency) throw new Error('Configure the journal or company currency before filling the batch');
  const open = search(db, 'account.move').filter(
    (m) => (m.company_id ?? 1) === company && m.state === 'posted' && m.move_type === MOVE_TYPE[batch.batch_type]
      && documentCurrency(db, m)?.id === configuredCurrency.id && (Number(m.amount_residual) || 0) > 0,
  );
  return write(db, 'account.batch.payment', batch.id, { journal_id: journal.id, lines: open.map((m) => ({ move_id: m.id, amount: m.amount_residual })) });
}

export const paymentMethodIdOf = (db, payment) => {
  const line = payment?.payment_method_line_id ? read(db, 'account.payment.method.line', payment.payment_method_line_id) : null;
  return line?.payment_method_id ?? payment?.payment_method_id ?? null;
};

export function batchPaymentMethod(db, batch) {
  if (!db || !batch) return null;
  if (batch.payment_method_id) {
    return read(db, 'account.payment.method', batch.payment_method_id) ?? null;
  }
  if (batch.batch_type === 'outbound') {
    return search(db, 'account.payment.method').find((m) => m.code === 'check_printing' && m.payment_type === 'outbound') ?? null;
  }
  return null;
}

export function isCheckBatch(db, batch) {
  if (!db || !batch || batch.batch_type !== 'outbound') return false;
  const method = batchPaymentMethod(db, batch);
  return method?.code === 'check_printing';
}

/**
 * Resolve the active payment method line on `journal` for `batch` (when a method is explicitly chosen
 * or defaulted for an outbound check batch), returning `{ method, line, error }`.
 */
export function resolveBatchMethodLine(db, batch, journal = null) {
  if (!db || !batch) return { method: null, line: null, error: null };
  const explicit = Boolean(batch.payment_method_id);
  const method = explicit
    ? read(db, 'account.payment.method', batch.payment_method_id)
    : batchPaymentMethod(db, batch);
  if (explicit && (!method || method.active === false)) {
    return { method: null, line: null, error: 'Select an active payment method' };
  }
  if (explicit && batch.batch_type && method.payment_type !== batch.batch_type) {
    return { method, line: null, error: 'Payment method direction must match the batch' };
  }
  const isCheck = batch.batch_type === 'outbound' && method?.code === 'check_printing';
  const targetJournalId = journal?.id ?? batch.journal_id ?? null;
  if (!method || !targetJournalId) {
    return { method: method ?? null, line: null, error: null };
  }
  const line = journalMethodLines(db, targetJournalId, batch.batch_type)
    .find((l) => l.payment_method_id === method.id) ?? null;
  if (!line && (explicit || isCheck)) {
    return {
      method,
      line: null,
      error: isCheck
        ? 'The batch journal has no check payment method'
        : 'The selected payment method is not available on this journal',
    };
  }
  return { method, line, error: null };
}

/** Validate the batch, pay each line, number the checks (outbound), assign the reference and post. */
export function postBatch(db, batch) {
  if (batch.state !== 'draft') throw new Error('Only draft batches can be validated');
  const lines = batch.lines ?? [];
  if (!lines.length) throw new Error('Add at least one invoice to the batch');
  const expected = MOVE_TYPE[batch.batch_type];
  const invoiceIds = lines.filter((l) => !l.payment_id).map((l) => l.move_id);
  const paymentIds = lines.filter((l) => l.payment_id).map((l) => l.payment_id);
  if (new Set(invoiceIds).size !== invoiceIds.length) throw new Error('An invoice can appear only once in a batch');
  if (new Set(paymentIds).size !== paymentIds.length) throw new Error('A payment can appear only once in a batch');
  if (!validDate(batch.date)) throw new Error('Enter a valid batch payment date');
  const isCheck = isCheckBatch(db, batch);
  const companies = new Set();
  for (const line of lines) {
    if (line.payment_id) {
      if (line.move_id) throw new Error('Select either an invoice or an existing payment on each batch line');
      const payment = read(db, 'account.payment', line.payment_id);
      if (!payment || payment.state !== 'posted' || !payment.move_id || read(db, 'account.move', payment.move_id)?.state !== 'posted') throw new Error('Select an existing posted payment');
      if (payment.payment_type !== batch.batch_type) throw new Error('Payment direction must match the batch');
      if (payment.journal_id !== batch.journal_id) throw new Error('Payment journal must match the batch journal');
      if (isCheck && !paymentPaysByCheck(db, payment)) throw new Error('A check batch only holds check payments');
      if (batch.payment_method_id && paymentMethodIdOf(db, payment) !== batch.payment_method_id) {
        throw new Error('Selected payments must use the same payment method');
      }
      if (isPaymentMatched(db, payment)) throw new Error('Payment is already matched');
      if ((db.records['account.batch.payment'] ?? []).some((other) => other.id !== batch.id && (other.lines ?? []).some((item) => !item.cancelled && item.payment_id === payment.id))) throw new Error('Payment is already in a batch');
      if (!(Number(line.amount) > 0) || roundCurrency(Number(line.amount) - Number(payment.amount), documentCurrency(db, payment)) !== 0) throw new Error('Batch amount must match the payment amount');
      companies.add(payment.company_id ?? 1);
      continue;
    }
    const move = read(db, 'account.move', line.move_id);
    if (!move) throw new Error(line.move_id ? `Invoice ${line.move_id} not found` : 'Select an invoice on every batch line');
    if (move.state !== 'posted') throw new Error(`${move.name} is not posted`);
    if (move.move_type !== expected) throw new Error(`${move.name} is not a ${TYPE_LABEL[expected]}`);
    companies.add(move.company_id ?? 1);
    const amount = Number(line.amount) || 0;
    if (!(amount > 0) || cents(amount) > cents(move.amount_residual)) {
      throw new Error(`${move.name}: the amount must be positive and at most the amount due (${round(move.amount_residual)})`);
    }
  }
  if (!batch.payment_method_id && paymentIds.length > 1) {
    const methods = new Set(paymentIds.map((id) => paymentMethodIdOf(db, read(db, 'account.payment', id))));
    if (methods.size > 1) throw new Error('Selected payments must use the same payment method');
  }
  if (companies.size !== 1) throw new Error('Batch invoices must belong to the same company');
  const [company] = companies;
  if (paymentIds.length && batch.company_id != null && batch.company_id !== company) throw new Error('Batch and payments must belong to the same company');
  const currency = batchCurrency(db, batch);
  if (currency.error) throw new Error(currency.error);
  const journalConfig = paymentJournal(db, batch.journal_id ?? null, company);
  const journal = read(db, 'account.journal', journalConfig.id);
  // A journal without its own currency accepts any currency; a fixed one only its own.
  if (journal.currency_id && currency.id !== journal.currency_id) throw new Error('Batch currency must match the journal currency');
  if (!isLiquidityJournal(journal) || (isCheck && journal.type !== 'bank')) {
    throw new Error(isCheck ? 'Checks require a bank journal' : 'Inbound batches require a bank or cash journal');
  }
  if (journal.company_id != null && journal.company_id !== company) throw new Error('Batch journal and invoices must belong to the same company');
  paymentJournal(db, journal.id, company);
  const { line: methodLine, error: methodError } = resolveBatchMethodLine(db, batch, journal);
  if (methodError) {
    throw new Error(methodError);
  }
  for (const line of lines) {
    if (line.payment_id) {
      const payment = read(db, 'account.payment', line.payment_id);
      const payError = recipientBankCompanyError(db, payment, payment?.company_id ?? company);
      if (payError) throw new Error(payError);
    }
    const move = read(db, 'account.move', line.move_id);
    const moveError = recipientBankCompanyError(db, move, move?.company_id ?? company);
    if (moveError) throw new Error(moveError);
    if (batch.batch_type === 'outbound' && move?.partner_id) {
      resolveAndValidateRecipientBank(db, move.partner_id, move.partner_bank_id, { companyId: company });
    }
  }

  let next = db;
  const linked = lines.map((line) => {
    if (line.payment_id) {
      const payment = read(next, 'account.payment', line.payment_id);
      const checkNumber = isCheck ? (payment?.check_number ?? line.check_number ?? null) : null;
      return { ...line, check_number: checkNumber, cancelled: false };
    }
    const invoice = read(next, 'account.move', line.move_id);
    const currency = documentCurrency(next, invoice);
    const discount = discountAvailable(next, invoice, batch.date);
    const eligible = discount > 0 && roundCurrency(invoice.amount_residual - Number(line.amount) - discount, currency) === 0;
    const options = {
      journalId: journal.id,
      ...(methodLine ? { paymentMethodLineId: methodLine.id } : {}),
    };
    next = eligible
      ? payWithDiscount(next, line.move_id, Number(line.amount), batch.date, options)
      : payMove(next, line.move_id, Number(line.amount), batch.date, options);
    const entryId = read(next, 'account.move', line.move_id).payments.findLast((payment) => !payment.discount).move_id;
    const createdPayment = search(next, 'account.payment').find((p) => p.move_id === entryId);
    return { ...line, check_number: isCheck ? (line.check_number ?? createdPayment?.check_number ?? null) : null, payment_id: createdPayment?.id, cancelled: false };
  });
  const prefix = batch.batch_type === 'inbound' ? 'BATCH-IN/' : 'BATCH-OUT/';
  const name = batch.name && batch.name !== 'New' ? batch.name : nextName(next, 'account.batch.payment', prefix);
  return write(next, 'account.batch.payment', batch.id, {
    name,
    state: 'posted',
    company_id: company,
    lines: linked,
  });
}

const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = [null, null, 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const underThousand = (n) => {
  const words = [];
  if (n >= 100) words.push(`${ONES[Math.floor(n / 100)]} Hundred`);
  const rest = n % 100;
  if (rest >= 20) words.push(rest % 10 ? `${TENS[Math.floor(rest / 10)]}-${ONES[rest % 10]}` : TENS[Math.floor(rest / 10)]);
  else if (rest) words.push(ONES[rest]);
  return words.join(' ');
};

/** Cheque-style amount in words: 1234.5 → 'One Thousand Two Hundred Thirty-Four Dollars and 50/100' (0 to 999,999,999.99). */
export function amountInWords(amount, currency) {
  if (typeof currency !== 'string' || !currency.trim()) throw new Error('Configure the currency unit name before spelling an amount');
  const totalCents = cents(amount);
  if (!(totalCents >= 0) || totalCents > 99999999999) throw new Error('Check amounts must be between 0 and 999,999,999.99');
  const value = Math.floor(totalCents / 100);
  const words = [];
  if (value >= 1000000) words.push(`${underThousand(Math.floor(value / 1000000))} Million`);
  if (Math.floor(value / 1000) % 1000) words.push(`${underThousand(Math.floor(value / 1000) % 1000)} Thousand`);
  if (value % 1000) words.push(underThousand(value % 1000));
  const dollars = words.length ? words.join(' ') : 'Zero';
  return `${dollars} ${currency.trim()} and ${String(totalCents % 100).padStart(2, '0')}/100`;
}

/** Numeric and written check amounts use the posted payment's currency, then its invoice currency. */
export function checkAmountDisplay(db, payment, invoice, amount) {
  const currency = payment?.currency_id ? read(db, 'res.currency', payment.currency_id) : documentCurrency(db, invoice);
  if (!currency) throw new Error('Configure the payment currency before printing this check');
  return { currency, numeric: formatCurrency(amount, currency), words: amountInWords(amount, currency.currency_unit_label ?? currency.unit_name) };
}

/** Check whether all active payment lines in a batch are matched in bank reconciliation. */
export function isBatchReconciled(db, batch) {
  if (!db || !batch) return false;
  const lines = (batch.lines ?? []).filter((l) => !l.cancelled && l.payment_id);
  return lines.length > 0 && lines.every((l) => isPaymentMatched(db, l.payment_id));
}

export const paymentModels = {
  'account.batch.payment': {
    label: 'Batch Payments',
    guard: (db, before, after) => {
      if (after.state === 'posted') {
        const transitioningToPosted = !before || before.state !== 'posted';
        const methodFieldChanged = before && (
          (before.payment_method_id ?? null) !== (after.payment_method_id ?? null)
          || (before.journal_id ?? null) !== (after.journal_id ?? null)
          || (before.batch_type ?? null) !== (after.batch_type ?? null)
        );
        if (transitioningToPosted || methodFieldChanged) {
          const resolvedJournalId = after.journal_id ?? defaultPaymentJournalId(db, after.company_id ?? 1);
          const journal = resolvedJournalId ? read(db, 'account.journal', resolvedJournalId) : null;
          if (after.payment_method_id || journal) {
            const { error } = resolveBatchMethodLine(db, after, journal);
            if (error) return error;
          }
          if (after.payment_method_id) {
            for (const line of after.lines ?? []) {
              if (line?.cancelled || !line?.payment_id) continue;
              const payment = read(db, 'account.payment', line.payment_id);
              if (payment && paymentMethodIdOf(db, payment) !== after.payment_method_id) {
                return 'Selected payments must use the same payment method';
              }
            }
          }
        }
      }
      return null;
    },
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      batch_type: { type: 'selection', label: 'Batch Type', required: true, options: [['inbound', 'Inbound'], ['outbound', 'Outbound']] },
      date: { type: 'date', label: 'Date' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      payment_method_id: {
        type: 'many2one',
        relation: 'account.payment.method',
        label: 'Payment Method',
        domain: (m, r, db) => m.active !== false
          && (!r?.batch_type || m.payment_type === r.batch_type)
          && (!r?.journal_id || !db || journalMethodLines(db, r.journal_id, r.batch_type || null).some((l) => l.payment_method_id === m.id)),
      },
      currency_id: { type: 'many2one', relation: 'res.currency', label: 'Currency', compute: (r, db) => batchCurrency(db, r).id },
      currency_warning: { type: 'char', label: 'Currency Status', readonly: true, compute: (r, db) => batchCurrency(db, r).error ?? '' },
      state: {
        type: 'selection',
        label: 'Status',
        tracking: true,
        options: [
          ['draft', 'Draft'],
          ['posted', 'Posted'],
        ],
      },
      reconciled: {
        type: 'boolean',
        label: 'Reconciled',
        readonly: true,
        compute: (r, db) => r.state === 'posted' && isBatchReconciled(db, r),
      },
      status: {
        type: 'selection',
        label: 'Status',
        readonly: true,
        options: [
          ['draft', 'Draft'],
          ['posted', 'Posted'],
          ['reconciled', 'Reconciled'],
        ],
        compute: (r, db) => (r.state === 'posted' && isBatchReconciled(db, r) ? 'reconciled' : r.state),
      },
      lines: {
        type: 'one2many',
        label: 'Payment Lines',
        fields: {
          move_id: { type: 'many2one', relation: 'account.move', label: 'Invoice' },
          amount: { type: 'monetary', label: 'Amount' },
          check_number: {
            type: 'integer',
            label: 'Check Number',
            readonly: (record, db) => {
              if (!db || !record) return true;
              const journalId = record.parent_journal_id
                ?? (record.payment_id ? read(db, 'account.payment', record.payment_id)?.journal_id : null)
                ?? (record.batch_id ? read(db, 'account.batch.payment', record.batch_id)?.journal_id : null);
              const journal = journalId ? read(db, 'account.journal', journalId) : null;
              return !journal?.check_manual_sequencing;
            },
          },
          payment_id: { type: 'many2one', relation: 'account.payment', label: 'Payment' },
          cancelled: { type: 'boolean', label: 'Cancelled', readonly: true },
        },
        newLine: () => ({ move_id: null, amount: 0 }),
        // Picking an invoice fills the amount with its residual unless one was already entered.
        onchange: (line, key, db) => {
          if (key === 'payment_id' && line.payment_id) {
            const payment = read(db, 'account.payment', line.payment_id);
            return payment ? { ...line, move_id: null, amount: payment.amount } : line;
          }
          if (key !== 'move_id' || !line.move_id) return line;
          const move = read(db, 'account.move', line.move_id);
          return move ? { ...line, payment_id: null, amount: Number(line.amount) > 0 ? line.amount : move.amount_residual } : line;
        },
      },
      amount_total: { type: 'monetary', label: 'Total', compute: (r, db) => {
        const currency = batchCurrency(db, r);
        return currency.error ? null : roundCurrency((r.lines ?? []).reduce((sum, line) => sum + (Number(line.amount) || 0), 0), currency.currency);
      } },
    },
    defaults: () => ({ name: 'New', date: today(), state: 'draft', lines: [] }),
    onchange: (r, key, db) => {
      if ((key === 'journal_id' || key === 'batch_type') && r.payment_method_id && db) {
        if (resolveBatchMethodLine(db, r).error) return { payment_method_id: null };
      }
      return {};
    },
    kanban: { title: 'name', lines: ['batch_type', 'date', 'amount_total'], badge: 'status' },
    list: ['name', 'batch_type', 'date', 'amount_total', 'status'],
    form: {
      statusbar: 'status',
      lockedWhen: (r) => r.state === 'posted',
      buttons: [
        { label: 'Add Open Invoices', when: (r) => r.state === 'draft', run: (db, r) => ({ db: fillOpenInvoices(db, r) }) },
        { label: 'Validate', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postBatch(db, r) }) },
        {
          label: 'Print Checks',
          when: (r, db) => r.state === 'posted' && r.batch_type === 'outbound' && (!db || isCheckBatch(db, r)),
          wizard: (db, r) => {
            const journalId = r?.journal_id ?? (r?.lines?.[0]?.payment_id && db ? read(db, 'account.payment', r.lines[0].payment_id)?.journal_id : null);
            const journal = db && journalId ? read(db, 'account.journal', journalId) : null;
            const payments = (r?.lines ?? [])
              .map((l) => (db && l.payment_id ? read(db, 'account.payment', l.payment_id) : null))
              .filter(Boolean);
            if (journal?.check_manual_sequencing && payments.length > 0 && payments.every((p) => p.check_number != null)) {
              return null;
            }
            const nextNum = db && journalId ? nextCheckNumber(db, journalId) : 1;
            return {
              title: 'Print Checks',
              fields: [
                { name: 'next_check_number', type: 'integer', label: 'Next Check Number', default: nextNum, required: true },
              ],
            };
          },
          run: (db, r, values = {}) => {
            const requested = values?.next_check_number ?? values?.check_number ?? null;
            const nextDb = printBatchChecks(db, r, requested);
            return { db: nextDb, go: '#/print/account.batch.payment/' + r.id };
          },
        },
        { label: 'Print Deposit Slip', when: (r) => r.state === 'posted' && r.batch_type === 'inbound', run: (db, r) => ({ db, go: '#/print/account.batch.payment/' + r.id }) },
      ],
      title: 'name',
      groups: [['batch_type'], ['date', 'journal_id', 'payment_method_id'], ['currency_id', 'amount_total', 'currency_warning']],
      tabs: [{ label: 'Payment Lines', fields: ['lines'] }],
      chatter: true,
    },
  },
};

/** Create a draft batch payment from a selection of existing posted payments. */
export function createBatchPayment(db, ids) {
  if (!ids || !ids.length) throw new Error('Select at least one payment');
  const uniqueIds = [...new Set(ids)];
  const payments = uniqueIds.map((id) => read(db, 'account.payment', id));
  if (payments.some((p) => !p)) throw new Error('Payment not found');
  if (payments.some((p) => p.state !== 'posted')) {
    throw new Error('Only posted payments can be added to a batch');
  }
  if (payments.some((p) => p.is_internal_transfer)) {
    throw new Error('Internal transfers cannot be added to a batch');
  }
  if (payments.some((p) => isPaymentMatched(db, p))) {
    throw new Error('Selected payments cannot include already matched payments');
  }
  const batches = db.records?.['account.batch.payment'] ?? [];
  const inBatch = payments.find((p) =>
    batches.some((b) => (b.lines ?? []).some((l) => !l.cancelled && l.payment_id === p.id)),
  );
  if (inBatch) {
    throw new Error('Selected payments cannot include payments already in a batch');
  }
  const journalIds = new Set(payments.map((p) => p.journal_id ?? null));
  if (journalIds.size > 1) {
    throw new Error('Selected payments must belong to the same journal');
  }
  const directions = new Set(payments.map((p) => p.payment_type ?? null));
  if (directions.size > 1) {
    throw new Error('Selected payments must have the same direction');
  }
  const methodLineIds = new Set(payments.map((p) => p.payment_method_line_id ?? null));
  const methodIds = new Set(payments.map((p) => paymentMethodIdOf(db, p) ?? p.payment_method_line_id ?? null));
  if (methodLineIds.size > 1 || methodIds.size > 1) {
    throw new Error('Selected payments must use the same payment method');
  }
  const companyIds = new Set(payments.map((p) => p.company_id ?? 1));
  if (companyIds.size > 1) {
    throw new Error('Selected payments must belong to the same company');
  }

  const first = payments[0];
  const companyId = first.company_id ?? read(db, 'account.journal', first.journal_id)?.company_id ?? 1;

  const methodId = paymentMethodIdOf(db, first);
  const method = methodId ? read(db, 'account.payment.method', methodId) : null;
  const isCheck = first.payment_type === 'outbound' && method?.code === 'check_printing';

  const journal = read(db, 'account.journal', first.journal_id);
  if (!journal || !isLiquidityJournal(journal) || (isCheck && journal.type !== 'bank')) {
    throw new Error(isCheck ? 'Checks require a bank journal' : 'Inbound batches require a bank or cash journal');
  }
  if (methodId) {
    const { error } = resolveBatchMethodLine(db, { batch_type: first.payment_type, payment_method_id: methodId }, journal);
    if (error) throw new Error(error);
  }
  if (isCheck && payments.some((p) => !paymentPaysByCheck(db, p))) {
    throw new Error('A check batch only holds check payments');
  }

  const currency = batchCurrency(db, { lines: payments.map((p) => ({ payment_id: p.id })) });
  if (currency.error) throw new Error(currency.error);
  if (journal?.currency_id && currency.id !== journal.currency_id) {
    throw new Error('Batch currency must match the journal currency');
  }

  const batchPayload = {
    name: 'New',
    batch_type: first.payment_type,
    journal_id: first.journal_id,
    company_id: companyId,
    date: today(),
    state: 'draft',
    ...(methodId ? { payment_method_id: methodId } : {}),
    lines: payments.map((p) => ({
      payment_id: p.id,
      amount: p.amount,
      ...(isCheck && p.check_number != null ? { check_number: p.check_number } : {}),
    })),
  };
  const res = create(db, 'account.batch.payment', batchPayload);
  return {
    db: res.db,
    go: `#/accounting/batch-payments/${res.id}`,
    id: res.id,
  };
}

export const createBatchPaymentListAction = {
  label: 'Create Batch Payment',
  requiresSelection: true,
  run: (db, ids) => createBatchPayment(db, ids),
};

const attachListAction = (target, action) => {
  if (!target) return;
  const current = target.listActions ?? [];
  if (!current.some((a) => a.label === action.label)) {
    target.listActions = [...current, action];
  }
};
attachListAction(customerPaymentView, createBatchPaymentListAction);
attachListAction(vendorPaymentView, createBatchPaymentListAction);
attachListAction(payModels?.['account.payment'], createBatchPaymentListAction);

