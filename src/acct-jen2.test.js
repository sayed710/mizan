import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { journalEntriesView, accountingModels } from './models/accounting.js';

test('journal entry search and grouping expose amount and company', () => {
  assert.ok(journalEntriesView.searchFields.includes('amount_total'));
  assert.ok(journalEntriesView.groupBys.includes('company_id'));
});

test('journal entry Not Secured uses the invoice predicate', () => {
  const entry = journalEntriesView.filters.flat().find((f) => f.id === 'not_secured');
  const invoice = accountingModels['account.move'].filters.flat().find((f) => f.id === 'not_secured');
  assert.ok(entry);
  assert.equal(entry.fn, invoice.fn);
  assert.equal(entry.fn({ state: 'posted' }), true);
  assert.equal(entry.fn({ state: 'draft' }), false);
  assert.equal(entry.fn({ state: 'posted', inalterable_hash: 'hash' }), false);
});

test('account roots come only from explicit codes', async () => {
  const { accountCodeRoot } = await import('./views/JournalItems.jsx');
  assert.equal(accountCodeRoot({ code: '120500', name: 'Other' }), '12');
  assert.equal(accountCodeRoot({ code: 'A' }), 'A');
  assert.equal(accountCodeRoot({ name: '120500' }), null);
  assert.equal(accountCodeRoot({ code: '' }), null);
});

test('matching filters select exact full or partial groups', async () => {
  const { matchingGroupKey, matchesMatchingGroup } = await import('./views/JournalItems.jsx');
  const full = { full_reconcile_id: 42, matching_number: 'A1', reconciliation_group: 'A1' };
  const partial = { matching_number: 'P17', reconciliation_group: 'P17' };
  assert.equal(matchingGroupKey(full), 'matching:A1');
  assert.equal(matchesMatchingGroup({ full_reconcile_id: 42, reconciliation_group: 'A1' }, matchingGroupKey(full)), true);
  assert.equal(matchesMatchingGroup({ full_reconcile_id: 43, matching_number: 'A1', reconciliation_group: 'A2' }, matchingGroupKey(full)), false);
  assert.equal(matchesMatchingGroup({ reconciliation_group: 'A4' }, matchingGroupKey({ reconciliation_group: 'A4' })), true);
  assert.equal(matchesMatchingGroup({ reconciliation_group: 'P17' }, matchingGroupKey(partial)), true);
  assert.equal(matchesMatchingGroup({ reconciliation_group: 'P18' }, matchingGroupKey(partial)), false);
  assert.equal(matchingGroupKey({ reconciled: true }), null);
});

test('partial matching membership follows active links and does not alter line identity', async () => {
  const { seed } = await import('./seed.js');
  const { postEntry, journalItems } = await import('./models/ledger.js');
  let db = seed();
  const account = db.records['account.account'].find((a) => a.reconcile === true && (a.company_id ?? 1) === 1);
  const other = db.records['account.account'].find((a) => a.id !== account.id && (a.company_id ?? 1) === 1);
  const journal = db.records['account.journal'].find((j) => j.type === 'general' && (j.company_id ?? 1) === 1);
  const debit = postEntry(db, { journal_id: journal.id, journal: journal.code, company: 1, date: '2026-01-01', lines: [{ account_id: account.id, debit: 100 }, { account_id: other.id, credit: 100 }] });
  const credit = postEntry(debit.db, { journal_id: journal.id, journal: journal.code, company: 1, date: '2026-01-02', lines: [{ account_id: account.id, credit: 100 }, { account_id: other.id, debit: 100 }] });
  db = credit.db;
  const before = journalItems(db).find((line) => line.move_id === debit.id && line.account_id === account.id);
  const link = { id: 987655, debit_move_id: debit.id, debit_line_index: 0, credit_move_id: credit.id, credit_line_index: 0, amount: 50 };
  const linked = { ...db, records: { ...db.records, 'account.partial.reconcile': [...(db.records['account.partial.reconcile'] ?? []), link] } };
  const rows = journalItems(linked).filter((line) => [debit.id, credit.id].includes(line.move_id) && line.account_id === account.id);
  assert.deepEqual(rows.map((line) => line.reconciliation_group), ['P987655', 'P987655']);
  assert.equal(rows.find((line) => line.move_id === debit.id).line_identity, before.line_identity);
  const reversed = { ...linked, records: { ...linked.records, 'account.partial.reconcile': linked.records['account.partial.reconcile'].map((item) => item.id === link.id ? { ...item, reversed: true } : item) } };
  assert.equal(journalItems(reversed).find((line) => line.move_id === debit.id && line.account_id === account.id).reconciliation_group, null);
});
