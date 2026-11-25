import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { applyRule, autoReconcile } from './models/reconcile.js';
import { unreconcile } from './models/bank.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

const MODEL = 'account.reconcile.model';
const LINE = 'account.bank.statement.line';

const bankJournals = (db) => search(db, 'account.journal').filter((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
const addLine = (db, vals) => create(db, LINE, { journal_id: bankJournals(db)[0].id, date: '2026-10-01', state: 'to_check', ...vals });
const addRule = (db, vals) => create(db, MODEL, { name: 'B3 Test Rule', ...vals });

test('BANK-20: counterpart lines of reconciliation models declare analytic_distribution and flow into write-off move lines and analytic items', () => {
  const base = seed();
  const feeAcc = accountId(base, '600000');
  const plan = create(base, 'account.analytic.plan', { name: 'Projects' });
  const analyticAcc = create(plan.db, 'account.analytic.account', { name: 'Project Alpha', plan_id: plan.id });
  let db = analyticAcc.db;

  // 1. Counterpart field is declared in model metadata
  assert.ok(models[MODEL].fields.line_ids.fields.analytic_distribution, 'analytic_distribution field declared on counterpart items');
  assert.equal(models[MODEL].fields.line_ids.fields.analytic_distribution.type, 'distribution');

  // 2. Creating a model preserves analytic_distribution on line_ids
  const r = addRule(db, {
    name: 'Fee with Analytic',
    line_ids: [{
      sequence: 10,
      account_id: feeAcc,
      label: 'Bank Service Fee',
      amount_type: 'percentage',
      amount_string: '100',
      analytic_distribution: { [analyticAcc.id]: 100 },
    }],
  });
  db = r.db;
  const savedRule = read(db, MODEL, r.id);
  assert.deepEqual(savedRule.line_ids[0].analytic_distribution, { [analyticAcc.id]: 100 });

  // 3. Applying the rule creates a write-off entry carrying the analytic distribution
  const stLine = addLine(db, { payment_ref: 'Service Charge Oct', amount: -75 });
  db = stLine.db;
  const after = applyRule(db, savedRule, read(db, LINE, stLine.id));
  const updatedLine = read(after, LINE, stLine.id);
  assert.equal(updatedLine.state, 'reconciled');

  const move = read(after, 'account.move', updatedLine.move_id);
  assert.ok(move, 'Write-off move created');
  const counterpartItem = move.line_ids.find((l) => l.account_id === feeAcc);
  assert.ok(counterpartItem, 'Counterpart fee line exists in move');
  assert.deepEqual(counterpartItem.analytic_distribution, { [analyticAcc.id]: 100 }, 'Move line receives analytic distribution');

  // 4. Analytic line item is posted to account.analytic.line
  const analyticLines = search(after, 'account.analytic.line').filter((l) => l.move_id === move.id);
  assert.equal(analyticLines.length, 1, 'Analytic line posted');
  assert.equal(analyticLines[0].account_id, analyticAcc.id);
  assert.equal(analyticLines[0].amount, -75);

  // 5. diffDb + applyDiff accepts valid distribution and rejects invalid distribution
  const validStaged = addRule(db, {
    name: 'Valid Staged',
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [analyticAcc.id]: 100 } }],
  });
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, validStaged.db), { isAdmin: true }));

  // Value > 100% caught by cleanRecord / validate.js
  const over100Staged = {
    ...db,
    records: {
      ...db.records,
      [MODEL]: [...(db.records[MODEL] ?? []), {
        id: 9999,
        name: 'Invalid Dist Rule Over 100',
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        line_ids: [{ sequence: 10, account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [analyticAcc.id]: 150 } }],
      }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, over100Staged), { isAdmin: true }), /Invalid value for account\.reconcile\.model\.line_ids\[0\]\.analytic_distribution/);

  // Total exceeding 100% for plan caught by distributionError
  const secondAcc = create(analyticAcc.db, 'account.analytic.account', { name: 'Project Beta', plan_id: plan.id });
  const planOver100Staged = {
    ...secondAcc.db,
    records: {
      ...secondAcc.db.records,
      [MODEL]: [...(secondAcc.db.records[MODEL] ?? []), {
        id: 9998,
        name: 'Invalid Plan Total',
        company_id: 1,
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        line_ids: [{ sequence: 10, account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [analyticAcc.id]: 60, [secondAcc.id]: 60 } }],
      }],
    },
  };
  assert.throws(() => applyDiff(secondAcc.db, diffDb(secondAcc.db, planOver100Staged), { isAdmin: true }), /Analytic distribution cannot exceed 100% per plan/);
});

test('BANK-23: regex conditions are applied by the autoReconcile runner and invalid regex is rejected on save', () => {
  const base = seed();
  const feeAcc = accountId(base, '600000');

  // 1. autoReconcile runner evaluates regex label conditions
  const rAutoRegex = addRule(base, {
    name: 'Auto Regex Label Rule',
    sequence: 1,
    trigger: 'auto_reconcile',
    match_label: 'match_regex',
    match_label_param: '^AUTO-FEES?-\\d+$',
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100', label: 'Auto Fee' }],
  });
  const stMatch = addLine(rAutoRegex.db, { payment_ref: 'AUTO-FEE-99', amount: -35 });
  const stNoMatch = addLine(stMatch.db, { payment_ref: 'OTHER-REF-99', amount: -35 });

  const reconciledDb = autoReconcile(stNoMatch.db);
  assert.equal(read(reconciledDb, LINE, stMatch.id).state, 'reconciled', 'Regex match is auto-reconciled');
  assert.equal(read(reconciledDb, LINE, stNoMatch.id).state, 'to_check', 'Non-matching label is left to_check');

  // 2. Invalid regex pattern in label parameter is rejected on save (create, write, applyDiff)
  assert.throws(() => addRule(base, {
    match_label: 'match_regex',
    match_label_param: '[unclosed',
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }],
  }), /Invalid regular expression in label parameter/);

  // 3. Invalid regex pattern in counterpart amount is rejected on save (create, write, applyDiff)
  assert.throws(() => addRule(base, {
    line_ids: [{ account_id: feeAcc, amount_type: 'regex', amount_string: '(?<invalid' }],
  }), /Invalid regular expression in counterpart line amount/);

  // 4. Server-side rejection through diffDb + applyDiff
  const forgedBadRegex = {
    ...base,
    records: {
      ...base.records,
      [MODEL]: [...(base.records[MODEL] ?? []), {
        id: 9998,
        name: 'Forged Bad Regex',
        company_id: 1,
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        match_label: 'match_regex',
        match_label_param: '*bad',
        line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }],
      }],
    },
  };
  assert.throws(() => applyDiff(base, diffDb(base, forgedBadRegex), { isAdmin: true }), /Invalid regular expression in label parameter/);
});

test('BANK-15 audit analysis: rule_type in Odoo 20 is hidden/readonly with automation driven by trigger', () => {
  const def = models[MODEL];
  // In Odoo 20, rule_type is internal ('matching_rule' | 'reco_model') and hidden/readonly in the form
  assert.equal(def.fields.rule_type.hidden, true);
  assert.equal(def.fields.rule_type.readonly, true);
  // Automation is controlled by trigger (Manual vs Automated) with statusbar buttons
  assert.equal(def.form.statusbar, 'trigger');
  assert.ok(def.form.buttons.some((b) => b.label === 'Automate' && b.vals.trigger === 'auto_reconcile'));
  assert.ok(def.form.buttons.some((b) => b.label === 'Set Manual' && b.vals.trigger === 'manual'));
});

test('an underpayment written off within a matching rule tolerance keeps the counterpart analytic distribution', () => {
  const base = seed();
  const plan = create(base, 'account.analytic.plan', { name: 'Projects' });
  const project = create(plan.db, 'account.analytic.account', { name: 'Project Alpha', plan_id: plan.id });
  const inv = create(project.db, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-04-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  const posted = postMove(inv.db, inv.id);
  const feeAcc = accountId(posted, '600000');
  const rule = addRule(posted, {
    rule_type: 'matching_rule',
    payment_tolerance: 5,
    payment_tolerance_type: 'amount',
    line_ids: [{ account_id: feeAcc, label: 'Short payment', amount_type: 'percentage', amount_string: '100', analytic_distribution: { [project.id]: 100 } }],
  });
  const line = addLine(rule.db, { payment_ref: 'Short 96', amount: 96, partner_id: 5 });
  const after = applyRule(line.db, read(line.db, MODEL, rule.id), read(line.db, LINE, line.id));
  assert.equal(read(after, 'account.move', inv.id).amount_residual, 0);
  const writeoffItems = search(after, 'account.move').flatMap((m) => m.line_ids ?? []).filter((l) => l.account_id === feeAcc && l.name === 'Short payment');
  assert.equal(writeoffItems.length, 1);
  assert.equal(writeoffItems[0].debit, 4);
  assert.deepEqual(writeoffItems[0].analytic_distribution, { [project.id]: 100 });

  // Once reconciled, the allocation that produced the posted write-off is frozen.
  const reconciled = read(after, LINE, line.id);
  const edited = { ...after, records: { ...after.records, [LINE]: after.records[LINE].map((l) => (l.id === line.id ? { ...l, writeoff_analytic_distribution: {} } : l)) } };
  assert.throws(() => applyDiff(after, diffDb(after, edited), { isAdmin: true }), /A reconciled bank transaction cannot be changed/);

  // Unreconciling drops it, so a later manual write-off cannot inherit the rule's hidden allocation.
  const reopened = unreconcile(after, reconciled).db;
  assert.equal(read(reopened, LINE, line.id).writeoff_analytic_distribution ?? null, null);
  assert.equal(read(applyDiff(after, diffDb(after, reopened), { isAdmin: true }), LINE, line.id).writeoff_analytic_distribution ?? null, null);
  // A synced unreconciliation cannot slip in a different hidden allocation.
  const injected = { ...reopened, records: { ...reopened.records, [LINE]: reopened.records[LINE].map((l) => (l.id === line.id ? { ...l, writeoff_analytic_distribution: { [project.id]: 50 } } : l)) } };
  assert.throws(() => applyDiff(after, diffDb(after, injected), { isAdmin: true }), /Unreconciliation requires clearing the matched links/);
});

test('a label regex with a repeated group around a repeat is rejected on save and never matched', () => {
  const base = seed();
  const feeAcc = accountId(base, '600000');
  const rule = { id: 9901, name: 'Runaway', company_id: 1, active: true, trigger: 'auto_reconcile', rule_type: 'reco_model', match_label: 'match_regex', match_label_param: '(a+)+$', line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }] };
  const staged = { ...base, records: { ...base.records, [MODEL]: [...(base.records[MODEL] ?? []), rule] } };
  assert.throws(() => applyDiff(base, diffDb(base, staged), { isAdmin: true }), /Invalid regular expression in label parameter/);

  // Overlapping alternation in repeated group, e.g. ^(a|aa)+$, also backtracks exponentially and must be rejected on save
  const ruleAlt = { id: 9902, name: 'Runaway Alternation', company_id: 1, active: true, trigger: 'auto_reconcile', rule_type: 'reco_model', match_label: 'match_regex', match_label_param: '^(a|aa)+$', line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }] };
  const stagedAlt = { ...base, records: { ...base.records, [MODEL]: [...(base.records[MODEL] ?? []), ruleAlt] } };
  assert.throws(() => applyDiff(base, diffDb(base, stagedAlt), { isAdmin: true }), /Invalid regular expression in label parameter/);

  // A pattern already stored before this check never matches, so the runner stays responsive.
  const line = addLine(staged, { payment_ref: `${'a'.repeat(40)}!`, amount: -10 });
  const started = Date.now();
  const after = autoReconcile(line.db);
  assert.ok(Date.now() - started < 2000);
  assert.equal(read(after, LINE, line.id).state, 'to_check');

  // Near-matching label on pre-stored overlapping alternation pattern stays responsive
  const lineAlt = addLine(stagedAlt, { payment_ref: `${'a'.repeat(30)}!`, amount: -10 });
  const startedAlt = Date.now();
  const afterAlt = autoReconcile(lineAlt.db);
  assert.ok(Date.now() - startedAlt < 2000);
  assert.equal(read(afterAlt, LINE, lineAlt.id).state, 'to_check');

  // Ordinary patterns must still compile and save cleanly
  for (const pattern of ['INV/(\\d+)', '^PAY-\\d+$', '(\\d+)\\.(\\d{2})']) {
    assert.doesNotThrow(() => addRule(base, {
      name: `Normal ${pattern}`,
      match_label: 'match_regex',
      match_label_param: pattern,
      line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }],
    }));
  }
});

test('counterpart line analytic distribution must belong to the model company or have no company', () => {
  const base = seed();
  const feeAcc = accountId(base, '600000');
  const co2 = create(base, 'res.company', { name: 'Company 2', currency_id: 1 });
  const plan = create(co2.db, 'account.analytic.plan', { name: 'Projects' });
  const co2Account = create(plan.db, 'account.analytic.account', { name: 'Co2 Project', company_id: co2.id, plan_id: plan.id });
  const globalAccount = create(co2Account.db, 'account.analytic.account', { name: 'Global Project', company_id: null, plan_id: plan.id });
  const co1Account = create(globalAccount.db, 'account.analytic.account', { name: 'Co1 Project', company_id: 1, plan_id: plan.id });
  const db = co1Account.db;

  // 1. Model for company 1 rejecting counterpart line with company 2 analytic account
  assert.throws(() => addRule(db, {
    name: 'Co1 Rule with Co2 Analytic',
    company_id: 1,
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [co2Account.id]: 100 } }],
  }), /Analytic accounts in the distribution must belong to the model company/);

  // 2. Rejecting through diffDb + applyDiff
  const forgedForeignAnalytic = {
    ...db,
    records: {
      ...db.records,
      [MODEL]: [...(db.records[MODEL] ?? []), {
        id: 9903,
        name: 'Forged Foreign Analytic',
        company_id: 1,
        sequence: 10,
        trigger: 'manual',
        rule_type: 'reco_model',
        line_ids: [{ sequence: 10, account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [co2Account.id]: 100 } }],
      }],
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedForeignAnalytic), { isAdmin: true }), /Analytic accounts in the distribution must belong to the model company/);

  // 3. Analytic account with same company is accepted
  assert.doesNotThrow(() => addRule(db, {
    name: 'Co1 Rule with Co1 Analytic',
    company_id: 1,
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [co1Account.id]: 100 } }],
  }));

  // 4. Analytic account with no company (global) is accepted
  assert.doesNotThrow(() => addRule(db, {
    name: 'Co1 Rule with Global Analytic',
    company_id: 1,
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100', analytic_distribution: { [globalAccount.id]: 100 } }],
  }));
});

test('a bounded repeat of a bounded group is saved and still matches labels', () => {
  const base = seed();
  const feeAcc = accountId(base, '600000');
  const rule = addRule(base, {
    trigger: 'auto_reconcile',
    match_label: 'match_regex',
    match_label_param: '^(a{1,3}){1,2}$',
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100' }],
  });
  const line = addLine(rule.db, { payment_ref: 'aaaa', amount: -10 });
  assert.equal(read(autoReconcile(line.db), LINE, line.id).state, 'reconciled');
});
