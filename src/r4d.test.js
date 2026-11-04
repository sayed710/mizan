import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write, setActiveCompany } from './orm.js';
import { models, menusFor } from './models/index.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { editableFields } from './models/locks.js';
import { applyDiff } from './sync.js';
import { changeFormValue, newDefaults } from './views/formDefaults.js';
import { saveFormRecord } from './views/formSave.js';

function invoice(db, company, amount) {
  const move = create(db, 'account.move', {
    company_id: company,
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2025-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }],
  });
  return { db: postMove(move.db, move.id), id: move.id };
}

// ---------------------------------------------------------------------------
// Finding 7: Adding open invoices blocks batch posting
// ---------------------------------------------------------------------------
test('Finding 7: Add Open Invoices only adds invoices from the batch company and validates cleanly', () => {
  const branch = createCompany(seed(), { name: 'Branch' });
  let db = branch.db;
  const inv1 = invoice(db, 1, 100);
  const invBranch = invoice(inv1.db, branch.id, 200);
  db = invBranch.db;

  // Create a draft inbound batch payment in Branch company
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'inbound',
    date: '2025-01-02',
    company_id: branch.id,
  });
  db = batchRes.db;

  // Run "Add Open Invoices" button action
  const addBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Add Open Invoices');
  assert.ok(addBtn, 'Add Open Invoices button exists');
  db = addBtn.run(db, read(db, 'account.batch.payment', batchRes.id)).db;

  const populatedBatch = read(db, 'account.batch.payment', batchRes.id);
  // Lines should ONLY include invoices belonging to Branch (company 2), NOT company 1
  assert.equal(populatedBatch.lines.length, 1, 'Only branch invoice should be added');
  assert.equal(populatedBatch.lines[0].move_id, invBranch.id);

  // Validate the batch via button
  const valBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Validate');
  assert.doesNotThrow(() => {
    db = valBtn.run(db, read(db, 'account.batch.payment', batchRes.id)).db;
  });
  assert.equal(read(db, 'account.batch.payment', batchRes.id).state, 'posted');
});

// ---------------------------------------------------------------------------
// Finding 8: Branch users cannot find their batches
// ---------------------------------------------------------------------------
test('Finding 8: journal-less batch updates company_id to invoice company on post, allowing branch users to find it and match statements', () => {
  try {
    const base = seed();
    const branch = createCompany(base, { name: 'Branch', currency_id: base.settings.base_currency_id });
    let db = write(branch.db, 'res.company', branch.id, {
      outstanding_receipts_account_id: accountId(branch.db, '101402', branch.id),
    });
    const inv = invoice(db, branch.id, 150);
    db = inv.db;

    // Batch created in company 1 (e.g. headquarters context) paying branch invoice
    const batch = create(db, 'account.batch.payment', {
      batch_type: 'inbound',
      company_id: 1,
      date: '2025-01-02',
      lines: [{ move_id: inv.id, amount: 150 }],
    });
    assert.equal(read(batch.db, 'account.batch.payment', batch.id).company_id, 1);

    // Validate the batch payment
    const valBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Validate');
    db = valBtn.run(batch.db, read(batch.db, 'account.batch.payment', batch.id)).db;

    // After posting, journal-less batch's company_id must be kept consistent with its payments (branch.id)
    const postedBatch = read(db, 'account.batch.payment', batch.id);
    assert.equal(postedBatch.company_id, branch.id, 'Batch company_id must be updated to payment company');

    // Branch-only user must be able to find the batch in search
    setActiveCompany(branch.id);
    const branchBatches = search(db, 'account.batch.payment');
    assert.ok(branchBatches.some((b) => b.id === batch.id), 'Branch user must find the batch in company-scoped search');

    // Branch statement line can match the batch
    const stmt = create(db, 'account.bank.statement.line', {
      company_id: branch.id,
      date: '2025-01-03',
      amount: 150,
      payment_ref: 'Branch receipt',
      batch_payment_id: batch.id,
    });
    const matchBtn = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment');
    db = matchBtn.run(stmt.db, read(stmt.db, 'account.bank.statement.line', stmt.id)).db;
    assert.equal(read(db, 'account.bank.statement.line', stmt.id).state, 'reconciled');

    // Inconsistent ownership: if batch record company_id does not match payments company, linking to statement must be rejected
    const inconsistentBatch = write(db, 'account.batch.payment', batch.id, { company_id: 1 });
    assert.throws(
      () => create(inconsistentBatch, 'account.bank.statement.line', {
        company_id: branch.id,
        date: '2025-01-03',
        amount: 150,
        payment_ref: 'Inconsistent receipt',
        batch_payment_id: batch.id,
      }),
      /another company/i,
      'Inconsistent batch company ownership must reject branch statement linking'
    );
  } finally {
    setActiveCompany(null);
  }
});

// ---------------------------------------------------------------------------
// Finding 13: Revenue actions also post expenses
// ---------------------------------------------------------------------------
test('Finding 13: each kind-filtered deferral menu generates only its own kind', () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    deferred_generation_method: 'manual_grouped',
    deferred_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(db, '212000'),
    deferred_expense_account_id: accountId(db, '132000'),
  });

  // Create one revenue schedule and one expense schedule
  const revSchedule = create(db, 'account.deferral', {
    name: 'Rev Schedule',
    kind: 'revenue',
    company_id: 1,
    start_date: '2026-01-01',
    end_date: '2026-01-31',
    state: 'running',
    deferred_account_id: accountId(db, '212000'),
    recognition_account_id: accountId(db, '410000'),
    board: [{ date: '2026-01-31', amount: 100, posted: false, move_id: null }],
  });
  const expSchedule = create(revSchedule.db, 'account.deferral', {
    name: 'Exp Schedule',
    kind: 'expense',
    company_id: 1,
    start_date: '2026-01-01',
    end_date: '2026-01-31',
    state: 'running',
    deferred_account_id: accountId(db, '132000'),
    recognition_account_id: accountId(db, '600000'),
    board: [{ date: '2026-01-31', amount: 50, posted: false, move_id: null }],
  });
  db = expSchedule.db;

  const menus = menusFor('accounting');
  const review = menus.find((m) => m.label === 'Review');
  const regEntries = review.children.find((m) => m.label === 'Regularization Entries');
  const revMenu = regEntries.children.find((m) => m.key === 'deferred-revenues');
  const expMenu = regEntries.children.find((m) => m.key === 'deferred-expenses');

  assert.ok(revMenu, 'deferred-revenues menu exists');
  assert.ok(expMenu, 'deferred-expenses menu exists');

  // The list view runs the model's Generate Entries action with the menu's own defaults.
  const action = models['account.deferral'].listActions.find((x) => x.label === 'Generate Entries');
  const revAction = { run: (d, ids, date) => action.run(d, ids, date, { defaults: revMenu.defaults }) };
  const expAction = { run: (d, ids, date) => action.run(d, ids, date, { defaults: expMenu.defaults }) };

  // Run the revenue list action
  db = revAction.run(db, [], '2026-01-31');

  // Must ONLY post revenue entries (1 grouped + 1 reversal = 2 moves), ZERO expense entries
  const movesAfterRev = search(db, 'account.move').filter((m) => m.is_deferred_grouped);
  assert.equal(movesAfterRev.length, 2, 'Exactly 2 revenue moves created');
  assert.ok(movesAfterRev.every((m) => m.deferral_kind === 'revenue'), 'All posted moves must be revenue');
  assert.equal(search(db, 'account.move').some((m) => m.deferral_kind === 'expense'), false, 'No expense moves posted by revenue menu');

  // Now run the expense list action
  db = expAction.run(db, [], '2026-01-31');

  const movesAfterExp = search(db, 'account.move').filter((m) => m.is_deferred_grouped);
  assert.equal(movesAfterExp.length, 4, '4 moves in total (2 revenue + 2 expense)');
  const expMoves = movesAfterExp.filter((m) => m.deferral_kind === 'expense');
  assert.equal(expMoves.length, 2, 'Exactly 2 expense moves created');
});

// ---------------------------------------------------------------------------
// Finding 14: Locked tax returns lose server-side field locks
// ---------------------------------------------------------------------------
test('Finding 14: non-admin cannot change date_deadline or Studio custom field on submitted return', async () => {
  const { installCustomFields } = await import('./models/studio.js');
  const { diffDb } = await import('./sync.js');
  let db = seed();
  const type = search(db, 'account.return.type').find((t) => t.category !== 'audit');
  assert.ok(type, 'tax return type exists');

  // Install a custom Studio field on account.return
  installCustomFields([{ model: 'account.return', label: 'Custom Audit Tag', type: 'char' }]);
  assert.ok(models['account.return'].fields.x_custom_audit_tag, 'custom field installed in registry');

  // Create, review, and submit a tax return as admin
  const actions = models['account.return'].form.buttons;
  const runBtn = (label, id) => {
    const next = actions.find((action) => action.label === label).run(db, read(db, 'account.return', id)).db;
    db = applyDiff(db, diffDb(db, next), { isAdmin: true });
  };
  const ret = create(db, 'account.return', {
    name: 'VAT 2026-01',
    type_id: type.id,
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    date_deadline: '2026-02-15',
    x_custom_audit_tag: 'Original Tag',
  });
  db = ret.db;
  runBtn('Review', ret.id);
  runBtn('Submit', ret.id);

  const submitted = read(db, 'account.return', ret.id);
  assert.equal(submitted.state, 'submitted');

  const fields = editableFields(models['account.return'], submitted, db);
  assert.ok(fields.includes('date_deadline'), 'editableFields must include date_deadline from function groups');
  assert.ok(fields.includes('x_custom_audit_tag'), 'editableFields must include Studio custom field from function groups');

  // Non-admin attempting to change date_deadline must be rejected
  const nonAdmin = { author: 'TaxClerk', isAdmin: false };
  const deadlineEdit = write(db, 'account.return', ret.id, { date_deadline: '2026-03-01' });
  assert.throws(
    () => applyDiff(db, diffDb(db, deadlineEdit), nonAdmin),
    /locked/i,
    'non-admin cannot change date_deadline on submitted return'
  );

  // Non-admin attempting to change Studio custom field must be rejected
  const customEdit = write(db, 'account.return', ret.id, { x_custom_audit_tag: 'Modified Tag' });
  assert.throws(
    () => applyDiff(db, diffDb(db, customEdit), nonAdmin),
    /locked/i,
    'non-admin cannot change Studio custom field on submitted return'
  );

  // Admin CAN still change them
  assert.doesNotThrow(() => {
    db = applyDiff(db, diffDb(db, deadlineEdit), { author: 'Admin', isAdmin: true });
  });
  assert.equal(read(db, 'account.return', ret.id).date_deadline, '2026-03-01');
});

// ---------------------------------------------------------------------------
// Finding 16: Picking a mismatched return type blocks saving
// ---------------------------------------------------------------------------
test('Finding 16: picking a mismatched return type does not block saving and keeps audit status consistent', () => {
  let db = seed();
  const vatType = search(db, 'account.return.type').find((t) => t.category !== 'audit');
  assert.ok(vatType, 'vat return type exists');

  // Ensure an audit return type exists
  let auditType = search(db, 'account.return.type').find((t) => t.category === 'audit');
  if (!auditType) {
    const created = create(db, 'account.return.type', { name: 'Audit Type', category: 'audit', company_id: 1 });
    db = created.db;
    auditType = read(db, 'account.return.type', created.id);
  }
  assert.ok(auditType, 'audit return type exists');

  const accountingMenus = menusFor('accounting');
  const closingChildren = accountingMenus.find((m) => m.label === 'Accounting').children
    .find((m) => m.label === 'Closing').children;
  const taxLeaf = closingChildren.find((m) => m.key === 'tax-returns');
  const auditChildren = accountingMenus.find((m) => m.label === 'Review').children
    .find((m) => m.label === 'Audit').children;
  const wfLeaf = auditChildren.find((m) => m.key === 'working-files');

  // 1. Picking a VAT type on a working file (starts with leaf.defaults audit_status: 'ongoing')
  // When user selects a VAT return type, onchange clears audit_status so it saves without error
  const wfInitial = newDefaults(db, wfLeaf.model, wfLeaf, new URLSearchParams(), null);
  assert.equal(wfInitial.audit_status, 'ongoing', 'Working Files form defaults audit_status to ongoing');
  const wfChanges = changeFormValue(wfLeaf.model, wfInitial, {}, 'type_id', vatType.id, db);
  assert.equal(wfChanges.audit_status, null, 'onchange clears audit_status when selecting a tax return type');

  const wfValues = {
    ...wfInitial,
    ...wfChanges,
    name: 'VAT from Working File Leaf',
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    company_id: 1,
  };
  let resVat;
  assert.doesNotThrow(() => {
    resVat = saveFormRecord(db, wfLeaf.model, null, wfValues);
  }, 'Saving a VAT type from working files must not throw error');
  db = resVat.db;
  const savedVat = read(db, 'account.return', resVat.id);
  assert.equal(savedVat.type_id, vatType.id);
  assert.equal(savedVat.audit_status, null, 'Audit status must be cleared when a non-audit type is chosen');
  assert.ok(taxLeaf.domain(savedVat, db), 'Saved VAT return belongs to Tax Returns domain');

  // 2. Picking an audit type on Tax Returns (no audit_status in defaults)
  // Must save with audit_status: 'ongoing' so Working Files default filters don't hide it
  const taxInitial = newDefaults(db, taxLeaf.model, taxLeaf, new URLSearchParams(), null);
  assert.equal(taxInitial.audit_status, undefined, 'Tax returns form does not default audit_status');
  const taxChanges = changeFormValue(taxLeaf.model, taxInitial, {}, 'type_id', auditType.id, db);
  assert.equal(taxChanges.audit_status, 'ongoing', 'onchange defaults audit_status to ongoing when audit type chosen');

  const taxValues = {
    ...taxInitial,
    ...taxChanges,
    name: 'Audit from Tax Returns Leaf',
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    company_id: 1,
  };
  const resAudit = saveFormRecord(db, taxLeaf.model, null, taxValues);
  db = resAudit.db;
  const savedAudit = read(db, 'account.return', resAudit.id);
  assert.equal(savedAudit.type_id, auditType.id);
  assert.equal(savedAudit.audit_status, 'ongoing', 'Audit return chosen under Tax Returns must default audit_status to ongoing');
  assert.ok(wfLeaf.domain(savedAudit, db), 'Saved audit return belongs to Working Files domain');

  // Verify default filters ('ongoing', 'paused') match the saved audit record
  const ongoingFilter = models['account.return'].filters[0].find((f) => f.id === 'ongoing');
  assert.ok(ongoingFilter.fn(savedAudit), 'Working Files default Ongoing filter must include the new audit return');

  // 3. Direct create with audit type also defaults audit_status to ongoing via prepareCreate
  const directAudit = create(db, 'account.return', {
    name: 'Direct Audit Return',
    type_id: auditType.id,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    company_id: 1,
  });
  const savedDirect = read(directAudit.db, 'account.return', directAudit.id);
  assert.equal(savedDirect.audit_status, 'ongoing', 'prepareCreate defaults audit_status to ongoing for audit type');
});



