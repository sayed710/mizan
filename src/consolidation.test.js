import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, setActiveCompany, unlink, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { createCompany, ensureMainCompany } from './models/company.js';
import { postEntry } from './models/ledger.js';
import { closePeriod, consolidate, consolidatePeriod, consolidationModels, periodRates } from './models/consolidation.js';

const previous = Object.fromEntries(Object.keys(consolidationModels).map((key) => [key, models[key]]));
Object.assign(models, consolidationModels);
after(() => {
  setActiveCompany(null);
  for (const [key, model] of Object.entries(previous)) {
    if (model) models[key] = model;
    else delete models[key];
  }
});

function fixture({ method = 'full', ownership = 100 } = {}) {
  let db = ensureMainCompany(seed());
  const group = create(db, 'res.currency', { name: 'GROUP', rate_ids: [{ date: '2089-12-31', rate: 1 }] });
  const source = create(group.db, 'res.currency', { name: 'SOURCE', rate_ids: [{ date: '2089-12-31', rate: 2 }, { date: '2090-01-02', rate: 4 }] });
  db = createCompany(source.db, { name: 'Parent', currency_id: group.id }).db;
  const parent = search(db, 'res.company').at(-1).id;
  const subsidiary = createCompany(db, { name: 'Subsidiary', currency_id: source.id });
  const child = subsidiary.id;
  const chart = create(subsidiary.db, 'consolidation.chart', {
    name: 'Group', currency_id: group.id,
    company_ids: [{ company_id: parent, ownership: 20, method: 'full' }, { company_id: child, ownership, method }],
    account_ids: [
      { code: 'CASH', name: 'Cash', account_type: 'asset_cash', source_codes: '101401, 101501' },
      { code: 'AR', name: 'Receivables', account_type: 'asset_receivable', source_codes: '121000' },
      { code: 'AP', name: 'Payables', account_type: 'liability_payable', source_codes: '211000' },
      { code: 'SALES', name: 'Sales', account_type: 'income', source_codes: '400000' },
      { code: 'COST', name: 'Expenses', account_type: 'expense', source_codes: '600000' },
    ],
  });
  const period = create(chart.db, 'consolidation.period', { name: 'January', chart_id: chart.id, date_from: '2090-01-01', date_to: '2090-01-02' });
  return { db: period.db, id: period.id, chart: chart.id, parent, child, source: source.id };
}

function entry(db, company_id, date, lines) {
  const posted = postEntry(db, { journal: 'MISC', date, lines });
  return write(posted.db, 'account.move', posted.id, { company_id });
}

const row = (result, code) => result.lines.find((line) => line.group_code === code);
const sale = (amount) => [{ account: '101401', debit: amount }, { account: '400000', credit: amount }];

test('company translation uses cumulative balance sheets, period P&L, daily average and closing rates without mutation', () => {
  const f = fixture();
  let db = entry(f.db, f.child, '2089-12-31', sale(80));
  db = entry(db, f.child, '2090-01-01', sale(80));
  db = entry(db, f.parent, '2090-01-02', sale(20));
  db = entry(db, f.child, '2090-01-03', sale(900));
  db = entry(db, 1, '2090-01-01', sale(900));
  const draft = create(db, 'account.move', { company_id: f.child, move_type: 'entry', state: 'draft', invoice_date: '2090-01-01', line_ids: [{ account_id: 1, debit: 500 }] });
  db = draft.db;
  const before = structuredClone(db);
  setActiveCompany(f.parent);
  const result = consolidate(db, f.id);
  setActiveCompany(null);
  assert.equal(row(result, 'CASH').by_company[f.child], 40);
  assert.equal(row(result, 'SALES').by_company[f.child], -30);
  assert.equal(row(result, 'CASH').by_company[f.parent], 20);
  assert.equal(row(result, 'SALES').total, -50);
  assert.deepEqual(result.unmapped, []);
  assert.deepEqual(db, before);
  assert.deepEqual(periodRates(db, read(db, 'consolidation.period', f.id)).find((r) => r.company_id === f.child), { company_id: f.child, rate_avg: 0.375, rate_closing: 0.25 });
});

test('proportional consolidation applies 60% ownership while full consolidation ignores ownership', () => {
  const f = fixture({ method: 'proportional', ownership: 60 });
  const db = entry(entry(f.db, f.child, '2090-01-01', sale(100)), f.parent, '2090-01-01', sale(100));
  const result = consolidate(db, f.id);
  assert.equal(row(result, 'CASH').by_company[f.child], 15);
  assert.equal(row(result, 'SALES').by_company[f.child], -22.5);
  assert.equal(row(result, 'CASH').by_company[f.parent], 100);
});

test('equity companies contribute only their share of translated net assets as an investment', () => {
  const f = fixture({ method: 'equity', ownership: 60 });
  let db = entry(f.db, f.child, '2090-01-01', [{ account: '101401', debit: 200 }, { account: '301000', credit: 200 }]);
  db = entry(db, f.child, '2090-01-02', [{ account: '600000', debit: 40 }, { account: '211000', credit: 40 }]);
  const result = consolidate(db, f.id);
  assert.equal(row(result, `EQUITY:${f.child}`).total, 24);
  assert.equal(row(result, 'CASH').by_company[f.child], undefined);
  assert.equal(row(result, 'COST').by_company[f.child], undefined);
  assert.deepEqual(result.unmapped, []);
});

test('inter-company sale and bill eliminate translated receivable, payable, revenue and expense only', () => {
  const f = fixture();
  const seller = read(f.db, 'res.company', f.parent).partner_id;
  const buyer = read(f.db, 'res.company', f.child).partner_id;
  let db = entry(f.db, f.parent, '2090-01-01', [
    { account: '121000', debit: 100, partner_id: buyer }, { account: '400000', credit: 100, partner_id: buyer },
  ]);
  db = entry(db, f.child, '2090-01-01', [
    { account: '600000', debit: 400, partner_id: seller }, { account: '211000', credit: 400, partner_id: seller },
  ]);
  db = entry(db, f.parent, '2090-01-01', sale(50));
  const result = consolidate(db, f.id);
  assert.deepEqual(['AR', 'AP', 'SALES', 'COST'].map((code) => row(result, code).eliminations), [-100, 100, 100, -150]);
  assert.deepEqual(['AR', 'AP', 'SALES', 'COST'].map((code) => row(result, code).total), [0, 0, -50, 0]);
  assert.equal(row(result, 'CASH').total, 50);
});

test('unmapped accounts are unique codes with nonzero per-company balances', () => {
  const f = fixture();
  let db = entry(f.db, f.parent, '2090-01-01', [{ account: '131000', debit: 20 }, { account: '301000', credit: 20 }]);
  db = entry(db, f.child, '2090-01-01', [{ account: '131000', debit: 40 }, { account: '301000', credit: 40 }]);
  assert.deepEqual(consolidate(db, f.id).unmapped, ['131000', '301000']);
});

test('draft button stores results and rates; closing recomputes and protects a detached stable snapshot', () => {
  const f = fixture();
  const db = entry(f.db, f.child, '2090-01-01', sale(80));
  const before = structuredClone(db);
  const buttons = consolidationModels['consolidation.period'].form.buttons;
  const draft = buttons[0].run(db, read(db, 'consolidation.period', f.id)).db;
  assert.equal(read(draft, 'consolidation.period', f.id).state, 'draft');
  assert.deepEqual(read(draft, 'consolidation.period', f.id).lines, consolidate(db, f.id).lines);
  assert.deepEqual(JSON.parse(read(draft, 'consolidation.period', f.id).display_lines[0].by_company), { [f.child]: 20 });
  const extra = entry(draft, f.child, '2090-01-02', sale(80));
  const closed = buttons[1].run(extra, read(extra, 'consolidation.period', f.id)).db;
  const expected = consolidate(extra, f.id);
  assert.deepEqual(consolidate(closed, f.id), expected);
  assert.equal(read(closed, 'consolidation.period', f.id).state, 'closed');
  assert.equal(row(expected, 'CASH').total, 40);
  assert.throws(() => closePeriod(closed, f.id), /already closed/);
  assert.throws(() => consolidatePeriod(closed, f.id), /already closed/);
  for (const vals of [{ state: 'draft' }, { lines: [] }, { date_to: '2090-01-03' }, { rate_ids: [] }]) assert.throws(() => write(closed, 'consolidation.period', f.id, vals), /cannot be changed or reopened/);
  assert.throws(() => unlink(closed, 'consolidation.period', [f.id]), /audit trail/);
  let changed = entry(closed, f.child, '2090-01-02', sale(100));
  changed = write(changed, 'res.currency', f.source, { rate_ids: [{ date: '2090-01-01', rate: 100 }] });
  changed = write(changed, 'consolidation.chart', f.chart, { account_ids: [] });
  assert.deepEqual(consolidate(changed, f.id), expected);
  const detached = consolidate(closed, f.id);
  detached.lines[0].by_company[f.child] = 999;
  assert.deepEqual(consolidate(closed, f.id), expected);
  assert.deepEqual(db, before);
});

test('overridden rates, date onchange, validation and seed remain usable', () => {
  const f = fixture();
  let db = entry(f.db, f.child, '2090-01-01', sale(100));
  db = write(db, 'consolidation.period', f.id, { rate_ids: [{ company_id: f.child, rate_avg: 2, rate_closing: 3 }] });
  assert.equal(row(consolidate(db, f.id), 'CASH').total, 300);
  assert.equal(row(consolidate(db, f.id), 'SALES').total, -200);
  const changed = write(db, 'consolidation.period', f.id, { date_from: '2090-01-02' });
  assert.equal(read(changed, 'consolidation.period', f.id).rate_ids.find((r) => r.company_id === f.child).rate_avg, 0.25);
  assert.throws(() => write(db, 'consolidation.period', f.id, { rate_ids: [{ company_id: f.child, rate_avg: 0, rate_closing: 1 }] }), /positive/);
  assert.throws(() => write(db, 'consolidation.period', f.id, { date_from: '2090-02-30' }), /date range/);
  assert.throws(() => write(db, 'consolidation.chart', f.chart, { company_ids: [{ company_id: f.child, ownership: 101 }] }), /Ownership/);
  assert.throws(() => write(db, 'consolidation.chart', f.chart, { account_ids: [
    { code: 'A', account_type: 'asset_cash', source_codes: '101401' }, { code: 'B', account_type: 'asset_cash', source_codes: '101401' },
  ] }), /only once/);
  assert.throws(() => consolidate(db, 99999), /not found/);
  assert.ok(search(seed(), 'account.move').length > 0);
});

const sumOf = (result) => Math.round(result.lines.reduce((s, l) => s + l.total, 0) * 100) / 100;
// Last year's sale, this period's sale and capital, booked on days with different rates.
const history = (f) => {
  let db = entry(f.db, f.child, '2089-12-31', sale(80));
  db = entry(db, f.child, '2090-01-01', [{ account: '101401', debit: 200 }, { account: '301000', credit: 200 }]);
  db = entry(db, f.child, '2090-01-02', sale(100));
  return entry(db, f.parent, '2090-01-01', sale(20));
};
const fullChart = (f) => {
  const chart = read(f.db, 'consolidation.chart', f.chart);
  return write(f.db, 'consolidation.chart', f.chart, { account_ids: [...chart.account_ids, { code: 'EQ', name: 'Capital', account_type: 'equity', source_codes: '301000' }] });
};

test('every method gives balances that add up to zero, with translation difference and prior results', () => {
  for (const [method, ownership] of [['full', 100], ['full', 60], ['proportional', 60], ['equity', 30]]) {
    const f = fixture({ method, ownership });
    const result = consolidate(history({ ...f, db: fullChart(f) }), f.id);
    assert.equal(sumOf(result), 0, `${method} ${ownership}%`);
    assert.deepEqual(result.unmapped, []);
  }
});

test('full consolidation below 100% gives the minority its share of equity and result', () => {
  const f = fixture({ method: 'full', ownership: 60 });
  const result = consolidate(history({ ...f, db: fullChart(f) }), f.id);
  const all = consolidate(history({ ...fixture(), db: fullChart(fixture()) }), f.id);
  // Assets and the P&L stay at 100%.
  assert.equal(row(result, 'CASH').by_company[f.child], row(all, 'CASH').by_company[f.child]);
  assert.equal(row(result, 'SALES').by_company[f.child], row(all, 'SALES').by_company[f.child]);
  const childEquity = ['EQ', 'EQUITY:RE', 'EQUITY:CTA'].reduce((s, code) => s + (row(all, code)?.by_company[f.child] ?? 0), 0);
  const childResult = row(all, 'SALES').by_company[f.child];
  assert.equal(row(result, 'EQUITY:NCI').by_company[f.child], Math.round(0.4 * (childEquity + childResult) * 100) / 100);
  assert.equal(row(result, 'EQUITY:NCI_RESULT').by_company[f.child], Math.round(-0.4 * childResult * 100) / 100);
});

test('the equity method books the investment against the share of result and reserves', () => {
  const f = fixture({ method: 'equity', ownership: 30 });
  const result = consolidate(history({ ...f, db: fullChart(f) }), f.id);
  const investment = row(result, `EQUITY:${f.child}`).total;
  assert.ok(investment > 0);
  assert.equal(Math.round((investment + row(result, `EQUITY:${f.child}:RESULT`).total + row(result, `EQUITY:${f.child}:RESERVE`).total) * 100) / 100, 0);
});

test('a period that does not add up or has unmapped accounts cannot be closed', () => {
  const f = fixture();
  const db = entry(f.db, f.child, '2090-01-01', [{ account: '101401', debit: 200 }, { account: '301000', credit: 200 }]);
  assert.throws(() => closePeriod(db, f.id), /Map these accounts before closing: 301000/);
});

test('cents lost to rounding of individual lines do not block closing a balanced period', () => {
  const f = fixture({ method: 'proportional', ownership: 60 });
  let db = entry(f.db, f.child, '2090-01-01', [{ account: '101401', debit: 0.07 }, { account: '600000', debit: 0.07 }, { account: '400000', credit: 0.14 }]);
  const closed = closePeriod(db, f.id);
  const lines = read(closed, 'consolidation.period', f.id).lines;
  assert.equal(Math.round(lines.reduce((s, l) => s + l.total, 0) * 100), 0);
});

test('a matched cross-currency inter-company pair closes; the rate difference is its own line', () => {
  const f = fixture();
  const seller = read(f.db, 'res.company', f.parent).partner_id;
  const buyer = read(f.db, 'res.company', f.child).partner_id;
  let db = entry(f.db, f.parent, '2090-01-01', [{ account: '121000', debit: 100, partner_id: buyer }, { account: '400000', credit: 100, partner_id: buyer }]);
  db = entry(db, f.child, '2090-01-01', [{ account: '600000', debit: 200, partner_id: seller }, { account: '211000', credit: 200, partner_id: seller }]);
  const closed = closePeriod(db, f.id);
  const lines = read(closed, 'consolidation.period', f.id).lines;
  assert.ok(lines.find((l) => l.group_code === 'EQUITY:ELIM_FX'));
  assert.equal(Math.round(lines.reduce((s, l) => s + l.total, 0) * 100), 0);
});

test('the minority keeps its share of a subsidiary result even when that result is an inter-company sale', () => {
  const f = fixture({ method: 'full', ownership: 60 });
  const parentPartner = read(f.db, 'res.company', f.parent).partner_id;
  const childPartner = read(f.db, 'res.company', f.child).partner_id;
  let db = entry(f.db, f.child, '2090-01-01', [{ account: '121000', debit: 200, partner_id: parentPartner }, { account: '400000', credit: 200, partner_id: parentPartner }]);
  db = entry(db, f.parent, '2090-01-01', [{ account: '600000', debit: 100, partner_id: childPartner }, { account: '211000', credit: 100, partner_id: childPartner }]);
  const lines = read(closePeriod(db, f.id), 'consolidation.period', f.id).lines;
  const own = lines.find((l) => l.group_code === 'SALES').by_company[f.child];
  assert.equal(lines.find((l) => l.group_code === 'EQUITY:NCI_RESULT').by_company[f.child], Math.round(-0.4 * own * 100) / 100);
});
