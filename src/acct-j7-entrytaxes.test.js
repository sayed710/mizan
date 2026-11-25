import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove, computeEntryTaxLines } from './models/accounting.js';
import { accountId } from './models/ledger.js';
import { taxesByGrid } from './models/finance.js';

test('1. JE-16: analytic_distribution is a visible column on manual entry lines with distribution widget when analytic plans exist', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { group_analytic_accounting: true });
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
  assert.equal(taxLineB.tax_base, 0, 'non-contributing repartition row carries 0 base (Finding 1)');
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

test('11. Finding 1: Split tax rows use each split\'s returned base including zero in both domestic and foreign currencies', () => {
  let db = seed();
  const taxAcc1 = accountId(db, '251000');
  const taxAcc2Rec = create(db, 'account.account', { name: 'Split Tax Acc 2', code: '251097', account_type: 'liability_current' });
  db = taxAcc2Rec.db;
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const eurCurr = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eurCurr);

  const splitTax = create(db, 'account.tax', {
    name: 'Multi-row Repartition Tax',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 801, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 802, repartition_type: 'tax', factor_percent: 50, account_id: taxAcc1, tag_ids: [] },
      { id: 803, repartition_type: 'tax', factor_percent: 50, account_id: taxAcc2Rec.id, tag_ids: [] },
    ],
  });
  db = splitTax.db;

  // Domestic: 1000 debit. Only contributing row carries base 1000, other carries 0.
  const domLines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 1000, credit: 0, tax_ids: [splitTax.id] }],
    { move_type: 'entry', company_id: 1 },
    db,
  );
  const domSplit1 = domLines.find((l) => l.tax_repartition_line_id === 802);
  const domSplit2 = domLines.find((l) => l.tax_repartition_line_id === 803);
  assert.equal(domSplit1.tax_base, 1000, 'contributing split carries full taxable base');
  assert.equal(domSplit2.tax_base, 0, 'non-contributing split carries 0 base (no duplicate fallback)');

  // Foreign: 100 EUR at rate 0.5 (200 USD base).
  db = write(db, 'res.currency', eurCurr.id, { rate_ids: [{ date: '2026-06-01', rate: 0.5 }] });
  const fxLines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 200, credit: 0, currency_id: eurCurr.id, amount_currency: 100, tax_ids: [splitTax.id] }],
    { move_type: 'entry', company_id: 1, date: '2026-06-01' },
    db,
  );
  const fxSplit1 = fxLines.find((l) => l.tax_repartition_line_id === 802);
  const fxSplit2 = fxLines.find((l) => l.tax_repartition_line_id === 803);
  assert.equal(fxSplit1.tax_base, 200, 'foreign contributing split carries converted company base');
  assert.equal(fxSplit2.tax_base, 0, 'foreign non-contributing split carries 0 base');
});

test('12. Finding 2: Explicit and fiscal-position-mapped taxes on manual entries are validated against entry company', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Company B' });
  db = c2.db;
  const taxCo2 = create(db, 'account.tax', {
    name: 'Co2 Tax',
    company_id: c2.id,
    amount: 15,
    type_tax_use: 'purchase',
  });
  db = taxCo2.db;
  const fpCo2 = create(db, 'account.fiscal.position', {
    name: 'Co2 FP',
    company_id: c2.id,
  });
  db = fpCo2.db;

  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const cashAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_cash' || a.account_type === 'asset_current');

  // Explicit foreign tax in computeEntryTaxLines throws
  assert.throws(
    () => computeEntryTaxLines([{ account_id: expAcc.id, debit: 100, tax_ids: [taxCo2.id] }], { move_type: 'entry', company_id: 1 }, db),
    /Tax belongs to another company/,
  );

  // Foreign fiscal position in computeEntryTaxLines throws
  assert.throws(
    () => computeEntryTaxLines([{ account_id: expAcc.id, debit: 100, tax_ids: [] }], { move_type: 'entry', company_id: 1, fiscal_position_id: fpCo2.id }, db),
    /Fiscal position belongs to another company/,
  );

  // Foreign fiscal position at create throws
  assert.throws(() => create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    fiscal_position_id: fpCo2.id,
    line_ids: [
      { account_id: expAcc.id, debit: 100, credit: 0 },
      { account_id: cashAcc.id, debit: 0, credit: 100 },
    ],
  }), /Fiscal position belongs to another company/);

  // Foreign fiscal position at postMove throws even on pre-existing unvalidated draft
  const draftWithForeignFp = {
    id: 99999,
    move_type: 'entry',
    state: 'draft',
    company_id: 1,
    fiscal_position_id: fpCo2.id,
    line_ids: [
      { account_id: expAcc.id, debit: 100, credit: 0 },
      { account_id: cashAcc.id, debit: 0, credit: 100 },
    ],
  };
  const dbWithDraft = { ...db, records: { ...db.records, 'account.move': [...(db.records['account.move'] ?? []), draftWithForeignFp] } };
  assert.throws(() => postMove(dbWithDraft, 99999), /Fiscal position belongs to another company/);

  // Manual tax item belonging to another company at postMove throws
  const resTax = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    line_ids: [
      { account_id: expAcc.id, debit: 100, credit: 0 },
      { account_id: cashAcc.id, debit: 0, credit: 100, tax_id: taxCo2.id },
    ],
  });
  assert.throws(() => postMove(resTax.db, resTax.id), /Tax belongs to another company/);
});

test('13. Finding 3: Tax synchronization runs on ORM create, explicit line writes, and postMove', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const cashAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_cash' || a.account_type === 'asset_current');

  const tax = create(db, 'account.tax', {
    name: 'Sync Tax 15%',
    type_tax_use: 'purchase',
    amount: 15,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 901, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 902, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = tax.db;

  // 1. ORM create automatically creates synchronized tax lines without onchange
  const created = create(db, 'account.move', {
    move_type: 'entry',
    date: '2026-06-01',
    line_ids: [
      { account_id: expAcc.id, debit: 1000, credit: 0, tax_ids: [tax.id] },
      { account_id: cashAcc.id, debit: 0, credit: 1150 },
    ],
  });
  db = created.db;
  const createdRec = read(db, 'account.move', created.id);
  assert.equal(createdRec.line_ids.length, 3, 'ORM create generates tax line');
  const taxLine1 = createdRec.line_ids.find((l) => l.tax_id === tax.id && l.tax_repartition_line_id === 902);
  assert.ok(taxLine1);
  assert.equal(taxLine1.debit, 150);

  // 2. ORM explicit write of line_ids resynchronizes tax lines
  db = write(db, 'account.move', created.id, {
    line_ids: [
      { account_id: expAcc.id, debit: 2000, credit: 0, tax_ids: [tax.id] },
      { account_id: cashAcc.id, debit: 0, credit: 2300 },
    ],
  });
  const updatedRec = read(db, 'account.move', created.id);
  assert.equal(updatedRec.line_ids.length, 3, 'ORM write resynchronizes tax line');
  const taxLine2 = updatedRec.line_ids.find((l) => l.tax_id === tax.id && l.tax_repartition_line_id === 902);
  assert.equal(taxLine2.debit, 300);
  assert.equal(taxLine2.tax_base, 2000);

  // 3. postMove runs and validates synchronized lines before posting
  db = postMove(db, created.id);
  const postedRec = read(db, 'account.move', created.id);
  assert.equal(postedRec.state, 'posted');
});

test('14. Finding 4: Pre-existing manual tax items are preserved during line synchronization', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');

  const taxA = create(db, 'account.tax', {
    name: 'Auto Tax 10%',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 1001, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1002, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = taxA.db;

  const taxB = create(db, 'account.tax', {
    name: 'Manual Tax 5%',
    type_tax_use: 'purchase',
    amount: 5,
    amount_type: 'percent',
  });
  db = taxB.db;

  // Entry has a base line and an independent manual tax item without tax_base_line_key
  const lines = [
    { account_id: expAcc.id, debit: 1000, credit: 0, tax_ids: [taxA.id] },
    { account_id: taxAcc, debit: 77, credit: 0, tax_id: taxB.id, name: 'Independent Manual Tax' },
  ];

  const syncd = computeEntryTaxLines(lines, { move_type: 'entry', company_id: 1 }, db);
  // Should have: updated base line (1000), manual tax line (77), generated taxA line (100)
  assert.equal(syncd.length, 3);
  const manual = syncd.find((l) => l.name === 'Independent Manual Tax');
  assert.ok(manual, 'manual tax item preserved');
  assert.equal(manual.debit, 77);
  assert.equal(manual.tax_id, taxB.id);

  const auto = syncd.find((l) => l.tax_id === taxA.id && l.tax_repartition_line_id === 1002);
  assert.ok(auto, 'auto tax line generated');
  assert.equal(auto.debit, 100);

  // Edit base line amount: 1000 -> 2500
  const baseLine = syncd.find((l) => !l.tax_id && !l.tax_repartition_line_id);
  baseLine.debit = 2500;
  const reSyncd = computeEntryTaxLines(syncd, { move_type: 'entry', company_id: 1 }, db);
  assert.equal(reSyncd.length, 3);
  const preservedManual = reSyncd.find((l) => l.name === 'Independent Manual Tax');
  assert.ok(preservedManual, 'manual tax item remains after base line edit');
  assert.equal(preservedManual.debit, 77);
  const updatedAuto = reSyncd.find((l) => l.tax_id === taxA.id && l.tax_repartition_line_id === 1002);
  assert.equal(updatedAuto.debit, 250);
});

test('15. Finding 5: Price-included tax updates base line untaxed amount and entry balances', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const cashAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_cash' || a.account_type === 'asset_current');
  const eurCurr = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eurCurr);

  const inclTax = create(db, 'account.tax', {
    name: 'VAT 10% Incl',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    price_include: true,
    invoice_repartition_line_ids: [
      { id: 1101, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1102, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = inclTax.db;

  // Domestic: gross debit 110 -> base 100, tax 10. Cash credit 110 balances entry!
  const domRes = create(db, 'account.move', {
    move_type: 'entry',
    date: '2026-06-01',
    line_ids: [
      { account_id: expAcc.id, debit: 110, credit: 0, tax_ids: [inclTax.id] },
      { account_id: cashAcc.id, debit: 0, credit: 110 },
    ],
  });
  db = domRes.db;
  const domMove = read(db, 'account.move', domRes.id);
  const domBase = domMove.line_ids.find((l) => !l.tax_id && !l.tax_repartition_line_id);
  const domTax = domMove.line_ids.find((l) => l.tax_id === inclTax.id);
  assert.equal(domBase.debit, 100, 'base line debits computed untaxed amount');
  assert.equal(domTax.debit, 10, 'tax line debits computed tax amount');
  assert.equal(domBase.debit + domTax.debit, 110, 'sum matches counterpart credit 110');

  // Verify it posts cleanly
  db = postMove(db, domRes.id);
  assert.equal(read(db, 'account.move', domRes.id).state, 'posted');

  // Foreign: 110 EUR at rate 0.5 (220 USD gross) -> base 100 EUR (200 USD), tax 10 EUR (20 USD)
  db = write(db, 'res.currency', eurCurr.id, { rate_ids: [{ date: '2026-06-01', rate: 0.5 }] });
  const fxLines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 220, credit: 0, currency_id: eurCurr.id, amount_currency: 110, tax_ids: [inclTax.id] }],
    { move_type: 'entry', company_id: 1, date: '2026-06-01' },
    db,
  );
  const fxBase = fxLines.find((l) => !l.tax_id && !l.tax_repartition_line_id);
  const fxTax = fxLines.find((l) => l.tax_id === inclTax.id);
  assert.equal(fxBase.amount_currency, 100, 'base amount_currency updated to untaxed 100 EUR');
  assert.equal(fxBase.debit, 200, 'base debit updated to converted 200 USD');
  assert.equal(fxTax.amount_currency, 10, 'tax amount_currency is 10 EUR');
  assert.equal(fxTax.debit, 20, 'tax debit is converted 20 USD');
});

test('16. Finding 6: Negative factor repartition split books positive amount on opposite side and posts without badLineSign error', () => {
  let db = seed();
  const taxAcc1 = accountId(db, '251000');
  const taxAcc2Rec = create(db, 'account.account', { name: 'Withholding Tax Acc', code: '251096', account_type: 'liability_current' });
  db = taxAcc2Rec.db;
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const cashAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_cash' || a.account_type === 'asset_current');
  const eurCurr = search(db, 'res.currency').find((c) => c.name === 'EUR');

  const withhTax = create(db, 'account.tax', {
    name: 'Tax with Withholding',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 1201, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1202, repartition_type: 'tax', factor_percent: 120, account_id: taxAcc1, tag_ids: [] }, // +120
      { id: 1203, repartition_type: 'tax', factor_percent: -20, account_id: taxAcc2Rec.id, tag_ids: [] }, // -20
    ],
  });
  db = withhTax.db;

  // Debit base line 1000:
  // Tax 1 (+120% of 100 tax = +120) -> debit 120
  // Tax 2 (-20% of 100 tax = -20) -> opposite side: credit 20, debit 0 (non-negative!)
  // Base 1000 + Tax 1 (debit 120) = 1120 debit; Tax 2 (credit 20) + Cash (credit 1100) = 1120 credit.
  const lines = computeEntryTaxLines(
    [
      { account_id: expAcc.id, debit: 1000, credit: 0, tax_ids: [withhTax.id] },
      { account_id: cashAcc.id, debit: 0, credit: 1100 },
    ],
    { move_type: 'entry', company_id: 1 },
    db,
  );

  const posLine = lines.find((l) => l.tax_repartition_line_id === 1202);
  const negLine = lines.find((l) => l.tax_repartition_line_id === 1203);
  assert.ok(posLine && negLine);

  assert.equal(posLine.debit, 120);
  assert.equal(posLine.credit, 0);

  // Negative split booked on credit side with nonnegative magnitude
  assert.equal(negLine.debit, 0);
  assert.equal(negLine.credit, 20, 'negative factor split books on credit side for debit base');

  // Verify posting succeeds without badLineSign error
  const res = create(db, 'account.move', {
    move_type: 'entry',
    date: '2026-06-01',
    line_ids: lines,
  });
  db = postMove(res.db, res.id);
  assert.equal(read(db, 'account.move', res.id).state, 'posted');

  // Also check foreign currency amount_currency sign follows side
  db = write(db, 'res.currency', eurCurr.id, { rate_ids: [{ date: '2026-06-01', rate: 1 }] });
  const fxLines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 1000, credit: 0, currency_id: eurCurr.id, amount_currency: 1000, tax_ids: [withhTax.id] }],
    { move_type: 'entry', company_id: 1, date: '2026-06-01' },
    db,
  );
  const fxNegLine = fxLines.find((l) => l.tax_repartition_line_id === 1203);
  assert.equal(fxNegLine.amount_currency, -20, 'credit tax line amount_currency is negative');
});

test('17. Finding 7: Changing entry date recalculates company-currency tax amounts with new exchange rate', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const eurCurr = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eurCurr);

  // Rate on 2026-06-01 is 0.5 (1 EUR = 2 USD), rate on 2026-07-01 is 0.25 (1 EUR = 4 USD)
  db = write(db, 'res.currency', eurCurr.id, {
    rate_ids: [
      { date: '2026-06-01', rate: 0.5 },
      { date: '2026-07-01', rate: 0.25 },
    ],
  });

  const tax = create(db, 'account.tax', {
    name: 'FX Rate Tax 10%',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 1301, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1302, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = tax.db;

  const res = create(db, 'account.move', {
    move_type: 'entry',
    date: '2026-06-01',
    line_ids: [
      { account_id: expAcc.id, debit: 200, credit: 0, currency_id: eurCurr.id, amount_currency: 100, tax_ids: [tax.id] },
    ],
  });
  db = res.db;

  let move = read(db, 'account.move', res.id);
  let taxLine = move.line_ids.find((l) => l.tax_id === tax.id);
  assert.equal(taxLine.debit, 20, 'converted at 2026-06-01 rate (10 EUR / 0.5 = 20 USD)');

  // Change date to 2026-07-01 via ORM write
  db = write(db, 'account.move', res.id, { date: '2026-07-01' });
  move = read(db, 'account.move', res.id);
  taxLine = move.line_ids.find((l) => l.tax_id === tax.id);
  assert.equal(taxLine.debit, 40, 'recalculated at 2026-07-01 rate (10 EUR / 0.25 = 40 USD)');

  // Change date via form onchange
  const changed = models['account.move'].onchange({ ...move, date: '2026-06-01' }, 'date', db);
  assert.equal(changed.invoice_date, '2026-06-01');
  const onchangeTaxLine = changed.line_ids.find((l) => l.tax_id === tax.id);
  assert.equal(onchangeTaxLine.debit, 20, 'form onchange recomputes foreign tax with new date rate');
});

test('18. Finding 8: Changing foreign base line to domestic clears currency fields; multiple base lines keep distinct provenance', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const eurCurr = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eurCurr);

  db = write(db, 'res.currency', eurCurr.id, { rate_ids: [{ date: '2026-06-01', rate: 1 }] });

  const tax = create(db, 'account.tax', {
    name: 'Provenance Tax 10%',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 1401, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1402, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = tax.db;

  // 1. Foreign base line generates tax line with currency_id and amount_currency
  let lines = [
    { account_id: expAcc.id, debit: 100, credit: 0, currency_id: eurCurr.id, amount_currency: 100, tax_ids: [tax.id] },
  ];
  let syncd = computeEntryTaxLines(lines, { move_type: 'entry', company_id: 1, date: '2026-06-01' }, db);
  let taxLine = syncd.find((l) => l.tax_id === tax.id);
  assert.equal(taxLine.currency_id, eurCurr.id);
  assert.equal(taxLine.amount_currency, 10);

  // Edit base line to domestic: remove currency_id and amount_currency
  const baseLine = syncd.find((l) => !l.tax_id);
  delete baseLine.currency_id;
  delete baseLine.amount_currency;
  baseLine.debit = 500;
  syncd = computeEntryTaxLines(syncd, { move_type: 'entry', company_id: 1, date: '2026-06-01' }, db);
  taxLine = syncd.find((l) => l.tax_id === tax.id);
  assert.equal(taxLine.currency_id, undefined, 'stale currency_id removed');
  assert.equal(taxLine.amount_currency, undefined, 'stale amount_currency removed');
  assert.equal(taxLine.debit, 50);

  // 2. Multiple base lines with same tax keep distinct provenance
  const multiLines = [
    { account_id: expAcc.id, debit: 1000, credit: 0, tax_ids: [tax.id], line_id: 'base_first' },
    { account_id: expAcc.id, debit: 500, credit: 0, tax_ids: [tax.id], line_id: 'base_second' },
  ];
  const multiSyncd = computeEntryTaxLines(multiLines, { move_type: 'entry', company_id: 1 }, db);
  assert.equal(multiSyncd.length, 4, '2 base lines + 2 tax lines');

  const taxLineFirst = multiSyncd.find((l) => l.tax_base_line_key === 'base_first' && l.tax_repartition_line_id);
  const taxLineSecond = multiSyncd.find((l) => l.tax_base_line_key === 'base_second' && l.tax_repartition_line_id);
  assert.ok(taxLineFirst && taxLineSecond);
  assert.equal(taxLineFirst.debit, 100);
  assert.equal(taxLineSecond.debit, 50);

  // Update only base_second
  const baseSecond = multiSyncd.find((l) => l.line_id === 'base_second');
  baseSecond.debit = 800;
  const reMulti = computeEntryTaxLines(multiSyncd, { move_type: 'entry', company_id: 1 }, db);
  const reTaxFirst = reMulti.find((l) => l.tax_base_line_key === 'base_first' && l.tax_repartition_line_id);
  const reTaxSecond = reMulti.find((l) => l.tax_base_line_key === 'base_second' && l.tax_repartition_line_id);
  assert.equal(reTaxFirst.debit, 100, 'base_first tax line is unaffected');
  assert.equal(reTaxSecond.debit, 80, 'base_second tax line updated');
});

test('19. Finding 9: Mixed sale and purchase price-included taxes compute and split using their respective repartition sides', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');

  // Purchase tax: on debit base uses invoice side (factor 100%). Refund has 60%/40% splits.
  const purchTax = create(db, 'account.tax', {
    name: 'Purch Tax 10%',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    price_include: true,
    invoice_repartition_line_ids: [
      { id: 1501, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1502, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { id: 1503, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1504, repartition_type: 'tax', factor_percent: 60, account_id: taxAcc, tag_ids: [] },
      { id: 15041, repartition_type: 'tax', factor_percent: 40, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = purchTax.db;

  // Sale tax: on debit base uses refund side (factor 100%). Invoice has 70%/30% splits.
  const saleTax = create(db, 'account.tax', {
    name: 'Sale Tax 10%',
    type_tax_use: 'sale',
    amount: 10,
    amount_type: 'percent',
    price_include: true,
    invoice_repartition_line_ids: [
      { id: 1505, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1506, repartition_type: 'tax', factor_percent: 70, account_id: taxAcc, tag_ids: [] },
      { id: 15061, repartition_type: 'tax', factor_percent: 30, account_id: taxAcc, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { id: 1507, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1508, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = saleTax.db;

  // Debit base line with 110 gross and purchTax: untaxed = 100, purchTax = 10 (invoice factor 100%)
  // Debit base line with 110 gross and saleTax: untaxed = 100, saleTax = 10 (refund factor 100%)
  const lines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 110, credit: 0, tax_ids: [purchTax.id, saleTax.id] }],
    { move_type: 'entry', company_id: 1 },
    db,
  );
  // Purch tax split uses invoice side (factor 100%)
  const purchLine = lines.find((l) => l.tax_id === purchTax.id && l.tax_repartition_line_id === 1502);
  assert.ok(purchLine);
  // Sale tax split uses refund side (factor 100%)
  const saleLine = lines.find((l) => l.tax_id === saleTax.id && l.tax_repartition_line_id === 1508);
  assert.ok(saleLine);
});

test('20. Finding 10: Foreign tax splits sharing account and tags aggregate before company-currency conversion', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expAcc = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const eurCurr = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eurCurr);

  // Rate where 1.40 EUR / 0.75 = 1.8666 -> 1.87 USD each (sum = 3.74 USD)
  // but aggregate 2.80 EUR / 0.75 = 3.7333 -> 3.73 USD
  db = write(db, 'res.currency', eurCurr.id, { rate_ids: [{ date: '2026-06-01', rate: 0.75 }] });

  // Tax with two 50% splits sharing the same account and tags
  const aggTax = create(db, 'account.tax', {
    name: 'Agg Tax',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 1601, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { id: 1602, repartition_type: 'tax', factor_percent: 50, account_id: taxAcc, tag_ids: [] },
      { id: 1603, repartition_type: 'tax', factor_percent: 50, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = aggTax.db;

  // Base foreign line: 28 EUR -> 10% tax is 2.80 EUR (two splits of 1.40 EUR each)
  const lines = computeEntryTaxLines(
    [{ account_id: expAcc.id, debit: 37.33, credit: 0, currency_id: eurCurr.id, amount_currency: 28, tax_ids: [aggTax.id] }],
    { move_type: 'entry', company_id: 1, date: '2026-06-01' },
    db,
  );

  const taxLines = lines.filter((l) => l.tax_id === aggTax.id);
  // Aggregated split converts 2.80 EUR -> 3.73 USD (not 3.74 USD)
  const totalTaxCompany = taxLines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  assert.equal(totalTaxCompany, 3.73, 'aggregated conversion produces 3.73 USD without 1-cent discrepancy');
});

test('21. Finding 11: Neutral tax on credit base sets tax_side to sale so taxesByGrid reports positive sign', () => {
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: 'Neutral Base Grid Tag', applicability: 'taxes' });
  db = baseTag.db;
  const taxTag = create(db, 'account.account.tag', { name: 'Neutral Tax Grid Tag', applicability: 'taxes' });
  db = taxTag.db;

  const taxAcc = accountId(db, '251000');
  const revAcc = search(db, 'account.account').find((a) => a.account_type === 'income');
  const cashAcc = search(db, 'account.account').find((a) => a.account_type === 'asset_cash' || a.account_type === 'asset_current');

  const neutralTax = create(db, 'account.tax', {
    name: 'Neutral Tax 10%',
    type_tax_use: 'none',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { id: 1701, repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [baseTag.id] },
      { id: 1702, repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [taxTag.id] },
    ],
  });
  db = neutralTax.db;

  // Credit base entry: credit 1000 on revenue, tax credit 100 on taxAcc, cash debit 1100
  const res = create(db, 'account.move', {
    move_type: 'entry',
    date: '2026-06-01',
    line_ids: [
      { account_id: revAcc.id, debit: 0, credit: 1000, tax_ids: [neutralTax.id] },
      { account_id: cashAcc.id, debit: 1100, credit: 0 },
    ],
  });
  db = postMove(res.db, res.id);

  const posted = read(db, 'account.move', res.id);
  assert.equal(posted.state, 'posted');

  const creditBaseLine = posted.line_ids.find((l) => l.account_id === revAcc.id);
  const creditTaxLine = posted.line_ids.find((l) => l.tax_id === neutralTax.id);
  assert.equal(creditBaseLine.tax_side, 'sale', 'credit base line gets tax_side: sale');
  assert.equal(creditTaxLine.tax_side, 'sale', 'credit tax line gets tax_side: sale');

  // Check taxesByGrid: both base and tax amounts should be strictly positive (sale grid convention)
  const grid = taxesByGrid(db);
  const baseRow = grid.find((r) => r.id === baseTag.id);
  const taxRow = grid.find((r) => r.id === taxTag.id);
  assert.ok(baseRow, 'base grid row found');
  assert.ok(taxRow, 'tax grid row found');
  assert.equal(baseRow.base, 1000, 'credit base appears positive in tax grid');
  assert.equal(taxRow.tax, 100, 'credit tax appears positive in tax grid');
});
