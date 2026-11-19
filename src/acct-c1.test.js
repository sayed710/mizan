import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const props = (node) => Object.entries(node ?? {}).find(([k]) => k.startsWith('__reactProps$'))?.[1];

test('PAY-11: account.batch.payment state options, cancel, draft, and reconciled compute', async () => {
  const { seed } = await import('./seed.js');
  const { create, read, write, search } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  const { postBatch, cancelBatch, draftBatch } = await import('./models/payments.js');
  const { postMove } = await import('./models/accounting.js');
  const { matchPayment } = await import('./models/bank.js');
  const { accountId } = await import('./models/ledger.js');

  let db = seed();
  db = write(db, 'res.company', 1, { outstanding_payments_account_id: accountId(db, '101403') });
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  // Verify state options on account.batch.payment model definition
  const stateField = models['account.batch.payment'].fields.state;
  const stateKeys = stateField.options.map(([k]) => k);
  assert.ok(stateKeys.includes('draft'), 'has draft state');
  assert.ok(stateKeys.includes('posted'), 'has posted state');
  assert.ok(stateKeys.includes('sent'), 'has sent state');
  assert.ok(stateKeys.includes('reconciled'), 'has reconciled state');
  assert.ok(stateKeys.includes('cancel'), 'has cancel state');

  // Create a vendor bill
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  // Create a draft outbound batch
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    check_number_start: 500,
    date: '2026-01-02',
    lines: [{ move_id: bill.id, amount: 100 }],
  });
  db = batchRes.db;
  const batchId = batchRes.id;
  assert.equal(read(db, 'account.batch.payment', batchId).state, 'draft');

  // Form buttons on draft include Cancel
  const cancelBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Cancel');
  assert.ok(cancelBtn, 'Cancel button exists on batch payment form');
  assert.equal(cancelBtn.when(read(db, 'account.batch.payment', batchId)), true, 'Cancel button visible in draft');

  // Cancel in draft
  db = cancelBatch(db, read(db, 'account.batch.payment', batchId));
  assert.equal(read(db, 'account.batch.payment', batchId).state, 'cancel');

  // Reset to draft
  const resetBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Reset to Draft');
  assert.ok(resetBtn, 'Reset to Draft button exists on batch payment form');
  assert.equal(resetBtn.when(read(db, 'account.batch.payment', batchId)), true, 'Reset to Draft visible in cancel');
  db = draftBatch(db, read(db, 'account.batch.payment', batchId));
  assert.equal(read(db, 'account.batch.payment', batchId).state, 'draft');

  // Validate the batch
  db = postBatch(db, read(db, 'account.batch.payment', batchId));
  assert.equal(read(db, 'account.batch.payment', batchId).state, 'posted');

  // Cancel button visible on posted batch (unreconciled)
  assert.equal(cancelBtn.when(read(db, 'account.batch.payment', batchId)), true, 'Cancel button visible when posted');

  // Match batch payment in bank reconciliation
  const paymentId = read(db, 'account.batch.payment', batchId).lines[0].payment_id;
  assert.ok(paymentId, 'batch has payment_id');
  const stmt = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    date: '2026-01-03',
    amount: -100,
    batch_payment_id: batchId,
    payment_ref: 'BATCH-MATCH',
  });
  const matchResult = matchPayment(stmt.db, read(stmt.db, 'account.bank.statement.line', stmt.id));
  db = matchResult.db;

  // Once matched, batch state computes to reconciled
  const reconciledBatch = read(db, 'account.batch.payment', batchId);
  assert.equal(reconciledBatch.state, 'reconciled', 'Batch transitions to reconciled once payments are matched');

  // Reconciled batch cannot be cancelled
  assert.throws(
    () => cancelBatch(db, reconciledBatch),
    /reconciled/i,
    'Cannot cancel a batch with reconciled payments',
  );
});

test('PAY-11: inbound batch has Print Deposit Slip button and renders Batch Deposit Slip in PrintDoc', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read, search } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  const { postMove } = await import('./models/accounting.js');
  const { postBatch } = await import('./models/payments.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  // Customer invoice
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 250, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Inbound batch
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'inbound',
    journal_id: journal.id,
    date: '2026-01-02',
    lines: [{ move_id: inv.id, amount: 250 }],
  });
  db = postBatch(batchRes.db, read(batchRes.db, 'account.batch.payment', batchRes.id));
  const postedBatch = read(db, 'account.batch.payment', batchRes.id);

  // Check buttons
  const printDepositBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Print Deposit Slip');
  assert.ok(printDepositBtn, 'Print Deposit Slip button exists on batch payment form');
  assert.equal(printDepositBtn.when(postedBatch), true, 'Print Deposit Slip visible on posted inbound batch');

  // Outbound checks button not visible on inbound batch
  const printChecksBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Print Checks');
  assert.equal(printChecksBtn.when(postedBatch), false, 'Print Checks not visible on inbound batch');

  // Render PrintDoc for inbound batch
  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.batch.payment', id: postedBatch.id })));
    const text = textOf(host);
    assert.match(text, /Batch Deposit/i, 'Renders Batch Deposit title');
    assert.match(text, new RegExp(postedBatch.name), 'Renders batch reference');
    assert.match(text, /Customer/i, 'Renders Customer column');
    assert.match(text, /Payment Reference|Payment/i, 'Renders Payment Reference column');
    assert.match(text, /250/, 'Renders deposit amount');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('PAY-17: check printing includes remittance voucher stub with bill details', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read, search } = await import('./orm.js');
  const { postMove } = await import('./models/accounting.js');
  const { postBatch } = await import('./models/payments.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  // Vendor bill
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    ref: 'BILL-REM-001',
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 180, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  // Outbound batch
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    check_number_start: 8000,
    date: '2026-01-02',
    lines: [{ move_id: bill.id, amount: 180 }],
  });
  db = postBatch(batchRes.db, read(batchRes.db, 'account.batch.payment', batchRes.id));
  const postedBatch = read(db, 'account.batch.payment', batchRes.id);

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.batch.payment', id: postedBatch.id })));
    const text = textOf(host);
    assert.match(text, /Check #8000/, 'Renders check number');
    assert.match(text, /Remittance Advice|Remittance/i, 'Renders remittance voucher stub');
    assert.match(text, /Bill|Invoice/i, 'Stub has bill/invoice header');
    assert.match(text, /Original Amount/i, 'Stub has original amount header');
    assert.match(text, /Net Payment|Amount Paid/i, 'Stub has net payment header');
    assert.match(text, /180/, 'Stub shows payment amount');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('PAY-18: Checks register supports search, status filtering, date grouping, and direct voiding', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read, search } = await import('./orm.js');
  const { postMove } = await import('./models/accounting.js');
  const { postBatch, voidCheck } = await import('./models/payments.js');
  const { Checks } = await import('./views/Checks.jsx');

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  // Vendor bill 1
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    ref: 'BILL-CHK-1',
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 150, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);

  // Outbound batch
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    check_number_start: 9100,
    date: '2026-01-02',
    lines: [{ move_id: bill1.id, amount: 150 }],
  });
  db = postBatch(batchRes.db, read(batchRes.db, 'account.batch.payment', batchRes.id));
  const postedBatch = read(db, 'account.batch.payment', batchRes.id);
  const paymentId = postedBatch.lines[0].payment_id;

  // Direct voidCheck helper tests
  const paymentBeforeVoid = read(db, 'account.payment', paymentId);
  assert.equal(paymentBeforeVoid.check_number, 9100);

  // Void the check
  const voidedDb = voidCheck(db, paymentId, 9100);

  // Verify batch line is marked cancelled
  const batchAfterVoid = read(voidedDb, 'account.batch.payment', postedBatch.id);
  assert.equal(batchAfterVoid.lines[0].cancelled, true, 'Batch line cancelled after void');

  // Render Checks component with initial unvoided check
  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Checks)));

    // Verify search input, status filter select, and group-by-date checkbox exist
    const searchInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'search');
    assert.ok(searchInput, 'Search input exists in Checks view');

    const statusSelect = find(host, (n) => n.tagName === 'SELECT');
    assert.ok(statusSelect, 'Status filter select exists in Checks view');

    const groupByCheckbox = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    assert.ok(groupByCheckbox, 'Group by date checkbox exists in Checks view');

    // Verify Print and Void actions exist on row
    const printLink = find(host, (n) => n.tagName === 'A' && props(n)?.href?.includes('/print/'));
    assert.ok(printLink, 'Print action link exists on check row');

    const voidBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n).includes('Void'));
    assert.ok(voidBtn, 'Void action button exists on check row');

    // Clicking Void button invokes voidCheck and updates the store
    await React.act(async () => props(voidBtn)?.onClick());
    const storeBatch = read(getDb(), 'account.batch.payment', postedBatch.id);
    assert.equal(storeBatch.lines[0].cancelled, true, 'Check 9100 batch line cancelled through UI action');
  } finally {
    await React.act(async () => root.unmount());
  }
});
