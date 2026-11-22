import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { customerPaymentView, vendorPaymentView, postPayment, issueCheckNumber } from './models/pay.js';
import { postPayments, printPaymentsChecks, printChecksListAction } from './models/payments.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const today = () => new Date().toISOString().slice(0, 10);
const props = (node) => Object.entries(node ?? {}).find(([k]) => k.startsWith('__reactProps$'))?.[1];

const findAll = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) findAll(child, pred, acc);
  return acc;
};

test('PAY8-1: Customer and Vendor Payments lists expose Validate and Print Checks list actions', () => {
  assert.ok(customerPaymentView.listActions, 'customerPaymentView should have listActions');
  assert.ok(vendorPaymentView.listActions, 'vendorPaymentView should have listActions');

  const custValidate = customerPaymentView.listActions.find((a) => a.label === 'Validate');
  const custPrint = customerPaymentView.listActions.find((a) => a.label === 'Print Checks');
  assert.ok(custValidate, 'customerPaymentView must expose Validate list action');
  assert.ok(custPrint, 'customerPaymentView must expose Print Checks list action');
  assert.equal(custValidate.requiresSelection, true);
  assert.equal(custPrint.requiresSelection, true);

  const vendValidate = vendorPaymentView.listActions.find((a) => a.label === 'Validate');
  const vendPrint = vendorPaymentView.listActions.find((a) => a.label === 'Print Checks');
  assert.ok(vendValidate, 'vendorPaymentView must expose Validate list action');
  assert.ok(vendPrint, 'vendorPaymentView must expose Print Checks list action');
  assert.equal(vendValidate.requiresSelection, true);
  assert.equal(vendPrint.requiresSelection, true);
});

test('PAY8-1: bulk Validate posts selected draft payments and diff-verifies guards', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const partner = search(db, 'res.partner')[0];

  const pay1 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 150,
    journal_id: bank.id,
    date: today(),
    state: 'draft',
  });
  db = pay1.db;

  const pay2 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 250,
    journal_id: bank.id,
    date: today(),
    state: 'draft',
  });
  db = pay2.db;

  assert.equal(read(db, 'account.payment', pay1.id).state, 'draft');
  assert.equal(read(db, 'account.payment', pay2.id).state, 'draft');

  const nextDb = postPayments(db, [pay1.id, pay2.id]);

  assert.equal(read(nextDb, 'account.payment', pay1.id).state, 'posted');
  assert.equal(read(nextDb, 'account.payment', pay2.id).state, 'posted');

  // Diff-verifiable through diffDb + applyDiff
  const synced = applyDiff(db, diffDb(db, nextDb), { isAdmin: true });
  assert.equal(read(synced, 'account.payment', pay1.id).state, 'posted');
  assert.equal(read(synced, 'account.payment', pay2.id).state, 'posted');
  assert.throws(() => postPayments(synced, [pay1.id, pay2.id]), /Only draft payments/);
  assert.throws(() => postPayments(db, [pay1.id, 999999]), /Payment not found/);
  const mixed = applyDiff(db, diffDb(db, postPayments(db, [pay1.id])), { isAdmin: true });
  assert.throws(() => postPayments(mixed, [pay1.id, pay2.id]), /Only draft payments/);
  assert.equal(read(mixed, 'account.payment', pay2.id).state, 'draft');
});

test('PAY8-1: bulk Print Checks numbers selected check payments, advances journal sequence, and navigates to print', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 50, check_manual_sequencing: false });
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  // Create two draft check payments
  const pay1 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 300,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    date: today(),
    state: 'draft',
  });
  db = pay1.db;

  const pay2 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 400,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    date: today(),
    state: 'draft',
  });
  db = pay2.db;

  // Run printPaymentsChecks: should validate drafts first, then number sequentially
  const res = printPaymentsChecks(db, [pay1.id, pay2.id], { next_check_number: 50 });
  const nextDb = res.db;

  const p1 = read(nextDb, 'account.payment', pay1.id);
  const p2 = read(nextDb, 'account.payment', pay2.id);
  assert.equal(p1.state, 'posted', 'Draft payments must be posted when printing checks');
  assert.equal(p2.state, 'posted', 'Draft payments must be posted when printing checks');
  assert.equal(p1.check_number, 50);
  assert.equal(p1.check_printed, true);
  assert.equal(p2.check_number, 51);
  assert.equal(p2.check_printed, true);

  const updatedBank = read(nextDb, 'account.journal', bank.id);
  assert.equal(updatedBank.check_next_number, 52);

  assert.ok(res.go.includes(String(pay1.id)));
  assert.ok(res.go.includes(String(pay2.id)));

  // Diff-verifiable through diffDb + applyDiff
  const synced = applyDiff(db, diffDb(db, nextDb), { isAdmin: true });
  assert.equal(read(synced, 'account.payment', pay1.id).check_number, 50);
  assert.equal(read(synced, 'account.payment', pay2.id).check_number, 51);
});

test('PAY8-1: bulk Print Checks refuses payments across mixed journals', () => {
  let db = seed();
  const bank1 = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const bank2 = create(db, 'account.journal', {
    name: 'Second Bank',
    code: 'BNK2',
    type: 'bank',
    company_id: 1,
    suspense_account_id: bank1.suspense_account_id,
    default_account_id: bank1.default_account_id,
    check_next_number: 1,
  });
  db = bank2.db;

  const checkLine1 = bank1.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const pay1 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 100,
    journal_id: bank1.id,
    payment_method_line_id: checkLine1.id,
    date: today(),
    state: 'draft',
  });
  db = pay1.db;

  const pay2 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 200,
    journal_id: bank2.id,
    date: today(),
    state: 'draft',
  });
  db = pay2.db;

  assert.throws(
    () => printPaymentsChecks(db, [pay1.id, pay2.id]),
    /Selected payments must belong to the same journal/
  );
  assert.throws(() => printChecksListAction.wizard(db, [pay1.id, pay2.id]), /Selected payments must belong to the same journal/);
  assert.throws(() => printPaymentsChecks(db, [pay1.id], 50), /Invalid wizard values/);
});

test('PAY8-2: Checks view renders row selection checkboxes and select-all', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { Checks } = await import('./views/Checks.jsx');
  await initStore();

  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const pay1 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 110,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    date: today(),
    state: 'draft',
  });
  db = postPayment(pay1.db, read(pay1.db, 'account.payment', pay1.id));
  db = issueCheckNumber(db, read(db, 'account.payment', pay1.id), { number: 101 });

  const pay2 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 220,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    date: today(),
    state: 'draft',
  });
  db = postPayment(pay2.db, read(pay2.db, 'account.payment', pay2.id));
  db = issueCheckNumber(db, read(db, 'account.payment', pay2.id), { number: 102 });

  commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(Checks));
  });

  // Table header must have select-all checkbox
  const thCheck = find(host, (n) => n.tagName === 'TH' && n.className === 'check');
  assert.ok(thCheck, 'Checks table header must have a th.check');
  const selectAll = find(thCheck, (n) => n.tagName === 'INPUT');
  assert.ok(selectAll, 'Must have select-all checkbox in header');

  // Table body rows must have checkboxes
  const rowCheckboxes = findAll(host, (n) => n.tagName === 'TD' && n.className === 'check');
  assert.equal(rowCheckboxes.length, 2, 'Each check row must have a td.check');

  // Select all rows to verify bulk action buttons appear
  await React.act(async () => {
    props(selectAll)?.onChange?.({ target: { checked: true } });
  });

  // Bulk action buttons must exist when rows are selected
  const printBtn = find(host, (n) => n.tagName === 'BUTTON' && (n.textContent === 'Print' || n.title === 'Print Checks' || n.getAttribute?.('title') === 'Print Checks'));
  const voidBtn = find(host, (n) => n.tagName === 'BUTTON' && (n.textContent === 'Void' || n.title === 'Void Checks' || n.getAttribute?.('title') === 'Void Checks'));
  assert.ok(printBtn, 'Must render bulk Print button when rows are selected');
  assert.ok(voidBtn, 'Must render bulk Void button when rows are selected');

  await React.act(async () => {
    root.unmount();
  });
});

test('PAY8-2: Checks view bulk Print prints selected checks and navigates to print route', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Checks } = await import('./views/Checks.jsx');
  await initStore();

  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_next_number: 301, check_manual_sequencing: false });
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  // Two posted check payments without check numbers yet (state 'To Print')
  const pay1 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 110,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    date: today(),
    state: 'draft',
  });
  db = postPayment(pay1.db, read(pay1.db, 'account.payment', pay1.id));

  const pay2 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 220,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    date: today(),
    state: 'draft',
  });
  db = postPayment(pay2.db, read(pay2.db, 'account.payment', pay2.id));

  commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(Checks));
  });

  // Select all rows
  const thCheck = find(host, (n) => n.tagName === 'TH' && n.className === 'check');
  const selectAll = find(thCheck, (n) => n.tagName === 'INPUT');
  await React.act(async () => {
    props(selectAll)?.onChange?.({ target: { checked: true } });
  });

  // Click bulk Print button
  const printBtn = find(host, (n) => n.tagName === 'BUTTON' && (n.textContent.includes('Print') || n.title?.includes('Print')));
  assert.ok(printBtn, 'Bulk Print button must exist');
  await React.act(async () => {
    props(printBtn)?.onClick?.();
  });

  const updatedDb = getDb();
  const p1 = read(updatedDb, 'account.payment', pay1.id);
  const p2 = read(updatedDb, 'account.payment', pay2.id);

  assert.equal(p1.check_number, 301);
  assert.equal(p1.check_printed, true);
  assert.equal(p2.check_number, 302);
  assert.equal(p2.check_printed, true);
  assert.ok(window.location.hash.includes(String(pay1.id)));
  assert.ok(window.location.hash.includes(String(pay2.id)));

  // Verify sync guards
  const synced = applyDiff(db, diffDb(db, updatedDb), { isAdmin: true });
  assert.equal(read(synced, 'account.payment', pay1.id).check_number, 301);
  assert.equal(read(synced, 'account.payment', pay2.id).check_number, 302);

  await React.act(async () => {
    root.unmount();
  });
});

test('PAY8-2: Checks view bulk Void voids selected checks and diff-verifies guards', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Checks } = await import('./views/Checks.jsx');
  await initStore();

  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing'
  );
  const partner = search(db, 'res.partner')[0];

  const pay1 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 110,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    date: today(),
    state: 'draft',
  });
  db = postPayment(pay1.db, read(pay1.db, 'account.payment', pay1.id));
  db = issueCheckNumber(db, read(db, 'account.payment', pay1.id), { number: 201 });

  const pay2 = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount: 220,
    journal_id: bank.id,
    payment_method_line_id: checkLine.id,
    date: today(),
    state: 'draft',
  });
  db = postPayment(pay2.db, read(pay2.db, 'account.payment', pay2.id));
  db = issueCheckNumber(db, read(db, 'account.payment', pay2.id), { number: 202 });

  commit(db);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(Checks));
  });

  // Select all rows
  const thCheck = find(host, (n) => n.tagName === 'TH' && n.className === 'check');
  const selectAll = find(thCheck, (n) => n.tagName === 'INPUT');
  await React.act(async () => {
    props(selectAll)?.onChange?.({ target: { checked: true } });
  });

  // Click bulk Void button
  const voidBtn = find(host, (n) => n.tagName === 'BUTTON' && (n.textContent.includes('Void') || n.title?.includes('Void')));
  assert.ok(voidBtn, 'Bulk Void button must exist');
  await React.act(async () => {
    props(voidBtn)?.onClick?.();
  });

  const updatedDb = getDb();
  const p1 = read(updatedDb, 'account.payment', pay1.id);
  const p2 = read(updatedDb, 'account.payment', pay2.id);

  assert.equal(p1.check_printed, false, 'Voided check payment must have check_printed false');
  assert.equal(p2.check_printed, false, 'Voided check payment must have check_printed false');
  assert.ok((p1.voided_check_numbers ?? []).some((v) => v.check_number === 201), 'Check 201 must be recorded in voided_check_numbers');
  assert.ok((p2.voided_check_numbers ?? []).some((v) => v.check_number === 202), 'Check 202 must be recorded in voided_check_numbers');

  // Verify sync guards
  const synced = applyDiff(db, diffDb(db, updatedDb), { isAdmin: true });
  assert.ok((read(synced, 'account.payment', pay1.id).voided_check_numbers ?? []).some((v) => v.check_number === 201));
  assert.ok((read(synced, 'account.payment', pay2.id).voided_check_numbers ?? []).some((v) => v.check_number === 202));

  await React.act(async () => {
    root.unmount();
  });
});

test('PAY8-i18n: Arabic translations exist for all PAY8 labels and errors', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {}, removeItem() {}, clear() {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-pay8');
    const strings = [
      'Validate',
      'Print Checks',
      'Print',
      'Void',
      'Void Checks',
      'Selected payments must belong to the same journal',
      'Only draft payments can be confirmed',
      'Only posted outbound payments can be printed',
      'Only issued checks can be voided',
      'Payment does not pay by check',
      'Checks require a bank journal',
    ];

    for (const s of strings) {
      const translated = t(s);
      assert.ok(translated, `Translation must exist for: ${s}`);
      assert.notEqual(translated, s, `Translation must not be identity for: ${s}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
