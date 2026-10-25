// Batch payments: pay several invoices in one operation; outbound batches also number and print checks.
import { read, search, write } from '../orm.js';
import { nextName, today } from './common.js';
import { payMove } from './accounting.js';

const round = (n) => Math.round(n * 100) / 100;
const cents = (n) => Math.round((Number(n) || 0) * 100);
const MOVE_TYPE = { inbound: 'out_invoice', outbound: 'in_invoice' };
const TYPE_LABEL = { out_invoice: 'customer invoice', in_invoice: 'vendor bill' };

/** Replace the batch lines with every posted, still-open invoice of the matching type, at its residual. */
export function fillOpenInvoices(db, batch) {
  const open = search(db, 'account.move').filter(
    (m) => m.state === 'posted' && m.move_type === MOVE_TYPE[batch.batch_type] && (Number(m.amount_residual) || 0) > 0,
  );
  return write(db, 'account.batch.payment', batch.id, { lines: open.map((m) => ({ move_id: m.id, amount: m.amount_residual })) });
}

/** Validate the batch, pay each line, number the checks (outbound), assign the reference and post. */
export function postBatch(db, batch) {
  const lines = batch.lines ?? [];
  if (!lines.length) throw new Error('Add at least one invoice to the batch');
  const expected = MOVE_TYPE[batch.batch_type];
  for (const line of lines) {
    const move = read(db, 'account.move', line.move_id);
    if (!move) throw new Error(line.move_id ? `Invoice ${line.move_id} not found` : 'Select an invoice on every batch line');
    if (move.state !== 'posted') throw new Error(`${move.name} is not posted`);
    if (move.move_type !== expected) throw new Error(`${move.name} is not a ${TYPE_LABEL[expected]}`);
    const amount = Number(line.amount) || 0;
    if (!(amount > 0) || cents(amount) > cents(move.amount_residual)) {
      throw new Error(`${move.name}: the amount must be positive and at most the amount due (${round(move.amount_residual)})`);
    }
  }
  if (batch.batch_type === 'outbound' && !(Number(batch.check_number_start) > 0)) throw new Error('Set the first check number to print');

  let next = db;
  for (const line of lines) next = payMove(next, line.move_id, Number(line.amount), batch.date);
  const prefix = batch.batch_type === 'inbound' ? 'BATCH-IN/' : 'BATCH-OUT/';
  const name = batch.name && batch.name !== 'New' ? batch.name : nextName(next, 'account.batch.payment', prefix);
  return write(next, 'account.batch.payment', batch.id, {
    name,
    state: 'posted',
    lines: lines.map((line, index) => ({
      ...line,
      check_number: batch.batch_type === 'outbound' ? Number(batch.check_number_start) + index : line.check_number ?? null,
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
      state: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['posted', 'Posted']] },
      lines: {
        type: 'one2many',
        label: 'Payment Lines',
        fields: {
          move_id: { type: 'many2one', relation: 'account.move', label: 'Invoice' },
          amount: { type: 'monetary', label: 'Amount' },
          check_number: { type: 'integer', label: 'Check Number', readonly: true },
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
      groups: [['batch_type'], ['date', 'check_number_start'], ['amount_total']],
      tabs: [{ label: 'Payment Lines', fields: ['lines'] }],
      chatter: true,
    },
  },
};
