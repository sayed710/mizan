import { test } from 'node:test';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { postMove } from './models/accounting.js';
import { journalItems, postEntry } from './models/ledger.js';
import { postPayment, reconcileJournalItems, unreconcileJournalItems, writeoffJournalItem } from './models/pay.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const date = '2026-06-15';
function fixture(amount = 100, outstanding = false) {
  let base = seed();
  if (outstanding) {
    const account = create(base, 'account.account', { code: 'UI4-OUT', name: 'Explicit outstanding receipts', company_id: 1, account_type: 'asset_current', reconcile: true });
    base = write(account.db, 'res.company', 1, { outstanding_receipts_account_id: account.id });
  }
  const partner = create(base, 'res.partner', { name: 'Journal item customer' });
  const journal = search(partner.db, 'account.journal').find((j) => j.default_for_payments === true);
  const draft = create(partner.db, 'account.payment', { partner_id: partner.id, company_id: 1, journal_id: journal.id, amount, date, payment_type: 'inbound', partner_type: 'customer' });
  const paid = postPayment(draft.db, read(draft.db, 'account.payment', draft.id));
  const invoice = create(paid, 'account.move', { partner_id: partner.id, company_id: 1, move_type: 'out_invoice', invoice_date: date, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const db = postMove(invoice.db, invoice.id);
  const payment = read(db, 'account.payment', draft.id);
  const account = read(db, 'res.company', 1).account_default_receivable_id;
  return { db, invoiceId: invoice.id, paymentId: payment.id, paymentMoveId: payment.move_id, account, journalId: journal.id };
}
function item(db, moveId, account) {
  const rows = journalItems(db).filter((l) => l.move_id === moveId && l.account_id === account);
  assert.equal(rows.length, 1);
  return { move_id: moveId, line_identity: rows[0].line_identity };
}
const selection = (f) => [item(f.db, f.invoiceId, f.account), item(f.db, f.paymentMoveId, f.account)];

test('Journal Items reconciles explicitly selected payment credit and derives matching from settlement links', () => {
  const f = fixture();
  const before = JSON.stringify(f.db);
  const db = reconcileJournalItems(f.db, selection(f), { date });
  assert.equal(read(db, 'account.move', f.invoiceId).amount_residual, 0);
  assert.equal(read(db, 'account.payment', f.paymentId).unapplied, 0);
  assert.ok(journalItems(db).filter((l) => [f.invoiceId, f.paymentMoveId].includes(l.move_id) && l.account_id === f.account).every((l) => l.reconciled));
  assert.equal(read(db, 'account.move', f.invoiceId).payments[0].move_id, f.paymentMoveId);
  assert.equal(JSON.stringify(f.db), before, 'input is immutable');
  assert.equal(db.records['account.full.reconcile'], undefined, 'no parallel matching model');
});

test('Journal Items selection survives line reordering and rejects stale or ambiguous identities', () => {
  const f = fixture();
  const selected = selection(f);
  const reordered = { ...f.db, records: { ...f.db.records, 'account.move': f.db.records['account.move'].map((m) => m.id === f.invoiceId ? { ...m, line_ids: [...m.line_ids].reverse() } : m) } };
  assert.equal(read(reconcileJournalItems(reordered, selected, { date }), 'account.move', f.invoiceId).amount_residual, 0);
  assert.throws(() => reconcileJournalItems(f.db, [{ ...selected[0], line_identity: 'missing' }, selected[1]], { date }), /missing, ambiguous/);
  const inv = read(f.db, 'account.move', f.invoiceId);
  const line = inv.line_ids.find((l) => l.account_id === f.account);
  const ambiguous = { ...f.db, records: { ...f.db.records, 'account.move': f.db.records['account.move'].map((m) => m.id === inv.id ? { ...m, line_ids: [...m.line_ids, { ...line }] } : m) } };
  assert.throws(() => reconcileJournalItems(ambiguous, selected, { date }), /ambiguous/);
});

test('Journal Items unreconciliation removes the matching and keeps the payment and its credit', () => {
  const f = fixture(40);
  let db = reconcileJournalItems(f.db, selection(f), { date });
  assert.equal(read(db, 'account.move', f.invoiceId).amount_residual, 60);
  assert.equal(journalItems(db).find((l) => l.move_id === f.invoiceId && l.account_id === f.account).reconciled, false);
  const creditBefore = read(f.db, 'account.payment', f.paymentId).unapplied;
  db = unreconcileJournalItems(db, [item(db, f.invoiceId, f.account)], { date });
  assert.equal(read(db, 'account.move', f.invoiceId).amount_residual, 100);
  assert.equal(read(db, 'account.payment', f.paymentId).state, 'posted');
  assert.equal(read(db, 'account.payment', f.paymentId).unapplied, creditBefore);
  assert.ok(!search(db, 'account.move').some((m) => m.reversed_entry_id === f.paymentMoveId));
  assert.equal(journalItems(db).find((l) => l.move_id === f.paymentMoveId && l.account_id === f.account).reconciled, false);
  db = reconcileJournalItems(db, selection(f), { date });
  assert.equal(read(db, 'account.move', f.invoiceId).amount_residual, 60);
});

test('Journal Items write-off requires explicit configuration and reverses the exact settlement', () => {
  const f = fixture();
  const selected = [item(f.db, f.invoiceId, f.account)];
  const account = search(f.db, 'account.account').find((a) => a.account_type === 'expense' && (!a.company_id || a.company_id === 1));
  const options = { date, amount: 100, journalId: f.journalId, accountId: account.id, label: 'Approved adjustment' };
  assert.throws(() => writeoffJournalItem(f.db, selected, { ...options, journalId: null }), /Select a write-off journal/);
  assert.throws(() => writeoffJournalItem(f.db, selected, { ...options, accountId: null }), /Select a write-off account/);
  assert.throws(() => writeoffJournalItem(f.db, selected, { ...options, label: '' }), /label/);
  assert.throws(() => writeoffJournalItem(f.db, selected, { ...options, amount: 101 }), /remaining invoice/);
  const written = writeoffJournalItem(f.db, selected, options);
  assert.equal(read(written, 'account.move', f.invoiceId).amount_residual, 0);
  const sourceId = read(written, 'account.move', f.invoiceId).payments[0].move_id;
  const db = unreconcileJournalItems(written, [item(written, sourceId, f.account)], { date });
  assert.equal(read(db, 'account.move', f.invoiceId).amount_residual, 100);
  assert.equal(read(db, 'account.payment', f.paymentId).state, 'posted', 'unrelated payment is untouched');
});

test('Journal Items rejects wrong accounts, missing payment links, invalid dates and duplicate selections before publishing', () => {
  const f = fixture();
  const selected = selection(f);
  assert.throws(() => reconcileJournalItems(f.db, selected, { date: '' }), /valid reconciliation date/);
  assert.throws(() => reconcileJournalItems(f.db, [selected[0], selected[0]], { date }), /only once/);
  assert.throws(() => reconcileJournalItems(f.db, [selected[0]], { date }), /one invoice/);
  const other = search(f.db, 'account.account').find((a) => a.account_type === 'expense');
  const entry = postEntry(f.db, { journal_id: f.journalId, company: 1, date, lines: [{ account: f.account, credit: 100, partner_id: read(f.db, 'account.move', f.invoiceId).partner_id }, { account: other.id, debit: 100 }] });
  assert.throws(() => reconcileJournalItems(entry.db, [selected[0], item(entry.db, entry.id, f.account)], { date }), /explicit posted payment link/);
  assert.equal(read(f.db, 'account.move', f.invoiceId).amount_residual, 100);
});

test('Journal Items unreconciles existing bank matches through the bank workflow without reversing the original payment', () => {
  const f = fixture(100, true);
  const p = read(f.db, 'account.payment', f.paymentId);
  assert.ok(p.outstanding_account_id);
  const bank = create(f.db, 'account.bank.statement.line', { date, amount: 100, payment_ref: 'Explicit bank match', partner_id: p.partner_id, company_id: 1, journal_id: f.journalId, payment_id: p.id });
  const matched = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment').run(bank.db, read(bank.db, 'account.bank.statement.line', bank.id)).db;
  const db = unreconcileJournalItems(matched, [item(matched, p.move_id, p.outstanding_account_id)], { date });
  assert.equal(read(db, 'account.bank.statement.line', bank.id).state, 'to_check');
  assert.equal(read(db, 'account.payment', p.id).state, 'posted');
  assert.equal(journalItems(db).find((l) => l.move_id === p.move_id && l.account_id === p.outstanding_account_id).reconciled, false);
});

test('Journal Items invoice unreconciliation keeps the payment bank match and restores the invoice balance', () => {
  const f = fixture(100, true);
  let db = reconcileJournalItems(f.db, selection(f), { date });
  const p = read(db, 'account.payment', f.paymentId);
  const bank = create(db, 'account.bank.statement.line', { date, amount: 100, payment_ref: 'Allocated payment bank match', partner_id: p.partner_id, company_id: 1, journal_id: f.journalId, payment_id: p.id });
  db = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment').run(bank.db, read(bank.db, 'account.bank.statement.line', bank.id)).db;
  db = unreconcileJournalItems(db, [item(db, f.invoiceId, f.account)], { date });
  assert.equal(read(db, 'account.bank.statement.line', bank.id).state, 'reconciled');
  assert.equal(read(db, 'account.move', f.invoiceId).amount_residual, 100);
  assert.equal(read(db, 'account.payment', f.paymentId).state, 'posted');
});

test('Journal Items rejects unallocated items and wrong partner selections without creating entries', () => {
  const f = fixture();
  assert.throws(() => unreconcileJournalItems(f.db, [item(f.db, f.paymentMoveId, f.account)], { date }), /no active settlement/);
  const partner = create(f.db, 'res.partner', { name: 'Other selected customer' });
  const invoice = create(partner.db, 'account.move', { partner_id: partner.id, move_type: 'out_invoice', invoice_date: date, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const db = postMove(invoice.db, invoice.id);
  assert.throws(() => reconcileJournalItems(db, [item(db, invoice.id, f.account), item(db, f.paymentMoveId, f.account)], { date }), /same account and partner/);
  assert.equal(read(db, 'account.move', f.invoiceId).amount_residual, 100);
});

test('Journal Items actions reject locked settlement writes without mutating the database', () => {
  const f = fixture();
  const locked = write(f.db, 'res.company', 1, { lock_date: date });
  const before = JSON.stringify(locked);
  assert.throws(() => reconcileJournalItems(locked, selection(f), { date }), /lock/i);
  assert.equal(JSON.stringify(locked), before);
  assert.ok(models['account.payment']);
});

test('Journal Items selection and confirmation controls execute reconciliation and unreconciliation', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();
  const f = fixture();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
  const button = (label) => find(host, (node) => node.tagName === 'BUTTON' && node.textContent === label);
  const select = async (identity) => {
    const row = find(host, (node) => node.tagName === 'TR' && find(node, (child) => child.tagName === 'A' && props(child)?.href === `#/accounting/entries/${identity.move_id}`) && node.textContent.includes(read(getDb(), 'account.account', f.account).name));
    const checkbox = find(row, (node) => node.tagName === 'INPUT' && props(node)?.type === 'checkbox');
    assert.ok(checkbox);
    await React.act(async () => props(checkbox).onChange({ target: { checked: true } }));
  };
  try {
    await React.act(async () => { await commit(f.db); root.render(React.createElement(JournalItems)); });
    assert.equal(props(button('Reconcile')).disabled, true);
    for (const identity of selection(f)) await select(identity);
    await React.act(async () => props(button('Reconcile')).onClick());
    const input = find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'date' && !props(node)?.['aria-label']);
    await React.act(async () => props(input).onChange({ target: { value: date } }));
    await React.act(async () => props(find(host, (node) => node.tagName === 'FORM')).onSubmit({ preventDefault() {} }));
    assert.equal(read(getDb(), 'account.move', f.invoiceId).amount_residual, 0);
    await select(item(getDb(), f.invoiceId, f.account));
    await React.act(async () => props(button('Unreconcile')).onClick());
    assert.ok(host.textContent.includes('payments stay posted'));
    await React.act(async () => props(find(host, (node) => node.tagName === 'FORM')).onSubmit({ preventDefault() {} }));
    assert.equal(read(getDb(), 'account.move', f.invoiceId).amount_residual, 100);
    assert.ok(button('Write Off'));
  } finally { await React.act(async () => root.unmount()); }
});

test('an unreconcile that frees a payment credit is accepted by server save (Qodo 1)', () => {
  const f = fixture(40);
  const matched = reconcileJournalItems(f.db, selection(f), { date });
  const local = unreconcileJournalItems(matched, [item(matched, f.invoiceId, f.account)], { date });
  const synced = applyDiff(matched, diffDb(matched, local), { isAdmin: true });
  assert.equal(read(synced, 'account.move', f.invoiceId).amount_residual, 100);
  assert.equal(read(synced, 'account.payment', f.paymentId).unapplied, read(f.db, 'account.payment', f.paymentId).unapplied);
});
