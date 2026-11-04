// Money rounding shared by every module (ARCH-007). Rounds half away from zero, like Odoo's float_round (HALF-UP).
// The scaled value is nudged by its binary floating point error first, so 1.005 rounds to 1.01 and -0.125 to -0.13.
// Non-numeric input rounds to 0.

/** `n` rounded to `digits` decimals (2 by default). */
export function round(n, digits = 2) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** digits;
  const x = num * factor;
  const nudged = Math.abs(x) * (1 + Number.EPSILON);
  if (!Number.isFinite(x) || !Number.isFinite(nudged)) throw new Error('Unrepresentable monetary amount');
  return (Math.sign(x) * Math.round(nudged)) / factor || 0;
}

/** Round to a currency's monetary increment; legacy currencies default to cents. */
export function roundCurrency(amount, currency) {
  const step = Number(currency?.rounding ?? 0.01);
  if (!Number.isFinite(step) || step <= 0) throw new Error('Currency rounding must be positive');
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  const units = Math.abs(value) / step;
  if (!Number.isFinite(units)) throw new Error('Unrepresentable monetary amount');
  return Number((Math.sign(value) * Math.round(units * (1 + Number.EPSILON)) * step).toPrecision(15)) || 0;
}

/** Decimal digits necessary to display a currency's increment. */
export function currencyDecimalPlaces(currency) {
  const step = Number(currency?.rounding ?? 0.01);
  if (!Number.isFinite(step) || step <= 0) throw new Error('Currency rounding must be positive');
  // Number#toString supplies the shortest decimal representing the increment,
  // including scientific notation for very small values. Avoid an absolute
  // tolerance here: it can mistake a nonzero increment for zero.
  const [coefficient, exponent = '0'] = step.toString().split('e');
  const fractionalDigits = (coefficient.split('.')[1] ?? '').length;
  return Math.min(15, Math.max(0, fractionalDigits - Number(exponent)));
}

/** Format using the configured increment's decimal places, not an ISO-code default. */
export function formatCurrency(amount, currency, code = currency?.name) {
  const digits = currencyDecimalPlaces(currency);
  const precision = { minimumFractionDigits: digits, maximumFractionDigits: digits };
  let formatter;
  try {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, ...precision });
  } catch {
    formatter = new Intl.NumberFormat('en-US', precision);
  }
  const value = Number(amount);
  return formatter.format(Number.isFinite(value) ? value : 0);
}

/** Resolve currencies without requiring callers to materialize computed ORM fields. */
export function companyCurrencyRecord(db, companyId) {
  const company = (db?.records?.['res.company'] ?? []).find((c) => c.id === (companyId ?? 1));
  const currencies = db?.records?.['res.currency'] ?? [];
  return currencies.find((c) => c.id === company?.currency_id)
    ?? currencies.find((c) => c.name === db?.settings?.currency) ?? null;
}

export function documentCurrency(db, record) {
  return (db?.records?.['res.currency'] ?? []).find((c) => c.id === record?.currency_id)
    ?? companyCurrencyRecord(db, record?.company_id);
}

/** Integer count of the currency's rounding units. */
export function currencyUnits(amount, currency) {
  const step = Number(currency?.rounding ?? 0.01);
  return Math.round(roundCurrency(amount, currency) / step);
}

/** `n` as integer minor units (cents), rounded the same way. */
export const cents = (n) => Math.round(round(n) * 100);

/** Split rounded cents proportionally, with stable largest-remainder ties and the total's sign. */
export function allocateCents(amount, weights, currency = null) {
  const step = Number(currency?.rounding ?? 0.01);
  const total = currencyUnits(amount, currency);
  const basis = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(basis) || basis <= 0 || weights.some((weight) => !Number.isFinite(weight) || weight < 0)) throw new Error('The selected allocation basis must be positive');
  const shares = weights.map((weight, index) => {
    const exact = Math.abs(total) * (weight / basis);
    const whole = Math.floor(exact);
    return { index, whole, fraction: exact - whole };
  });
  const ranked = [...shares].sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const leftover = Math.abs(total) - shares.reduce((sum, share) => sum + share.whole, 0);
  for (let i = 0; i < leftover; i++) ranked[i].whole++;
  return shares.map((share) => Number((Math.sign(total) * share.whole * step).toPrecision(15)) || 0);
}

/** Round a monetary amount to an increment, with directions measured away from zero. */
export function cashRound(amount, increment, method) {
  const value = Number(amount);
  const step = Number(increment);
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0 || !['UP', 'DOWN', 'HALF-UP'].includes(method)) throw new Error('Invalid cash rounding');
  const scaled = Math.abs(value) / step;
  const tolerance = Number.EPSILON * Math.max(1, scaled) * 4;
  const units = method === 'UP' ? Math.ceil(scaled - tolerance) : method === 'DOWN' ? Math.floor(scaled + tolerance) : Math.floor(scaled + 0.5 + tolerance);
  return Number((Math.sign(value) * units * step).toPrecision(15)) || 0;
}
