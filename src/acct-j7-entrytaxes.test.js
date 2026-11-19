import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove, computeEntryTaxLines } from './models/accounting.js';
import { accountId } from './models/ledger.js';

test('1. JE-16: analytic_distribution is a visible column on manual entry lines with distribution widget when analytic plans exist', () => {
  let db = seed();
  db = create(db, 'account.analytic.plan', { name: 'Projects' }).db;
  const moveDef = models['account.move'];
  const lineItem = moveDef.fields.line_ids;
  const cols = Object.fromEntries(lineItem.columnsFor({ move_type: 'entry' }, db));

  assert.ok(cols.analytic_distribution, 'analytic_distribution column exists on entry lines when analytic plans exist');
  assert.equal(cols.analytic_distribution.hidden, false, 'analytic_distribution is not hidden for move_type entry');
  assert.equal(cols.analytic_distribution.type, 'distribution', 'analytic_distribution uses distribution type/widget');
  assert.equal(lineItem.fields.analytic_distribution.type, 'distribution');
});

test('2. JE-16: analytic_distribution is kept on posted journal items of manual entries', () => {
  let db = seed();
  const accounts = search(db, 'account.account').filter((a) => (a.company_id ?? 1) === 1);
  const expAcc = accounts.find((a) => a.account_type === 'expense');
  const cashAcc = accounts.find((a) => a.account_type === 'asset_cash' || a.account_type === 'asset_current');
  const analyticAcc = search(db, 'account.analytic.account')[0];
  assert.ok(expAcc && cashAcc && analyticAcc);

  const res = create(db, 'account.move', {
    move_type: 'entry',
    date: '2026-06-01',
    line_ids: [
      { account_id: expAcc.id, debit: 500, credit: 0, analytic_distribution: { [analyticAcc.id]: 100 } },
      { account_id: cashAcc.id, debit: 0, credit: 500 },
    ],
  });
  db = postMove(res.db, res.id);

  const posted = read(db, 'account.move', res.id);
  assert.equal(posted.state, 'posted');
  const expLine = posted.line_ids.find((l) => l.account_id === expAcc.id);
  assert.ok(expLine, 'expense line exists');
  assert.deepEqual(expLine.analytic_distribution, { [analyticAcc.id]: 100 }, 'analytic distribution preserved on posted item');
});

test('3. JE-1: choosing an account fills the line taxes with account default taxes (account.tax_ids)', () => {
  let db = seed();
  const tax = search(db, 'account.tax').find((t) => t.type_tax_use === 'purchase' && t.active !== false);
  assert.ok(tax);

  const accRec = create(db, 'account.account', {
    name: 'Supplies with Default Tax',
    code: '600999',
    account_type: 'expense',
    tax_ids: [tax.id],
  });
  db = accRec.db;

  const lineItem = models['account.move'].fields.line_ids;
  assert.ok(typeof lineItem.onchange === 'function', 'lineItem has onchange handler');

  const line = lineItem.onchange({ account_id: accRec.id, debit: 100, credit: 0 }, 'account_id', db, { move_type: 'entry', company_id: 1 });
  assert.deepEqual(line.tax_ids, [tax.id], "line's tax_ids filled with account's default taxes");
});

test('4. JE-1: choosing taxes generates tax lines from repartition lines with correct account, tags, tax_base, tax_id, tax_repartition_line_id', () => {
  let db = seed();
  const invBaseTag = create(db, 'account.account.tag', { name: 'Purchase Base Grid', applicability: 'taxes' });
  db = invBaseTag.db;
  const invTaxTag = create(db, 'account.account.tag', { name: 'Purchase Tax Grid', applicability: 'taxes' });
  db = invTaxTag.db;

  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');

  const tax = create(db, 'account.tax', {
    name: 'VAT 15% Purchase',
    type_tax_use: 'purchase',
    amount: 15,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 101, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [invBaseTag.id] },
      { id: 102, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [invTaxTag.id] },
    ],
    refund_repartition_line_ids: [
      { id: 103, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 104, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = tax.db;

  const move = {
    move_type: 'entry',
    company_id: 1,
    line_ids: [
      { account_id: expAcc.id, debit: 1000, credit: 0, tax_ids: [tax.id] },
    ],
  };

  const changed = models['account.move'].onchange(move, 'line_ids', db);
  const lines = changed.line_ids;
  assert.equal(lines.length, 2, 'base line and generated tax line');

  const baseLine = lines.find((l) => !l.tax_repartition_line_id);
  const taxLine = lines.find((l) => l.tax_repartition_line_id);
  assert.ok(baseLine, 'base line found');
  assert.ok(taxLine, 'tax line found');

  // Base line gets base tags
  assert.deepEqual(baseLine.tax_tag_ids, [invBaseTag.id], 'base line gets base tags');

  // Tax line details
  assert.equal(taxLine.account_id, taxAcc, 'tax line account from repartition line');
  assert.equal(taxLine.debit, 150, 'tax line debit follows base line debit');
  assert.equal(taxLine.credit, 0);
  assert.equal(taxLine.tax_base, 1000, 'tax_base matches base amount');
  assert.equal(taxLine.tax_id, tax.id, 'tax_id matches tax');
  assert.equal(taxLine.tax_repartition_line_id, 102, 'tax_repartition_line_id matches tax repartition line');
  assert.deepEqual(taxLine.tax_tag_ids, [invTaxTag.id], 'tax line gets tax tags');
});

test('5. JE-1: tax lines stay in sync when base amount, side, or taxes change; removing taxes removes tax lines', () => {
  let db = seed();
  const invBaseTag = create(db, 'account.account.tag', { name: 'Inv Base', applicability: 'taxes' });
  db = invBaseTag.db;
  const invTaxTag = create(db, 'account.account.tag', { name: 'Inv Tax', applicability: 'taxes' });
  db = invTaxTag.db;
  const refBaseTag = create(db, 'account.account.tag', { name: 'Ref Base', applicability: 'taxes' });
  db = refBaseTag.db;
  const refTaxTag = create(db, 'account.account.tag', { name: 'Ref Tax', applicability: 'taxes' });
  db = refTaxTag.db;

  const invTaxAcc = accountId(db, '251000');
  const refTaxAccRec = create(db, 'account.account', { name: 'Ref Tax Acc', code: '251099', account_type: 'liability_current' });
  db = refTaxAccRec.db;
  const refTaxAcc = refTaxAccRec.id;
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');

  const taxA = create(db, 'account.tax', {
    name: 'Tax A 10%',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 201, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [invBaseTag.id] },
      { id: 202, repartition_type: 'tax', factor_percent: 100, account_id: invTaxAcc, tag_ids: [invTaxTag.id] },
    ],
    refund_repartition_line_ids: [
      { id: 203, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [refBaseTag.id] },
      { id: 204, repartition_type: 'tax', factor_percent: 100, account_id: refTaxAcc, tag_ids: [refTaxTag.id] },
    ],
  });
  db = taxA.db;

  const taxB = create(db, 'account.tax', {
    name: 'Tax B 20%',
    type_tax_use: 'purchase',
    amount: 20,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 205, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 206, repartition_type: 'tax', factor_percent: 100, account_id: invTaxAcc, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { id: 207, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 208, repartition_type: 'tax', factor_percent: 100, account_id: refTaxAcc, tag_ids: [] },
    ],
  });
  db = taxB.db;

  // Step 1: Initial move with base line 1000 debit
  let move = {
    move_type: 'entry',
    company_id: 1,
    line_ids: [
      { account_id: expAcc.id, debit: 1000, credit: 0, tax_ids: [taxA.id] },
    ],
  };
  let synced = models['account.move'].onchange(move, 'line_ids', db).line_ids;
  assert.equal(synced.length, 2);
  let taxLine = synced.find((l) => l.tax_id === taxA.id && l.tax_repartition_line_id);
  assert.equal(taxLine.debit, 100);
  assert.equal(taxLine.tax_base, 1000);

  // Step 2: Base amount changes: 1000 -> 2500
  let baseLine = synced.find((l) => !l.tax_repartition_line_id);
  baseLine.debit = 2500;
  move = { ...move, line_ids: synced };
  synced = models['account.move'].onchange(move, 'line_ids', db).line_ids;
  taxLine = synced.find((l) => l.tax_id === taxA.id && l.tax_repartition_line_id);
  assert.equal(taxLine.debit, 250, 'tax amount kept in sync after base amount change');
  assert.equal(taxLine.tax_base, 2500, 'tax_base updated');

  // Step 3: Side changes: debit 2500 -> credit 2500 (becomes purchase refund)
  baseLine = synced.find((l) => !l.tax_repartition_line_id);
  baseLine.debit = 0;
  baseLine.credit = 2500;
  move = { ...move, line_ids: synced };
  synced = models['account.move'].onchange(move, 'line_ids', db).line_ids;
  baseLine = synced.find((l) => !l.tax_repartition_line_id);
  taxLine = synced.find((l) => l.tax_id === taxA.id && l.tax_repartition_line_id);
  assert.equal(taxLine.credit, 250, 'tax line sign follows base line credit side');
  assert.equal(taxLine.debit, 0);
  assert.equal(taxLine.account_id, refTaxAcc, 'refund repartition tax account applied');
  assert.deepEqual(baseLine.tax_tag_ids, [refBaseTag.id], 'base line gets refund base tags');
  assert.deepEqual(taxLine.tax_tag_ids, [refTaxTag.id], 'tax line gets refund tax tags');

  // Step 4: Tax changes from Tax A to Tax B
  baseLine.tax_ids = [taxB.id];
  move = { ...move, line_ids: synced };
  synced = models['account.move'].onchange(move, 'line_ids', db).line_ids;
  assert.ok(!synced.some((l) => l.tax_id === taxA.id && l.tax_repartition_line_id), 'old tax line removed');
  taxLine = synced.find((l) => l.tax_id === taxB.id && l.tax_repartition_line_id);
  assert.ok(taxLine, 'new tax line generated');
  assert.equal(taxLine.credit, 500, '20% of 2500 is 500');

  // Step 5: Removing the tax removes its lines
  baseLine = synced.find((l) => !l.tax_repartition_line_id);
  baseLine.tax_ids = [];
  move = { ...move, line_ids: synced };
  synced = models['account.move'].onchange(move, 'line_ids', db).line_ids;
  assert.equal(synced.length, 1, 'only base line remains');
  assert.equal(synced[0].tax_repartition_line_id, undefined);
  assert.deepEqual(synced[0].tax_tag_ids, [], 'base tags cleared');
});

test('6. JE-1: analytic distribution copied where tax has analytic === true (Include in Analytic Cost)', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const analyticAcc = search(db, 'account.analytic.account')[0];
  assert.ok(analyticAcc);

  // Tax with analytic: true
  const taxWithAnalytic = create(db, 'account.tax', {
    name: 'Tax With Analytic',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    analytic: true,
    invoice_repartition_line_ids: [
      { id: 301, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 302, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { id: 303, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 304, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = taxWithAnalytic.db;

  // Tax without analytic (default false)
  const taxWithoutAnalytic = create(db, 'account.tax', {
    name: 'Tax Without Analytic',
    type_tax_use: 'purchase',
    amount: 5,
    amount_type: 'percent',
    analytic: false,
    invoice_repartition_line_ids: [
      { id: 305, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 306, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { id: 307, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 308, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = taxWithoutAnalytic.db;

  const move = {
    move_type: 'entry',
    company_id: 1,
    line_ids: [
      {
        account_id: expAcc.id,
        debit: 1000,
        credit: 0,
        tax_ids: [taxWithAnalytic.id, taxWithoutAnalytic.id],
        analytic_distribution: { [analyticAcc.id]: 100 },
      },
    ],
  };

  const synced = models['account.move'].onchange(move, 'line_ids', db).line_ids;
  const taxLine1 = synced.find((l) => l.tax_id === taxWithAnalytic.id && l.tax_repartition_line_id);
  const taxLine2 = synced.find((l) => l.tax_id === taxWithoutAnalytic.id && l.tax_repartition_line_id);

  assert.ok(taxLine1 && taxLine2);
  assert.deepEqual(taxLine1.analytic_distribution, { [analyticAcc.id]: 100 }, 'tax line receives analytic distribution when tax has analytic: true');
  assert.equal(taxLine2.analytic_distribution, undefined, 'tax line does not receive analytic distribution when analytic is false');
});

test('7. JE-1: sale tax on manual entry (credit base -> credit tax; debit base -> debit tax for sales refund)', () => {
  let db = seed();
  const tag1 = create(db, 'account.account.tag', { name: 'Sale Inv Base Grid', applicability: 'taxes' });
  db = tag1.db;
  const tag2 = create(db, 'account.account.tag', { name: 'Sale Inv Tax Grid', applicability: 'taxes' });
  db = tag2.db;
  const tag3 = create(db, 'account.account.tag', { name: 'Sale Ref Base Grid', applicability: 'taxes' });
  db = tag3.db;
  const tag4 = create(db, 'account.account.tag', { name: 'Sale Ref Tax Grid', applicability: 'taxes' });
  db = tag4.db;

  const taxAcc = accountId(db, '251000');
  const revAcc = search(db, 'account.account').find((a) => a.account_type === 'income');

  const saleTax = create(db, 'account.tax', {
    name: 'Sale Tax 14%',
    type_tax_use: 'sale',
    amount: 14,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 401, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [tag1.id] },
      { id: 402, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [tag2.id] },
    ],
    refund_repartition_line_ids: [
      { id: 403, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [tag3.id] },
      { id: 404, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [tag4.id] },
    ],
  });
  db = saleTax.db;

  // Credit base (normal sale): credit 1000 -> credit 140 tax
  const saleLines = computeEntryTaxLines(
    [{ account_id: revAcc.id, debit: 0, credit: 1000, tax_ids: [saleTax.id] }],
    { move_type: 'entry', company_id: 1 },
    db,
  );
  assert.equal(saleLines.length, 2);
  const saleBase = saleLines.find((l) => !l.tax_repartition_line_id);
  const saleTaxLine = saleLines.find((l) => l.tax_id === saleTax.id && l.tax_repartition_line_id);
  assert.equal(saleTaxLine.credit, 140);
  assert.equal(saleTaxLine.debit, 0);
  assert.deepEqual(saleBase.tax_tag_ids, [tag1.id], 'invoice base tag for normal sale');
  assert.deepEqual(saleTaxLine.tax_tag_ids, [tag2.id], 'invoice tax tag for normal sale');

  // Debit base (sale refund / credit note): debit 1000 -> debit 140 tax
  const refundLines = computeEntryTaxLines(
    [{ account_id: revAcc.id, debit: 1000, credit: 0, tax_ids: [saleTax.id] }],
    { move_type: 'entry', company_id: 1 },
    db,
  );
  assert.equal(refundLines.length, 2);
  const refundBase = refundLines.find((l) => !l.tax_repartition_line_id);
  const refundTaxLine = refundLines.find((l) => l.tax_id === saleTax.id && l.tax_repartition_line_id);
  assert.equal(refundTaxLine.debit, 140);
  assert.equal(refundTaxLine.credit, 0);
  assert.deepEqual(refundBase.tax_tag_ids, [tag3.id], 'refund base tag for sale refund');
  assert.deepEqual(refundTaxLine.tax_tag_ids, [tag4.id], 'refund tax tag for sale refund');
});

test('8. JE-1: split repartition rows across two tax accounts (50% / 50%)', () => {
  let db = seed();
  const taxAcc1 = accountId(db, '251000');
  const taxAcc2Rec = create(db, 'account.account', { name: 'Tax Sub Acc 2', code: '251098', account_type: 'liability_current' });
  db = taxAcc2Rec.db;
  const taxAcc2 = taxAcc2Rec.id;
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');

  const splitTax = create(db, 'account.tax', {
    name: 'Split Tax 10%',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 501, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 502, repartition_type: 'tax', factor_percent: 50, account_id: taxAcc1, tag_ids: [] },
      { id: 503, repartition_type: 'tax', factor_percent: 50, account_id: taxAcc2, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { id: 504, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 505, repartition_type: 'tax', factor_percent: 50, account_id: taxAcc1, tag_ids: [] },
      { id: 506, repartition_type: 'tax', factor_percent: 50, account_id: taxAcc2, tag_ids: [] },
    ],
  });
  db = splitTax.db;

  const lines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 1000, credit: 0, tax_ids: [splitTax.id] }],
    { move_type: 'entry', company_id: 1 },
    db,
  );
  assert.equal(lines.length, 3, '1 base line + 2 split tax lines');
  const taxLineA = lines.find((l) => l.tax_repartition_line_id === 502);
  const taxLineB = lines.find((l) => l.tax_repartition_line_id === 503);
  assert.ok(taxLineA && taxLineB);
  assert.equal(taxLineA.account_id, taxAcc1);
  assert.equal(taxLineA.debit, 50);
  assert.equal(taxLineA.tax_base, 1000);
  assert.equal(taxLineB.account_id, taxAcc2);
  assert.equal(taxLineB.debit, 50);
  assert.equal(taxLineB.tax_base, 1000);
});

test('9. JE-1: manual entry tax lines handle foreign currency', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const eurCurr = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eurCurr);

  const tax = create(db, 'account.tax', {
    name: 'Tax 10%',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 601, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 602, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { id: 603, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 604, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = tax.db;

  const lines = computeEntryTaxLines(
    [{
      account_id: expAcc.id,
      debit: 200,
      credit: 0,
      currency_id: eurCurr.id,
      amount_currency: 100,
      tax_ids: [tax.id],
    }],
    { move_type: 'entry', company_id: 1, currency_id: eurCurr.id },
    db,
  );
  assert.equal(lines.length, 2);
  const taxLine = lines.find((l) => l.tax_id === tax.id && l.tax_repartition_line_id);
  assert.ok(taxLine);
  assert.equal(taxLine.currency_id, eurCurr.id);
  assert.equal(taxLine.amount_currency, 10, '10% of 100 EUR is 10 EUR');
});

test('10. JE-1: taxes with type_tax_use neither sale nor purchase follow natural base side (debit = invoice side, credit = invoice side)', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: 'None Base Tag', applicability: 'taxes' });
  db = baseTag.db;
  const taxTag = create(db, 'account.account.tag', { name: 'None Tax Tag', applicability: 'taxes' });
  db = taxTag.db;
  const refBaseTag = create(db, 'account.account.tag', { name: 'None Ref Base Tag', applicability: 'taxes' });
  db = refBaseTag.db;

  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');

  const noneTax = create(db, 'account.tax', {
    name: 'Tax None 10%',
    type_tax_use: 'none',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 701, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [baseTag.id] },
      { id: 702, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { id: 703, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [refBaseTag.id] },
      { id: 704, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = noneTax.db;

  // Debit base line (purchase-like): uses invoice repartition side
  const debitLines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 500, credit: 0, tax_ids: [noneTax.id] }],
    { move_type: 'entry', company_id: 1 },
    db,
  );
  assert.equal(debitLines.length, 2);
  const debitBase = debitLines.find((l) => !l.tax_repartition_line_id);
  const debitTaxLine = debitLines.find((l) => l.tax_id === noneTax.id && l.tax_repartition_line_id);
  assert.equal(debitTaxLine.debit, 50);
  assert.equal(debitTaxLine.credit, 0);
  assert.deepEqual(debitBase.tax_tag_ids, [baseTag.id], 'debit base gets invoice base tags');
  assert.deepEqual(debitTaxLine.tax_tag_ids, [taxTag.id], 'debit tax line gets invoice tax tags');

  // Credit base line (sale-like): uses invoice repartition side
  const creditLines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 0, credit: 500, tax_ids: [noneTax.id] }],
    { move_type: 'entry', company_id: 1 },
    db,
  );
  assert.equal(creditLines.length, 2);
  const creditBase = creditLines.find((l) => !l.tax_repartition_line_id);
  const creditTaxLine = creditLines.find((l) => l.tax_id === noneTax.id && l.tax_repartition_line_id);
  assert.equal(creditTaxLine.credit, 50);
  assert.equal(creditTaxLine.debit, 0);
  assert.deepEqual(creditBase.tax_tag_ids, [baseTag.id], 'credit base gets invoice base tags');
  assert.deepEqual(creditTaxLine.tax_tag_ids, [taxTag.id], 'credit tax line gets invoice tax tags');
});
