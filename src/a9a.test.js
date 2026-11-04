import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { accountId, isBalanced } from './models/ledger.js';
import { confirmAsset, depreciationBoard, disposeAsset, modifyAsset, postDepreciation } from './models/assets.js';
import { discountAvailable, payWithDiscount, postMove } from './models/accounting.js';
import { postBatch } from './models/payments.js';
import { followUps, partnerFollowUp, updatePartnerFollowUp } from './models/finance.js';

test('asset modification: value increase posts adjusting entry, updates original value and recomputes remaining board', () => {
  let db = seed();
  const assetAccId = accountId(db, '151000');
  const revalAccId = accountId(db, '450300');
  const asset = create(db, 'account.asset', {
    name: 'Machinery',
    acquisition_date: '2026-01-01',
    original_value: 10000,
    salvage_value: 0,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_asset_id: assetAccId,
  });
  db = confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id));

  // Post first year depreciation (2026-12-31): 2000
  db = postDepreciation(db, read(db, 'account.asset', asset.id), '2026-12-31');
  let a = read(db, 'account.asset', asset.id);
  assert.equal(a.depreciation_ids[0].posted, true);
  assert.equal(a.depreciation_ids[0].amount, 2000);
  assert.equal(a.book_value, 8000);

  // User triggers Modify Depreciation: value increase of +2000 on 2027-01-15
  // Public path: models['account.asset'].actions.modify or form button
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  assert.ok(button, 'Modify Depreciation button exists on account.asset form');

  // Value increase requires an explicit counterpart account
  assert.throws(() => button.run(db, a, { date: '2027-01-15', value_change: 2000 }), /counterpart account/i);

  db = button.run(db, a, { date: '2027-01-15', value_change: 2000, account_id: revalAccId }).db;
  a = read(db, 'account.asset', asset.id);

  assert.equal(a.original_value, 12000);
  assert.equal(a.book_value, 10000); // 12000 - 2000 posted

  // Check the adjusting journal entry
  const moves = search(db, 'account.move').filter((m) => m.ref === 'Machinery value adjustment');
  assert.equal(moves.length, 1);
  assert.ok(isBalanced(moves[0].line_ids));
  const assetLine = moves[0].line_ids.find((l) => l.account_id === assetAccId);
  assert.equal(assetLine.debit, 2000);
  const revalLine = moves[0].line_ids.find((l) => l.account_id === revalAccId);
  assert.equal(revalLine.credit, 2000);

  // Check remaining board: period 1 stays posted (2000). Remaining 10000 spread over 4 remaining periods = 2500 each
  assert.equal(a.depreciation_ids.length, 5);
  assert.equal(a.depreciation_ids[0].posted, true);
  assert.equal(a.depreciation_ids[0].amount, 2000);
  assert.deepEqual(a.depreciation_ids.slice(1).map((l) => l.amount), [2500, 2500, 2500, 2500]);
  assert.equal(a.depreciation_ids.at(-1).remaining, 0);
});

test('asset modification: value decrease (impairment) posts loss entry and recomputes declining board', () => {
  let db = seed();
  const assetAccId = accountId(db, '151000');
  const lossAccId = accountId(db, '690300');
  const asset = create(db, 'account.asset', {
    name: 'Tech Equipment',
    acquisition_date: '2026-01-01',
    original_value: 10000,
    salvage_value: 0,
    method: 'degressive',
    method_number: 4,
    method_period: '12',
    method_progress_factor: 0.3,
    account_asset_id: assetAccId,
    account_loss_id: lossAccId,
  });
  db = confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id));

  // Post year 1 (2026-12-31): 3000
  db = postDepreciation(db, read(db, 'account.asset', asset.id), '2026-12-31');
  let a = read(db, 'account.asset', asset.id);
  assert.equal(a.depreciation_ids[0].amount, 3000);
  assert.equal(a.depreciation_ids[0].posted, true);
  assert.equal(a.book_value, 7000);

  // Value decrease of -2000 (impairment) on 2027-01-15 -> new original value = 8000, new remaining book value = 5000
  db = modifyAsset(db, a, { date: '2027-01-15', value_change: -2000 });
  a = read(db, 'account.asset', asset.id);

  assert.equal(a.original_value, 8000);
  assert.equal(a.book_value, 5000); // 8000 - 3000 posted

  // Check the adjusting journal entry
  const move = search(db, 'account.move').find((m) => m.ref === 'Tech Equipment value adjustment');
  assert.ok(move, 'Value adjustment move created');
  assert.ok(isBalanced(move.line_ids));
  const assetLine = move.line_ids.find((l) => l.account_id === assetAccId);
  assert.equal(assetLine.credit, 2000);
  const lossLine = move.line_ids.find((l) => l.account_id === lossAccId);
  assert.equal(lossLine.debit, 2000);

  // Remaining 3 periods: declining on 5000: 5000 * 0.3 = 1500, next 3500 * 0.3 = 1050, last absorbs remaining 2450
  assert.equal(a.depreciation_ids.length, 4);
  assert.equal(a.depreciation_ids[0].posted, true);
  assert.equal(a.depreciation_ids[0].amount, 3000);
  assert.deepEqual(a.depreciation_ids.slice(1).map((l) => l.amount), [1500, 1050, 2450]);
  assert.equal(a.depreciation_ids.at(-1).remaining, 0);
});

test('asset modification guards: enforces valid states, dates, configured accounts, and non-depreciable bounds', () => {
  let db = seed();
  const asset = create(db, 'account.asset', {
    name: 'Guarded Asset',
    acquisition_date: '2026-01-01',
    original_value: 5000,
    salvage_value: 500,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_asset_id: accountId(db, '151000'),
    account_loss_id: accountId(db, '690300'),
  });
  db = confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id));
  db = postDepreciation(db, read(db, 'account.asset', asset.id), '2027-12-31'); // 2 periods posted = 1800
  const a = read(db, 'account.asset', asset.id);

  // Modification date before last posted depreciation (2027-12-31)
  assert.throws(() => modifyAsset(db, a, { date: '2027-06-01', value_change: 100, accountId: accountId(db, '450300') }), /precede posted depreciation/i);

  // Value decrease that drops original value below already depreciated + salvage value
  assert.throws(() => modifyAsset(db, a, { date: '2028-01-01', value_change: -4000 }), /already depreciated/i);

  // Missing configured asset account or loss account throws a clear error
  const unconfigured = write(db, 'account.asset', a.id, { account_asset_id: null, account_loss_id: null });
  assert.throws(() => modifyAsset(unconfigured, read(unconfigured, 'account.asset', a.id), { date: '2028-01-01', value_change: -100 }), /fixed asset account/i);
  const noLoss = write(db, 'account.asset', a.id, { account_loss_id: null });
  assert.throws(() => modifyAsset(noLoss, read(noLoss, 'account.asset', a.id), { date: '2028-01-01', value_change: -100 }), /loss or expense account/i);

  // Dispose the asset
  const disposed = disposeAsset(db, a, { date: '2028-01-01' });
  const closed = read(disposed, 'account.asset', a.id);
  assert.throws(() => modifyAsset(disposed, closed, { date: '2028-01-02', value_change: 500, accountId: accountId(db, '450300') }), /running or paused/i);
});

test('early payment discount with tax reduction on invoice (mixed): reduces tax base, sets discount on term line and settles at payment', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', {
    name: '2% 10 Net 30 with Tax Reduction',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'mixed',
  });
  db = term.db;

  const tax = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.amount === 14 && !t.price_include && t.tax_exigibility === 'on_invoice');
  assert.ok(tax, 'Found 14% invoice-basis tax');

  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax_id: tax.id, tax: 14 }],
  });

  db = postMove(invoice.db, invoice.id);
  const posted = read(db, 'account.move', invoice.id);

  // 1. Invoice Tax Lines: tax base should be 98 (100 - 2%), tax amount should be 13.72 (98 * 14%)
  const taxLine = posted.line_ids.find((l) => l.tax_name && !l.tax_zero);
  assert.ok(taxLine, 'Tax line exists on posted move');
  assert.equal(taxLine.tax_base, 98);
  assert.equal(taxLine.credit, 13.72);

  // Invoice total should be 100 + 13.72 = 113.72
  assert.equal(posted.amount_total, 113.72);

  // 2. Payment Term Discount Lines: receivable line carries discount attributes
  const receivableLine = posted.line_ids.find((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable');
  assert.ok(receivableLine, 'Receivable line exists');
  assert.equal(receivableLine.debit, 113.72);
  assert.equal(receivableLine.discount_date, '2026-01-11');
  assert.equal(receivableLine.discount_percentage, 2);
  assert.equal(receivableLine.discount_amount_currency, 2);

  // 3. Payment Entry: customer pays 111.72 within discount window (on 2026-01-10)
  assert.equal(discountAvailable(db, posted, '2026-01-10'), 2);
  db = payWithDiscount(db, posted.id, 111.72, '2026-01-10');
  const paid = read(db, 'account.move', posted.id);

  assert.equal(paid.amount_residual, 0);
  assert.equal(paid.payment_state, 'paid');

  // Check discount move: books 2.00 to discount expense without reversing tax (tax was already reduced upfront)
  const discountPayment = paid.payments.find((p) => p.discount);
  assert.ok(discountPayment, 'Discount payment recorded');
  const discountEntry = read(db, 'account.move', discountPayment.move_id);
  assert.ok(isBalanced(discountEntry.line_ids));
  const expAccount = search(db, 'account.account').find((a) => a.code === '690200');
  assert.equal(discountEntry.line_ids.find((l) => l.account_id === expAccount.id)?.debit, 2);
  // No tax lines in the discount entry because tax was already reduced on invoice
  assert.ok(!discountEntry.line_ids.some((l) => l.tax_name));
});

test('early payment discount (mixed): late payment after discount date receives no discount', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', {
    name: '2% 10 Net 30 mixed',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'mixed',
  });
  const tax = search(term.db, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.amount === 14 && !t.price_include && t.tax_exigibility === 'on_invoice');
  const invoice = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax_id: tax.id, tax: 14 }],
  });
  db = postMove(invoice.db, invoice.id);
  const posted = read(db, 'account.move', invoice.id);

  // After 10 days (e.g. 2026-01-15): discountAvailable should be 0
  assert.equal(discountAvailable(db, posted, '2026-01-15'), 0);
  const latePaid = payWithDiscount(db, posted.id, 111.72, '2026-01-15');
  assert.equal(read(latePaid, 'account.move', posted.id).amount_residual, 2);
  assert.equal(read(latePaid, 'account.move', posted.id).payment_state, 'partial');
});

test('follow-up exclusions: partner excluded, invoice excluded, blocked line, and next action date', () => {
  let db = seed();

  // Create partner 1 with overdue invoice, excluded via per-company followup_lines
  const partner1 = create(db, 'res.partner', { name: 'Customer Excluded Partner' });
  db = write(partner1.db, 'res.partner', partner1.id, { followup_lines: updatePartnerFollowUp(read(partner1.db, 'res.partner', partner1.id), 1, { no_followup: true }).followup_lines });
  const bill1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner1.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-15',
    invoice_line_ids: [{ qty: 1, price_unit: 500, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);

  // 1. Partner 1 is excluded via per-company no_followup: true -> should NOT appear in followUps
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner1.id), 1)?.no_followup, true);
  assert.equal(followUps(db, '2026-02-01').some((f) => f.partner_id === partner1.id), false);

  // Partner with per-company followup_status = 'no_action_needed'
  const partnerStatus = create(db, 'res.partner', { name: 'No Action Customer' });
  db = write(partnerStatus.db, 'res.partner', partnerStatus.id, { followup_lines: updatePartnerFollowUp(read(partnerStatus.db, 'res.partner', partnerStatus.id), 1, { followup_status: 'no_action_needed' }).followup_lines });
  const billStatus = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partnerStatus.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-15',
    invoice_line_ids: [{ qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(billStatus.db, billStatus.id);
  assert.equal(partnerFollowUp(read(db, 'res.partner', partnerStatus.id), 1)?.followup_status, 'no_action_needed');
  assert.equal(followUps(db, '2026-02-01').some((f) => f.partner_id === partnerStatus.id), false);

  // 2. Invoice excluded from follow-up
  const partner2 = create(db, 'res.partner', { name: 'Customer Excluded Invoice' });
  db = partner2.db;
  const bill2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner2.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-15',
    exclude_from_followup: true,
    invoice_line_ids: [{ qty: 1, price_unit: 400, tax: 0 }],
  });
  db = postMove(bill2.db, bill2.id);
  assert.equal(followUps(db, '2026-02-01').some((f) => f.partner_id === partner2.id), false);

  // 3. Blocked lines (litigation / dispute on journal item)
  const partner3 = create(db, 'res.partner', { name: 'Customer Disputed Line' });
  db = partner3.db;
  const bill3 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner3.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-15',
    invoice_line_ids: [{ qty: 1, price_unit: 600, tax: 0 }],
  });
  db = postMove(bill3.db, bill3.id);
  // Mark the receivable line as blocked
  const move3 = read(db, 'account.move', bill3.id);
  const updatedLines = move3.line_ids.map((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable' ? { ...l, blocked: true } : l);
  db = write(db, 'account.move', bill3.id, { line_ids: updatedLines });
  assert.equal(followUps(db, '2026-02-01').some((f) => f.partner_id === partner3.id), false);

  // 4. Next-action date: snoozed until 2026-03-01 via per-company followup_lines
  const partner4 = create(db, 'res.partner', { name: 'Customer Snoozed' });
  db = partner4.db;
  const bill4 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner4.id,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-15',
    invoice_line_ids: [{ qty: 1, price_unit: 700, tax: 0 }],
  });
  db = postMove(bill4.db, bill4.id);
  db = write(db, 'res.partner', partner4.id, { followup_lines: updatePartnerFollowUp(read(db, 'res.partner', partner4.id), 1, { followup_next_action_date: '2026-03-01' }).followup_lines });

  // On 2026-02-01 (before next action date): partner4 is excluded
  assert.equal(followUps(db, '2026-02-01').some((f) => f.partner_id === partner4.id), false);

  // On 2026-03-01 (date has arrived): partner4 appears in follow-ups
  assert.equal(followUps(db, '2026-03-01').some((f) => f.partner_id === partner4.id), true);
});





test('degressive boards: declining takes the factor on the residual, declining-then-linear switches to straight line once larger', () => {
  const base = { acquisition_date: '2026-01-01', original_value: 10000, salvage_value: 0, method_number: 4, method_period: '12', method_progress_factor: 0.3 };
  const declining = depreciationBoard({ ...base, method: 'degressive' }).map((l) => l.amount);
  assert.deepEqual(declining.slice(0, 3), [3000, 2100, 1470]);
  assert.equal(declining.reduce((s, v) => s + v, 0), 10000);
  const mixed = depreciationBoard({ ...base, method: 'degressive_then_linear' }).map((l) => l.amount);
  assert.equal(mixed[0], 3000);
  assert.ok(mixed[1] > 2100 && Math.abs(mixed[1] - 7000 / 3) < 0.01);
  assert.equal(Math.round(mixed.reduce((s, v) => s + v, 0) * 100), 1000000);
});

test('asset disposal: due depreciation is posted, the loss entry balances and the board closes', () => {
  let db = seed();
  const asset = create(db, 'account.asset', { name: 'Truck', acquisition_date: '2026-01-01', original_value: 12000, salvage_value: 0, method: 'linear', method_number: 5, method_period: '12' });
  db = confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id));
  db = postDepreciation(db, read(db, 'account.asset', asset.id), '2027-12-31');
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Sell or Dispose');
  db = button.run(db, read(db, 'account.asset', asset.id), { date: '2028-12-31', sale_value: 5000 }).db;
  const a = read(db, 'account.asset', asset.id);
  assert.equal(a.state, 'close');
  assert.equal(a.depreciation_ids.length, 3);
  assert.equal(a.depreciation_ids[2].date, '2028-12-31');
  assert.equal(a.depreciation_ids[2].amount, 2400);
  assert.ok(a.depreciation_ids.every((l) => l.posted));
  const entry = search(db, 'account.move').find((m) => m.ref === 'Truck disposal');
  assert.ok(isBalanced(entry.line_ids));
  const line = (code) => entry.line_ids.find((l) => l.account_id === accountId(db, code));
  assert.equal(line('151000').credit, 12000);
  assert.equal(line('152000').debit, 7200);
  assert.equal(line('450300').credit, 200);
});

test('reprinting a check voids the old number, takes the next free one and never reuses a voided number', () => {
  let db = seed();
  const bank = search(db, 'account.account').find((account) => account.code === '101401');
  const journal = create(db, 'account.journal', { name: 'Check journal', code: 'CHKR', type: 'bank', company_id: 1, default_account_id: bank.id, check_next_number: 700 });
  db = journal.db;
  const issue = () => {
    const bill = create(db, 'account.move', { move_type: 'in_invoice', company_id: 1, partner_id: 7, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(bill.db, bill.id);
    const batch = create(db, 'account.batch.payment', { batch_type: 'outbound', journal_id: journal.id, date: '2026-01-02', lines: [{ move_id: bill.id, amount: 100 }] });
    db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
    return { batchId: batch.id, ...read(db, 'account.batch.payment', batch.id).lines[0] };
  };
  const first = issue();
  assert.equal(first.check_number, 700);
  const button = models['account.payment'].form.buttons.find((b) => b.label === 'Reprint Check');
  db = button.run(db, read(db, 'account.payment', first.payment_id)).db;
  const payment = read(db, 'account.payment', first.payment_id);
  assert.equal(payment.check_number, 701);
  assert.deepEqual(payment.voided_check_numbers.map((v) => v.check_number), [700]);
  assert.equal(read(db, 'account.batch.payment', first.batchId).lines[0].check_number, 701);
  assert.equal(read(db, 'account.journal', journal.id).check_next_number, 702);
  assert.throws(() => write(db, 'account.payment', first.payment_id, { check_number: 700 }), /check/i);
  db = write(db, 'account.journal', journal.id, { check_next_number: 700 });
  assert.equal(issue().check_number, 702);
  assert.throws(() => button.run(db, { id: 99999, state: 'draft' }), Error);
});

test('mixed early discount: posted total, amount_tax and the posted tax and receivable lines agree on one invoice', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', { name: '3% 7 mixed', early_discount: true, discount_percent: 3, discount_days: 7, discount_tax_computation: 'mixed' });
  db = term.db;
  const tax = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.amount === 14 && !t.price_include && t.tax_exigibility === 'on_invoice');
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 3, price_unit: 33.33, tax_id: tax.id, tax: 14 }] });
  db = postMove(invoice.db, invoice.id);
  const posted = read(db, 'account.move', invoice.id);
  const taxCredit = posted.line_ids.filter((l) => l.tax_name && !l.tax_zero).reduce((s, l) => s + l.credit, 0);
  const receivable = posted.line_ids.find((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable');
  assert.equal(posted.amount_tax, Math.round(taxCredit * 100) / 100);
  assert.equal(posted.amount_total, receivable.debit);
  assert.equal(Math.round((posted.amount_untaxed + posted.amount_tax) * 100) / 100, posted.amount_total);
  assert.ok(isBalanced(posted.line_ids));
});
