import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { accountId, isBalanced } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { applyRule, autoReconcile, ruleMatches, suggestRule } from './models/reconcile.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const LINE = 'account.bank.statement.line';
const rule = (vals) => ({ match_nature: 'both', match_amount: '', match_label: '', active: true, ...vals });
const addLine = (db, vals) => create(db, LINE, { date: '2026-10-01', state: 'to_check', ...vals });
const addRule = (db, vals) => create(db, 'account.reconcile.model', { name: 'Rule', ...vals }).db;

test('ruleMatches checks label, amount, nature, partner and regex; an invalid regex never matches', () => {
  const line = { payment_ref: 'Monthly BANK fee', amount: -25, partner_id: null };
  assert.equal(ruleMatches(rule({ match_label: 'contains', match_label_param: 'bank' }), line), true);
  assert.equal(ruleMatches(rule({ match_label: 'not_contains', match_label_param: 'bank' }), line), false);
  assert.equal(ruleMatches(rule({ match_label: 'match_regex', match_label_param: '^monthly\\s+bank' }), line), true);
  assert.equal(ruleMatches(rule({ match_label: 'match_regex', match_label_param: '([' }), line), false);
  assert.equal(ruleMatches(rule({ match_amount: 'lower', match_amount_max: 30 }), line), true);
  assert.equal(ruleMatches(rule({ match_amount: 'greater', match_amount_min: 30 }), line), false);
  assert.equal(ruleMatches(rule({ match_amount: 'between', match_amount_min: 20, match_amount_max: 25 }), line), true);
  assert.equal(ruleMatches(rule({ match_nature: 'amount_paid' }), line), true);
  assert.equal(ruleMatches(rule({ match_nature: 'amount_received' }), line), false);
  assert.equal(ruleMatches(rule({ match_partner: true }), line), false);
  assert.equal(ruleMatches(rule({ partner_id: 3 }), { ...line, partner_id: 4 }), false);
  assert.equal(ruleMatches(rule({ partner_id: 3 }), { ...line, partner_id: 3 }), true);
});

test('a write-off splits fixed then percentage counterparts into one balanced bank entry', () => {
  const { db, id } = addLine(seed(), { payment_ref: 'Card settlement', amount: 1000 });
  const r = rule({ rule_type: 'writeoff_button', line_ids: [
    { account_code: '600000', label: 'Fee', amount_type: 'percentage', amount: 33.333 },
    { account_code: '690000', label: 'Fixed fee', amount_type: 'fixed', amount: 10 },
    { account_code: '450000', label: 'Rest', amount_type: 'percentage', amount: 66.667 },
  ] });
  const after = applyRule(db, r, read(db, LINE, id));
  const line = read(after, LINE, id);
  assert.equal(line.state, 'reconciled');
  const move = read(after, 'account.move', line.move_id);
  assert.ok(isBalanced(move.line_ids));
  assert.equal(move.ref, 'Card settlement');
  const credit = (code) => move.line_ids.find((l) => l.account_id === accountId(after, code)).credit;
  assert.equal(move.line_ids.find((l) => l.account_id === accountId(after, '101401')).debit, 1000);
  assert.deepEqual([credit('690000'), credit('600000'), credit('450000')], [10, 330, 660]);
  assert.throws(() => applyRule(db, rule({ line_ids: [{ account_code: '600000', amount_type: 'percentage', amount: 50 }] }), read(db, LINE, id)), /cover/);
});

test('invoice matching reconciles a statement line with the posted invoice for its amount', () => {
  const { db: d1, id: inv } = create(seed(), 'account.move', {
    move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-10-01', invoice_line_ids: [{ product_id: 4, qty: 2, price_unit: 35, tax: 14 }],
  });
  const posted = postMove(d1, inv);
  const total = read(posted, 'account.move', inv).amount_total;
  const { db, id } = addLine(posted, { payment_ref: 'Customer transfer', amount: total, partner_id: 5 });
  const after = applyRule(db, rule({ rule_type: 'invoice_matching' }), read(db, LINE, id));
  assert.equal(read(after, LINE, id).move_id, inv);
  assert.equal(read(after, LINE, id).state, 'reconciled');
  assert.equal(read(after, 'account.move', inv).amount_residual, 0);
});

test('autoReconcile applies the lowest-sequence auto-validated rule and skips the others', () => {
  let db = seed();
  db = addRule(db, { sequence: 20, auto_reconcile: true, match_label: 'contains', match_label_param: 'bank', line_ids: [{ account_code: '690000', amount_type: 'percentage', amount: 100 }] });
  db = addRule(db, { sequence: 5, auto_reconcile: true, match_label: 'contains', match_label_param: 'charges', line_ids: [{ account_code: '600000', amount_type: 'percentage', amount: 100 }] });
  db = addRule(db, { sequence: 1, auto_reconcile: false, rule_type: 'writeoff_suggestion', match_label: 'contains', match_label_param: 'rent' });
  const after = autoReconcile(db);
  const byRef = (ref) => search(after, LINE).find((l) => l.payment_ref === ref);
  const charges = byRef('Bank charges');
  assert.equal(charges.state, 'reconciled');
  const move = read(after, 'account.move', charges.move_id);
  assert.equal(move.line_ids.find((l) => l.debit).account_id, accountId(after, '600000'));
  assert.equal(byRef('Office rent October').state, 'to_check');
  assert.equal(byRef('TRF SARA HASSAN INV').state, 'to_check');
  assert.equal(suggestRule(after, byRef('Office rent October')).sequence, 1);
  assert.equal(suggestRule(after, byRef('TRF SARA HASSAN INV')), null);
});

test('the bank line button applies the matching reconciliation model', () => {
  const base = create(seed(), 'account.reconcile.model', { name: 'Fees', rule_type: 'writeoff_button', match_label: 'contains', match_label_param: 'fee', line_ids: [{ account_code: '690000', label: 'Fee', amount_type: 'percentage', amount: 100 }] });
  const { db, id } = create(base.db, 'account.bank.statement.line', { date: '2026-05-01', payment_ref: 'Card fee May', amount: -12, state: 'to_check' });
  const button = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Apply Reconciliation Model');
  const done = button.run(db, read(db, 'account.bank.statement.line', id)).db;
  assert.equal(read(done, 'account.bank.statement.line', id).state, 'reconciled');
  const other = create(done, 'account.bank.statement.line', { date: '2026-05-02', payment_ref: 'Unknown transfer', amount: 999, state: 'to_check' });
  assert.throws(() => button.run(other.db, read(other.db, 'account.bank.statement.line', other.id)), /No reconciliation model/);
});
