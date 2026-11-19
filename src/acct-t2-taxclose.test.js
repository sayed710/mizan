import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { round, roundCurrency } from './money.js';
import { postMove } from './models/accounting.js';
import { journalItems, postEntry } from './models/ledger.js';
import { taxSnapshot } from './models/taxes.js';
import { taxClosingMatchesReturn, taxClosingSpec } from './models/finance.js';
import { payReturn, reviewReturn, submitReturn } from './models/taxreturn.js';

function setupTaxClosingEnv(db, { separatePayable = true, configureRounding = true } = {}) {
  let next = db;
  const vatType = search(next, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  const profitAcc = search(next, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.code === '450000')
    ?? create(next, 'account.account', { code: '450991', name: 'Tax Rounding Profit', account_type: 'income_other', company_id: 1 });
  if (profitAcc.db) next = profitAcc.db;

  const lossAcc = search(next, 'account.account').find((a) => (a.company_id ?? 1) === 1 && a.code === '690000')
    ?? create(next, 'account.account', { code: '690991', name: 'Tax Rounding Loss', account_type: 'expense', company_id: 1 });
  if (lossAcc.db) next = lossAcc.db;

  let payableAccId = vatType.tax_payable_account_id;
  if (separatePayable) {
    const payableCreated = create(next, 'account.account', {
      code: '251999', name: 'Tax Authority Payable', account_type: 'liability_current', company_id: 1,
    });
    next = payableCreated.db;
    payableAccId = payableCreated.id;
  }

  let receivableAccId = vatType.tax_receivable_account_id;
  if (separatePayable) {
    const recCreated = create(next, 'account.account', {
      code: '131999', name: 'Tax Authority Receivable', account_type: 'asset_current', company_id: 1,
    });
    next = recCreated.db;
    receivableAccId = recCreated.id;
  }

  next = write(next, 'account.return.type', vatType.id, {
    tax_payable_account_id: payableAccId,
    tax_receivable_account_id: receivableAccId,
    ...(configureRounding ? {
      rounding_profit_account_id: profitAcc.id,
      rounding_loss_account_id: lossAcc.id,
    } : {}),
  });

  const saleTax = search(next, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'sale' && Number(t.amount) > 0);
  const purchTax = search(next, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'purchase' && Number(t.amount) > 0);
  const vatOutAccId = saleTax.invoice_repartition_line_ids.find((l) => l.repartition_type === 'tax').account_id;
  const vatInAccId = purchTax.invoice_repartition_line_ids.find((l) => l.repartition_type === 'tax').account_id;
  const partner = search(next, 'res.partner')[0];

  return {
    db: next,
    vatType: read(next, 'account.return.type', vatType.id),
    profitAccId: profitAcc.id,
    lossAccId: lossAcc.id,
    payableAccId,
    receivableAccId,
    saleTax,
    purchTax,
    vatOutAccId,
    vatInAccId,
    partnerId: partner.id,
  };
}

function accountBalanceUpTo(db, accountId, toDate, companyId = 1) {
  const items = journalItems(db, { to: toDate, company_id: companyId }).filter((l) => l.account_id === accountId);
  return round(items.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
}

test('item 1: small positive rounding difference books to rounding_profit_account_id and passes sync + payment', () => {
  const env = setupTaxClosingEnv(seed());
  let { db } = env;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-04-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale', qty: 1, price_unit: 100, ...taxSnapshot(env.saleTax) }], // 14.00 VAT
  });
  db = postMove(inv.db, inv.id);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: env.partnerId, invoice_date: '2026-04-12', company_id: 1,
    invoice_line_ids: [{ name: 'Purchase', qty: 1, price_unit: 50, ...taxSnapshot(env.purchTax) }], // 7.00 VAT
  });
  db = postMove(bill.db, bill.id);

  // Add a 0.03 minor rounding discrepancy on the output VAT account (tax_zero keeps report payable at 7.00 while ledger is 7.03).
  db = postEntry(db, {
    journal: 'MISC',
    date: '2026-04-15',
    company: 1,
    ref: 'Tax rounding adjustment',
    lines: [
      { account_id: env.vatOutAccId, credit: 0.03, tax_name: env.saleTax.name, tax_zero: true },
      { account: '101401', debit: 0.03 },
    ],
  }).db;

  const ret = create(db, 'account.return', {
    name: 'VAT Apr 2026', type_id: env.vatType.id, date_from: '2026-04-01', date_to: '2026-04-30', company_id: 1,
  });
  const reviewed = reviewReturn(ret.db, ret.id);
  const submitted = submitReturn(reviewed, ret.id);

  // Sync guard must accept the submitted return with the rounding line.
  const synced = applyDiff(reviewed, diffDb(reviewed, submitted), { isAdmin: true });
  const subRet = read(synced, 'account.return', ret.id);
  assert.equal(subRet.total_amount_to_pay, 7);
  assert.equal(taxClosingMatchesReturn(synced, subRet), true);

  const closingMove = read(synced, 'account.move', subRet.closing_move_ids[0]);
  const profitLine = closingMove.line_ids.find((l) => l.account_id === env.profitAccId);
  assert.ok(profitLine, 'Closing entry must book rounding profit line');
  assert.equal(profitLine.credit, 0.03);
  assert.equal(profitLine.debit, 0);

  const payableLine = closingMove.line_ids.find((l) => l.account_id === env.payableAccId && l.partner_id === env.vatType.payment_partner_id);
  assert.equal(payableLine.credit, 7);

  // Tax accounts are completely cleared to 0.
  assert.equal(accountBalanceUpTo(synced, env.vatOutAccId, '2026-04-30'), 0);
  assert.equal(accountBalanceUpTo(synced, env.vatInAccId, '2026-04-30'), 0);

  // Paying the return settles the 7.00 payable.
  const paidDb = payReturn(synced, ret.id);
  assert.equal(read(paidDb, 'account.return', ret.id).state, 'paid');
});

test('item 1: small negative rounding difference (including refund return) books to rounding_loss_account_id', () => {
  const env = setupTaxClosingEnv(seed());
  let { db } = env;

  // Refund scenario: purchase tax 14.00 > sale tax 7.00 -> report payable = -7.00.
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-04-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale', qty: 1, price_unit: 50, ...taxSnapshot(env.saleTax) }], // 7.00
  });
  db = postMove(inv.db, inv.id);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: env.partnerId, invoice_date: '2026-04-12', company_id: 1,
    invoice_line_ids: [{ name: 'Purchase', qty: 1, price_unit: 100, ...taxSnapshot(env.purchTax) }], // 14.00
  });
  db = postMove(bill.db, bill.id);

  // Purchase tax ledger has 0.04 extra debit (14.04 instead of 14.00), so netClosed = -7.04 vs report.payable = -7.00 -> diff = -0.04 (loss).
  db = postEntry(db, {
    journal: 'MISC',
    date: '2026-04-15',
    company: 1,
    ref: 'Tax rounding loss',
    lines: [
      { account_id: env.vatInAccId, debit: 0.04, tax_name: env.purchTax.name, tax_zero: true },
      { account: '101401', credit: 0.04 },
    ],
  }).db;

  const ret = create(db, 'account.return', {
    name: 'VAT Refund Apr 2026', type_id: env.vatType.id, date_from: '2026-04-01', date_to: '2026-04-30', company_id: 1,
  });
  const submitted = submitReturn(reviewReturn(ret.db, ret.id), ret.id);
  const subRet = read(submitted, 'account.return', ret.id);
  assert.equal(subRet.total_amount_to_pay, -7);

  const closingMove = read(submitted, 'account.move', subRet.closing_move_ids[0]);
  const lossLine = closingMove.line_ids.find((l) => l.account_id === env.lossAccId);
  assert.ok(lossLine, 'Closing entry must book rounding loss line');
  assert.equal(lossLine.debit, 0.04);
  assert.equal(lossLine.credit, 0);

  const recLine = closingMove.line_ids.find((l) => l.account_id === env.receivableAccId && l.partner_id === env.vatType.payment_partner_id);
  assert.equal(recLine.debit, 7);
  assert.equal(accountBalanceUpTo(submitted, env.vatOutAccId, '2026-04-30'), 0);
  assert.equal(accountBalanceUpTo(submitted, env.vatInAccId, '2026-04-30'), 0);
});

test('item 1: throws when difference exceeds tolerance or when needed rounding account is missing, and scales with currency minor units', () => {
  const env = setupTaxClosingEnv(seed(), { configureRounding: false });
  let { db } = env;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: env.partnerId, invoice_date: '2026-04-10', company_id: 1,
    invoice_line_ids: [{ name: 'Sale', qty: 1, price_unit: 100, ...taxSnapshot(env.saleTax) }],
  });
  db = postMove(inv.db, inv.id);

  // 0.02 profit difference without rounding_profit_account_id configured -> clear error.
  const withSmallProfit = postEntry(db, {
    journal: 'MISC', date: '2026-04-15', company: 1,
    lines: [
      { account_id: env.vatOutAccId, credit: 0.02, tax_name: env.saleTax.name, tax_zero: true },
      { account: '101401', debit: 0.02 },
    ],
  }).db;
  const retProfit = create(withSmallProfit, 'account.return', {
    name: 'Missing Profit Account', type_id: env.vatType.id, date_from: '2026-04-01', date_to: '2026-04-30', company_id: 1,
  });
  const revProfit = reviewReturn(retProfit.db, retProfit.id);
  assert.throws(() => submitReturn(revProfit, retProfit.id), /rounding_profit_account_id|Rounding Profit Account/i);

  // Configure only rounding_profit_account_id -> profit succeeds without needing rounding_loss_account_id.
  const onlyProfit = write(revProfit, 'account.return.type', env.vatType.id, { rounding_profit_account_id: env.profitAccId });
  assert.doesNotThrow(() => submitReturn(onlyProfit, retProfit.id));

  // 0.02 loss difference without rounding_loss_account_id configured -> clear error.
  const withSmallLoss = postEntry(db, {
    journal: 'MISC', date: '2026-04-15', company: 1,
    lines: [
      { account_id: env.vatOutAccId, debit: 0.02, tax_name: env.saleTax.name, tax_zero: true },
      { account: '101401', credit: 0.02 },
    ],
  }).db;
  const retLoss = create(withSmallLoss, 'account.return', {
    name: 'Missing Loss Account', type_id: env.vatType.id, date_from: '2026-04-01', date_to: '2026-04-30', company_id: 1,
  });
  const revLoss = reviewReturn(retLoss.db, retLoss.id);
  assert.throws(() => submitReturn(revLoss, retLoss.id), /rounding_loss_account_id|Rounding Loss Account/i);

  // Large difference (0.50 > tolerance) throws even when both rounding accounts are configured.
  const withLargeDiff = postEntry(write(db, 'account.return.type', env.vatType.id, {
    rounding_profit_account_id: env.profitAccId, rounding_loss_account_id: env.lossAccId,
  }), {
    journal: 'MISC', date: '2026-04-15', company: 1,
    lines: [
      { account_id: env.vatOutAccId, credit: 0.50, tax_name: env.saleTax.name, tax_zero: true },
      { account: '101401', debit: 0.50 },
    ],
  }).db;
  const retLarge = create(withLargeDiff, 'account.return', {
    name: 'Large Diff', type_id: env.vatType.id, date_from: '2026-04-01', date_to: '2026-04-30', company_id: 1,
  });
  const revLarge = reviewReturn(retLarge.db, retLarge.id);
  assert.throws(() => submitReturn(revLarge, retLarge.id), /Unbalanced tax account: ledger balance does not match tax report/);

  // 3-decimal company currency (0.001 minor unit): 0.005 is within 5 minor units, 0.006 exceeds tolerance.
  const bhd = create(write(db, 'account.return.type', env.vatType.id, {
    rounding_profit_account_id: env.profitAccId, rounding_loss_account_id: env.lossAccId,
  }), 'res.currency', { name: 'BHD', rounding: 0.001, rate_ids: [{ date: '2026-01-01', rate: 1 }] });
  const dbBhd = write(bhd.db, 'res.company', 1, { currency_id: bhd.id });
  const okBhd = postEntry(dbBhd, {
    journal: 'MISC', date: '2026-04-15', company: 1,
    lines: [
      { account_id: env.vatOutAccId, credit: 0.005, tax_name: env.saleTax.name, tax_zero: true },
      { account: '101401', debit: 0.005 },
    ],
  }).db;
  const retBhdOk = create(okBhd, 'account.return', {
    name: 'BHD Ok', type_id: env.vatType.id, date_from: '2026-04-01', date_to: '2026-04-30', company_id: 1, state: 'reviewed',
  });
  const specBhd = taxClosingSpec(retBhdOk.db, read(retBhdOk.db, 'account.return', retBhdOk.id), 1);
  assert.equal(roundCurrency(specBhd.lines.find((l) => l.account_id === env.profitAccId)?.credit, read(retBhdOk.db, 'res.currency', bhd.id)), 0.005);

  const badBhd = postEntry(okBhd, {
    journal: 'MISC', date: '2026-04-16', company: 1,
    lines: [
      { account_id: env.vatOutAccId, credit: 0.001, tax_name: env.saleTax.name, tax_zero: true },
      { account: '101401', debit: 0.001 },
    ],
  }).db;
  const retBhdBad = create(badBhd, 'account.return', {
    name: 'BHD Bad', type_id: env.vatType.id, date_from: '2026-04-01', date_to: '2026-04-30', company_id: 1, state: 'reviewed',
  });
  assert.throws(
    () => taxClosingSpec(retBhdBad.db, read(retBhdBad.db, 'account.return', retBhdBad.id), 1),
    /Unbalanced tax account: ledger balance does not match tax report/
  );
});
