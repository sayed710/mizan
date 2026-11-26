import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { diffDb, applyDiff } from './sync.js';
import { models } from './models/index.js';
import { autoReconcile, mapStatementPartner, applyRule, isWriteoffButtonModel, ruleMatches } from './models/reconcile.js';
import { setupDom } from './test-support/dom.js';

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

test('locked booked statement lines skip partner mapping writes without crashing widget or aborting autoReconcile', async () => {
  let db = seed();
  const expenseAcc = search(db, 'account.account').find((a) => a.account_type === 'expense_direct_cost' || a.account_type === 'expense');
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

  // Rule that covers 50% (partial write-off) so the line remains to_check with bank_move_id
  const partialRule = create(db, model, {
    name: 'Half Writeoff',
    trigger: 'manual',
    rule_type: 'reco_model',
    line_ids: [{ account_id: expenseAcc.id, amount_type: 'percentage', amount_string: '50' }],
  });
  db = partialRule.db;

  // Create line in 2026-10-01 and partially write it off before partner mappings exist
  const lockedLineRes = create(db, line, {
    journal_id: journal.id,
    company_id: 1,
    date: '2026-10-01',
    state: 'to_check',
    payment_ref: 'LOCKED PARTIAL',
    amount: -100,
  });
  db = applyRule(lockedLineRes.db, read(lockedLineRes.db, model, partialRule.id), read(lockedLineRes.db, line, lockedLineRes.id));
  const partiallyBooked = read(db, line, lockedLineRes.id);
  assert.equal(partiallyBooked.state, 'to_check');
  assert.ok(partiallyBooked.bank_move_id);
  assert.equal(partiallyBooked.partner_id ?? null, null);

  // Manual quick-action rule requiring partner 5 + partner mapping regex matching the locked line
  const quickRule = create(db, model, {
    name: 'Locked Quick Action',
    trigger: 'manual',
    rule_type: 'reco_model',
    match_partner_ids: [5],
    partner_mapping_line_ids: [{ payment_ref_regex: '^LOCKED', partner_id: 5 }],
    line_ids: [{ account_id: expenseAcc.id, amount_type: 'percentage', amount_string: '100' }],
  });
  db = quickRule.db;

  const autoRule = create(db, model, {
    name: 'Auto Partner Writeoff',
    trigger: 'auto_reconcile',
    rule_type: 'reco_model',
    match_partner_ids: [5],
    partner_mapping_line_ids: [{ payment_ref_regex: '^AUTO', partner_id: 5 }],
    line_ids: [{ account_id: expenseAcc.id, amount_type: 'percentage', amount_string: '100' }],
  });
  db = autoRule.db;

  // Add an unlocked line after the lock date that should still auto-reconcile
  const openLineRes = create(db, line, {
    journal_id: journal.id,
    company_id: 1,
    date: '2026-11-05',
    state: 'to_check',
    payment_ref: 'AUTO OK',
    amount: -40,
  });
  db = openLineRes.db;

  // Model a historical lock that predates this unreconciled line; a new lock would be rejected.
  db = { ...db, records: { ...db.records, 'res.company': db.records['res.company'].map((company) => company.id === 1 ? { ...company, lock_date: '2026-10-31' } : company) } };

  // 1. Existing lock is preserved for direct partner writes on the locked booked line
  assert.throws(
    () => write(db, line, lockedLineRes.id, { partner_id: 5 }),
    /period up to 2026-10-31 is locked/i,
  );

  // 2. mapStatementPartner skips writing on locked booked line without throwing
  const mapped = mapStatementPartner(db, read(db, line, lockedLineRes.id));
  assert.equal(read(mapped, line, lockedLineRes.id).partner_id ?? null, null);

  // 3. autoReconcile does not abort on the locked line and reconciles the unlocked line
  const afterAuto = autoReconcile(db);
  assert.equal(read(afterAuto, line, lockedLineRes.id).state, 'to_check');
  assert.equal(read(afterAuto, line, lockedLineRes.id).partner_id ?? null, null);
  assert.equal(read(afterAuto, line, openLineRes.id).state, 'reconciled');
  assert.equal(read(afterAuto, line, openLineRes.id).partner_id, 5);

  // 4. BankReconcile widget renders the locked booked line without crashing
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const { makeEl } = setupDom();
  await initStore();
  await commit(db);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));
    assert.ok(host.textContent.includes('LOCKED PARTIAL'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('shared reconciliation models allow company-specific partners on save and only assign them to matching company lines', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Company 2', currency_id: 1 });
  db = c2.db;
  const pC2 = create(db, 'res.partner', { name: 'Company 2 Partner', company_id: c2.id });
  db = pC2.db;
  const pArchived = create(db, 'res.partner', { name: 'Archived Partner', company_id: c2.id, active: false });
  db = pArchived.db;

  const fieldDomain = models[model].fields.partner_mapping_line_ids.fields.partner_id.domain;
  assert.equal(fieldDomain(read(db, 'res.partner', pC2.id), { company_id: null }), true);
  assert.equal(fieldDomain(read(db, 'res.partner', 5), { company_id: null }), true);
  assert.equal(fieldDomain(read(db, 'res.partner', pArchived.id), { company_id: null }), false);
  assert.equal(fieldDomain(read(db, 'res.partner', pC2.id), { company_id: 1 }), false);
  assert.equal(fieldDomain(read(db, 'res.partner', pC2.id), { company_id: c2.id }), true);

  // Creating a company-2 model with a company-2 partner succeeds
  const sharedRule = create(db, model, {
    name: 'Shared Partner Mapping',
    company_id: c2.id,
    trigger: 'auto_reconcile',
    partner_mapping_line_ids: [{ payment_ref_regex: '^C2PAY', partner_id: pC2.id }],
  });
  db = sharedRule.db;
  assert.equal(read(db, model, sharedRule.id).partner_mapping_line_ids[0].partner_id, pC2.id);

  // Editing via diffDb/applyDiff also succeeds for company-2 partner and rejects archived partner
  const updated = applyDiff(db, diffDb(db, rawChange(db, sharedRule.id, {
    partner_mapping_line_ids: [{ payment_ref_regex: '^C2NEW', partner_id: pC2.id }],
  })));
  assert.equal(read(updated, model, sharedRule.id).partner_mapping_line_ids[0].payment_ref_regex, '^C2NEW');
  assert.throws(
    () => applyDiff(updated, diffDb(updated, rawChange(updated, sharedRule.id, {
      partner_mapping_line_ids: [{ payment_ref_regex: '^C2NEW', partner_id: pArchived.id }],
    }))),
    /belong to the model company/i,
  );

  // Runtime mapping only assigns company-2 partner to company-2 lines, never to company-1 lines
  const j1 = search(updated, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const c2BankAcc = create(updated, 'account.account', { code: '101499', name: 'Bank C2', account_type: 'asset_cash', company_id: c2.id });
  const c2SuspenseAcc = create(c2BankAcc.db, 'account.account', { code: '101498', name: 'Suspense C2', account_type: 'asset_current', company_id: c2.id });
  const j2 = create(c2SuspenseAcc.db, 'account.journal', { name: 'Bank C2', code: 'BNK2', type: 'bank', company_id: c2.id, default_account_id: c2BankAcc.id, suspense_account_id: c2SuspenseAcc.id });
  const l1 = create(j2.db, line, { journal_id: j1.id, company_id: 1, date: '2026-10-01', state: 'to_check', payment_ref: 'C2NEW 1', amount: 25 });
  const l2 = create(l1.db, line, { journal_id: j2.id, company_id: c2.id, date: '2026-10-01', state: 'to_check', payment_ref: 'C2NEW 2', amount: 25 });

  const afterC1 = mapStatementPartner(l2.db, read(l2.db, line, l1.id));
  assert.equal(read(afterC1, line, l1.id).partner_id ?? null, null, 'company-1 line must not receive company-2 partner');

  const afterC2 = mapStatementPartner(afterC1, read(afterC1, line, l2.id));
  assert.equal(read(afterC2, line, l2.id).partner_id, pC2.id, 'company-2 line must receive company-2 partner from shared rule');
});

