import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { autoReconcile } from './models/reconcile.js';

const LINE = 'account.bank.statement.line';
const run = (db, id, label) => models[LINE].form.buttons.find((button) => button.label === label).run(db, read(db, LINE, id)).db;
const invoice = (db, partner) => {
  const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: partner, date: '2030-01-01', invoice_date: '2030-01-01', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 123, tax: 0 }] });
  return { db: postMove(made.db, made.id), id: made.id };
};

test('manual matching rejects an invoice belonging to another commercial partner', () => {
  const a = create(seed(), 'res.partner', { name: 'Customer A', is_company: true });
  const b = create(a.db, 'res.partner', { name: 'Customer B', is_company: true });
  const inv = invoice(b.db, b.id);
  const line = create(inv.db, LINE, { date: '2030-01-05', payment_ref: 'Transfer', amount: 123, partner_id: a.id, move_id: inv.id });
  assert.throws(() => run(line.db, line.id, 'Match'), /partner/i);
  assert.equal(read(line.db, 'account.move', inv.id).amount_residual, 123);
  assert.equal(read(line.db, LINE, line.id).state, 'to_check');
});

test('automatic invoice rules leave equally matching invoices for review', () => {
  const partner = create(seed(), 'res.partner', { name: 'Customer', is_company: true });
  const first = invoice(partner.db, partner.id);
  const second = invoice(first.db, partner.id);
  const rule = create(second.db, 'account.reconcile.model', { name: 'Invoice rule', rule_type: 'invoice_matching', active: true, auto_reconcile: true, match_label: 'contains', match_label_param: 'unique transfer', line_ids: [] });
  const line = create(rule.db, LINE, { date: '2030-01-05', payment_ref: 'unique transfer', amount: 123, partner_id: partner.id });
  const after = autoReconcile(line.db);
  assert.equal(read(after, LINE, line.id).state, 'to_check');
  assert.equal(read(after, 'account.move', first.id).amount_residual, 123);
  assert.equal(read(after, 'account.move', second.id).amount_residual, 123);
});
