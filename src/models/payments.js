// Batch payments: pay several invoices in one operation; outbound batches also number and print checks.
import { read, search, write } from '../orm.js';
import { nextName, today, validDate } from './common.js';
import { discountAvailable, payMove, payWithDiscount } from './accounting.js';
import { cents, round, roundCurrency, documentCurrency, companyCurrencyRecord, formatCurrency } from '../money.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';
import { isLiquidityJournal, paymentJournal } from './ledger.js';
import { paymentPaysByCheck, printBatchChecks } from './pay.js';
import { isPaymentMatched } from './bank.js';
import { recipientBankCompanyError } from './company.js';
import { buildSepaXml } from './sepa.js';

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

/** Validate the batch, pay each line, number the checks (outbound), assign the reference and post. */
export function postBatch(db, batch) {
  if (batch.state !== 'draft') throw new Error('Only draft batches can be validated');
  const lines = batch.lines ?? [];
  if (!lines.length) throw new Error('Add at least one invoice to the batch');
  const sepa = batch.batch_type === 'outbound' && lines.some((line) => paymentMethodCode(db, read(db, 'account.payment', line.payment_id)) === 'sepa_ct');
  if (sepa && lines.some((line) => !line.payment_id || paymentMethodCode(db, read(db, 'account.payment', line.payment_id)) !== 'sepa_ct')) throw new Error('Every payment must use SEPA Credit Transfer');
  const expected = MOVE_TYPE[batch.batch_type];
  const invoiceIds = lines.filter((l) => !l.payment_id).map((l) => l.move_id);
  const paymentIds = lines.filter((l) => l.payment_id).map((l) => l.payment_id);
  if (new Set(invoiceIds).size !== invoiceIds.length) throw new Error('An invoice can appear only once in a batch');
  if (new Set(paymentIds).size !== paymentIds.length) throw new Error('A payment can appear only once in a batch');
  if (!validDate(batch.date)) throw new Error('Enter a valid batch payment date');
  const companies = new Set();
  for (const line of lines) {
    if (line.payment_id) {
      if (line.move_id) throw new Error('Select either an invoice or an existing payment on each batch line');
      const payment = read(db, 'account.payment', line.payment_id);
      if (!payment || payment.state !== 'posted' || !payment.move_id || read(db, 'account.move', payment.move_id)?.state !== 'posted') throw new Error('Select an existing posted payment');
      if (payment.payment_type !== batch.batch_type || payment.partner_type !== (batch.batch_type === 'inbound' ? 'customer' : 'supplier')) throw new Error('Payment direction and partner type must match the batch');
      if (payment.journal_id !== batch.journal_id) throw new Error('Payment journal must match the batch journal');
      if (batch.batch_type === 'outbound' && !sepa && !paymentPaysByCheck(db, payment)) throw new Error('A check batch only holds check payments');
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
  if (companies.size !== 1) throw new Error('Batch invoices must belong to the same company');
  const [company] = companies;
  if (paymentIds.length && batch.company_id != null && batch.company_id !== company) throw new Error('Batch and payments must belong to the same company');
  const currency = batchCurrency(db, batch);
  if (currency.error) throw new Error(currency.error);
  const journalConfig = paymentJournal(db, batch.journal_id ?? null, company);
  const journal = read(db, 'account.journal', journalConfig.id);
  // A journal without its own currency accepts any currency; a fixed one only its own.
  if (journal.currency_id && currency.id !== journal.currency_id) throw new Error('Batch currency must match the journal currency');
  if (!isLiquidityJournal(journal) || (batch.batch_type === 'outbound' && journal.type !== 'bank')) {
    throw new Error(batch.batch_type === 'outbound' ? 'Checks require a bank journal' : 'Inbound batches require a bank or cash journal');
  }
  if (journal.company_id != null && journal.company_id !== company) throw new Error('Batch journal and invoices must belong to the same company');
  paymentJournal(db, journal.id, company);
  const checkMethod = search(db, 'account.payment.method').find((m) => m.code === 'check_printing' && m.payment_type === 'outbound');
  const checkLine = (batch.batch_type === 'outbound' && !sepa && checkMethod)
    ? search(db, 'account.payment.method.line').find((l) => l.journal_id === journal.id && l.payment_method_id === checkMethod.id)
    : null;
  if (batch.batch_type === 'outbound' && !sepa && !checkLine) {
    throw new Error('The batch journal has no check payment method');
  }
  for (const line of lines) {
    if (line.payment_id) {
      const payment = read(db, 'account.payment', line.payment_id);
      const payError = recipientBankCompanyError(db, payment, payment?.company_id ?? company);
      if (payError) throw new Error(payError);
      if (batch.batch_type === 'outbound' && payment?.partner_id) {
        if (sepa && !payment.partner_bank_id) throw new Error('The selected bank account is invalid or inactive');
        resolveAndValidateRecipientBank(db, payment.partner_id, payment.partner_bank_id, { companyId: company });
      }
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
      const checkNumber = payment?.check_number ?? null;
      return { ...line, check_number: checkNumber, cancelled: false };
    }
    const invoice = read(next, 'account.move', line.move_id);
    const currency = documentCurrency(next, invoice);
    const discount = discountAvailable(next, invoice, batch.date);
    const eligible = discount > 0 && roundCurrency(invoice.amount_residual - Number(line.amount) - discount, currency) === 0;
    const options = {
      journalId: journal.id,
      ...(checkLine ? { paymentMethodLineId: checkLine.id } : {}),
    };
    next = eligible
      ? payWithDiscount(next, line.move_id, Number(line.amount), batch.date, options)
      : payMove(next, line.move_id, Number(line.amount), batch.date, options);
    const entryId = read(next, 'account.move', line.move_id).payments.findLast((payment) => !payment.discount).move_id;
    const createdPayment = search(next, 'account.payment').find((p) => p.move_id === entryId);
    return { ...line, check_number: line.check_number ?? createdPayment?.check_number ?? null, payment_id: createdPayment?.id, cancelled: false };
  });
  const prefix = batch.batch_type === 'inbound' ? 'BATCH-IN/' : 'BATCH-OUT/';
  const name = batch.name && batch.name !== 'New' ? batch.name : nextName(next, 'account.batch.payment', prefix);
  const sepaFile = sepa ? generateSepaFile(next, { ...batch, name, company_id: company, lines: linked }).content : null;
  return write(next, 'account.batch.payment', batch.id, {
    ...(sepa ? { sepa_file: sepaFile } : {}),
    name,
    state: 'posted',
    company_id: company,
    lines: linked,
  });
}

const paymentMethodCode = (db, payment) => {
  const line = read(db, 'account.payment.method.line', payment?.payment_method_line_id);
  const method = read(db, 'account.payment.method', line?.payment_method_id);
  return method?.payment_type === payment?.payment_type ? method?.code : null;
};

/** Prepare an XML download from explicitly linked SEPA payments. */
export function generateSepaFile(db, batch, createdAt = new Date().toISOString()) {
  const journal = read(db, 'account.journal', batch.journal_id);
  const bank = read(db, 'res.partner.bank', journal?.bank_account_id);
  const company = read(db, 'res.company', batch.company_id ?? journal?.company_id);
  const payments = (batch.lines ?? []).filter((line) => !line.cancelled).map((line) => {
    const payment = read(db, 'account.payment', line.payment_id);
    if (!payment) throw new Error('Each batch line must have a payment');
    const methodLine = read(db, 'account.payment.method.line', payment.payment_method_line_id);
    const method = read(db, 'account.payment.method', methodLine?.payment_method_id);
    if (method?.code !== 'sepa_ct' || method.payment_type !== 'outbound') throw new Error('Every payment must use SEPA Credit Transfer');
    if (documentCurrency(db, payment)?.name !== 'EUR') throw new Error('SEPA payments must use EUR');
    if (!payment.partner_bank_id) throw new Error('The selected bank account is invalid or inactive');
    resolveAndValidateRecipientBank(db, payment.partner_id, payment.partner_bank_id, { companyId: company?.id ?? payment.company_id ?? 1 });
    const recipient = read(db, 'res.partner.bank', payment.partner_bank_id);
    return { id: String(payment.id), amount: payment.amount, name: read(db, 'res.partner', payment.partner_id)?.name, iban: recipient?.account_number, memo: payment.memo };
  });
  return { name: `sepa-${batch.id}.xml`, content: buildSepaXml({ id: batch.name, createdAt, date: batch.date, debtor: { name: company?.name, iban: bank?.account_number, bic: bank?.bank_bic }, payments }) };
}

function validBatchLinesTransition(beforeLines = [], afterLines = []) {
  if (beforeLines.length !== afterLines.length) return false;
  return beforeLines.every((bLine, i) => {
    const aLine = afterLines[i];
    if (!aLine) return false;
    const { cancelled: bCancelled, ...bRest } = bLine;
    const { cancelled: aCancelled, ...aRest } = aLine;
    if (JSON.stringify(bRest) !== JSON.stringify(aRest)) return false;
    if (Boolean(bCancelled) === Boolean(aCancelled)) return true;
    return !bCancelled && aCancelled === true;
  });
}

function sepaBatchGuard(db, before, after) {
  if (before?.state === 'posted' && before.sepa_file) {
    if (before.sepa_file !== after.sepa_file) return 'The SEPA file cannot be changed after validation';
    if (['state', 'name', 'batch_type', 'journal_id', 'company_id', 'date'].some((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))) return 'A validated SEPA batch cannot be changed';
    if (!validBatchLinesTransition(before.lines, after.lines)) return 'A validated SEPA batch cannot be changed';
  }
  if (after.state !== 'posted' || before?.state === 'posted') return null;
  const sepa = (after.lines ?? []).some((line) => paymentMethodCode(db, read(db, 'account.payment', line.payment_id)) === 'sepa_ct');
  if (!sepa) return after.sepa_file ? 'Only SEPA batches can have a SEPA file' : null;
  if (!after.sepa_file) return 'A validated SEPA batch requires a SEPA file';
  if (after.batch_type !== 'outbound' || (after.lines ?? []).some((line) => {
    const payment = read(db, 'account.payment', line.payment_id);
    return !payment || payment.state !== 'posted' || payment.journal_id !== after.journal_id || (payment.company_id ?? 1) !== after.company_id || Number(line.amount) !== Number(payment.amount) || read(db, 'account.move', payment.move_id)?.state !== 'posted';
  })) return 'A SEPA batch requires posted payments matching the journal, company and amounts';
  const timestamp = after.sepa_file.match(/<CreDtTm>([^<]+)<\/CreDtTm>/)?.[1];
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return 'The SEPA file does not match the batch';
  try {
    if (generateSepaFile(db, after, timestamp).content !== after.sepa_file) return 'The SEPA file does not match the batch';
  } catch (error) {
    return error.message;
  }
  return null;
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
    guard: sepaBatchGuard,
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      sepa_file: { type: 'text', label: 'SEPA file', readonly: true },
      sepa_file_eligible: {
        type: 'boolean',
        label: 'SEPA File Eligible',
        readonly: true,
        compute: (r) => Boolean(r.sepa_file) && !(r.lines ?? []).some((l) => l.cancelled),
      },
      batch_type: { type: 'selection', label: 'Batch Type', required: true, options: [['inbound', 'Inbound'], ['outbound', 'Outbound']] },
      date: { type: 'date', label: 'Date' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
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
    kanban: { title: 'name', lines: ['batch_type', 'date', 'amount_total'], badge: 'status' },
    list: ['name', 'batch_type', 'date', 'amount_total', 'status'],
    form: {
      statusbar: 'status',
      lockedWhen: (r) => r.state === 'posted',
      buttons: [
        { label: 'Add Open Invoices', when: (r) => r.state === 'draft', run: (db, r) => ({ db: fillOpenInvoices(db, r) }) },
        { label: 'Validate', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postBatch(db, r) }) },
        {
          label: 'Generate SEPA file',
          unavailable: 'The original SEPA file is ineligible for download because one or more transfers were cancelled',
          when: (r) => r.state === 'posted' && Boolean(r.sepa_file) && !(r.lines ?? []).some((l) => l.cancelled),
          run: (db, r) => ({ db, download: { name: `sepa-${r.id}.xml`, content: r.sepa_file } }),
        },
        {
          label: 'Generate Replacement SEPA file',
          when: (r) => r.state === 'posted' && Boolean(r.sepa_file) && (r.lines ?? []).some((l) => l.cancelled) && (r.lines ?? []).some((l) => !l.cancelled),
          run: (db, r) => ({ db, download: generateSepaFile(db, r) }),
        },
        { label: 'Print Checks', when: (r) => r.state === 'posted' && r.batch_type === 'outbound' && !r.sepa_file, run: (db, r) => ({ db: printBatchChecks(db, r), go: '#/print/account.batch.payment/' + r.id }) },
        { label: 'Print Deposit Slip', when: (r) => r.state === 'posted' && r.batch_type === 'inbound', run: (db, r) => ({ db, go: '#/print/account.batch.payment/' + r.id }) },
      ],
      title: 'name',
      groups: [['batch_type'], ['date', 'journal_id'], ['currency_id', 'amount_total', 'currency_warning']],
      tabs: [{ label: 'Payment Lines', fields: ['lines'] }],
      chatter: true,
    },
  },
};
