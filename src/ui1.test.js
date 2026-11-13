import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { journalCards } from './models/finance.js';
import { journalItems, accountId, postEntry } from './models/ledger.js';
import { postPayment } from './models/pay.js';
import { addDays, shiftMonth, today } from './models/common.js';
import { journalCardListUrl } from './views/journalDashboard.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const LINE = 'account.bank.statement.line';
const run = (db, model, id, label, values = {}) => models[model].form.buttons
  .find((button) => button.label === label)
  .run(db, read(db, model, id), values).db;

const foreignBank = (db = seed(), rate = 1.25) => {
  const currency = create(db, 'res.currency', {
    name: 'UI1_FX', rate_ids: [{ date: '2025-01-01', rate }],
  });
  const journal = search(currency.db, 'account.journal').find((row) => row.code === 'BNK1');
  return { db: write(currency.db, 'account.journal', journal.id, { currency_id: currency.id, outstanding_receipts_account_id: accountId(currency.db, '101402'), outstanding_payments_account_id: accountId(currency.db, '101403') }), currency: currency.id, journal: journal.id };
};

const invoice = (db, { amount, currency_id = null, type = 'out_invoice', journal_id } = {}) => {
  const draft = create(db, 'account.move', {
    move_type: type, partner_id: 3, journal_id, currency_id,
    date: '2025-01-02', invoice_date: '2025-01-02',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: amount, tax: 0 }],
  });
  return { db: postMove(draft.db, draft.id), id: draft.id };
};

test('foreign-currency bank write-offs use statement currency for both invoice and payment matching', () => {
  const fx = foreignBank();
  const fee = accountId(fx.db, '690000');
  const companyInvoice = invoice(fx.db, { amount: 80 });
  const invoiceLine = create(companyInvoice.db, LINE, {
    date: '2025-01-02', payment_ref: 'Invoice less bank fee', amount: 90,
    journal_id: fx.journal, move_id: companyInvoice.id,
    writeoff_account_id: fee, writeoff_label: 'Bank fee', writeoff_amount: 10,
  });
  assert.equal(read(invoiceLine.db, LINE, invoiceLine.id).currency_id, fx.currency);
  const invoiceSettled = run(invoiceLine.db, LINE, invoiceLine.id, 'Match');
  const invoiceResult = read(invoiceSettled, LINE, invoiceLine.id);
  const invoiceWriteoff = read(invoiceSettled, 'account.move', invoiceResult.writeoff_move_id);
  assert.equal(invoiceWriteoff.line_ids.find((line) => line.account_id === fee).debit, 8);
  assert.equal(read(invoiceSettled, 'account.move', companyInvoice.id).amount_residual, 0);

  const foreignInvoice = invoice(fx.db, { amount: 100, currency_id: fx.currency });
  const paid = run(foreignInvoice.db, 'account.move', foreignInvoice.id, 'Register Payment', {
    amount: 100, date: '2025-01-02', journal_id: fx.journal,
  });
  const payment = search(paid, 'account.payment').find((row) => row.invoice_id === foreignInvoice.id);
  const paymentLine = create(paid, LINE, {
    date: '2025-01-02', payment_ref: 'Payment less bank fee', amount: 95,
    journal_id: fx.journal, payment_id: payment.id,
    writeoff_account_id: fee, writeoff_label: 'Bank fee', writeoff_amount: 5,
  });
  const paymentMatched = run(paymentLine.db, LINE, paymentLine.id, 'Match Payment');
  const paymentResult = read(paymentMatched, LINE, paymentLine.id);
  const paymentWriteoff = read(paymentMatched, 'account.move', paymentResult.bank_move_id);
  const feeLine = paymentWriteoff.line_ids.find((line) => line.account_id === fee);
  assert.equal(feeLine.debit, 4);
  assert.equal(feeLine.amount_currency, 5);
});

test('fully settled invoice and settlement journal items leave the unreconciled report', () => {
  const db = seed();
  const journal = search(db, 'account.journal').find((row) => row.code === 'BNK1');
  const created = invoice(db, { amount: 100 });
  const paid = run(created.db, 'account.move', created.id, 'Register Payment', {
    amount: 100, date: '2025-01-03', journal_id: journal.id,
  });
  const payment = search(paid, 'account.payment').find((row) => row.invoice_id === created.id);
  const statement = create(paid, LINE, {
    date: '2025-01-03', payment_ref: 'Invoice payment', amount: 100,
    journal_id: journal.id, payment_id: payment.id,
  });
  const matched = run(statement.db, LINE, statement.id, 'Match Payment');
  const unsettled = journalItems(matched, { reviewMode: 'unreconciled' });
  const receivable = accountId(matched, '121000');
  assert.equal(unsettled.some((line) => line.move_id === created.id && line.account_id === receivable), false);
  assert.equal(unsettled.some((line) => line.move_id === payment.move_id && line.account_id === receivable), false);
  assert.equal(journalItems(matched).find((line) => line.move_id === created.id && line.account_id === receivable).reconciled, true);
  assert.equal(matched.records['account.move'].some((move) => move.line_ids?.some((line) => Object.hasOwn(line, 'reconciled'))), false);
  const unMatched = run(matched, LINE, statement.id, 'Unreconcile');
  const reversed = run(unMatched, 'account.payment', payment.id, 'Reverse');
  assert.equal(journalItems(reversed, { reviewMode: 'unreconciled' }).some((line) => line.move_id === created.id && line.account_id === receivable), true);
});

test('bank journal cards sum the remaining open statement amount', () => {
  const seeded = seed();
  const template = search(seeded, 'account.journal').find((row) => row.code === 'BNK1');
  const made = create(seeded, 'account.journal', { ...template, id: undefined, name: 'UI1 Bank', code: 'UI1', default_for_payments: false });
  const db = made.db;
  const journal = read(db, 'account.journal', made.id);
  const created = invoice(db, { amount: 60 });
  const statement = create(created.db, LINE, {
    date: '2025-01-02', payment_ref: 'Partial payment', amount: 100,
    journal_id: journal.id, move_id: created.id,
  });
  const matched = run(statement.db, LINE, statement.id, 'Match');
  assert.equal(read(matched, LINE, statement.id).open_amount, 40);
  const card = journalCards(matched).find((item) => item.journal.id === journal.id);
  assert.equal(card.toReconcile, 1);
  assert.equal(card.toReconcileAmount, 40);
});

test('sales and purchase To Validate counts include only invoices and bills', () => {
  let db = seed();
  const saleJournal = search(db, 'account.journal').find((row) => row.type === 'sale' && row.code === 'INV');
  const purchaseJournal = search(db, 'account.journal').find((row) => row.type === 'purchase' && row.code === 'BILL');
  const baseline = journalCards(db);
  const saleDraft = create(db, 'account.move', { move_type: 'out_invoice', journal_id: saleJournal.id, partner_id: 3 });
  const purchaseDraft = create(saleDraft.db, 'account.move', { move_type: 'in_invoice', journal_id: purchaseJournal.id, partner_id: 3 });
  const manualSale = create(purchaseDraft.db, 'account.move', { move_type: 'entry', journal_id: saleJournal.id });
  const manualPurchase = create(manualSale.db, 'account.move', { move_type: 'entry', journal_id: purchaseJournal.id });
  db = manualPurchase.db;
  const cards = journalCards(db);
  assert.equal(cards.find((item) => item.journal.id === saleJournal.id).draft, baseline.find((item) => item.journal.id === saleJournal.id).draft + 1);
  assert.equal(cards.find((item) => item.journal.id === purchaseJournal.id).draft, baseline.find((item) => item.journal.id === purchaseJournal.id).draft + 1);
});

test('sales and purchase journal card lists keep the journal filter', () => {
  const cards = journalCards(seed());
  const sale = cards.find((item) => item.kind === 'sale');
  const purchase = cards.find((item) => item.kind === 'purchase');
  assert.equal(journalCardListUrl(sale), `#/accounting/invoices?view=list&rel=journal_id:${sale.journal.id}`);
  assert.equal(journalCardListUrl(purchase), `#/accounting/bills?view=list&rel=journal_id:${purchase.journal.id}`);
});

test('partial settlements leave the invoice open without reopening the applied payment item', () => {
  const created = invoice(seed(), { amount: 100 });
  const journal = search(created.db, 'account.journal').find((row) => row.code === 'BNK1');
  const paid = run(created.db, 'account.move', created.id, 'Register Payment', { amount: 60, date: '2025-01-03', journal_id: journal.id });
  const payment = search(paid, 'account.payment').find((row) => row.invoice_id === created.id);
  const receivable = accountId(paid, '121000');
  const items = journalItems(paid, { reviewMode: 'unreconciled' });
  assert.equal(items.some((line) => line.move_id === created.id && line.account_id === receivable), true);
  assert.equal(items.some((line) => line.move_id === payment.move_id && line.account_id === receivable), false);
});

test('same-currency invoice write-offs do not gain a cent from a company-currency round trip', () => {
  const fx = foreignBank(seed(), 1.3);
  const created = invoice(fx.db, { amount: 100, currency_id: fx.currency });
  const statement = create(created.db, LINE, {
    date: '2025-01-02', payment_ref: 'Fractional conversion', amount: 95,
    journal_id: fx.journal, move_id: created.id,
    writeoff_account_id: accountId(created.db, '690000'), writeoff_label: 'Adjustment', writeoff_amount: 5,
  });
  const matched = run(statement.db, LINE, statement.id, 'Match');
  const result = read(matched, LINE, statement.id);
  const settled = read(matched, 'account.move', created.id);
  assert.equal(settled.payments.find((payment) => payment.move_id === result.writeoff_move_id).amount, 5);
  assert.equal(settled.amount_residual, 0);
});

test('outbound foreign-bank write-offs convert statement amounts before settling a bill', () => {
  const fx = foreignBank();
  const created = invoice(fx.db, { amount: 80, type: 'in_invoice' });
  const fee = accountId(created.db, '690000');
  const statement = create(created.db, LINE, {
    date: '2025-01-02', payment_ref: 'Bill adjustment', amount: -90,
    journal_id: fx.journal, move_id: created.id,
    writeoff_account_id: fee, writeoff_label: 'Adjustment', writeoff_amount: 10,
  });
  const matched = run(statement.db, LINE, statement.id, 'Match');
  const result = read(matched, LINE, statement.id);
  assert.equal(read(matched, 'account.move', created.id).amount_residual, 0);
  assert.equal(read(matched, 'account.move', result.writeoff_move_id).line_ids.find((line) => line.account_id === fee).credit, 8);
});

test('foreign-bank payment write-offs separate bank fees from exchange differences', () => {
  const fx = foreignBank(seed(), 1);
  const created = invoice(fx.db, { amount: 100, currency_id: fx.currency });
  const paid = run(created.db, 'account.move', created.id, 'Register Payment', {
    amount: 100, date: '2025-01-02', journal_id: fx.journal,
  });
  const payment = search(paid, 'account.payment').find((row) => row.invoice_id === created.id);
  const changedRate = write(paid, 'res.currency', fx.currency, { rate_ids: [{ date: '2025-01-01', rate: 1 }, { date: '2025-01-03', rate: 2 }] });
  const fee = accountId(changedRate, '690000');
  const statement = create(changedRate, LINE, {
    date: '2025-01-03', payment_ref: 'Payment and fee', amount: 95,
    journal_id: fx.journal, payment_id: payment.id,
    writeoff_account_id: fee, writeoff_label: 'Fee', writeoff_amount: 5,
  });
  const matched = run(statement.db, LINE, statement.id, 'Match Payment');
  const bankMove = read(matched, 'account.move', read(matched, LINE, statement.id).bank_move_id);
  const feeItem = bankMove.line_ids.find((line) => line.account_id === fee);
  assert.equal(feeItem.debit, 2.5);
  assert.equal(feeItem.amount_currency, 5);
  assert.equal(bankMove.line_ids.reduce((sum, line) => sum + line.debit - line.credit, 0), 0);
});

async function renderDashboard(db) {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { initStore, commit } = await import('./store.js');
  const { Dashboard } = await import('./views/Dashboard.jsx');
  await initStore();
  await commit(db);
  return renderToStaticMarkup(React.createElement(Dashboard));
}

test('rendered dashboard puts KPI row above journal cards and renders sale/purchase counts, amounts, links, and 13-month bars', async () => {
  let db = seed();
  const sale = search(db, 'account.journal').find((j) => j.type === 'sale' && j.code === 'INV');
  const purchase = search(db, 'account.journal').find((j) => j.type === 'purchase' && j.code === 'BILL');
  const twoMonthsAgo = shiftMonth(today(), -2);
  const draftBill = create(db, 'account.move', {
    move_type: 'in_invoice', journal_id: purchase.id, partner_id: 7, invoice_date: today(),
    invoice_line_ids: [{ name: 'Draft bill', qty: 1, price_unit: 325, tax: 0 }],
  });
  const oldInv = create(draftBill.db, 'account.move', {
    move_type: 'out_invoice', journal_id: sale.id, partner_id: 3,
    invoice_date: twoMonthsAgo, invoice_date_due: addDays(today(), -10),
    invoice_line_ids: [{ name: 'Old service', qty: 1, price_unit: 450, tax: 0 }],
  });
  db = postMove(oldInv.db, oldInv.id);

  const html = await renderDashboard(db);
  const kpiPos = html.indexOf('class="kpis"');
  const cardsPos = html.indexOf('class="journal-cards"');
  assert.ok(kpiPos > 0 && cardsPos > kpiPos, 'KPI tiles sit above journal cards');

  assert.match(html, new RegExp(`href="#/accounting/invoices\\?view=list&amp;rel=journal_id:${sale.id}&amp;filter=draft">1 To Validate</a>`));
  assert.match(html, new RegExp(`href="#/accounting/invoices\\?view=list&amp;rel=journal_id:${sale.id}&amp;filter=unpaid">`));
  assert.match(html, new RegExp(`href="#/accounting/invoices\\?view=list&amp;rel=journal_id:${sale.id}&amp;filter=overdue">`));
  assert.match(html, new RegExp(`href="#/accounting/bills\\?view=list&amp;rel=journal_id:${purchase.id}&amp;filter=draft">1 To Validate</a>`));
  assert.match(html, new RegExp(`href="#/accounting/bills\\?view=list&amp;rel=journal_id:${purchase.id}&amp;filter=unpaid">1 To Pay</a>`));
  assert.match(html, new RegExp(`href="#/accounting/bills\\?view=list&amp;rel=journal_id:${purchase.id}&amp;filter=overdue">0 Late</a>`));
  assert.match(html, /\$325\.00/);
  assert.doesNotMatch(html, /To Validate.*·/);
  assert.doesNotMatch(html, /Unpaid.*·/);
  assert.doesNotMatch(html, /To Pay.*·/);
  const zeroMonth = shiftMonth(today(), -1).slice(0, 7);
  assert.match(html, new RegExp(`data-month="${zeroMonth}"`));
});

test('rendered dashboard bank card shows N To Reconcile button, conditional Outstanding Payments, and Misc. Operations', async () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && j.code === 'BNK1');
  const htmlWithoutOutstanding = await renderDashboard(db);
  assert.match(htmlWithoutOutstanding, new RegExp(`href="#/accounting/bank\\?view=list&amp;rel=journal_id:${bank.id}">3 To Reconcile</a>`));
  assert.doesNotMatch(htmlWithoutOutstanding, /Outstanding Payments/);
  assert.match(htmlWithoutOutstanding, /1 Misc\. Operations/);

  db = write(db, 'account.journal', bank.id, {
    outstanding_receipts_account_id: accountId(db, '101402'),
    outstanding_payments_account_id: accountId(db, '101403'),
  });
  const pmt = create(db, 'account.payment', { partner_id: 3, company_id: 1, journal_id: bank.id, amount: 250, date: today(), payment_type: 'inbound', partner_type: 'customer' });
  db = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id));
  const htmlWithOutstanding = await renderDashboard(db);
  assert.match(htmlWithOutstanding, /1 Outstanding Payments/);
  assert.match(htmlWithOutstanding, /\$250\.00/);
});

test('rendered dashboard shows empty states for journals with no posted entries and hides Reconcile on empty bank/cash', async () => {
  let db = seed();
  const emptyBankAcc = create(db, 'account.account', { code: '101488', name: 'Empty Bank Account', account_type: 'asset_cash', company_id: 1 });
  const emptyCashAcc = create(emptyBankAcc.db, 'account.account', { code: '101588', name: 'Empty Cash Account', account_type: 'asset_cash', company_id: 1 });
  const emptySale = create(emptyCashAcc.db, 'account.journal', { name: 'Empty Sale', code: 'ESAL', type: 'sale', invoice_sequence_prefix: 'ES/' });
  const emptyPurchase = create(emptySale.db, 'account.journal', { name: 'Empty Purchase', code: 'EPUR', type: 'purchase', invoice_sequence_prefix: 'EP/' });
  const emptyBank = create(emptyPurchase.db, 'account.journal', { name: 'Empty Bank', code: 'EBNK', type: 'bank', default_account_id: emptyBankAcc.id });
  const emptyCash = create(emptyBank.db, 'account.journal', { name: 'Empty Cash', code: 'ECSH', type: 'cash', default_account_id: emptyCashAcc.id });
  // Also post an entry on an unrelated cash journal so the empty cash card is clearly isolated.
  const seededCash = search(emptyCash.db, 'account.journal').find((j) => j.type === 'cash' && j.code === 'CSH1');
  db = postEntry(emptyCash.db, {
    journal: 'MISC', date: today(), ref: 'Cash misc',
    lines: [{ account_id: seededCash.default_account_id, debit: 50 }, { account_id: accountId(emptyCash.db, '301000'), credit: 50 }],
  }).db;

  const html = await renderDashboard(db);
  assert.match(html, /Empty Sale[\s\S]*Create your first invoice\.[\s\S]*New Invoice/);
  assert.match(html, /Empty Purchase[\s\S]*Create your first bill\.[\s\S]*New Bill/);
  assert.match(html, /Empty Bank[\s\S]*No transactions yet\./);
  assert.match(html, /Empty Cash[\s\S]*No transactions yet\./);
  assert.doesNotMatch(html, new RegExp(`rel=journal_id:${emptyBank.id}[^>]*>.*Reconcile`));
  assert.doesNotMatch(html, new RegExp(`rel=journal_id:${emptyCash.id}[^>]*>.*Reconcile`));
});
