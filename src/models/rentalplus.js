import { create, read, search, write } from '../orm.js';
import { postEntry } from './ledger.js';
import { extraModels } from './extra.js';
import { round } from '../money.js';

const baseRental = extraModels['sale.rental'];

export { bestPrice, rentalHours } from './rentalpricing.js';
import { periods, timestamp, windowOf } from './rentalpricing.js';

const rentalOf = (db, id) => {
  const rental = read(db, 'sale.rental', id);
  if (!rental) throw new Error('Rental not found');
  return rental;
};

/** Available fleet units, accounting for picked units already removed from on-hand stock. */
export function availability(db, productId, from, to) {
  const [start, end] = windowOf(from, to);
  const product = read(db, 'product', productId);
  if (!product) throw new Error('Product not found');
  const rentals = search(db, 'sale.rental').filter((r) => r.product_id === productId);
  const out = rentals.filter((r) => r.state === 'picked' && !r.actual_return_date).reduce((sum, r) => sum + Number(r.qty), 0);
  const busy = rentals.filter((r) => ['reserved', 'picked'].includes(r.state) && !r.actual_return_date && timestamp(r.pickup_date) <= end && (r.state === 'picked' || timestamp(r.return_date) >= start))
    .reduce((sum, r) => sum + Number(r.qty), 0);
  return Number(product.qty_available) + out - busy;
}

/** Receive a refundable deposit; returns { db, id } for the held deposit. */
export function holdDeposit(db, rentalId, amount) {
  const rental = rentalOf(db, rentalId);
  if (!Number.isFinite(amount) || round(amount) <= 0) throw new Error('Deposit amount must be positive');
  const value = round(amount);
  const booked = postEntry(db, { journal: 'BNK1', ref: `Deposit ${rental.name}`, company: rental.company_id ?? 1, lines: [
    { account: '101401', debit: value, partner_id: rental.partner_id },
    { account: '230100', credit: value, partner_id: rental.partner_id },
  ] });
  return create(booked.db, 'rental.deposit', { rental_id: rentalId, company_id: rental.company_id ?? 1, amount: value, state: 'held', move_id: booked.id });
}

/** Release the liability to bank and, for damage, other income; returns the new db. */
export function settleDeposit(db, depositId, { damage = 0, note } = {}) {
  const deposit = read(db, 'rental.deposit', depositId);
  if (!deposit) throw new Error('Deposit not found');
  if (deposit.state !== 'held') throw new Error('This deposit has already been settled');
  if (!Number.isFinite(damage) || damage < 0 || damage > deposit.amount) throw new Error('Damage must be between zero and the deposit amount');
  const rental = rentalOf(db, deposit.rental_id);
  const withheld = round(damage), refund = round(deposit.amount - withheld);
  const partner_id = rental.partner_id;
  const booked = postEntry(db, { journal: 'BNK1', ref: `Settle deposit ${rental.name}`, company: rental.company_id ?? 1, lines: [
    { account: '230100', debit: deposit.amount, partner_id },
    ...(refund ? [{ account: '101401', credit: refund, partner_id }] : []),
    ...(withheld ? [{ account: '450000', credit: withheld, partner_id }] : []),
  ] });
  return write(booked.db, 'rental.deposit', depositId, { state: withheld ? 'withheld' : 'refunded', withheld_amount: withheld, note: note ?? deposit.note, settlement_move_id: booked.id });
}

function rentalPicking(db, rental, incoming) {
  const current = rentalOf(db, rental.id);
  const key = incoming ? 'return_picking_id' : 'pickup_picking_id';
  if (current[key]) return db;
  const picking = create(db, 'stock.picking', {
    picking_type: incoming ? 'incoming' : 'outgoing', partner_id: current.partner_id, origin: current.name,
    scheduled_date: incoming ? current.return_date : current.pickup_date,
    move_ids: [{ product_id: current.product_id, qty: current.qty }], state: 'draft',
  });
  return write(picking.db, 'sale.rental', current.id, { [key]: picking.id });
}

/** Create and link one draft outgoing transfer; returns the new db. */
export function pickupPicking(db, rental) {
  return rentalPicking(db, rental, false);
}

/** Create and link one draft incoming transfer; returns the new db. */
export function returnPicking(db, rental) {
  return rentalPicking(db, rental, true);
}

/** Group overlapping rentals by product, retaining full dates and all workflow states. */
export function rentalSchedule(db, { from, to }) {
  const [start, end] = windowOf(from, to);
  const products = new Map();
  for (const rental of search(db, 'sale.rental')) {
    const stop = rental.actual_return_date ?? rental.return_date;
    if (timestamp(rental.pickup_date) > end || timestamp(stop) < start) continue;
    const item = { id: rental.id, name: rental.name, start: rental.pickup_date, end: stop, state: rental.state };
    products.set(rental.product_id, [...(products.get(rental.product_id) ?? []), item]);
  }
  return [...products].map(([product_id, rentals]) => ({ product_id, rentals: rentals.sort((a, b) => timestamp(a.start) - timestamp(b.start) || a.id - b.id) }));
}

export const rentalPlusModels = {
  'rental.pricing': {
    label: 'Rental Pricing',
    fields: {
      product_id: { type: 'many2one', relation: 'product', label: 'Product', required: true },
      period: { type: 'selection', label: 'Period', required: true, options: [['hour', 'Hour'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month']] },
      duration: { type: 'integer', label: 'Duration', required: true },
      price: { type: 'monetary', label: 'Price', required: true },
    },
    defaults: () => ({ period: 'day', duration: 1, price: 0 }),
    guard: (db, before, r) => !periods[r.period] || !Number.isInteger(r.duration) || r.duration < 1 ? 'Choose a valid period and positive whole duration' : !Number.isFinite(r.price) || r.price < 0 ? 'Price must be a non-negative amount' : null,
    list: ['product_id', 'period', 'duration', 'price'],
    form: { title: 'product_id', groups: [['product_id'], ['period', 'duration', 'price']] },
  },
  'rental.deposit': {
    label: 'Security Deposits',
    duplicate: false,
    fields: {
      rental_id: { type: 'many2one', relation: 'sale.rental', label: 'Rental', required: true },
      amount: { type: 'monetary', label: 'Amount', required: true, readonly: true },
      state: { type: 'selection', label: 'Status', readonly: true, tracking: true, options: [['held', 'Held'], ['refunded', 'Refunded'], ['withheld', 'Withheld']] },
      withheld_amount: { type: 'monetary', label: 'Withheld Amount', readonly: true },
      note: { type: 'text', label: 'Note' },
      move_id: { type: 'many2one', relation: 'account.move', label: 'Deposit Entry', readonly: true },
      settlement_move_id: { type: 'many2one', relation: 'account.move', label: 'Settlement Entry', readonly: true },
    },
    defaults: () => ({ state: 'held', withheld_amount: 0, note: '' }),
    list: ['rental_id', 'amount', 'state', 'withheld_amount', 'move_id'],
    form: {
      title: 'rental_id', statusbar: 'state', lockedWhen: (r) => r.state !== 'held',
      buttons: [
        { label: 'Refund', primary: true, when: (r) => r.state === 'held', run: (db, r) => ({ db: settleDeposit(db, r.id) }) },
        {
          label: 'Withhold for Damage', when: (r) => r.state === 'held',
          ask: [{ label: 'Damage amount to keep', type: 'number' }, { label: 'Note' }],
          run: (db, r, [damage, note]) => ({ db: settleDeposit(db, r.id, { damage, note: note || undefined }) }),
        },
      ],
      groups: [['rental_id', 'amount', 'withheld_amount'], ['move_id', 'settlement_move_id']], tabs: [{ label: 'Note', fields: ['note'] }], chatter: true,
    },
  },
  'sale.rental': {
    ...baseRental,
    form: {
      ...baseRental.form,
      buttons: [
        ...baseRental.form.buttons,
        {
          label: 'Hold Deposit', when: (r) => ['reserved', 'picked'].includes(r.state),
          ask: [{ label: 'Deposit amount', type: 'number' }],
          run: (db, r, [amount]) => { const res = holdDeposit(db, r.id, amount); return { db: res.db, go: `#/rental/deposits/${res.id}` }; },
        },
      ],
    },
  },
};
