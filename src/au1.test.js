import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search } from './orm.js';
import { postMove, payMove } from './models/accounting.js';
import { taxesByGrid, taxesByTax, taxReport } from './models/finance.js';
import { taxSnapshot } from './models/taxes.js';

test('Finding 1 & 8: a 60/40 repartition tax of 20% on 1000 shows base 1000 and tax 200 in taxesByTax and taxReport', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box 01', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const taxTag = create(db, 'account.account.tag', { name: '+Box 21', applicability: 'taxes', tax_negate: false });
  db = taxTag.db;

  const taxAcc1 = create(db, 'account.account', { name: 'VAT 12%', code: '131011', account_type: 'asset_current' });
  db = taxAcc1.db;
  const taxAcc2 = create(db, 'account.account', { name: 'VAT 8%', code: '131012', account_type: 'asset_current' });
  db = taxAcc2.db;

  const tax = create(db, 'account.tax', {
    name: '20% 60/40 Split Tax',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 60, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
      { factor_percent: 40, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 60, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
      { factor_percent: 40, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag.id] },
    ],
  });
  db = tax.db;

  const partner = search(db, 'res.partner')[0];
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2025-01-10',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Expense', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = bill.db;
  db = postMove(db, bill.id);

  // taxesByTax shows base 1000 and tax 200 without duplicate base
  const byTax = taxesByTax(db, { from: '2025-01-01', to: '2025-01-31' });
  const row = byTax.find((t) => t.tax_id === tax.id);
  assert.ok(row, 'tax row must exist in taxesByTax');
  assert.equal(row.base, 1000);
  assert.equal(row.tax, 200);

  // taxReport shows input tax 200
  const rep = taxReport(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(rep.input, 200);
  assert.equal(rep.output, 0);
  assert.equal(rep.payable, -200);

  // taxesByGrid carries base 1000 on base tag and tax 200 on tax tag
  const grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  const box01 = grid.find((r) => r.id === baseTag.id);
  const box21 = grid.find((r) => r.id === taxTag.id);
  assert.ok(box01);
  assert.equal(box01.base, 1000);
  assert.equal(box01.tax, 0);
  assert.ok(box21);
  assert.equal(box21.tax, 200);
});

test('Finding 1 & 8: 60/40 cash basis tax after full payment shows base 1000 and tax 200, and base tag carries 1000 in taxesByGrid', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box 01', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const taxTag = create(db, 'account.account.tag', { name: '+Box 21', applicability: 'taxes', tax_negate: false });
  db = taxTag.db;

  const taxAcc1 = create(db, 'account.account', { name: 'VAT 12%', code: '131011', account_type: 'asset_current' });
  db = taxAcc1.db;
  const taxAcc2 = create(db, 'account.account', { name: 'VAT 8%', code: '131012', account_type: 'asset_current' });
  db = taxAcc2.db;
  const transAcc = create(db, 'account.account', { name: 'VAT Transition', code: '131101', account_type: 'asset_current' });
  db = transAcc.db;

  const tax = create(db, 'account.tax', {
    name: '20% Cash Basis Split',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 60, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
      { factor_percent: 40, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 60, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
      { factor_percent: 40, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag.id] },
    ],
  });
  db = tax.db;

  const partner = search(db, 'res.partner')[0];
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2025-01-10',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Expense CB Full', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = bill.db;
  db = postMove(db, bill.id);

  // Before payment: tax report is 0, grid has no released base or tax
  assert.equal(taxReport(db, { from: '2025-01-01', to: '2025-01-31' }).input, 0);
  const preGrid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(preGrid.find((r) => r.id === baseTag.id), undefined);
  assert.equal(preGrid.find((r) => r.id === taxTag.id)?.tax ?? 0, 0);

  // Full payment (1200)
  db = payMove(db, bill.id, 1200, '2025-01-15');

  // taxesByTax shows base 1000 and tax 200
  const byTax = taxesByTax(db, { from: '2025-01-01', to: '2025-01-31' });
  const row = byTax.find((t) => t.tax_id === tax.id);
  assert.ok(row);
  assert.equal(row.base, 1000);
  assert.equal(row.tax, 200);

  // taxReport shows input 200
  const rep = taxReport(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(rep.input, 200);
  assert.equal(rep.output, 0);

  // taxesByGrid base tag carries 1000 and tax tag carries 200
  const grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  const box01 = grid.find((r) => r.id === baseTag.id);
  const box21 = grid.find((r) => r.id === taxTag.id);
  assert.ok(box01, 'Base tag Box 01 must exist in grid');
  assert.equal(box01.base, 1000);
  assert.equal(box01.tax, 0);
  assert.ok(box21, 'Tax tag Box 21 must exist in grid');
  assert.equal(box21.tax, 200);
  assert.equal(box21.base, 0);
});

test('Finding 1 & 8: 60/40 cash basis tax after two half payments shows base 1000 and tax 200, and refund reverses it', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box 01', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const taxTag = create(db, 'account.account.tag', { name: '+Box 21', applicability: 'taxes', tax_negate: false });
  db = taxTag.db;

  const taxAcc1 = create(db, 'account.account', { name: 'VAT 12%', code: '131011', account_type: 'asset_current' });
  db = taxAcc1.db;
  const taxAcc2 = create(db, 'account.account', { name: 'VAT 8%', code: '131012', account_type: 'asset_current' });
  db = taxAcc2.db;
  const transAcc = create(db, 'account.account', { name: 'VAT Transition', code: '131101', account_type: 'asset_current' });
  db = transAcc.db;

  const tax = create(db, 'account.tax', {
    name: '20% Cash Basis Split Partials',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 60, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
      { factor_percent: 40, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 60, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
      { factor_percent: 40, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag.id] },
    ],
  });
  db = tax.db;

  const partner = search(db, 'res.partner')[0];
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2025-01-10',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Expense CB Half', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = bill.db;
  db = postMove(db, bill.id);

  // First half payment (600)
  db = payMove(db, bill.id, 600, '2025-01-12');
  let grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 500);
  assert.equal(grid.find((r) => r.id === baseTag.id)?.tax, 0);
  assert.equal(grid.find((r) => r.id === taxTag.id)?.tax, 100);

  // Second half payment (600)
  db = payMove(db, bill.id, 600, '2025-01-20');

  // taxesByTax and taxReport after two half payments
  const byTax = taxesByTax(db, { from: '2025-01-01', to: '2025-01-31' });
  const row = byTax.find((t) => t.tax_id === tax.id);
  assert.ok(row);
  assert.equal(row.base, 1000);
  assert.equal(row.tax, 200);

  const rep = taxReport(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(rep.input, 200);

  grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === baseTag.id)?.tax, 0);
  assert.equal(grid.find((r) => r.id === taxTag.id)?.tax, 200);
  assert.equal(grid.find((r) => r.id === taxTag.id)?.base, 0);

  // Refund reverses it
  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: partner.id,
    invoice_date: '2025-01-25',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Expense CB Refund', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = refund.db;
  db = postMove(db, refund.id);
  db = payMove(db, refund.id, 1200, '2025-01-26');

  // After full bill and refund are both paid, net results are reversed to zero
  const netRep = taxReport(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(netRep.input, 0);
  assert.equal(netRep.output, 0);
  assert.equal(netRep.payable, 0);

  const netByTax = taxesByTax(db, { from: '2025-01-01', to: '2025-01-31' });
  const netRow = netByTax.find((t) => t.tax_id === tax.id);
  assert.equal(netRow?.base ?? 0, 0);
  assert.equal(netRow?.tax ?? 0, 0);

  const netGrid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(netGrid.find((r) => r.id === baseTag.id)?.base ?? 0, 0);
  assert.equal(netGrid.find((r) => r.id === taxTag.id)?.tax ?? 0, 0);
});

test('Finding 1 & 8: 60/40 cash basis sale tax after full payment and two half payments, reversed by credit note', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box 01', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const taxTag = create(db, 'account.account.tag', { name: '+Box 21', applicability: 'taxes', tax_negate: false });
  db = taxTag.db;

  const taxAcc1 = create(db, 'account.account', { name: 'VAT Sale 12%', code: '231011', account_type: 'liability_current' });
  db = taxAcc1.db;
  const taxAcc2 = create(db, 'account.account', { name: 'VAT Sale 8%', code: '231012', account_type: 'liability_current' });
  db = taxAcc2.db;
  const transAcc = create(db, 'account.account', { name: 'VAT Sale Transition', code: '231101', account_type: 'liability_current' });
  db = transAcc.db;

  const tax = create(db, 'account.tax', {
    name: '20% Sale Cash Basis Split',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'sale',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 60, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
      { factor_percent: 40, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 60, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
      { factor_percent: 40, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag.id] },
    ],
  });
  db = tax.db;

  const partner = search(db, 'res.partner')[0];
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2025-01-10',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Service CB', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = invoice.db;
  db = postMove(db, invoice.id);

  // Before payment: 0 tax reported
  assert.equal(taxReport(db, { from: '2025-01-01', to: '2025-01-31' }).output, 0);

  // Two half payments: 600 and 600
  db = payMove(db, invoice.id, 600, '2025-01-15');
  let grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 500);
  assert.equal(grid.find((r) => r.id === taxTag.id)?.tax, 100);

  db = payMove(db, invoice.id, 600, '2025-01-20');

  // After full payment across two halves:
  const byTax = taxesByTax(db, { from: '2025-01-01', to: '2025-01-31' });
  const row = byTax.find((t) => t.tax_id === tax.id);
  assert.ok(row);
  assert.equal(row.side, 'sale');
  assert.equal(row.base, 1000);
  assert.equal(row.tax, 200);

  const rep = taxReport(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(rep.output, 200);
  assert.equal(rep.input, 0);
  assert.equal(rep.payable, 200);

  grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === taxTag.id)?.tax, 200);

  // Credit note reverses it
  const creditNote = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: partner.id,
    invoice_date: '2025-01-25',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Service CB Refund', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = creditNote.db;
  db = postMove(db, creditNote.id);
  db = payMove(db, creditNote.id, 1200, '2025-01-26');

  // Net reversed to zero
  const netRep = taxReport(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(netRep.output, 0);
  assert.equal(netRep.input, 0);
  assert.equal(netRep.payable, 0);

  const netByTax = taxesByTax(db, { from: '2025-01-01', to: '2025-01-31' });
  const netRow = netByTax.find((t) => t.tax_id === tax.id);
  assert.equal(netRow?.base ?? 0, 0);
  assert.equal(netRow?.tax ?? 0, 0);

  const netGrid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(netGrid.find((r) => r.id === baseTag.id)?.base ?? 0, 0);
  assert.equal(netGrid.find((r) => r.id === taxTag.id)?.tax ?? 0, 0);
});
