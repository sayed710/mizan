import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { amounts } from './models/common.js';
import { postMove, payMove } from './models/accounting.js';
import { taxSnapshot, fiscalPositionFor } from './models/taxes.js';

test('excluded base-affecting tax participates in included tax solver', () => {
  const line = { qty: 1, price_unit: 100, tax_breakdown: [
    { tax_id: 1, tax: 10, tax_include_base_amount: true },
    { tax_id: 2, tax: 10, tax_include: true },
  ] };
  const result = amounts([line]);
  assert.equal(result.untaxed, 90.09);
  assert.equal(result.tax, 18.92);
  assert.equal(result.total, 109.01);
});

test('payment releases only cash-basis components of a mixed tax line', () => {
  const base = seed();
  const taxes = search(base, 'account.tax');
  const cash = taxes.find((t) => t.name === 'VAT 14% (Cash Basis)');
  const invoice = taxes.find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const made = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax_breakdown: [taxSnapshot(cash), taxSnapshot(invoice)] }] });
  const posted = postMove(made.db, made.id);
  const paid = payMove(posted, made.id, 128, '2026-03-10');
  const releases = search(paid, 'account.move').filter((m) => !search(posted, 'account.move').some((old) => old.id === m.id));
  const releaseLines = releases.flatMap((m) => m.line_ids ?? []).filter((l) => l.tax_name === invoice.name);
  assert.equal(releaseLines.length, 0);
  assert.ok(read(paid, 'account.move', made.id));
});

test('invoice product selection uses purchase defaults on bills and refunds', () => {
  let db = seed();
  const sale = create(db, 'account.tax', { name: 'Sale 20', amount: 20, type_tax_use: 'sale' });
  const purchase = create(sale.db, 'account.tax', { name: 'Purchase 5', amount: 5, type_tax_use: 'purchase' });
  db = write(purchase.db, 'product', 1, { list_price: 100, cost: 60, tax_id: sale.id, supplier_tax_id: purchase.id });
  const field = models['account.move'].fields.invoice_line_ids;
  for (const move_type of ['in_invoice', 'in_refund']) {
    const line = field.onchange({ product_id: 1, qty: 1 }, 'product_id', db, { move_type });
    assert.equal(line.price_unit, 60);
    assert.equal(line.tax_id, purchase.id);
  }
  assert.equal(field.onchange({ product_id: 1, qty: 1 }, 'product_id', db, { move_type: 'out_invoice' }).tax_id, sale.id);
});

test('changing fiscal position updates existing product tax while preserving entered price', () => {
  const db = seed();
  const fp = search(db, 'account.fiscal.position').find((p) => p.name === 'Export');
  const field = models['account.move'].fields.invoice_line_ids;
  const original = field.onchange({ product_id: 1, qty: 1 }, 'product_id', db, { move_type: 'out_invoice' });
  const move = { move_type: 'out_invoice', fiscal_position_id: fp.id, invoice_line_ids: [{ ...original, price_unit: 37 }] };
  const changed = models['account.move'].onchange(move, 'fiscal_position_id', db).invoice_line_ids[0];
  assert.equal(changed.tax, 0);
  assert.equal(changed.price_unit, 37);
});

test('fiscal position maps the existing line account when the draft is posted', () => {
  let db = seed();
  const source = create(db, 'account.account', { name: 'Original income', code: '499101', account_type: 'income' });
  const destination = create(source.db, 'account.account', { name: 'Mapped income', code: '499102', account_type: 'income' });
  const position = create(destination.db, 'account.fiscal.position', { name: 'Account mapping', account_ids: [{ account_src_id: source.id, account_dest_id: destination.id }] });
  const move = { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', fiscal_position_id: position.id, invoice_line_ids: [{ qty: 1, price_unit: 100, account_id: source.id }] };
  const changed = models['account.move'].onchange(move, 'fiscal_position_id', position.db);
  assert.equal(changed.invoice_line_ids[0].account_id, source.id);
  const draft = create(position.db, 'account.move', { ...move, ...changed });
  db = postMove(draft.db, draft.id);
  assert.ok(read(db, 'account.move', draft.id).line_ids.some((line) => line.account_id === destination.id && line.credit === 100));
});

test('automatic fiscal positions use sequence before record order', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Ambiguous', country: 'Exampleland' });
  db = create(partner.db, 'account.fiscal.position', { name: 'One', sequence: 20, auto_apply: true, country: 'Exampleland' }).db;
  const second = create(db, 'account.fiscal.position', { name: 'Two', sequence: 5, auto_apply: true, country: 'Exampleland' });
  assert.equal(fiscalPositionFor(second.db, partner.id), second.id);
});
