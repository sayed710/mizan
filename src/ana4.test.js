import test from 'node:test';
import assert from 'node:assert/strict';

import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postEntry } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { findAnalyticDistribution } from './models/analyticplus.js';
import { balanceAnalyticColumns, pnlAnalyticColumns } from './views/reportCompare.js';
import { today } from './models/common.js';

test('Finding 8: Product-category distribution rules match category IDs consistently', () => {
  let db = seed();

  // Verify field type in account.analytic.distribution.model
  const distModelDef = models['account.analytic.distribution.model'];
  assert.equal(distModelDef.fields.product_categ_id.type, 'many2one');
  assert.equal(distModelDef.fields.product_categ_id.relation, 'product.category');

  // Create a product category and a product
  const cat = create(db, 'product.category', { name: 'Hardware Category' });
  db = cat.db;
  const product = create(db, 'product', {
    name: 'Keyboard Hardware',
    categ_id: cat.id,
    type: 'goods',
    list_price: 150,
  });
  db = product.db;

  const analytic = create(db, 'account.analytic.account', { name: 'Hardware Project' });
  db = analytic.db;

  // Create distribution model with string category ID (as entered in text input)
  const rule = create(db, 'account.analytic.distribution.model', {
    product_categ_id: String(cat.id),
    sequence: 10,
    company_id: 1,
    analytic_distribution: { [analytic.id]: 100 },
  });
  db = rule.db;

  // Verify findAnalyticDistribution matches
  const dist = findAnalyticDistribution(db, {
    product_id: product.id,
    company_id: 1,
  });
  assert.deepEqual(dist, { [analytic.id]: 100 });

  // Post invoice with the product and verify rule applies to invoice lines
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: today(),
    invoice_line_ids: [
      { product_id: product.id, qty: 1, price_unit: 150, tax: 0 },
    ],
  });
  db = postMove(invoice.db, invoice.id);
  const posted = read(db, 'account.move', invoice.id);
  assert.deepEqual(posted.invoice_line_ids[0].analytic_distribution, { [analytic.id]: 100 });
});

test('Finding 9: Distribution model matching combines distinct plans and respects sequence priority', () => {
  let db = seed();

  // Create two distinct analytic plans
  const planA = create(db, 'account.analytic.plan', { name: 'Plan Projects' });
  db = planA.db;
  const planB = create(db, 'account.analytic.plan', { name: 'Plan Departments' });
  db = planB.db;

  const accA1 = create(db, 'account.analytic.account', { name: 'Project Alpha', plan_id: planA.id });
  db = accA1.db;
  const accA2 = create(db, 'account.analytic.account', { name: 'Project Alpha Later', plan_id: planA.id });
  db = accA2.db;
  const accB1 = create(db, 'account.analytic.account', { name: 'Department R&D', plan_id: planB.id });
  db = accB1.db;

  const partner = create(db, 'res.partner', { name: 'Test Client' });
  db = partner.db;
  const product = create(db, 'product', { name: 'Consulting Widget', type: 'service', list_price: 200 });
  db = product.db;

  // Rule 1: sequence 10, general rule (partner only, score 1) for Plan A -> accA1
  const rule1 = create(db, 'account.analytic.distribution.model', {
    partner_id: partner.id,
    sequence: 10,
    company_id: 1,
    analytic_distribution: { [accA1.id]: 100 },
  });
  db = rule1.db;

  // Rule 1b: sequence 25, same score (partner only, score 1) for Plan A -> accA2 (later sequence)
  const rule1b = create(db, 'account.analytic.distribution.model', {
    partner_id: partner.id,
    sequence: 25,
    company_id: 1,
    analytic_distribution: { [accA2.id]: 100 },
  });
  db = rule1b.db;

  // Rule 2: sequence 20, more specific rule (partner AND product, score 2) for Plan B -> accB1
  // Previously, because Rule 2 had higher specificity score than Rule 1, Rule 2 won globally
  // and discarded Rule 1 (Plan A).
  const rule2 = create(db, 'account.analytic.distribution.model', {
    partner_id: partner.id,
    product_id: product.id,
    sequence: 20,
    company_id: 1,
    analytic_distribution: { [accB1.id]: 100 },
  });
  db = rule2.db;

  // Resolution must:
  // 1. Pick Rule 1 for Plan A (sequence 10 beats sequence 25 for equal score)
  // 2. Pick Rule 2 for Plan B (more specific rule for Plan B)
  // 3. Combine applicable rules for distinct plans in sequence order (Rule 1 seq 10, then Rule 2 seq 20)
  const dist = findAnalyticDistribution(db, {
    partner_id: partner.id,
    product_id: product.id,
    company_id: 1,
  });
  assert.deepEqual(dist, { [accA1.id]: 100, [accB1.id]: 100 });

  // Post invoice and verify combined distribution is applied
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    invoice_line_ids: [
      { product_id: product.id, qty: 1, price_unit: 200, tax: 0 },
    ],
  });
  db = postMove(invoice.db, invoice.id);
  const posted = read(db, 'account.move', invoice.id);
  assert.deepEqual(posted.invoice_line_ids[0].analytic_distribution, {
    [accA1.id]: 100,
    [accB1.id]: 100,
  });
});

test('Finding 10: Horizontal analytic groups do not split independent plan allocations', () => {
  let db = seed();

  const planA = create(db, 'account.analytic.plan', { name: 'Projects' });
  db = planA.db;
  const planB = create(db, 'account.analytic.plan', { name: 'Departments' });
  db = planB.db;

  const accA = create(db, 'account.analytic.account', { name: 'Project 100', plan_id: planA.id });
  db = accA.db;
  const accB = create(db, 'account.analytic.account', { name: 'Dept 200', plan_id: planB.id });
  db = accB.db;

  const date = `${today().slice(0, 4)}-06-15`;
  const expenseAcc = search(db, 'account.account').find((a) => a.code === '600000')?.id;

  // Post a 100 line with 100% in Plan A and 100% in Plan B
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date,
    lines: [
      {
        account: expenseAcc,
        debit: 100,
        analytic_distribution: { [accA.id]: 100, [accB.id]: 100 },
      },
      { account: '101401', credit: 100 },
    ],
  }).db;

  // Group by one account from each plan
  const group = create(db, 'account.report.horizontal.group', {
    name: 'Multi Plan Group',
    company_id: 1,
    rule_ids: [{ field: 'analytic', ids: `${accA.id},${accB.id}` }],
  });
  db = group.db;

  const period = { from: `${today().slice(0, 4)}-01-01`, to: `${today().slice(0, 4)}-12-31` };
  const groupRec = read(db, 'account.report.horizontal.group', group.id);

  // Test P&L analytic columns
  const pnlData = pnlAnalyticColumns(db, groupRec, period);
  assert.deepEqual(pnlData.headers, ['Dept 200', 'Project 100', 'Others']);
  const expSection = pnlData.sections.find((s) => s.title === 'Expenses');
  assert.ok(expSection);

  // Before fix: Dept 200 = 50, Project 100 = 50 because 200% was normalized to 50% each
  // Expected: each plan's allocation reports full 100
  assert.equal(expSection.totals[0], 100, 'Dept 200 reports full 100');
  assert.equal(expSection.totals[1], 100, 'Project 100 reports full 100');

  // Test Balance Sheet analytic columns as well
  const bsData = balanceAnalyticColumns(db, groupRec, period.to);
  assert.deepEqual(bsData.headers, ['Dept 200', 'Project 100', 'Others']);
});


test('Finding 8: Product-category rule matches child categories and handles numeric category IDs', () => {
  let db = seed();

  const parentCat = create(db, 'product.category', { name: 'Parent Category' });
  db = parentCat.db;
  const childCat = create(db, 'product.category', { name: 'Child Category', parent_id: parentCat.id });
  db = childCat.db;

  const productInChild = create(db, 'product', {
    name: 'Child Product',
    categ_id: childCat.id,
    type: 'goods',
  });
  db = productInChild.db;

  const analytic = create(db, 'account.analytic.account', { name: 'Parent Cat Account' });
  db = analytic.db;

  // Rule defined on parent category using numeric ID
  const rule = create(db, 'account.analytic.distribution.model', {
    product_categ_id: parentCat.id,
    sequence: 10,
    company_id: 1,
    analytic_distribution: { [analytic.id]: 100 },
  });
  db = rule.db;

  // Product in child category should match rule on parent category
  const dist = findAnalyticDistribution(db, {
    product_id: productInChild.id,
    company_id: 1,
  });
  assert.deepEqual(dist, { [analytic.id]: 100 });
});

test('Finding 9: Tie-breaking by specificity when sequence is equal, and fallback preservation', () => {
  let db = seed();

  const planA = create(db, 'account.analytic.plan', { name: 'Plan Core' });
  db = planA.db;
  const acc1 = create(db, 'account.analytic.account', { name: 'Acc General', plan_id: planA.id });
  db = acc1.db;
  const acc2 = create(db, 'account.analytic.account', { name: 'Acc Specific', plan_id: planA.id });
  db = acc2.db;

  const partner = create(db, 'res.partner', { name: 'Partner Tie' });
  db = partner.db;
  const product = create(db, 'product', { name: 'Product Tie' });
  db = product.db;

  // Both have sequence 10, but rule 2 has partner AND product (score 2 vs 1)
  const rule1 = create(db, 'account.analytic.distribution.model', {
    partner_id: partner.id,
    sequence: 10,
    company_id: 1,
    analytic_distribution: { [acc1.id]: 100 },
  });
  db = rule1.db;
  const rule2 = create(db, 'account.analytic.distribution.model', {
    partner_id: partner.id,
    product_id: product.id,
    sequence: 10,
    company_id: 1,
    analytic_distribution: { [acc2.id]: 100 },
  });
  db = rule2.db;

  const dist = findAnalyticDistribution(db, {
    partner_id: partner.id,
    product_id: product.id,
    company_id: 1,
  });
  assert.deepEqual(dist, { [acc2.id]: 100 }, 'Higher score breaks tie when sequence is identical');
});

test('Finding 10: Horizontal group with separate rules per plan preserves full amounts', () => {
  let db = seed();

  const planA = create(db, 'account.analytic.plan', { name: 'Projects A' });
  db = planA.db;
  const planB = create(db, 'account.analytic.plan', { name: 'Regions B' });
  db = planB.db;

  const accA = create(db, 'account.analytic.account', { name: 'Project North', plan_id: planA.id });
  db = accA.db;
  const accB = create(db, 'account.analytic.account', { name: 'Region East', plan_id: planB.id });
  db = accB.db;

  const date = `${today().slice(0, 4)}-08-10`;
  const expenseAcc = search(db, 'account.account').find((a) => a.code === '600000')?.id;

  // €250 line with 100% in Project North and 100% in Region East
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date,
    lines: [
      {
        account: expenseAcc,
        debit: 250,
        analytic_distribution: { [accA.id]: 100, [accB.id]: 100 },
      },
      { account: '101401', credit: 250 },
    ],
  }).db;

  // Separate rule per plan
  const group = create(db, 'account.report.horizontal.group', {
    name: 'Two Rule Group',
    company_id: 1,
    rule_ids: [
      { field: 'analytic', ids: String(accA.id) },
      { field: 'analytic', ids: String(accB.id) },
    ],
  });
  db = group.db;

  const period = { from: `${today().slice(0, 4)}-01-01`, to: `${today().slice(0, 4)}-12-31` };
  const groupRec = read(db, 'account.report.horizontal.group', group.id);
  const pnlData = pnlAnalyticColumns(db, groupRec, period);

  // Headers: Project North, Others (Rule 0), Region East, Others (Rule 1)
  const expSection = pnlData.sections.find((s) => s.title === 'Expenses');
  assert.ok(expSection);
  // Column 0 is Project North (should be 250), Column 2 is Region East (should be 250)
  assert.equal(expSection.totals[0], 250, 'Project North has full 250');
  assert.equal(expSection.totals[2], 250, 'Region East has full 250');
});
