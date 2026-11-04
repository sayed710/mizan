import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { taxesByGrid } from './models/finance.js';
import { migrate, MIGRATIONS, SCHEMA_VERSION } from './migrations.js';
import { accountId } from './models/ledger.js';
import { applyDiff, assignIds, diffDb } from './sync.js';

test('account.tax validation: requires exactly one base row per side', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');

  // Missing base row on invoice side
  assert.throws(() => {
    create(db, 'account.tax', {
      name: 'No Base Tax',
      type_tax_use: 'sale',
      amount: 14,
      invoice_repartition_line_ids: [
        { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
      ],
      refund_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
      ],
    });
  }, /base/i);

  // Two base rows on refund side
  assert.throws(() => {
    create(db, 'account.tax', {
      name: 'Two Base Tax',
      type_tax_use: 'sale',
      amount: 14,
      invoice_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
      ],
      refund_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
      ],
    });
  }, /base/i);
});

test('account.tax validation: requires at least one tax row per side', () => {
  let db = seed();

  assert.throws(() => {
    create(db, 'account.tax', {
      name: 'No Tax Row Tax',
      type_tax_use: 'sale',
      amount: 14,
      invoice_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      ],
      refund_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 100, account_id: null, tag_ids: [] },
      ],
    });
  }, /tax/i);
});

test('account.tax validation: tax factors on each side must sum to 100', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');

  // Sums to 90
  assert.throws(() => {
    create(db, 'account.tax', {
      name: 'Sum 90 Tax',
      type_tax_use: 'sale',
      amount: 14,
      invoice_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 90, account_id: taxAcc, tag_ids: [] },
      ],
      refund_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
      ],
    });
  }, /100/);

  // Sums to 110
  assert.throws(() => {
    create(db, 'account.tax', {
      name: 'Sum 110 Tax',
      type_tax_use: 'sale',
      amount: 14,
      invoice_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
      ],
      refund_repartition_line_ids: [
        { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 60, account_id: taxAcc, tag_ids: [] },
        { repartition_type: 'tax', factor_percent: 50, account_id: taxAcc, tag_ids: [] },
      ],
    });
  }, /100/);
});

test('invoice and refund postings distinguish repartition lines, accounts, and grids', () => {
  let db = seed();

  const invBaseTag = create(db, 'account.account.tag', { name: 'Inv Base Grid', applicability: 'taxes' });
  db = invBaseTag.db;
  const invTaxTag = create(db, 'account.account.tag', { name: 'Inv Tax Grid', applicability: 'taxes' });
  db = invTaxTag.db;
  const refBaseTag = create(db, 'account.account.tag', { name: 'Ref Base Grid', applicability: 'taxes' });
  db = refBaseTag.db;
  const refTaxTag = create(db, 'account.account.tag', { name: 'Ref Tax Grid', applicability: 'taxes' });
  db = refTaxTag.db;

  const invAcc = accountId(db, '251000');
  const refAccRec = create(db, 'account.account', { name: 'Refund Tax Account', code: '251001', account_type: 'liability_current' });
  db = refAccRec.db;
  const refAcc = refAccRec.id;

  const tax = create(db, 'account.tax', {
    name: 'Distinguishable Tax',
    type_tax_use: 'sale',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [invBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: invAcc, tag_ids: [invTaxTag.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [refBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: refAcc, tag_ids: [refTaxTag.id] },
    ],
  });
  db = tax.db;

  // 1. Post an invoice
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', tax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  const postedInv = read(db, 'account.move', inv.id);
  const invBaseItem = postedInv.line_ids.find((l) => l.tax_grid_base);
  assert.ok(invBaseItem, 'invoice base item exists');
  assert.deepEqual(invBaseItem.tax_tag_ids, [invBaseTag.id], 'invoice base tag from invoice base row');

  const invTaxItem = postedInv.line_ids.find((l) => l.tax_name === 'Distinguishable Tax');
  assert.ok(invTaxItem, 'invoice tax item exists');
  assert.equal(invTaxItem.account_id, invAcc, 'invoice tax account from invoice tax row');
  assert.deepEqual(invTaxItem.tax_tag_ids, [invTaxTag.id], 'invoice tax tag from invoice tax row');

  // 2. Post a refund (credit note)
  const ref = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    invoice_date: '2026-06-02',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', tax.id)) }],
  });
  db = postMove(ref.db, ref.id);

  const postedRef = read(db, 'account.move', ref.id);
  const refBaseItem = postedRef.line_ids.find((l) => l.tax_grid_base);
  assert.ok(refBaseItem, 'refund base item exists');
  assert.deepEqual(refBaseItem.tax_tag_ids, [refBaseTag.id], 'refund base tag from refund base row');

  const refTaxItem = postedRef.line_ids.find((l) => l.tax_name === 'Distinguishable Tax');
  assert.ok(refTaxItem, 'refund tax item exists');
  assert.equal(refTaxItem.account_id, refAcc, 'refund tax account from refund tax row');
  assert.deepEqual(refTaxItem.tax_tag_ids, [refTaxTag.id], 'refund tax tag from refund tax row');

  // 3. Verify tax grids
  const grids = taxesByGrid(db, { from: '2026-06-01', to: '2026-06-30' });
  const invBaseGrid = grids.find((g) => g.id === invBaseTag.id);
  const invTaxGrid = grids.find((g) => g.id === invTaxTag.id);
  const refBaseGrid = grids.find((g) => g.id === refBaseTag.id);
  const refTaxGrid = grids.find((g) => g.id === refTaxTag.id);

  assert.equal(invBaseGrid?.base, 100);
  assert.equal(invTaxGrid?.tax, 10);
  assert.equal(refBaseGrid?.base, -100);
  assert.equal(refTaxGrid?.tax, -10);
});

test('tax splitting across multiple accounts with exact cent allocation (largest remainder on last row)', () => {
  let db = seed();
  const acc1 = accountId(db, '251000');
  const acc2Rec = create(db, 'account.account', { name: 'Split Tax Account 2', code: '251002', account_type: 'liability_current' });
  db = acc2Rec.db;
  const acc2 = acc2Rec.id;

  // 50% / 50% split on 10% tax with odd cent amount: price 0.50 -> tax is 0.05
  // 50% of 0.05 is 0.025 each.
  // With largest remainder on the last row: first row gets 0.02, last row gets 0.03.
  const splitTax = create(db, 'account.tax', {
    name: '50-50 Split Tax',
    type_tax_use: 'sale',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: acc1, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: acc2, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: acc1, tag_ids: [] },
    ],
  });
  db = splitTax.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-10',
    invoice_line_ids: [{ qty: 1, price_unit: 0.50, ...taxSnapshot(read(db, 'account.tax', splitTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  const posted = read(db, 'account.move', inv.id);
  const taxItems = posted.line_ids.filter((l) => l.tax_name === '50-50 Split Tax');
  assert.equal(taxItems.length, 2, 'split into 2 tax lines');

  const item1 = taxItems.find((l) => l.account_id === acc1);
  const item2 = taxItems.find((l) => l.account_id === acc2);
  assert.ok(item1 && item2);
  // Credit side for sales tax: item1 gets 0.02, item2 (last row) gets 0.03
  assert.equal(item1.credit, 0.02, 'first tax row gets smaller on tie');
  assert.equal(item2.credit, 0.03, 'last tax row gets largest remainder cent');
  assert.equal(Number((item1.credit + item2.credit).toFixed(2)), 0.05, 'total equals tax amount');
});

test('tax repartition row with empty account_id stays on base line account', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');
  const expenseAcc = accountId(db, '600000');

  const partialDeductible = create(db, 'account.tax', {
    name: '50% Non-Deductible Purchase Tax',
    type_tax_use: 'purchase',
    amount: 10,
    amount_type: 'percent',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: taxAcc, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 50, account_id: null, tag_ids: [] }, // empty = keep on base line's account
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc, tag_ids: [] },
    ],
  });
  db = partialDeductible.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 1,
    invoice_date: '2026-06-15',
    invoice_line_ids: [{ account_id: expenseAcc, qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', partialDeductible.id)) }],
  });
  db = postMove(bill.db, bill.id);

  const posted = read(db, 'account.move', bill.id);
  const taxItems = posted.line_ids.filter((l) => l.tax_name === '50% Non-Deductible Purchase Tax');
  assert.equal(taxItems.length, 2);

  const itemOnTaxAcc = taxItems.find((l) => l.account_id === taxAcc);
  const itemOnBaseAcc = taxItems.find((l) => l.account_id === expenseAcc);
  assert.ok(itemOnTaxAcc, '50% deductible on tax account');
  assert.ok(itemOnBaseAcc, '50% non-deductible on expense account');
  assert.equal(itemOnTaxAcc.debit, 5);
  assert.equal(itemOnBaseAcc.debit, 5);
});

test('schema migration: upgrades legacy taxes with default repartition lines and bumps SCHEMA_VERSION', () => {
  let db = seed();
  const oldDb = {
    ...db,
    schema_version: 27,
    records: {
      ...db.records,
      'account.tax': [
        {
          id: 999,
          name: 'Legacy Tax',
          amount: 14,
          amount_type: 'percent',
          type_tax_use: 'sale',
          account_id: accountId(db, '251000'),
          tag_ids: [1],
        },
      ],
      'account.move': [
        {
          id: 501,
          move_type: 'out_invoice',
          invoice_line_ids: [
            { id: 1, product_id: 1, qty: 1, price_unit: 100, tax_id: 999, tax: 14, tax_account_id: accountId(db, '251000'), tax_tag_ids: [1] },
          ],
        },
      ],
    },
  };

  const migrated = migrate(oldDb);
  assert.equal(migrated.schema_version, MIGRATIONS.at(-1).version);
  assert.equal(SCHEMA_VERSION, MIGRATIONS.at(-1).version);

  const migratedTax = migrated.records['account.tax'].find((t) => t.id === 999);
  assert.ok(migratedTax);
  assert.equal(migratedTax.account_id, undefined);
  assert.equal(migratedTax.tag_ids, undefined);
  assert.equal(migratedTax.base_tag_ids, undefined);
  assert.equal(migratedTax.invoice_repartition_line_ids.length, 2);
  assert.equal(migratedTax.invoice_repartition_line_ids[0].repartition_type, 'base');
  assert.equal(migratedTax.invoice_repartition_line_ids[1].repartition_type, 'tax');
  assert.equal(migratedTax.invoice_repartition_line_ids[1].factor_percent, 100);
  assert.equal(migratedTax.invoice_repartition_line_ids[1].account_id, accountId(db, '251000'));
  assert.deepEqual(migratedTax.invoice_repartition_line_ids[1].tag_ids, [1]);

  assert.equal(migratedTax.refund_repartition_line_ids.length, 2);
  assert.equal(migratedTax.refund_repartition_line_ids[0].repartition_type, 'base');
  assert.equal(migratedTax.refund_repartition_line_ids[1].repartition_type, 'tax');
  assert.equal(migratedTax.refund_repartition_line_ids[1].factor_percent, 100);
  assert.equal(migratedTax.refund_repartition_line_ids[1].account_id, accountId(db, '251000'));
  assert.deepEqual(migratedTax.refund_repartition_line_ids[1].tag_ids, [1]);

  const migratedMove = migrated.records['account.move'].find((m) => m.id === 501);
  assert.ok(migratedMove);
  const [line] = migratedMove.invoice_line_ids;
  assert.equal(line.tax_account_id, undefined);
  assert.equal(line.tax_tag_ids, undefined);
  assert.equal(line.invoice_repartition_line_ids.length, 2);
  assert.equal(line.refund_repartition_line_ids.length, 2);
});

test('server remaps accounts inside invoice line tax repartition snapshots for queued creates', () => {
  const db = seed();
  const queuedId = (db.seq['account.account'] ?? 0) + 1;
  const account = create(db, 'account.account', { name: 'Queued VAT', code: 'QVAT', account_type: 'liability_current', company_id: 1 });
  const rows = [{ repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] }, { repartition_type: 'tax', factor_percent: 100, account_id: queuedId, tag_ids: [] }];
  const invoice = create(account.db, 'account.move', { move_type: 'out_invoice', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 10, invoice_repartition_line_ids: rows, refund_repartition_line_ids: rows }] });
  const collision = create(db, 'account.account', { name: 'Other', code: 'OTHER', account_type: 'liability_current', company_id: 1 }).db;
  const assigned = assignIds(collision, diffDb(db, invoice.db));
  const saved = applyDiff(collision, assigned.diff, { isAdmin: true });
  const remappedId = assigned.remapped['account.account'][queuedId];
  assert.notEqual(remappedId, queuedId);
  const line = read(saved, 'account.move', assigned.remapped['account.move']?.[invoice.id] ?? invoice.id).invoice_line_ids[0];
  assert.equal(line.invoice_repartition_line_ids[1].account_id, remappedId);
  assert.equal(line.refund_repartition_line_ids[1].account_id, remappedId);
});
