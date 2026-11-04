import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { analyticPlusModels, planApplicability } from './models/analyticplus.js';

test('mandatory default with a product-less line rejected', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', {
    name: 'Operating Plan',
    default_applicability: 'mandatory',
  });
  db = plan.db;

  const analyticAcc = create(db, 'account.analytic.account', {
    name: 'Cost Center 1',
    code: 'CC1',
    plan_id: plan.id,
  });
  db = analyticAcc.db;

  const expenseAcc = search(db, 'account.account').find((a) => a.code === '600000');

  // Product-less line on vendor bill without analytic distribution must be rejected
  const billNoProduct = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-01',
    invoice_line_ids: [
      { name: 'Consulting Expense', price_unit: 500, qty: 1, tax: 0, account_id: expenseAcc.id },
    ],
  });
  db = billNoProduct.db;

  assert.throws(
    () => postMove(db, billNoProduct.id),
    /Allocate product lines to the mandatory analytic plan: Operating Plan/
  );

  // When analytic distribution is provided on the product-less line, posting succeeds
  const billWithDist = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-01',
    invoice_line_ids: [
      {
        name: 'Consulting Expense',
        price_unit: 500,
        qty: 1,
        tax: 0,
        account_id: expenseAcc.id,
        analytic_distribution: { [analyticAcc.id]: 100 },
      },
    ],
  });
  db = postMove(billWithDist.db, billWithDist.id);
  assert.equal(read(db, 'account.move', billWithDist.id).state, 'posted');
});

test('a rule making a plan mandatory only for account prefix 6 on bills', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', {
    name: 'Cost Plan',
    default_applicability: 'optional',
    applicability_ids: [
      {
        business_domain: 'bill',
        account_prefix: '6',
        applicability: 'mandatory',
      },
    ],
  });
  db = plan.db;

  const analyticAcc = create(db, 'account.analytic.account', {
    name: 'Cost Account',
    code: 'CA1',
    plan_id: plan.id,
  });
  db = analyticAcc.db;

  const expenseAcc = search(db, 'account.account').find((a) => a.code === '600000');
  const revenueAcc = search(db, 'account.account').find((a) => a.code === '400000');

  // Vendor bill on account prefix 6 without distribution is rejected
  const billExp = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-02',
    invoice_line_ids: [
      { name: 'Office Cleaning', price_unit: 300, qty: 1, tax: 0, account_id: expenseAcc.id },
    ],
  });
  assert.throws(
    () => postMove(billExp.db, billExp.id),
    /Allocate product lines to the mandatory analytic plan: Cost Plan/
  );

  // Vendor bill on account prefix 6 with distribution posts successfully
  const billExpValid = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-02',
    invoice_line_ids: [
      {
        name: 'Office Cleaning',
        price_unit: 300,
        qty: 1,
        tax: 0,
        account_id: expenseAcc.id,
        analytic_distribution: { [analyticAcc.id]: 100 },
      },
    ],
  });
  db = postMove(billExpValid.db, billExpValid.id);
  assert.equal(read(db, 'account.move', billExpValid.id).state, 'posted');

  // Customer invoice on account prefix 4 without distribution is not affected by bill rule
  const invRev = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-02',
    invoice_line_ids: [
      { name: 'Consulting Income', price_unit: 1000, qty: 1, tax: 0, account_id: revenueAcc.id },
    ],
  });
  db = postMove(invRev.db, invRev.id);
  assert.equal(read(db, 'account.move', invRev.id).state, 'posted');
});

test('a rule making a plan unavailable for one product category', () => {
  let db = seed();
  const parentCat = create(db, 'product.category', { name: 'Hardware' });
  db = parentCat.db;

  const childCat = create(db, 'product.category', { name: 'Desktops', parent_id: parentCat.id });
  db = childCat.db;

  const otherCat = create(db, 'product.category', { name: 'Services' });
  db = otherCat.db;

  const deskProduct = create(db, 'product', {
    name: 'Workstation X',
    categ_id: childCat.id,
    list_price: 1500,
    cost: 900,
    type: 'goods',
  });
  db = deskProduct.db;

  const serviceProduct = create(db, 'product', {
    name: 'Consulting Hours',
    categ_id: otherCat.id,
    list_price: 100,
    cost: 50,
    type: 'service',
  });
  db = serviceProduct.db;

  const plan = create(db, 'account.analytic.plan', {
    name: 'Services Only Plan',
    default_applicability: 'mandatory',
    applicability_ids: [
      {
        product_categ_id: parentCat.id,
        applicability: 'unavailable',
      },
    ],
  });
  db = plan.db;

  const analyticAcc = create(db, 'account.analytic.account', {
    name: 'Service Analytic',
    code: 'SRV',
    plan_id: plan.id,
  });
  db = analyticAcc.db;

  // If a line in the unavailable category allocates to this plan, posting is rejected
  const invBlocked = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-03',
    invoice_line_ids: [
      {
        product_id: deskProduct.id,
        qty: 1,
        price_unit: 1500,
        tax: 0,
        analytic_distribution: { [analyticAcc.id]: 100 },
      },
    ],
  });
  assert.throws(
    () => postMove(invBlocked.db, invBlocked.id),
    /Analytic plan is unavailable: Services Only Plan/
  );

  // If a line in the unavailable category has NO allocation, posting succeeds
  const invAllowedWithoutDist = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-03',
    invoice_line_ids: [
      { product_id: deskProduct.id, qty: 1, price_unit: 1500, tax: 0 },
    ],
  });
  db = postMove(invAllowedWithoutDist.db, invAllowedWithoutDist.id);
  assert.equal(read(db, 'account.move', invAllowedWithoutDist.id).state, 'posted');

  // A line in another category falls back to mandatory default
  const invServiceNoDist = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-03',
    invoice_line_ids: [
      { product_id: serviceProduct.id, qty: 1, price_unit: 100, tax: 0 },
    ],
  });
  assert.throws(
    () => postMove(invServiceNoDist.db, invServiceNoDist.id),
    /Allocate product lines to the mandatory analytic plan: Services Only Plan/
  );
});

test('most specific rule wins', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', {
    name: 'Tiered Plan',
    default_applicability: 'optional',
    applicability_ids: [
      {
        business_domain: 'bill',
        applicability: 'optional',
      },
      {
        business_domain: 'bill',
        account_prefix: '60',
        applicability: 'mandatory',
      },
    ],
  });
  db = plan.db;

  const analyticAcc = create(db, 'account.analytic.account', {
    name: 'Tiered Account',
    code: 'TA1',
    plan_id: plan.id,
  });
  db = analyticAcc.db;

  const acc60 = search(db, 'account.account').find((a) => a.code === '600000');
  const acc61 = search(db, 'account.account').find((a) => a.code === '610000');

  // Bill on account 600000: Rule 2 has higher specificity score than Rule 1, so mandatory wins
  const bill60 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-04',
    invoice_line_ids: [
      { name: 'Specific Expense', price_unit: 400, qty: 1, tax: 0, account_id: acc60.id },
    ],
  });
  assert.throws(
    () => postMove(bill60.db, bill60.id),
    /Allocate product lines to the mandatory analytic plan: Tiered Plan/
  );

  // Bill on account 610000: Rule 2 does not match, Rule 1 matches with score 1 -> optional wins
  const bill61 = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-04',
    invoice_line_ids: [
      { name: 'Travel Expense', price_unit: 250, qty: 1, tax: 0, account_id: acc61.id },
    ],
  });
  db = postMove(bill61.db, bill61.id);
  assert.equal(read(db, 'account.move', bill61.id).state, 'posted');
});

test('section and note lines are ignored during mandatory plan checks', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', {
    name: 'Strict Plan',
    default_applicability: 'mandatory',
  });
  db = plan.db;

  const analyticAcc = create(db, 'account.analytic.account', {
    name: 'Strict Acc',
    code: 'ST1',
    plan_id: plan.id,
  });
  db = analyticAcc.db;

  const expenseAcc = search(db, 'account.account').find((a) => a.code === '600000');

  // Bill contains:
  // 1. Valid product line with mandatory distribution
  // 2. Section line without distribution
  // 3. Note line without distribution
  const billWithSections = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-05',
    invoice_line_ids: [
      {
        name: 'Consulting Deliverable',
        price_unit: 800,
        qty: 1,
        tax: 0,
        account_id: expenseAcc.id,
        analytic_distribution: { [analyticAcc.id]: 100 },
      },
      {
        name: 'Phase 1 Milestones',
        display_type: 'line_section',
      },
      {
        name: 'Payment is due within 30 days of milestone approval',
        display_type: 'line_note',
      },
    ],
  });

  db = postMove(billWithSections.db, billWithSections.id);
  assert.equal(read(db, 'account.move', billWithSections.id).state, 'posted');
});

test('journal entry posting validates analytic applicability for general domain', () => {
  let db = seed();
  const plan = create(db, 'account.analytic.plan', {
    name: 'General Audit Plan',
    default_applicability: 'optional',
    applicability_ids: [
      {
        business_domain: 'general',
        account_prefix: '6',
        applicability: 'mandatory',
      },
    ],
  });
  db = plan.db;

  const analyticAcc = create(db, 'account.analytic.account', {
    name: 'Audit CC',
    code: 'AUD',
    plan_id: plan.id,
  });
  db = analyticAcc.db;

  const expenseAcc = search(db, 'account.account').find((a) => a.code === '600000');
  const cashAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_cash');

  // Journal entry debiting account prefix 6 without analytic distribution is rejected
  const entryUnallocated = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    invoice_date: '2026-02-06',
    line_ids: [
      { account_id: expenseAcc.id, debit: 150, credit: 0 },
      { account_id: cashAcc.id, debit: 0, credit: 150 },
    ],
  });

  assert.throws(
    () => postMove(entryUnallocated.db, entryUnallocated.id),
    /Allocate product lines to the mandatory analytic plan: General Audit Plan/
  );

  // When allocated, journal entry posting succeeds
  const entryAllocated = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    invoice_date: '2026-02-06',
    line_ids: [
      {
        account_id: expenseAcc.id,
        debit: 150,
        credit: 0,
        analytic_distribution: { [analyticAcc.id]: 100 },
      },
      { account_id: cashAcc.id, debit: 0, credit: 150 },
    ],
  });

  db = postMove(entryAllocated.db, entryAllocated.id);
  assert.equal(read(db, 'account.move', entryAllocated.id).state, 'posted');
});

test('plan form exposes editable applicability_ids one2many', () => {
  let db = seed();
  const planModel = analyticPlusModels['account.analytic.plan'];
  assert.ok(planModel.fields.applicability_ids, 'applicability_ids declared on plan');
  assert.equal(planModel.fields.applicability_ids.type, 'one2many');
  assert.ok(
    planModel.form.tabs.some((t) => t.fields.includes('applicability_ids')),
    'applicability_ids exposed on plan form tab'
  );

  const plan = create(db, 'account.analytic.plan', {
    name: 'Form Editable Plan',
    applicability_ids: [
      {
        business_domain: 'bill',
        account_prefix: '60',
        applicability: 'mandatory',
      },
    ],
  });
  db = plan.db;

  const fetched = read(db, 'account.analytic.plan', plan.id);
  assert.equal(fetched.applicability_ids.length, 1);
  assert.equal(fetched.applicability_ids[0].business_domain, 'bill');
  assert.equal(fetched.applicability_ids[0].account_prefix, '60');
  assert.equal(fetched.applicability_ids[0].applicability, 'mandatory');
});

test('planApplicability resolves account, category hierarchy and domain correctly', () => {
  let db = seed();
  const parentCat = create(db, 'product.category', { name: 'Electronics' });
  db = parentCat.db;
  const childCat = create(db, 'product.category', { name: 'Phones', parent_id: parentCat.id });
  db = childCat.db;
  const prod = create(db, 'product', { name: 'Smartphone', categ_id: childCat.id, list_price: 500 });
  db = prod.db;

  const plan = {
    id: 99,
    name: 'Test Plan',
    default_applicability: 'optional',
    applicability_ids: [
      { business_domain: 'invoice', product_categ_id: parentCat.id, applicability: 'mandatory' },
      { account_prefix: '60', applicability: 'unavailable' },
    ],
  };

  const invMove = { move_type: 'out_invoice', company_id: 1 };
  const line = { product_id: prod.id, price_unit: 500, qty: 1 };

  // Resolves category via product categ_id parent chain and invoice domain from move_type
  assert.equal(planApplicability(db, plan, line, invMove), 'mandatory');

  // Ignored guessed fallbacks: line.business_domain does not set domain without move.move_type
  assert.equal(planApplicability(db, plan, { ...line, business_domain: 'invoice' }, null), 'optional');

  // Ignored guessed fallbacks: line.product_categ_id is not used if product has no matching categ
  const noCatProd = create(db, 'product', { name: 'No Cat' });
  db = noCatProd.db;
  assert.equal(planApplicability(db, plan, { product_id: noCatProd.id, product_categ_id: parentCat.id }, invMove), 'optional');

  // Resolves account from invoiceLineAccount if line.account_id is absent
  const billMove = { move_type: 'in_invoice', company_id: 1 };
  const expAcc = search(db, 'account.account').find((a) => a.code === '600000');
  // With explicit account_id
  assert.equal(planApplicability(db, plan, { account_id: expAcc.id }, billMove), 'unavailable');
  // Ignored guessed fallbacks: line.account_code without account_id is not used on non-invoice entries
  const entryMove = { move_type: 'entry', company_id: 1 };
  assert.equal(planApplicability(db, plan, { account_code: '600000' }, entryMove), 'optional');
  assert.equal(planApplicability(db, plan, { account_id: expAcc.id }, entryMove), 'unavailable');
});
