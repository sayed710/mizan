import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

test('receipts in cases/dozens allocate billed value with proper unit conversion', () => {
  let db = seed();
  const unitUom = search(db, 'uom.uom').find((u) => u.name === 'Units');
  const dozenUom = search(db, 'uom.uom').find((u) => u.name === 'Dozens');
  assert.ok(unitUom && dozenUom, 'UoMs must exist');

  // Product with stock in Units, cost 5, FIFO costing
  const prod = create(db, 'product', {
    name: 'Widget in Units',
    type: 'goods',
    uom_id: unitUom.id,
    cost: 5,
    qty_available: 0,
    cost_method: 'fifo',
    valuation: 'real_time',
  });
  db = prod.db;
  const productId = prod.id;

  // Purchase order for 1 Dozen (= 12 Units) at $120/Dozen
  const poRes = create(db, 'purchase.order', {
    partner_id: 1,
    order_line: [{ product_id: productId, qty: 1, uom_id: dozenUom.id, price_unit: 120, tax: 0 }],
  });
  db = poRes.db;
  const poId = poRes.id;

  // Confirm order to generate picking
  const confirmed = run(db, 'purchase.order', poId, 'Confirm Order');
  db = confirmed.db;

  const picking = search(db, 'stock.picking').find((p) => p.purchase_id === poId);
  assert.ok(picking, 'Picking should be created');

  // Create vendor bill for 1 Dozen at $120
  const billRes = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 1,
    purchase_id: poId,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ product_id: productId, qty: 1, uom_id: dozenUom.id, price_unit: 120, tax: 0 }],
  });
  db = billRes.db;
  db = postMove(db, billRes.id);

  // Validate receipt of 12 units
  const validated = run(db, 'stock.picking', picking.id, 'Validate');
  db = validated.db;

  const layers = search(db, 'stock.valuation.layer').filter((l) => l.product_id === productId && l.picking_id === picking.id);
  assert.equal(layers.length, 1, 'Should create one valuation layer');
  // 12 units should be valued at $120 total ($10/unit), NOT using unbilled fallback for 11 units
  assert.equal(layers[0].quantity, 12);
  assert.equal(layers[0].unit_cost, 10);
  assert.equal(layers[0].value, 120);
});

test('reposted bills reset draft asset model-derived fields when switched to unmodeled fixed account', () => {
  let db = seed();
  const depAcc = create(db, 'account.account', { name: 'Accum Dep', code: '159900', account_type: 'asset_fixed' });
  db = depAcc.db;
  const expAcc = create(db, 'account.account', { name: 'Dep Expense', code: '680000', account_type: 'expense' });
  db = expAcc.db;

  const modelRes = create(db, 'account.asset.model', {
    name: 'Special Model',
    method: 'degressive',
    method_number: 10,
    method_period: '1',
    method_progress_factor: 0.45,
    prorata: true,
    account_depreciation_id: depAcc.id,
    account_expense_id: expAcc.id,
  });
  db = modelRes.db;

  const modeledAcc = create(db, 'account.account', {
    name: 'Modeled Equipment',
    code: '151100',
    account_type: 'asset_fixed',
    asset_model_id: modelRes.id,
  });
  db = modeledAcc.db;

  const unmodeledAcc = create(db, 'account.account', {
    name: 'Generic Equipment',
    code: '151200',
    account_type: 'asset_fixed',
  });
  db = unmodeledAcc.db;

  // Create bill with modeled fixed asset account
  const billRes = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 1,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ name: 'Equipment Line', qty: 1, price_unit: 1000, tax: 0, account_id: modeledAcc.id }],
  });
  db = billRes.db;
  db = postMove(db, billRes.id);

  let asset = search(db, 'account.asset').find((a) => a.bill_id === billRes.id);
  assert.ok(asset, 'Draft asset should be generated');
  assert.equal(asset.model_id, modelRes.id);
  assert.equal(asset.method, 'degressive');
  assert.equal(asset.method_number, 10);
  assert.equal(asset.account_depreciation_id, depAcc.id);

  // Reset bill to draft, change account to unmodeled, and repost
  const reset = run(db, 'account.move', billRes.id, 'Reset to Draft');
  db = reset.db;
  db = write(db, 'account.move', billRes.id, {
    invoice_line_ids: [{ name: 'Equipment Line', qty: 1, price_unit: 1000, tax: 0, account_id: unmodeledAcc.id }],
  });
  db = postMove(db, billRes.id);

  const assetAfter = search(db, 'account.asset').find((a) => a.bill_id === billRes.id);
  assert.ok(assetAfter, 'Asset should exist');
  assert.equal(assetAfter.id, asset.id, 'Asset identity should be preserved');
  assert.equal(assetAfter.model_id, null, 'model_id should be cleared');
  assert.equal(assetAfter.method, 'linear', 'method should be reset to default');
  assert.equal(assetAfter.method_number, 5, 'method_number should be reset to default');
  assert.equal(assetAfter.method_period, '12', 'method_period should be reset to default');
  assert.equal(assetAfter.method_progress_factor, 0.3, 'method_progress_factor should be reset to default');
  assert.equal(assetAfter.prorata, false, 'prorata should be reset to default');
  assert.equal(assetAfter.account_depreciation_id, null, 'account_depreciation_id should be cleared');
  assert.equal(assetAfter.account_expense_id, null, 'account_expense_id should be cleared');
});

test('invoices and bills enforce existing, company-matched journal of appropriate sale or purchase type', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  assert.ok(bankJournal, 'Bank journal must exist');

  // Customer invoice pointing to bank journal should be rejected on post
  const invWithBank = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    journal_id: bankJournal.id,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  assert.throws(
    () => postMove(invWithBank.db, invWithBank.id),
    /type/i,
    'Posting invoice to bank journal must fail on journal type check'
  );

  // Customer invoice with nonexistent journal should be rejected
  const invNonexistent = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    journal_id: 99999,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  assert.throws(
    () => postMove(invNonexistent.db, invNonexistent.id),
    /exist/i,
    'Posting invoice to nonexistent journal must fail'
  );

  // Vendor bill pointing to sale journal should be rejected
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  assert.ok(saleJournal, 'Sale journal must exist');
  const billWithSale = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 1,
    company_id: 1,
    journal_id: saleJournal.id,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ name: 'Product', qty: 1, price_unit: 100, tax: 0 }],
  });
  assert.throws(
    () => postMove(billWithSale.db, billWithSale.id),
    /type/i,
    'Posting bill to sale journal must fail on journal type check'
  );

  // Valid alternative sale journal in same company should post successfully
  const altSale = create(db, 'account.journal', {
    name: 'Alternative Sales',
    code: 'INVA',
    type: 'sale',
    company_id: 1,
  });
  db = altSale.db;
  const validInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    journal_id: altSale.id,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  const posted = postMove(validInv.db, validInv.id);
  assert.equal(read(posted, 'account.move', validInv.id).state, 'posted');
  assert.equal(read(posted, 'account.move', validInv.id).journal_id, altSale.id);
});

test('finding 15: taxes with foreign configured account reject posting when company equivalent is missing', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Branch 2' });
  db = c2.db;
  const company2Id = c2.id;

  // Setup Company 2 journals and base accounts
  const j2 = create(db, 'account.journal', { name: 'B2 Sales', code: 'INV2', type: 'sale', company_id: company2Id });
  db = j2.db;
  const rec2 = create(db, 'account.account', { name: 'B2 Rec', code: '121000', account_type: 'asset_receivable', company_id: company2Id });
  db = rec2.db;
  const inc2 = create(db, 'account.account', { name: 'B2 Inc', code: '400000', account_type: 'income', company_id: company2Id });
  db = inc2.db;
  const defTax2 = create(db, 'account.account', { name: 'B2 Def Tax', code: '251000', account_type: 'liability_current', company_id: company2Id });
  db = defTax2.db;

  // Tax configured with an account belonging only to Company 1 (code 259999)
  const taxAccC1 = create(db, 'account.account', { name: 'C1 Only Tax Acc', code: '259999', account_type: 'liability_current', company_id: 1 });
  db = taxAccC1.db;
  const tax = create(db, 'account.tax', { name: 'C1 Tax', amount: 10, amount_type: 'percent', type_tax_use: 'sale', account_id: taxAccC1.id });
  db = tax.db;

  // Invoice in Company 2 using this tax
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: company2Id,
    journal_id: j2.id,
    partner_id: 1,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax_id: tax.id, tax: 10, tax_account_id: taxAccC1.id }],
  });
  db = inv.db;

  // Must reject posting because Company 2 does not have a 259999 tax account (cannot silently fallback to 251000)
  assert.throws(
    () => postMove(db, inv.id),
    /tax account/i,
    'Posting invoice with foreign tax account missing in invoice company must fail'
  );

  // Now create the same-code account in Company 2
  const taxAccC2 = create(db, 'account.account', { name: 'B2 Tax Acc', code: '259999', account_type: 'liability_current', company_id: company2Id });
  db = taxAccC2.db;

  // Now posting should succeed and use B2's tax account
  const posted = postMove(db, inv.id);
  const postedMove = read(posted, 'account.move', inv.id);
  assert.equal(postedMove.state, 'posted');
  const taxLine = postedMove.line_ids.find((l) => l.account_id === taxAccC2.id);
  assert.ok(taxLine, 'Tax should post to resolved company tax account 259999');
});

test('finding 16: fiscal account rules apply to original selected account before company resolution', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Branch 2' });
  db = c2.db;
  const company2Id = c2.id;

  const j2 = create(db, 'account.journal', { name: 'B2 Sales', code: 'INV2', type: 'sale', company_id: company2Id });
  db = j2.db;
  const rec2 = create(db, 'account.account', { name: 'B2 Rec', code: '121000', account_type: 'asset_receivable', company_id: company2Id });
  db = rec2.db;
  const inc2Base = create(db, 'account.account', { name: 'B2 Inc Base', code: '400000', account_type: 'income', company_id: company2Id });
  db = inc2Base.db;
  const inc2Dest = create(db, 'account.account', { name: 'B2 Inc Export', code: '400100', account_type: 'income', company_id: company2Id });
  db = inc2Dest.db;

  // Company 1 original account explicitly scoped to company 1
  const inc1 = create(db, 'account.account', { name: 'C1 Sales', code: '400000', account_type: 'income', company_id: 1 });
  db = inc1.db;

  // Fiscal position in Company 2 maps original account inc1.id -> inc2Dest.id
  const fp = create(db, 'account.fiscal.position', {
    name: 'Export FP',
    company_id: company2Id,
    account_ids: [{ account_src_id: inc1.id, account_dest_id: inc2Dest.id }],
  });
  db = fp.db;

  // Invoice in Company 2 with line referencing inc1.id
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: company2Id,
    journal_id: j2.id,
    partner_id: 1,
    fiscal_position_id: fp.id,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ name: 'Export Goods', qty: 1, price_unit: 100, tax: 0, account_id: inc1.id }],
  });
  db = inv.db;

  const posted = postMove(db, inv.id);
  const postedMove = read(posted, 'account.move', inv.id);
  assert.equal(postedMove.state, 'posted');
  // It should post to inc2Dest.id (400100), NOT inc2Base.id (400000)
  const line400100 = postedMove.line_ids.find((l) => l.account_id === inc2Dest.id);
  assert.ok(line400100, 'Income should post to fiscal-mapped destination account 400100');
  const line400000 = postedMove.line_ids.find((l) => l.account_id === inc2Base.id);
  assert.equal(line400000, undefined, 'Income should NOT post to unmapped 400000');

  // Also verify product-configured account mapping with fiscal position
  const prod = create(db, 'product', {
    name: 'FP Product',
    type: 'consu',
    property_account_income_id: inc1.id,
  });
  db = prod.db;

  const invProd = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: company2Id,
    journal_id: j2.id,
    partner_id: 1,
    fiscal_position_id: fp.id,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ product_id: prod.id, name: 'FP Product', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = invProd.db;

  const postedProdMove = read(postMove(db, invProd.id), 'account.move', invProd.id);
  assert.equal(postedProdMove.state, 'posted');
  const prodLine400100 = postedProdMove.line_ids.find((l) => l.account_id === inc2Dest.id);
  assert.ok(prodLine400100, 'Product-configured income should post to fiscal-mapped destination account 400100');
  const prodLine400000 = postedProdMove.line_ids.find((l) => l.account_id === inc2Base.id);
  assert.equal(prodLine400000, undefined, 'Product-configured income should NOT post to unmapped 400000');
});

test('finding 17: product with foreign configured account rejects posting when company equivalent is missing', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Branch 2' });
  db = c2.db;
  const company2Id = c2.id;

  const j2 = create(db, 'account.journal', { name: 'B2 Sales', code: 'INV2', type: 'sale', company_id: company2Id });
  db = j2.db;
  const rec2 = create(db, 'account.account', { name: 'B2 Rec', code: '121000', account_type: 'asset_receivable', company_id: company2Id });
  db = rec2.db;
  const inc2Base = create(db, 'account.account', { name: 'B2 Inc Base', code: '400000', account_type: 'income', company_id: company2Id });
  db = inc2Base.db;

  // Account only in Company 1
  const specAccC1 = create(db, 'account.account', { name: 'C1 Only Income', code: '499999', account_type: 'income', company_id: 1 });
  db = specAccC1.db;

  // Product configured with this income account
  const prod = create(db, 'product', {
    name: 'Special Product',
    type: 'consu',
    property_account_income_id: specAccC1.id,
  });
  db = prod.db;

  // Invoice in Company 2 using this product without line account
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: company2Id,
    journal_id: j2.id,
    partner_id: 1,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ product_id: prod.id, name: 'Special Product', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = inv.db;

  // Must reject posting because Company 2 has no 499999 account (cannot silently fallback to 400000)
  assert.throws(
    () => postMove(db, inv.id),
    /product account/i,
    'Posting invoice with foreign product account missing in invoice company must fail'
  );

  // But an unconfigured product should use generic base account 400000 without error
  const unconfiguredProd = create(db, 'product', {
    name: 'Standard Product',
    type: 'consu',
  });
  db = unconfiguredProd.db;
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: company2Id,
    journal_id: j2.id,
    partner_id: 1,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ product_id: unconfiguredProd.id, name: 'Standard Product', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = inv2.db;

  const posted2 = postMove(db, inv2.id);
  const postedMove2 = read(posted2, 'account.move', inv2.id);
  assert.equal(postedMove2.state, 'posted');
  const baseLine = postedMove2.line_ids.find((l) => l.account_id === inc2Base.id);
  assert.ok(baseLine, 'Unconfigured product should fall back to company generic income account');
});
