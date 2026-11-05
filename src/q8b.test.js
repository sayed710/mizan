import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import './models/index.js';
import { seed } from './seed.js';
import { payMove, postMove } from './models/accounting.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { accountId } from './models/ledger.js';
import { amounts } from './models/common.js';
import { installments } from './models/terms.js';
import { assignIds } from './sync.js';
import { publicOrder } from '../server/api.js';
import { migrate } from './migrations.js';
import { taxAccounts } from './models/finance.js';

test('Qodo 4: Synced group taxes remap child tax_id and repartition account and tag IDs in tax_breakdown', () => {
  const db = seed();
  const diff = {
    created: { 'account.tax': [100, 101], 'account.account': [200], 'account.account.tag': [300], 'account.move': [500] },
    upserts: {
      'account.tax': [
        { id: 100, name: 'Group Tax', amount_type: 'group', children_tax_ids: [101] },
        { id: 101, name: 'Child Tax', amount_type: 'percent', amount: 14 },
      ],
      'account.account': [{ id: 200, code: '259999', name: 'Custom Tax Account' }],
      'account.account.tag': [{ id: 300, name: 'Tax Grid Tag' }],
      'account.move': [
        {
          id: 500,
          move_type: 'out_invoice',
          invoice_line_ids: [
            {
              id: 1,
              product_id: 1,
              qty: 1,
              price_unit: 100,
              tax_id: 100,
              tax_breakdown: [
                {
                  tax_id: 101,
                  tax: 14,
                  tax_name: 'Child Tax',
                  invoice_repartition_line_ids: [
                    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
                    { repartition_type: 'tax', factor_percent: 100, account_id: 200, tag_ids: [300] },
                  ],
                  refund_repartition_line_ids: [
                    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
                    { repartition_type: 'tax', factor_percent: 100, account_id: 200, tag_ids: [300] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const { diff: remappedDiff, remapped } = assignIds(db, diff);
  assert.ok(remapped['account.tax'][101], 'Child tax got new server id');
  assert.ok(remapped['account.account'][200], 'Account got new server id');
  assert.ok(remapped['account.account.tag'][300], 'Tag got new server id');

  const [remappedMove] = remappedDiff.upserts['account.move'];
  const [line] = remappedMove.invoice_line_ids;
  const [childSnap] = line.tax_breakdown;

  assert.equal(childSnap.tax_id, remapped['account.tax'][101]);
  assert.equal(childSnap.invoice_repartition_line_ids[1].account_id, remapped['account.account'][200]);
  assert.deepEqual(childSnap.invoice_repartition_line_ids[1].tag_ids, [remapped['account.account.tag'][300]]);
  assert.equal(childSnap.refund_repartition_line_ids[1].account_id, remapped['account.account'][200]);
  assert.deepEqual(childSnap.refund_repartition_line_ids[1].tag_ids, [remapped['account.account.tag'][300]]);
});

test('Qodo 9: Website orders use active company for order and tax snapshots', () => {
  let db = seed();
  const c2Res = create(db, 'res.company', { name: 'Firm Two' });
  db = c2Res.db;
  const c2Id = c2Res.id;

  const taxAcc = create(db, 'account.account', { code: '251002', name: 'VAT Output C2', company_id: c2Id, account_type: 'liability_current' });
  db = taxAcc.db;

  const c2Tax = create(db, 'account.tax', {
    name: 'C2 Tax 20%',
    type_tax_use: 'sale',
    amount: 20,
    company_id: c2Id,
    ...defaultTaxRepartitionLines(taxAcc.id),
  });
  db = c2Tax.db;

  const product = create(db, 'product', {
    name: 'C2 Widget',
    list_price: 100,
    qty_available: 10,
    sale_ok: true,
    is_published: true,
    tax_id: c2Tax.id,
  });
  db = product.db;

  db = updateSettings(db, { current_company_id: c2Id });

  const result = publicOrder(db, {
    name: 'Buyer',
    email: 'buyer@example.com',
    carrier_id: 1,
    lines: [{ product_id: product.id, qty: 1 }],
    provider_code: 'wire',
  });

  assert.equal(result.status, 201, result.body?.error);
  const order = search(result.db, 'sale.order').find((o) => o.name === result.body.order);
  assert.ok(order);
  assert.equal(order.company_id, c2Id, 'Sale order belongs to current company 2');
  assert.equal(order.order_line[0].tax_id, c2Tax.id, 'Line uses Company 2 tax');
});

test('Qodo 21: amounts and invoiceTaxGroups keep distinct tax IDs separate under global rounding', () => {
  let db = seed();
  const taxAcc = accountId(db, '251000');

  const taxA = create(db, 'account.tax', {
    name: 'Small Tax',
    amount: 0.5,
    amount_type: 'percent',
    type_tax_use: 'sale',
    ...defaultTaxRepartitionLines(taxAcc),
  });
  db = taxA.db;

  const taxB = create(db, 'account.tax', {
    name: 'Small Tax',
    amount: 0.5,
    amount_type: 'percent',
    type_tax_use: 'sale',
    ...defaultTaxRepartitionLines(taxAcc),
  });
  db = taxB.db;

  db = updateSettings(db, { tax_calculation_rounding_method: 'round_globally' });
  db = write(db, 'res.company', 1, { tax_calculation_rounding_method: 'round_globally' });

  // On $1.00, each 0.5% tax is 0.005. Under global rounding:
  // Separate buckets: 0.005 -> 0.01 and 0.005 -> 0.01 => total tax 0.02, total 1.02.
  const snapA = taxSnapshot(read(db, 'account.tax', taxA.id), db);
  const snapB = taxSnapshot(read(db, 'account.tax', taxB.id), db);
  const lines = [{
    qty: 1,
    price_unit: 1.00,
    discount: 0,
    tax_breakdown: [snapA, snapB],
  }];

  const calc = amounts(lines, null, { roundingMethod: 'round_globally' });
  assert.equal(calc.untaxed, 1.00);
  assert.equal(calc.tax, 0.02, 'amounts keeps distinct tax IDs separate yielding 0.02 total tax');
  assert.equal(calc.total, 1.02);

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_line_ids: lines,
  });
  db = postMove(inv.db, inv.id);

  const posted = read(db, 'account.move', inv.id);
  const postedTaxLines = posted.line_ids.filter((l) => l.account_id === taxAcc);
  const totalPostedTax = postedTaxLines.reduce((s, l) => s + (Number(l.credit) || 0) - (Number(l.debit) || 0), 0);
  assert.equal(Math.round(totalPostedTax * 100) / 100, 0.02);

  const revenueLine = posted.line_ids.find((l) => l.account_id === accountId(db, '400000'));
  assert.equal(revenueLine.credit, 1.00, 'Revenue base is not reduced by a false docGap');
});

test('Qodo 22: Plain-rate VAT is booked as tax journal item, not revenue', () => {
  let db = seed();
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 14 }],
  });
  db = postMove(inv.db, inv.id);

  const posted = read(db, 'account.move', inv.id);
  const taxAccount = accountId(db, '251000');
  const revenueAccount = accountId(db, '400000');

  const taxLine = posted.line_ids.find((l) => l.account_id === taxAccount);
  assert.ok(taxLine, 'Tax journal item is created on tax account 251000');
  assert.equal(taxLine.credit, 14, 'Tax is credited for 14');

  const revLine = posted.line_ids.find((l) => l.account_id === revenueAccount);
  assert.ok(revLine);
  assert.equal(revLine.credit, 100, 'Revenue remains 100 and does not absorb VAT');
});

test('Qodo 23: Cash-basis payments release split tax accounts proportionally', () => {
  let db = seed();
  const taxAcc1 = accountId(db, '251000');
  const taxAcc2 = create(db, 'account.account', { code: '252000', name: 'Secondary VAT Output', company_id: 1, account_type: 'liability_current' });
  db = taxAcc2.db;

  const splitCashTax = create(db, 'account.tax', {
    name: 'Split Cash VAT 10%',
    type_tax_use: 'sale',
    amount: 10,
    amount_type: 'percent',
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(db, '251100'),
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 60, account_id: taxAcc1, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 40, account_id: taxAcc2.id, tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc1, tag_ids: [] },
    ],
  });
  db = splitCashTax.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', splitCashTax.id)) }],
  });
  db = postMove(inv.db, inv.id);

  // Pay in full: 100 base + 10 tax = 110
  db = payMove(db, inv.id, 110, '2026-05-02');

  const relMove = search(db, 'account.move').find((m) => m.cash_basis_origin_move_id === inv.id);
  assert.ok(relMove, 'Cash basis release entry was generated');

  const relItem1 = relMove.line_ids.find((l) => l.account_id === taxAcc1);
  const relItem2 = relMove.line_ids.find((l) => l.account_id === taxAcc2.id);

  assert.ok(relItem1, 'First tax account received released cash basis tax');
  assert.ok(relItem2, 'Second split tax account received released cash basis tax');
  assert.equal(relItem1.credit, 6, '60% of 10 = 6 on first tax account');
  assert.equal(relItem2.credit, 4, '40% of 10 = 4 on second tax account');
});

test('Qodo 72: Migration 28 sets default tax accounts for legacy taxes without account_id', () => {
  const base = seed();
  const oldDb = {
    ...base,
    schema_version: 27,
    records: {
      ...base.records,
      'account.tax': [
        { id: 980, name: 'Legacy Sale VAT', amount: 14, amount_type: 'percent', type_tax_use: 'sale' },
        { id: 981, name: 'Legacy Purchase VAT', amount: 14, amount_type: 'percent', type_tax_use: 'purchase' },
      ],
    },
  };

  const migrated = migrate(oldDb);
  const saleTax = migrated.records['account.tax'].find((t) => t.id === 980);
  const purchTax = migrated.records['account.tax'].find((t) => t.id === 981);

  assert.equal(saleTax.invoice_repartition_line_ids[1].account_id, accountId(base, '251000'));
  assert.equal(purchTax.invoice_repartition_line_ids[1].account_id, accountId(base, '131000'));

  const accounts = taxAccounts(migrated, 1);
  assert.ok(accounts.sale.has(accountId(base, '251000')));
  assert.ok(accounts.purchase.has(accountId(base, '131000')));
});

test('Qodo 74: Migration 28 leaves base repartition tag_ids empty when only tag_ids are present', () => {
  const base = seed();
  const oldDb = {
    ...base,
    schema_version: 27,
    records: {
      ...base.records,
      'account.tax': [
        { id: 982, name: 'Grid Tagged Tax', amount: 14, amount_type: 'percent', type_tax_use: 'sale', tag_ids: [42] },
      ],
      'account.move': [
        {
          id: 502,
          move_type: 'out_invoice',
          invoice_line_ids: [
            { id: 1, product_id: 1, qty: 1, price_unit: 100, tax_id: 982, tax: 14, tax_tag_ids: [42] },
          ],
        },
      ],
    },
  };

  const migrated = migrate(oldDb);
  const tax = migrated.records['account.tax'].find((t) => t.id === 982);
  assert.deepEqual(tax.invoice_repartition_line_ids[0].tag_ids, [], 'Base row tag_ids must be empty');
  assert.deepEqual(tax.invoice_repartition_line_ids[1].tag_ids, [42], 'Tax row retains tax tag');

  const move = migrated.records['account.move'].find((m) => m.id === 502);
  const [line] = move.invoice_line_ids;
  assert.deepEqual(line.invoice_repartition_line_ids[0].tag_ids, [], 'Line base row tag_ids must be empty');
  assert.deepEqual(line.invoice_repartition_line_ids[1].tag_ids, [42], 'Line tax row tag_ids retains tax tag');
});

test('Qodo 14: Invoices with fixed-amount payment terms post and calculate installments', () => {
  let db = seed();
  const mixedTerm = create(db, 'account.payment.term', {
    name: 'Fixed 125 + 87.5%',
    line_ids: [
      { value: 125, value_type: 'fixed', nb_days: 0, delay_type: 'days_after' },
      { value: 87.5, value_type: 'percent', nb_days: 30, delay_type: 'days_after' },
    ],
  });
  db = mixedTerm.db;

  // On a 2000 invoice: fixed 125, remainder 1875.
  const rows = installments(read(db, 'account.payment.term', mixedTerm.id), 2000, '2026-06-01');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, 125);
  assert.equal(rows[1].amount, 1875);

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-06-01',
    invoice_payment_term_id: mixedTerm.id,
    invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 1000 }],
  });

  // Must post without error
  assert.doesNotThrow(() => {
    db = postMove(inv.db, inv.id);
  });
  assert.equal(read(db, 'account.move', inv.id).state, 'posted');

  // Verify pure percentage term without 100% still throws
  assert.throws(() => installments({ line_ids: [{ value_type: 'percent', value: 10 }, { value_type: 'percent', value: 10 }] }, 1000, '2026-06-01'), /100%/);
});

test('Qodo 44: Cross-company payment terms are rejected on invoice create, write, and post', () => {
  let db = seed();
  const c2Res = create(db, 'res.company', { name: 'Foreign Firm' });
  db = c2Res.db;
  const c2Id = c2Res.id;

  const termC2 = create(db, 'account.payment.term', {
    name: 'Net 45 C2',
    company_id: c2Id,
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 45, delay_type: 'days_after' }],
  });
  db = termC2.db;

  // 1. Create invoice in Company 1 with Company 2's payment term
  assert.throws(() => {
    create(db, 'account.move', {
      move_type: 'out_invoice',
      company_id: 1,
      partner_id: 1,
      invoice_date: '2026-07-01',
      invoice_payment_term_id: termC2.id,
      invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
    });
  }, /Payment terms belong to another company/);

  // 2. Write foreign payment term to existing Company 1 invoice
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-07-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = inv.db;

  assert.throws(() => {
    write(db, 'account.move', inv.id, { invoice_payment_term_id: termC2.id });
  }, /Payment terms belong to another company/);

  // 3. PostMove rejects foreign payment term
  const forgedDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (m.id === inv.id ? { ...m, invoice_payment_term_id: termC2.id } : m)),
    },
  };

  assert.throws(() => {
    postMove(forgedDb, inv.id);
  }, /Payment terms belong to another company/);
});
