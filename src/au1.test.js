import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { postMove, payMove } from './models/accounting.js';
import { postEntry } from './models/ledger.js';
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

test('Finding 1: two cash-basis taxes sharing a base tag show base once in taxesByGrid after partial and final payment', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box 01', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const taxTag1 = create(db, 'account.account.tag', { name: '+Box 21', applicability: 'taxes', tax_negate: false });
  db = taxTag1.db;
  const taxTag2 = create(db, 'account.account.tag', { name: '+Box 22', applicability: 'taxes', tax_negate: false });
  db = taxTag2.db;

  const taxAcc1 = create(db, 'account.account', { name: 'VAT 10%', code: '131031', account_type: 'asset_current' });
  db = taxAcc1.db;
  const taxAcc2 = create(db, 'account.account', { name: 'VAT 5%', code: '131032', account_type: 'asset_current' });
  db = taxAcc2.db;
  const transAcc1 = create(db, 'account.account', { name: 'VAT Transition 1', code: '131131', account_type: 'asset_current' });
  db = transAcc1.db;
  const transAcc2 = create(db, 'account.account', { name: 'VAT Transition 2', code: '131132', account_type: 'asset_current' });
  db = transAcc2.db;

  const tax1 = create(db, 'account.tax', {
    name: '10% Cash Basis 1',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc1.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag1.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag1.id] },
    ],
  });
  db = tax1.db;

  const tax2 = create(db, 'account.tax', {
    name: '5% Cash Basis 2',
    amount: 5,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc2.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag2.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag2.id] },
    ],
  });
  db = tax2.db;

  const partner = search(db, 'res.partner')[0];
  const snap1 = taxSnapshot(read(db, 'account.tax', tax1.id));
  const snap2 = taxSnapshot(read(db, 'account.tax', tax2.id));
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2025-01-10',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Shared CB Line', qty: 1, price_unit: 1000, tax_breakdown: [snap1, snap2] },
    ],
  });
  db = bill.db;
  db = postMove(db, bill.id);

  // Partial payment: 575 (50% of 1150)
  db = payMove(db, bill.id, 575, '2025-01-15');
  let grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 500);
  assert.equal(grid.find((r) => r.id === taxTag1.id)?.tax, 50);
  assert.equal(grid.find((r) => r.id === taxTag2.id)?.tax, 25);

  // Final payment: remaining 575 (50%)
  db = payMove(db, bill.id, 575, '2025-01-20');
  grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  // The shared base tag must show 1000, not 2000!
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === taxTag1.id)?.tax, 100);
  assert.equal(grid.find((r) => r.id === taxTag2.id)?.tax, 50);
});

test('Finding 1: accrual tax and cash-basis tax sharing a base tag show base once in taxesByGrid', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box 01', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const taxTag1 = create(db, 'account.account.tag', { name: '+Box 21', applicability: 'taxes', tax_negate: false });
  db = taxTag1.db;
  const taxTag2 = create(db, 'account.account.tag', { name: '+Box 22', applicability: 'taxes', tax_negate: false });
  db = taxTag2.db;

  const taxAcc1 = create(db, 'account.account', { name: 'VAT Accrual 10%', code: '131041', account_type: 'asset_current' });
  db = taxAcc1.db;
  const taxAcc2 = create(db, 'account.account', { name: 'VAT CB 5%', code: '131042', account_type: 'asset_current' });
  db = taxAcc2.db;
  const transAcc2 = create(db, 'account.account', { name: 'VAT Transition CB', code: '131142', account_type: 'asset_current' });
  db = transAcc2.db;

  // Accrual tax
  const tax1 = create(db, 'account.tax', {
    name: '10% Accrual',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag1.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag1.id] },
    ],
  });
  db = tax1.db;

  // Cash basis tax sharing baseTag
  const tax2 = create(db, 'account.tax', {
    name: '5% Cash Basis',
    amount: 5,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc2.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag2.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc2.id, tag_ids: [taxTag2.id] },
    ],
  });
  db = tax2.db;

  const partner = search(db, 'res.partner')[0];
  const snap1 = taxSnapshot(read(db, 'account.tax', tax1.id));
  const snap2 = taxSnapshot(read(db, 'account.tax', tax2.id));
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2025-01-10',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Mixed Accrual and CB Line', qty: 1, price_unit: 1000, tax_breakdown: [snap1, snap2] },
    ],
  });
  db = bill.db;
  db = postMove(db, bill.id);

  // On invoice post: accrual tax already emitted base 1000 for baseTag
  let grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === taxTag1.id)?.tax, 100);
  assert.equal(grid.find((r) => r.id === taxTag2.id)?.tax ?? 0, 0);

  // Partial payment: 575
  db = payMove(db, bill.id, 575, '2025-01-15');
  grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  // Base must NOT be duplicated to 1500!
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === taxTag1.id)?.tax, 100);
  assert.equal(grid.find((r) => r.id === taxTag2.id)?.tax, 25);

  // Final payment: 575
  db = payMove(db, bill.id, 575, '2025-01-20');
  grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  // Base must NOT be duplicated to 2000!
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === taxTag1.id)?.tax, 100);
  assert.equal(grid.find((r) => r.id === taxTag2.id)?.tax, 50);
});

test('Finding 3: cash-basis tax where tax row has no account and shares base row tags does not omit base in final payment', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box 01', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const transAcc = create(db, 'account.account', { name: 'VAT Transition F3', code: '131151', account_type: 'asset_current' });
  db = transAcc.db;

  // Tax row has no account_id (account_id: null) and its tags match base row!
  const tax = create(db, 'account.tax', {
    name: '10% Cash Basis Shared Line Account',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: null, tag_ids: [baseTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: null, tag_ids: [baseTag.id] },
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
      { name: 'Expense F3', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = bill.db;
  db = postMove(db, bill.id);

  // Partial 50% payment (550 of 1100)
  db = payMove(db, bill.id, 550, '2025-01-12');
  let grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 500);
  assert.equal(grid.find((r) => r.id === baseTag.id)?.tax, 50);

  // Final 50% payment (remaining 550)
  db = payMove(db, bill.id, 550, '2025-01-20');
  grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  // Prior bug subtracted 100 from 100 leaving grid at 50; fixed grid shows full 1000 base and 100 tax!
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === baseTag.id)?.tax, 100);
});

test('Finding 4: zero-share tax repartition row does not carry the base or post a zero-tax line', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box Base', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const zeroTag = create(db, 'account.account.tag', { name: '+Box ZeroShare', applicability: 'taxes', tax_negate: false });
  db = zeroTag.db;
  const taxTag = create(db, 'account.account.tag', { name: '+Box ActiveShare', applicability: 'taxes', tax_negate: false });
  db = taxTag.db;

  const taxAcc0 = create(db, 'account.account', { name: 'VAT Zero Account', code: '131061', account_type: 'asset_current' });
  db = taxAcc0.db;
  const taxAcc1 = create(db, 'account.account', { name: 'VAT 20% Active Account', code: '131062', account_type: 'asset_current' });
  db = taxAcc1.db;

  const tax = create(db, 'account.tax', {
    name: '20% Tax with 0% First Row',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 0, repartition_type: 'tax', account_id: taxAcc0.id, tag_ids: [zeroTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 0, repartition_type: 'tax', account_id: taxAcc0.id, tag_ids: [zeroTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc1.id, tag_ids: [taxTag.id] },
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
      { name: 'Expense F4', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = bill.db;
  db = postMove(db, bill.id);

  const posted = read(db, 'account.move', bill.id);
  // Row 0 has 0 factor, so it must not produce a journal line on taxAcc0
  assert.equal(posted.line_ids.some((l) => l.account_id === taxAcc0.id), false);
  // Active row on taxAcc1 carries the tax and the base
  const activeLine = posted.line_ids.find((l) => l.account_id === taxAcc1.id);
  assert.ok(activeLine, 'Active tax line must exist on taxAcc1');
  assert.equal(activeLine.debit, 200);
  assert.equal(activeLine.tax_base, 1000);

  // taxesByTax shows base 1000 and tax 200 once
  const byTax = taxesByTax(db, { from: '2025-01-01', to: '2025-01-31' });
  const row = byTax.find((t) => t.tax_id === tax.id);
  assert.ok(row);
  assert.equal(row.base, 1000);
  assert.equal(row.tax, 200);

  // taxesByGrid
  const grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === taxTag.id)?.tax, 200);
  assert.equal(grid.find((r) => r.id === zeroTag.id), undefined);
});

test('Finding 5: paying cash-basis invoice with base tags succeeds under mandatory analytic plan', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', { name: 'Projects', default_applicability: 'mandatory' });
  db = plan.db;
  const analyticAcc = create(db, 'account.analytic.account', { name: 'Alpha', plan_id: plan.id });
  db = analyticAcc.db;

  const baseTag = create(db, 'account.account.tag', { name: '+Box 01', applicability: 'taxes', tax_negate: false });
  db = baseTag.db;
  const taxTag = create(db, 'account.account.tag', { name: '+Box 21', applicability: 'taxes', tax_negate: false });
  db = taxTag.db;

  const taxAcc = create(db, 'account.account', { name: 'VAT 20%', code: '131071', account_type: 'asset_current' });
  db = taxAcc.db;
  const transAcc = create(db, 'account.account', { name: 'VAT Transition F5', code: '131171', account_type: 'asset_current' });
  db = transAcc.db;

  const tax = create(db, 'account.tax', {
    name: '20% Cash Basis Analytic',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc.id, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc.id, tag_ids: [taxTag.id] },
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
      { name: 'Expense with Analytic', qty: 1, price_unit: 1000, analytic_distribution: { [analyticAcc.id]: 100 }, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = bill.db;
  db = postMove(db, bill.id);

  // Payment must not fail on mandatory plan check for zero-amount base lines
  assert.doesNotThrow(() => {
    db = payMove(db, bill.id, 1200, '2025-01-15');
  });

  const grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(grid.find((r) => r.id === baseTag.id)?.base, 1000);
  assert.equal(grid.find((r) => r.id === taxTag.id)?.tax, 200);
});

test('Finding 6: legacy cash-basis release move without base lines still contributes base to taxesByGrid', () => {
  let db = seed();
  const tag = create(db, 'account.account.tag', { name: '+Legacy Box', applicability: 'taxes', tax_negate: false });
  db = tag.db;
  const taxAcc = create(db, 'account.account', { name: 'VAT Legacy', code: '131081', account_type: 'asset_current' });
  db = taxAcc.db;

  const partner = search(db, 'res.partner')[0];
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2025-01-10',
    company_id: 1,
    invoice_line_ids: [
      { name: 'Expense Legacy', qty: 1, price_unit: 1000, tax: 0 },
    ],
  });
  db = postMove(bill.db, bill.id);
  const invoice = read(db, 'account.move', bill.id);

  // A legacy cash basis release has cash_basis_origin_move_id and tax_grid_release lines, but NO tax_grid_base lines
  const legacyRelease = postEntry(db, {
    journal: 'MISC',
    date: '2025-01-15',
    ref: `Cash basis taxes ${invoice.name}`,
    company: 1,
    lines: [
      {
        account_id: taxAcc.id,
        partner_id: partner.id,
        name: 'Legacy VAT',
        tax_name: 'Legacy VAT',
        debit: 200,
        credit: 0,
        tax_base: 1000,
        tax_side: 'purchase',
        tax_tag_ids: [tag.id],
        tax_grid_release: true,
      },
      {
        account_id: 1,
        partner_id: partner.id,
        name: 'Transition Counterpart',
        debit: 0,
        credit: 200,
      },
    ],
  });
  db = write(legacyRelease.db, 'account.move', legacyRelease.id, { cash_basis_origin_move_id: invoice.id });

  const grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  const row = grid.find((r) => r.id === tag.id);
  assert.ok(row, 'Legacy tag row must exist in grid');
  assert.equal(row.base, 1000);
  assert.equal(row.tax, 200);
});

test('final cash-basis payment after legacy partial release sharing base and tax tag counts invoice base once', () => {
  let db = seed();
  const sharedTag = create(db, 'account.account.tag', { name: '+Shared Box', applicability: 'taxes', tax_negate: false });
  db = sharedTag.db;
  const taxAcc = create(db, 'account.account', { name: 'VAT Shared CB', code: '131082', account_type: 'asset_current' });
  db = taxAcc.db;
  const transAcc = create(db, 'account.account', { name: 'VAT Shared Transition', code: '131182', account_type: 'asset_current' });
  db = transAcc.db;

  const tax = create(db, 'account.tax', {
    name: '20% Shared Tag CB',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [sharedTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc.id, tag_ids: [sharedTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [sharedTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc.id, tag_ids: [sharedTag.id] },
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
      { name: 'Expense Shared CB', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) },
    ],
  });
  db = postMove(bill.db, bill.id);
  const invoice = read(db, 'account.move', bill.id);

  // Partial payment (600 of 1200 = 50%) released in legacy form without tax_grid_base lines
  const pmtEntry = postEntry(db, {
    journal: 'BNK1',
    date: '2025-01-15',
    ref: `Payment ${invoice.name}`,
    company: 1,
    lines: [
      { account: '211000', debit: 600, partner_id: partner.id },
      { account: '101401', credit: 600, partner_id: partner.id },
    ],
  });
  db = pmtEntry.db;
  const legacyRelease = postEntry(db, {
    journal: 'MISC',
    date: '2025-01-15',
    ref: `Cash basis taxes ${invoice.name}`,
    company: 1,
    lines: [
      {
        account_id: taxAcc.id,
        partner_id: partner.id,
        tax_id: tax.id,
        name: '20% Shared Tag CB',
        tax_name: '20% Shared Tag CB',
        debit: 100,
        credit: 0,
        tax_base: 500,
        tax_side: 'purchase',
        tax_tag_ids: [sharedTag.id],
        tax_grid_release: true,
      },
      {
        account_id: transAcc.id,
        partner_id: partner.id,
        name: 'Transition Counterpart',
        debit: 0,
        credit: 100,
      },
    ],
  });
  db = write(legacyRelease.db, 'account.move', legacyRelease.id, { cash_basis_origin_move_id: invoice.id });
  db = write(db, 'account.move', invoice.id, {
    amount_paid: 600,
    payment_date: '2025-01-15',
    payments: [{ date: '2025-01-15', amount: 600, company_amount: 600, move_id: pmtEntry.id }],
  });

  // Final payment (remaining 600) with current code
  db = payMove(db, invoice.id, 600, '2025-01-20');

  const grid = taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' });
  const row = grid.find((r) => r.id === sharedTag.id);
  assert.ok(row);
  assert.equal(row.base, 1000);
  assert.equal(row.tax, 200);
});

test('cash-basis release without base tags marks cash_basis_base_grid without a fake zero base line and stays non-legacy on reversal', async () => {
  const { models } = await import('./models/index.js');
  let db = seed();
  const taxTag = create(db, 'account.account.tag', { name: '+Tax Only CB', applicability: 'taxes', tax_negate: false });
  db = taxTag.db;
  const taxAcc = create(db, 'account.account', { name: 'VAT Tax Only CB', code: '131083', account_type: 'asset_current' });
  db = taxAcc.db;
  const transAcc = create(db, 'account.account', { name: 'VAT Tax Only Transition', code: '131183', account_type: 'asset_current' });
  db = transAcc.db;
  const tax = create(db, 'account.tax', {
    name: '20% Tax Only CB',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc.id, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [] },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc.id, tag_ids: [taxTag.id] },
    ],
  });
  db = tax.db;

  const partner = search(db, 'res.partner')[0];
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2025-01-10',
    company_id: 1,
    invoice_line_ids: [{ name: 'Tax Only CB', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) }],
  });
  db = postMove(bill.db, bill.id);

  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const payment = create(db, 'account.payment', {
    partner_id: partner.id, invoice_id: bill.id, journal_id: bank.id, amount: 1200, date: '2025-01-15',
    partner_type: 'supplier', payment_type: 'outbound',
  });
  db = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm').run(payment.db, read(payment.db, 'account.payment', payment.id)).db;

  const { isLegacyCashBasisRelease } = await import('./models/accounting.js');
  const releaseId = read(db, 'account.move', bill.id).payments.at(-1).cash_basis_move_id;
  const releaseMove = read(db, 'account.move', releaseId);
  assert.equal(releaseMove.cash_basis_base_grid, true);
  assert.equal(releaseMove.line_ids.some((l) => l.tax_grid_base), false);
  assert.equal(isLegacyCashBasisRelease(releaseMove), false);

  let row = taxesByGrid(db).find((r) => r.id === taxTag.id);
  assert.deepEqual(row, { id: taxTag.id, name: '+Tax Only CB', base: 0, tax: 200 });

  db = models['account.payment'].form.buttons.find((b) => b.label === 'Reverse').run(db, read(db, 'account.payment', payment.id)).db;
  const reversal = search(db, 'account.move').find((m) => m.reversed_entry_id === releaseId);
  assert.equal(reversal.cash_basis_base_grid, true);
  assert.equal(isLegacyCashBasisRelease(reversal), false);
  row = taxesByGrid(db).find((r) => r.id === taxTag.id);
  assert.deepEqual(row, { id: taxTag.id, name: '+Tax Only CB', base: 0, tax: 0 });
});
