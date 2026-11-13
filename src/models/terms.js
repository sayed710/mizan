import { addDays, today } from './common.js';
import { currencyUnits, roundCurrency } from '../money.js';

const money = (n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function lineDate(line, invoiceDate) {
  const days = Number(line.nb_days) || 0;
  if (line.delay_type !== 'days_end_of_month') return addDays(invoiceDate, days);
  const [year, month] = invoiceDate.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return addDays(`${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`, days);
}

/** Split an invoice total into dated installments according to a payment term. */
export function installments(term, total, invoiceDate, currency = null) {
  const lines = term.line_ids ?? [];
  if (!lines.length) throw new Error('Add at least one due term');

  const step = Number(currency?.rounding ?? 0.01);
  const signedTotal = currencyUnits(total, currency);
  const sign = Math.sign(signedTotal);
  const totalCents = Math.abs(signedTotal);
  const fixed = lines.map((line) => line.value_type === 'fixed' ? Math.max(0, currencyUnits(line.value, currency)) : 0);
  let fixedRemaining = fixed.reduce((sum, amount) => sum + amount, 0);
  if (fixedRemaining > totalCents) throw new Error('Fixed amounts exceed the total');
  const balanceIndex = lines.findIndex((line) => line.value_type === 'balance' || (!line.value_type && line.value === 'balance'));
  if (balanceIndex >= 0 && balanceIndex !== lines.length - 1) throw new Error('The balance due term must be the last one');
  const hasFixed = lines.some((line) => line.value_type === 'fixed');
  if (!hasFixed || balanceIndex >= 0) {
    const requestedTotal = lines.reduce((sum, line, index) => sum + (line.value_type === 'fixed' ? fixed[index] : line.value_type === 'percent' ? totalCents * (Number(line.value) || 0) / 100 : 0), 0);
    // Without a balance line the terms must add up to the total; rounding may shift half a unit per line.
    if (balanceIndex >= 0 ? requestedTotal > totalCents + lines.length / 2 : Math.abs(requestedTotal - totalCents) > lines.length / 2) throw new Error('Payment terms must allocate 100% of the total');
  }

  let remaining = totalCents;
  const amounts = lines.map((line, index) => {
    fixedRemaining -= fixed[index];
    const requested = line.value_type === 'fixed'
      ? fixed[index]
      : Math.max(0, Math.round(totalCents * (Number(line.value) || 0) / 100));
    // Reserve later fixed terms and never let rounded percentages overspend the total.
    const amount = index === lines.length - 1 ? remaining : Math.min(requested, remaining - fixedRemaining);
    remaining -= amount;
    return sign * amount;
  });

  return lines.map((line, index) => ({
    date: lineDate(line, invoiceDate),
    amount: Number((amounts[index] * step).toPrecision(15)),
  }));
}

/** Due date of the final installment (dates do not depend on the amount). */
export function dueDate(term, invoiceDate) {
  const dates = (term.line_ids ?? []).map((line) => lineDate(line, invoiceDate));
  return dates.length ? dates.reduce((latest, date) => date > latest ? date : latest) : invoiceDate;
}

/** Return the early-payment discount when payment falls within its configured window. */
export function earlyDiscount(term, total, invoiceDate, paymentDate, currency = null) {
  const discountDate = addDays(invoiceDate, Number(term.discount_days) || 0);
  if (!term.early_discount || !paymentDate || paymentDate > discountDate) return 0;
  return roundCurrency(roundCurrency(total, currency) * (Number(term.discount_percent) || 0) / 100, currency);
}

export const DISCOUNT_TAX_COMPUTATIONS = new Set(['excluded', 'included', 'mixed']);

/** Resolve the canonical discount tax computation mode for a payment term (defaults to 'included' when unset). */
export function discountTaxComputation(term) {
  if (!term) return null;
  return DISCOUNT_TAX_COMPUTATIONS.has(term.discount_tax_computation) ? term.discount_tax_computation : 'included';
}

/** Share of the invoice's tax kept when the term reduces tax for its early-payment discount (1 when it does not). */
export function mixedDiscountFactor(term) {
  const percent = Number(term?.discount_percent) || 0;
  return term?.early_discount && discountTaxComputation(term) === 'mixed' && percent > 0 ? 1 - percent / 100 : 1;
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
      discount_tax_computation: { type: 'selection', label: 'Discount Tax Computation', options: [['excluded', 'Discount before tax'], ['included', 'Discount including tax'], ['mixed', 'Always (tax reduction on invoice)']] },
      line_ids: {
        type: 'one2many',
        label: 'Due Terms',
        fields: {
          value: { type: 'float', label: 'Value' },
          value_type: { type: 'selection', label: 'Value Type', options: [['percent', 'Percent'], ['fixed', 'Fixed'], ['balance', 'Balance']] },
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
    createDefaults: (_db, vals) => (vals?.early_discount ? { discount_tax_computation: 'included' } : {}),
    onchange: (r, key) => (key === 'early_discount' && r.early_discount && !r.discount_tax_computation ? { discount_tax_computation: 'included' } : {}),
    guard: (_db, _before, after) => (after.early_discount && !DISCOUNT_TAX_COMPUTATIONS.has(after.discount_tax_computation) ? 'Select a discount tax computation mode' : null),
    kanban: { title: 'name', lines: ['early_discount'] },
    list: ['name', 'early_discount'],
    form: {
      title: 'name',
      groups: [['name'], ['early_discount', 'discount_percent', 'discount_days', 'discount_tax_computation'], ['preview']],
      tabs: [{ label: 'Due Terms', fields: ['line_ids'] }, { label: 'Note', fields: ['note'] }],
      chatter: true,
    },
  },
};
