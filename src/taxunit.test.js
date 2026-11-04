import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { ensureReturnTypes } from './models/taxreturn.js';
import { taxReport, taxesByTax } from './models/finance.js';

test('tax unit return reviews and closes each company once', () => {
  let db = seed();
  const company = createCompanyWithDefaultInvoiceJournals(db, { name: 'Subsidiary' });
  db = company.db;
  const unit = create(db, 'account.tax.unit', { name: 'Unit', company_ids: [1, company.id], main_company_id: 1 });
  db = unit.db;
  const field = models['account.return'].fields.tax_unit_id;
  assert.ok(field);
  assert.ok(field.domain(read(db, 'account.tax.unit', unit.id), { company_id: 1 }));
  assert.ok(!field.domain(read(db, 'account.tax.unit', unit.id), { company_id: 999 }));
  const tax = search(db, 'account.tax').find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  for (const [company_id, price_unit] of [[1, 100], [company.id, 200]]) {
    const invoice = create(db, 'account.move', { company_id, move_type: 'out_invoice', partner_id: 2, invoice_date: '2040-01-10', invoice_line_ids: [{ qty: 1, price_unit, ...taxSnapshot(tax) }] });
    db = postMove(invoice.db, invoice.id);
  }
  db = ensureReturnTypes(db);
  const type = search(db, 'account.return.type').find((t) => t.company_id === 1 && t.name === 'VAT Return');
  const memberType = search(db, 'account.return.type').find((t) => t.company_id === company.id && t.name === 'VAT Return');
  db = write(db, 'account.tax.unit', unit.id, { member_return_type_ids: [{ company_id: company.id, type_id: memberType.id }] });
  const ret = create(db, 'account.return', { name: 'Unit return', type_id: type.id, company_id: 1, tax_unit_id: unit.id, date_from: '2040-01-01', date_to: '2040-01-31' });
  db = ret.db;
  assert.deepEqual(taxReport(db, { from: '2040-01-01', to: '2040-01-31', company_id: 1, tax_unit_id: unit.id }), { output: 42, input: 0, payable: 42 });
  assert.equal(taxesByTax(db, { from: '2040-01-01', to: '2040-01-31', company_id: 1, tax_unit_id: unit.id }).reduce((sum, row) => sum + row.tax, 0), 42);
  assert.throws(() => write(db, 'account.return', ret.id, { company_id: 999 }), /Tax unit/);
  const action = (label) => models['account.return'].form.buttons.find((button) => button.label === label).run(db, read(db, 'account.return', ret.id)).db;
  db = action('Review');
  assert.equal(read(db, 'account.return', ret.id).total_amount_to_pay, 42);
  db = action('Submit');
  const result = read(db, 'account.return', ret.id);
  assert.equal(result.total_amount_to_pay, 42);
  const moves = result.closing_move_ids.map((id) => read(db, 'account.move', id));
  assert.deepEqual(moves.map((move) => move.company_id).sort(), [1, company.id].sort());
  for (const [companyId, amount] of [[1, 14], [company.id, 28]]) {
    const move = moves.find((m) => m.company_id === companyId);
    assert.equal(move.state, 'posted');
    assert.equal(move.line_ids.reduce((sum, line) => sum + line.debit, 0), amount);
    assert.equal(db.settings.tax_lock_dates[companyId], '2040-01-31');
  }
  assert.throws(() => write(db, 'account.tax.unit', unit.id, { company_ids: [1, 999] }), /Cannot change companies/);
  db = action('Reset to Draft');
  assert.equal(db.settings.tax_lock_dates[1], null);
  assert.equal(db.settings.tax_lock_dates[company.id], null);
  assert.ok(moves.every((move) => read(db, 'account.move', move.id).state === 'cancel'));
});

test('return type picker offers audit types to working files and tax types to tax returns', async () => {
  const { models } = await import('./models/index.js');
  const { seed } = await import('./seed.js');
  const { search } = await import('./orm.js');
  const db = seed();
  const domain = models['account.return'].fields.type_id.domain;
  const types = search(db, 'account.return.type').filter((t) => (t.company_id ?? 1) === 1);
  const working = types.filter((t) => domain(t, { company_id: 1, audit_status: 'ongoing' }));
  const tax = types.filter((t) => domain(t, { company_id: 1, audit_status: null }));
  assert.ok(tax.length > 0, 'tax returns have tax types to pick');
  assert.ok(working.every((t) => t.category === 'audit'));
  assert.ok(tax.every((t) => t.category !== 'audit'));
});
