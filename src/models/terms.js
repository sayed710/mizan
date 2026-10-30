import { addDays, today } from './common.js';
import { allocateCents, cents } from '../money.js';

const money = (n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function lineDate(line, invoiceDate) {
  const days = Number(line.nb_days) || 0;
  if (line.delay_type !== 'days_end_of_month') return addDays(invoiceDate, days);
  const [year, month] = invoiceDate.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return addDays(`${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`, days);
}

/** Split an invoice total into dated installments according to a payment term. */
export function installments(term, total, invoiceDate) {
  const lines = term.line_ids ?? [];
  if (!lines.length) throw new Error('Add at least one due term');

  const totalCents = cents(total);
  const fixedCents = lines.reduce((sum, line) => sum + (line.value_type === 'fixed' ? cents(line.value) : 0), 0);
  if (fixedCents > totalCents) throw new Error('Fixed amounts exceed the total');

  const variable = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.value_type !== 'fixed');
  const amounts = lines.map((line) => line.value_type === 'fixed' ? cents(line.value) / 100 : 0);
  const rest = (totalCents - fixedCents) / 100;
  if (variable.length) {
    // The last percentage line is the balance, as in the original payment-term semantics.
    const weights = variable.map(({ line }) => Math.max(0, Number(line.value) || 0));
    const preceding = weights.slice(0, -1).reduce((sum, value) => sum + value, 0);
    weights[weights.length - 1] = Math.max(0, (totalCents ? (totalCents - fixedCents) * 100 / totalCents : 100) - preceding) || 0;
    const shares = allocateCents(rest, weights.some(Boolean) ? weights : weights.map(() => 1));
    variable.forEach(({ index }, i) => { amounts[index] = shares[i]; });
  } else {
    amounts[amounts.length - 1] += rest;
  }
  return lines.map((line, index) => ({ date: lineDate(line, invoiceDate), amount: amounts[index] }));
}

/** Due date of the final installment (dates do not depend on the amount). */
export function dueDate(term, invoiceDate) {
  const last = (term.line_ids ?? []).at(-1);
  return last ? lineDate(last, invoiceDate) : invoiceDate;
}

/** Return the early-payment discount when payment falls within its configured window. */
export function earlyDiscount(term, total, invoiceDate, paymentDate) {
  const discountDate = addDays(invoiceDate, Number(term.discount_days) || 0);
  if (!term.early_discount || !paymentDate || paymentDate > discountDate) return 0;
  return Math.round(cents(total) * (Number(term.discount_percent) || 0) / 100) / 100;
}

const newLine = () => ({ value: 100, value_type: 'percent', nb_days: 0, delay_type: 'days_after' });

export const termModels = {
  'account.payment.term': {
    label: 'Payment Terms',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      early_discount: { type: 'boolean', label: 'Early Discount' },
      discount_percent: { type: 'float', label: 'Discount %' },
      discount_days: { type: 'integer', label: 'Discount Days' },
      line_ids: {
        type: 'one2many',
        label: 'Due Terms',
        fields: {
          value: { type: 'float', label: 'Value' },
          value_type: { type: 'selection', label: 'Value Type', options: [['percent', 'Percent'], ['fixed', 'Fixed']] },
          nb_days: { type: 'integer', label: 'Days' },
          delay_type: { type: 'selection', label: 'Delay Type', options: [['days_after', 'Days after invoice date'], ['days_end_of_month', 'Days after end of month']] },
        },
        newLine,
      },
      preview: {
        type: 'text',
        label: 'Preview',
        readonly: true,
        compute: (r) => {
          try {
            const rows = installments(r, 1000, today());
            return [`Example: ${money(1000)} on ${today()}`, ...rows.map((row) => `${money(row.amount)} on ${row.date}`)].join('\n');
          } catch (e) {
            return e.message;
          }
        },
      },
      note: { type: 'text', label: 'Note' },
    },
    defaults: () => ({ early_discount: false, discount_percent: 0, discount_days: 0, line_ids: [newLine()] }),
    kanban: { title: 'name', lines: ['early_discount'] },
    list: ['name', 'early_discount'],
    form: {
      title: 'name',
      groups: [['name'], ['early_discount', 'discount_percent', 'discount_days'], ['preview']],
      tabs: [{ label: 'Due Terms', fields: ['line_ids'] }, { label: 'Note', fields: ['note'] }],
      chatter: true,
    },
  },
};
