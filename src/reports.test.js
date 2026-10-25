import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { payMove, postMove } from './models/accounting.js';
import { postEntry } from './models/ledger.js';
import { cashFlow, customerStatement, executiveSummary, partnerLedger, trialBalance } from './models/reports.js';

// Wide enough to hold every posted entry (the seed's opening entry, invoices, payments and bill, plus the
// additions below), so it works as a whole-books period with no opening balances.
const whole = { from: addDays(today(), -365), to: addDays(today(), 365) };
// Starts after the seed's older history (opening entry, both invoices at -18/-45 days, the bill and the
// first payment at -10 days), pushing all of it into the opening column.
const recent = { from: addDays(today(), -7), to: addDays(today(), 7) };

/** Seeded books plus a capital injection, a fixed-asset purchase and one partly paid invoice for Omar Khaled. */
function books() {
  let db = seed();
  db = postEntry(db, {
    journal: 'MISC', date: addDays(today(), -5), ref: 'Capital injection',
    lines: [{ account: '101401', debit: 50000 }, { account: '301000', credit: 50000 }],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', date: addDays(today(), -4), ref: 'Delivery van',
    lines: [{ account: '151000', debit: 25000 }, { account: '101401', credit: 25000 }],
  }).db;
  const { db: withInvoice, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 5, invoice_date: addDays(today(), -3),
    invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 500, tax: 14 }], // 1000 + 14% VAT = 1140
  });
  db = postMove(withInvoice, id);
  db = payMove(db, id, 570, addDays(today(), -1));
  return { db, id };
}

const pick = (r) => ({ initial: r.initial, debit: r.debit, credit: r.credit, end: r.end });

test('trial balance lists per-account opening, movement and end, and the books balance to zero', () => {
  const { db } = books();
  const tb = trialBalance(db, whole);
  assert.equal(tb.totals.initial, 0);
  assert.equal(tb.totals.debit, tb.totals.credit);
  assert.equal(tb.totals.end, 0);
  assert.deepEqual(tb.rows.map((r) => r.account.code), ['101401', '101501', '121000', '131000', '151000', '211000', '251000', '301000', '400000', '600000']);
  assert.ok(tb.rows.every((r) => r.initial || r.debit || r.credit || r.end)); // all-zero rows are omitted
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '101401')), { initial: 0, debit: 208936, credit: 25000, end: 183936 });
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '121000')), { initial: 0, debit: 10716, credit: 8936, end: 1780 });
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '400000')), { initial: 0, debit: 0, credit: 9400, end: -9400 });
  assert.deepEqual(trialBalance(db, { from: '2000-01-01', to: '2000-12-31' }), { rows: [], totals: { initial: 0, debit: 0, credit: 0, end: 0 } });
});

test('trial balance carries activity from before the period into the opening column', () => {
  const { db } = books();
  const tb = trialBalance(db, recent);
  assert.equal(tb.totals.initial, 0); // the books were balanced before `from` too
  assert.equal(tb.totals.end, 0);
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '101401')), { initial: 150500, debit: 58436, credit: 25000, end: 183936 });
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '121000')), { initial: 9076, debit: 1140, credit: 8436, end: 1780 });
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '101501')), { initial: 5000, debit: 0, credit: 0, end: 5000 }); // only ever touched before `from`
});

test('partner ledger runs a receivable balance per partner, sorted by name', () => {
  const { db } = books();
  const rows = partnerLedger(db, whole);
  assert.deepEqual(rows.map((r) => read(db, 'res.partner', r.partner_id).name), ['Gulf Interiors', 'Omar Khaled', 'Sara Hassan']);
  const [gulf, omar, sara] = rows;
  assert.deepEqual(pick(gulf), { initial: 0, debit: 7866, credit: 7866, end: 0 }); // invoiced and paid in full
  assert.deepEqual(gulf.lines.map((l) => [l.debit, l.credit, l.balance]), [[7866, 0, 7866], [0, 7866, 0]]);
  assert.deepEqual(pick(omar), { initial: 0, debit: 1140, credit: 570, end: 570 });
  assert.deepEqual(omar.lines.map((l) => [l.debit, l.credit, l.balance]), [[1140, 0, 1140], [0, 570, 570]]);
  assert.deepEqual(pick(sara), { initial: 0, debit: 1710, credit: 500, end: 1210 }); // the seed's partly paid invoice
});

test('partner ledger: payable side and opening balances carried across the period start', () => {
  const { db } = books();
  assert.deepEqual(partnerLedger(db, whole, 'payable').map(pick), [{ initial: 0, debit: 0, credit: 9234, end: -9234 }]);
  const rows = partnerLedger(db, recent);
  const sara = rows.find((r) => r.partner_id === 3);
  assert.deepEqual(sara, { partner_id: 3, initial: 1210, debit: 0, credit: 0, end: 1210, lines: [] });
  const gulf = rows.find((r) => r.partner_id === 4);
  assert.deepEqual(pick(gulf), { initial: 7866, debit: 0, credit: 7866, end: 0 });
  assert.deepEqual(gulf.lines.map((l) => [l.debit, l.credit, l.balance]), [[0, 7866, 0]]);
});

test('cash flow splits every cash movement into operating, investing and financing', () => {
  const { db } = books();
  const cf = cashFlow(db, whole);
  assert.deepEqual([cf.opening, cf.closing, cf.net], [0, 188936, 188936]);
  assert.deepEqual([cf.operating, cf.investing, cf.financing], [8936, -25000, 205000]); // payments; van; opening entry + capital
  assert.equal(cf.net, cf.operating + cf.investing + cf.financing);
  assert.deepEqual(cf.lines.map((l) => [l.section, l.account.code, l.amount]), [
    ['operating', '121000', 8936],
    ['investing', '151000', -25000],
    ['financing', '301000', 205000],
  ]);
  const week = cashFlow(db, recent);
  assert.deepEqual([week.opening, week.closing, week.net], [155500, 188936, 33436]);
  assert.deepEqual([week.operating, week.investing, week.financing], [8436, -25000, 50000]);
  assert.equal(week.net, week.operating + week.investing + week.financing);
});

test('executive summary reports margins, liquidity and days sales outstanding', () => {
  const { db } = books();
  const s = executiveSummary(db, whole);
  assert.deepEqual([s.revenue, s.grossProfit, s.netProfit], [9400, 9400, 1300]);
  assert.deepEqual([s.cash, s.receivables, s.payables], [188936, 1780, 9234]);
  assert.equal(s.grossMargin, 100);
  assert.equal(s.netMargin, 13.83);
  assert.equal(s.dso, 138); // 1780 / 9400 × 731 days
  assert.ok(s.currentRatio > 18.18 && s.currentRatio < 18.19); // (1780 + 188936 + 1134) / (9234 + 1316)
  const none = executiveSummary(db, { from: '2000-01-01', to: '2000-12-31' });
  assert.deepEqual([none.revenue, none.cash, none.receivables, none.payables], [0, 0, 0, 0]);
  assert.deepEqual([none.currentRatio, none.grossMargin, none.netMargin, none.dso], [null, null, null, null]);
});

test('customer statement runs one partner receivable with the payment reference', () => {
  const { db, id } = books();
  const statement = customerStatement(db, 5, whole);
  const invName = read(db, 'account.move', id).name;
  assert.equal(statement.opening, 0);
  assert.deepEqual(statement.lines.map((l) => [l.date, l.debit, l.credit, l.balance]), [
    [addDays(today(), -3), 1140, 0, 1140],
    [addDays(today(), -1), 0, 570, 570],
  ]);
  assert.equal(statement.lines[0].move_name, invName);
  assert.equal(statement.lines[0].ref, undefined); // the invoice carries no reference
  assert.ok(statement.lines[1].move_name.startsWith('BNK1/'));
  assert.equal(statement.lines[1].ref, `Payment ${invName}`);
  assert.equal(statement.closing, 570);
  assert.deepEqual(customerStatement(db, 3, recent), { opening: 1210, lines: [], closing: 1210 }); // balance carried, no movement
  assert.deepEqual(customerStatement(db, 1, whole), { opening: 0, lines: [], closing: 0 }); // partner without receivable
});
