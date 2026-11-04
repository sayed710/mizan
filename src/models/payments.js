// Batch payments: pay several invoices in one operation; outbound batches also number and print checks.
import { read, search, write } from '../orm.js';
import { nextName, today } from './common.js';
import { payMove } from './accounting.js';
import { cents, round } from '../money.js';
import { resolveAndValidateRecipientBank } from './partnerbank.js';
import { journalId } from './ledger.js';
import { nextCheckNumber } from './pay.js';

const MOVE_TYPE = { inbound: 'out_invoice', outbound: 'in_invoice' };
const TYPE_LABEL = { out_invoice: 'customer invoice', in_invoice: 'vendor bill' };

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
    .filter((payment) => payment.state === 'posted' && payment.payment_type === 'outbound' && payment.check_number != null && !batchedPaymentIds.has(payment.id))
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
          state: 'Issued',
        });
      }
      return rows;
    });
  return [...batchRows, ...individualRows];
}

/** Replace the batch lines with every posted, still-open invoice of the matching type, at its residual. */
export function fillOpenInvoices(db, batch) {
  const company = (batch.journal_id ? read(db, 'account.journal', batch.journal_id)?.company_id : null) ?? batch.company_id ?? 1;
  const open = search(db, 'account.move').filter(
    (m) => (m.company_id ?? 1) === company && m.state === 'posted' && m.move_type === MOVE_TYPE[batch.batch_type] && (Number(m.amount_residual) || 0) > 0,
  );
  return write(db, 'account.batch.payment', batch.id, { lines: open.map((m) => ({ move_id: m.id, amount: m.amount_residual })) });
}

/** Validate the batch, pay each line, number the checks (outbound), assign the reference and post. */
export function postBatch(db, batch) {
  if (batch.state !== 'draft') throw new Error('Only draft batches can be validated');
  const lines = batch.lines ?? [];
  if (!lines.length) throw new Error('Add at least one invoice to the batch');
  const expected = MOVE_TYPE[batch.batch_type];
  if (new Set(lines.map((l) => l.move_id)).size !== lines.length) throw new Error('An invoice can appear only once in a batch');
  for (const line of lines) {
    const move = read(db, 'account.move', line.move_id);
    if (!move) throw new Error(line.move_id ? `Invoice ${line.move_id} not found` : 'Select an invoice on every batch line');
    if (move.state !== 'posted') throw new Error(`${move.name} is not posted`);
    if (move.move_type !== expected) throw new Error(`${move.name} is not a ${TYPE_LABEL[expected]}`);
    const amount = Number(line.amount) || 0;
    if (!(amount > 0) || cents(amount) > cents(move.amount_residual)) {
      throw new Error(`${move.name}: the amount must be positive and at most the amount due (${round(move.amount_residual)})`);
    }
    if (batch.batch_type === 'outbound' && move.partner_id) {
      resolveAndValidateRecipientBank(db, move.partner_id, move.partner_bank_id, { companyId: move.company_id ?? 1 });
    }
  }
  const company = read(db, 'account.move', lines[0].move_id)?.company_id ?? 1;
  if (batch.batch_type === 'inbound' && lines.some((line) => (read(db, 'account.move', line.move_id)?.company_id ?? 1) !== company)) throw new Error('Batch invoices must belong to the same company');
  const journal = read(db, 'account.journal', batch.journal_id ?? journalId(db, 'BNK1', company));
  if (!journal || journal.type !== 'bank' || (journal.company_id != null && journal.company_id !== company) || lines.some((line) => (read(db, 'account.move', line.move_id)?.company_id ?? 1) !== company)) throw new Error('Batch payments require a bank journal and invoices in the same company');
  const requested = Number(batch.check_number_start || journal?.check_next_number || 0);
  if (batch.batch_type === 'outbound' && (!Number.isSafeInteger(requested) || requested < 1)) throw new Error('Set the first check number to print');
  const start = journal ? nextCheckNumber(db, journal.id, requested) : requested;
  if (batch.batch_type === 'outbound' && !Number.isSafeInteger(start + lines.length)) throw new Error('Check number is too large');

  let next = db;
  const linked = lines.map((line, index) => {
    next = payMove(next, line.move_id, Number(line.amount), batch.date, { journalId: journal.id, ...(batch.batch_type === 'outbound' ? { checkNumber: start + index } : {}) });
    const entryId = read(next, 'account.move', line.move_id).payments.at(-1).move_id;
    return { ...line, payment_id: search(next, 'account.payment').find((p) => p.move_id === entryId).id, cancelled: false };
  });
  if (journal) next = write(next, 'account.journal', journal.id, { check_next_number: start + lines.length });
  const prefix = batch.batch_type === 'inbound' ? 'BATCH-IN/' : 'BATCH-OUT/';
  const name = batch.name && batch.name !== 'New' ? batch.name : nextName(next, 'account.batch.payment', prefix);
  return write(next, 'account.batch.payment', batch.id, {
    name,
    state: 'posted',
    ...(!batch.journal_id ? { company_id: company } : {}),
    lines: linked.map((line, index) => ({
      ...line,
      check_number: batch.batch_type === 'outbound' ? start + index : line.check_number ?? null,
    })),
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
export function amountInWords(amount, currency = 'Dollars') {
  const totalCents = cents(amount);
  if (!(totalCents >= 0) || totalCents > 99999999999) throw new Error('Check amounts must be between 0 and 999,999,999.99');
  const value = Math.floor(totalCents / 100);
  const words = [];
  if (value >= 1000000) words.push(`${underThousand(Math.floor(value / 1000000))} Million`);
  if (Math.floor(value / 1000) % 1000) words.push(`${underThousand(Math.floor(value / 1000) % 1000)} Thousand`);
  if (value % 1000) words.push(underThousand(value % 1000));
  const dollars = words.length ? words.join(' ') : 'Zero';
  return `${dollars} ${currency} and ${String(totalCents % 100).padStart(2, '0')}/100`;
}

export const paymentModels = {
  'account.batch.payment': {
    label: 'Batch Payments',
    fields: {
      name: { type: 'char', label: 'Reference', required: true },
      batch_type: { type: 'selection', label: 'Batch Type', required: true, options: [['inbound', 'Inbound'], ['outbound', 'Outbound']] },
      date: { type: 'date', label: 'Date' },
      check_number_start: { type: 'integer', label: 'First Check Number' },
      journal_id: { type: 'many2one', relation: 'account.journal', label: 'Journal' },
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['posted', 'Posted']] },
      lines: {
        type: 'one2many',
        label: 'Payment Lines',
        fields: {
          move_id: { type: 'many2one', relation: 'account.move', label: 'Invoice' },
          amount: { type: 'monetary', label: 'Amount' },
          check_number: { type: 'integer', label: 'Check Number', readonly: true },
          payment_id: { type: 'many2one', relation: 'account.payment', label: 'Payment', readonly: true },
          cancelled: { type: 'boolean', label: 'Cancelled', readonly: true },
        },
        newLine: () => ({ move_id: null, amount: 0 }),
        // Picking an invoice fills the amount with its residual unless one was already entered.
        onchange: (line, key, db) => {
          if (key !== 'move_id' || Number(line.amount) > 0) return line;
          const move = line.move_id ? read(db, 'account.move', line.move_id) : null;
          return move ? { ...line, amount: move.amount_residual } : line;
        },
      },
      amount_total: { type: 'monetary', label: 'Total', compute: (r) => round((r.lines ?? []).reduce((s, l) => s + (Number(l.amount) || 0), 0)) },
    },
    defaults: () => ({ name: 'New', date: today(), state: 'draft', lines: [] }),
    kanban: { title: 'name', lines: ['batch_type', 'date', 'amount_total'], badge: 'state' },
    list: ['name', 'batch_type', 'date', 'amount_total', 'state'],
    form: {
      statusbar: 'state',
      lockedWhen: (r) => r.state === 'posted',
      buttons: [
        { label: 'Add Open Invoices', when: (r) => r.state === 'draft', run: (db, r) => ({ db: fillOpenInvoices(db, r) }) },
        { label: 'Validate', primary: true, when: (r) => r.state === 'draft', run: (db, r) => ({ db: postBatch(db, r) }) },
        { label: 'Print Checks', when: (r) => r.state === 'posted' && r.batch_type === 'outbound', run: (db, r) => ({ db, go: '#/print/account.batch.payment/' + r.id }) },
      ],
      title: 'name',
      groups: [['batch_type'], ['date', 'journal_id', 'check_number_start'], ['amount_total']],
      tabs: [{ label: 'Payment Lines', fields: ['lines'] }],
      chatter: true,
    },
  },
};
