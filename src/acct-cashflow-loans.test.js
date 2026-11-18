import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { accountId, balances, journalItems } from './models/ledger.js';
import { cashFlow, accountCashFlowActivity } from './models/reports.js';
import { confirmLoan, postDueLines } from './models/loans.js';
import { postMove } from './models/accounting.js';

test('loan disbursement classifies proceeds as financing in', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const loan = create(db, 'account.loan', {
    name: 'Term Loan 50k',
    amount: 50000,
    duration: 12,
    interest_rate: 6,
    method: 'annuity',
    start_date: '2040-01-01',
    journal_id: bankJournal.id,
    bank_account_id: accountId(db, '101401'),
    principal_account_id: accountId(db, '260000'),
    interest_account_id: accountId(db, '690400'),
    company_id: 1,
    state: 'draft',
  });
  db = confirmLoan(loan.db, read(loan.db, 'account.loan', loan.id));

  const period = { from: '2040-01-01', to: '2040-01-01', company_id: 1 };
  const flow = cashFlow(db, period);

  assert.equal(flow.financing, 50000, 'Loan disbursement proceeds are classified as financing cash inflow');
  assert.equal(flow.operating, 0);
  assert.equal(flow.investing, 0);
  assert.equal(flow.unclassified, 0);
  assert.equal(flow.net, 50000);
  assert.equal(flow.closing - flow.opening, flow.net);

  const ledgerCash = balances(db, journalItems(db, { to: '2040-01-01', company_id: 1 }))
    .filter((b) => b.account.account_type === 'asset_cash')
    .reduce((s, b) => s + b.balance, 0);
  assert.equal(flow.closing, Math.round(ledgerCash * 100) / 100, 'Closing cash matches ledger cash balance');
});

test('loan repayment splits principal (financing out) vs interest (operating out)', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const loan = create(db, 'account.loan', {
    name: 'Equipment Loan',
    amount: 12000,
    duration: 12,
    interest_rate: 10,
    method: 'linear',
    start_date: '2040-01-01',
    journal_id: bankJournal.id,
    bank_account_id: accountId(db, '101401'),
    principal_account_id: accountId(db, '260000'),
    interest_account_id: accountId(db, '690400'),
    company_id: 1,
    state: 'draft',
  });
  db = confirmLoan(loan.db, read(loan.db, 'account.loan', loan.id));

  // Post the first instalment due at 2040-02-29 (the month after start_date 2040-01-01)
  const loanRec = read(db, 'account.loan', loan.id);
  db = postDueLines(db, loanRec, '2040-02-29');

  const firstLine = read(db, 'account.loan', loan.id).line_ids.find((l) => l.posted);
  assert.ok(firstLine, 'First instalment line should be posted');
  assert.equal(firstLine.principal, 1000, 'Linear principal is 1000');
  assert.equal(firstLine.interest, 100, 'Monthly interest is 100');
  assert.equal(firstLine.payment, 1100, 'Total payment is 1100');

  // Evaluate cash flow on the repayment date only
  const repaymentPeriod = { from: '2040-02-29', to: '2040-02-29', company_id: 1 };
  const flow = cashFlow(db, repaymentPeriod);

  assert.equal(flow.financing, -1000, 'Principal repayment is financing outflow');
  assert.equal(flow.operating, -100, 'Interest expense is operating outflow');
  assert.equal(flow.investing, 0);
  assert.equal(flow.unclassified, 0);
  assert.equal(flow.net, -1100, 'Net cash change matches total payment');
  assert.equal(flow.operating + flow.financing, flow.net);
  assert.equal(flow.closing - flow.opening, flow.net);

  const ledgerCash = balances(db, journalItems(db, { to: '2040-02-29', company_id: 1 }))
    .filter((b) => b.account.account_type === 'asset_cash')
    .reduce((s, b) => s + b.balance, 0);
  assert.equal(flow.closing, Math.round(ledgerCash * 100) / 100, 'Closing cash matches ledger cash balance');
});

test('the cash-flow tag decides the section and an untagged counterpart stays unclassified', () => {
  let db = seed();
  const cash = accountId(db, '101401');
  const tagInvesting = create(db, 'account.account.tag', { name: 'CapEx Tag', applicability: 'accounts', cash_flow_activity: 'investing' });
  const tagFinancing = create(tagInvesting.db, 'account.account.tag', { name: 'Funding Tag', applicability: 'accounts', cash_flow_activity: 'financing' });
  db = tagFinancing.db;
  const expenseInvesting = create(db, 'account.account', { code: '609902', name: 'Tagged R&D Assetization', account_type: 'expense', tag_ids: [tagInvesting.id] });
  const fixedFinancing = create(expenseInvesting.db, 'account.account', { code: '159904', name: 'Financed Equipment', account_type: 'asset_fixed', tag_ids: [tagFinancing.id] });
  const untaggedFixed = create(fixedFinancing.db, 'account.account', { code: '159903', name: 'Untagged Machinery', account_type: 'asset_fixed' });
  db = untaggedFixed.db;

  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', expenseInvesting.id)), 'investing');
  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', fixedFinancing.id)), 'financing');
  assert.equal(accountCashFlowActivity(db, read(db, 'account.account', untaggedFixed.id)), 'unclassified');

  const post = (lines) => {
    const m = create(db, 'account.move', { move_type: 'entry', invoice_date: '2040-05-10', line_ids: lines });
    db = postMove(m.db, m.id);
  };
  post([{ account_id: cash, credit: 200 }, { account_id: expenseInvesting.id, debit: 200 }]);
  post([{ account_id: cash, debit: 400 }, { account_id: fixedFinancing.id, credit: 400 }]);
  post([{ account_id: cash, credit: 300 }, { account_id: untaggedFixed.id, debit: 300 }]);

  const report = cashFlow(db, { from: '2040-05-10', to: '2040-05-10', company_id: 1 });
  assert.deepEqual([report.operating, report.investing, report.financing, report.unclassified, report.net], [0, -200, 400, -300, -100]);
});

test('opening plus net change equals closing cash and closing cash reconciles to the ledger', () => {
  let db = seed();
  const bankJournal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = accountId(db, '101401');

  // Prior period move (before from date)
  const prior = create(db, 'account.move', {
    move_type: 'entry', invoice_date: '2040-01-15',
    line_ids: [{ account_id: cash, debit: 5000 }, { account_id: accountId(db, '301000'), credit: 5000 }],
  });
  db = postMove(prior.db, prior.id);

  // In-period transactions
  // 1. Loan disbursement of 25,000 on 2040-02-01
  const loan = create(db, 'account.loan', {
    name: 'Test Reconciliation Loan',
    amount: 25000,
    duration: 12,
    interest_rate: 6,
    method: 'annuity',
    start_date: '2040-02-01',
    journal_id: bankJournal.id,
    bank_account_id: cash,
    principal_account_id: accountId(db, '260000'),
    interest_account_id: accountId(db, '690400'),
    company_id: 1,
    state: 'draft',
  });
  db = confirmLoan(loan.db, read(loan.db, 'account.loan', loan.id));

  // 2. Loan repayment on 2040-02-28
  db = postDueLines(db, read(db, 'account.loan', loan.id), '2040-02-28');

  // 3. Operating expense payment on 2040-02-15
  const exp = create(db, 'account.move', {
    move_type: 'entry', invoice_date: '2040-02-15',
    line_ids: [{ account_id: cash, credit: 750 }, { account_id: accountId(db, '600000'), debit: 750 }],
  });
  db = postMove(exp.db, exp.id);

  const period = { from: '2040-02-01', to: '2040-02-28', company_id: 1 };
  const flow = cashFlow(db, period);

  // Invariant 1: opening + net equals closing
  assert.equal(flow.closing, flow.opening + flow.net, 'Opening + net change must equal closing cash');

  // Invariant 2: closing cash equals ledger cash/bank account balances at end date
  const ledgerItemsAtTo = journalItems(db, { to: '2040-02-28', company_id: 1 });
  const ledgerCashBalancesAtTo = balances(db, ledgerItemsAtTo)
    .filter((b) => b.account.account_type === 'asset_cash')
    .reduce((s, b) => s + b.balance, 0);
  assert.equal(flow.closing, Math.round(ledgerCashBalancesAtTo * 100) / 100, 'Closing cash matches ledger cash balance at end date');

  // Invariant 3: opening cash equals ledger cash/bank account balances before start date
  const ledgerItemsBeforeFrom = journalItems(db, { company_id: 1 }).filter((l) => l.date < '2040-02-01');
  const ledgerCashBalancesBeforeFrom = balances(db, ledgerItemsBeforeFrom)
    .filter((b) => b.account.account_type === 'asset_cash')
    .reduce((s, b) => s + b.balance, 0);
  assert.equal(flow.opening, Math.round(ledgerCashBalancesBeforeFrom * 100) / 100, 'Opening cash matches ledger cash balance at start date');

  // Invariant 4: sum of sections equals net
  assert.equal(flow.net, flow.operating + flow.investing + flow.financing + flow.unclassified);
});

test('company isolation strictly scopes cash flow items to the requested company', () => {
  let db = seed();
  const c1Cash = accountId(db, '101401');
  const c1LoanAccount = accountId(db, '260000');

  // Create Company 2 and its own accounts
  const comp2 = create(db, 'res.company', {
    name: 'Subsidiary Two Ltd',
    currency_id: db.records['res.company'][0].currency_id,
    default_general_journal_id: read(db, 'res.company', 1).default_general_journal_id,
  });
  db = comp2.db;

  const financingTag = create(db, 'account.account.tag', { name: 'Co2 Financing', applicability: 'accounts', cash_flow_activity: 'financing' });
  const operatingTag = create(financingTag.db, 'account.account.tag', { name: 'Co2 Operating', applicability: 'accounts', cash_flow_activity: 'operating' });
  db = operatingTag.db;
  const c2Cash = create(db, 'account.account', {
    code: '101402',
    name: 'Co2 Bank',
    account_type: 'asset_cash',
    company_id: comp2.id,
  });
  const c2LoanAcc = create(c2Cash.db, 'account.account', {
    code: '260002',
    name: 'Co2 Loans Payable',
    account_type: 'liability_non_current',
    company_id: comp2.id,
    tag_ids: [financingTag.id],
  });
  const c2ExpAcc = create(c2LoanAcc.db, 'account.account', {
    code: '600002',
    name: 'Co2 Operating Expense',
    account_type: 'expense',
    company_id: comp2.id,
    tag_ids: [operatingTag.id],
  });
  db = c2ExpAcc.db;

  // Post transactions in Company 1
  const m1 = create(db, 'account.move', {
    move_type: 'entry', invoice_date: '2040-03-01', company_id: 1,
    line_ids: [{ account_id: c1Cash, debit: 15000 }, { account_id: c1LoanAccount, credit: 15000 }],
  });
  const m1b = create(m1.db, 'account.move', {
    move_type: 'entry', invoice_date: '2040-03-10', company_id: 1,
    line_ids: [{ account_id: c1Cash, credit: 2000 }, { account_id: accountId(db, '600000'), debit: 2000 }],
  });
  db = postMove(postMove(m1b.db, m1.id), m1b.id);

  // Post transactions in Company 2
  const m2 = create(db, 'account.move', {
    move_type: 'entry', invoice_date: '2040-03-05', company_id: comp2.id,
    line_ids: [{ account_id: c2Cash.id, debit: 35000 }, { account_id: c2LoanAcc.id, credit: 35000 }],
  });
  const m2b = create(m2.db, 'account.move', {
    move_type: 'entry', invoice_date: '2040-03-12', company_id: comp2.id,
    line_ids: [{ account_id: c2Cash.id, credit: 4000 }, { account_id: c2ExpAcc.id, debit: 4000 }],
  });
  db = postMove(postMove(m2b.db, m2.id), m2b.id);

  const periodC1 = { from: '2040-03-01', to: '2040-03-31', company_id: 1 };
  const flowC1 = cashFlow(db, periodC1);

  assert.equal(flowC1.financing, 15000, 'Company 1 financing includes only Company 1 loan');
  assert.equal(flowC1.operating, -2000, 'Company 1 operating includes only Company 1 expense');
  assert.equal(flowC1.net, 13000, 'Company 1 net reflects only Company 1 net cash');
  const c1Ledger = balances(db, journalItems(db, { to: '2040-03-31', company_id: 1 }))
    .filter((b) => b.account.account_type === 'asset_cash')
    .reduce((s, b) => s + b.balance, 0);
  assert.equal(flowC1.closing, Math.round(c1Ledger * 100) / 100, 'Company 1 closing equals Company 1 ledger');

  const periodC2 = { from: '2040-03-01', to: '2040-03-31', company_id: comp2.id };
  const flowC2 = cashFlow(db, periodC2);

  assert.equal(flowC2.financing, 35000, 'Company 2 financing includes only Company 2 loan');
  assert.equal(flowC2.operating, -4000, 'Company 2 operating includes only Company 2 expense');
  assert.equal(flowC2.net, 31000, 'Company 2 net reflects only Company 2 net cash');
  const c2Ledger = balances(db, journalItems(db, { to: '2040-03-31', company_id: comp2.id }))
    .filter((b) => b.account.account_type === 'asset_cash')
    .reduce((s, b) => s + b.balance, 0);
  assert.equal(flowC2.closing, Math.round(c2Ledger * 100) / 100, 'Company 2 closing equals Company 2 ledger');
});
