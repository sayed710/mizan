import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';

const run = (db, id, label) => models['sale.rental'].form.buttons.find((b) => b.label === label).run(db, read(db, 'sale.rental', id)).db;

test('reservations cannot exceed stock for overlapping dates', () => {
  const db0 = write(seed(), 'product', 3, { qty_available: 2 });
  const busy = (db0.records['sale.rental'] ?? []).filter((o) => o.product_id === 3);
  const base = busy.reduce((db, o) => write(db, 'sale.rental', o.id, { state: 'cancel' }), db0);
  const a = create(base, 'sale.rental', { partner_id: 1, product_id: 3, qty: 2, pickup_date: '2027-01-10', return_date: '2027-01-15', price_per_day: 10 });
  const reserved = run(a.db, a.id, 'Confirm');
  const b = create(reserved, 'sale.rental', { partner_id: 1, product_id: 3, qty: 1, pickup_date: '2027-01-14', return_date: '2027-01-20', price_per_day: 10 });
  assert.throws(() => run(b.db, b.id, 'Confirm'), /Only 0 .* available/);
  const c = create(reserved, 'sale.rental', { partner_id: 1, product_id: 3, qty: 1, pickup_date: '2027-01-16', return_date: '2027-01-20', price_per_day: 10 });
  assert.equal(read(run(c.db, c.id, 'Confirm'), 'sale.rental', c.id).state, 'reserved');
});

test('a late return adds a late fee line to the invoice', () => {
  const { db, id } = create(seed(), 'sale.rental', { partner_id: 1, product_id: 1, qty: 1, pickup_date: addDays(today(), -6), return_date: addDays(today(), -2), price_per_day: 20, state: 'picked', late_fee_factor: 1.5 });
  const returned = run(db, id, 'Return');
  assert.equal(read(returned, 'sale.rental', id).late_fee, 60);
  const invoiced = run(returned, id, 'Create Invoice');
  const inv = search(invoiced, 'account.move').find((m) => m.invoice_origin === read(invoiced, 'sale.rental', id).name);
  assert.deepEqual(inv.invoice_line_ids.map((l) => l.price_unit), [20, 60]);
});
