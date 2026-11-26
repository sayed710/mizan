import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { round } from './money.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { createCompany } from './models/company.js';
import { models } from './models/index.js';
import { payMove, postMove } from './models/accounting.js';
import { journalItems, postEntry } from './models/ledger.js';
import { postPayment } from './models/pay.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { isClosableRepartitionLine, taxClosingMatchesReturn, taxClosingSpec, taxReport } from './models/finance.js';
import { ensureReturnTypes, payReturn, reviewReturn, submitReturn } from './models/taxreturn.js';

function accountBalanceUpTo(db, accountId, toDate, companyId = 1) {
  const items = journalItems(db, { to: toDate, company_id: companyId }).filter((l) => l.account_id === accountId);
  return round(items.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
}

function setupBaseTaxClosingEnv(db) {
  let next = db;
  const vatType = search(next, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');

  const defPayableCreated = create(next, 'account.account', {
    code: '251998', name: 'Default Tax Authority Payable', account_type: 'liability_current', company_id: 1,
  });
  next = defPayableCreated.db;

  const defReceivableCreated = create(next, 'account.account', {
    code: '131998', name: 'Default Tax Authority Receivable', account_type: 'asset_current', company_id: 1,
  });
  next = defReceivableCreated.db;

  const profitCreated = create(next, 'account.account', {
    code: '758998', name: 'Tax Rounding Profit', account_type: 'income_other', company_id: 1,
  });
  next = profitCreated.db;

  const lossCreated = create(next, 'account.account', {
    code: '658998', name: 'Tax Rounding Loss', account_type: 'expense', company_id: 1,
  });
  next = lossCreated.db;

  next = write(next, 'account.return.type', vatType.id, {
    tax_payable_account_id: defPayableCreated.id,
    tax_receivable_account_id: defReceivableCreated.id,
    rounding_profit_account_id: profitCreated.id,
    rounding_loss_account_id: lossCreated.id,
  });

  const partner = search(next, 'res.partner')[0];

  return {
    db: next,
    vatType: read(next, 'account.return.type', vatType.id),
    defPayableAccId: defPayableCreated.id,
    defReceivableAccId: defReceivableCreated.id,
    profitAccId: profitCreated.id,
    lossAccId: lossCreated.id,
    partnerId: partner.id,
  };
}

test('TAX-8: account.tax.group fields, form, and guard validations diff-verifiable', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const taxGroupDef = models['account.tax.group'];
  assert.ok(taxGroupDef.fields.tax_payable_account_id, 'tax_payable_account_id field exists');
  assert.equal(taxGroupDef.fields.tax_payable_account_id.type, 'many2one');
  assert.equal(taxGroupDef.fields.tax_payable_account_id.relation, 'account.account');

  assert.ok(taxGroupDef.fields.tax_receivable_account_id, 'tax_receivable_account_id field exists');
  assert.equal(taxGroupDef.fields.tax_receivable_account_id.type, 'many2one');
  assert.equal(taxGroupDef.fields.tax_receivable_account_id.relation, 'account.account');

  // Form includes both fields
  const formFieldNames = [
    ...(taxGroupDef.form.groups?.flatMap((g) => (Array.isArray(g) ? g : g.fields ?? [])) ?? []),
    ...(taxGroupDef.form.tabs?.flatMap((tb) => tb.fields ?? tb.groups?.flatMap((g) => (Array.isArray(g) ? g : g.fields ?? [])) ?? []) ?? []),
  ];
  assert.ok(formFieldNames.includes('tax_payable_account_id'), 'tax_payable_account_id shown on form');
  assert.ok(formFieldNames.includes('tax_receivable_account_id'), 'tax_receivable_account_id shown on form');

  // Create accounts for testing guards
  const validPayable = create(db, 'account.account', {
    code: '251811', name: 'Valid Payable Account', account_type: 'liability_current', company_id: 1,
  });
  db = validPayable.db;

  const validReceivable = create(db, 'account.account', {
    code: '131811', name: 'Valid Receivable Account', account_type: 'asset_current', company_id: 1,
  });
  db = validReceivable.db;

  const assetWrongForPayable = create(db, 'account.account', {
    code: '131812', name: 'Asset Account Wrong For Payable', account_type: 'asset_current', company_id: 1,
  });
  db = assetWrongForPayable.db;

  const liabilityWrongForReceivable = create(db, 'account.account', {
    code: '251812', name: 'Liability Account Wrong For Receivable', account_type: 'liability_current', company_id: 1,
  });
  db = liabilityWrongForReceivable.db;

  const branch = createCompany(db, { name: 'Branch 2' });
  db = branch.db;

  const branchPayable = create(db, 'account.account', {
    code: '251813', name: 'Branch Payable Account', account_type: 'liability_current', company_id: branch.id,
  });
  db = branchPayable.db;

  const branchReceivable = create(db, 'account.account', {
    code: '131813', name: 'Branch Receivable Account', account_type: 'asset_current', company_id: branch.id,
  });
  db = branchReceivable.db;

  // Guard test: tax_payable_account_id must belong to tax group company
  const stagedForeignPayable = {
    ...db,
    records: {
      ...db.records,
      'account.tax.group': [...(db.records['account.tax.group'] ?? []), { id: 991, name: 'Group Foreign Payable', company_id: 1, tax_payable_account_id: branchPayable.id }],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, stagedForeignPayable), { isAdmin: true }),
    /Tax payable account must belong to the tax group company/i,
  );

  // Guard test: tax_payable_account_id must be a liability account
  const stagedWrongTypePayable = {
    ...db,
    records: {
      ...db.records,
      'account.tax.group': [...(db.records['account.tax.group'] ?? []), { id: 992, name: 'Group Wrong Type Payable', company_id: 1, tax_payable_account_id: assetWrongForPayable.id }],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, stagedWrongTypePayable), { isAdmin: true }),
    /Tax payable account must be a liability account/i,
  );

  // Guard test: tax_receivable_account_id must belong to tax group company
  const stagedForeignReceivable = {
    ...db,
    records: {
      ...db.records,
      'account.tax.group': [...(db.records['account.tax.group'] ?? []), { id: 993, name: 'Group Foreign Receivable', company_id: 1, tax_receivable_account_id: branchReceivable.id }],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, stagedForeignReceivable), { isAdmin: true }),
    /Tax receivable account must belong to the tax group company/i,
  );

  // Guard test: tax_receivable_account_id must be an asset account
  const stagedWrongTypeReceivable = {
    ...db,
    records: {
      ...db.records,
      'account.tax.group': [...(db.records['account.tax.group'] ?? []), { id: 994, name: 'Group Wrong Type Receivable', company_id: 1, tax_receivable_account_id: liabilityWrongForReceivable.id }],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, stagedWrongTypeReceivable), { isAdmin: true }),
    /Tax receivable account must be an asset account/i,
  );

  // Valid accounts pass diffDb + applyDiff
  const validGroupStaged = create(db, 'account.tax.group', {
    name: 'Valid Group',
    company_id: 1,
    tax_payable_account_id: validPayable.id,
    tax_receivable_account_id: validReceivable.id,
  });
  const synced = applyDiff(db, diffDb(db, validGroupStaged.db), { isAdmin: true });
  const saved = read(synced, 'account.tax.group', validGroupStaged.id);
  assert.equal(saved.tax_payable_account_id, validPayable.id);
  assert.equal(saved.tax_receivable_account_id, validReceivable.id);
});

test('TAX-8: two tax groups closing to their own accounts', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  // Group 1 accounts
  const p1 = create(db, 'account.account', { code: '251821', name: 'Group 1 Payable', account_type: 'liability_current', company_id: 1 });
  db = p1.db;
  const r1 = create(db, 'account.account', { code: '131821', name: 'Group 1 Receivable', account_type: 'asset_current', company_id: 1 });
  db = r1.db;

  // Group 2 accounts
  const p2 = create(db, 'account.account', { code: '251822', name: 'Group 2 Payable', account_type: 'liability_current', company_id: 1 });
  db = p2.db;
  const r2 = create(db, 'account.account', { code: '131822', name: 'Group 2 Receivable', account_type: 'asset_current', company_id: 1 });
  db = r2.db;

  // Tax accounts
  const tax1OutAcc = create(db, 'account.account', { code: '251831', name: 'Tax 1 Output Account', account_type: 'liability_current', company_id: 1 });
  db = tax1OutAcc.db;
  const tax2InAcc = create(db, 'account.account', { code: '131832', name: 'Tax 2 Input Account', account_type: 'asset_current', company_id: 1 });
  db = tax2InAcc.db;

  // Tax groups
  const group1 = create(db, 'account.tax.group', {
    name: 'Tax Group 1', company_id: 1, tax_payable_account_id: p1.id, tax_receivable_account_id: r1.id,
  });
  db = group1.db;
  const group2 = create(db, 'account.tax.group', {
    name: 'Tax Group 2', company_id: 1, tax_payable_account_id: p2.id, tax_receivable_account_id: r2.id,
  });
  db = group2.db;

  // Tax 1: sale tax 10% in Group 1
  const tax1Res = create(db, 'account.tax', {
    name: 'Sale Tax Group 1',
    company_id: 1,
    type_tax_use: 'sale',
    amount: 10,
    amount_type: 'percent',
    tax_group_id: group1.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax1OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax1OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax1Res.db;
  const tax1 = read(db, 'account.tax', tax1Res.id);

  // Tax 2: purchase tax 20% in Group 2
  const tax2Res = create(db, 'account.tax', {
    name: 'Purchase Tax Group 2',
    company_id: 1,
    type_tax_use: 'purchase',
    amount: 20,
    amount_type: 'percent',
    tax_group_id: group2.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax2InAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax2InAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax2Res.db;
  const tax2 = read(db, 'account.tax', tax2Res.id);

  // Post invoice with Tax 1: 100 base -> 10.00 output tax on tax1OutAcc
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-05-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale Item', qty: 1, price_unit: 100, ...taxSnapshot(tax1) }],
  });
  db = postMove(inv.db, inv.id);

  // Post bill with Tax 2: 150 base -> 30.00 input tax on tax2InAcc
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: env.partnerId, invoice_date: '2026-05-12', company_id: 1,
    invoice_line_ids: [{ name: 'Purchase Item', qty: 1, price_unit: 150, ...taxSnapshot(tax2) }],
  });
  db = postMove(bill.db, bill.id);

  const ret = create(db, 'account.return', {
    name: 'VAT May 2026', type_id: env.vatType.id, date_from: '2026-05-01', date_to: '2026-05-31', company_id: 1,
  });
  const reviewed = reviewReturn(ret.db, ret.id);
  const submitted = submitReturn(reviewed, ret.id);

  // Sync diff-verifiable
  const synced = applyDiff(reviewed, diffDb(reviewed, submitted), { isAdmin: true });
  const subRet = read(synced, 'account.return', ret.id);
  assert.equal(subRet.total_amount_to_pay, -20);
  assert.equal(taxClosingMatchesReturn(synced, subRet), true);

  const closingMove = read(synced, 'account.move', subRet.closing_move_ids[0]);

  // Tax accounts are closed
  const tax1CloseLine = closingMove.line_ids.find((l) => l.account_id === tax1OutAcc.id);
  assert.ok(tax1CloseLine, 'Tax 1 output account is closed');
  assert.equal(tax1CloseLine.debit, 10);

  const tax2CloseLine = closingMove.line_ids.find((l) => l.account_id === tax2InAcc.id);
  assert.ok(tax2CloseLine, 'Tax 2 input account is closed');
  assert.equal(tax2CloseLine.credit, 30);

  // Group 1 net (+10 due) nets into Group 1's payable account (p1)
  const g1Line = closingMove.line_ids.find((l) => l.account_id === p1.id);
  assert.ok(g1Line, 'Group 1 payable line booked to Group 1 payable account');
  assert.equal(g1Line.credit, 10);
  assert.equal(g1Line.debit, 0);

  // Group 2 net (-30 recoverable) nets into Group 2's receivable account (r2)
  const g2Line = closingMove.line_ids.find((l) => l.account_id === r2.id);
  assert.ok(g2Line, 'Group 2 receivable line booked to Group 2 receivable account');
  assert.equal(g2Line.debit, 30);
  assert.equal(g2Line.credit, 0);

  // Neither default payable nor default receivable account was touched
  assert.ok(!closingMove.line_ids.some((l) => l.account_id === env.defPayableAccId));
  assert.ok(!closingMove.line_ids.some((l) => l.account_id === env.defReceivableAccId));

  // Balances of tax accounts cleared to 0
  assert.equal(accountBalanceUpTo(synced, tax1OutAcc.id, '2026-05-31'), 0);
  assert.equal(accountBalanceUpTo(synced, tax2InAcc.id, '2026-05-31'), 0);
});

test('TAX-8: a group without accounts falling back to company defaults', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  // Group 1 has its own payable account
  const p1 = create(db, 'account.account', { code: '251841', name: 'Group 1 Payable Only', account_type: 'liability_current', company_id: 1 });
  db = p1.db;

  // Group 2 has NO accounts configured
  const group1 = create(db, 'account.tax.group', {
    name: 'Tax Group 1 With Account', company_id: 1, tax_payable_account_id: p1.id, tax_receivable_account_id: null,
  });
  db = group1.db;
  const group2 = create(db, 'account.tax.group', {
    name: 'Tax Group 2 Without Accounts', company_id: 1, tax_payable_account_id: null, tax_receivable_account_id: null,
  });
  db = group2.db;

  const tax1OutAcc = create(db, 'account.account', { code: '251851', name: 'Tax 1 Output Acc', account_type: 'liability_current', company_id: 1 });
  db = tax1OutAcc.db;
  const tax2OutAcc = create(db, 'account.account', { code: '251852', name: 'Tax 2 Output Acc', account_type: 'liability_current', company_id: 1 });
  db = tax2OutAcc.db;

  const tax1Res = create(db, 'account.tax', {
    name: 'Tax Group 1 Tax', company_id: 1, type_tax_use: 'sale', amount: 15, amount_type: 'percent', tax_group_id: group1.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax1OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax1OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax1Res.db;
  const tax1 = read(db, 'account.tax', tax1Res.id);

  const tax2Res = create(db, 'account.tax', {
    name: 'Tax Group 2 Tax', company_id: 1, type_tax_use: 'sale', amount: 25, amount_type: 'percent', tax_group_id: group2.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax2OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax2OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax2Res.db;
  const tax2 = read(db, 'account.tax', tax2Res.id);

  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-06-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale Item 1', qty: 1, price_unit: 100, ...taxSnapshot(tax1) }],
  });
  db = postMove(inv1.db, inv1.id);

  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-06-12', company_id: 1,
    invoice_line_ids: [{ name: 'Sale Item 2', qty: 1, price_unit: 100, ...taxSnapshot(tax2) }],
  });
  db = postMove(inv2.db, inv2.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Jun 2026', type_id: env.vatType.id, date_from: '2026-06-01', date_to: '2026-06-30', company_id: 1,
  });
  const reviewed = reviewReturn(ret.db, ret.id);
  const submitted = submitReturn(reviewed, ret.id);

  const synced = applyDiff(reviewed, diffDb(reviewed, submitted), { isAdmin: true });
  const subRet = read(synced, 'account.return', ret.id);
  assert.equal(subRet.total_amount_to_pay, 40);
  assert.equal(taxClosingMatchesReturn(synced, subRet), true);

  const closingMove = read(synced, 'account.move', subRet.closing_move_ids[0]);

  // Group 1 nets to p1
  const g1Line = closingMove.line_ids.find((l) => l.account_id === p1.id);
  assert.ok(g1Line, 'Group 1 payable line booked to Group 1 payable account');
  assert.equal(g1Line.credit, 15);

  // Group 2 without accounts falls back to env.defPayableAccId
  const fallbackLine = closingMove.line_ids.find((l) => l.account_id === env.defPayableAccId);
  assert.ok(fallbackLine, 'Group 2 falls back to company default payable account');
  assert.equal(fallbackLine.credit, 25);

  assert.equal(accountBalanceUpTo(synced, tax1OutAcc.id, '2026-06-30'), 0);
  assert.equal(accountBalanceUpTo(synced, tax2OutAcc.id, '2026-06-30'), 0);
});

test('TAX-13: a repartition line excluded from closing stays out of the closing entry', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const repField = models['account.tax'].fields.invoice_repartition_line_ids;
  assert.ok(repField.fields.use_in_tax_closing, 'use_in_tax_closing field exists on repartition lines');
  assert.equal(repField.fields.use_in_tax_closing.type, 'boolean');

  // New line in repartition field defaults use_in_tax_closing to true for tax lines
  assert.equal(repField.newLine().use_in_tax_closing, true);

  const deductibleVatAcc = create(db, 'account.account', {
    code: '131861', name: 'Deductible Input VAT Account', account_type: 'asset_current', company_id: 1,
  });
  db = deductibleVatAcc.db;

  const nonDeductibleExpenseAcc = create(db, 'account.account', {
    code: '600862', name: 'Non-Deductible VAT Expense Account', account_type: 'expense', company_id: 1,
  });
  db = nonDeductibleExpenseAcc.db;

  // Purchase tax with 50% deductible (use_in_tax_closing: true) and 50% non-deductible expense (use_in_tax_closing: false)
  const splitTaxRes = create(db, 'account.tax', {
    name: 'Split Deductible Tax 20%',
    company_id: 1,
    type_tax_use: 'purchase',
    amount: 20,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: deductibleVatAcc.id, tag_ids: [], use_in_tax_closing: true },
      { repartition_type: 'tax', factor_percent: 50, account_id: nonDeductibleExpenseAcc.id, tag_ids: [], use_in_tax_closing: false },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: deductibleVatAcc.id, tag_ids: [], use_in_tax_closing: true },
      { repartition_type: 'tax', factor_percent: 50, account_id: nonDeductibleExpenseAcc.id, tag_ids: [], use_in_tax_closing: false },
    ],
  });
  db = splitTaxRes.db;
  const splitTax = read(db, 'account.tax', splitTaxRes.id);

  // Post vendor bill: 100 base -> 10.00 to deductibleVatAcc, 10.00 to nonDeductibleExpenseAcc
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: env.partnerId, invoice_date: '2026-07-10', company_id: 1,
    invoice_line_ids: [{ name: 'Partially Deductible Purchase', qty: 1, price_unit: 100, ...taxSnapshot(splitTax) }],
  });
  db = postMove(bill.db, bill.id);

  // Before closing: both accounts have debits
  assert.equal(accountBalanceUpTo(db, deductibleVatAcc.id, '2026-07-31'), 10);
  assert.equal(accountBalanceUpTo(db, nonDeductibleExpenseAcc.id, '2026-07-31'), 10);

  // Non-closing line still appears in the tax report
  const rep = taxReport(db, { from: '2026-07-01', to: '2026-07-31', company_id: 1 });
  assert.equal(rep.input, 20, 'Tax report includes both deductible and non-deductible tax lines');
  assert.equal(rep.payable, -20, 'Tax report shows full tax amount');

  const ret = create(db, 'account.return', {
    name: 'VAT Jul 2026', type_id: env.vatType.id, date_from: '2026-07-01', date_to: '2026-07-31', company_id: 1,
  });
  const reviewed = reviewReturn(ret.db, ret.id);
  const submitted = submitReturn(reviewed, ret.id);

  const synced = applyDiff(reviewed, diffDb(reviewed, submitted), { isAdmin: true });
  const subRet = read(synced, 'account.return', ret.id);
  assert.equal(subRet.total_amount_to_pay, -10);
  assert.equal(taxClosingMatchesReturn(synced, subRet), true);

  const closingMove = read(synced, 'account.move', subRet.closing_move_ids[0]);

  // Deductible account is closed
  const closedLine = closingMove.line_ids.find((l) => l.account_id === deductibleVatAcc.id);
  assert.ok(closedLine, 'Deductible VAT account is closed in closing entry');
  assert.equal(closedLine.credit, 10);

  // Non-deductible expense account is NOT in the closing move
  const nonDeductibleLine = closingMove.line_ids.find((l) => l.account_id === nonDeductibleExpenseAcc.id);
  assert.equal(nonDeductibleLine, undefined, 'Excluded repartition account stays out of the closing entry');

  // Closing move is balanced
  const totalDebit = round(closingMove.line_ids.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const totalCredit = round(closingMove.line_ids.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  assert.equal(totalDebit, totalCredit, 'Closing move is balanced');

  // Deductible account is cleared to 0
  assert.equal(accountBalanceUpTo(synced, deductibleVatAcc.id, '2026-07-31'), 0);

  // Non-deductible account balance stays on the expense account (untouched by closing)
  assert.equal(accountBalanceUpTo(synced, nonDeductibleExpenseAcc.id, '2026-07-31'), 10);
});

test('TAX-8: group resolution uses tax_id when present, else account group only if unique among closing rows', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const p1 = create(db, 'account.account', { code: '251871', name: 'Group 1 Payable', account_type: 'liability_current', company_id: 1 });
  db = p1.db;
  const p2 = create(db, 'account.account', { code: '251872', name: 'Group 2 Payable', account_type: 'liability_current', company_id: 1 });
  db = p2.db;

  const group1 = create(db, 'account.tax.group', {
    name: 'Group 1 Multi', company_id: 1, tax_payable_account_id: p1.id,
  });
  db = group1.db;
  const group2 = create(db, 'account.tax.group', {
    name: 'Group 2 Multi', company_id: 1, tax_payable_account_id: p2.id,
  });
  db = group2.db;

  // Shared account used by Tax 1 (Group 1) and Tax 2 (Group 2)
  const sharedAcc = create(db, 'account.account', { code: '251873', name: 'Shared Closing Tax Acc', account_type: 'liability_current', company_id: 1 });
  db = sharedAcc.db;

  // Exclusive account used ONLY by Tax 3 (Group 1)
  const exclusiveAcc = create(db, 'account.account', { code: '251874', name: 'Exclusive Group 1 Acc', account_type: 'liability_current', company_id: 1 });
  db = exclusiveAcc.db;

  const tax1Res = create(db, 'account.tax', {
    name: 'Tax 1 Shared G1', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent', tax_group_id: group1.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: sharedAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: sharedAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax1Res.db;

  const tax2Res = create(db, 'account.tax', {
    name: 'Tax 2 Shared G2', company_id: 1, type_tax_use: 'sale', amount: 20, amount_type: 'percent', tax_group_id: group2.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: sharedAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: sharedAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax2Res.db;
  const tax2 = read(db, 'account.tax', tax2Res.id);

  const tax3Res = create(db, 'account.tax', {
    name: 'Tax 3 Exclusive G1', company_id: 1, type_tax_use: 'sale', amount: 15, amount_type: 'percent', tax_group_id: group1.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: exclusiveAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: exclusiveAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax3Res.db;

  // 1) Line on exclusiveAcc without tax_id -> unique group is Group 1 -> closes to p1
  db = postEntry(db, {
    journal: 'MISC', date: '2026-09-10', company: 1,
    lines: [
      { account_id: exclusiveAcc.id, credit: 15, tax_name: 'Manual Tax On Exclusive', tax_side: 'sale' },
      { account: '101401', debit: 15 },
    ],
  }).db;

  // 2) Line on sharedAcc without tax_id -> multiple groups share sharedAcc -> falls back to company default (defPayableAccId)
  db = postEntry(db, {
    journal: 'MISC', date: '2026-09-11', company: 1,
    lines: [
      { account_id: sharedAcc.id, credit: 10, tax_name: 'Manual Tax On Shared Untagged', tax_side: 'sale' },
      { account: '101401', debit: 10 },
    ],
  }).db;

  // 3) Line on sharedAcc WITH tax_id: tax2.id -> explicitly Group 2 -> closes to p2
  db = postEntry(db, {
    journal: 'MISC', date: '2026-09-12', company: 1,
    lines: [
      { account_id: sharedAcc.id, credit: 20, tax_id: tax2.id, tax_name: tax2.name, tax_side: 'sale' },
      { account: '101401', debit: 20 },
    ],
  }).db;

  const ret = create(db, 'account.return', {
    name: 'VAT Sep 2026', type_id: env.vatType.id, date_from: '2026-09-01', date_to: '2026-09-30', company_id: 1,
  });
  const reviewed = reviewReturn(ret.db, ret.id);
  const submitted = submitReturn(reviewed, ret.id);

  const synced = applyDiff(reviewed, diffDb(reviewed, submitted), { isAdmin: true });
  const subRet = read(synced, 'account.return', ret.id);
  const closingMove = read(synced, 'account.move', subRet.closing_move_ids[0]);

  // Exclusive account line without tax_id booked to Group 1 payable
  const g1Line = closingMove.line_ids.find((l) => l.account_id === p1.id);
  assert.ok(g1Line, 'Exclusive account without tax_id books to unique account group (p1)');
  assert.equal(g1Line.credit, 15);

  // Shared account line WITH tax2.id booked to Group 2 payable
  const g2Line = closingMove.line_ids.find((l) => l.account_id === p2.id);
  assert.ok(g2Line, 'Shared account with tax_id books to that tax group (p2)');
  assert.equal(g2Line.credit, 20);

  // Shared account line WITHOUT tax_id fell back to company default payable
  const defLine = closingMove.line_ids.find((l) => l.account_id === env.defPayableAccId);
  assert.ok(defLine, 'Shared account without tax_id falls back to company default payable');
  assert.equal(defLine.credit, 10);
});

test('TAX-8: resolveTaxGroupAccount throws when configured account is invalid (archived or foreign company)', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const p1 = create(db, 'account.account', { code: '251881', name: 'G1 Payable Valid', account_type: 'liability_current', company_id: 1 });
  db = p1.db;

  const taxAcc = create(db, 'account.account', { code: '251882', name: 'Tax Out Acc', account_type: 'liability_current', company_id: 1 });
  db = taxAcc.db;

  const group1 = create(db, 'account.tax.group', {
    name: 'Group 1 Strict', company_id: 1, tax_payable_account_id: p1.id,
  });
  db = group1.db;

  const tax1Res = create(db, 'account.tax', {
    name: 'Tax 1 Strict', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent', tax_group_id: group1.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax1Res.db;
  const tax1 = read(db, 'account.tax', tax1Res.id);

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-10-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale Item', qty: 1, price_unit: 100, ...taxSnapshot(tax1) }],
  });
  db = postMove(inv.db, inv.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Oct 2026', type_id: env.vatType.id, date_from: '2026-10-01', date_to: '2026-10-31', company_id: 1, state: 'reviewed',
  });
  db = ret.db;
  const retRecord = read(db, 'account.return', ret.id);

  // Case 1: archived configured account throws clear error
  let badDb = write(db, 'account.account', p1.id, { active: false });
  assert.throws(() => taxClosingSpec(badDb, retRecord), /is archived/i);

  // Case 2: foreign company configured account throws clear error
  const branch = createCompany(db, { name: 'Branch For Tax Group' });
  badDb = branch.db;
  const branchAcc = create(badDb, 'account.account', { code: '251883', name: 'Branch Payable', account_type: 'liability_current', company_id: branch.id });
  badDb = branchAcc.db;
  badDb = {
    ...badDb,
    records: {
      ...badDb.records,
      'account.tax.group': (badDb.records['account.tax.group'] ?? []).map((g) => (g.id === group1.id ? { ...g, tax_payable_account_id: branchAcc.id } : g)),
    },
  };
  assert.throws(() => taxClosingSpec(badDb, retRecord), /belong to the tax group company/i);

  // Case 3: unconfigured account (null) falls back cleanly without error
  const okDb = write(db, 'account.tax.group', group1.id, { tax_payable_account_id: null });
  const spec = taxClosingSpec(okDb, retRecord);
  assert.ok(spec.lines.some((l) => l.account_id === env.defPayableAccId));
});

test('TAX-8: closing entry balances and payable equals report.payable with rounding difference across two groups', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const p1 = create(db, 'account.account', { code: '251891', name: 'Group 1 Payable Rnd', account_type: 'liability_current', company_id: 1 });
  db = p1.db;
  const p2 = create(db, 'account.account', { code: '251892', name: 'Group 2 Payable Rnd', account_type: 'liability_current', company_id: 1 });
  db = p2.db;

  const tax1OutAcc = create(db, 'account.account', { code: '251893', name: 'Tax 1 Out Rnd', account_type: 'liability_current', company_id: 1 });
  db = tax1OutAcc.db;
  const tax2OutAcc = create(db, 'account.account', { code: '251894', name: 'Tax 2 Out Rnd', account_type: 'liability_current', company_id: 1 });
  db = tax2OutAcc.db;

  const group1 = create(db, 'account.tax.group', {
    name: 'Group 1 Rnd', company_id: 1, tax_payable_account_id: p1.id,
  });
  db = group1.db;
  const group2 = create(db, 'account.tax.group', {
    name: 'Group 2 Rnd', company_id: 1, tax_payable_account_id: p2.id,
  });
  db = group2.db;

  const tax1Res = create(db, 'account.tax', {
    name: 'Sale Tax G1 Rnd', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent', tax_group_id: group1.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax1OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax1OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax1Res.db;
  const tax1 = read(db, 'account.tax', tax1Res.id);

  const tax2Res = create(db, 'account.tax', {
    name: 'Sale Tax G2 Rnd', company_id: 1, type_tax_use: 'sale', amount: 20, amount_type: 'percent', tax_group_id: group2.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax2OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax2OutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = tax2Res.db;
  const tax2 = read(db, 'account.tax', tax2Res.id);

  // Group 1 invoice: 100 base -> 10 tax
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2027-01-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale G1', qty: 1, price_unit: 100, ...taxSnapshot(tax1) }],
  });
  db = postMove(inv1.db, inv1.id);

  // Group 2 invoice: 100 base -> 20 tax
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2027-01-12', company_id: 1,
    invoice_line_ids: [{ name: 'Sale G2', qty: 1, price_unit: 100, ...taxSnapshot(tax2) }],
  });
  db = postMove(inv2.db, inv2.id);

  // Add 0.03 rounding adjustment on tax1OutAcc: ledger balance becomes 10.03, report is 30.00
  db = postEntry(db, {
    journal: 'MISC', date: '2027-01-15', company: 1, ref: 'Tax rounding difference',
    lines: [
      { account_id: tax1OutAcc.id, credit: 0.03, tax_id: tax1.id, tax_name: tax1.name, tax_zero: true },
      { account: '101401', debit: 0.03 },
    ],
  }).db;

  const rep = taxReport(db, { from: '2027-01-01', to: '2027-01-31', company_id: 1 });
  assert.equal(rep.output, 30);
  assert.equal(rep.payable, 30);

  const ret = create(db, 'account.return', {
    name: 'VAT Jan 2027', type_id: env.vatType.id, date_from: '2027-01-01', date_to: '2027-01-31', company_id: 1,
  });
  const reviewed = reviewReturn(ret.db, ret.id);
  const submitted = submitReturn(reviewed, ret.id);

  const synced = applyDiff(reviewed, diffDb(reviewed, submitted), { isAdmin: true });
  const subRet = read(synced, 'account.return', ret.id);
  assert.equal(subRet.total_amount_to_pay, 30);
  assert.equal(taxClosingMatchesReturn(synced, subRet), true);

  const closingMove = read(synced, 'account.move', subRet.closing_move_ids[0]);

  // Prove closing entry balances
  const totalDebit = round(closingMove.line_ids.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const totalCredit = round(closingMove.line_ids.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  assert.equal(totalDebit, totalCredit, 'Closing move must be balanced');
  assert.equal(totalDebit, 30.03);

  // Rounding line booked with credit 0.03
  const profitLine = closingMove.line_ids.find((l) => l.account_id === env.profitAccId);
  assert.ok(profitLine, 'Rounding profit line exists');
  assert.equal(profitLine.credit, 0.03);

  // Group payable lines exist
  const g1Line = closingMove.line_ids.find((l) => l.account_id === p1.id);
  const g2Line = closingMove.line_ids.find((l) => l.account_id === p2.id);
  assert.ok(g1Line, 'Group 1 payable line exists');
  assert.ok(g2Line, 'Group 2 payable line exists');

  // Prove group payable lines total EXACTLY equals report.payable (30.00)
  const payableTotal = round(Number(g1Line.credit) + Number(g2Line.credit));
  assert.equal(payableTotal, rep.payable, 'Group payable total must equal report.payable');
  assert.equal(payableTotal, 30);

  // Tax accounts completely cleared
  assert.equal(accountBalanceUpTo(synced, tax1OutAcc.id, '2027-01-31'), 0);
  assert.equal(accountBalanceUpTo(synced, tax2OutAcc.id, '2027-01-31'), 0);
});

test('TAX-8: paying a return with group-configured payable accounts settles every closing obligation', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const p1 = create(db, 'account.account', { code: '251901', name: 'Group 1 Own Payable', account_type: 'liability_current', company_id: 1 });
  db = p1.db;
  const p2 = create(db, 'account.account', { code: '251902', name: 'Group 2 Own Payable', account_type: 'liability_current', company_id: 1 });
  db = p2.db;
  const tax1Acc = create(db, 'account.account', { code: '251903', name: 'Tax 1 Out Pay', account_type: 'liability_current', company_id: 1 });
  db = tax1Acc.db;
  const tax2Acc = create(db, 'account.account', { code: '251904', name: 'Tax 2 Out Pay', account_type: 'liability_current', company_id: 1 });
  db = tax2Acc.db;

  const g1 = create(db, 'account.tax.group', { name: 'Pay Group 1', company_id: 1, tax_payable_account_id: p1.id });
  db = g1.db;
  const g2 = create(db, 'account.tax.group', { name: 'Pay Group 2', company_id: 1, tax_payable_account_id: p2.id });
  db = g2.db;

  const t1Res = create(db, 'account.tax', {
    name: 'Sale Tax P1', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent', tax_group_id: g1.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax1Acc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax1Acc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = t1Res.db;
  const t1 = read(db, 'account.tax', t1Res.id);

  // Case A: Single group with custom payable p1
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-05-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale A', qty: 1, price_unit: 100, ...taxSnapshot(t1) }],
  });
  db = postMove(inv1.db, inv1.id);

  const retA = create(db, 'account.return', {
    name: 'VAT May 2026 Pay', type_id: env.vatType.id, date_from: '2026-05-01', date_to: '2026-05-31', company_id: 1,
  });
  const revA = reviewReturn(retA.db, retA.id);
  const subA = submitReturn(revA, retA.id);

  // Guard: posting payment to the default return-type account instead of the group's p1 must throw
  const wrongPay = create(subA, 'account.payment', {
    partner_id: env.vatType.payment_partner_id,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 10,
    date: '2026-06-05',
    company_id: 1,
    state: 'draft',
    destination_account_id: env.defPayableAccId,
    is_tax_payment: true,
    return_id: retA.id,
  });
  assert.throws(() => postPayment(wrongPay.db, read(wrongPay.db, 'account.payment', wrongPay.id)), /Payment must match the tax return obligation/i);

  // Paying via payReturn succeeds, creates payment to p1, clears p1, and passes applyDiff
  const paidA = payReturn(subA, retA.id);
  const syncedPaidA = applyDiff(subA, diffDb(subA, paidA), { isAdmin: true });
  const paidRecA = read(syncedPaidA, 'account.return', retA.id);
  assert.equal(paidRecA.state, 'paid');
  assert.equal(paidRecA.is_completed, true);
  assert.equal(paidRecA.payment_ids.length, 1);
  assert.equal(read(syncedPaidA, 'account.payment', paidRecA.payment_ids[0]).destination_account_id, p1.id);
  assert.equal(accountBalanceUpTo(syncedPaidA, p1.id, '2099-12-31'), 0);
  assert.equal(accountBalanceUpTo(syncedPaidA, env.defPayableAccId, '2099-12-31'), 0);

  // Case B: Multiple groups (p1 and p2) in one return -> both obligations paid and settled
  const t2Res = create(db, 'account.tax', {
    name: 'Sale Tax P2', company_id: 1, type_tax_use: 'sale', amount: 20, amount_type: 'percent', tax_group_id: g2.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax2Acc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: tax2Acc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  let dbB = t2Res.db;
  const t2 = read(dbB, 'account.tax', t2Res.id);

  const invB1 = create(dbB, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-06-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale B1', qty: 1, price_unit: 100, ...taxSnapshot(t1) }],
  });
  dbB = postMove(invB1.db, invB1.id);
  const invB2 = create(dbB, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-06-12', company_id: 1,
    invoice_line_ids: [{ name: 'Sale B2', qty: 1, price_unit: 100, ...taxSnapshot(t2) }],
  });
  dbB = postMove(invB2.db, invB2.id);

  const retB = create(dbB, 'account.return', {
    name: 'VAT Jun 2026 Pay', type_id: env.vatType.id, date_from: '2026-06-01', date_to: '2026-06-30', company_id: 1,
  });
  const revB = reviewReturn(retB.db, retB.id);
  const subB = submitReturn(revB, retB.id);
  const paidB = payReturn(subB, retB.id);
  const syncedPaidB = applyDiff(subB, diffDb(subB, paidB), { isAdmin: true });
  const paidRecB = read(syncedPaidB, 'account.return', retB.id);
  assert.equal(paidRecB.state, 'paid');
  assert.equal(paidRecB.payment_ids.length, 2);
  const destAccounts = paidRecB.payment_ids.map((pid) => read(syncedPaidB, 'account.payment', pid).destination_account_id).sort((a, b) => a - b);
  assert.deepEqual(destAccounts, [p1.id, p2.id].sort((a, b) => a - b));
  assert.equal(accountBalanceUpTo(syncedPaidB, p1.id, '2099-12-31'), 0);
  assert.equal(accountBalanceUpTo(syncedPaidB, p2.id, '2099-12-31'), 0);
});

test('TAX-8: tax unit settlement clears member group-account obligations across two groups and balances intercompany entries', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let db = write(env.db, 'res.company', 1, { country: 'Egypt' });
  const branch = createCompanyWithDefaultInvoiceJournals(db, { name: 'Unit Member Co', country: 'Egypt' });
  db = ensureReturnTypes(branch.db);
  const memberId = branch.id;

  const mainPartner = create(db, 'res.partner', { name: 'Main Co Contact' });
  db = mainPartner.db;
  const memberPartner = create(db, 'res.partner', { name: 'Member Co Contact' });
  db = memberPartner.db;
  db = write(db, 'res.company', 1, { partner_id: mainPartner.id });
  db = write(db, 'res.company', memberId, { partner_id: memberPartner.id });

  const memberType = search(db, 'account.return.type').find((t) => t.company_id === memberId && t.name === 'VAT Return');
  const mDefPay = create(db, 'account.account', { code: '251910', name: 'Member Def Payable', account_type: 'liability_current', company_id: memberId });
  db = mDefPay.db;
  const mDefRec = create(db, 'account.account', { code: '131910', name: 'Member Def Receivable', account_type: 'asset_current', company_id: memberId });
  db = mDefRec.db;
  db = write(db, 'account.return.type', memberType.id, {
    tax_payable_account_id: mDefPay.id,
    tax_receivable_account_id: mDefRec.id,
    payment_partner_id: env.vatType.payment_partner_id,
  });

  // Member IC accounts for Main Co partner and Main IC accounts for Member Co partner
  const mainIcRec = create(db, 'account.account', { code: '121911', name: 'Main IC Receivable', account_type: 'asset_receivable', company_id: 1, reconcile: true });
  db = mainIcRec.db;
  const mainIcPay = create(db, 'account.account', { code: '211911', name: 'Main IC Payable', account_type: 'liability_payable', company_id: 1, reconcile: true });
  db = mainIcPay.db;
  db = write(db, 'res.partner', memberPartner.id, {
    property_account_receivable_id: mainIcRec.id,
    property_account_payable_id: mainIcPay.id,
  });
  const memIcRec = create(db, 'account.account', { code: '121912', name: 'Member IC Receivable', account_type: 'asset_receivable', company_id: memberId, reconcile: true });
  db = memIcRec.db;
  const memIcPay = create(db, 'account.account', { code: '211912', name: 'Member IC Payable', account_type: 'liability_payable', company_id: memberId, reconcile: true });
  db = memIcPay.db;
  db = write(db, 'res.partner', mainPartner.id, {
    property_account_receivable_id: memIcRec.id,
    property_account_payable_id: memIcPay.id,
  });

  const unit = create(db, 'account.tax.unit', {
    name: 'Group Tax Unit',
    country: 'Egypt',
    company_ids: [1, memberId],
    main_company_id: 1,
    member_return_type_ids: [{ company_id: memberId, type_id: memberType.id }],
  });
  db = unit.db;

  // Main company sale tax (50 due)
  const mainTaxOut = create(db, 'account.account', { code: '251915', name: 'Main Tax Out', account_type: 'liability_current', company_id: 1 });
  db = mainTaxOut.db;
  const mainTaxRes = create(db, 'account.tax', {
    name: 'Main Sale 10%', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: mainTaxOut.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: mainTaxOut.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = mainTaxRes.db;
  const mainInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-07-10', company_id: 1,
    invoice_line_ids: [{ name: 'Main Sale', qty: 1, price_unit: 500, ...taxSnapshot(read(db, 'account.tax', mainTaxRes.id)) }],
  });
  db = postMove(mainInv.db, mainInv.id);

  // Member company TWO groups on DIFFERENT custom accounts: mp1 (+15 payable), mr2 (-40 receivable) -> member net -25
  const mp1 = create(db, 'account.account', { code: '251916', name: 'Member G1 Payable', account_type: 'liability_current', company_id: memberId });
  db = mp1.db;
  const mr2 = create(db, 'account.account', { code: '131917', name: 'Member G2 Receivable', account_type: 'asset_current', company_id: memberId });
  db = mr2.db;
  const mTaxOutAcc = create(db, 'account.account', { code: '251918', name: 'Member G1 Out', account_type: 'liability_current', company_id: memberId });
  db = mTaxOutAcc.db;
  const mTaxInAcc = create(db, 'account.account', { code: '131919', name: 'Member G2 In', account_type: 'asset_current', company_id: memberId });
  db = mTaxInAcc.db;

  const mg1 = create(db, 'account.tax.group', { name: 'Member Group 1', company_id: memberId, tax_payable_account_id: mp1.id });
  db = mg1.db;
  const mg2 = create(db, 'account.tax.group', { name: 'Member Group 2', company_id: memberId, tax_receivable_account_id: mr2.id });
  db = mg2.db;

  const mTax1Res = create(db, 'account.tax', {
    name: 'Member Sale 15%', company_id: memberId, type_tax_use: 'sale', amount: 15, amount_type: 'percent', tax_group_id: mg1.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: mTaxOutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: mTaxOutAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = mTax1Res.db;
  const mTax2Res = create(db, 'account.tax', {
    name: 'Member Purch 20%', company_id: memberId, type_tax_use: 'purchase', amount: 20, amount_type: 'percent', tax_group_id: mg2.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: mTaxInAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: mTaxInAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = mTax2Res.db;

  const mInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-07-12', company_id: memberId,
    invoice_line_ids: [{ name: 'Member Sale', qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', mTax1Res.id)) }],
  });
  db = postMove(mInv.db, mInv.id);
  const mBill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: env.partnerId, invoice_date: '2026-07-14', company_id: memberId,
    invoice_line_ids: [{ name: 'Member Purch', qty: 1, price_unit: 200, ...taxSnapshot(read(db, 'account.tax', mTax2Res.id)) }],
  });
  db = postMove(mBill.db, mBill.id);

  const ret = create(db, 'account.return', {
    name: 'Unit VAT Jul 2026', type_id: env.vatType.id, tax_unit_id: unit.id,
    date_from: '2026-07-01', date_to: '2026-07-31', company_id: 1,
  });
  const rev = reviewReturn(ret.db, ret.id);
  assert.equal(read(rev, 'account.return', ret.id).total_amount_to_pay, 25);

  const sub = submitReturn(rev, ret.id);
  const paid = payReturn(sub, ret.id);
  const synced = applyDiff(sub, diffDb(sub, paid), { isAdmin: true });
  assert.equal(read(synced, 'account.return', ret.id).state, 'paid');

  // Every tax and group account across both companies is cleared to 0
  assert.equal(accountBalanceUpTo(synced, mp1.id, '2099-12-31', memberId), 0);
  assert.equal(accountBalanceUpTo(synced, mr2.id, '2099-12-31', memberId), 0);
  assert.equal(accountBalanceUpTo(synced, mDefPay.id, '2099-12-31', memberId), 0);
  assert.equal(accountBalanceUpTo(synced, mDefRec.id, '2099-12-31', memberId), 0);
  assert.equal(accountBalanceUpTo(synced, env.defPayableAccId, '2099-12-31', 1), 0);

  // Intercompany entry in member cleared both mp1 (debit 15) and mr2 (credit 40) cleanly and balanced
  const memberSettlementMove = (synced.records['account.move'] ?? []).find((m) => (
    m.company_id === memberId && m.is_tax_payment && m.tax_return_id === ret.id && !(read(synced, 'account.return', ret.id).closing_move_ids ?? []).includes(m.id)
  ));
  assert.ok(memberSettlementMove, 'Member settlement move exists');
  assert.equal(memberSettlementMove.line_ids.find((l) => l.account_id === mp1.id)?.debit, 15);
  assert.equal(memberSettlementMove.line_ids.find((l) => l.account_id === mr2.id)?.credit, 40);
  assert.equal(memberSettlementMove.line_ids.find((l) => l.account_id === memIcRec.id)?.debit, 25);
});

test('TAX-13: per-line exclusion works when included/excluded rows share an account and when invoice/refund flags differ', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  // Case A: Included and excluded row sharing the SAME account on a purchase tax
  const sharedPurchAcc = create(db, 'account.account', { code: '131921', name: 'Shared Input VAT Acc', account_type: 'asset_current', company_id: 1 });
  db = sharedPurchAcc.db;

  const splitSharedTaxRes = create(db, 'account.tax', {
    name: 'Shared Acc Split 20%', company_id: 1, type_tax_use: 'purchase', amount: 20, amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: sharedPurchAcc.id, tag_ids: [], use_in_tax_closing: true },
      { repartition_type: 'tax', factor_percent: 50, account_id: sharedPurchAcc.id, tag_ids: [], use_in_tax_closing: false },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: sharedPurchAcc.id, tag_ids: [], use_in_tax_closing: true },
      { repartition_type: 'tax', factor_percent: 50, account_id: sharedPurchAcc.id, tag_ids: [], use_in_tax_closing: false },
    ],
  });
  db = splitSharedTaxRes.db;
  const splitSharedTax = read(db, 'account.tax', splitSharedTaxRes.id);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: env.partnerId, invoice_date: '2027-05-10', company_id: 1,
    invoice_line_ids: [{ name: 'Shared Split Purchase', qty: 1, price_unit: 100, ...taxSnapshot(splitSharedTax) }],
  });
  db = postMove(bill.db, bill.id);

  // Full tax report shows 20 input tax; reviewReturn stores -10 (closable portion only) before posting
  const repA = taxReport(db, { from: '2027-05-01', to: '2027-05-31', company_id: 1 });
  assert.equal(repA.input, 20);
  const retA = create(db, 'account.return', {
    name: 'VAT May 2027', type_id: env.vatType.id, date_from: '2027-05-01', date_to: '2027-05-31', company_id: 1,
  });
  const revA = reviewReturn(retA.db, retA.id);
  const revRecA = read(revA, 'account.return', retA.id);
  assert.equal(revRecA.total_amount_to_pay, -10, 'reviewReturn uses closable-payable calculation without posting');
  assert.equal(revRecA.closing_move_ids.length, 0);

  const subA = submitReturn(revA, retA.id);
  const syncedA = applyDiff(revA, diffDb(revA, subA), { isAdmin: true });
  const subRecA = read(syncedA, 'account.return', retA.id);
  assert.equal(subRecA.total_amount_to_pay, -10);
  assert.equal(taxClosingMatchesReturn(syncedA, subRecA), true);

  // Only the eligible 10 is closed; the excluded 10 stays on sharedPurchAcc
  const closeA = read(syncedA, 'account.move', subRecA.closing_move_ids[0]);
  assert.equal(closeA.line_ids.find((l) => l.account_id === sharedPurchAcc.id)?.credit, 10);
  assert.equal(accountBalanceUpTo(syncedA, sharedPurchAcc.id, '2027-05-31'), 10);

  // Case B: Invoice (use_in_tax_closing: true) vs Refund (use_in_tax_closing: false) on the SAME account
  // Continue from the closed May period so the June closing does not pick up May's unclosed input tax.
  db = syncedA;
  const sharedSaleAcc = create(db, 'account.account', { code: '251922', name: 'Inv vs Ref Shared Sale Acc', account_type: 'liability_current', company_id: 1 });
  db = sharedSaleAcc.db;

  const invRefTaxRes = create(db, 'account.tax', {
    name: 'Inv Closable / Ref Excluded 10%', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: sharedSaleAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: sharedSaleAcc.id, tag_ids: [], use_in_tax_closing: false },
    ],
  });
  db = invRefTaxRes.db;
  const invRefTax = read(db, 'account.tax', invRefTaxRes.id);

  const saleInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2027-06-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale Inv', qty: 1, price_unit: 100, ...taxSnapshot(invRefTax) }], // +10 credit (closable)
  });
  db = postMove(saleInv.db, saleInv.id);
  const saleRef = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: env.partnerId, invoice_date: '2027-06-12', company_id: 1,
    invoice_line_ids: [{ name: 'Sale Ref', qty: 1, price_unit: 40, ...taxSnapshot(invRefTax) }], // 4 debit (excluded)
  });
  db = postMove(saleRef.db, saleRef.id);

  // Full report shows net 6 output, whereas closing only closes the 10 eligible invoice tax
  assert.equal(taxReport(db, { from: '2027-06-01', to: '2027-06-30', company_id: 1 }).payable, 6);
  const retB = create(db, 'account.return', {
    name: 'VAT Jun 2027', type_id: env.vatType.id, date_from: '2027-06-01', date_to: '2027-06-30', company_id: 1,
  });
  const revB = reviewReturn(retB.db, retB.id);
  assert.equal(read(revB, 'account.return', retB.id).total_amount_to_pay, 10);

  const subB = submitReturn(revB, retB.id);
  const syncedB = applyDiff(revB, diffDb(revB, subB), { isAdmin: true });
  const subRecB = read(syncedB, 'account.return', retB.id);
  assert.equal(subRecB.total_amount_to_pay, 10);
  const closeB = read(syncedB, 'account.move', subRecB.closing_move_ids[0]);
  assert.equal(closeB.line_ids.find((l) => l.account_id === sharedSaleAcc.id)?.debit, 10);
  // Refund debit of +4 remains unclosed on sharedSaleAcc
  assert.equal(accountBalanceUpTo(syncedB, sharedSaleAcc.id, '2027-06-30'), 4);
});

test('TAX-13: use_in_tax_closing stored defaults on create, migration v60, and strict stored-value read', () => {
  let db = seed();

  const expAcc = create(db, 'account.account', { code: '600931', name: 'Expense For Repartition', account_type: 'expense', company_id: 1 });
  db = expAcc.db;
  const incAcc = create(db, 'account.account', { code: '400931', name: 'Income For Repartition', account_type: 'income', company_id: 1 });
  db = incAcc.db;
  const taxLiabAcc = create(db, 'account.account', { code: '251931', name: 'Liability For Repartition', account_type: 'liability_current', company_id: 1 });
  db = taxLiabAcc.db;

  // Creating a tax sets stored `use_in_tax_closing` explicitly: true for liability/asset/null tax rows, false for income/expense tax rows and base rows
  const createdTax = create(db, 'account.tax', {
    name: 'Explicit Defaults Check',
    company_id: 1,
    type_tax_use: 'purchase',
    amount: 20,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: taxLiabAcc.id, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 25, account_id: expAcc.id, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 25, account_id: incAcc.id, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: null, tag_ids: [] },
    ],
  });
  const savedTax = read(createdTax.db, 'account.tax', createdTax.id);
  assert.strictEqual(savedTax.invoice_repartition_line_ids[0].use_in_tax_closing, false, 'base row stored false');
  assert.strictEqual(savedTax.invoice_repartition_line_ids[1].use_in_tax_closing, true, 'liability tax row defaults true');
  assert.strictEqual(savedTax.invoice_repartition_line_ids[2].use_in_tax_closing, false, 'expense tax row defaults false');
  assert.strictEqual(savedTax.invoice_repartition_line_ids[3].use_in_tax_closing, false, 'income tax row defaults false');
  assert.strictEqual(savedTax.refund_repartition_line_ids[0].use_in_tax_closing, false, 'refund base row stored false');
  assert.strictEqual(savedTax.refund_repartition_line_ids[1].use_in_tax_closing, true, 'accountless tax row defaults true');

  // isClosableRepartitionLine reads ONLY the stored boolean (never guesses from type_tax_use)
  assert.strictEqual(isClosableRepartitionLine({ repartition_type: 'tax', use_in_tax_closing: true }), true);
  assert.strictEqual(isClosableRepartitionLine({ repartition_type: 'tax', use_in_tax_closing: false }), false);
  assert.strictEqual(isClosableRepartitionLine({ repartition_type: 'tax' }), false);

  // Migration v60 backfills legacy repartition rows lacking `use_in_tax_closing`
  const stripClosing = (lines) => (lines ?? []).map(({ use_in_tax_closing: _drop, ...rest }) => rest);
  const legacyDb = {
    ...createdTax.db,
    schema_version: 59,
    records: {
      ...createdTax.db.records,
      'account.tax': (createdTax.db.records['account.tax'] ?? []).map((t) => ({
        ...t,
        invoice_repartition_line_ids: stripClosing(t.invoice_repartition_line_ids),
        refund_repartition_line_ids: stripClosing(t.refund_repartition_line_ids),
      })),
    },
  };
  assert.equal(SCHEMA_VERSION, 80);
  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 80);
  const migratedTax = read(migrated, 'account.tax', createdTax.id);
  assert.strictEqual(migratedTax.invoice_repartition_line_ids[0].use_in_tax_closing, false);
  assert.strictEqual(migratedTax.invoice_repartition_line_ids[1].use_in_tax_closing, true);
  assert.strictEqual(migratedTax.invoice_repartition_line_ids[2].use_in_tax_closing, false);
  assert.strictEqual(migratedTax.invoice_repartition_line_ids[3].use_in_tax_closing, false);
  assert.strictEqual(migrate(migrated), migrated, 'migration v60 is idempotent');
});

test('TAX-13 / Qodo 1: pre-migration cash-basis invoice with an expense tax row migrated then paid releases non-closable tax', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const expAcc = create(db, 'account.account', { code: '651921', name: 'Non-Deductible Tax Expense', account_type: 'expense', company_id: 1 });
  db = expAcc.db;
  const transAcc = create(db, 'account.account', { code: '251199', name: 'Cash Basis Transition', account_type: 'liability_current', company_id: 1 });
  db = transAcc.db;

  const taxRes = create(db, 'account.tax', {
    name: 'CB Expense Tax 10%', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent',
    tax_exigibility: 'on_payment', cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: expAcc.id, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: expAcc.id, tag_ids: [] },
    ],
  });
  db = taxRes.db;
  const tax = read(db, 'account.tax', taxRes.id);

  // Post invoice with this tax
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-08-10', company_id: 1,
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, ...taxSnapshot(tax) }],
  });
  db = postMove(inv.db, inv.id);

  // Strip use_in_tax_closing from invoice snapshot to simulate pre-migration legacy invoice
  const stripClosing = (lines) => (lines ?? []).map(({ use_in_tax_closing: _drop, ...rest }) => rest);
  const legacyDb = {
    ...db,
    schema_version: 59,
    records: {
      ...db.records,
      'account.move': (db.records['account.move'] ?? []).map((m) => m.id === inv.id ? {
        ...m,
        invoice_line_ids: (m.invoice_line_ids ?? []).map((l) => ({
          ...l,
          invoice_repartition_line_ids: stripClosing(l.invoice_repartition_line_ids),
          refund_repartition_line_ids: stripClosing(l.refund_repartition_line_ids),
        })),
      } : m),
    },
  };

  // Migrate database to v60
  const migratedDb = migrate(legacyDb, 60);
  const migratedInv = read(migratedDb, 'account.move', inv.id);
  assert.strictEqual(migratedInv.invoice_line_ids[0].invoice_repartition_line_ids[1].use_in_tax_closing, false, 'migrated invoice snapshot has use_in_tax_closing: false for expense account');

  // Pay the invoice via payMove -> cash-basis tax is released
  const paidDb = payMove(migratedDb, inv.id, 110, '2026-08-15');

  // Find the cash basis release move
  const releaseMoves = (paidDb.records['account.move'] ?? []).filter((m) => (m.ref ?? '').includes(`Cash basis taxes ${migratedInv.name}`));
  assert.ok(releaseMoves.length > 0, 'Cash basis release move exists');
  const releaseMove = releaseMoves[0];
  const releasedTaxLine = releaseMove.line_ids.find((l) => l.account_id === expAcc.id);
  assert.ok(releasedTaxLine, 'Released tax line on expense account exists');
  assert.strictEqual(releasedTaxLine.use_in_tax_closing, false, 'Released tax line is NOT closable');

  // Closing the period leaves this release out of the tax closing entry
  const ret = create(paidDb, 'account.return', {
    name: 'VAT Aug 2026', type_id: env.vatType.id, date_from: '2026-08-01', date_to: '2026-08-31', company_id: 1,
  });
  const reviewed = reviewReturn(ret.db, ret.id);
  const revRet = read(reviewed, 'account.return', ret.id);
  assert.equal(revRet.total_amount_to_pay, 0, 'No closable tax payable because expense tax was excluded');
  const submitted = submitReturn(reviewed, ret.id);
  const subRet = read(submitted, 'account.return', ret.id);
  const closingMove = read(submitted, 'account.move', subRet.closing_move_ids[0]);
  assert.ok(!closingMove.line_ids.some((l) => l.account_id === expAcc.id), 'Expense account stays out of closing entry');
});

test('TAX-13 / Qodo 2: defaultTaxRepartitionLines helper leaves use_in_tax_closing unset without db and resolves correctly on tax create', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const expAcc = create(db, 'account.account', { code: '651922', name: 'Expense For Tax', account_type: 'expense', company_id: 1 });
  db = expAcc.db;
  const liabAcc = create(db, 'account.account', { code: '251922', name: 'Liability For Tax', account_type: 'liability_current', company_id: 1 });
  db = liabAcc.db;

  // 1. Without db, defaultTaxRepartitionLines leaves use_in_tax_closing unset on tax lines
  const helperExp = defaultTaxRepartitionLines(expAcc.id, []);
  assert.strictEqual(helperExp.invoice_repartition_line_ids[1].use_in_tax_closing, undefined, 'helper omits use_in_tax_closing without db');
  assert.strictEqual(helperExp.invoice_repartition_line_ids[0].use_in_tax_closing, false, 'base line is always false');

  // 2. Creating a tax using the helper output with expense account derives use_in_tax_closing: false
  const expTaxRes = create(db, 'account.tax', {
    name: 'Helper Expense Tax', company_id: 1, type_tax_use: 'purchase', amount: 5, amount_type: 'percent',
    ...helperExp,
  });
  db = expTaxRes.db;
  const expTax = read(db, 'account.tax', expTaxRes.id);
  assert.strictEqual(expTax.invoice_repartition_line_ids[1].use_in_tax_closing, false, 'tax creation derived false for expense account');
  assert.strictEqual(expTax.refund_repartition_line_ids[1].use_in_tax_closing, false, 'refund repartition derived false for expense account');

  // 3. Creating a tax using the helper output with liability account derives use_in_tax_closing: true
  const liabTaxRes = create(db, 'account.tax', {
    name: 'Helper Liability Tax', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent',
    ...defaultTaxRepartitionLines(liabAcc.id, []),
  });
  db = liabTaxRes.db;
  const liabTax = read(db, 'account.tax', liabTaxRes.id);
  assert.strictEqual(liabTax.invoice_repartition_line_ids[1].use_in_tax_closing, true, 'tax creation derived true for liability account');

  // 4. Explicit choice is preserved even with expense account
  const explicitTaxRes = create(db, 'account.tax', {
    name: 'Explicit Override Tax', company_id: 1, type_tax_use: 'purchase', amount: 5, amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [], use_in_tax_closing: false },
      { repartition_type: 'tax', factor_percent: 100, account_id: expAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [], use_in_tax_closing: false },
      { repartition_type: 'tax', factor_percent: 100, account_id: expAcc.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = explicitTaxRes.db;
  const explicitTax = read(db, 'account.tax', explicitTaxRes.id);
  assert.strictEqual(explicitTax.invoice_repartition_line_ids[1].use_in_tax_closing, true, 'explicit true is preserved');
});

test('TAX-8 / Qodo 3: period with unpaid and paid cash-basis invoices closes successfully without unbalanced tax error', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;

  const cbTaxOut = create(db, 'account.account', { code: '251923', name: 'CB Output Tax', account_type: 'liability_current', company_id: 1 });
  db = cbTaxOut.db;
  const cbTrans = create(db, 'account.account', { code: '251123', name: 'CB Transition Acc', account_type: 'liability_current', company_id: 1 });
  db = cbTrans.db;

  const cbTaxRes = create(db, 'account.tax', {
    name: 'CB Sale 10%', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent',
    tax_exigibility: 'on_payment', cash_basis_transition_account_id: cbTrans.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: cbTaxOut.id, tag_ids: [], use_in_tax_closing: true },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: cbTaxOut.id, tag_ids: [], use_in_tax_closing: true },
    ],
  });
  db = cbTaxRes.db;
  const cbTax = read(db, 'account.tax', cbTaxRes.id);

  // Invoice 1: Posted in period (2026-09-05) and remains UNPAID (tax = 20 on transition account)
  const unpaidInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-09-05', company_id: 1,
    invoice_line_ids: [{ name: 'Unpaid Item', qty: 1, price_unit: 200, ...taxSnapshot(cbTax) }],
  });
  db = postMove(unpaidInv.db, unpaidInv.id);

  // Invoice 2: Posted in period (2026-09-10) and PAID in the same period via payMove (tax = 10 released to cbTaxOut)
  const paidInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-09-10', company_id: 1,
    invoice_line_ids: [{ name: 'Paid Item', qty: 1, price_unit: 100, ...taxSnapshot(cbTax) }],
  });
  db = postMove(paidInv.db, paidInv.id);
  db = payMove(db, paidInv.id, 110, '2026-09-12');

  // Run review and submit for the period
  const ret = create(db, 'account.return', {
    name: 'VAT Sep 2026', type_id: env.vatType.id, date_from: '2026-09-01', date_to: '2026-09-30', company_id: 1,
  });
  const reviewed = reviewReturn(ret.db, ret.id);
  const revRet = read(reviewed, 'account.return', ret.id);

  // Only the paid cash-basis tax (10.00) is due; the unpaid invoice's tax (20.00) is waiting on transition
  assert.equal(revRet.total_amount_to_pay, 10);

  const submitted = submitReturn(reviewed, ret.id);
  const subRet = read(submitted, 'account.return', ret.id);
  assert.equal(subRet.state, 'submitted');
  assert.equal(taxClosingMatchesReturn(submitted, subRet), true);

  const closingMove = read(submitted, 'account.move', subRet.closing_move_ids[0]);
  // Closing entry balances
  const debit = round(closingMove.line_ids.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const credit = round(closingMove.line_ids.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  assert.equal(debit, credit, 'Closing move balances');

  // The released tax account (cbTaxOut) is closed with debit 10
  const taxCloseLine = closingMove.line_ids.find((l) => l.account_id === cbTaxOut.id);
  assert.ok(taxCloseLine, 'Released tax account is closed');
  assert.equal(taxCloseLine.debit, 10);

  // The cash basis transition account (cbTrans) is NOT closed or touched by closing
  assert.ok(!closingMove.line_ids.some((l) => l.account_id === cbTrans.id), 'Transition account stays untouched in closing');
  // Transition account still has the 20.00 credit balance from the unpaid invoice
  assert.equal(accountBalanceUpTo(submitted, cbTrans.id, '2099-12-31'), -20);
});

test('TAX-13 / Qodo 4: a partial cash-basis release posted before migration is not released again by the final payment after it', () => {
  const env = setupBaseTaxClosingEnv(seed());
  let { db } = env;
  const expAcc = create(db, 'account.account', { code: '651922', name: 'Non-Deductible Tax Expense', account_type: 'expense', company_id: 1 });
  db = expAcc.db;
  const transAcc = create(db, 'account.account', { code: '251198', name: 'Cash Basis Transition', account_type: 'liability_current', company_id: 1 });
  db = transAcc.db;
  const rows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: expAcc.id, tag_ids: [] },
  ];
  const taxRes = create(db, 'account.tax', {
    name: 'CB Expense Tax 10% B', company_id: 1, type_tax_use: 'sale', amount: 10, amount_type: 'percent',
    tax_exigibility: 'on_payment', cash_basis_transition_account_id: transAcc.id,
    invoice_repartition_line_ids: rows, refund_repartition_line_ids: rows,
  });
  db = taxRes.db;
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-08-10', company_id: 1,
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', taxRes.id)) }],
  });
  db = payMove(postMove(inv.db, inv.id), inv.id, 55, '2026-08-12');

  // Make the invoice snapshot and its first release look like they were written before the closing flag existed.
  const drop = ({ use_in_tax_closing: _drop, ...rest }) => rest;
  const legacyDb = {
    ...db,
    schema_version: 59,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => {
        if (m.id === inv.id) {
          return { ...m, invoice_line_ids: m.invoice_line_ids.map((l) => ({ ...l, invoice_repartition_line_ids: l.invoice_repartition_line_ids.map(drop), refund_repartition_line_ids: l.refund_repartition_line_ids.map(drop) })) };
        }
        return m.cash_basis_origin_move_id === inv.id ? { ...m, line_ids: m.line_ids.map(drop) } : m;
      }),
    },
  };
  const paid = payMove(migrate(legacyDb, 60), inv.id, 55, '2026-08-20');

  const released = paid.records['account.move']
    .filter((m) => m.cash_basis_origin_move_id === inv.id && m.state === 'posted')
    .flatMap((m) => m.line_ids.filter((l) => l.account_id === expAcc.id))
    .reduce((s, l) => s + (Number(l.credit) || 0) - (Number(l.debit) || 0), 0);
  assert.equal(round(released), 10, 'the whole tax is released exactly once across both payments');
});
