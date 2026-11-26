import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { bookToAccount, setStatementLineReview, statementCounterpartAccount, unreconcile } from './models/bank.js';
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
