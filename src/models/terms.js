import { addDays, isoDate, today, validDate } from './common.js';
import { currencyUnits, roundCurrency } from '../money.js';
import { t } from '../i18n.js';
import { read } from '../orm.js';

/** Payment-term text printed on an invoice: the term's note, else its name; none when the term is hidden from invoices. */
export function invoiceTermNote(db, move) {
  const term = move?.invoice_payment_term_id ? read(db, 'account.payment.term', move.invoice_payment_term_id) : null;
  if (!term || term.display_on_invoice === false) return null;
  return term.note?.trim() || `${t('Payment Terms')}: ${term.name}`;
}

const money = (n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function lineDate(line, invoiceDate) {
  const days = Number(line.nb_days) || 0;
  if (line.delay_type === 'days_end_of_month') {
    const [year, month] = invoiceDate.split('-').map(Number);
    return addDays(isoDate(new Date(year, month, 0)), days);
  }
  if (line.delay_type === 'days_after_end_of_next_month') {
    const [year, month] = invoiceDate.split('-').map(Number);
    return addDays(isoDate(new Date(year, month + 1, 0)), days);
  }
  if (line.delay_type === 'days_end_of_month_on_the') {
    const [y, m] = addDays(invoiceDate, days).split('-').map(Number);
    const nextEnd = new Date(y, m + 1, 0);
    nextEnd.setDate(Math.min(Math.max(1, Math.trunc(Number(line.days_next_month) || 1)), nextEnd.getDate()));
    return isoDate(nextEnd);
  }
  return addDays(invoiceDate, days);
}

/** Return an error message when transient preview inputs (`example_amount`, `example_date`) are invalid, or null. */
export function exampleInputsError(vals) {
  if (!vals) return null;
  if (Object.hasOwn(vals, 'example_amount')) {
    const n = Number(vals.example_amount);
    if (vals.example_amount === '' || vals.example_amount == null || !Number.isFinite(n) || n <= 0) {
      return 'Example amount must be a positive number';
    }
  }
  if (Object.hasOwn(vals, 'example_date') && !validDate(vals.example_date)) {
    return 'Example date must be a valid date';
  }
  return null;
}

/** Return an error message when any due-term line has invalid day-of-month configuration, or null. */
export function dueTermLinesError(term) {
  for (const l of term?.line_ids ?? []) {
    if (l.delay_type === 'days_end_of_month_on_the') {
      const d = l.days_next_month;
      if (!Number.isInteger(d) || d < 1 || d > 31) {
        return 'Enter the day of the next month (1-31) for Days end of month on the';
      }
    }
  }
  return null;
}

/** Return the first validation error for a payment term schedule against `total`, or null when valid. */
export function termScheduleError(term, total, currency = null) {
  const lines = term?.line_ids ?? [];
  if (!lines.length) return 'Add at least one due term';

  const totalCents = Math.abs(currencyUnits(total, currency));
  const fixed = lines.map((line) => (line.value_type === 'fixed' ? Math.max(0, currencyUnits(line.value, currency)) : 0));
  const fixedRemaining = fixed.reduce((sum, amount) => sum + amount, 0);
  if (fixedRemaining > totalCents) return 'Fixed amounts exceed the total';
  const balanceIndex = lines.findIndex((line) => line.value_type === 'balance' || (!line.value_type && line.value === 'balance'));
  if (balanceIndex >= 0 && balanceIndex !== lines.length - 1) return 'The balance due term must be the last one';
  const hasFixed = lines.some((line) => line.value_type === 'fixed');
  if (!hasFixed || balanceIndex >= 0) {
    const requestedTotal = lines.reduce((sum, line, index) => sum + (line.value_type === 'fixed' ? fixed[index] : line.value_type === 'percent' ? totalCents * (Number(line.value) || 0) / 100 : 0), 0);
    // Without a balance line the terms must add up to the total; rounding may shift half a unit per line.
    if (balanceIndex >= 0 ? requestedTotal > totalCents + lines.length / 2 : Math.abs(requestedTotal - totalCents) > lines.length / 2) {
      return 'Payment terms must allocate 100% of the total';
    }
  }
  return null;
}

/** Split an invoice total into dated installments according to a payment term. */
export function installments(term, total, invoiceDate, currency = null) {
  const error = termScheduleError(term, total, currency);
  if (error) throw new Error(error);

  const lines = term.line_ids ?? [];
  const step = Number(currency?.rounding ?? 0.01);
  const signedTotal = currencyUnits(total, currency);
  const sign = Math.sign(signedTotal);
  const totalCents = Math.abs(signedTotal);
  const fixed = lines.map((line) => (line.value_type === 'fixed' ? Math.max(0, currencyUnits(line.value, currency)) : 0));
  let fixedRemaining = fixed.reduce((sum, amount) => sum + amount, 0);

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

/** Format the payment-term preview lines from its example amount/date without hiding unexpected errors. */
export function formatTermPreview(r) {
  const rawAmount = r && Object.hasOwn(r, 'example_amount') ? r.example_amount : 1000;
  const date = r && Object.hasOwn(r, 'example_date') ? r.example_date : today();
  const inputError = exampleInputsError({ example_amount: rawAmount, example_date: date });
  if (inputError) return t(inputError);

  const total = Number(rawAmount);
  const validationError = termScheduleError(r, total) ?? dueTermLinesError(r);
  if (validationError) return t(validationError);
  if (r?.display_on_invoice === false) return '';

  const rows = installments(r, total, date);
  const lines = [];
  if (r?.early_discount) {
    const discountDate = addDays(date, Number(r.discount_days) || 0);
    const discount = earlyDiscount(r, total, date, discountDate);
    lines.push(t('Early Payment Discount: {amount} if paid before {date}', { amount: money(total - discount), date: discountDate }));
  }
  rows.forEach((row, i) => {
    lines.push(t('{index} - Installment of {amount} due on {date}', { index: i + 1, amount: money(row.amount), date: row.date }));
  });
  return lines.join('\n');
}

export const termModels = {
  'account.payment.term': {
    label: 'Payment Terms',
    fields: {
      name: { type: 'char', label: 'Payment Terms', required: true, placeholder: 'e.g. 30 days' },
      sequence: { type: 'integer', label: 'Sequence', widget: 'handle' },
      active: { type: 'boolean', label: 'Active' },
      company_id: { type: 'many2one', relation: 'res.company', label: 'Company', multiCompanyOnly: true, placeholder: 'Visible to all' },
      early_discount: { type: 'boolean', label: 'Early Discount' },
      discount_percent: { type: 'float', label: 'Discount %' },
      discount_days: { type: 'integer', label: 'Within (days)' },
      discount_tax_computation: {
        type: 'selection',
        label: 'Reduced tax',
        options: [
          ['included', 'On early payment'],
          ['excluded', 'Never'],
          ['mixed', 'Always (upon invoice)'],
        ],
      },
      display_on_invoice: { type: 'boolean', label: 'Display terms on invoice' },
      example_amount: { type: 'float', label: 'Example Amount', editable: true, compute: (r) => (r && Object.hasOwn(r, 'example_amount') ? r.example_amount : 1000) },
      example_date: { type: 'date', label: 'Example Date', editable: true, compute: (r) => (r && Object.hasOwn(r, 'example_date') ? r.example_date : today()) },
      line_ids: {
        type: 'one2many',
        label: 'Due Terms',
        fields: {
          value: { type: 'float', label: 'Due' },
          value_type: {
            type: 'selection',
            label: 'Value Type',
            hideHeader: true,
            legacyOptions: ['balance'],
            options: [['percent', 'Percent'], ['fixed', 'Fixed'], ['balance', 'Balance']],
          },
          nb_days: { type: 'integer', label: 'After' },
          delay_type: {
            type: 'selection',
            label: 'Delay Type',
            hideHeader: true,
            options: [
              ['days_after', 'Days after invoice date'],
              ['days_end_of_month', 'Days after end of month'],
              ['days_after_end_of_next_month', 'Days after end of next month'],
              ['days_end_of_month_on_the', 'Days end of month on the'],
            ],
          },
          days_next_month: {
            type: 'integer',
            label: 'On the',
            readonly: (l) => l?.delay_type !== 'days_end_of_month_on_the',
            hideWhen: (l) => l?.delay_type !== 'days_end_of_month_on_the',
          },
        },
        newLine,
        onchange: (l, key) => (key === 'delay_type'
          ? (l.delay_type === 'days_end_of_month_on_the'
            ? { ...l, days_next_month: l.days_next_month || 10 }
            : (() => { const { days_next_month: _, ...rest } = l; return rest; })())
          : l),
      },
      preview: {
        type: 'text',
        label: 'Preview',
        readonly: true,
        compute: formatTermPreview,
      },
      note: {
        type: 'text',
        label: 'Note',
        placeholder: 'Description on invoice (e.g. Payment terms: 30 days after invoice date)',
      },
    },
    defaults: () => ({ sequence: 10, active: true, display_on_invoice: true, early_discount: false, discount_percent: 0, discount_days: 0, line_ids: [newLine()] }),
    createDefaults: (_db, vals) => (vals?.early_discount ? { discount_tax_computation: 'included' } : {}),
    onchange: (r, key) => (key === 'early_discount' && r.early_discount && !r.discount_tax_computation ? { discount_tax_computation: 'included' } : {}),
    guard: (_db, before, after, _ctx, vals) => {
      const exampleErr = exampleInputsError(vals);
      if (exampleErr) return exampleErr;
      // Terms saved before the mode existed keep reading as 'included' (discountTaxComputation) and stay editable.
      const legacyUnset = after.discount_tax_computation == null && before?.early_discount && before.discount_tax_computation == null;
      if (after.early_discount && !DISCOUNT_TAX_COMPUTATIONS.has(after.discount_tax_computation) && !legacyUnset) {
        return 'Select a discount tax computation mode';
      }
      return dueTermLinesError(after);
    },
    sort: (a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || (a.id ?? 0) - (b.id ?? 0),
    views: ['list', 'kanban'],
    kanban: { title: 'name', lines: ['early_discount'] },
    list: ['sequence', 'name', 'company_id'],
    listDecoration: (r) => (r.active === false ? 'muted' : ''),
    searchFields: ['name'],
    form: {
      title: 'name',
      titleLabel: true,
      groups: (r) => [
        {
          fullWidth: true,
          fields: [
            'company_id',
            {
              fields: ['early_discount', ...(r?.early_discount ? ['discount_percent', 'discount_days'] : [])],
              joins: ['', '% if paid within'],
              suffix: r?.early_discount ? 'days' : undefined,
              inline: true,
            },
            ...(r?.early_discount ? [{ field: 'discount_tax_computation', label: 'Reduced tax:' }] : []),
          ],
        },
        { title: 'Due Terms', fields: ['line_ids'] },
        {
          title: 'Preview',
          fields: [
            'display_on_invoice',
            { label: 'Example:', fields: ['example_amount', 'example_date'], join: 'on', inline: true },
            'note',
            'preview',
          ],
        },
      ],
      chatter: true,
    },
  },
};
