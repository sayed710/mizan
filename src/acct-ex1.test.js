import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { executiveSummary } from './models/reports.js';
import { executiveColumns } from './views/reportCompare.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const findAll = (node, pred, out = []) => {
  if (pred(node)) out.push(node);
  for (const c of node.childNodes ?? []) findAll(c, pred, out);
  return out;
};

function seededExecutiveLedger() {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };

  const acc = (code) => search(db, 'account.account').find((a) => a.code === code);
  const bank = acc('101401');
  const ar = acc('121000');
  const stock = acc('110100');
  const fixed = acc('151000');
  const ap = acc('211000');
  const capital = acc('301000');
  const sales = acc('400000');
  const cogs = acc('500000');
  const rent = acc('630000');
  const bankFees = acc('690000');
  const otherInc = acc('450000');

  const cardRes = create(db, 'account.account', { code: '215000', name: 'Corporate Card', account_type: 'liability_credit_card', company_id: 1 });
  db = cardRes.db;
  const card = cardRes.id;

  const depExpRes = create(db, 'account.account', { code: '681000', name: 'Amortization', account_type: 'expense_depreciation', company_id: 1 });
  db = depExpRes.db;
  const depExp = depExpRes.id;

  const nonCurLiabRes = create(db, 'account.account', { code: '270000', name: 'Long-term Loan', account_type: 'liability_non_current', company_id: 1 });
  db = nonCurLiabRes.db;
  const nonCurLiab = nonCurLiabRes.id;

  // Prior month (2026-04-15): opening capital, long-term loan, credit card balance (-200), bank, and fixed asset
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-04-15',
    lines: [
      { account_id: bank.id, debit: 10000 },
      { account_id: fixed.id, debit: 4000 },
      { account_id: card, credit: 200 },
      { account_id: nonCurLiab, credit: 2000 },
      { account_id: capital.id, credit: 11800 },
    ],
  }).db;

  // Period 1 (2026-05-01 .. 2026-05-31, 31 days)
  // 1) Credit sale: Revenue 2000, AR 2000
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-05',
    lines: [{ account_id: ar.id, debit: 2000 }, { account_id: sales.id, credit: 2000 }],
  }).db;
  // 2) Customer payment: Bank +1500, AR -1500 (remaining AR = 500)
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-10',
    lines: [{ account_id: bank.id, debit: 1500 }, { account_id: ar.id, credit: 1500 }],
  }).db;
  // 3) Vendor bill for direct cost (Cost of Revenue 600) & inventory (400): AP -1000 raw
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-12',
    lines: [
      { account_id: cogs.id, debit: 600 },
      { account_id: stock.id, debit: 400 },
      { account_id: ap.id, credit: 1000 },
    ],
  }).db;
  // 4) Vendor payment: AP +700, Bank -700 (remaining AP raw balance = -300)
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-15',
    lines: [{ account_id: ap.id, debit: 700 }, { account_id: bank.id, credit: 700 }],
  }).db;
  // 5) Operating expense (Rent 200) paid on corporate credit card (liability_credit_card credit 200),
  //    followed by partial card repayment from bank (card debit 150, bank credit 150).
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-18',
    lines: [{ account_id: rent.id, debit: 200 }, { account_id: card, credit: 200 }],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-19',
    lines: [{ account_id: card, debit: 150 }, { account_id: bank.id, credit: 150 }],
  }).db;
  // 6) Other expense (Bank Fees 50) paid from bank and Depreciation (50)
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-20',
    lines: [{ account_id: bankFees.id, debit: 50 }, { account_id: bank.id, credit: 50 }],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-21',
    lines: [{ account_id: depExp, debit: 50 }, { account_id: fixed.id, credit: 50 }],
  }).db;
  // 7) Other income received in bank: +100
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-05-25',
    lines: [{ account_id: bank.id, debit: 100 }, { account_id: otherInc.id, credit: 100 }],
  }).db;

  // Period 2 (2026-06-01 .. 2026-06-30, 30 days) for comparison tests
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-06-10',
    lines: [{ account_id: bank.id, debit: 3000 }, { account_id: sales.id, credit: 3000 }],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: '2026-06-15',
    lines: [{ account_id: cogs.id, debit: 1200 }, { account_id: bank.id, credit: 1200 }],
  }).db;

  return db;
}

test('ex1 model: computes all five Odoo 20 Executive Summary sections and 19 lines with exact period vs to-date scope', () => {
  const db = seededExecutiveLedger();
  const s = executiveSummary(db, { from: '2026-05-01', to: '2026-05-31', company_id: 1 });

  // Section order and exact line labels match Odoo 20 Executive Summary
  assert.deepEqual(
    s.sections.map((sec) => [sec.title, sec.rows.map((r) => r.label)]),
    [
      ['Cash', ['Cash received', 'Cash spent', 'Cash surplus', 'Closing bank balance']],
      ['Profitability', ['Revenue', 'Cost of Revenue', 'Gross profit', 'Expenses', 'Net Profit']],
      ['Balance Sheet', ['Receivables', 'Payables', 'Net assets']],
      [
        'Performance',
        [
          'Gross profit margin (gross profit / operating income)',
          'Net profit margin (net profit / revenue)',
          'Return on investments (net profit / assets)',
        ],
      ],
      ['Position', ['Average debtors days', 'Average creditors days', 'Short term cash forecast', 'Current assets to liabilities']],
    ],
  );

  // Cash (asset_cash + liability_credit_card):
  // CR = 1500 (bank) + 150 (card debit) + 100 (bank) = 1750
  // CS = -700 (bank) - 200 (card credit) - 150 (bank) - 50 (bank) = -1100
  // Cash surplus = 1750 + (-1100) = 650
  // Closing bank balance (to 2026-05-31) = bank 10700 + card (-250) = 10450
  assert.equal(s.cashReceived, 1750);
  assert.equal(s.cashSpent, -1100);
  assert.equal(s.cashSurplus, 650);
  assert.equal(s.closingBankBalance, 10450);

  // Profitability (from P&L):
  // REV = 2000; COS = 600; GRP = 1400; EXP (operating: rent 200 + dep 50, excluding otherExpense 50) = 250;
  // NEP = 1400 + 100 - 250 - 50 = 1200
  assert.equal(s.revenue, 2000);
  assert.equal(s.costOfRevenue, 600);
  assert.equal(s.grossProfit, 1400);
  assert.equal(s.expenses, 250);
  assert.equal(s.netProfit, 1200);

  // Balance Sheet (to 2026-05-31):
  // DEB = 500; CRE = -300 (raw balance);
  // TA = bank 10700 + AR 500 + Stock 400 + Fixed 3950 = 15550
  // L = AP 300 + Card 250 + Non-current 2000 = 2550
  // Net assets = TA - L = 15550 - 2550 = 13000
  assert.equal(s.receivables, 500);
  assert.equal(s.payables, -300);
  assert.equal(s.netAssets, 13000);

  // Performance (unannualised):
  // Gross profit margin = 1400 / 2000 * 100 = 70
  // Net profit margin = 1200 / 2000 * 100 = 60
  // Return on investments = 1200 / 15550 * 100 = 7.72 (not annualised)
  assert.equal(s.grossProfitMargin, 70);
  assert.equal(s.netProfitMargin, 60);
  assert.equal(s.returnOnInvestments, 7.72);

  // Position (NDays = 31):
  // Average debtors days = round((500 / 2000) * 31, 2) = 7.75
  // Average creditors days = round((-(-300) / (600 + 250)) * 31, 2) = 10.94
  // Short term cash forecast = DEB + CRE = 500 + (-300) = 200
  // Current assets to liabilities = (10700 + 500 + 400) / (300 + 250) = 11600 / 550
  assert.equal(s.averageDebtorsDays, 7.75);
  assert.equal(s.averageCreditorsDays, 10.94);
  assert.equal(s.shortTermCashForecast, 200);
  assert.ok(Math.abs(s.currentAssetsToLiabilities - 11600 / 550) < 1e-9);

  // Verify sections[*].rows[*].value matches every line above
  const rowMap = new Map(s.sections.flatMap((sec) => sec.rows.map((r) => [r.label, r.value])));
  assert.deepEqual(Object.fromEntries(rowMap), {
    'Cash received': 1750,
    'Cash spent': -1100,
    'Cash surplus': 650,
    'Closing bank balance': 10450,
    Revenue: 2000,
    'Cost of Revenue': 600,
    'Gross profit': 1400,
    Expenses: 250,
    'Net Profit': 1200,
    Receivables: 500,
    Payables: -300,
    'Net assets': 13000,
    'Gross profit margin (gross profit / operating income)': 70,
    'Net profit margin (net profit / revenue)': 60,
    'Return on investments (net profit / assets)': 7.72,
    'Average debtors days': 7.75,
    'Average creditors days': 10.94,
    'Short term cash forecast': 200,
    'Current assets to liabilities': s.currentAssetsToLiabilities,
  });
});

test('ex1 model: ROI is not annualised, works when open-ended, and creditors days use COS + EXP only', () => {
  const db = seededExecutiveLedger();
  // 90-day window (2026-04-02 .. 2026-06-30): NEP = 1200 + 1800 = 3000, TA = 17350
  // ROI = round(3000 / 17350 * 100) = 17.29 (not annualised by 365/90)
  // Creditors days = round((300 / (1800 + 250)) * 90, 2) = 13.17
  const qtr = executiveSummary(db, { from: '2026-04-02', to: '2026-06-30', company_id: 1 });
  assert.equal(qtr.netProfit, 3000);
  assert.equal(qtr.costOfRevenue, 1800);
  assert.equal(qtr.expenses, 250);
  assert.equal(qtr.payables, -300);
  assert.equal(qtr.returnOnInvestments, 17.29);
  assert.equal(qtr.averageCreditorsDays, 13.17);

  // Open-ended periods still compute non-annualised ROI = NEP / TA * 100
  const toOnly = executiveSummary(db, { to: '2026-05-31', company_id: 1 });
  assert.equal(toOnly.returnOnInvestments, 7.72);

  // Bills booked only to operating Expenses (COS = 0, EXP = 500) give non-zero Average creditors days
  let expOnlyDb = seed();
  expOnlyDb = { ...expOnlyDb, records: { ...expOnlyDb.records, 'account.move': [], 'account.payment': [] } };
  const acc = (code) => search(expOnlyDb, 'account.account').find((a) => a.code === code);
  expOnlyDb = postEntry(expOnlyDb, {
    journal: 'MISC', company: 1, date: '2026-07-10',
    lines: [{ account_id: acc('630000').id, debit: 500 }, { account_id: acc('211000').id, credit: 500 }],
  }).db;
  const expSummary = executiveSummary(expOnlyDb, { from: '2026-07-01', to: '2026-07-31', company_id: 1 });
  assert.equal(expSummary.costOfRevenue, 0);
  assert.equal(expSummary.expenses, 500);
  assert.equal(expSummary.payables, -500);
  assert.equal(expSummary.averageCreditorsDays, 31);

  // Bills booked only to expense_other (COS = 0, EXP = 0) yield 0 for Average creditors days (zero denominator)
  let otherOnlyDb = seed();
  otherOnlyDb = { ...otherOnlyDb, records: { ...otherOnlyDb.records, 'account.move': [], 'account.payment': [] } };
  const accOther = (code) => search(otherOnlyDb, 'account.account').find((a) => a.code === code);
  otherOnlyDb = postEntry(otherOnlyDb, {
    journal: 'MISC', company: 1, date: '2026-07-10',
    lines: [{ account_id: accOther('690000').id, debit: 500 }, { account_id: accOther('211000').id, credit: 500 }],
  }).db;
  const otherSummary = executiveSummary(otherOnlyDb, { from: '2026-07-01', to: '2026-07-31', company_id: 1 });
  assert.equal(otherSummary.costOfRevenue, 0);
  assert.equal(otherSummary.expenses, 0);
  assert.equal(otherSummary.payables, -500);
  assert.equal(otherSummary.averageCreditorsDays, 0);
});

test('ex1 model: zero-division cases and empty period return 0 across Performance and Position (ignore_zero_division)', () => {
  const db = seededExecutiveLedger();
  const empty = executiveSummary(db, { from: '2025-01-01', to: '2025-01-31', company_id: 1 });
  assert.equal(empty.cashReceived, 0);
  assert.equal(empty.cashSpent, 0);
  assert.equal(empty.cashSurplus, 0);
  assert.equal(empty.closingBankBalance, 0);
  assert.equal(empty.revenue, 0);
  assert.equal(empty.costOfRevenue, 0);
  assert.equal(empty.grossProfit, 0);
  assert.equal(empty.expenses, 0);
  assert.equal(empty.netProfit, 0);
  assert.equal(empty.receivables, 0);
  assert.equal(empty.payables, 0);
  assert.equal(empty.netAssets, 0);
  assert.equal(empty.grossProfitMargin, 0);
  assert.equal(empty.netProfitMargin, 0);
  assert.equal(empty.returnOnInvestments, 0);
  assert.equal(empty.averageDebtorsDays, 0);
  assert.equal(empty.averageCreditorsDays, 0);
  assert.equal(empty.shortTermCashForecast, 0);
  assert.equal(empty.currentAssetsToLiabilities, 0);

  // Non-zero numerators with zero denominators (REV = 0, CL = 0, COS + EXP = 0) still return 0
  let zeroDenomDb = seed();
  zeroDenomDb = { ...zeroDenomDb, records: { ...zeroDenomDb.records, 'account.move': [], 'account.payment': [] } };
  const acc = (code) => search(zeroDenomDb, 'account.account').find((a) => a.code === code);
  zeroDenomDb = postEntry(zeroDenomDb, {
    journal: 'MISC', company: 1, date: '2026-08-05',
    lines: [{ account_id: acc('101401').id, debit: 1000 }, { account_id: acc('301000').id, credit: 1000 }],
  }).db;
  zeroDenomDb = postEntry(zeroDenomDb, {
    journal: 'MISC', company: 1, date: '2026-08-10',
    lines: [{ account_id: acc('121000').id, debit: 400 }, { account_id: acc('450000').id, credit: 400 }],
  }).db;
  const zeroDenom = executiveSummary(zeroDenomDb, { from: '2026-08-01', to: '2026-08-31', company_id: 1 });
  assert.equal(zeroDenom.revenue, 0);
  assert.equal(zeroDenom.receivables, 400);
  assert.equal(zeroDenom.grossProfitMargin, 0);
  assert.equal(zeroDenom.netProfitMargin, 0);
  assert.equal(zeroDenom.averageDebtorsDays, 0);
  assert.equal(zeroDenom.averageCreditorsDays, 0);
  assert.equal(zeroDenom.currentAssetsToLiabilities, 0);
  assert.equal(zeroDenom.returnOnInvestments, 28.57); // 400 / 1400 * 100
});

test('ex1 view & comparison: ExecutiveSummary renders all 5 sections in order and executiveColumns compares May vs Jun', async () => {
  const db = seededExecutiveLedger();
  const periods = [
    { from: '2026-05-01', to: '2026-05-31', label: 'May 2026' },
    { from: '2026-06-01', to: '2026-06-30', label: 'Jun 2026' },
  ];
  const cols = executiveColumns(db, periods, { company_id: 1 });
  assert.deepEqual(cols.headers, ['May 2026', 'Jun 2026']);
  assert.deepEqual(cols.totals.find((t) => t.label === 'Revenue').values, [2000, 3000]);
  assert.deepEqual(cols.totals.find((t) => t.label === 'Gross Profit').values, [1400, 1800]);
  assert.deepEqual(cols.totals.find((t) => t.label === 'Net Profit').values, [1200, 1800]);
  assert.deepEqual(cols.totals.find((t) => t.label === 'Cash').values, [10450, 12250]);
  assert.deepEqual(cols.totals.find((t) => t.label === 'Payables').values, [-300, -300]);

  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ExecutiveSummary } = await import('./views/FinanceReports.jsx');
  const host = makeEl('table');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(ExecutiveSummary, {
        db,
        period: { from: '2026-05-01', to: '2026-05-31' },
        companyId: '1',
      }));
    });
    const rows = findAll(host, (n) => n.tagName === 'TR');
    const labels = rows.map((tr) => textOf(tr.childNodes[0]));
    assert.deepEqual(labels, [
      'Cash',
      'Cash received', 'Cash spent', 'Cash surplus', 'Closing bank balance',
      'Profitability',
      'Revenue', 'Cost of Revenue', 'Gross profit', 'Expenses', 'Net Profit',
      'Balance Sheet',
      'Receivables', 'Payables', 'Net assets',
      'Performance',
      'Gross profit margin (gross profit / operating income)',
      'Net profit margin (net profit / revenue)',
      'Return on investments (net profit / assets)',
      'Position',
      'Average debtors days', 'Average creditors days', 'Short term cash forecast', 'Current assets to liabilities',
    ]);
    const text = textOf(host);
    assert.match(text, /\$1,750\.00/);
    assert.match(text, /-\$1,100\.00/);
    assert.match(text, /\$10,450\.00/);
    assert.match(text, /-\$300\.00/);
    assert.match(text, /\$13,000\.00/);
    assert.match(text, /70%/);
    assert.match(text, /60%/);
    assert.match(text, /7\.72%/);
    assert.match(text, /7\.75/);
    assert.match(text, /10\.94/);
    assert.match(text, /21\.09/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('ex1 i18n: all Odoo 20 Executive Summary section and line labels translate into formal Arabic', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?ex1-ar=1`);
    const keys = [
      'Cash', 'Cash received', 'Cash spent', 'Cash surplus', 'Closing bank balance',
      'Profitability', 'Revenue', 'Cost of Revenue', 'Gross profit', 'Expenses', 'Net Profit',
      'Balance Sheet', 'Receivables', 'Payables', 'Net assets',
      'Performance',
      'Gross profit margin (gross profit / operating income)',
      'Net profit margin (net profit / revenue)',
      'Return on investments (net profit / assets)',
      'Position', 'Average debtors days', 'Average creditors days', 'Short term cash forecast', 'Current assets to liabilities',
    ];
    for (const key of keys) {
      const translated = t(key);
      assert.notEqual(translated, key, `Expected Arabic translation for "${key}"`);
      assert.match(translated, /[\u0600-\u06FF]/, `Expected Arabic script for "${key}", got "${translated}"`);
    }
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});
