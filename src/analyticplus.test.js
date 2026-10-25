import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { moreModels } from './models/more.js';
import { analyticPlusModels, normalizeDistribution, distributionOfLine, analyticLinesForMove, postAnalytic, removeAnalytic, analyticBalance, budgetReport, checkMandatoryPlans } from './models/analyticplus.js';

const setup = () => {
  const first = create(seed(), 'account.analytic.account', { name: 'Consulting' });
  const second = create(first.db, 'account.analytic.account', { name: 'Support' });
  return { db: second.db, a: first.id, b: second.id };
};
const moveValues = (a, b, move_type = 'out_invoice') => ({
  name: 'Analytic test', move_type, state: 'posted', partner_id: 1, invoice_date: '2026-01-10',
  invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 100, discount: 10, tax: 14, analytic_distribution: { [a]: 60, [b]: 40 } }],
});
const runBudget = (db, id, label) => analyticPlusModels['account.budget'].form.buttons.find((b) => b.label === label).run(db, read(db, 'account.budget', id)).db;

test('analytic distributions are copied and reject invalid percentages, accounts and totals', () => {
  const original = Object.freeze({ 1: 60, 2: 40 });
  assert.deepEqual(normalizeDistribution(original), original);
  assert.notEqual(normalizeDistribution(original), original);
  assert.deepEqual(normalizeDistribution(null), {});
  for (const value of [-1, '60', null, NaN, Infinity, true]) assert.throws(() => normalizeDistribution({ 1: value }), /non-negative numbers/);
  for (const value of [[], 'invalid', 5]) assert.throws(() => normalizeDistribution(value), /must be an object/);
  assert.throws(() => normalizeDistribution({ 1: 61, 2: 40 }), /100%/);
  assert.throws(() => normalizeDistribution({ bad: 100 }), /valid analytic account/);
  assert.throws(() => normalizeDistribution({ 99999: 100 }, seed()), /not found/);
});

test('distribution totals are independent per plan, including legacy plan selections', () => {
  const { db, a, b } = setup();
  assert.throws(() => normalizeDistribution({ [a]: 100, [b]: 100 }, db), /100%/);
  const p = create(db, 'account.analytic.plan', { name: 'Departments' });
  const otherPlan = write(p.db, 'account.analytic.account', b, { plan_id: p.id });
  assert.deepEqual(normalizeDistribution({ [a]: 100, [b]: 100 }, otherPlan), { [a]: 100, [b]: 100 });
  assert.deepEqual(normalizeDistribution({ [a]: 100, [b]: 100 }, write(db, 'account.analytic.account', b, { plan: 'region' })), { [a]: 100, [b]: 100 });
});

test('legacy analytic allocation falls back to 100%, while explicit empty distribution wins', () => {
  assert.deepEqual(distributionOfLine({ analytic_account_id: 7 }), { 7: 100 });
  assert.deepEqual(distributionOfLine({}), {});
  assert.deepEqual(distributionOfLine({ analytic_account_id: 7, analytic_distribution: {} }), {});
  const { db, a } = setup();
  const move = { ...moveValues(a, a), invoice_line_ids: [{ qty: 1, price_unit: 80, analytic_account_id: a }] };
  assert.equal(analyticLinesForMove(db, move)[0].amount, 80);
});

test('invoices and bills allocate discounted untaxed amounts 60/40 with opposite signs and metadata', () => {
  const { db, a, b } = setup();
  const before = JSON.stringify(db);
  for (const [type, sign, category, code] of [['out_invoice', 1, 'invoice', '400000'], ['in_invoice', -1, 'vendor_bill', '600000']]) {
    const move = { ...moveValues(a, b, type), id: 999 };
    const lines = analyticLinesForMove(db, move);
    assert.deepEqual(lines.map((l) => [l.account_id, l.amount]), [[a, 108 * sign], [b, 72 * sign]]);
    for (const line of lines) {
      assert.equal(line.category, category);
      assert.equal(line.general_account, code);
      assert.equal(line.partner_id, 1);
      assert.equal(line.product_id, 1);
      assert.equal(line.move_id, 999);
      assert.equal(line.date, '2026-01-10');
      assert.equal(line.unit_amount, 0);
      assert.equal(line.employee_id, null);
    }
  }
  assert.equal(JSON.stringify(db), before);
  assert.deepEqual(analyticLinesForMove(db, { move_type: 'entry' }), []);
});

test('analytic allocations respect tax-included prices and explicit general accounts', () => {
  const { db, a, b } = setup();
  const account = search(db, 'account.account').find((r) => r.code === '450000');
  const move = moveValues(a, b);
  const line = { ...move.invoice_line_ids[0], qty: 1, price_unit: 114, discount: 0, tax_include: true, account_id: account.id };
  const lines = analyticLinesForMove(db, { ...move, invoice_line_ids: [line] });
  assert.deepEqual(lines.map((l) => l.amount), [60, 40]);
  assert.ok(lines.every((l) => l.general_account === '450000'));
});

test('analytic posting is immutable, idempotent and removable without deleting linked timesheets', () => {
  const { db: base, a, b } = setup();
  const { db, id } = create(base, 'account.move', moveValues(a, b));
  const before = JSON.stringify(db);
  const posted = postAnalytic(db, id);
  assert.equal(search(posted, 'account.analytic.line').filter((r) => r.move_id === id).length, 2);
  assert.equal(postAnalytic(posted, id), posted);
  assert.equal(JSON.stringify(db), before);
  const timesheet = create(posted, 'account.analytic.line', { name: 'Keep me', move_id: id, unit_amount: 2 });
  const removed = removeAnalytic(timesheet.db, id);
  assert.deepEqual(search(removed, 'account.analytic.line').filter((r) => r.move_id === id).map((r) => r.id), [timesheet.id]);
  assert.equal(removeAnalytic(removed, id), removed);
  assert.equal(search(postAnalytic(removed, id), 'account.analytic.line').filter((r) => r.move_id === id).length, 3);
  assert.throws(() => postAnalytic(db, 999999), /not found/);
  const draft = create(base, 'account.move', { ...moveValues(a, b), state: 'draft' });
  assert.throws(() => postAnalytic(draft.db, draft.id), /Post the invoice/);
});

test('analytic balances include date boundaries and exclude other accounts', () => {
  const { db: base, a, b } = setup();
  const db = [
    { date: '2026-01-01', amount: 100 }, { date: '2026-01-31', amount: -40 },
    { date: '2025-12-31', amount: 900 }, { date: '2026-02-01', amount: -900 },
    { date: '2026-01-15', amount: 500, account_id: b },
  ].reduce((next, vals) => create(next, 'account.analytic.line', { account_id: a, ...vals }).db, base);
  assert.deepEqual(analyticBalance(db, a, { from: '2026-01-01', to: '2026-01-31' }), { debit: 40, credit: 100, balance: 60 });
  assert.deepEqual(analyticBalance(db, a), { debit: 940, credit: 1000, balance: 60 });
  assert.deepEqual(analyticBalance(db, 99999), { debit: 0, credit: 0, balance: 0 });
});

test('budget reports filter account prefixes and periods and prorate inclusive days with achievement', () => {
  const { db: base, a, b } = setup();
  const actuals = [
    { date: '2026-01-01', amount: -120, general_account: '600000' },
    { date: '2026-01-10', amount: -80, general_account: '600100' },
    { date: '2026-01-05', amount: 30, general_account: '400000' },
    { date: '2026-01-11', amount: -500, general_account: '600000' },
    { date: '2026-01-02', amount: -999, general_account: '600000', account_id: b },
  ].reduce((next, vals) => create(next, 'account.analytic.line', { account_id: a, ...vals }).db, base);
  const { db, id } = create(actuals, 'account.budget', { name: 'Ten days', date_from: '2026-01-01', date_to: '2026-01-10', lines: [
    { analytic_account_id: a, general_account: '600', planned: -1000 },
    { analytic_account_id: a, planned: 0 },
  ] });
  const [costs, all] = budgetReport(db, id, '2026-01-05');
  assert.deepEqual([costs.planned, costs.practical, costs.theoretical, costs.achievement], [-1000, -200, -500, 40]);
  assert.deepEqual([all.practical, all.theoretical, all.achievement], [-170, 0, 0]);
  assert.equal(budgetReport(db, id, '2025-12-31')[0].theoretical, 0);
  assert.equal(budgetReport(db, id, '2026-01-01')[0].theoretical, -100);
  assert.equal(budgetReport(db, id, '2026-02-01')[0].theoretical, -1000);
  const single = write(db, 'account.budget', id, { date_to: '2026-01-01' });
  assert.equal(budgetReport(single, id, '2026-01-01')[0].theoretical, -1000);
  assert.throws(() => budgetReport(db, 99999), /not found/);
  assert.throws(() => budgetReport(db, id, '2026-02-30'), /valid budget date/);
  assert.throws(() => budgetReport(write(db, 'account.budget', id, { date_to: '2025-12-31' }), id), /end date/);
});

test('mandatory plans require positive allocations per product line; unavailable plans reject allocations', () => {
  const { db: base, a, b } = setup();
  const plan = create(base, 'account.analytic.plan', { name: 'Projects', default_applicability: 'mandatory' });
  const db = write(plan.db, 'account.analytic.account', a, { plan_id: plan.id });
  const move = moveValues(a, b);
  assert.doesNotThrow(() => checkMandatoryPlans(db, move));
  for (const distribution of [{}, { [a]: 0 }, { [b]: 100 }]) {
    assert.throws(() => checkMandatoryPlans(db, { ...move, invoice_line_ids: [{ ...move.invoice_line_ids[0], analytic_distribution: distribution }] }), /mandatory.*Projects/);
  }
  assert.throws(() => checkMandatoryPlans(db, { ...move, invoice_line_ids: [...move.invoice_line_ids, { product_id: 1 }] }), /mandatory/);
  assert.doesNotThrow(() => checkMandatoryPlans(db, { ...move, invoice_line_ids: [{ name: 'Description' }] }));
  assert.throws(() => checkMandatoryPlans(write(db, 'account.analytic.plan', plan.id, { default_applicability: 'unavailable' }), move), /unavailable/);
});

test('budget buttons enforce transitions and retain the existing report action', () => {
  const made = create(seed(), 'account.budget', { name: 'Workflow' });
  assert.throws(() => runBudget(made.db, made.id, 'Approve'), /current state/);
  let db = made.db;
  for (const [button, state] of [['Confirm', 'confirmed'], ['Approve', 'validated'], ['Done', 'done'], ['Reset to Draft', 'draft'], ['Cancel', 'cancel'], ['Reset to Draft', 'draft']]) {
    db = runBudget(db, made.id, button);
    assert.equal(read(db, 'account.budget', made.id).state, state);
  }
  assert.ok(analyticPlusModels['account.budget'].form.buttons.some((b) => b.label === 'Budget vs Actual'));
});

test('seed and timesheet fields, defaults, views and hours remain compatible', () => {
  const db = seed();
  assert.equal(search(db, 'account.analytic.plan').length, 0);
  assert.ok(search(db, 'account.analytic.account').some((r) => r.plan === 'region'));
  assert.ok(search(db, 'account.budget').length);
  assert.ok(search(db, 'account.analytic.line').length);
  const def = analyticPlusModels['account.analytic.line'];
  const old = moreModels['account.analytic.line'];
  for (const key of Object.keys(old.fields)) assert.deepEqual(def.fields[key], old.fields[key]);
  for (const key of ['views', 'graph', 'pivot', 'calendar', 'filters', 'list', 'groupBys', 'kanban']) assert.deepEqual(def[key], old[key]);
  const made = create(db, 'account.analytic.line', { name: 'Analysis', project_id: 1, task_id: 1, unit_amount: 2.5 });
  const line = read(made.db, 'account.analytic.line', made.id);
  assert.equal(line.unit_amount, 2.5);
  assert.equal(line.employee_id, 1);
  assert.equal(line.category, 'timesheet');
  assert.equal(line.amount, 0);
});
