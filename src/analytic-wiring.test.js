// Posting an invoice books its analytic lines; Reset to Draft removes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';

test('invoice posting creates analytic lines that reset to draft removes', () => {
  let db = seed();
  const account = create(db, 'account.analytic.account', { name: 'Project Nile' });
  const inv = create(account.db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-10-20',
    invoice_line_ids: [{ product_id: 1, name: 'Desk', qty: 2, price_unit: 50, tax: 0, analytic_distribution: { [account.id]: 100 } }],
  });
  db = postMove(inv.db, inv.id);
  const lines = () => search(db, 'account.analytic.line').filter((l) => l.move_id === inv.id);
  assert.equal(lines().length, 1);
  assert.equal(lines()[0].amount, 100);
  const reset = models['account.move'].form.buttons.find((b) => b.label === 'Reset to Draft');
  db = reset.run(db, search(db, 'account.move').find((m) => m.id === inv.id)).db;
  assert.equal(lines().length, 0);
});
