import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { setStatementLinePartner, reconcileWith } from './models/bank.js';
import { postMove } from './models/accounting.js';
import { accountId } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';
import { find, setupDom } from './test-support/dom.js';

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

const bankJournal = (db) => search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

function makeInvoice(db, { partnerId = 1, price = 200, companyId = 1, date = '2026-10-01' } = {}) {
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    company_id: companyId,
    invoice_date: date,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: price, tax: 0 }],
  });
  const postedDb = postMove(inv.db, inv.id);
  return { db: postedDb, id: inv.id };
}

test('the statement line guard blocks partner_id change on reconciled line through diffDb + applyDiff', () => {
  let db = seed();
  const journal = bankJournal(db);
  const partners = search(db, 'res.partner');
  const partner1 = partners[0];
  const partner2 = partners[1];

  // Create an invoice and a statement line, then reconcile them
  const inv = makeInvoice(db, { partnerId: partner1.id, price: 100 });
  db = inv.db;
  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    company_id: 1,
    partner_id: partner1.id,
    date: '2026-10-01',
    amount: 100,
    payment_ref: 'Settled Tx',
    state: 'to_check',
  });
  db = lineRes.db;
  db = reconcileWith(db, read(db, 'account.bank.statement.line', lineRes.id), inv.id);
  const reconciledLine = read(db, 'account.bank.statement.line', lineRes.id);
  assert.equal(reconciledLine.state, 'reconciled');

  // Attempt to forge a partner_id change on the reconciled statement line through a diff
  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': db.records['account.bank.statement.line'].map((l) => (l.id === lineRes.id ? { ...l, partner_id: partner2.id } : l)),
    },
  };

  // The account.bank.statement.line guard must reject this diff
  assert.throws(
    () => applyDiff(db, diffDb(db, forged), { isAdmin: true }),
    /A reconciled bank transaction cannot be changed/,
    'Server-side lineGuard on account.bank.statement.line must block partner_id mutation on reconciled lines through diffDb + applyDiff',
  );
});

test('BANK-13: setStatementLinePartner updates partner_id on unreconciled statement line and enforces guards', () => {
  let db = seed();
  const journal = bankJournal(db);
  const partners = search(db, 'res.partner');
  const partner1 = partners[0];
  const partner2 = partners[1];

  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    company_id: 1,
    partner_id: null,
    date: '2026-10-01',
    amount: 150,
    payment_ref: 'Customer Deposit',
    state: 'to_check',
  });
  db = lineRes.db;
  const lineId = lineRes.id;

  // 1. Assign partner using line ID
  db = setStatementLinePartner(db, lineId, partner1.id);
  let line = read(db, 'account.bank.statement.line', lineId);
  assert.equal(line.partner_id, partner1.id, 'Partner must be set to partner1.id');

  // Server-side guard diff verification: diffDb + applyDiff must accept the partner update on to_check line
  const syncedDb = applyDiff(lineRes.db, diffDb(lineRes.db, db), { isAdmin: true });
  assert.equal(read(syncedDb, 'account.bank.statement.line', lineId).partner_id, partner1.id);

  // 2. Change partner using line object
  db = setStatementLinePartner(db, line, partner2.id);
  line = read(db, 'account.bank.statement.line', lineId);
  assert.equal(line.partner_id, partner2.id, 'Partner must be updated to partner2.id');

  // 3. Clear partner with null or empty string
  db = setStatementLinePartner(db, lineId, null);
  line = read(db, 'account.bank.statement.line', lineId);
  assert.equal(line.partner_id, null, 'Partner must be cleared to null');

  db = setStatementLinePartner(db, lineId, partner1.id);
  db = setStatementLinePartner(db, lineId, '');
  line = read(db, 'account.bank.statement.line', lineId);
  assert.equal(line.partner_id, null, 'Partner must be cleared when passed empty string');

  // 4. Error on non-existent statement line
  assert.throws(
    () => setStatementLinePartner(db, 999999, partner1.id),
    /Bank transaction does not exist/,
  );

  // 5. Error on non-existent partner
  assert.throws(
    () => setStatementLinePartner(db, lineId, 999999),
    /Partner does not exist/,
  );

  // 6. Error if partner belongs to another company
  const company2PartnerRes = create(db, 'res.partner', {
    name: 'Company 2 Partner',
    company_id: 2,
  });
  db = company2PartnerRes.db;
  assert.throws(
    () => setStatementLinePartner(db, lineId, company2PartnerRes.id),
    /Partner belongs to another company/,
  );

  // 7. Error on already reconciled line
  const inv = makeInvoice(db, { partnerId: partner1.id, price: 100 });
  db = inv.db;
  const recLineRes = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    company_id: 1,
    partner_id: partner1.id,
    date: '2026-10-01',
    amount: 100,
    payment_ref: 'Settled Deposit',
    state: 'to_check',
  });
  db = recLineRes.db;
  db = reconcileWith(db, read(db, 'account.bank.statement.line', recLineRes.id), inv.id);
  assert.throws(
    () => setStatementLinePartner(db, recLineRes.id, partner2.id),
    /A reconciled bank transaction cannot be changed/,
  );
});

test('BANK-13: BankReconcile widget renders editable partner selector and updates matching candidates', async () => {
  let db = seed();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const journal = bankJournal(db);
  const partners = search(db, 'res.partner');
  const partner1 = partners[0];
  const partner2 = partners[1];

  // Create an open invoice for partner1
  const inv = makeInvoice(db, { partnerId: partner1.id, price: 200, date: '2026-10-01' });
  db = inv.db;
  const invMove = read(db, 'account.move', inv.id);

  // Create statement line with partner2 initially
  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    company_id: 1,
    partner_id: partner2.id,
    date: '2026-10-05',
    amount: 200,
    payment_ref: 'Deposit 200',
    state: 'to_check',
  });
  db = lineRes.db;

  const { makeEl } = setupDom();
  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));

    // Select the statement line
    const stLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Deposit 200'));
    assert.ok(stLineBtn, 'Statement line button must exist');
    await React.act(async () => props(stLineBtn).onClick());

    // Check partner select dropdown exists
    const partnerSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Partner');
    assert.ok(partnerSelect, 'Partner select element must exist in BankReconcile');
    assert.equal(props(partnerSelect).value, String(partner2.id), 'Partner select should initially reflect statement line partner');

    // Because line has partner2, invoice for partner1 should NOT appear in candidates
    let candidateBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(invMove.name));
    assert.ok(!candidateBtn, 'Invoice for partner1 should not appear when line is assigned to partner2');

    // Now change partner to partner1 through the partner selector
    await React.act(async () => {
      props(partnerSelect).onChange({ target: { value: String(partner1.id) } });
    });

    // Verify candidate invoice for partner1 now appears
    candidateBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(invMove.name));
    assert.ok(candidateBtn, 'Invoice for partner1 should now appear after changing partner to partner1');

    // Now clear partner to No Partner
    await React.act(async () => {
      props(partnerSelect).onChange({ target: { value: '' } });
    });
    const currentDb = (await import('./store.js')).getDb();
    const lineAfterClear = read(currentDb, 'account.bank.statement.line', lineRes.id);
    assert.equal(lineAfterClear.partner_id, null, 'Statement line partner_id should be cleared in DB');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('BANK-16: BankReconcile widget shows quick-action buttons for manual reco_model and applies them on click', async () => {
  let db = seed();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const journal = bankJournal(db);
  const expenseId = accountId(db, '600000');

  // Create cash journal to test journal filtering on reconciliation models
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);

  // 1. Manual reco_model (applies to all journals)
  const model1Res = create(db, 'account.reconcile.model', {
    name: 'Bank Fee Button',
    rule_type: 'reco_model',
    trigger: 'manual',
    sequence: 1,
    active: true,
    line_ids: [{ account_id: expenseId, label: 'Bank Fee', amount_type: 'percentage', amount: 100 }],
  });
  db = model1Res.db;

  // 2. Manual reco_model limited to bank journal
  const model2Res = create(db, 'account.reconcile.model', {
    name: 'Manual Writeoff Model',
    rule_type: 'reco_model',
    trigger: 'manual',
    match_journal_ids: [journal.id],
    sequence: 2,
    active: true,
    line_ids: [{ account_id: expenseId, label: 'Service Charge', amount_type: 'percentage', amount: 100 }],
  });
  db = model2Res.db;

  // 3. Model restricted to cash journal only (should NOT appear on bank statement line)
  const cashOnlyModelRes = create(db, 'account.reconcile.model', {
    name: 'Cash Only Model',
    rule_type: 'reco_model',
    trigger: 'manual',
    match_journal_ids: [cashJournal.id],
    sequence: 3,
    active: true,
    line_ids: [{ account_id: expenseId, label: 'Cash Variance', amount_type: 'percentage', amount: 100 }],
  });
  db = cashOnlyModelRes.db;

  // 4. Inactive manual model (should NOT appear)
  const inactiveModelRes = create(db, 'account.reconcile.model', {
    name: 'Inactive Model',
    rule_type: 'reco_model',
    trigger: 'manual',
    sequence: 4,
    active: false,
    line_ids: [{ account_id: expenseId, label: 'Old Fee', amount_type: 'percentage', amount: 100 }],
  });
  db = inactiveModelRes.db;

  // 5. Model belonging to another company (should NOT appear)
  const company2ModelRes = create(db, 'account.reconcile.model', {
    name: 'Company 2 Fee',
    company_id: 2,
    rule_type: 'reco_model',
    trigger: 'manual',
    sequence: 5,
    active: true,
    line_ids: [{ account_id: expenseId, label: 'C2 Fee', amount_type: 'percentage', amount: 100 }],
  });
  db = company2ModelRes.db;

  // 6. Matching rule model (should NOT appear as quick-action button)
  const matchingRuleRes = create(db, 'account.reconcile.model', {
    name: 'Invoice Matching Rule',
    rule_type: 'matching_rule',
    sequence: 6,
    active: true,
  });
  db = matchingRuleRes.db;

  // 7. Automated model (trigger: auto_reconcile, should NOT appear as quick-action button)
  const autoModelRes = create(db, 'account.reconcile.model', {
    name: 'Auto Rule Model',
    rule_type: 'reco_model',
    trigger: 'auto_reconcile',
    sequence: 7,
    active: true,
    line_ids: [{ account_id: expenseId, label: 'Auto Fee', amount_type: 'percentage', amount: 100 }],
  });
  db = autoModelRes.db;

  // Create a statement line on the bank journal
  const lineRes = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    company_id: 1,
    date: '2026-10-10',
    amount: -50,
    payment_ref: 'Bank Charge Oct',
    state: 'to_check',
  });
  db = lineRes.db;
  const lineId = lineRes.id;

  const { makeEl } = setupDom();
  await initStore();
  await commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));

    // Select the statement line
    const stLineBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Bank Charge Oct'));
    assert.ok(stLineBtn, 'Statement line button must exist');
    await React.act(async () => props(stLineBtn).onClick());

    // Item 2: Quick-actions toolbar must have the class and no inline style object
    const toolbar = find(host, (n) => props(n)?.className?.includes('bank-reconcile-quick-actions'));
    assert.ok(toolbar, 'Quick actions toolbar element must exist with bank-reconcile-quick-actions class');
    assert.equal(props(toolbar)?.style, undefined, 'Quick actions toolbar must not use inline style object');

    // Check quick-action buttons: model1 and model2 MUST exist
    const btn1 = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Bank Fee Button');
    const btn2 = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Manual Writeoff Model');
    assert.ok(btn1, 'Quick-action button for Bank Fee Button must exist');
    assert.ok(btn2, 'Quick-action button for Manual Writeoff Model must exist');

    // Other models must NOT have quick-action buttons
    assert.ok(!find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cash Only Model'), 'Cash only model must not appear on bank line');
    assert.ok(!find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Inactive Model'), 'Inactive model must not appear');
    assert.ok(!find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Company 2 Fee'), 'Other company model must not appear');
    assert.ok(!find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Invoice Matching Rule'), 'Matching rule model must not appear');
    assert.ok(!find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Auto Rule Model'), 'Auto rule model must not appear');

    // Click the quick-action button for model1
    await React.act(async () => {
      props(btn1).onClick();
    });

    // Check statement line is now reconciled
    const currentDb = getDb();
    const updatedLine = read(currentDb, 'account.bank.statement.line', lineId);
    assert.equal(updatedLine.state, 'reconciled', 'Statement line should be reconciled after clicking quick-action button');
    assert.ok(updatedLine.move_id, 'Statement line must have move_id created by write-off');
  } finally {
    await React.act(async () => root.unmount());
  }
});
