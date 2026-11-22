import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { diffDb, applyDiff } from './sync.js';
import { models } from './models/index.js';
import { autoReconcile, mapStatementPartner, applyRule, isWriteoffButtonModel, ruleMatches } from './models/reconcile.js';

const model = 'account.reconcile.model';
const line = 'account.bank.statement.line';
const rawChange = (db, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => r.id === id ? { ...r, ...vals } : r) } });

test('partner mappings validate regex through plain diffs and run before matching rules', () => {
  const rule = create(seed(), model, { name: 'Mapping', trigger: 'auto_reconcile', partner_mapping_line_ids: [{ payment_ref_regex: '^ABC', narration_regex: 'invoice', partner_id: 5 }] });
  assert.throws(() => applyDiff(rule.db, diffDb(rule.db, rawChange(rule.db, rule.id, { partner_mapping_line_ids: [{ payment_ref_regex: '(', partner_id: 5 }] }))), /invalid regular expression/i);
  const journal = search(rule.db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const st = create(rule.db, line, { journal_id: journal.id, date: '2026-10-01', state: 'to_check', payment_ref: 'ABC 123', narration: 'invoice', amount: 12 });
  assert.equal(read(autoReconcile(st.db), line, st.id).partner_id, 5);
});

test('partner mapping rejects foreign company partner on save and during mapping', () => {
  const db = seed();
  const c2 = create(db, 'res.company', { name: 'Company 2', currency_id: 1 });
  const pForeign = create(c2.db, 'res.partner', { name: 'Foreign Partner', company_id: c2.id });
  const rule = create(pForeign.db, model, { name: 'Mapping C1', company_id: 1, trigger: 'auto_reconcile', partner_mapping_line_ids: [{ payment_ref_regex: '^ABC', partner_id: 5 }] });

  // Field domain check
  const fieldDomain = models[model].fields.partner_mapping_line_ids.fields.partner_id.domain;
  assert.equal(typeof fieldDomain, 'function', 'partner_id in partner_mapping_line_ids has a domain');
  assert.equal(fieldDomain(read(rule.db, 'res.partner', pForeign.id), { company_id: 1 }), false);
  assert.equal(fieldDomain(read(rule.db, 'res.partner', 5), { company_id: 1 }), true);

  // Save-time rejection
  assert.throws(
    () => applyDiff(rule.db, diffDb(rule.db, rawChange(rule.db, rule.id, { partner_mapping_line_ids: [{ payment_ref_regex: '^ABC', partner_id: pForeign.id }] }))),
    /belong to the model company/i,
  );

  // Raw change bypasses guard: mapStatementPartner must still check company compatibility
  const injectedDb = rawChange(rule.db, rule.id, { partner_mapping_line_ids: [{ payment_ref_regex: '^ABC', partner_id: pForeign.id }] });
  const journal = search(injectedDb, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const st = create(injectedDb, line, { journal_id: journal.id, company_id: 1, date: '2026-10-01', state: 'to_check', payment_ref: 'ABC 123', amount: 12 });
  const afterMapping = mapStatementPartner(st.db, read(st.db, line, st.id));
  assert.equal(read(afterMapping, line, st.id).partner_id ?? null, null, 'foreign company partner must not be mapped onto statement line');
});

test('bounded overlapping-alternation regex is rejected on save and stays responsive on near-matching text', () => {
  const db = seed();
  const rule = create(db, model, { name: 'Regex Test', trigger: 'auto_reconcile', partner_mapping_line_ids: [{ payment_ref_regex: '^ABC', partner_id: 5 }] });

  // Save-time rejection of bounded overlapping alternation
  assert.throws(
    () => applyDiff(rule.db, diffDb(rule.db, rawChange(rule.db, rule.id, { partner_mapping_line_ids: [{ payment_ref_regex: '^(a|aa){1,50}$', partner_id: 5 }] }))),
    /invalid regular expression in partner mapping/i,
  );

  // Pre-stored / injected pattern must not stall mapStatementPartner on near-matching label
  const injectedDb = rawChange(rule.db, rule.id, { partner_mapping_line_ids: [{ payment_ref_regex: '^(a|aa){1,50}$', partner_id: 5 }] });
  const journal = search(injectedDb, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const nearMatchLabel = `${'a'.repeat(30)}!`;
  const st = create(injectedDb, line, { journal_id: journal.id, date: '2026-10-01', state: 'to_check', payment_ref: nearMatchLabel, amount: 12 });
  const started = Date.now();
  const after = mapStatementPartner(st.db, read(st.db, line, st.id));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `Mapping execution took too long: ${elapsed}ms`);
  assert.equal(read(after, line, st.id).partner_id ?? null, null);
});

test('manual reconciliation widget and applyRule map partner before rule matching and commit', () => {
  const db = seed();
  const expenseAcc = search(db, 'account.account').find((a) => a.account_type === 'expense_direct_cost' || a.account_type === 'expense');
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  // Partner-constrained writeoff button model
  const rule = create(db, model, {
    name: 'Vendor Quick Action',
    trigger: 'manual',
    rule_type: 'reco_model',
    match_partner_ids: [5],
    partner_mapping_line_ids: [{ payment_ref_regex: '^VENDOR', partner_id: 5 }],
    line_ids: [{ account_id: expenseAcc.id, amount_type: 'percentage', amount_string: '100' }],
  });

  const st = create(rule.db, line, {
    journal_id: journal.id,
    date: '2026-10-01',
    state: 'to_check',
    payment_ref: 'VENDOR REF 99',
    amount: -50,
  });

  const unmappedLine = read(st.db, line, st.id);
  assert.equal(unmappedLine.partner_id ?? null, null);

  // 1. Evaluating quickActionModels: with mapping step, model matches
  const ruleRecord = read(rule.db, model, rule.id);
  const mappedDb = mapStatementPartner(st.db, unmappedLine);
  const lineForRules = read(mappedDb, line, st.id);
  assert.equal(lineForRules.partner_id, 5);
  assert.equal(isWriteoffButtonModel(ruleRecord), true);
  assert.equal(ruleMatches(ruleRecord, lineForRules), true);
  assert.equal(ruleMatches(ruleRecord, unmappedLine), false, 'unmapped line without partner fails ruleMatches');

  // 2. Applying rule directly on unmapped line without prior manual mapping:
  // applyRule maps line, writes partner and posts entry
  const afterRec = applyRule(st.db, ruleRecord, unmappedLine);
  const reconciledLine = read(afterRec, line, st.id);
  assert.equal(reconciledLine.partner_id, 5);
  assert.equal(reconciledLine.state, 'reconciled');
  const move = read(afterRec, 'account.move', reconciledLine.move_id);
  assert.equal(move.partner_id, 5);
});

