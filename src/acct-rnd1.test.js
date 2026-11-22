import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { cashRoundingApplies } from './models/configured-account.js';
import { postMove } from './models/accounting.js';
import { accountId, invoiceTaxTotals, isBalanced } from './models/ledger.js';
import { payOrder, posOrderTotal, startSession } from './models/pos.js';
import { taxSnapshot } from './models/taxes.js';
import { applyDiff, diffDb } from './sync.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

function tryApplyWrite(db, model, id, vals) {
  const next = {
    ...db,
    records: {
      ...db.records,
      [model]: (db.records[model] ?? []).map((r) => (r.id === id ? { ...r, ...vals } : r)),
    },
  };
  return applyDiff(db, diffDb(db, next));
}

function tryApplyCreate(db, model, vals) {
  const nextId = (db.seq[model] ?? 0) + 1;
  const next = {
    ...db,
    seq: { ...db.seq, [model]: nextId },
    records: {
      ...db.records,
      [model]: [...(db.records[model] ?? []), { id: nextId, ...vals }],
    },
  };
  return applyDiff(db, diffDb(db, next));
}

test('RND-1: account.cash.rounding Odoo 20 conditions, cashRoundingApplies, POS strategy & diff-verified guards', async () => {
  let db = seed();
  const roundingDef = models['account.cash.rounding'];
  // Odoo 20 account.cash.rounding conditions are currency_ids and company_id only;
  // partner categories are not on cash rounding, and payment method restriction is only_round_cash_method on pos.config.
  assert.ok(roundingDef.fields.currency_ids);
  assert.ok(roundingDef.fields.company_id);
  assert.equal(roundingDef.fields.partner_category_ids, undefined);
  assert.equal(roundingDef.fields.payment_method_ids, undefined);
  assert.ok(models['pos.config'].fields.only_round_cash_method);
  assert.ok(models['pos.config'].fields.payment_method_ids);

  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Co' });
  db = c2.db;
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const cad = create(db, 'res.currency', { name: 'CAD', rate_ids: [{ date: '2026-01-01', rate: 1.4 }] });
  db = cad.db;
  const profit = accountId(db, '450000');
  const loss = accountId(db, '690000');

  const rUsdCo1 = create(db, 'account.cash.rounding', {
    name: 'Co1 USD Line',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'add_invoice_line',
    profit_account_id: profit,
    loss_account_id: loss,
    company_id: 1,
    currency_ids: [usd.id],
  });
  db = rUsdCo1.db;
  const rCadOnly = create(db, 'account.cash.rounding', {
    name: 'CAD Line',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profit,
    loss_account_id: loss,
    currency_ids: [cad.id],
  });
  db = rCadOnly.db;
  const rBiggest = create(db, 'account.cash.rounding', {
    name: 'Biggest Tax',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'biggest_tax',
  });
  db = rBiggest.db;
  const rGlobal = create(db, 'account.cash.rounding', {
    name: 'Global Line',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profit,
    loss_account_id: loss,
  });
  db = rGlobal.db;

  // cashRoundingApplies honours both company_id and currency_ids
  assert.equal(cashRoundingApplies(read(db, 'account.cash.rounding', rGlobal.id), c2.id, cad.id), true);
  assert.equal(cashRoundingApplies(read(db, 'account.cash.rounding', rUsdCo1.id), 1, usd.id), true);
  assert.equal(cashRoundingApplies(read(db, 'account.cash.rounding', rUsdCo1.id), 1, cad.id), false);
  assert.equal(cashRoundingApplies(read(db, 'account.cash.rounding', rUsdCo1.id), c2.id, usd.id), false);

  // POS config domain excludes biggest_tax and non-applicable company/currency roundings
  const cfg = search(db, 'pos.config').find((c) => (c.company_id ?? 1) === 1);
  const posDomain = models['pos.config'].fields.rounding_method_id.domain;
  assert.equal(posDomain(read(db, 'account.cash.rounding', rUsdCo1.id), cfg, db), true);
  assert.equal(posDomain(read(db, 'account.cash.rounding', rCadOnly.id), cfg, db), false);
  assert.equal(posDomain(read(db, 'account.cash.rounding', rBiggest.id), cfg, db), false);

  // Guards enforced through diffDb + applyDiff (src/sync.js)
  assert.throws(
    () => tryApplyWrite(db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: rBiggest.id }),
    /The cash rounding strategy of a POS must be 'Add a rounding line'/,
  );
  assert.throws(
    () => tryApplyWrite(db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: rCadOnly.id }),
    /does not apply to this currency/,
  );
  assert.throws(
    () => tryApplyCreate(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: 1,
      company_id: 1,
      invoice_date: '2026-03-01',
      invoice_cash_rounding_id: rCadOnly.id,
      invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 10.02, tax: 0 }],
    }),
    /does not apply to this currency/,
  );
  assert.throws(
    () => tryApplyCreate(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: 1,
      company_id: c2.id,
      invoice_date: '2026-03-01',
      invoice_cash_rounding_id: rUsdCo1.id,
      invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 10.02, tax: 0 }],
    }),
    /belongs to another company/,
  );

  // POS honours cashRoundingApplies even if the method's currency_ids is narrowed after config save
  let posDb = write(db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: rUsdCo1.id, only_round_cash_method: false });
  posDb = startSession(posDb, 0, cfg.id).db;
  const cash = search(posDb, 'pos.payment.method').find((m) => m.type === 'cash' && (m.company_id ?? 1) === 1);
  const posLines = [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }];
  assert.equal(posOrderTotal(posDb, posLines, { configId: cfg.id, method: cash.id }).roundedTotal, 10.00);

  const narrowed = write(posDb, 'account.cash.rounding', rUsdCo1.id, { currency_ids: [cad.id] });
  assert.equal(posOrderTotal(narrowed, posLines, { configId: cfg.id, method: cash.id }).roundedTotal, 10.02);
  assert.equal(posOrderTotal(narrowed, posLines, { configId: cfg.id, method: cash.id }).roundingDifference, 0);
  const paidNarrowed = payOrder(narrowed, { lines: posLines, method: cash.id, config_id: cfg.id });
  assert.equal(read(paidNarrowed.db, 'pos.order', paidNarrowed.id).rounding_difference, 0);

  // Arabic translation for POS strategy constraint
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import(`./i18n.js?lang=ar-rnd1=${Date.now()}`);
    const msg = "The cash rounding strategy of a POS must be 'Add a rounding line'";
    assert.notEqual(t(msg), msg);
  } finally {
    globalThis.localStorage = prev;
  }
});

test('RND-2: Invoice cash rounding add_invoice_line vs biggest_tax lines and amounts match Odoo', () => {
  let db = seed();
  const profit = accountId(db, '450000');
  const loss = accountId(db, '690000');
  const taxAcc14 = search(db, 'account.account').find((a) => a.code === '251000').id;
  const tax14 = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.amount === 14);
  const group5 = create(db, 'account.tax.group', { name: 'VAT 5%', sequence: 20 });
  db = group5.db;
  const tax5 = create(db, 'account.tax', {
    name: 'VAT 5%',
    type_tax_use: 'sale',
    amount: 5,
    tax_group_id: group5.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc14, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc14, tag_ids: [] },
    ],
  });
  db = tax5.db;

  const rAddLine = create(db, 'account.cash.rounding', {
    name: '0.05 Add Line',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'add_invoice_line',
    profit_account_id: profit,
    loss_account_id: loss,
  });
  db = rAddLine.db;
  const rBiggest = create(db, 'account.cash.rounding', {
    name: '0.05 Biggest Tax',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'biggest_tax',
  });
  db = rBiggest.db;

  // Multi-tax customer invoice:
  // Line 1: 100.02 @ 14% -> untaxed 100.02, tax 14.00
  // Line 2: 20.00  @ 5%  -> untaxed 20.00,  tax 1.00
  // Unrounded: untaxed 120.02, tax 15.00, total 135.02 -> HALF-UP 0.05 => 135.00 (diff -0.02)
  const invLines = [
    { name: 'Main Item', qty: 1, price_unit: 100.02, ...taxSnapshot(tax14, db) },
    { name: 'Small Item', qty: 1, price_unit: 20.00, ...taxSnapshot(read(db, 'account.tax', tax5.id), db) },
  ];

  // 1. add_invoice_line: taxes stay 14.00 and 1.00; dedicated Cash Rounding loss line debits 0.02; total is 135.00
  const invAdd = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_cash_rounding_id: rAddLine.id,
    invoice_line_ids: invLines,
  });
  const postedAddDb = postMove(invAdd.db, invAdd.id);
  const postedAdd = read(postedAddDb, 'account.move', invAdd.id);
  assert.equal(postedAdd.amount_untaxed, 120.02);
  assert.equal(postedAdd.amount_tax, 15.00);
  assert.equal(postedAdd.amount_total, 135.00);
  assert.ok(isBalanced(postedAdd.line_ids));

  const totalsAdd = invoiceTaxTotals(postedAddDb, postedAdd);
  assert.equal(totalsAdd.untaxed, 120.02);
  assert.equal(totalsAdd.tax, 15.00);
  assert.equal(totalsAdd.rounding_amount, -0.02);
  assert.equal(totalsAdd.total, 135.00);

  const addRoundLine = postedAdd.line_ids.find((l) => l.name === 'Cash Rounding');
  assert.ok(addRoundLine);
  assert.equal(addRoundLine.account_id, loss);
  assert.equal(addRoundLine.debit, 0.02);
  assert.equal(addRoundLine.credit, 0);
  assert.equal(postedAdd.line_ids.find((l) => l.tax_id === tax14.id).credit, 14.00);
  assert.equal(postedAdd.line_ids.find((l) => l.tax_id === tax5.id).credit, 1.00);
  assert.equal(postedAdd.line_ids.find((l) => l.account_id === accountId(postedAddDb, '121000')).debit, 135.00);

  // 2. biggest_tax: NO Cash Rounding line; biggest tax (14.00) is reduced to 13.98, 5% tax stays 1.00; amount_tax is 14.98
  const invBig = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_cash_rounding_id: rBiggest.id,
    invoice_line_ids: invLines,
  });
  const postedBigDb = postMove(invBig.db, invBig.id);
  const postedBig = read(postedBigDb, 'account.move', invBig.id);
  assert.equal(postedBig.amount_untaxed, 120.02);
  assert.equal(postedBig.amount_tax, 14.98);
  assert.equal(postedBig.amount_total, 135.00);
  assert.ok(isBalanced(postedBig.line_ids));

  const totalsBig = invoiceTaxTotals(postedBigDb, postedBig);
  assert.equal(totalsBig.untaxed, 120.02);
  assert.equal(totalsBig.tax, 14.98);
  assert.equal(totalsBig.rounding_amount, 0);
  assert.equal(totalsBig.total, 135.00);
  assert.equal(postedBig.line_ids.some((l) => l.name === 'Cash Rounding'), false);
  assert.equal(postedBig.line_ids.find((l) => l.tax_id === tax14.id).credit, 13.98);
  assert.equal(postedBig.line_ids.find((l) => l.tax_id === tax5.id).credit, 1.00);
  assert.equal(postedBig.line_ids.find((l) => l.account_id === accountId(postedBigDb, '121000')).debit, 135.00);

  // 3. Credit note (out_refund): loss/profit direction reverses for add_invoice_line, tax line flips to debit for biggest_tax
  const refAdd = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_cash_rounding_id: rAddLine.id,
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100.02, ...taxSnapshot(tax14, db) }],
  });
  const postedRefAdd = read(postMove(refAdd.db, refAdd.id), 'account.move', refAdd.id);
  assert.equal(postedRefAdd.amount_total, 114.00);
  assert.equal(postedRefAdd.amount_tax, 14.00);
  const refRoundLine = postedRefAdd.line_ids.find((l) => l.name === 'Cash Rounding');
  assert.equal(refRoundLine.account_id, profit);
  assert.equal(refRoundLine.credit, 0.02);

  const refBig = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_cash_rounding_id: rBiggest.id,
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100.02, ...taxSnapshot(tax14, db) }],
  });
  const postedRefBig = read(postMove(refBig.db, refBig.id), 'account.move', refBig.id);
  assert.equal(postedRefBig.amount_total, 114.00);
  assert.equal(postedRefBig.amount_tax, 13.98);
  assert.equal(postedRefBig.line_ids.some((l) => l.name === 'Cash Rounding'), false);
  assert.equal(postedRefBig.line_ids.find((l) => l.tax_id === tax14.id).debit, 13.98);

  // 4. Zero-net reverse-charge tax under biggest_tax: posted journal items stay unrounded like amount_tax & amount_total
  const accOut = search(db, 'account.account').find((a) => a.code === '250100').id;
  const rcRows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc14, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: accOut, tag_ids: [] },
  ];
  const rcTax = create(db, 'account.tax', {
    name: 'RC 15%',
    type_tax_use: 'sale',
    amount: 15,
    invoice_repartition_line_ids: rcRows,
    refund_repartition_line_ids: rcRows,
  });
  const rcMove = create(rcTax.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_cash_rounding_id: rBiggest.id,
    invoice_line_ids: [{ name: 'RC Item', qty: 1, price_unit: 10.03, ...taxSnapshot(read(rcTax.db, 'account.tax', rcTax.id), rcTax.db) }],
  });
  const postedRcDb = postMove(rcMove.db, rcMove.id);
  const postedRc = read(postedRcDb, 'account.move', rcMove.id);
  assert.equal(postedRc.amount_untaxed, 10.03);
  assert.equal(postedRc.amount_tax, 0);
  assert.equal(postedRc.amount_total, 10.03);
  assert.equal(postedRc.line_ids.find((l) => l.account_id === accountId(postedRcDb, '121000')).debit, 10.03);
  assert.ok(isBalanced(postedRc.line_ids));

  // 5. Foreign currency invoice for both strategies
  const eur = create(db, 'res.currency', { name: 'EUR', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
  const fxAdd = create(eur.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    currency_id: eur.id,
    invoice_date: '2026-04-01',
    invoice_cash_rounding_id: rAddLine.id,
    invoice_line_ids: [{ name: 'FX Item', qty: 1, price_unit: 100.02, ...taxSnapshot(tax14, eur.db) }],
  });
  const postedFxAdd = read(postMove(fxAdd.db, fxAdd.id), 'account.move', fxAdd.id);
  assert.equal(postedFxAdd.amount_total, 114.00);
  assert.equal(postedFxAdd.amount_tax, 14.00);
  const fxAddRound = postedFxAdd.line_ids.find((l) => l.name === 'Cash Rounding');
  assert.equal(fxAddRound.currency_id, eur.id);
  assert.equal(fxAddRound.amount_currency, 0.02);
  assert.equal(fxAddRound.debit, 0.01);
  assert.ok(isBalanced(postedFxAdd.line_ids));

  const fxBig = create(eur.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    currency_id: eur.id,
    invoice_date: '2026-04-01',
    invoice_cash_rounding_id: rBiggest.id,
    invoice_line_ids: [{ name: 'FX Item', qty: 1, price_unit: 100.02, ...taxSnapshot(tax14, eur.db) }],
  });
  const postedFxBig = read(postMove(fxBig.db, fxBig.id), 'account.move', fxBig.id);
  assert.equal(postedFxBig.amount_total, 114.00);
  assert.equal(postedFxBig.amount_tax, 13.98);
  const fxBigTax = postedFxBig.line_ids.find((l) => l.tax_id === tax14.id);
  assert.equal(fxBigTax.currency_id, eur.id);
  assert.equal(fxBigTax.amount_currency, -13.98);
  assert.equal(fxBigTax.credit, 6.99);
  assert.ok(isBalanced(postedFxBig.line_ids));
});
