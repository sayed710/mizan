import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { withCompany } from './models/company.js';
import { cleanRecord } from './validate.js';
import { seed } from './seed.js';

const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);
const press = (db, model, id, label) => button(model, label).run(db, read(db, model, id));

test('the company guard wrapper passes the admin flag through to the model guard', () => {
  let seen;
  const wrapped = withCompany({ 'crm.lead': { fields: {}, guard: (db, before, r, opts) => { seen = opts; return null; } } });
  wrapped['crm.lead'].guard(seed(), null, { id: 1 }, { isAdmin: true });
  assert.deepEqual(seen, { isAdmin: true });
});

test('invoice lines keep a valid analytic distribution and reject malformed ones', () => {
  const line = { product_id: 1, qty: 1, price_unit: 10, analytic_distribution: { 3: 60, 4: 40 } };
  assert.deepEqual(cleanRecord('account.move', { id: 1, invoice_line_ids: [line] }).invoice_line_ids[0].analytic_distribution, { 3: 60, 4: 40 });
  for (const bad of [{ x: 10 }, { 3: 120 }, { 3: '50' }, [3]]) {
    assert.throws(() => cleanRecord('account.move', { id: 1, invoice_line_ids: [{ ...line, analytic_distribution: bad }] }), /Invalid value/);
  }
});

test('reset to draft drops the posted journal items, and posting again rebuilds them', () => {
  const made = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = press(made.db, 'account.move', made.id, 'Confirm').db;
  assert.ok(read(posted, 'account.move', made.id).line_ids.length > 0);
  const draft = press(posted, 'account.move', made.id, 'Reset to Draft').db;
  assert.deepEqual(read(draft, 'account.move', made.id).line_ids, []);
  const reposted = read(press(draft, 'account.move', made.id, 'Confirm').db, 'account.move', made.id);
  assert.equal(reposted.line_ids.reduce((s, l) => s + (l.debit ?? 0), 0), reposted.line_ids.reduce((s, l) => s + (l.credit ?? 0), 0));
});

test('an invoice created from a sales order keeps the order currency', () => {
  const eur = create(seed(), 'res.currency', { name: 'EUR', symbol: '€', rate: 1 });
  const order = create(eur.db, 'sale.order', { partner_id: 2, currency_id: eur.id, order_line: [{ product_id: 1, qty: 1, price_unit: 10 }] });
  const confirmed = press(order.db, 'sale.order', order.id, 'Confirm').db;
  const invoiced = press(confirmed, 'sale.order', order.id, 'Create Invoice').db;
  const move = invoiced.records['account.move'].find((m) => m.invoice_origin === read(invoiced, 'sale.order', order.id).name);
  assert.equal(move.currency_id, eur.id);
});
