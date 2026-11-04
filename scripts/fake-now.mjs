// Preload for running the tests at another date: FAKE_NOW=2027-01-02T10:00:00Z, or 400 days ahead when unset.
// Catches tests that hard-code dates the seed (built relative to today) will move past.
const target = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : Date.now() + 400 * 86400000;
const offset = target - Date.now();
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(RealDate.now() + offset);
  }

  static now() { return RealDate.now() + offset; }
}
globalThis.Date = ShiftedDate;
