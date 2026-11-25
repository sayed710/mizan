import { addDays, isoDate, today, validDate } from './common.js';
import { currencyUnits, documentCurrency, roundCurrency } from '../money.js';
import { companyCurrency } from './currency.js';
import { t } from '../i18n.js';
import { read } from '../orm.js';

/** Payment-term text printed on an invoice: the term's note, else its name; none when the term is hidden from invoices. */
export function invoiceTermNote(db, move) {
  const term = move?.invoice_payment_term_id ? read(db, 'account.payment.term', move.invoice_payment_term_id) : null;
  if (!term || term.display_on_invoice === false) return null;
  return term.note?.trim() || `${t('Payment Terms')}: ${term.name}`;
}

/** Derive the displayed installment schedule for an invoice document. */
export function invoiceInstallments(db, move, term = null) {
  const termRecord = term ?? (move?.invoice_payment_term_id ? read(db, 'account.payment.term', move.invoice_payment_term_id) : null);
  if (!termRecord?.display_on_invoice) return null;

  if (move?.state === 'posted') {
    const accountType = ['out_invoice', 'out_refund'].includes(move.move_type)
      ? 'asset_receivable'
      : ['in_invoice', 'in_refund'].includes(move.move_type)
        ? 'liability_payable'
        : null;
    if (!accountType) return null;
    const items = (move.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === accountType);
    if (!items.length) return null;
    const own = companyCurrency(db, move.company_id);
    const foreign = !!move.currency_id && move.currency_id !== own;
    return items
      .map((l) => ({
        date: l.date_maturity ?? move.invoice_date_due ?? (validDate(move.invoice_date) ? move.invoice_date : today()),
        amount: foreign && l.amount_currency != null
          ? Math.abs(Number(l.amount_currency) || 0)
          : Math.abs((Number(l.debit) || 0) - (Number(l.credit) || 0)),
      }))
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  }

  const currency = documentCurrency(db, move);
  const baseDate = validDate(move?.invoice_date) ? move.invoice_date : today();
  const error = termScheduleError(termRecord, move?.amount_total, currency) ?? dueTermLinesError(termRecord);
  if (error) return null;
  return installments(termRecord, move?.amount_total, baseDate, currency);
}

const money = (n) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function lineDate(line, invoiceDate) {
  const base = validDate(invoiceDate) ? invoiceDate : today();
  const days = Number(line.nb_days) || 0;
  if (line.delay_type === 'days_end_of_month') {
    const [year, month] = base.split('-').map(Number);
    return addDays(isoDate(new Date(year, month, 0)), days);
  }
  if (line.delay_type === 'days_after_end_of_next_month') {
    const [year, month] = base.split('-').map(Number);
    return addDays(isoDate(new Date(year, month + 1, 0)), days);
  }
  if (line.delay_type === 'days_end_of_month_on_the') {
    const [y, m] = addDays(base, days).split('-').map(Number);
    const nextEnd = new Date(y, m + 1, 0);
    nextEnd.setDate(Math.min(Math.max(1, Math.trunc(Number(line.days_next_month) || 1)), nextEnd.getDate()));
    return isoDate(nextEnd);
  }
  return addDays(base, days);
}

const isBalanceLine = (line) => line?.value_type === 'balance' || (!line?.value_type && line?.value === 'balance');
const isPercentLine = (line) => line?.value_type === 'percent';
const roundPercent = (value) => Math.round(value * 1e6) / 1e6;

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

/** Validate payment term line percentages, balance line placement, and early-discount rules (Odoo _check_lines/_check_percent). */
export function paymentTermLinesError(term) {
  const lines = term?.line_ids ?? [];
  if (!lines.length) return 'Add at least one due term';
  const balanceIndex = lines.findIndex(isBalanceLine);
  if (balanceIndex >= 0 && balanceIndex !== lines.length - 1) return 'The balance due term must be the last one';

  let totalPercent = 0;
  let hasPercent = false;
  for (const line of lines) {
    if (!isPercentLine(line)) continue;
    hasPercent = true;
    const pct = Number(line.value ?? 0);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return 'Percentages on the Payment Terms lines must be between 0 and 100.';
    }
    totalPercent += pct;
  }
  totalPercent = roundPercent(totalPercent);

  if (balanceIndex < 0) {
    if (!hasPercent || totalPercent !== 100) {
      return 'The Payment Term must have at least one percent line and the sum of the percent must be 100%.';
    }
  } else if (totalPercent > 100) {
    return 'Payment terms must allocate 100% of the total';
  }

  if (term?.early_discount) {
    if (lines.length !== 1 || !isPercentLine(lines[0]) || totalPercent !== 100) {
      return 'The Early Payment Discount functionality can only be used with payment terms using a single 100% line.';
    }
    const discountPercent = Number(term.discount_percent);
    if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
      return 'The Early Payment Discount must be strictly positive.';
    }
    const discountDays = Number(term.discount_days);
    if (!Number.isFinite(discountDays) || discountDays <= 0) {
      return 'The Early Payment Discount days must be strictly positive.';
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
  const balanceIndex = lines.findIndex(isBalanceLine);
  if (balanceIndex >= 0 && balanceIndex !== lines.length - 1) return 'The balance due term must be the last one';
  const hasFixed = lines.some((line) => line.value_type === 'fixed');
  const hasPercent = lines.some(isPercentLine);
  const lastPercentIndex = balanceIndex < 0 && hasFixed && hasPercent ? lines.findLastIndex(isPercentLine) : -1;
  const requestedTotal = lines.reduce((sum, line, index) => sum + (
    line.value_type === 'fixed' ? fixed[index] : isPercentLine(line) && index !== lastPercentIndex ? totalCents * (Number(line.value) || 0) / 100 : 0
  ), 0);
  if (balanceIndex >= 0 || (hasFixed && hasPercent)) {
    if (requestedTotal > totalCents + lines.length / 2) {
      return 'Payment terms must allocate 100% of the total';
    }
  } else if (Math.abs(requestedTotal - totalCents) > lines.length / 2) {
    return 'Payment terms must allocate 100% of the total';
  }
  return null;
}

/** Split an invoice total into dated installments according to a payment term. */
export function installments(term, total, invoiceDate, currency = null) {
  const error = termScheduleError(term, total, currency);
  if (error) throw new Error(error);

  const baseDate = validDate(invoiceDate) ? invoiceDate : today();
  const lines = [...(term.line_ids ?? [])].sort((a, b) => lineDate(a, baseDate).localeCompare(lineDate(b, baseDate)));
  const step = Number(currency?.rounding ?? 0.01);
  const signedTotal = currencyUnits(total, currency);
  const sign = Math.sign(signedTotal);
  const totalCents = Math.abs(signedTotal);
  const fixed = lines.map((line) => (line.value_type === 'fixed' ? Math.max(0, currencyUnits(line.value, currency)) : 0));
  let fixedRemaining = fixed.reduce((sum, amount) => sum + amount, 0);

  const hasBalance = lines.some(isBalanceLine);
  const lastPercentIndex = lines.findLastIndex(isPercentLine);
  const isResidualLine = (line, index) => (hasBalance ? isBalanceLine(line) : index === lastPercentIndex);

  let remaining = totalCents;
  const amounts = lines.map((line, index) => {
    fixedRemaining -= fixed[index];
    const requested = line.value_type === 'fixed'
      ? fixed[index]
      : Math.max(0, Math.round(totalCents * (Number(line.value) || 0) / 100));
    // Reserve later fixed terms and never let rounded percentages overspend the total.
    const isResidual = isResidualLine(line, index);
    const laterRequested = isResidual ? lines.slice(index + 1).reduce((sum, later) => sum + (later.value_type === 'fixed'
      ? Math.max(0, currencyUnits(later.value, currency))
      : Math.max(0, Math.round(totalCents * (Number(later.value) || 0) / 100))), 0) : 0;
    const amount = isResidual
      ? Math.max(0, remaining - laterRequested)
      : Math.min(requested, remaining - fixedRemaining);
    remaining -= amount;
    return sign * amount;
  });

  return lines.map((line, index) => ({
    date: lineDate(line, baseDate),
    amount: Number((amounts[index] * step).toPrecision(15)),
  }));
}

/** Due date of the final installment (dates do not depend on the amount). */
export function dueDate(term, invoiceDate) {
  const baseDate = validDate(invoiceDate) ? invoiceDate : today();
  const dates = (term.line_ids ?? []).map((line) => lineDate(line, baseDate));
  return dates.length ? dates.reduce((latest, date) => date > latest ? date : latest) : baseDate;
}

/** Return the early-payment discount when payment falls within its configured window. */
export function earlyDiscount(term, total, invoiceDate, paymentDate, currency = null) {
  const baseDate = validDate(invoiceDate) ? invoiceDate : today();
  const discountDate = addDays(baseDate, Number(term.discount_days) || 0);
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
      display_on_invoice: { type: 'boolean', label: 'Show installment dates' },
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
      return paymentTermLinesError(after) ?? dueTermLinesError(after);
    },
    protectDelete: (db, term) => ((db.records['account.move'] ?? []).some((move) => move.invoice_payment_term_id === term.id)
      ? 'You can not delete payment terms as other records still reference it. However, you can archive it.'
      : null),
    sort: (a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || (a.id ?? 0) - (b.id ?? 0),
    views: ['list', 'kanban'],
    kanban: { title: 'name', lines: ['note'] },
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
