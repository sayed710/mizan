import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postMove, residual } from './models/accounting.js';
import { bankModels, reconcileWith } from './models/bank.js';
import { applyRule } from './models/reconcile.js';
import { taxSnapshot } from './models/taxes.js';

const setupTestDb = () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const expenseDiscAccount = search(db, 'account.account').find((a) => a.code === '690000' && (a.company_id ?? 1) === 1)
    || create(db, 'account.account', { name: 'Early discount expense', code: '690000', account_type: 'expense', company_id: 1 });
  db = expenseDiscAccount.db ?? db;
  const incomeDiscAccount = search(db, 'account.account').find((a) => a.code === '790000' && (a.company_id ?? 1) === 1)
    || create(db, 'account.account', { name: 'Early discount income', code: '790000', account_type: 'income', company_id: 1 });
  db = incomeDiscAccount.db ?? db;

  db = write(db, 'res.company', 1, {
    expense_early_payment_discount_account_id: expenseDiscAccount.id,
    income_early_payment_discount_account_id: incomeDiscAccount.id,
  });

  return { db, bankJournal, expenseDiscAccount, incomeDiscAccount };
};

test('TERM-2: Customer invoice reconciled with discounted amount within discount window is fully paid with discount booked', () => {
  const { db: initDb, bankJournal, expenseDiscAccount } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Line amount 98 within discount period (2026-01-05)
  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'CUST-INV-01',
    amount: 98,
    partner_id: 1,
  });
  db = line.db;

  db = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), inv.id);

  const afterMove = read(db, 'account.move', inv.id);
  assert.equal(residual(afterMove, db), 0, 'Invoice should be fully paid');
  assert.equal(afterMove.payment_state, 'paid', 'Payment state should be paid');
  assert.equal(afterMove.amount_paid, 100, 'Amount paid should equal 100');

  const afterLine = read(db, 'account.bank.statement.line', line.id);
  assert.equal(afterLine.state, 'reconciled', 'Statement line should be reconciled');
  assert.equal(afterLine.open_amount, 0, 'Statement line open amount should be 0');

  // Verify discount settlement row on the invoice
  const discRow = (afterMove.payments ?? []).find((p) => p.discount);
  assert.ok(discRow, 'Discount settlement row must exist');
  assert.equal(discRow.amount, 2, 'Discount amount should be 2');
  assert.equal(discRow.payment_move_id, afterLine.bank_move_id, 'Discount payment_move_id must link to bank move');

  // Verify discount journal entry
  const discMove = read(db, 'account.move', discRow.move_id);
  assert.ok(discMove, 'Discount journal entry must exist');
  assert.equal(read(db, 'account.journal', discMove.journal_id)?.code, 'MISC', 'Discount move journal should be MISC');
  assert.ok(discMove.line_ids.some((l) => l.account_id === expenseDiscAccount.id && l.debit === 2), 'Should debit discount expense');
});

test('TERM-2: Vendor bill reconciled with discounted amount within discount window is fully paid with discount booked', () => {
  const { db: initDb, bankJournal, incomeDiscAccount } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: '3% 7 days',
    early_discount: true,
    discount_percent: 3,
    discount_days: 7,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-02-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  // Bill 200 with 3% discount = 194. Statement line amount: -194 on 2026-02-05
  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-02-05',
    payment_ref: 'BILL-01',
    amount: -194,
    partner_id: 1,
  });
  db = line.db;

  db = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), bill.id);

  const afterMove = read(db, 'account.move', bill.id);
  assert.equal(residual(afterMove, db), 0, 'Bill should be fully paid');
  assert.equal(afterMove.payment_state, 'paid', 'Payment state should be paid');
  assert.equal(afterMove.amount_paid, 200, 'Amount paid should equal 200');

  const afterLine = read(db, 'account.bank.statement.line', line.id);
  assert.equal(afterLine.state, 'reconciled');
  assert.equal(afterLine.open_amount, 0);

  const discRow = (afterMove.payments ?? []).find((p) => p.discount);
  assert.ok(discRow);
  assert.equal(discRow.amount, 6);

  const discMove = read(db, 'account.move', discRow.move_id);
  assert.ok(discMove.line_ids.some((l) => l.account_id === incomeDiscAccount.id && l.credit === 6), 'Should credit discount income');
});

test('TERM-2: Outside discount period, line amount pays partially and no discount is booked', () => {
  const { db: initDb, bankJournal } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Line amount 98 on 2026-01-15 (after 10-day window ending 2026-01-11)
  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-15',
    payment_ref: 'LATE-98',
    amount: 98,
    partner_id: 1,
  });
  db = line.db;

  db = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), inv.id);

  const afterMove = read(db, 'account.move', inv.id);
  assert.equal(residual(afterMove, db), 2, 'Residual should remain 2');
  assert.equal(afterMove.payment_state, 'partial', 'Payment state should be partial');
  assert.equal(afterMove.amount_paid, 98);
  assert.equal((afterMove.payments ?? []).some((p) => p.discount), false, 'No discount should be booked');
});

test('TERM-2: Full amount within discount period pays full amount and books no discount', () => {
  const { db: initDb, bankJournal } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Line amount 100 on 2026-01-05
  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'FULL-100',
    amount: 100,
    partner_id: 1,
  });
  db = line.db;

  db = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), inv.id);

  const afterMove = read(db, 'account.move', inv.id);
  assert.equal(residual(afterMove, db), 0);
  assert.equal(afterMove.payment_state, 'paid');
  assert.equal(afterMove.amount_paid, 100);
  assert.equal((afterMove.payments ?? []).some((p) => p.discount), false, 'No discount should be booked');
});

test('TERM-2: Multi-currency invoice with discount reconciled against foreign bank statement line', () => {
  const { db: initDb } = setupTestDb();
  let db = initDb;

  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  assert.ok(eur && usd);

  // Rate on 2026-05-01: 1 USD = 0.8 EUR (so 1 EUR = 1.25 USD)
  const existingRates = (eur.rate_ids ?? []).filter((r) => r.date !== '2026-05-01');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [...existingRates, { date: '2026-05-01', rate: 0.8, company_id: null }],
  });

  const liquidityAccount = search(db, 'account.account').find((a) => a.code === '101401' && (a.company_id ?? 1) === 1)
    || search(db, 'account.account').find((a) => a.account_type === 'asset_cash' && (a.company_id ?? 1) === 1);

  // USD Bank journal
  const usdJournal = create(db, 'account.journal', {
    name: 'USD Bank',
    code: 'USDB',
    type: 'bank',
    currency_id: usd.id,
    company_id: 1,
    default_account_id: liquidityAccount.id,
  });
  db = usdJournal.db;

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  // EUR invoice of 100 EUR
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    currency_id: eur.id,
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-05-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // 98 EUR at 1 EUR = 1.25 USD = 122.50 USD
  const line = create(db, 'account.bank.statement.line', {
    journal_id: usdJournal.id,
    date: '2026-05-05',
    payment_ref: 'USD-PAY',
    amount: 122.5,
    partner_id: 1,
  });
  db = line.db;

  db = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), inv.id);

  const afterMove = read(db, 'account.move', inv.id);
  assert.equal(residual(afterMove, db), 0, 'EUR invoice should be fully paid');
  assert.equal(afterMove.payment_state, 'paid');
  assert.equal(afterMove.amount_paid, 100);

  const discRow = (afterMove.payments ?? []).find((p) => p.discount);
  assert.ok(discRow);
  assert.equal(discRow.amount, 2);
});

test('TERM-2: Auto-reconciliation matching rule matches invoice with early discount', () => {
  const { db: initDb, bankJournal } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const rule = create(db, 'account.reconcile.model', {
    name: 'Auto match invoices',
    rule_type: 'matching_rule',
    trigger: 'auto_reconcile',
    company_id: 1,
    line_ids: [],
  });
  db = rule.db;

  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'AUTO-RECO',
    amount: 98,
    partner_id: 1,
  });
  db = line.db;

  const afterDb = applyRule(db, read(db, 'account.reconcile.model', rule.id), read(db, 'account.bank.statement.line', line.id));

  const afterMove = read(afterDb, 'account.move', inv.id);
  assert.equal(residual(afterMove, afterDb), 0, 'Auto-reconciled invoice should be fully paid');
  assert.equal(afterMove.payment_state, 'paid');
  const discRow = (afterMove.payments ?? []).find((p) => p.discount);
  assert.ok(discRow, 'Discount settlement should be booked by auto-reconciliation');
  assert.equal(discRow.amount, 2);
});

test('TERM-2: Missing discount account throws configuration error', () => {
  const { db: initDb, bankJournal } = setupTestDb();
  let db = write(initDb, 'res.company', 1, {
    expense_early_payment_discount_account_id: null,
  });

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'ERR-CHECK',
    amount: 98,
    partner_id: 1,
  });
  db = line.db;

  assert.throws(
    () => reconcileWith(db, read(db, 'account.bank.statement.line', line.id), inv.id),
    /Configure the early payment discount expense account/
  );
});

test('TERM-2: Tax-inclusive discount reverses tax share during bank reconciliation', () => {
  const { db: initDb, bankJournal } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: 'Tax-inclusive 2%',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'included',
  });
  db = term.db;

  const tax = search(db, 'account.tax').find((item) => item.type_tax_use === 'sale' && item.amount === 14 && item.tax_exigibility === 'on_invoice' && !item.price_include);
  assert.ok(tax);

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(tax) }],
  });
  db = postMove(inv.db, inv.id);

  // Total 114, discount 2% on total with tax included = 2.28 -> net 111.72
  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'TAX-INCL',
    amount: 111.72,
    partner_id: 1,
  });
  db = line.db;

  db = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), inv.id);

  const afterMove = read(db, 'account.move', inv.id);
  assert.equal(residual(afterMove, db), 0);
  assert.equal(afterMove.payment_state, 'paid');
  const discRow = (afterMove.payments ?? []).find((p) => p.discount);
  assert.ok(discRow);
  assert.equal(discRow.amount, 2.28);
});

test('TERM-2: Partial installment / already partially paid invoice does not get early discount', () => {
  const { db: initDb, bankJournal } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Pay 10 first
  const line1 = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-02',
    payment_ref: 'PART-1',
    amount: 10,
    partner_id: 1,
  });
  db = reconcileWith(line1.db, read(line1.db, 'account.bank.statement.line', line1.id), inv.id);

  // Residual is now 90, amount_paid is 10.
  // Second line tries to pay discounted balance: per Register Payment wizard rules,
  // discountAvailable is 0 once amount_paid > 0.
  const line2 = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'PART-2',
    amount: 88,
    partner_id: 1,
  });
  db = reconcileWith(line2.db, read(line2.db, 'account.bank.statement.line', line2.id), inv.id);

  const afterMove = read(db, 'account.move', inv.id);
  assert.equal(residual(afterMove, db), 2, 'Should remain 2 because discount does not apply after partial payment');
  assert.equal((afterMove.payments ?? []).some((p) => p.discount), false, 'No discount should be booked');
});

test('TERM-2: Unreconciling statement line reverses both payment and linked discount entry', async () => {
  const { db: initDb, bankJournal } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'UNREC-TEST',
    amount: 98,
    partner_id: 1,
  });
  db = line.db;

  db = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), inv.id);
  const reconciledMove = read(db, 'account.move', inv.id);
  assert.equal(residual(reconciledMove, db), 0);

  // Unreconcile
  const { unreconcile } = await import('./models/bank.js');
  db = unreconcile(db, read(db, 'account.bank.statement.line', line.id)).db;

  const restoredMove = read(db, 'account.move', inv.id);
  assert.equal(residual(restoredMove, db), 100, 'Invoice residual should be restored to 100');
  assert.equal(restoredMove.payment_state, 'not_paid');
  const activeDiscount = (restoredMove.payments ?? []).filter((p) => p.discount && !p.reversed);
  assert.equal(activeDiscount.length, 0, 'Discount settlement should be reversed');
});

test('TERM-2: Server guards and sync replay cleanly through diffDb + applyDiff', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  const { db: initDb, bankJournal } = setupTestDb();
  let db = initDb;

  const term = create(db, 'account.payment.term', {
    name: '2% 10 days',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'excluded',
  });
  db = term.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const line = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    date: '2026-01-05',
    payment_ref: 'SYNC-DIFF',
    amount: 98,
    partner_id: 1,
  });
  const beforeDb = line.db;

  const reconciledDb = reconcileWith(beforeDb, read(beforeDb, 'account.bank.statement.line', line.id), inv.id);
  const diff = diffDb(beforeDb, reconciledDb);

  const syncedDb = applyDiff(beforeDb, diff, { isAdmin: true });
  const syncedMove = read(syncedDb, 'account.move', inv.id);
  assert.equal(residual(syncedMove, syncedDb), 0);
  assert.equal(syncedMove.payment_state, 'paid');
  const syncedLine = read(syncedDb, 'account.bank.statement.line', line.id);
  assert.equal(syncedLine.state, 'reconciled');
  assert.equal(syncedLine.open_amount, 0);
});



test('TERM-2: automatic matching uses the remaining statement amount for a discount', () => {
  let { db, bankJournal } = setupTestDb();
  const term = create(db, 'account.payment.term', { name: '2%', early_discount: true, discount_percent: 2, discount_days: 10, discount_tax_computation: 'excluded' });
  db = term.db;
  const first = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }] });
  db = postMove(first.db, first.id);
  const second = create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(second.db, second.id);
  const line = create(db, 'account.bank.statement.line', { journal_id: bankJournal.id, date: '2026-01-05', payment_ref: 'SPLIT', amount: 148, partner_id: 1 });
  db = reconcileWith(line.db, read(line.db, 'account.bank.statement.line', line.id), first.id);
  db = write(db, 'account.bank.statement.line', line.id, { move_id: null });
  const button = bankModels['account.bank.statement.line'].form.buttons.find((item) => item.label === 'Reconcile');
  db = button.run(db, read(db, 'account.bank.statement.line', line.id)).db;
  assert.equal(residual(read(db, 'account.move', second.id), db), 0);
  assert.equal(read(db, 'account.move', second.id).payments.find((payment) => payment.discount)?.amount, 2);
});
