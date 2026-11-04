import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { reprintCheck } from './models/pay.js';
import { postBatch } from './models/payments.js';
import { postMove, payMove } from './models/accounting.js';
import { secureEntries } from './models/hash_chain.js';
import { confirmAsset, modifyAsset, postDepreciation } from './models/assets.js';
import { applyDiff } from './sync.js';

test('1. Posted check numbers cannot be forged by supplying voided_check_numbers via write or sync', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 500 });

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 7,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ qty: 1, price_unit: 150, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);
  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: bank.id,
    date: '2026-04-02',
    lines: [{ move_id: bill.id, amount: 150 }],
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const payId = read(db, 'account.batch.payment', batch.id).lines[0].payment_id;
  const pay = read(db, 'account.payment', payId);
  assert.equal(pay.check_number, 500);

  // Attempting to forge check_number via ordinary write while supplying the previous number in voided_check_numbers must fail.
  assert.throws(
    () => write(db, 'account.payment', pay.id, {
      check_number: 501,
      voided_check_numbers: [{ check_number: 500, date: '2026-04-02' }],
    }),
    /Issued check numbers cannot be changed/,
  );

  // Attempting to forge check_number via sync diff without journal sequence & reprint transition must also fail.
  assert.throws(
    () => applyDiff(db, {
      upserts: {
        'account.payment': [{
          ...read(db, 'account.payment', pay.id),
          check_number: 501,
          voided_check_numbers: [{ check_number: 500, date: '2026-04-02' }],
        }],
      },
    }),
    /check number|reprinting/i,
  );

  // Legitimate reprintCheck action succeeds, records void history, and advances journal sequence.
  db = reprintCheck(db, read(db, 'account.payment', pay.id));
  const reprinted = read(db, 'account.payment', pay.id);
  assert.equal(reprinted.check_number, 501);
  assert.deepEqual(reprinted.voided_check_numbers.map((v) => v.check_number), [500]);
  assert.equal(read(db, 'account.journal', bank.id).check_next_number, 502);

  // Previously recorded voided check numbers cannot be altered even when keeping the same check_number.
  assert.throws(
    () => write(db, 'account.payment', pay.id, {
      voided_check_numbers: [{ check_number: 500, date: '2020-01-01' }],
    }),
    /Issued check numbers cannot be changed/,
  );
});

test('6. Mixed-discount invoices with multiple distinct tax groups match the posted ledger receivable', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const incomeAcc = search(db, 'account.account').find((a) => a.code === '400000');
  const taxAcc = search(db, 'account.account').find((a) => a.code === '251000');

  // Create a mixed early-payment discount payment term (2% discount -> factor 0.98).
  let termId;
  ({ db, id: termId } = create(db, 'account.payment.term', {
    name: '2% 10 Net 30 Mixed',
    early_discount: true,
    discount_percentage: 2,
    discount_days: 10,
    early_pay_discount_computation: 'mixed',
    line_ids: [{ value: 'balance', days: 30 }],
  }));

  // Three distinct tax groups with raw tax 0.12 each:
  // Aggregate: round(0.36 * 0.98) = round(0.3528) = 0.35
  // Per group: 3 * round(0.12 * 0.98) = 3 * round(0.1176) = 3 * 0.12 = 0.36
  let moveId;
  ({ db, id: moveId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-04-01',
    invoice_payment_term_id: termId,
    invoice_line_ids: [
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax A 12%', tax_account_id: taxAcc.id },
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax B 12%', tax_account_id: taxAcc.id },
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax C 12%', tax_account_id: taxAcc.id },
    ],
  }));

  const draft = read(db, 'account.move', moveId);
  assert.equal(models['account.move'].fields.amount_tax.compute(draft, db), 0.36);
  assert.equal(models['account.move'].fields.amount_total.compute(draft, db), 3.36);

  db = postMove(db, moveId);
  const posted = read(db, 'account.move', moveId);
  const receivable = posted.line_ids
    .filter((l) => l.name === posted.name)
    .reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);

  assert.equal(receivable, 3.36);
  assert.equal(models['account.move'].fields.amount_total.compute(posted, db), receivable);
  assert.equal(models['account.move'].fields.amount_residual.compute(posted, db), receivable);

  // Paying the posted receivable settles the invoice completely with 0 residual.
  db = payMove(db, moveId, receivable, '2026-04-20');
  const settled = read(db, 'account.move', moveId);
  assert.equal(models['account.move'].fields.amount_residual.compute(settled, db), 0);
  assert.equal(models['account.move'].fields.payment_state.compute(settled, db), 'paid');
});

test('8. Extending an asset depreciation board does not skip the period after retained unposted lines', () => {
  let db = seed();
  let assetId;
  ({ db, id: assetId } = create(db, 'account.asset', {
    name: 'Monthly Laptop',
    original_value: 300,
    salvage_value: 0,
    acquisition_date: '2026-01-01',
    method: 'linear',
    method_number: 3,
    method_period: '1',
    prorata: false,
  }));
  db = confirmAsset(db, read(db, 'account.asset', assetId));
  let asset = read(db, 'account.asset', assetId);
  assert.deepEqual(asset.depreciation_ids.map((l) => l.date), ['2026-01-31', '2026-02-28', '2026-03-31']);

  // Extend the Jan-Mar board to 4 periods before any depreciation is due.
  db = modifyAsset(db, asset, { date: '2026-01-15', methodNumber: 4 });
  asset = read(db, 'account.asset', assetId);
  assert.deepEqual(
    asset.depreciation_ids.map((l) => l.date),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'],
  );

  let prorataAssetId;
  ({ db, id: prorataAssetId } = create(db, 'account.asset', {
    name: 'Prorata Laptop',
    original_value: 300,
    salvage_value: 0,
    acquisition_date: '2026-01-15',
    method: 'linear',
    method_number: 2,
    method_period: '1',
    prorata: true,
  }));
  db = confirmAsset(db, read(db, 'account.asset', prorataAssetId));
  let prorataAsset = read(db, 'account.asset', prorataAssetId);
  assert.deepEqual(prorataAsset.depreciation_ids.map((l) => l.date), ['2026-01-31', '2026-02-28', '2026-03-31']);

  db = modifyAsset(db, prorataAsset, { date: '2026-01-15', methodNumber: 4 });
  prorataAsset = read(db, 'account.asset', prorataAssetId);
  assert.deepEqual(
    prorataAsset.depreciation_ids.map((l) => l.date),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'],
  );
});

test('9. Modifying an asset settles due depreciation before recalculating the remaining schedule', () => {
  let db = seed();
  const assetAcc = search(db, 'account.account').find((a) => a.code === '151000');
  const depAcc = search(db, 'account.account').find((a) => a.code === '152000');
  const expAcc = search(db, 'account.account').find((a) => a.code === '680000');
  const revalAcc = search(db, 'account.account').find((a) => a.code === '450300');
  let assetId;
  ({ db, id: assetId } = create(db, 'account.asset', {
    name: 'Delivery Van',
    original_value: 3000,
    salvage_value: 0,
    acquisition_date: '2026-01-01',
    method: 'linear',
    method_number: 3,
    method_period: '1',
    prorata: false,
    account_asset_id: assetAcc.id,
    account_depreciation_id: depAcc.id,
    account_depreciation_expense_id: expAcc.id,
  }));
  db = confirmAsset(db, read(db, 'account.asset', assetId));

  // Modify on 2026-02-15 without having manually run postDepreciation for January first.
  db = modifyAsset(db, read(db, 'account.asset', assetId), {
    date: '2026-02-15',
    value_change: 600,
    accountId: revalAcc.id,
  });

  let asset = read(db, 'account.asset', assetId);
  // January (2026-01-31 <= 2026-02-15) must have been settled at its original 1000 amount, not rewritten to 1200.
  assert.equal(asset.depreciation_ids[0].date, '2026-01-31');
  assert.equal(asset.depreciation_ids[0].posted, true);
  assert.equal(asset.depreciation_ids[0].amount, 1000);

  // Only February and March (after 2026-02-15) reflect the +600 revaluation ((3600 - 1000) / 2 = 1300 each).
  assert.equal(asset.depreciation_ids[1].date, '2026-02-28');
  assert.equal(asset.depreciation_ids[1].posted, false);
  assert.equal(asset.depreciation_ids[1].amount, 1300);
  assert.equal(asset.depreciation_ids[2].date, '2026-03-31');
  assert.equal(asset.depreciation_ids[2].posted, false);
  assert.equal(asset.depreciation_ids[2].amount, 1300);

  // Posting remaining depreciation afterward posts Feb and Mar at 1300 and closes the asset.
  db = postDepreciation(db, asset, '2026-03-31');
  asset = read(db, 'account.asset', assetId);
  assert.equal(asset.state, 'close');
  assert.deepEqual(asset.depreciation_ids.map((l) => l.amount), [1000, 1300, 1300]);
});

test('10. Mixed-currency billing converts linked invoice totals into the order currency for credit exposure', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  db = write(db, 'res.partner', partner.id, { credit_limit: 80 });

  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  // Set EUR rate to 2.0 (2 EUR = 1 USD) on 2026-04-01.
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [...(eur.rate_ids ?? []), { date: '2026-04-01', rate: 2 }],
  });

  const product = search(db, 'product')[0];
  let orderId;
  ({ db, id: orderId } = create(db, 'sale.order', {
    partner_id: partner.id,
    currency_id: usd.id,
    date_order: '2026-04-01',
    order_line: [{ product_id: product.id, qty: 1, price_unit: 100, tax: 0 }],
  }));
  const confirmBtn = models['sale.order'].form.buttons.find((b) => b.label === 'Confirm');
  ({ db } = confirmBtn.run(db, read(db, 'sale.order', orderId)));

  // Manually link and post a same-company invoice in EUR for 100 EUR (= 50 USD at rate 2).
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const incomeAcc = search(db, 'account.account').find((a) => a.code === '400000');
  let invId;
  ({ db, id: invId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournal.id,
    currency_id: eur.id,
    invoice_date: '2026-04-01',
    sale_id: orderId,
    invoice_line_ids: [{ account_id: incomeAcc.id, qty: 1, price_unit: 100, tax: 0 }],
  }));
  db = postMove(db, invId);

  // Receivable is 50 USD; remaining uninvoiced order is 100 USD - 50 USD = 50 USD.
  // Total exposure is 50 + 50 = 100 USD > 80 USD credit limit, so form.warning must still trigger.
  const order = read(db, 'sale.order', orderId);
  const warning = models['sale.order'].form.warning(order, db);
  assert.match(warning, /exceed the credit limit \(100 > 80\)/);
});

test('13. Dispute flag (blocked) can be toggled on posted entries in a locked period or with an inalterability hash', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = write(db, 'account.journal', saleJournal.id, { restrict_mode_hash_table: true });
  const incomeAcc = search(db, 'account.account').find((a) => a.code === '400000');

  let invId;
  ({ db, id: invId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ account_id: incomeAcc.id, qty: 1, price_unit: 200, tax: 0 }],
  }));
  db = postMove(db, invId);
  db = secureEntries(db, { hashDate: '2099-12-31' });
  let posted = read(db, 'account.move', invId);
  assert.ok(posted.inalterable_hash, 'Expected posted invoice to carry an inalterability hash');

  // Lock the period covering the invoice.
  db.settings.lock_date = '2026-04-30';
  db.settings.hard_lock_date = '2026-04-30';

  // Toggling `blocked` on the receivable line passes securedMoveRule, lockRule, and postedMoveRule.
  const toggledLines = posted.line_ids.map((l) => (l.debit > 0 ? { ...l, blocked: true } : l));
  db = write(db, 'account.move', invId, { line_ids: toggledLines });
  posted = read(db, 'account.move', invId);
  assert.equal(posted.line_ids.find((l) => l.debit > 0).blocked, true);

  // Editing any other field on line_ids while locked/hashed is still rejected.
  const badLines = posted.line_ids.map((l) => (l.debit > 0 ? { ...l, name: 'Tampered' } : l));
  assert.throws(() => write(db, 'account.move', invId, { line_ids: badLines }), /Secured entries cannot be modified/);
});
