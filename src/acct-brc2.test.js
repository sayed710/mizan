import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { bookToAccount, matchPayment, reconcileWith, setStatementLineReview, statementCounterpartAccount, unreconcile } from './models/bank.js';
import { postMove } from './models/accounting.js';
import { models } from './models/index.js';
import { applyRule } from './models/reconcile.js';
import { diffDb, applyDiff } from './sync.js';
import { find, setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

function fixture() {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const statement = create(db, 'account.bank.statement', { name: 'Statement actions', journal_id: journal.id, date: '2026-10-01', balance_start: 10, balance_end_real: 110 });
  const partner = search(statement.db, 'res.partner')[0];
  const line = create(statement.db, 'account.bank.statement.line', { statement_id: statement.id, journal_id: journal.id, company_id: 1, partner_id: partner.id, date: '2026-10-01', payment_ref: 'Action line', amount: 100, state: 'to_check' });
  db = line.db;
  return { db, lineId: line.id, statementId: statement.id };
}

test('counterpart choices resolve company settings, require a partner, and post the partner account', () => {
  let { db, lineId } = fixture();
  let line = read(db, 'account.bank.statement.line', lineId);
  const company = read(db, 'res.company', 1);
  assert.equal(statementCounterpartAccount(db, line, 'receivable'), company.account_default_receivable_id);
  assert.equal(statementCounterpartAccount(db, line, 'payable'), company.account_default_payable_id);
  assert.throws(() => statementCounterpartAccount(db, line, 'transfer'), /Internal transfer account/);
  const transfer = create(db, 'account.account', { code: '199998', name: 'Transfers', account_type: 'asset_current', company_id: 1, reconcile: true });
  db = write(transfer.db, 'res.company', 1, { transfer_account_id: transfer.id });
  assert.equal(statementCounterpartAccount(db, line, 'transfer'), transfer.id);
  assert.throws(() => bookToAccount(db, { ...line, partner_id: null, counterpart_account_id: company.account_default_receivable_id }), /valid counterpart/);
  const beforeBooking = db;
  db = bookToAccount(db, { ...line, counterpart_account_id: company.account_default_receivable_id }).db;
  const bookedId = read(db, 'account.bank.statement.line', lineId).bank_move_id;
  const forged = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((move) => move.id !== bookedId ? move : { ...move, line_ids: move.line_ids.map((item) => item.account_id === company.account_default_receivable_id ? { ...item, partner_id: null } : item) }) } };
  assert.throws(() => applyDiff(beforeBooking, diffDb(beforeBooking, forged), { isAdmin: true }), /valid counterpart/);
  line = read(db, 'account.bank.statement.line', lineId);
  assert.equal(line.state, 'reconciled');
  assert.ok(read(db, 'account.move', line.bank_move_id).line_ids.some((item) => item.account_id === company.account_default_receivable_id && item.partner_id === line.partner_id));
  assert.throws(() => statementCounterpartAccount(db, line, 'receivable'), /already reconciled/);
  db = unreconcile(db, line).db;
  assert.equal(read(db, 'account.bank.statement.line', lineId).state, 'to_check');
  db = write(db, 'account.bank.statement.line', lineId, { partner_id: null });
  assert.throws(() => statementCounterpartAccount(db, read(db, 'account.bank.statement.line', lineId), 'payable'), /Select a partner/);
});

test('review flag is separate from matching and deletion retains the saved-diff guard', () => {
  let { db, lineId } = fixture();
  db = setStatementLineReview(db, lineId, true);
  assert.equal(read(db, 'account.bank.statement.line', lineId).state, 'to_check');
  assert.equal(read(db, 'account.bank.statement.line', lineId).review_requested, true);
  const line = read(db, 'account.bank.statement.line', lineId);
  const account = statementCounterpartAccount(db, line, 'receivable');
  db = bookToAccount(db, { ...line, counterpart_account_id: account }).db;
  const booked = read(db, 'account.bank.statement.line', lineId);
  assert.equal(read(db, 'account.move', booked.bank_move_id).to_check, true);
  db = setStatementLineReview(db, lineId, false);
  assert.equal(read(db, 'account.move', booked.bank_move_id).to_check, false);
  assert.throws(() => unlink(db, 'account.bank.statement.line', [lineId]), /cannot be deleted/);
  const forged = { ...db, records: { ...db.records, 'account.bank.statement.line': db.records['account.bank.statement.line'].filter((l) => l.id !== lineId) } };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /cannot be deleted/);
});

test('a rule may book a non-default receivable account through the saved-diff guard', () => {
  const { db, lineId } = fixture();
  const account = create(db, 'account.account', { code: '199997', name: 'Other receivable', account_type: 'asset_receivable', company_id: 1, reconcile: true });
  const rule = create(account.db, 'account.reconcile.model', { name: 'Custom receivable', rule_type: 'writeoff_button', line_ids: [{ account_id: account.id, amount_type: 'percentage', amount: 100 }] });
  const after = applyRule(rule.db, read(rule.db, 'account.reconcile.model', rule.id), read(rule.db, 'account.bank.statement.line', lineId));
  const synced = applyDiff(rule.db, diffDb(rule.db, after), { isAdmin: true });
  assert.equal(read(synced, 'account.bank.statement.line', lineId).state, 'reconciled');
});

function invoiceFixture() {
  const db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  return { db: postMove(invoice.db, invoice.id), invoiceId: invoice.id, journalId: journal.id };
}

test('exact invoice settlement accepts a child contact through the saved-diff guard', () => {
  let { db, invoiceId, journalId } = invoiceFixture();
  const child = create(db, 'res.partner', { name: 'Invoice contact', parent_id: 3 });
  const line = create(child.db, 'account.bank.statement.line', { journal_id: journalId, date: '2026-01-02', payment_ref: 'Contact payment', amount: 100, partner_id: child.id });
  db = line.db;
  const matched = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), invoiceId);
  const synced = applyDiff(db, diffDb(db, matched), { isAdmin: true });
  assert.equal(read(synced, 'account.bank.statement.line', line.id).state, 'reconciled');
});

test('exact invoice settlement uses its booked receivable after partner configuration changes', () => {
  let { db, invoiceId, journalId } = invoiceFixture();
  const oldAccount = read(db, 'account.move', invoiceId).line_ids.find((item) => read(db, 'account.account', item.account_id)?.account_type === 'asset_receivable').account_id;
  const replacement = create(db, 'account.account', { code: '199996', name: 'New receivable', account_type: 'asset_receivable', company_id: 1, reconcile: true });
  db = write(replacement.db, 'res.partner', 3, { property_account_receivable_id: replacement.id });
  const line = create(db, 'account.bank.statement.line', { journal_id: journalId, date: '2026-01-02', payment_ref: 'Old account payment', amount: 100, partner_id: 3 });
  db = line.db;
  const matched = reconcileWith(db, read(db, 'account.bank.statement.line', line.id), invoiceId);
  const synced = applyDiff(db, diffDb(db, matched), { isAdmin: true });
  const booked = read(synced, 'account.bank.statement.line', line.id);
  assert.equal(booked.state, 'reconciled');
  assert.ok(read(synced, 'account.move', booked.bank_move_id).line_ids.some((item) => item.account_id === oldAccount));
});

test('partnerless statement matches a direct payment through the saved-diff guard', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  db = write(db, 'account.journal', journal.id, { outstanding_receipts_account_id: null });
  const payment = create(db, 'account.payment', { partner_id: 3, payment_type: 'inbound', partner_type: 'customer', amount: 100, journal_id: journal.id, date: '2026-01-02' });
  db = models['account.payment'].form.buttons.find((button) => button.label === 'Confirm').run(payment.db, read(payment.db, 'account.payment', payment.id)).db;
  assert.equal(read(db, 'account.payment', payment.id).outstanding_account_id, null);
  const line = create(db, 'account.bank.statement.line', { journal_id: journal.id, date: '2026-01-03', payment_ref: 'Direct payment', amount: 100, payment_ids: [payment.id] });
  db = line.db;
  assert.equal(read(db, 'account.bank.statement.line', line.id).partner_id ?? null, null);
  const matched = matchPayment(db, read(db, 'account.bank.statement.line', line.id)).db;
  const synced = applyDiff(db, diffDb(db, matched), { isAdmin: true });
  assert.equal(read(synced, 'account.bank.statement.line', line.id).state, 'reconciled');
});

test('workspace exposes actions, statement preview and reconciled selection', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const { db, lineId } = fixture();
  await initStore();
  await commit(db);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));
    const props = (node) => node?.[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
    const button = (name) => find(host, (node) => node.tagName === 'BUTTON' && node.textContent === name);
    for (const name of ['Validate', 'Reset', 'To Check', 'Delete line', 'Receivable', 'Payable', 'Internal Transfer', 'Print Statement', 'Export Statement']) assert.ok(button(name), name);
    await React.act(async () => props(button('To Check')).onClick());
    assert.ok(button('Set as Checked'));
    await React.act(async () => props(button('Receivable')).onClick());
    assert.ok(host.textContent.includes('Manual Operation'));
    await React.act(async () => props(button('Print Statement')).onClick());
    assert.ok(host.textContent.includes('Statement actions'));
    assert.ok(host.textContent.includes('Action line'));
    assert.ok(button('Print'));
    await React.act(async () => props(button('Back')).onClick());
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    let exported;
    URL.createObjectURL = (blob) => { exported = blob; return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    try {
      await React.act(async () => props(button('Export Statement')).onClick());
      const csv = await exported.text();
      assert.match(csv, /Statement actions/);
      assert.match(csv, /Action line/);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
    await React.act(async () => props(button('Validate')).onClick());
    assert.equal(read(getDb(), 'account.bank.statement.line', lineId).state, 'reconciled');
    const show = find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'checkbox');
    await React.act(async () => props(show).onChange({ target: { checked: true } }));
    assert.ok(button('Reset'));
    await React.act(async () => props(button('Reset')).onClick());
    assert.equal(read(getDb(), 'account.bank.statement.line', lineId).state, 'to_check');
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      await React.act(async () => props(button('Delete line')).onClick());
      assert.equal(read(getDb(), 'account.bank.statement.line', lineId), undefined);
    } finally { globalThis.confirm = originalConfirm; }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('statement preview and export preserve saved order and use the journal currency with no selected line', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  let { db, lineId, statementId } = fixture();
  const journalId = read(db, 'account.bank.statement', statementId).journal_id;
  const currency = create(db, 'res.currency', { name: 'TST', symbol: '¤', position: 'before', rounding: 0.01, rate_ids: [{ date: '2020-01-01', rate: 1 }] });
  db = write(currency.db, 'account.journal', journalId, { currency_id: currency.id });
  db = write(db, 'account.bank.statement.line', lineId, { sequence: 20 });
  const other = create(db, 'account.bank.statement.line', { statement_id: statementId, journal_id: journalId, company_id: 1, date: '2026-10-01', payment_ref: 'First ordered', amount: 5, sequence: 10, state: 'to_check' });
  await initStore();
  await commit(other.db);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));
    const props = (node) => node?.[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
    const button = (name) => find(host, (node) => node.tagName === 'BUTTON' && node.textContent === name);
    const select = find(host, (node) => node.tagName === 'SELECT' && props(node)?.['aria-label'] === 'Statement');
    await React.act(async () => props(select).onChange({ target: { value: String(statementId) } }));
    let exported;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => { exported = blob; return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    try {
      await React.act(async () => props(button('Export Statement')).onClick());
      const csv = await exported.text();
      assert.ok(csv.indexOf('First ordered') < csv.indexOf('Action line'));
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
    await React.act(async () => props(button('Print Statement')).onClick());
    assert.ok(host.textContent.indexOf('First ordered') < host.textContent.indexOf('Action line'));
    assert.match(host.textContent, /¤/);
    assert.ok(!host.textContent.includes(' ? '));
  } finally { await React.act(async () => root.unmount()); }
});

test('empty statement print header uses its journal currency', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const currency = create(db, 'res.currency', { name: 'TST', symbol: '¤', position: 'before', rounding: 0.01, rate_ids: [{ date: '2020-01-01', rate: 1 }] });
  db = write(currency.db, 'account.journal', journal.id, { currency_id: currency.id });
  const statement = create(db, 'account.bank.statement', { name: 'Empty foreign statement', journal_id: journal.id, date: '2026-10-01', balance_start: 10, balance_end_real: 10 });
  await initStore();
  await commit(statement.db);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile)));
    const props = (node) => node?.[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
    const select = find(host, (node) => node.tagName === 'SELECT' && props(node)?.['aria-label'] === 'Statement');
    await React.act(async () => props(select).onChange({ target: { value: String(statement.id) } }));
    const button = find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Print Statement');
    await React.act(async () => props(button).onClick());
    const header = find(host, (node) => node.tagName === 'P' && node.textContent.includes('Starting Balance'));
    assert.equal((header.textContent.match(/¤/g) ?? []).length, 2);
    assert.ok(header.textContent.includes(' · '));
    assert.ok(!header.textContent.includes('?'));
  } finally { await React.act(async () => root.unmount()); }
});
