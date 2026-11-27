import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { payMove, postMove } from './models/accounting.js';
import { accountId, journalItems, postEntry } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';
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
    invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 500, tax: 14, ...defaultTaxRepartitionLines(accountId(db, '251000')) }], // 1000 + 14% VAT = 1140
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
  assert.deepEqual(tb.rows.map((r) => r.account.code), ['101401', '101404', '101501', '110100', '110200', '121000', '131000', '151000', '211000', '251000', '301000', '400000']);
  assert.ok(tb.rows.every((r) => r.initial || r.debit || r.credit || r.end)); // all-zero rows are omitted
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '101401')), { initial: 0, debit: 210146, credit: 26812.5, end: 183333.5 });
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '121000')), { initial: 0, debit: 10716, credit: 8936, end: 1780 });
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '400000')), { initial: 0, debit: 0, credit: 9400, end: -9400 });
  assert.deepEqual(trialBalance(db, { from: '2000-01-01', to: '2000-12-31' }), { rows: [], totals: { initial: 0, debit: 0, credit: 0, end: 0 } });
});

test('trial balance carries activity from before the period into the opening column', () => {
  const { db } = books();
  const tb = trialBalance(db, recent);
  assert.equal(tb.totals.initial, 0); // the books were balanced before `from` too
  assert.equal(tb.totals.end, 0);
  assert.deepEqual(pick(tb.rows.find((r) => r.account.code === '101401')), { initial: 150500, debit: 59646, credit: 26812.5, end: 183333.5 });
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

test('partner ledger lines show due date, label and the reconciliation matching number', async () => {
  const { reconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Ledger Detail Partner' }); db = partner.db;
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: '2026-03-01', invoice_date_due: '2026-04-01',
    invoice_line_ids: [{ qty: 1, price_unit: 500, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const receivable = read(db, 'res.company', 1).account_default_receivable_id ?? accountId(db, '121000', 1);
  const misc = search(db, 'account.journal').find((j) => j.type === 'general' && (j.company_id ?? 1) === 1);
  const settlement = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'Settlement',
    lines: [{ account_id: receivable, partner_id: partner.id, credit: 500, name: 'Manual receipt' }, { account_id: accountId(db, '400000', 1), debit: 500 }],
  });
  db = settlement.db;
  const selection = (moveId) => {
    const items = journalItems(db).filter((l) => l.move_id === moveId && l.account_id === receivable);
    assert.equal(items.length, 1);
    return { move_id: moveId, line_identity: items[0].line_identity };
  };
  const next = reconcileLedgerItems(db, [selection(inv.id), selection(settlement.id)], { date: '2026-03-02' });
  db = applyDiff(db, diffDb(db, next), { isAdmin: true });
  const row = partnerLedger(db, { from: '2026-03-01', to: '2026-03-31' }).find((r) => r.partner_id === partner.id);
  const invoiceLine = row.lines.find((l) => l.move_id === inv.id);
  const receiptLine = row.lines.find((l) => l.move_id === settlement.id);
  assert.equal(invoiceLine.dueDate, '2026-04-01'); // journal item date_maturity
  assert.equal(invoiceLine.label, read(db, 'account.move', inv.id).name);
  assert.ok(invoiceLine.matchingNumber, 'reconciled lines carry the GL matching number');
  assert.equal(receiptLine.matchingNumber, invoiceLine.matchingNumber);
  assert.equal(receiptLine.ref, 'Settlement');
});

test('partner ledger unreconciled-only keeps open lines in the period and the opening, dropping reconciled ones', () => {
  const { db } = books();
  const idOf = (name) => search(db, 'res.partner').find((p) => p.name === name).id;
  const gulf = idOf('Gulf Interiors');
  const omar = idOf('Omar Khaled');
  const sara = idOf('Sara Hassan');
  const filtered = partnerLedger(db, { ...whole, unreconciledOnly: true });
  assert.deepEqual(filtered.map((r) => r.partner_id), [omar, sara]);
  assert.deepEqual(filtered.find((r) => r.partner_id === omar).lines.map((l) => [l.debit, l.credit]), [[1140, 0]]);
  assert.deepEqual(filtered.find((r) => r.partner_id === sara).lines.map((l) => [l.debit, l.credit]), [[1710, 0]]);
  const opening = partnerLedger(db, { ...recent, unreconciledOnly: true });
  assert.equal(opening.find((r) => r.partner_id === sara).initial, 1710); // open item, not the net 1210
  assert.equal(opening.find((r) => r.partner_id === gulf), undefined); // fully reconciled before the period
});

test('partner ledger filters by one or more partners', () => {
  const { db } = books();
  const all = partnerLedger(db, whole).map((r) => r.partner_id);
  const [first, second] = all;
  assert.deepEqual(partnerLedger(db, { ...whole, partnerIds: [first] }).map((r) => r.partner_id), [first]);
  assert.deepEqual(partnerLedger(db, { ...whole, partnerIds: [String(first)] }).map((r) => r.partner_id), [first]);
  assert.deepEqual(partnerLedger(db, { ...whole, partnerIds: [first, second] }).map((r) => r.partner_id), [first, second]);
  assert.deepEqual(partnerLedger(db, { ...whole, partnerIds: [] }).map((r) => r.partner_id), all);
});

test('partner ledger uses only the requested company journal items', () => {
  const db = seed();
  const receivable = db.records['account.account'].find((a) => a.account_type === 'asset_receivable');
  const partner = db.records['res.partner'][0];
  const move = (id, company_id, amount) => ({
    id, company_id, state: 'posted', move_type: 'out_invoice', date: '2026-01-10', invoice_date: '2026-01-10',
    invoice_date_due: '2026-02-10', partner_id: partner.id, line_ids: [{ account_id: receivable.id, partner_id: partner.id, debit: amount, credit: 0 }],
  });
  const fixture = {
    ...db,
    records: {
      ...db.records,
      'res.company': [...db.records['res.company'], { id: 9999, name: 'Second', currency_id: db.records['res.company'][0].currency_id }],
      'account.move': [...db.records['account.move'], move(9001, 1, 100), move(9002, 9999, 250)],
    },
  };
  const period = { from: '2026-01-01', to: '2026-01-31' };
  const moveIdsFor = (company_id) => partnerLedger(fixture, { ...period, company_id })
    .find((r) => r.partner_id === partner.id).lines.map((l) => l.move_id).filter((id) => [9001, 9002].includes(id));
  assert.deepEqual(moveIdsFor(1), [9001]);
  assert.deepEqual(moveIdsFor(9999), [9002]);
});

test('cash flow splits every cash movement into operating, investing and financing', () => {
  const { db } = books();
  const cf = cashFlow(db, whole);
  assert.deepEqual([cf.opening, cf.closing, cf.net], [0, 188333.5, 188333.5]);
  assert.deepEqual([cf.operating, cf.investing, cf.financing], [8333.5, -25000, 205000]); // payments; van; opening entry + capital
  assert.equal(cf.net, cf.operating + cf.investing + cf.financing);
  assert.deepEqual(cf.lines.map((l) => [l.section, l.account.code, l.amount]), [
    ['operating', '101404', -602.5],
    ['operating', '251000', 1097.4],
    ['operating', '400000', 7838.6],
    ['investing', '151000', -25000],
    ['financing', '301000', 205000],
  ]);
  const week = cashFlow(db, recent);
  assert.deepEqual([week.opening, week.closing, week.net], [155500, 188333.5, 32833.5]);
  assert.deepEqual([week.operating, week.investing, week.financing], [7833.5, -25000, 50000]);
  assert.equal(week.net, week.operating + week.investing + week.financing);
});

test('cash flow follows account activity tags and leaves untagged accounts unclassified', () => {
  let db = seed();
  const asset = accountId(db, '151000');
  const financing = search(db, 'account.account.tag').find((tag) => tag.name === 'Financing Activities');
  const period = { from: '2040-01-01', to: '2040-01-01' };
  db = postEntry(db, { journal: 'MISC', date: period.from, lines: [{ account: '151000', debit: 100 }, { account: '101401', credit: 100 }] }).db;
  const sections = () => { const flow = cashFlow(db, period); return [flow.operating, flow.investing, flow.financing]; };
  assert.deepEqual(sections(), [0, -100, 0]);
  db = write(db, 'account.account', asset, { tag_ids: [financing.id] });
  assert.deepEqual(sections(), [0, 0, -100]);
  db = write(db, 'account.account', asset, { tag_ids: [] });
  assert.deepEqual(sections(), [0, 0, 0]);
  assert.equal(cashFlow(db, period).unclassified, -100);
});

test('executive summary reports margins, liquidity and days sales outstanding', () => {
  const { db } = books();
  const s = executiveSummary(db, whole);
  assert.deepEqual([s.revenue, s.grossProfit, s.netProfit], [9400, 9400, 9400]); // purchases are stock, not expense
  assert.deepEqual([s.cash, s.receivables, s.payables], [188333.5, 1780, 9234]);
  assert.equal(s.grossMargin, 100);
  assert.equal(s.netMargin, 100);
  assert.equal(s.dso, 138); // 1780 / 9400 × 731 days
  assert.ok(s.currentRatio > 21.58 && s.currentRatio < 21.59); // (1780 + 188936 + 1134 + 35852 stock, opening stock included) / (9234 + 1316)
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

test('partner ledger: a manual receivable entry without a due date shows its entry date', () => {
  const db = seed();
  const receivable = db.records['account.account'].find((a) => a.account_type === 'asset_receivable');
  const income = db.records['account.account'].find((a) => a.account_type === 'income');
  const partner = db.records['res.partner'][0];
  const fixture = { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'], {
    id: 9101, company_id: 1, state: 'posted', move_type: 'entry', date: '2026-01-15', partner_id: partner.id,
    line_ids: [{ account_id: receivable.id, partner_id: partner.id, debit: 80, credit: 0 }, { account_id: income.id, debit: 0, credit: 80 }],
  }] } };
  const line = partnerLedger(fixture, { from: '2026-01-01', to: '2026-01-31', company_id: 1 })
    .find((r) => r.partner_id === partner.id).lines.find((l) => l.move_id === 9101);
  assert.equal(line.dueDate, '2026-01-15');
});
