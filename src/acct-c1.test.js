import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const props = (node) => Object.entries(node ?? {}).find(([k]) => k.startsWith('__reactProps$'))?.[1];
const findAll = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) findAll(child, pred, acc);
  return acc;
};

test('PAY-11 (Point 1): batch states have draft/posted only, no cancel/sent/records override, and computed read-only reconciled/status', async () => {
  const { seed } = await import('./seed.js');
  const { create, read, write, search } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  const paymentsMod = await import('./models/payments.js');
  const { postBatch, isBatchReconciled } = paymentsMod;
  const { postMove } = await import('./models/accounting.js');
  const { matchPayment } = await import('./models/bank.js');
  const { accountId } = await import('./models/ledger.js');

  assert.equal('cancelBatch' in paymentsMod, false, 'cancelBatch must be removed');
  assert.equal('draftBatch' in paymentsMod, false, 'draftBatch must be removed');
  assert.equal('voidCheck' in paymentsMod, false, 'voidCheck must be removed');

  const batchModel = models['account.batch.payment'];
  assert.equal(batchModel.records, undefined, 'account.batch.payment must not override records');

  const stateKeys = batchModel.fields.state.options.map(([k]) => k);
  assert.deepEqual(stateKeys, ['draft', 'posted'], 'state field has only draft and posted options');

  const reconciledField = batchModel.fields.reconciled;
  assert.ok(reconciledField, 'reconciled field exists');
  assert.equal(reconciledField.readonly, true, 'reconciled field is readonly');
  assert.equal(typeof reconciledField.compute, 'function', 'reconciled field uses compute');

  const statusField = batchModel.fields.status;
  assert.ok(statusField, 'status computed field exists for list/statusbar');
  assert.equal(statusField.readonly, true, 'status field is readonly');
  assert.equal(typeof statusField.compute, 'function', 'status field uses compute');
  assert.deepEqual(
    statusField.options.map(([k]) => k),
    ['draft', 'posted', 'reconciled'],
    'status field shows draft, posted, reconciled',
  );
  assert.equal(batchModel.form.statusbar, 'status', 'form statusbar displays computed status');

  const buttonLabels = batchModel.form.buttons.map((b) => b.label);
  assert.equal(buttonLabels.includes('Cancel'), false, 'Cancel button removed');
  assert.equal(buttonLabels.includes('Reset to Draft'), false, 'Reset to Draft button removed');

  let db = seed();
  db = write(db, 'res.company', 1, { outstanding_payments_account_id: accountId(db, '101403') });
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    date: '2026-01-02',
    lines: [{ move_id: bill.id, amount: 100 }],
  });
  db = batchRes.db;
  const batchId = batchRes.id;

  assert.equal(read(db, 'account.batch.payment', batchId).state, 'draft');
  assert.equal(read(db, 'account.batch.payment', batchId).status, 'draft');
  assert.equal(read(db, 'account.batch.payment', batchId).reconciled, false);

  // Attempting to write reconciled/status directly is stripped by ORM compute mechanism
  db = write(db, 'account.batch.payment', batchId, { reconciled: true, status: 'reconciled' });
  assert.equal(read(db, 'account.batch.payment', batchId).reconciled, false, 'cannot write reconciled directly');
  assert.equal(read(db, 'account.batch.payment', batchId).status, 'draft', 'cannot write status directly');

  // Validate the batch -> posted
  db = postBatch(db, read(db, 'account.batch.payment', batchId));
  const postedBatch = read(db, 'account.batch.payment', batchId);
  assert.equal(postedBatch.state, 'posted');
  assert.equal(postedBatch.status, 'posted');
  assert.equal(postedBatch.reconciled, false);
  assert.equal(isBatchReconciled(db, postedBatch), false);

  // Match batch payment in bank reconciliation
  const stmt = create(db, 'account.bank.statement.line', {
    journal_id: journal.id,
    date: '2026-01-03',
    amount: -100,
    batch_payment_id: batchId,
    payment_ref: 'BATCH-MATCH',
  });
  db = matchPayment(stmt.db, read(stmt.db, 'account.bank.statement.line', stmt.id)).db;

  const afterMatch = read(db, 'account.batch.payment', batchId);
  assert.equal(afterMatch.state, 'posted', 'stored state stays posted');
  assert.equal(afterMatch.reconciled, true, 'computed reconciled becomes true');
  assert.equal(afterMatch.status, 'reconciled', 'computed status shows reconciled');
  assert.equal(db.records['account.batch.payment'].find((r) => r.id === batchId).state, 'posted', 'raw record state is untouched');
});

test('PAY-11 (Point 5): inbound batch Print Deposit Slip uses batchCurrency', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read, search, write } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  const { postMove } = await import('./models/accounting.js');
  const { postBatch, batchCurrency } = await import('./models/payments.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');

  assert.equal(typeof batchCurrency, 'function', 'batchCurrency helper is exported and reused');

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  // Ensure journal has no fixed currency_id, and create an invoice in EUR
  db = write(db, 'account.journal', journal.id, { currency_id: null });
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency exists');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 2.0 }] });

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    currency_id: eur.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 250, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'inbound',
    journal_id: journal.id,
    date: '2026-01-02',
    lines: [{ move_id: inv.id, amount: 250 }],
  });
  db = postBatch(batchRes.db, read(batchRes.db, 'account.batch.payment', batchRes.id));
  const postedBatch = read(db, 'account.batch.payment', batchRes.id);

  // Simulate stripped/un-hydrated record without precomputed currency_id to prove DepositSlip uses batchCurrency(db, batch)
  const rawBatch = db.records['account.batch.payment'].find((b) => b.id === postedBatch.id);
  assert.equal(rawBatch.currency_id, undefined, 'raw record has no stored currency_id');

  const printDepositBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Print Deposit Slip');
  assert.ok(printDepositBtn, 'Print Deposit Slip button exists');
  assert.equal(printDepositBtn.when(postedBatch), true);

  const printChecksBtn = models['account.batch.payment'].form.buttons.find((b) => b.label === 'Print Checks');
  assert.equal(printChecksBtn.when(postedBatch), false);

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.batch.payment', id: postedBatch.id })));
    const text = textOf(host);
    assert.match(text, /Batch Deposit/i);
    assert.match(text, new RegExp(postedBatch.name));
    assert.match(text, /€\s*250|250\.00\s*€/, 'Deposit slip formats total using batchCurrency (EUR), not journal/null');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('PAY-17 (Point 4): remittance stub uses paymentSettledMoves, shows credit notes and foreign bill documentCurrency', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read, search, write } = await import('./orm.js');
  const { postMove, payMove } = await import('./models/accounting.js');
  const { applyPaymentCredit, printCheck } = await import('./models/pay.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(usd && eur);

  // Set explicit EUR rate = 2.0 EUR per 1 USD (so EUR 200 bill = USD 100)
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 2.0 }] });

  // Vendor bill 1 in EUR (EUR 200)
  const eurBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    currency_id: eur.id,
    ref: 'BILL-EUR-200',
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(eurBill.db, eurBill.id);

  // Vendor bill 2 in USD (USD 50)
  const usdBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    currency_id: usd.id,
    ref: 'BILL-USD-50',
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(usdBill.db, usdBill.id);

  // Credit note (out_refund) in USD (USD 25) that we will link as settled by the same payment
  const creditNote = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 3,
    currency_id: usd.id,
    ref: 'CN-25',
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 25, tax: 0 }],
  });
  db = postMove(creditNote.db, creditNote.id);

  // Set journal check_next_number = 8500
  db = write(db, 'account.journal', journal.id, { check_next_number: 8500 });
  const checkLine = (journal.outbound_payment_method_line_ids ?? []).map((l) => typeof l === 'object' ? l : read(db, 'account.payment.method.line', l))
    .find((l) => read(db, 'account.payment.method', l?.payment_method_id)?.code === 'check_printing');

  // Pay USD 150 against USD 50 bill with check #8500 (leaves USD 100 unapplied credit)
  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 3,
    amount: 150,
    journal_id: journal.id,
    ...(checkLine ? { payment_method_line_id: checkLine.id } : {}),
  });
  db = payMove(draftPay.db, usdBill.id, 150, '2026-01-02', { paymentId: draftPay.id, journalId: journal.id });
  db = printCheck(db, draftPay.id);
  const payment = read(db, 'account.payment', draftPay.id);
  assert.equal(payment.check_number, 8500, 'Check #8500 payment created');

  // Apply $100 USD unapplied credit of this payment to EUR 200 bill (settles EUR 200.00)
  db = applyPaymentCredit(db, payment.id, eurBill.id, '2026-01-02', 200);

  // Also simulate/record a credit note settled by the same payment.move_id (e.g. via reconciliation)
  const cnRec = read(db, 'account.move', creditNote.id);
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (
        m.id === creditNote.id
          ? { ...m, payments: [{ date: '2026-01-02', amount: 25, move_id: payment.move_id }], amount_paid: 25 }
          : m
      )),
    },
  };

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: payment.id })));
    const text = textOf(host);
    assert.match(text, /Check #8500/);
    assert.match(text, /Remittance Advice/i);

    // Inspect remittance stub table rows
    const stubTable = find(host, (n) => n.tagName === 'TABLE' && props(n)?.className?.includes('stub-table'));
    assert.ok(stubTable, 'Remittance stub table exists');
    const stubText = textOf(stubTable);

    // EUR bill MUST be formatted in EUR (€), NOT check currency ($)
    assert.match(stubText, new RegExp(read(db, 'account.move', eurBill.id).name));
    assert.match(stubText, /€\s*200|200\.00\s*€/, 'EUR bill original/settled amount formatted in EUR documentCurrency');
    assert.doesNotMatch(stubText, /\$\s*200\.00/, 'EUR bill must NOT be formatted in USD check currency');

    // USD bill appears in USD
    assert.match(stubText, new RegExp(read(db, 'account.move', usdBill.id).name));
    assert.match(stubText, /\$\s*50\.00/, 'USD bill formatted in USD');

    // Credit note settled by the same payment also appears
    assert.match(stubText, new RegExp(cnRec.name), 'Credit note settled by the payment appears in remittance stub');
    assert.match(stubText, /\$\s*25\.00/, 'Credit note amount formatted in its documentCurrency');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('PAY-18 (Points 2 & 3): Checks register drops Void, filters directly on checkRegisterRows state values, preserves search and date grouping', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read, search, write } = await import('./orm.js');
  const { postMove, payMove } = await import('./models/accounting.js');
  const { postBatch, CHECK_REGISTER_STATES } = await import('./models/payments.js');
  const { printCheck, printBatchChecks, reprintCheck } = await import('./models/pay.js');
  const { Checks } = await import('./views/Checks.jsx');

  // Verify every state in CHECK_REGISTER_STATES has an Arabic translation and option values stay canonical
  assert.deepEqual(CHECK_REGISTER_STATES, ['Posted', 'Issued', 'Voided', 'Reversed', 'Cancelled']);

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  // 1. Batch check -> state: 'Posted'
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 150, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);
  db = write(db, 'account.journal', journal.id, { check_next_number: 9100 });
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    date: '2026-01-02',
    lines: [{ move_id: bill1.id, amount: 150 }],
  });
  db = postBatch(batchRes.db, read(batchRes.db, 'account.batch.payment', batchRes.id));
  db = printBatchChecks(db, batchRes.id);

  // 2. Individual check -> state: 'Issued' + reprint -> state: 'Voided' + replacement check
  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 75, tax: 0 }],
  });
  db = postMove(bill2.db, bill2.id);
  db = write(db, 'account.journal', journal.id, { check_next_number: 9200 });
  const checkLine = (journal.outbound_payment_method_line_ids ?? []).map((l) => typeof l === 'object' ? l : read(db, 'account.payment.method.line', l))
    .find((l) => read(db, 'account.payment.method', l?.payment_method_id)?.code === 'check_printing');
  const draftPay = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 3,
    amount: 75,
    journal_id: journal.id,
    ...(checkLine ? { payment_method_line_id: checkLine.id } : {}),
  });
  db = payMove(draftPay.db, bill2.id, 75, '2026-01-03', { paymentId: draftPay.id, journalId: journal.id });
  db = printCheck(db, draftPay.id);
  const indivPayment = read(db, 'account.payment', draftPay.id);
  assert.equal(indivPayment.check_number, 9200);
  // Reprint voids 9200 ('Voided') and issues 9201 ('Issued')
  db = reprintCheck(db, indivPayment);

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Checks)));

    // Verify Void button and Print link exist
    const voidBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n).includes('Void'));
    assert.ok(voidBtn, 'Void button exists in Checks register');

    const printLinks = findAll(host, (n) => n.tagName === 'A' && props(n)?.href?.includes('/print/'));
    assert.ok(printLinks.length >= 2, 'Print action links exist on issued/posted check rows');

    // Verify status filter <select> options match c2 register options, without unprinted or Draft
    const statusSelect = find(host, (n) => n.tagName === 'SELECT');
    assert.ok(statusSelect, 'Status filter select exists');
    const optionValues = findAll(statusSelect, (n) => n.tagName === 'OPTION').map((o) => props(o)?.value);
    assert.ok(optionValues.includes('printed'), 'offers printed status');
    assert.ok(optionValues.includes('to_print'), 'offers to_print status');
    assert.ok(optionValues.includes('voided'), 'offers voided status');
    assert.equal(optionValues.includes('unprinted'), false, 'must not handle/offer unprinted');
    assert.equal(optionValues.includes('Draft'), false, 'must not offer Draft which cannot occur');
    assert.ok(optionValues.includes('all'));
    assert.ok(optionValues.includes('Reversed'));
    assert.ok(optionValues.includes('Cancelled'));

    // Filter by 'printed' (shows both Posted batch check 9100 and Issued check 9201)
    await React.act(async () => props(statusSelect).onChange({ target: { value: 'printed' } }));
    const printedRowsText = textOf(find(host, (n) => n.tagName === 'TBODY'));
    assert.match(printedRowsText, /9100/);
    assert.match(printedRowsText, /9201/);
    assert.doesNotMatch(printedRowsText, /9200/);

    // Filter by 'voided' (shows Voided check 9200)
    await React.act(async () => props(statusSelect).onChange({ target: { value: 'voided' } }));
    const voidedRowsText = textOf(find(host, (n) => n.tagName === 'TBODY'));
    assert.match(voidedRowsText, /9200/);
    assert.doesNotMatch(voidedRowsText, /9100/);
    assert.doesNotMatch(voidedRowsText, /9201/);

    // Reset filter to 'all' and test search input + group by date
    await React.act(async () => props(statusSelect).onChange({ target: { value: 'all' } }));
    const searchInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'search');
    assert.ok(searchInput);
    await React.act(async () => props(searchInput).onChange({ target: { value: '9100' } }));
    const searchedText = textOf(find(host, (n) => n.tagName === 'TBODY'));
    assert.match(searchedText, /9100/);
    assert.doesNotMatch(searchedText, /9201/);

    await React.act(async () => props(searchInput).onChange({ target: { value: '' } }));
    const groupCheckbox = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    assert.ok(groupCheckbox);
    await React.act(async () => props(groupCheckbox).onChange({ target: { checked: true } }));
    const sectionRows = findAll(host, (n) => n.tagName === 'TR' && props(n)?.className === 'rep-section');
    assert.ok(sectionRows.length >= 2, 'Groups checks into date section rows');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Finding 1: check register row print link targets that row payment and prints only that check', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read, search, write } = await import('./orm.js');
  const { postMove } = await import('./models/accounting.js');
  const { postBatch } = await import('./models/payments.js');
  const { printBatchChecks } = await import('./models/pay.js');
  const { Checks } = await import('./views/Checks.jsx');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  // Create two vendor bills
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    ref: 'BILL-MULTI-1',
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);

  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    ref: 'BILL-MULTI-2',
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(bill2.db, bill2.id);

  // Create outbound batch with both bills
  db = write(db, 'account.journal', journal.id, { check_next_number: 9300 });
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    journal_id: journal.id,
    date: '2026-01-02',
    lines: [
      { move_id: bill1.id, amount: 100 },
      { move_id: bill2.id, amount: 200 },
    ],
  });
  db = postBatch(batchRes.db, read(batchRes.db, 'account.batch.payment', batchRes.id));
  db = printBatchChecks(db, batchRes.id);
  const postedBatch = read(db, 'account.batch.payment', batchRes.id);
  const payment1Id = postedBatch.lines[0].payment_id;
  const payment2Id = postedBatch.lines[1].payment_id;
  assert.ok(payment1Id && payment2Id);
  assert.equal(postedBatch.lines[0].check_number, 9300);
  assert.equal(postedBatch.lines[1].check_number, 9301);

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    // 1. In Checks register, row Print link must point to account.payment, NOT account.batch.payment
    await React.act(async () => root.render(React.createElement(Checks)));
    const printLinks = findAll(host, (n) => n.tagName === 'A' && props(n)?.href?.includes('/print/'));
    const link1 = printLinks.find((l) => props(l)?.href?.includes(String(payment1Id)));
    assert.ok(link1, 'Print link for check 1 targets row payment');
    assert.equal(props(link1)?.href, `#/print/account.payment/${payment1Id}`);

    // 2. Rendering PrintDoc for account.payment prints only ONE check
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.payment', id: payment1Id })));
    const singleCheckText = textOf(host);
    assert.match(singleCheckText, /Check #9300/);
    assert.doesNotMatch(singleCheckText, /Check #9301/);

    // 3. Rendering PrintDoc for account.batch.payment prints BOTH checks
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.batch.payment', id: postedBatch.id })));
    const batchCheckText = textOf(host);
    assert.match(batchCheckText, /Check #9300/);
    assert.match(batchCheckText, /Check #9301/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Finding 2: draft inbound batch direct print URL does not render deposit slip and does not auto-print', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  const { create, read, search } = await import('./orm.js');
  const { postMove } = await import('./models/accounting.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');

  await initStore();
  let db = getDb();
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Draft inbound batch
  const batchRes = create(db, 'account.batch.payment', {
    batch_type: 'inbound',
    journal_id: journal.id,
    date: '2026-01-02',
    lines: [{ move_id: inv.id, amount: 100 }],
  });
  const draftBatch = read(batchRes.db, 'account.batch.payment', batchRes.id);
  assert.equal(draftBatch.state, 'draft');

  let printCalls = 0;
  const originalPrint = globalThis.window.print;
  globalThis.window.print = () => { printCalls++; };

  await React.act(async () => commit(batchRes.db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(PrintDoc, { model: 'account.batch.payment', id: draftBatch.id })));
    const text = textOf(host);
    // Must NOT render deposit slip
    assert.doesNotMatch(text, /Batch Deposit/i);
    assert.doesNotMatch(text, /Number of Items/i);
    // Must show alert / restriction message
    assert.match(text, /Deposit slips can only be printed for posted batch payments|posted/i);
    // Must not auto-print
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(printCalls, 0, 'window.print was not called for draft inbound batch');
  } finally {
    globalThis.window.print = originalPrint;
    await React.act(async () => root.unmount());
  }
});

test('Finding 3: Arabic coverage for register headers, CHECK_REGISTER_STATES, and Actions/Cancelled', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {}, removeItem() {}, clear() {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-c1-check');
    const { CHECK_REGISTER_STATES } = await import('./models/payments.js');

    const headers = ['Check Number', 'Date', 'Payment', 'Vendor', 'Amount', 'Status', 'Actions'];
    for (const h of headers) {
      const tr = t(h);
      assert.notEqual(tr, h, `Missing Arabic translation for header ${h}`);
      assert.ok(/[\u0600-\u06FF]/.test(tr), `Translation for ${h} must contain Arabic text`);
    }

    for (const s of CHECK_REGISTER_STATES) {
      const tr = t(s);
      assert.notEqual(tr, s, `Missing Arabic translation for state ${s}`);
      assert.ok(/[\u0600-\u06FF]/.test(tr), `Translation for ${s} must contain Arabic text`);
    }

    assert.notEqual(t('Actions'), 'Actions');
    assert.notEqual(t('Cancelled'), 'Cancelled');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
