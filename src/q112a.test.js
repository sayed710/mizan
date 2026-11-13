import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { payOrder, refundOrder, startSession } from './models/pos.js';

test('direct refund without partner_id reverses sale on partner configured receivable account', () => {
  const base = seed();
  const customReceivable = create(base, 'account.account', {
    name: 'Customer Special Receivable',
    code: '121099',
    account_type: 'asset_receivable',
    company_id: 1,
  });
  const partner = create(customReceivable.db, 'res.partner', {
    name: 'VIP Customer',
    property_account_receivable_id: customReceivable.id,
  });
  const opened = startSession(partner.db).db;
  const lines = [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }];
  const sale = payOrder(opened, { lines, method: 'cash', partner_id: partner.id });
  const saleOrder = read(sale.db, 'pos.order', sale.id);

  // Verify the sale used customReceivable
  const saleEntry = read(sale.db, 'account.move', saleOrder.accounting_entries[0].move_id);
  const salePaymentEntry = read(sale.db, 'account.move', saleOrder.accounting_entries[1].move_id);
  assert.equal(saleEntry.partner_id, partner.id);
  assert.ok(salePaymentEntry.line_ids.some((l) => l.account_id === customReceivable.id && l.credit === 100 && l.partner_id === partner.id));

  // Direct refund omits partner_id
  const refund = payOrder(sale.db, { lines: saleOrder.lines, method: 'cash', refund_of: saleOrder.id });
  const refOrder = read(refund.db, 'pos.order', refund.id);
  const refEntry = read(refund.db, 'account.move', refOrder.accounting_entries[0].move_id);
  const refPaymentEntry = read(refund.db, 'account.move', refOrder.accounting_entries[1].move_id);

  assert.equal(refOrder.partner_id, partner.id);
  assert.equal(refEntry.partner_id, partner.id);
  assert.ok(
    refPaymentEntry.line_ids.some((l) => l.account_id === customReceivable.id && l.debit === 100 && l.partner_id === partner.id),
    'refund must reverse receivable on partner configured account with partner_id'
  );
  // Ensure default company receivable account (121000) was NOT used
  const defaultReceivable = read(refund.db, 'res.company', 1).account_default_receivable_id;
  assert.equal(refPaymentEntry.line_ids.some((l) => l.account_id === defaultReceivable), false);
});

test('refund reverses original rounding account even if rounding method changed, disabled, or removed from config', () => {
  let db = seed();
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');

  const profitAcc1 = accountId(db, '450000');
  const lossAcc1 = accountId(db, '690000');

  const profitAcc2 = create(db, 'account.account', { name: 'Profit 2', code: '450002', account_type: 'income_other', company_id: 1 });
  const lossAcc2 = create(profitAcc2.db, 'account.account', { name: 'Loss 2', code: '690002', account_type: 'expense_other', company_id: 1 });

  const rounding1 = create(lossAcc2.db, 'account.cash.rounding', {
    name: '0.05 UP R1',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc1,
    loss_account_id: lossAcc1,
  });

  const rounding2 = create(rounding1.db, 'account.cash.rounding', {
    name: '0.05 UP R2',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc2.id,
    loss_account_id: lossAcc2.id,
  });

  db = write(rounding2.db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: rounding1.id });
  db = startSession(db, 0, cfg.id).db;

  // 10.02 rounded UP to 10.05 => roundingDiff = +0.03 (profit on profitAcc1)
  const lines = [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }];
  const sale = payOrder(db, { lines, method: cash.id });
  const saleOrder = read(sale.db, 'pos.order', sale.id);
  assert.equal(saleOrder.rounding_account_id, profitAcc1, 'sale must record rounding_account_id on pos.order');
  const saleEntry = read(sale.db, 'account.move', saleOrder.accounting_entries[0].move_id);
  const saleRoundingLine = saleEntry.line_ids.find((l) => l.name === 'Cash Rounding');
  assert.ok(saleRoundingLine);
  assert.equal(saleRoundingLine.account_id, profitAcc1);
  assert.equal(saleRoundingLine.credit, 0.03);

  // Subtest 1: config changes rounding_method_id to rounding2 (which uses profitAcc2)
  const changedDb = write(sale.db, 'pos.config', cfg.id, { rounding_method_id: rounding2.id });
  const refund1 = payOrder(changedDb, { lines: saleOrder.lines, method: cash.id, refund_of: saleOrder.id });
  const refOrder1 = read(refund1.db, 'pos.order', refund1.id);
  const refEntry1 = read(refund1.db, 'account.move', refOrder1.accounting_entries[0].move_id);
  const refRoundingLine1 = refEntry1.line_ids.find((l) => l.name === 'Cash Rounding');
  assert.ok(refRoundingLine1);
  assert.equal(refRoundingLine1.account_id, profitAcc1, 'must reverse to profitAcc1 even though config now points to rounding2');
  assert.equal(refRoundingLine1.debit, 0.03);

  // Subtest 2: config disables cash rounding and clears rounding_method_id
  const disabledDb = write(sale.db, 'pos.config', cfg.id, { cash_rounding: false, rounding_method_id: null });
  const refund2 = payOrder(disabledDb, { lines: saleOrder.lines, method: cash.id, refund_of: saleOrder.id });
  const refOrder2 = read(refund2.db, 'pos.order', refund2.id);
  const refEntry2 = read(refund2.db, 'account.move', refOrder2.accounting_entries[0].move_id);
  const refRoundingLine2 = refEntry2.line_ids.find((l) => l.name === 'Cash Rounding');
  assert.ok(refRoundingLine2);
  assert.equal(refRoundingLine2.account_id, profitAcc1, 'must reverse to profitAcc1 even though config cleared rounding_method_id');
  assert.equal(refRoundingLine2.debit, 0.03);

  // Subtest 3: rounding1 method changes its profit account in DB
  const modifiedRoundingDb = write(sale.db, 'account.cash.rounding', rounding1.id, { profit_account_id: profitAcc2.id });
  const refund3 = payOrder(modifiedRoundingDb, { lines: saleOrder.lines, method: cash.id, refund_of: saleOrder.id });
  const refOrder3 = read(refund3.db, 'pos.order', refund3.id);
  const refEntry3 = read(refund3.db, 'account.move', refOrder3.accounting_entries[0].move_id);
  const refRoundingLine3 = refEntry3.line_ids.find((l) => l.name === 'Cash Rounding');
  assert.ok(refRoundingLine3);
  assert.equal(refRoundingLine3.account_id, profitAcc1, 'must reverse to original profitAcc1 even if rounding1 profit_account_id changed');
  assert.equal(refRoundingLine3.debit, 0.03);

  // Subtest 4: inactive or foreign-company recorded rounding account throws clear error
  const inactiveAccDb = write(sale.db, 'account.account', profitAcc1, { active: false });
  assert.throws(
    () => payOrder(inactiveAccDb, { lines: saleOrder.lines, method: cash.id, refund_of: saleOrder.id }),
    /Original POS rounding account belongs to another company or is inactive/
  );
  const foreignAccDb = write(sale.db, 'account.account', profitAcc1, { company_id: 2 });
  assert.throws(
    () => payOrder(foreignAccDb, { lines: saleOrder.lines, method: cash.id, refund_of: saleOrder.id }),
    /Original POS rounding account belongs to another company or is inactive/
  );
});

test('refund of historical order without recorded rounding_account_id resolves from current configuration or fails clearly', () => {
  let db = seed();
  const cfg = search(db, 'pos.config')[0];
  const cash = search(db, 'pos.payment.method').find((m) => m.type === 'cash');

  const profitAcc1 = accountId(db, '450000');
  const lossAcc1 = accountId(db, '690000');

  const profitAcc2 = create(db, 'account.account', { name: 'Profit 2', code: '450002', account_type: 'income_other', company_id: 1 });
  const lossAcc2 = create(profitAcc2.db, 'account.account', { name: 'Loss 2', code: '690002', account_type: 'expense_other', company_id: 1 });

  const rounding1 = create(lossAcc2.db, 'account.cash.rounding', {
    name: '0.05 UP R1',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc1,
    loss_account_id: lossAcc1,
  });

  const rounding2 = create(rounding1.db, 'account.cash.rounding', {
    name: '0.05 UP R2',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: profitAcc2.id,
    loss_account_id: lossAcc2.id,
  });

  db = write(rounding2.db, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: rounding1.id });
  db = startSession(db, 0, cfg.id).db;

  // 10.02 rounded UP to 10.05 => roundingDiff = +0.03
  const lines = [{ product_id: 5, qty: 1, price_unit: 10.02, tax: 0 }];
  const sale = payOrder(db, { lines, method: cash.id });

  // Simulate historical order by clearing rounding_account_id
  const histDb = write(sale.db, 'pos.order', sale.id, { rounding_account_id: null });
  const histOrder = read(histDb, 'pos.order', sale.id);
  assert.equal(histOrder.rounding_account_id, null);
  assert.equal(histOrder.rounding_difference, 0.03);

  // 1. With current config pointing to rounding2, historical order resolves from current config (profitAcc2)
  const config2Db = write(histDb, 'pos.config', cfg.id, { rounding_method_id: rounding2.id });
  const refundResolved = payOrder(config2Db, { lines: histOrder.lines, method: cash.id, refund_of: histOrder.id });
  const refOrder = read(refundResolved.db, 'pos.order', refundResolved.id);
  const refEntry = read(refundResolved.db, 'account.move', refOrder.accounting_entries[0].move_id);
  const refRoundingLine = refEntry.line_ids.find((l) => l.account_id === profitAcc2.id);
  assert.ok(refRoundingLine, 'historical refund must use currently configured rounding account');
  assert.equal(refRoundingLine.debit, 0.03);

  // 1b. Verify the refundOrder public function (UI action) behaves identically
  const refundViaButton = refundOrder(config2Db, histOrder);
  const refBtnOrder = read(refundViaButton.db, 'pos.order', refundViaButton.id);
  const refBtnEntry = read(refundViaButton.db, 'account.move', refBtnOrder.accounting_entries[0].move_id);
  const refBtnRoundingLine = refBtnEntry.line_ids.find((l) => l.account_id === profitAcc2.id);
  assert.ok(refBtnRoundingLine, 'historical refund via refundOrder must use currently configured rounding account');
  assert.equal(refBtnRoundingLine.debit, 0.03);

  // 2. When cash rounding is disabled in current config, refund of historical order fails clearly
  const disabledDb = write(histDb, 'pos.config', cfg.id, { cash_rounding: false, rounding_method_id: null });
  assert.throws(
    () => payOrder(disabledDb, { lines: histOrder.lines, method: cash.id, refund_of: histOrder.id }),
    /Configure the profit account on the cash rounding method/
  );
  assert.throws(
    () => refundOrder(disabledDb, histOrder),
    /Configure the profit account on the cash rounding method/
  );

  // 3. When a legacy stored rounding method has no profit account, refund of historical order fails clearly
  assert.throws(
    () => create(histDb, 'account.cash.rounding', {
      name: '0.05 UP Unconfigured',
      rounding: 0.05,
      rounding_method: 'UP',
      strategy: 'add_invoice_line',
      profit_account_id: null,
      loss_account_id: null,
    }),
    /Configure the profit account on 0.05 UP Unconfigured/
  );
  const unconfiguredId = (histDb.seq['account.cash.rounding'] ?? 0) + 1;
  const unconfiguredStoredDb = {
    ...histDb,
    seq: { ...histDb.seq, 'account.cash.rounding': unconfiguredId },
    records: {
      ...histDb.records,
      'account.cash.rounding': [
        ...(histDb.records['account.cash.rounding'] ?? []),
        { id: unconfiguredId, name: '0.05 UP Unconfigured', rounding: 0.05, rounding_method: 'UP', strategy: 'add_invoice_line', active: true, profit_account_id: null, loss_account_id: null },
      ],
    },
  };
  const unconfiguredDb = write(unconfiguredStoredDb, 'pos.config', cfg.id, { cash_rounding: true, rounding_method_id: unconfiguredId });
  assert.throws(
    () => payOrder(unconfiguredDb, { lines: histOrder.lines, method: cash.id, refund_of: histOrder.id }),
    /Configure the profit account on 0.05 UP Unconfigured/
  );
});
