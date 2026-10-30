// Money rounding shared by every module (ARCH-007). Rounds half away from zero, like Odoo's float_round (HALF-UP).
// The scaled value is nudged by its binary floating point error first, so 1.005 rounds to 1.01 and -0.125 to -0.13.
// Non-numeric input rounds to 0.

/** `n` rounded to `digits` decimals (2 by default). */
export function round(n, digits = 2) {
  const factor = 10 ** digits;
  const x = Number(n) * factor;
  if (!Number.isFinite(x)) return 0;
  return (Math.sign(x) * Math.round(Math.abs(x) * (1 + Number.EPSILON))) / factor || 0;
}

/** `n` as integer minor units (cents), rounded the same way. */
export const cents = (n) => Math.round(round(n) * 100);

/** Split rounded cents proportionally, with stable largest-remainder ties and the total's sign. */
export function allocateCents(amount, weights) {
  const total = cents(amount);
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
  return shares.map((share) => Math.sign(total) * share.whole / 100 || 0);
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
