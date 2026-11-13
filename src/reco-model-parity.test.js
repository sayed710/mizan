import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, create, groupRecords, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { accountId, isBalanced } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { applyRule, autoReconcile, ruleMatches, suggestRule } from './models/reconcile.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { seed } from './seed.js';

const MODEL = 'account.reconcile.model';
const LINE = 'account.bank.statement.line';

const bankJournals = (db) => search(db, 'account.journal').filter((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
const addLine = (db, vals) => create(db, LINE, { journal_id: bankJournals(db)[0].id, date: '2026-10-01', state: 'to_check', ...vals });
const addRule = (db, vals) => create(db, MODEL, { name: 'Parity Rule', ...vals });

test('migration 41 converts legacy reconciliation models to Odoo 20 schema idempotently', () => {
  const base = seed();
  const expense = accountId(base, '600000');
  const legacyDb = {
    ...base,
    schema_version: 39,
    records: {
      ...base.records,
      [MODEL]: [
        {
          id: 901,
          name: 'Legacy Suggestion Paid',
          company_id: 1,
          sequence: 5,
          rule_type: 'writeoff_suggestion',
          auto_reconcile: true,
          match_nature: 'amount_paid',
          match_partner: true,
          partner_id: 4,
          match_amount: '',
          match_label: 'contains',
          match_label_param: 'Bank Fees',
          active: true,
          line_ids: [{ account_id: expense, label: 'Fee', amount_type: 'percentage', amount: 100 }],
        },
        {
          id: 902,
          name: 'Legacy Invoice Match Both',
          company_id: 1,
          sequence: 10,
          rule_type: 'invoice_matching',
          auto_reconcile: false,
          match_nature: 'both',
          match_partner: false,
          partner_id: null,
          active: true,
          line_ids: [],
        },
        {
          id: 903,
          name: 'Legacy Button',
          company_id: 1,
          sequence: 15,
          rule_type: 'writeoff_button',
          auto_reconcile: false,
          match_nature: 'both',
          active: true,
          line_ids: [{ account_id: expense, amount_type: 'fixed', amount: -25 }],
        },
      ],
    },
  };

  const migrated = migrate(legacyDb, SCHEMA_VERSION);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);

  const r1 = read(migrated, MODEL, 901);
  assert.equal(r1.rule_type, 'reco_model');
  assert.equal(r1.trigger, 'auto_reconcile');
  assert.equal('auto_reconcile' in r1, false);
  assert.equal('partner_id' in r1, false);
  assert.deepEqual(r1.match_partner_ids, [4]);
  // match_nature non-'both' and match_partner=true are retained hidden because they restrict ruleMatches behavior.
  assert.equal(r1.match_nature, 'amount_paid');
  assert.equal(r1.match_partner, true);
  assert.equal(r1.line_ids[0].amount_string, '100');
  assert.equal(r1.line_ids[0].amount, 100);

  const r2 = read(migrated, MODEL, 902);
  assert.equal(r2.rule_type, 'matching_rule');
  assert.equal(r2.trigger, 'manual');
  assert.deepEqual(r2.match_partner_ids, []);
  assert.equal('match_nature' in r2, false);
  assert.equal('match_partner' in r2, false);

  const r3 = read(migrated, MODEL, 903);
  assert.equal(r3.rule_type, 'reco_model');
  assert.equal(r3.trigger, 'manual');
  assert.equal(r3.line_ids[0].amount_string, '-25');
  assert.equal(r3.line_ids[0].amount, -25);

  // Idempotent on re-run
  const twice = migrate(migrated, SCHEMA_VERSION);
  assert.deepEqual(read(twice, MODEL, 901), r1);
  assert.deepEqual(read(twice, MODEL, 902), r2);
  assert.deepEqual(read(twice, MODEL, 903), r3);
});

test('ruleMatches honours match_journal_ids, match_partner_ids, inclusive amount bounds, label conditions, and hidden legacy flags', () => {
  const base = seed();
  const [j1] = bankJournals(base);
  const j2 = create(base, 'account.journal', { name: 'Bank 2', code: 'BNK2', type: 'bank', company_id: 1, suspense_account_id: accountId(base, '101404') });
  const expense = accountId(j2.db, '600000');

  // Journals condition: empty matches all, non-empty restricts to listed journals
  const allJournals = { rule_type: 'reco_model', match_journal_ids: [] };
  const onlyJ2 = { rule_type: 'reco_model', match_journal_ids: [j2.id] };
  assert.equal(ruleMatches(allJournals, { journal_id: j1.id, amount: -10 }), true);
  assert.equal(ruleMatches(onlyJ2, { journal_id: j1.id, amount: -10 }), false);
  assert.equal(ruleMatches(onlyJ2, { journal_id: j2.id, amount: -10 }), true);

  // Partners condition: empty allows null/any partner, non-empty requires partner in list
  const pRule = addRule(j2.db, {
    name: 'Partner Filter',
    match_partner_ids: [3, 5],
    line_ids: [{ account_id: expense, amount_type: 'percentage', amount_string: '100' }],
  });
  const partnerRule = read(pRule.db, MODEL, pRule.id);
  assert.equal(ruleMatches(partnerRule, { journal_id: j1.id, amount: -10, partner_id: null }), false);
  assert.equal(ruleMatches(partnerRule, { journal_id: j1.id, amount: -10, partner_id: 4 }), false);
  assert.equal(ruleMatches(partnerRule, { journal_id: j1.id, amount: -10, partner_id: 5 }), true);

  // Amount bounds: lower is <=, greater is >=, between is [min, max]
  assert.equal(ruleMatches({ match_amount: 'lower', match_amount_max: 50 }, { amount: -50 }), true);
  assert.equal(ruleMatches({ match_amount: 'lower', match_amount_max: 50 }, { amount: -50.01 }), false);
  assert.equal(ruleMatches({ match_amount: 'greater', match_amount_min: 50 }, { amount: 50 }), true);
  assert.equal(ruleMatches({ match_amount: 'greater', match_amount_min: 50 }, { amount: 49.99 }), false);
  assert.equal(ruleMatches({ match_amount: 'between', match_amount_min: 10, match_amount_max: 20 }, { amount: -10 }), true);
  assert.equal(ruleMatches({ match_amount: 'between', match_amount_min: 10, match_amount_max: 20 }, { amount: -20 }), true);
  assert.equal(ruleMatches({ match_amount: 'between', match_amount_min: 10, match_amount_max: 20 }, { amount: -21 }), false);

  // Label conditions
  assert.equal(ruleMatches({ match_label: 'contains', match_label_param: 'FEE' }, { payment_ref: 'Monthly fee' }), true);
  assert.equal(ruleMatches({ match_label: 'not_contains', match_label_param: 'FEE' }, { payment_ref: 'Monthly fee' }), false);
  assert.equal(ruleMatches({ match_label: 'match_regex', match_label_param: '^INV-\\d+$' }, { payment_ref: 'inv-42' }), true);

  // Hidden legacy match_nature (retained hidden rather than dropped because Mizan behavior distinguishes paid vs received rules)
  assert.equal(ruleMatches({ match_nature: 'amount_paid' }, { amount: -10 }), true);
  assert.equal(ruleMatches({ match_nature: 'amount_paid' }, { amount: 10 }), false);
  assert.equal(ruleMatches({ match_partner: true }, { amount: 10, partner_id: null }), false);
});

test('write-off engine supports fixed (negative=debit, positive=credit), percentage, percentage_st_line, and regex (1 & 2 capture groups + no-match skip)', () => {
  const base = seed();
  const feeAcc = accountId(base, '600000');
  const miscAcc = accountId(base, '690000');
  const otherAcc = accountId(base, '450000');

  // 1. Outgoing transaction (-100) with negative fixed (-25 = debit 25), percentage_st_line (10% of 100 = 10 debit), percentage (100% of remaining 65 = 65 debit)
  const r1 = addRule(base, {
    name: 'Mixed Types',
    line_ids: [
      { sequence: 10, account_id: feeAcc, label: 'Fixed Fee', amount_type: 'fixed', amount_string: '-25' },
      { sequence: 20, account_id: miscAcc, label: 'Tx Pct', amount_type: 'percentage_st_line', amount_string: '10' },
      { sequence: 30, account_id: otherAcc, label: 'Rest', amount_type: 'percentage', amount_string: '100' },
    ],
  });
  const saved1 = read(r1.db, MODEL, r1.id);
  assert.deepEqual(saved1.line_ids.map((l) => l.amount), [-25, 10, 100]);

  const l1 = addLine(r1.db, { payment_ref: 'Outgoing split', amount: -100 });
  const after1 = applyRule(l1.db, saved1, read(l1.db, LINE, l1.id));
  const move1 = read(after1, 'account.move', read(after1, LINE, l1.id).move_id);
  assert.ok(isBalanced(move1.line_ids));
  assert.equal(move1.line_ids.find((x) => x.account_id === feeAcc).debit, 25);
  assert.equal(move1.line_ids.find((x) => x.account_id === miscAcc).debit, 10);
  assert.equal(move1.line_ids.find((x) => x.account_id === otherAcc).debit, 65);

  // 2. Incoming receipt (+100) where bank deducted a -20 fixed debit fee, and remaining 120 goes to credit receivable/income
  const r2 = addRule(base, {
    name: 'Incoming with Deducted Fee',
    line_ids: [
      { account_id: feeAcc, label: 'Bank Fee', amount_type: 'fixed', amount_string: '-20' },
      { account_id: otherAcc, label: 'Gross Settlement', amount_type: 'percentage', amount_string: '100' },
    ],
  });
  const l2 = addLine(r2.db, { payment_ref: 'Net settlement', amount: 100 });
  const after2 = applyRule(l2.db, read(r2.db, MODEL, r2.id), read(l2.db, LINE, l2.id));
  const move2 = read(after2, 'account.move', read(after2, LINE, l2.id).move_id);
  assert.ok(isBalanced(move2.line_ids));
  assert.equal(move2.line_ids.find((x) => x.account_id === feeAcc).debit, 20);
  assert.equal(move2.line_ids.find((x) => x.account_id === otherAcc).credit, 120);

  // 3. Regex with 1 capture group vs 2 capture groups (integer + decimal), plus skipping unmatched regex lines
  const r3 = addRule(base, {
    name: 'Regex Multi',
    line_ids: [
      { sequence: 10, account_id: feeAcc, label: '1-group', amount_type: 'regex', amount_string: 'FEE=(\\d+\\.\\d+)' },
      { sequence: 20, account_id: miscAcc, label: '2-group', amount_type: 'regex', amount_string: 'VAT=(\\d+),(\\d{2})' },
      { sequence: 30, account_id: otherAcc, label: 'Rest', amount_type: 'percentage', amount_string: '100' },
    ],
  });
  const l3a = addLine(r3.db, { payment_ref: 'PMT FEE=12.50 VAT=2,50 END', amount: -100 });
  const after3a = applyRule(l3a.db, read(r3.db, MODEL, r3.id), read(l3a.db, LINE, l3a.id));
  const move3a = read(after3a, 'account.move', read(after3a, LINE, l3a.id).move_id);
  assert.ok(isBalanced(move3a.line_ids));
  assert.equal(move3a.line_ids.find((x) => x.account_id === feeAcc).debit, 12.5);
  assert.equal(move3a.line_ids.find((x) => x.account_id === miscAcc).debit, 2.5);
  assert.equal(move3a.line_ids.find((x) => x.account_id === otherAcc).debit, 85);

  // Unmatched regex lines are skipped without error, letting percentage take 100%
  const l3b = addLine(r3.db, { payment_ref: 'NO AMOUNTS IN LABEL', amount: -100 });
  const after3b = applyRule(l3b.db, read(r3.db, MODEL, r3.id), read(l3b.db, LINE, l3b.id));
  const move3b = read(after3b, 'account.move', read(after3b, LINE, l3b.id).move_id);
  assert.equal(move3b.line_ids.some((x) => x.account_id === feeAcc || x.account_id === miscAcc), false);
  assert.equal(move3b.line_ids.find((x) => x.account_id === otherAcc).debit, 100);

  // Regex-only rule with no match leaves statement line open cleanly
  const rRegexOnly = addRule(base, {
    name: 'Regex Only',
    line_ids: [{ account_id: feeAcc, amount_type: 'regex', amount_string: 'FEE=(\\d+)' }],
  });
  const l3c = addLine(rRegexOnly.db, { payment_ref: 'UNMATCHED', amount: -50 });
  const after3c = applyRule(l3c.db, read(rRegexOnly.db, MODEL, rRegexOnly.id), read(l3c.db, LINE, l3c.id));
  assert.equal(read(after3c, LINE, l3c.id).state, 'to_check');

  // Direct call with invalid regex on line skips cleanly instead of throwing
  const afterBad = applyRule(l3c.db, { rule_type: 'reco_model', line_ids: [{ account_id: feeAcc, amount_type: 'regex', amount_string: '([' }] }, read(l3c.db, LINE, l3c.id));
  assert.equal(read(afterBad, LINE, l3c.id).state, 'to_check');

  // write() also keeps numeric amount derived from amount_string
  const updated = write(r1.db, MODEL, r1.id, {
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage_st_line', amount_string: '33.5', label: 'Updated' }],
  });
  assert.equal(read(updated, MODEL, r1.id).line_ids[0].amount, 33.5);

  // percentage_st_line computes % of original statement transaction amount even when partially open
  const rPart = addRule(base, { name: 'Half Balance', line_ids: [{ account_id: otherAcc, amount_type: 'percentage', amount_string: '50' }] });
  const rSt20 = addRule(rPart.db, { name: 'Tx 20%', line_ids: [{ account_id: feeAcc, amount_type: 'percentage_st_line', amount_string: '20' }] });
  const sPart = addLine(rSt20.db, { payment_ref: 'Two stage', amount: -200 });
  const afterHalf = applyRule(sPart.db, read(sPart.db, MODEL, rPart.id), read(sPart.db, LINE, sPart.id));
  assert.equal(read(afterHalf, LINE, sPart.id).open_amount, 100);
  const afterSt20 = applyRule(afterHalf, read(afterHalf, MODEL, rSt20.id), read(afterHalf, LINE, sPart.id));
  const mSt20 = read(afterSt20, 'account.move', read(afterSt20, LINE, sPart.id).move_id);
  assert.equal(mSt20.line_ids.find((x) => x.account_id === feeAcc).debit, 40, '20% of full 200 transaction = 40, not 20% of 100 open balance');
  assert.equal(read(afterSt20, LINE, sPart.id).open_amount, 60);
});

test('trigger controls autoReconcile vs manual suggestion and bank Apply button', () => {
  const base = seed();
  const acc = accountId(base, '600000');
  const rManual = addRule(base, {
    name: 'Manual Fees',
    sequence: 1,
    trigger: 'manual',
    match_label: 'contains',
    match_label_param: 'Manual Fee',
    line_ids: [{ account_id: acc, amount_type: 'percentage', amount_string: '100' }],
  });
  const rAuto = addRule(rManual.db, {
    name: 'Auto Fees',
    sequence: 2,
    trigger: 'auto_reconcile',
    match_label: 'contains',
    match_label_param: 'Auto Fee',
    line_ids: [{ account_id: acc, amount_type: 'percentage', amount_string: '100' }],
  });
  const s1 = addLine(rAuto.db, { payment_ref: 'Manual Fee 10', amount: -10 });
  const s2 = addLine(s1.db, { payment_ref: 'Auto Fee 20', amount: -20 });

  assert.equal(suggestRule(s2.db, read(s2.db, LINE, s1.id))?.id, rManual.id);
  const afterAuto = autoReconcile(s2.db);
  assert.equal(read(afterAuto, LINE, s1.id).state, 'to_check');
  assert.equal(read(afterAuto, LINE, s2.id).state, 'reconciled');

  // Manual rule is applied via the statement line's Apply Reconciliation Model button
  const btn = models[LINE].form.buttons.find((b) => b.label === 'Apply Reconciliation Model');
  const afterBtn = btn.run(afterAuto, read(afterAuto, LINE, s1.id)).db;
  assert.equal(read(afterBtn, LINE, s1.id).state, 'reconciled');
});

test('matching_rule honours matching_order (new_first vs old_first) and payment_tolerance', () => {
  let db = seed();
  const feeAcc = accountId(db, '600000');
  const invOldRes = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-01-10', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(invOldRes.db, invOldRes.id);
  const invNewRes = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-02-10', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(invNewRes.db, invNewRes.id);

  // old_first settles invOld first
  const rOld = addRule(db, { name: 'Match Old', rule_type: 'matching_rule', matching_order: 'old_first' });
  const lineOld = addLine(rOld.db, { payment_ref: 'Pay 1', amount: 100, partner_id: 5 });
  const afterOld = applyRule(lineOld.db, read(lineOld.db, MODEL, rOld.id), read(lineOld.db, LINE, lineOld.id));
  assert.equal(read(afterOld, 'account.move', invOldRes.id).amount_residual, 0);
  assert.equal(read(afterOld, 'account.move', invNewRes.id).amount_residual, 100);

  // new_first settles invNew first
  const invSecond = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-03-10', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  const dbNew = postMove(invSecond.db, invSecond.id);
  const rNew = addRule(dbNew, { name: 'Match New', rule_type: 'matching_rule', matching_order: 'new_first' });
  const lineNew = addLine(rNew.db, { payment_ref: 'Pay 2', amount: 100, partner_id: 5 });
  const afterNew = applyRule(lineNew.db, read(lineNew.db, MODEL, rNew.id), read(lineNew.db, LINE, lineNew.id));
  assert.equal(read(afterNew, 'account.move', invSecond.id).amount_residual, 0);
  assert.equal(read(afterNew, 'account.move', invOldRes.id).amount_residual, 100);

  // payment_tolerance in amount (underpayment 96 on 100 within 5 tolerance) & percentage overpayment written off to counterpart item
  let dbTol = seed();
  const invTol = create(dbTol, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-04-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  dbTol = postMove(invTol.db, invTol.id);
  const rTolAmt = addRule(dbTol, {
    name: 'Tol Amount',
    rule_type: 'matching_rule',
    payment_tolerance: 5,
    payment_tolerance_type: 'amount',
  });
  const lineOutOfTol = addLine(rTolAmt.db, { payment_ref: 'Short 90', amount: 90, partner_id: 5 });
  const notMatched = applyRule(lineOutOfTol.db, read(lineOutOfTol.db, MODEL, rTolAmt.id), read(lineOutOfTol.db, LINE, lineOutOfTol.id));
  assert.equal(read(notMatched, LINE, lineOutOfTol.id).state, 'to_check');

  const lineInTol = addLine(rTolAmt.db, { payment_ref: 'Short 96', amount: 96, partner_id: 5 });
  const matchedAmt = applyRule(lineInTol.db, read(lineInTol.db, MODEL, rTolAmt.id), read(lineInTol.db, LINE, lineInTol.id));
  assert.equal(read(matchedAmt, LINE, lineInTol.id).state, 'reconciled');

  // Percentage tolerance overpayment writes off remaining open_amount using Counterpart Items
  const rTolPct = addRule(dbTol, {
    name: 'Tol Pct Writeoff',
    rule_type: 'matching_rule',
    payment_tolerance: 5,
    payment_tolerance_type: 'percentage',
    line_ids: [{ account_id: feeAcc, amount_type: 'percentage', amount_string: '100', label: 'Tol writeoff' }],
  });
  const lineOver = addLine(rTolPct.db, { payment_ref: 'Over 103', amount: 103, partner_id: 5 });
  const matchedPct = applyRule(lineOver.db, read(lineOver.db, MODEL, rTolPct.id), read(lineOver.db, LINE, lineOver.id));
  assert.equal(read(matchedPct, 'account.move', invTol.id).amount_residual, 0);
  assert.equal(read(matchedPct, LINE, lineOver.id).state, 'reconciled');
});

test('guard rejects missing required params, wrong-company/archived accounts, non-numeric amounts, out-of-range percentages, and invalid regex', () => {
  let db = seed();
  const acc = accountId(db, '600000');
  const comp2 = create(db, 'res.company', { name: 'Co2', currency_id: 1 });
  const foreignAcc = create(comp2.db, 'account.account', { code: '600099', name: 'Co2 Exp', account_type: 'expense', company_id: comp2.id });
  const archivedAcc = create(foreignAcc.db, 'account.account', { code: '600098', name: 'Arch Exp', account_type: 'expense', company_id: 1, active: false });
  db = archivedAcc.db;

  // Missing amount condition bounds
  assert.throws(() => addRule(db, { match_amount: 'greater' }), /Minimum amount/);
  assert.throws(() => addRule(db, { match_amount: 'between', match_amount_min: 10 }), /Maximum amount/);

  // Missing or invalid label param
  assert.throws(() => addRule(db, { match_label: 'contains' }), /Label parameter/);
  assert.throws(() => addRule(db, { match_label: 'match_regex', match_label_param: '([' }), /Invalid regular expression/);

  // Negative tolerance
  assert.throws(() => addRule(db, { rule_type: 'matching_rule', payment_tolerance: -1 }), /negative/);

  // Line without account_id AND without partner_id is rejected; partner_id alone is allowed
  assert.throws(() => addRule(db, { line_ids: [{ amount_type: 'fixed', amount_string: '10' }] }), /requires an account unless a partner is set/);
  assert.doesNotThrow(() => addRule(db, { line_ids: [{ partner_id: 2 }] }));

  // Foreign or archived account rejected
  assert.throws(() => addRule(db, { line_ids: [{ account_id: foreignAcc.id, amount_type: 'percentage', amount_string: '100' }] }), /active and belong to the model company/);
  assert.throws(() => addRule(db, { line_ids: [{ account_id: archivedAcc.id, amount_type: 'percentage', amount_string: '100' }] }), /active and belong to the model company/);

  // Non-numeric amount_string for fixed/percentage/percentage_st_line
  assert.throws(() => addRule(db, { line_ids: [{ account_id: acc, amount_type: 'fixed', amount_string: 'abc' }] }), /numeric/);
  assert.throws(() => addRule(db, { line_ids: [{ account_id: acc, amount_type: 'percentage', amount_string: '' }] }), /numeric/);

  // Percentage outside 0..100
  assert.throws(() => addRule(db, { line_ids: [{ account_id: acc, amount_type: 'percentage', amount_string: '101' }] }), /between 0 and 100/);
  assert.throws(() => addRule(db, { line_ids: [{ account_id: acc, amount_type: 'percentage_st_line', amount_string: '-1' }] }), /between 0 and 100/);

  // Invalid regex on regex line
  assert.throws(() => addRule(db, { line_ids: [{ account_id: acc, amount_type: 'regex', amount_string: '([' }] }), /Invalid regular expression/);
  assert.throws(() => addRule(db, { line_ids: [{ account_id: acc, amount_type: 'regex', amount_string: '' }] }), /Invalid regular expression/);
});

test('list, form, statusbar buttons, filters, groupBys, and i18n match Odoo 20 specification', async () => {
  const def = models[MODEL];
  assert.deepEqual(def.list, ['sequence', 'name', 'trigger', 'match_journal_ids']);
  assert.equal(def.fields.sequence.widget, 'handle');
  assert.equal(def.fields.match_journal_ids.optional, 'hide');
  assert.equal(def.fields.rule_type.hidden, true);
  assert.equal(def.fields.rule_type.readonly, true);
  assert.equal(def.fields.match_nature.hidden, true);
  assert.equal(def.fields.line_ids.fields.sequence.widget, 'handle');
  assert.equal(def.fields.line_ids.fields.tax_ids.optional, 'hide');
  assert.deepEqual(def.fields.line_ids.fields.amount_type.options.map(([k]) => k), ['fixed', 'percentage', 'percentage_st_line', 'regex']);

  // Statusbar and header buttons switch trigger
  assert.equal(def.form.statusbar, 'trigger');
  const [btnAutomate, btnManual] = def.form.buttons;
  assert.equal(btnAutomate.label, 'Automate');
  assert.equal(btnManual.label, 'Set Manual');
  assert.equal(btnAutomate.when({ trigger: 'manual' }), true);
  assert.equal(btnAutomate.when({ trigger: 'auto_reconcile' }), false);
  assert.equal(btnManual.when({ trigger: 'manual' }), false);
  assert.equal(btnManual.when({ trigger: 'auto_reconcile' }), true);

  // Form dynamic group & tab visibility
  const baseGroups = def.form.groups({ rule_type: 'reco_model', match_amount: null, match_label: null }).flat().map((x) => (typeof x === 'string' ? x : x.field));
  assert.equal(baseGroups.includes('match_amount_min'), false);
  assert.equal(baseGroups.includes('match_amount_max'), false);
  assert.equal(baseGroups.includes('match_label_param'), false);
  assert.equal(baseGroups.includes('matching_order'), false);
  assert.equal(baseGroups.includes('payment_tolerance'), false);
  assert.equal(baseGroups.includes('match_nature'), false);

  const lowerGroups = def.form.groups({ rule_type: 'reco_model', match_amount: 'lower', match_label: 'contains' }).flat();
  assert.equal(lowerGroups.includes('match_amount_min'), false);
  assert.equal(lowerGroups.includes('match_amount_max'), true);
  assert.equal(lowerGroups.includes('match_label_param'), true);

  const matchingGroups = def.form.groups({ rule_type: 'matching_rule', match_amount: 'greater', match_label: null }).flat();
  assert.equal(matchingGroups.includes('match_amount_min'), true);
  assert.equal(matchingGroups.includes('match_amount_max'), false);
  assert.equal(matchingGroups.includes('matching_order'), true);
  assert.equal(matchingGroups.includes('payment_tolerance'), true);
  assert.equal(matchingGroups.includes('payment_tolerance_type'), true);

  assert.equal(def.form.tabs({ rule_type: 'matching_rule', payment_tolerance: 0 }).length, 0);
  assert.equal(def.form.tabs({ rule_type: 'matching_rule', payment_tolerance: 5 }).length, 1);
  assert.equal(def.form.tabs({ rule_type: 'reco_model', payment_tolerance: 0 }).length, 1);

  // Filters & groupBys
  const base = seed();
  const acc = accountId(base, '600000');
  const tax = search(base, 'account.tax')[0];
  const j1 = bankJournals(base)[0];
  let db = addRule(base, {
    name: 'User Auto Tax',
    trigger: 'auto_reconcile',
    match_journal_ids: [j1.id],
    line_ids: [{ account_id: acc, amount_type: 'percentage', amount_string: '100', tax_ids: [tax.id] }],
  }).db;
  db = addRule(db, { name: 'System Manual', created_automatically: true, trigger: 'manual' }).db;

  const recs = search(db, MODEL);
  assert.equal(applyFilters(MODEL, recs, ['created_by_user']).length, 1);
  assert.equal(applyFilters(MODEL, recs, ['created_automatically']).length, 1);
  assert.equal(applyFilters(MODEL, recs, ['automated']).length, 1);
  assert.equal(applyFilters(MODEL, recs, ['with_tax']).length, 1);

  assert.deepEqual(def.groupBys, ['match_journal_ids', 'trigger']);
  assert.deepEqual(def.groupByLabels, { match_journal_ids: 'Journals Availability', trigger: 'Automation' });
  assert.equal(groupRecords(db, MODEL, recs, 'match_journal_ids').length, 2);
  assert.deepEqual(groupRecords(db, MODEL, recs, 'trigger').map((g) => g.key), ['manual', 'auto_reconcile']);

  // Arabic i18n translations exist for new labels
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'ar' };
  try {
    const { t: tAr } = await import('./i18n.js?testAr=1');
    for (const key of ['Trigger', 'Automation', 'Set Manual', 'Journals Availability', 'Amount Condition', 'Matching Order', 'Payment Tolerance', 'Counterpart Items', 'Percentage of transaction', 'From label']) {
      assert.notEqual(tAr(key), key, `missing Arabic translation for ${key}`);
    }
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});

test('migration 41 keeps legacy fixed amounts on the counterpart side of paid-only rules', () => {
  const base = seed();
  const expense = accountId(base, '600000');
  const legacy = { ...base, schema_version: 39, records: { ...base.records, [MODEL]: [
    { id: 911, name: 'Paid fee', company_id: 1, rule_type: 'writeoff_button', match_nature: 'amount_paid', active: true, line_ids: [{ account_id: expense, amount_type: 'fixed', amount: 25 }] },
    { id: 912, name: 'Received fee', company_id: 1, rule_type: 'writeoff_button', match_nature: 'amount_received', active: true, line_ids: [{ account_id: expense, amount_type: 'fixed', amount: 25 }] },
  ] } };
  const migrated = migrate(legacy, SCHEMA_VERSION);
  assert.equal(read(migrated, MODEL, 911).line_ids[0].amount_string, '-25', 'a paid transaction books its counterpart as a debit');
  assert.equal(read(migrated, MODEL, 912).line_ids[0].amount_string, '25', 'a received transaction books its counterpart as a credit');
  assert.equal(read(migrate(migrated, SCHEMA_VERSION), MODEL, 911).line_ids[0].amount_string, '-25', 'migrating again changes nothing');
});

test('the Journals condition offers only liquidity journals of the model company', () => {
  const db = seed();
  const domain = models[MODEL].fields.match_journal_ids.domain;
  const journals = search(db, 'account.journal');
  const offered = journals.filter((j) => domain(j, { company_id: 1 })).map((j) => j.type);
  assert.ok(offered.length > 0);
  assert.ok(offered.every((type) => ['bank', 'cash', 'credit'].includes(type)));
  assert.equal(domain({ type: 'bank', company_id: 2 }, { company_id: 1 }), false);
});
