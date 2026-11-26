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
  const full = { full_reconcile_id: 42, matching_number: 'A1' };
  const partial = { matching_number: 'P17' };
  assert.equal(matchingGroupKey(full), 'full:42');
  assert.equal(matchesMatchingGroup({ full_reconcile_id: 42 }, matchingGroupKey(full)), true);
  assert.equal(matchesMatchingGroup({ full_reconcile_id: 43, matching_number: 'A1' }, matchingGroupKey(full)), false);
  assert.equal(matchesMatchingGroup({ matching_number: 'A4' }, matchingGroupKey({ matching_number: 'A4' })), true);
  assert.equal(matchesMatchingGroup({ matching_number: 'P17' }, matchingGroupKey(partial)), true);
  assert.equal(matchesMatchingGroup({ matching_number: 'P18' }, matchingGroupKey(partial)), false);
  assert.equal(matchingGroupKey({ reconciled: true }), null);
});
