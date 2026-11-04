import { search } from '../orm.js';
import { round } from '../money.js';

export const periods = { hour: 1, day: 24, week: 168, month: 720 };
export const timestamp = (value) => {
  const time = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error('Enter a valid pickup and return date');
  return time;
};
export const windowOf = (from, to) => {
  const start = timestamp(from), end = timestamp(to);
  if (end < start) throw new Error('The return date must be after the pickup date');
  return [start, end];
};
/** Elapsed hours rounded up to a whole hour, with a one-hour minimum. */
export function rentalHours(pickup, end) {
  const [from, to] = windowOf(pickup, end);
  return Math.max(1, Math.ceil((to - from) / 36e5));
}

/** Find the least expensive combination of periods covering the rental; prices are per unit. */
export function bestPrice(db, productId, hours) {
  if (!Number.isFinite(hours) || hours < 0) throw new Error('Enter a valid rental duration');
  const wanted = Math.max(1, hours);
  const rules = search(db, 'rental.pricing').filter((r) => r.product_id === productId)
    .map((r) => ({ ...r, hours: periods[r.period] * r.duration })).sort((a, b) => b.hours - a.hours || a.price - b.price);
  if (!rules.length) {
    const rental = search(db, 'sale.rental').find((r) => r.product_id === productId);
    if (!rental) throw new Error('Set rental pricing or a rental daily price for this product');
    const qty = Math.ceil(wanted / 24), price = round(qty * Number(rental.price_per_day));
    return { price, breakdown: [{ period: 'day', duration: 1, qty, price }] };
  }
  const cache = new Map();
  const quote = (index, remaining) => {
    if (remaining <= 0) return { price: 0, breakdown: [] };
    if (index === rules.length) return { price: Infinity, breakdown: [] };
    const key = `${index}:${remaining}`;
    if (cache.has(key)) return cache.get(key);
    const rule = rules[index];
    const line = (qty) => ({ period: rule.period, duration: rule.duration, qty, price: round(qty * rule.price) });
    const rounded = line(Math.ceil(remaining / rule.hours));
    let best = { price: rounded.price, breakdown: [rounded] };
    for (let qty = Math.floor(remaining / rule.hours); qty >= 0; qty--) {
      const tail = quote(index + 1, remaining - qty * rule.hours);
      if (!Number.isFinite(tail.price)) continue;
      const head = line(qty);
      const price = round(head.price + tail.price);
      if (price < best.price) best = { price, breakdown: [...(qty ? [head] : []), ...tail.breakdown] };
    }
    cache.set(key, best);
    return best;
  };
  return quote(0, wanted);
}

