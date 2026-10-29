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
