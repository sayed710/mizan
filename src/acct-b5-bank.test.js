import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { ONLINE_FEED_JOURNAL_TYPES, STATEMENT_JOURNAL_TYPES, isOnlineFeedJournal, isStatementJournal, accountId } from './models/ledger.js';
import { bookBankMovement, bookToAccount, reconcileWith, unreconcile } from './models/bank.js';
import { counterpartTaxLines } from './models/reconcile.js';
import { journalCards, taxReport, taxesByGrid } from './models/finance.js';
import { postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';
import { find, setupDom } from './test-support/dom.js';

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function makeInvoice(db, { partnerId = 1, price = 200, companyId = 1, date = '2026-10-01' } = {}) {
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    company_id: companyId,
    invoice_date: date,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: price, tax: 0 }],
  });
  const postedDb = postMove(inv.db, inv.id);
  return { db: postedDb, id: inv.id };
}

// -------------------------------------------------------------------------
// BANK-7: Cash journals in bank reconciliation
// -------------------------------------------------------------------------

test('BANK-7: STATEMENT_JOURNAL_TYPES includes cash, isOnlineFeedJournal restricts feeds to bank/credit, and Arabic translations exist', async () => {
  assert.ok(STATEMENT_JOURNAL_TYPES.includes('cash'), 'STATEMENT_JOURNAL_TYPES must include cash');
  assert.equal(isStatementJournal('cash'), true, 'isStatementJournal must return true for cash type string');
  assert.equal(isStatementJournal({ type: 'cash' }), true, 'isStatementJournal must return true for cash journal object');

  assert.deepEqual(ONLINE_FEED_JOURNAL_TYPES, ['bank', 'credit']);
  assert.equal(isOnlineFeedJournal('bank'), true);
  assert.equal(isOnlineFeedJournal('credit'), true);
  assert.equal(isOnlineFeedJournal('cash'), false);

  const fs = await import('node:fs');
  const i18nContent = fs.readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  assert.ok(i18nContent.includes("Taxes: 'الضرائب'"));
  assert.ok(i18nContent.includes("None: 'لا شيء'"));
  assert.ok(i18nContent.includes("'Select an invoice or bill to match': 'اختر فاتورة أو فاتورة مورد للمطابقة'"));
});

test('BANK-7: a statement line on a cash journal can be created, matched to an invoice, unreconciled, and dashboard counts open lines', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  assert.ok(cashJournal, 'Seeded cash journal must exist');

  // Baseline dashboard toReconcile for cash journal
  const beforeCards = journalCards(db);
  const beforeCashCard = beforeCards.find((c) => c.journal.id === cashJournal.id);
  assert.equal(beforeCashCard.toReconcile, 0, 'Initially 0 open lines on cash journal');

  // Create an open customer invoice for 150
  const inv = makeInvoice(db, { price: 150, date: '2026-03-01' });
  db = inv.db;

  // Create a statement line on the cash journal for 150
  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: cashJournal.id,
    company_id: 1,
    date: '2026-03-02',
    payment_ref: 'Cash Sale 150',
    amount: 150,
    state: 'to_check',
  });
  db = lineRes.db;

  // Dashboard count for cash journal counts its open lines
  const withLineCards = journalCards(db);
  const withLineCashCard = withLineCards.find((c) => c.journal.id === cashJournal.id);
  assert.equal(withLineCashCard.toReconcile, 1, 'Dashboard card for cash journal must count open lines to reconcile');

  // Match the statement line to the invoice
  const freshLine = read(db, 'account.bank.statement.line', lineRes.id);
  db = reconcileWith(db, freshLine, inv.id);

  // Line must now be reconciled
  const reconciledLine = read(db, 'account.bank.statement.line', lineRes.id);
  assert.equal(reconciledLine.state, 'reconciled');
  assert.equal(reconciledLine.open_amount, 0);
  assert.equal(reconciledLine.allocations?.length, 1);
  assert.equal(reconciledLine.allocations[0].invoice_id, inv.id);

  // Invoice must be fully paid
  const paidInvoice = read(db, 'account.move', inv.id);
  assert.equal(paidInvoice.amount_residual, 0);

  // Dashboard count drops to 0 open items to reconcile
  const reconciledCards = journalCards(db);
  const reconciledCashCard = reconciledCards.find((c) => c.journal.id === cashJournal.id);
  assert.equal(reconciledCashCard.toReconcile, 0, 'Dashboard card for cash journal drops to 0 when reconciled');

  // Unreconcile the statement line
  const unreconciled = unreconcile(db, reconciledLine);
  db = unreconciled.db;

  const afterLine = read(db, 'account.bank.statement.line', lineRes.id);
  assert.equal(afterLine.state, 'to_check');
  assert.equal(afterLine.open_amount, 150);
  assert.deepEqual(afterLine.allocations, []);

  // Invoice residual is restored
  const restoredInvoice = read(db, 'account.move', inv.id);
  assert.equal(restoredInvoice.amount_residual, 150);

  // Dashboard count is back to 1
  const afterCards = journalCards(db);
  const afterCashCard = afterCards.find((c) => c.journal.id === cashJournal.id);
  assert.equal(afterCashCard.toReconcile, 1, 'Dashboard card for cash journal counts restored open line');
});

// -------------------------------------------------------------------------
// BANK-12: Taxes on manual reconciliation lines
// -------------------------------------------------------------------------

test('BANK-12: a 115 receipt booked to income with a 15% sales tax posts 100 income + 15 tax on tax repartition account with grid tags and tax report picks it up', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  // Create tags for tax grid reporting
  const baseTag = create(db, 'account.account.tag', { name: 'Base 15%', applicability: 'taxes', country_id: 1 });
  const taxTag = create(baseTag.db, 'account.account.tag', { name: 'Tax 15%', applicability: 'taxes', country_id: 1 });
  db = taxTag.db;

  // Dedicated tax repartition account
  const taxAcc = create(db, 'account.account', {
    code: '220015',
    name: 'Sales Tax 15%',
    account_type: 'liability_current',
    company_id: 1,
  });
  db = taxAcc.db;

  // 15% sales tax with repartition lines carrying accounts and grid tags
  const taxRes = create(db, 'account.tax', {
    name: 'VAT 15%',
    amount_type: 'percent',
    amount: 15,
    type_tax_use: 'sale',
    price_include: true,
    company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [baseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc.id, tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [baseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc.id, tag_ids: [taxTag.id] },
    ],
  });
  db = taxRes.db;

  // Income account 400000
  const incomeAccountId = accountId(db, '400000', 1);

  // 115 receipt statement line
  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: bank.id,
    company_id: 1,
    date: '2026-03-10',
    payment_ref: 'Manual Receipt 115',
    amount: 115,
    partner_id: partner.id,
    state: 'to_check',
  });
  db = lineRes.db;
  const line = read(db, 'account.bank.statement.line', lineRes.id);

  // Book 115 to income account with the 15% sales tax (tax-included)
  const booked = bookToAccount(db, {
    ...line,
    counterpart_account_id: incomeAccountId,
  }, { amount: 115, label: 'Income booking', tax_ids: [taxRes.id] });
  db = booked.db;

  const updatedLine = read(db, 'account.bank.statement.line', lineRes.id);
  assert.equal(updatedLine.state, 'reconciled');
  assert.equal(updatedLine.open_amount, 0);

  const move = read(db, 'account.move', updatedLine.move_id);
  assert.ok(move, 'Move must be created and linked to statement line');
  assert.equal(move.state, 'posted');

  // Verify move lines:
  // 1) Net income line: credit 100 on income account, tax_grid_base=true, tax_tag_ids=[baseTag.id]
  const incomeLine = move.line_ids.find((l) => l.account_id === incomeAccountId);
  assert.ok(incomeLine, 'Income counterpart line must exist');
  assert.equal(Number(incomeLine.credit), 100, 'Income line must be credited 100');
  assert.equal(Number(incomeLine.debit), 0);
  assert.equal(incomeLine.tax_grid_base, true, 'Income line must carry tax_grid_base=true');
  assert.deepEqual(incomeLine.tax_tag_ids, [baseTag.id], 'Income line must carry base grid tags');

  // 2) Tax line: credit 15 on taxAcc, tax_base=100, tax_tag_ids=[taxTag.id]
  const taxLine = move.line_ids.find((l) => l.account_id === taxAcc.id);
  assert.ok(taxLine, 'Tax repartition line must exist');
  assert.equal(Number(taxLine.credit), 15, 'Tax line must be credited 15');
  assert.equal(Number(taxLine.debit), 0);
  assert.equal(Number(taxLine.tax_base), 100, 'Tax line must carry tax_base of 100');
  assert.deepEqual(taxLine.tax_tag_ids, [taxTag.id], 'Tax line must carry tax grid tags');
  assert.equal(taxLine.tax_side, 'sale', 'Tax line tax_side must be sale');

  // 3) Tax report picks it up
  const report = taxReport(db, { from: '2026-03-01', to: '2026-03-31', company_id: 1 });
  assert.equal(report.output, 15, 'Tax report output must be 15');
  assert.equal(report.input, 0, 'Tax report input must be 0');
  assert.equal(report.payable, 15, 'Tax report payable must be 15');

  // 4) Tax grid report picks it up
  const gridReport = taxesByGrid(db, { from: '2026-03-01', to: '2026-03-31', company_id: 1 });
  const baseGrid = gridReport.find((g) => g.id === baseTag.id);
  const taxGrid = gridReport.find((g) => g.id === taxTag.id);
  assert.ok(baseGrid, 'Base grid tag must appear in taxesByGrid');
  assert.equal(baseGrid.base, 100, 'Base grid tag base must be 100');
  assert.ok(taxGrid, 'Tax grid tag must appear in taxesByGrid');
  assert.equal(taxGrid.tax, 15, 'Tax grid tag tax must be 15');
});

test('BANK-12: BankReconcile widget renders Taxes field in Manual Operation tab and passes tax ids to bookToAccount', async () => {
  let db = seed();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const incomeAccount = accountId(db, '400000', 1);

  // Create a 15% tax
  const tax = create(db, 'account.tax', {
    name: 'Manual Test Tax 15%',
    amount_type: 'percent',
    amount: 15,
    type_tax_use: 'sale',
    company_id: 1,
  });
  db = tax.db;

  const st = create(db, 'account.bank.statement.line', {
    journal_id: bank.id,
    company_id: 1,
    date: '2026-03-05',
    payment_ref: 'UI Manual Tax 115',
    amount: 115,
    state: 'to_check',
  });
  db = st.db;

  const { makeEl } = setupDom();
  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));

    // Select the statement line
    const stLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('UI Manual Tax 115'));
    assert.ok(stLineBtn, 'Statement line button must exist');
    await React.act(async () => props(stLineBtn).onClick());

    // Switch to manual tab
    const manualTab = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.includes('Manual Operation'));
    assert.ok(manualTab, 'Manual Operation tab must exist');
    await React.act(async () => props(manualTab).onClick());

    // Taxes field must exist and be multi-select
    const taxesSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Taxes');
    assert.ok(taxesSelect, 'Taxes select must exist in manual operation tab');
    assert.equal(props(taxesSelect)?.multiple, true, 'Taxes select must be a multi-select');

    // Select counterpart account
    const accountSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Counterpart Account');
    assert.ok(accountSelect, 'Counterpart Account select must exist');
    await React.act(async () => {
      props(accountSelect).onChange({ target: { value: String(incomeAccount) } });
    });

    // Select the tax
    await React.act(async () => {
      props(taxesSelect).onChange({ target: { selectedOptions: [{ value: String(tax.id) }] } });
    });

    // Click Validate
    const validateBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Validate'));
    assert.ok(validateBtn, 'Validate button must exist');
    await React.act(async () => props(validateBtn).onClick());

    // Verify statement line is reconciled with tax split
    const currentDb = (await import('./store.js')).getDb();
    const reconciledSt = read(currentDb, 'account.bank.statement.line', st.id);
    assert.equal(reconciledSt.state, 'reconciled');
    const move = read(currentDb, 'account.move', reconciledSt.move_id);
    assert.ok(move, 'Move must be created');
    const incLine = move.line_ids.find((l) => l.account_id === incomeAccount);
    assert.equal(Number(incLine.credit), 100);
  } finally {
    await React.act(async () => root.unmount());
  }
});

// -------------------------------------------------------------------------
// BANK-14: Several candidates matching
// -------------------------------------------------------------------------

test('BANK-14: one 300 statement line matched to invoices of 100 and 200 reconciles both fully', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  const inv1 = makeInvoice(db, { partnerId: partner.id, price: 100, date: '2026-03-01' });
  db = inv1.db;
  const inv2 = makeInvoice(db, { partnerId: partner.id, price: 200, date: '2026-03-02' });
  db = inv2.db;

  const st = create(db, 'account.bank.statement.line', {
    journal_id: bank.id,
    company_id: 1,
    partner_id: partner.id,
    date: '2026-03-05',
    payment_ref: 'MATCH-300',
    amount: 300,
    state: 'to_check',
  });
  db = st.db;
  const line = read(db, 'account.bank.statement.line', st.id);

  // Match 300 line against both invoices [inv1, inv2]
  db = reconcileWith(db, line, [inv1.id, inv2.id]);

  // Both invoices must be fully reconciled (residual 0)
  assert.equal(read(db, 'account.move', inv1.id).amount_residual, 0, 'Invoice 1 must be fully paid');
  assert.equal(read(db, 'account.move', inv2.id).amount_residual, 0, 'Invoice 2 must be fully paid');

  // Statement line must be fully reconciled
  const reconciledLine = read(db, 'account.bank.statement.line', st.id);
  assert.equal(reconciledLine.state, 'reconciled');
  assert.equal(reconciledLine.open_amount, 0);
  assert.equal(reconciledLine.allocations?.length, 2);
  assert.equal(reconciledLine.allocations[0].invoice_id, inv1.id);
  assert.equal(reconciledLine.allocations[0].amount, 100);
  assert.equal(reconciledLine.allocations[1].invoice_id, inv2.id);
  assert.equal(reconciledLine.allocations[1].amount, 200);

  // Unreconciling restores both invoices
  db = unreconcile(db, reconciledLine).db;
  assert.equal(read(db, 'account.move', inv1.id).amount_residual, 100);
  assert.equal(read(db, 'account.move', inv2.id).amount_residual, 200);
  assert.equal(read(db, 'account.bank.statement.line', st.id).state, 'to_check');
});

test('BANK-14: matching 100 + 250 against 300 leaves the expected partial on the right document', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  const inv1 = makeInvoice(db, { partnerId: partner.id, price: 100, date: '2026-03-01' });
  db = inv1.db;
  const inv2 = makeInvoice(db, { partnerId: partner.id, price: 250, date: '2026-03-02' });
  db = inv2.db;

  const st = create(db, 'account.bank.statement.line', {
    journal_id: bank.id,
    company_id: 1,
    partner_id: partner.id,
    date: '2026-03-05',
    payment_ref: 'MATCH-PART-300',
    amount: 300,
    state: 'to_check',
  });
  db = st.db;
  const line = read(db, 'account.bank.statement.line', st.id);

  // Match 300 line against [inv1 (100), inv2 (250)]
  db = reconcileWith(db, line, [inv1.id, inv2.id]);

  // First invoice is fully paid
  assert.equal(read(db, 'account.move', inv1.id).amount_residual, 0, 'Invoice 1 must be fully paid');

  // Second invoice is partially paid (250 - 200 = 50 remaining)
  assert.equal(read(db, 'account.move', inv2.id).amount_residual, 50, 'Invoice 2 must have 50 residual left');

  // Statement line is fully reconciled
  const reconciledLine = read(db, 'account.bank.statement.line', st.id);
  assert.equal(reconciledLine.state, 'reconciled');
  assert.equal(reconciledLine.open_amount, 0);
  assert.equal(reconciledLine.allocations?.length, 2);
  assert.equal(reconciledLine.allocations[0].invoice_id, inv1.id);
  assert.equal(reconciledLine.allocations[0].amount, 100);
  assert.equal(reconciledLine.allocations[1].invoice_id, inv2.id);
  assert.equal(reconciledLine.allocations[1].amount, 200);
});

test('BANK-14: BankReconcile widget allows selecting several candidate invoices and matching them in one action', async () => {
  let db = seed();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  const inv1 = makeInvoice(db, { partnerId: partner.id, price: 100, date: '2026-03-01' });
  db = inv1.db;
  const inv2 = makeInvoice(db, { partnerId: partner.id, price: 200, date: '2026-03-02' });
  db = inv2.db;

  const st = create(db, 'account.bank.statement.line', {
    journal_id: bank.id,
    company_id: 1,
    partner_id: partner.id,
    date: '2026-03-05',
    payment_ref: 'UI Match 300',
    amount: 300,
    state: 'to_check',
  });
  db = st.db;

  const { makeEl } = setupDom();
  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));

    // Select the statement line
    const stLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('UI Match 300'));
    assert.ok(stLineBtn, 'Statement line button must exist');
    await React.act(async () => props(stLineBtn).onClick());

    const inv1Name = read(db, 'account.move', inv1.id).name;
    const inv2Name = read(db, 'account.move', inv2.id).name;

    // Both candidates appear in the list
    const cand1Btn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(inv1Name));
    const cand2Btn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(inv2Name));
    assert.ok(cand1Btn, 'Candidate 1 button must exist');
    assert.ok(cand2Btn, 'Candidate 2 button must exist');

    // Click candidate 1 to toggle it on
    await React.act(async () => props(cand1Btn).onClick());
    // Click candidate 2 to toggle it on
    await React.act(async () => props(cand2Btn).onClick());

    // Both should now be active/selected
    assert.equal(props(cand1Btn)?.['aria-pressed'], true, 'Candidate 1 should be selected');
    assert.equal(props(cand2Btn)?.['aria-pressed'], true, 'Candidate 2 should be selected');

    // Click Validate
    const validateBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Validate'));
    assert.ok(validateBtn, 'Validate button must exist');
    await React.act(async () => props(validateBtn).onClick());

    // Check store db
    const currentDb = (await import('./store.js')).getDb();
    assert.equal(read(currentDb, 'account.move', inv1.id).amount_residual, 0);
    assert.equal(read(currentDb, 'account.move', inv2.id).amount_residual, 0);
    const reconciledSt = read(currentDb, 'account.bank.statement.line', st.id);
    assert.equal(reconciledSt.state, 'reconciled');
    assert.equal(reconciledSt.allocations?.length, 2);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('BANK-7, BANK-12, BANK-14: operations replay cleanly through diffDb + applyDiff without server guard errors', () => {
  let db = seed();
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner')[0];

  // 1. BANK-7: Cash statement line creation and reconciliation through diffDb + applyDiff
  const inv = makeInvoice(db, { price: 50, date: '2026-03-01' });
  db = applyDiff(db, diffDb(db, inv.db), { isAdmin: true });

  const cashLineRes = create(db, 'account.bank.statement.line', {
    journal_id: cashJournal.id,
    company_id: 1,
    date: '2026-03-02',
    payment_ref: 'Cash Line Sync',
    amount: 50,
    state: 'to_check',
  });
  db = applyDiff(db, diffDb(db, cashLineRes.db), { isAdmin: true });

  const matchedCashDb = reconcileWith(db, read(db, 'account.bank.statement.line', cashLineRes.id), inv.id);
  db = applyDiff(db, diffDb(db, matchedCashDb), { isAdmin: true });
  assert.equal(read(db, 'account.bank.statement.line', cashLineRes.id).state, 'reconciled');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);

  const unreconciledDb = unreconcile(db, read(db, 'account.bank.statement.line', cashLineRes.id)).db;
  db = applyDiff(db, diffDb(db, unreconciledDb), { isAdmin: true });
  assert.equal(read(db, 'account.bank.statement.line', cashLineRes.id).state, 'to_check');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 50);

  // 2. BANK-12: Manual line with tax booking through diffDb + applyDiff
  const tax = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'sale');
  const incomeAccount = accountId(db, '400000', 1);
  const manualLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    date: '2026-03-03',
    payment_ref: 'Manual Tax Sync',
    amount: 115,
    state: 'to_check',
  });
  db = applyDiff(db, diffDb(db, manualLine.db), { isAdmin: true });
  const bookedTaxDb = bookToAccount(db, {
    ...read(db, 'account.bank.statement.line', manualLine.id),
    counterpart_account_id: incomeAccount,
  }, { amount: 115, label: 'Manual tax test', tax_ids: [tax.id] }).db;
  db = applyDiff(db, diffDb(db, bookedTaxDb), { isAdmin: true });
  const reconciledManual = read(db, 'account.bank.statement.line', manualLine.id);
  assert.equal(reconciledManual.state, 'reconciled');
  assert.ok(reconciledManual.move_id);

  // 3. BANK-14: Multi-candidate match through diffDb + applyDiff
  const invA = makeInvoice(db, { price: 40, date: '2026-03-04' });
  db = applyDiff(db, diffDb(db, invA.db), { isAdmin: true });
  const invB = makeInvoice(db, { price: 60, date: '2026-03-04' });
  db = applyDiff(db, diffDb(db, invB.db), { isAdmin: true });

  const multiLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    partner_id: partner.id,
    date: '2026-03-05',
    payment_ref: 'Multi Candidate Sync',
    amount: 100,
    state: 'to_check',
  });
  db = applyDiff(db, diffDb(db, multiLine.db), { isAdmin: true });
  const multiMatchedDb = reconcileWith(db, read(db, 'account.bank.statement.line', multiLine.id), [invA.id, invB.id]);
  db = applyDiff(db, diffDb(db, multiMatchedDb), { isAdmin: true });
  assert.equal(read(db, 'account.move', invA.id).amount_residual, 0);
  assert.equal(read(db, 'account.move', invB.id).amount_residual, 0);
  assert.equal(read(db, 'account.bank.statement.line', multiLine.id).state, 'reconciled');
});

test('BANK-12: counterpartTaxLines extracts canonical tax split logic for both directions', () => {
  const db = seed();
  const saleTax = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'sale');
  const purchaseTax = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'purchase');
  const account = accountId(db, '400000', 1);

  // Seeded 14% sale tax on 114 amount gives 100 net + 14 tax
  // Incoming (receipt): net line credit, tax line credit, tax_side: sale
  const inLines = counterpartTaxLines(db, {
    company: 1,
    tax_ids: [saleTax.id],
    amount: 114,
    account_id: account,
    incoming: true,
  });
  assert.equal(inLines.length, 2);
  assert.equal(inLines[0].credit, 100);
  assert.equal(inLines[0].tax_side, 'sale');
  assert.equal(inLines[1].credit, 14);
  assert.equal(inLines[1].tax_side, 'sale');

  // Outgoing (payment): net line debit, tax line debit, tax_side: purchase
  const outLines = counterpartTaxLines(db, {
    company: 1,
    tax_ids: [purchaseTax.id],
    amount: 114,
    account_id: account,
    incoming: false,
  });
  assert.equal(outLines.length, 2);
  assert.equal(outLines[0].debit, 100);
  assert.equal(outLines[0].tax_side, 'purchase');
  assert.equal(outLines[1].debit, 14);
  assert.equal(outLines[1].tax_side, 'purchase');
});

test('Qodo Issue 1: foreign receipt rounding remainder is assigned to net line while foreign amounts stay exact', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  // Configure EUR (currency 2) rate to 2.7 units per company currency unit
  db = write(db, 'res.currency', 2, {
    rate_ids: [{ date: '2020-01-01', rate: 2.7, company_id: null }],
  });
  const incomeAccount = accountId(db, '400000', 1);
  const foreignJournal = create(db, 'account.journal', {
    name: 'EUR Bank',
    type: 'bank',
    code: 'EBANK',
    company_id: 1,
    currency_id: 2,
    default_account_id: bankJournal.default_account_id,
    suspense_account_id: bankJournal.suspense_account_id,
  });
  db = foreignJournal.db;
  const tax = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'sale' && t.amount === 14);

  // Foreign receipt of 114 EUR at rate 2.7 with 14% included tax:
  // Expected company liquidity = 114 / 2.7 = 42.22
  // Separately rounded net = 100 / 2.7 = 37.04, tax = 14 / 2.7 = 5.19 (sum 42.23, difference -0.01)
  // Adjusted net in company currency must be 37.03 so total balances to 42.22
  const line = create(db, 'account.bank.statement.line', {
    journal_id: foreignJournal.id,
    company_id: 1,
    counterpart_account_id: incomeAccount,
    foreign_currency_id: 2,
    amount_currency: 114,
    amount: 114,
    date: '2026-03-10',
    payment_ref: 'Foreign Receipt 114',
    state: 'to_check',
  });
  db = line.db;

  const booked = bookToAccount(db, read(db, 'account.bank.statement.line', line.id), {
    tax_ids: [tax.id],
  });
  const reconciledLine = read(booked.db, 'account.bank.statement.line', line.id);
  assert.equal(reconciledLine.state, 'reconciled');
  const move = read(booked.db, 'account.move', reconciledLine.move_id);
  assert.ok(move, 'Move must be posted without balance rejection');

  const liquidityLine = move.line_ids.find((l) => l.debit > 0);
  const netLine = move.line_ids.find((l) => l.account_id === incomeAccount);
  const taxLine = move.line_ids.find((l) => l !== liquidityLine && l !== netLine);

  assert.equal(liquidityLine.debit, 42.22);
  assert.equal(liquidityLine.amount_currency, 114);

  assert.equal(netLine.credit, 37.03);
  assert.equal(netLine.amount_currency, -100);

  assert.equal(taxLine.credit, 5.19);
  assert.equal(taxLine.amount_currency, -14);
});

test('Qodo Issue 2: in-memory write-off fields are retained in multi-invoice reconciliation, with and without prebooked movement', () => {
  for (const withPrebooked of [false, true]) {
    let db = seed();
    const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
    const partner = search(db, 'res.partner')[0];
    const expenseAccount = accountId(db, '600000', 1);

    const invA = makeInvoice(db, { partnerId: partner.id, price: 100, date: '2026-03-01' });
    db = invA.db;
    const invB = makeInvoice(db, { partnerId: partner.id, price: 50, date: '2026-03-01' });
    db = invB.db;

    // Statement line of 140 (settles 100 on invA, 40 on invB, and 10 writeoff on invB)
    const lineRes = create(db, 'account.bank.statement.line', {
      journal_id: bankJournal.id,
      company_id: 1,
      partner_id: partner.id,
      amount: 140,
      date: '2026-03-02',
      payment_ref: `Writeoff test prebooked=${withPrebooked}`,
      state: 'to_check',
    });
    db = lineRes.db;

    if (withPrebooked) {
      const booked = bookBankMovement(db, read(db, 'account.bank.statement.line', lineRes.id), 1, {
        date: '2026-03-02',
        openAmount: 140,
      });
      db = booked.db;
    }

    // In-memory line carrying writeoff fields (like BankReconcile widget passes)
    const inMemoryLine = {
      ...read(db, 'account.bank.statement.line', lineRes.id),
      writeoff_account_id: expenseAccount,
      writeoff_amount: 10,
      writeoff_label: 'Settlement discount',
    };

    const nextDb = reconcileWith(db, inMemoryLine, [invA.id, invB.id]);
    const finalLine = read(nextDb, 'account.bank.statement.line', lineRes.id);
    const finalA = read(nextDb, 'account.move', invA.id);
    const finalB = read(nextDb, 'account.move', invB.id);

    assert.equal(finalLine.state, 'reconciled');
    assert.equal(finalA.amount_residual, 0);
    assert.equal(finalB.amount_residual, 0);
    assert.ok(finalLine.writeoff_move_id, 'Write-off move id must be recorded on statement line');
    assert.equal(finalLine.allocations.length, 2);
    assert.equal(finalLine.allocations[0].amount, 100);
    assert.equal(finalLine.allocations[0].writeoff_move_id, undefined);
    assert.equal(finalLine.allocations[1].amount, 40);
    assert.equal(finalLine.allocations[1].writeoff_move_id, finalLine.writeoff_move_id);
  }
});

test('Qodo Issue 3: BankReconcile widget Taxes multi-select has no None option and binds array of string values', async () => {
  let db = seed();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');

  const line = create(db, 'account.bank.statement.line', {
    journal_id: bank.id,
    company_id: 1,
    date: '2026-03-05',
    payment_ref: 'UI Taxes Select Check',
    amount: 100,
    state: 'to_check',
  });
  db = line.db;

  const { makeEl } = setupDom();
  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));

    const stLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('UI Taxes Select Check'));
    await React.act(async () => props(stLineBtn).onClick());

    const manualTab = find(host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab' && n.textContent.includes('Manual Operation'));
    await React.act(async () => props(manualTab).onClick());

    const taxesSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Taxes');
    assert.ok(taxesSelect, 'Taxes select must exist');
    assert.equal(props(taxesSelect)?.multiple, true);
    assert.deepEqual(props(taxesSelect)?.value, [], 'Initial value must be empty array');

    const options = taxesSelect.options ?? [];
    assert.ok(options.length > 0, 'Options list must have taxes');
    assert.equal(options.some((o) => props(o)?.value === '' || o.textContent === 'None'), false, 'Must not contain None option');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Qodo Issue 4: counterpartTaxLines validates tax direction matches transaction and throws clear error', () => {
  const db = seed();
  const saleTax = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'sale');
  const purchaseTax = search(db, 'account.tax').find((t) => (t.company_id ?? 1) === 1 && t.type_tax_use === 'purchase');
  const account = accountId(db, '400000', 1);

  // Incoming transaction with purchase tax must throw
  assert.throws(
    () => counterpartTaxLines(db, {
      company: 1,
      tax_ids: [purchaseTax.id],
      amount: 100,
      account_id: account,
      incoming: true,
    }),
    /Incoming transactions only accept sale taxes/,
  );

  // Outgoing transaction with sale tax must throw
  assert.throws(
    () => counterpartTaxLines(db, {
      company: 1,
      tax_ids: [saleTax.id],
      amount: 100,
      account_id: account,
      incoming: false,
    }),
    /Outgoing transactions only accept purchase taxes/,
  );
});

test('Qodo Issue 5: multi-invoice matching rejects candidate invoices from different commercial partners and widget disables mismatched partner buttons', async () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partners = search(db, 'res.partner');
  const p1 = partners[0];
  const p2 = partners[1];

  const inv1 = makeInvoice(db, { partnerId: p1.id, price: 100, date: '2026-03-01' });
  db = inv1.db;
  const inv2 = makeInvoice(db, { partnerId: p2.id, price: 100, date: '2026-03-01' });
  db = inv2.db;
  const inv2b = makeInvoice(db, { partnerId: p2.id, price: 100, date: '2026-03-01' });
  db = inv2b.db;

  const lineNoPartner = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    amount: 200,
    date: '2026-03-02',
    payment_ref: 'Line No Partner Test',
    state: 'to_check',
  });
  db = lineNoPartner.db;

  assert.throws(
    () => reconcileWith(db, read(db, 'account.bank.statement.line', lineNoPartner.id), [inv1.id, inv2.id]),
    /All selected invoices must belong to the same commercial partner/,
  );

  const lineWithP1 = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    partner_id: p1.id,
    amount: 200,
    date: '2026-03-02',
    payment_ref: 'Line With P1 Test',
    state: 'to_check',
  });
  db = lineWithP1.db;

  assert.throws(
    () => reconcileWith(db, read(db, 'account.bank.statement.line', lineWithP1.id), [inv2.id, inv2b.id]),
    /All selected invoices must match the partner on the statement line/,
  );

  // Widget test: selecting inv1 disables inv2 (different partner)
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');

  const { makeEl } = setupDom();
  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));

    const stLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Line No Partner Test'));
    await React.act(async () => props(stLineBtn).onClick());

    const m1 = read(db, 'account.move', inv1.id);
    const m2 = read(db, 'account.move', inv2.id);
    const btn1 = find(host, (n) => n.tagName === 'BUTTON' && n.className?.includes('bank-reconcile-line-item') && n.textContent.includes(m1.name));
    const btn2 = find(host, (n) => n.tagName === 'BUTTON' && n.className?.includes('bank-reconcile-line-item') && n.textContent.includes(m2.name));
    assert.equal(Boolean(props(btn1)?.disabled), false);
    assert.equal(Boolean(props(btn2)?.disabled), false);

    await React.act(async () => props(btn1).onClick());

    const btn1After = find(host, (n) => n.tagName === 'BUTTON' && n.className?.includes('bank-reconcile-line-item') && n.textContent.includes(m1.name));
    const btn2After = find(host, (n) => n.tagName === 'BUTTON' && n.className?.includes('bank-reconcile-line-item') && n.textContent.includes(m2.name));
    assert.equal(Boolean(props(btn1After)?.disabled), false);
    assert.equal(Boolean(props(btn2After)?.disabled), true, 'Candidate with different partner must be disabled');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Qodo Issue 6: reconcileWith throws when statement amount is exhausted before last selected invoice is matched', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partner = search(db, 'res.partner')[0];

  const inv1 = makeInvoice(db, { partnerId: partner.id, price: 100, date: '2026-03-01' });
  db = inv1.db;
  const inv2 = makeInvoice(db, { partnerId: partner.id, price: 100, date: '2026-03-01' });
  db = inv2.db;

  // Statement line of 100 matched against two 100 invoices
  const line100 = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    company_id: 1,
    partner_id: partner.id,
    amount: 100,
    date: '2026-03-02',
    payment_ref: 'Exhausted Statement Line',
    state: 'to_check',
  });
  db = line100.db;

  assert.throws(
    () => reconcileWith(db, read(db, 'account.bank.statement.line', line100.id), [inv1.id, inv2.id]),
    /The statement amount is fully used before all selected invoices are matched/,
  );
});

test('a booked write-off is not replayed after unreconciliation', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partner = search(db, 'res.partner')[0];
  const inv = makeInvoice(db, { partnerId: partner.id, price: 100, date: '2026-03-01' });
  db = inv.db;
  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, company_id: 1, partner_id: partner.id, amount: 90, date: '2026-03-02', payment_ref: 'Replay check', state: 'to_check',
  });
  db = lineRes.db;
  db = reconcileWith(db, {
    ...read(db, 'account.bank.statement.line', lineRes.id),
    writeoff_account_id: accountId(db, '600000', 1), writeoff_amount: 10, writeoff_label: 'Fee',
  }, inv.id);
  const reconciled = read(db, 'account.bank.statement.line', lineRes.id);
  assert.ok(reconciled.writeoff_move_id);

  db = unreconcile(db, reconciled).db;
  const cleared = read(db, 'account.bank.statement.line', lineRes.id);
  assert.equal(cleared.writeoff_account_id ?? null, null);
  assert.equal(cleared.writeoff_amount ?? null, null);
  assert.equal(cleared.writeoff_label ?? null, null);

  // Matching again from the stored line books no write-off and leaves the invoice partly open.
  db = reconcileWith(db, cleared, inv.id);
  assert.equal(read(db, 'account.bank.statement.line', lineRes.id).writeoff_move_id ?? null, null);
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 10);
});
