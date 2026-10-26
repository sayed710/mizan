// Preload: shift the wall clock by MIZAN_SHIFT_DAYS days (Date and Date.now only).
const shift = Number(process.env.MIZAN_SHIFT_DAYS || 0) * 86400000;
const Real = Date;
class Shifted extends Real {
  constructor(...a) { if (a.length === 0) super(Real.now() + shift); else super(...a); }
  static now() { return Real.now() + shift; }
}
globalThis.Date = Shifted;
