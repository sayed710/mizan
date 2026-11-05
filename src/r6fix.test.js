import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { postMove, payMove } from './models/accounting.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { accountId } from './models/ledger.js';
import * as finance from './models/finance.js';
import { importStatement } from './models/statements.js';

test('tax grids follow posted base and tax items including refunds', () => {
  let db = seed();
  const tag = create(db, 'account.account.tag', { name: 'Grid A', applicability: 'taxes' });
  const tax = create(tag.db, 'account.tax', { name: 'Grid tax', amount: 10, type_tax_use: 'sale', ...defaultTaxRepartitionLines(accountId(db, '251000'), [tag.id]) });
  db = tax.db;
  for (const [move_type, price_unit] of [['out_invoice', 100], ['out_refund', 20]]) {
    const move = create(db, 'account.move', { move_type, partner_id: 2, invoice_date: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit, ...taxSnapshot(read(db, 'account.tax', tax.id)) }] });
    db = postMove(move.db, move.id);
    assert.equal(read(db, 'account.move', move.id).line_ids.filter((l) => l.tax_tag_ids?.includes(tag.id)).length, 2);
  }
  assert.deepEqual(finance.taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' }).find((r) => r.id === tag.id), { id: tag.id, name: 'Grid A', base: 80, tax: 8 });
});

test('credit limit warns while sale confirmation and invoice posting succeed', () => {
  let db = write(seed(), 'res.partner', 2, { credit_limit: 50 });
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit: 60, tax: 0 }] });
  assert.match(models['account.move'].form.warning(read(inv.db, 'account.move', inv.id), inv.db), /credit limit/i);
  db = postMove(inv.db, inv.id);
  const sale = create(db, 'sale.order', { partner_id: 2, order_line: [{ name: 'Service', qty: 1, price_unit: 10, tax: 0 }] });
  assert.match(models['sale.order'].form.warning(read(sale.db, 'sale.order', sale.id), sale.db), /credit limit/i);
  db = models['sale.order'].form.buttons.find((b) => b.label === 'Confirm').run(sale.db, read(sale.db, 'sale.order', sale.id)).db;
  assert.equal(read(db, 'sale.order', sale.id).state, 'sale');
});

test('statement import deduplicates within the bank journal and company', () => {
  const db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const other = create(db, 'account.journal', { name: 'Other bank', code: 'BNK2', type: 'bank', company_id: 1 });
  const file = '<OFX><BANKTRANLIST><STMTTRN><DTPOSTED>20250101<TRNAMT>100<FITID>123<NAME>Deposit</STMTTRN></BANKTRANLIST></OFX>';
  const first = importStatement(other.db, 'a.ofx', file, { journal_id: bank.id });
  const repeat = importStatement(first.db, 'a.ofx', file, { journal_id: bank.id });
  const second = importStatement(repeat.db, 'b.ofx', file, { journal_id: other.id });
  assert.deepEqual([first.count, repeat.count, second.count], [1, 0, 1]);
});



test('cash basis grids report the paid share in the payment period', () => {
  const tag = create(seed(), 'account.account.tag', { name: 'Cash grid', applicability: 'taxes' });
  const tax = create(tag.db, 'account.tax', { name: 'Cash grid VAT', amount: 10, type_tax_use: 'sale', tax_exigibility: 'on_payment', cash_basis_transition_account_id: accountId(tag.db, '251100'), ...defaultTaxRepartitionLines(accountId(tag.db, '251000'), [tag.id]) });
  const move = create(tax.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
  let db = postMove(move.db, move.id);
  db = payMove(db, move.id, 55, '2025-02-01');
  assert.deepEqual(finance.taxesByGrid(db, { from: '2025-02-01', to: '2025-02-28' }).find((r) => r.id === tag.id), { id: tag.id, name: 'Cash grid', base: 50, tax: 5 });
});

test('distinct grids on same named taxes keep their separate bases', () => {
  const a = create(seed(), 'account.account.tag', { name: 'A', applicability: 'taxes' });
  const b = create(a.db, 'account.account.tag', { name: 'B', applicability: 'taxes' });
  const ta = create(b.db, 'account.tax', { name: 'Same VAT', amount: 10, type_tax_use: 'sale', ...defaultTaxRepartitionLines(accountId(b.db, '251000'), [a.id]) });
  const tb = create(ta.db, 'account.tax', { name: 'Same VAT', amount: 10, type_tax_use: 'sale', ...defaultTaxRepartitionLines(accountId(ta.db, '251000'), [b.id]) });
  const move = create(tb.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: '2025-01-01', invoice_line_ids: [
    { qty: 1, price_unit: 100, ...taxSnapshot(read(tb.db, 'account.tax', ta.id)) },
    { qty: 1, price_unit: 200, ...taxSnapshot(read(tb.db, 'account.tax', tb.id)) },
  ] });
  const db = postMove(move.db, move.id);
  const rows = finance.taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.deepEqual(rows.find((r) => r.id === a.id), { id: a.id, name: 'A', base: 100, tax: 10 });
  assert.deepEqual(rows.find((r) => r.id === b.id), { id: b.id, name: 'B', base: 200, tax: 20 });
});
