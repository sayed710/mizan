import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { seed } from './seed.js';
import { generateGroupedEntries, postDueEntries } from './models/deferred.js';
import { accountId } from './models/ledger.js';
import { journalCards } from './models/finance.js';

const button = (model, label, db, id) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const schedule = (db) => create(db, 'account.deferral', { name: 'Contract', kind: 'revenue', amount: 120, start_date: '2026-01-01', months: 12, company_id: 1, deferred_account_id: accountId(db, '212000'), recognition_account_id: accountId(db, '400000') });

test('cancellation blocks posted recognition until explicitly handled', () => {
  const made = schedule(seed());
  let db = button('account.deferral', 'Compute', made.db, made.id);
  db = postDueEntries(db, read(db, 'account.deferral', made.id), '2026-01-31');
  assert.throws(() => button('account.deferral', 'Cancel', db, made.id), /reverse.*recognition/i);
  assert.equal(read(db, 'account.deferral', made.id).state, 'running');
});

test('grouped regeneration posts only the delta for newly added schedules without modifying earlier entries', () => {
  let db = write(seed(), 'res.company', 1, { deferred_generation_method: 'manual_grouped' });
  const first = schedule(db);
  db = button('account.deferral', 'Compute', first.db, first.id);
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  assert.equal(generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' }), db);
  const firstGroup = search(db, 'account.move').find((m) => m.is_deferred_grouped && !m.reversed_entry_id);
  const second = schedule(db);
  db = button('account.deferral', 'Compute', second.db, second.id);
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  const groupedMoves = search(db, 'account.move').filter((m) => m.is_deferred_grouped && !m.reversed_entry_id && m.deferral_date === '2026-01-31');
  assert.equal(groupedMoves.length, 2);
  assert.deepEqual(read(db, 'account.move', firstGroup.id), firstGroup);
  assert.deepEqual(groupedMoves[1].deferred_contributions.map((c) => c.schedule_id), [second.id]);
  assert.equal(generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' }), db);
  assert.throws(() => button('account.deferral', 'Cancel', db, first.id), /reverse.*recognition/i);
});

test('bank cards count only their own journal transactions', () => {
  let db = seed();
  const banks = search(db, 'account.journal').filter((j) => j.type === 'bank');
  const second = create(db, 'account.journal', { name: 'Second bank', code: 'B2', type: 'bank', default_account_id: banks[0].default_account_id, suspense_account_id: banks[0].suspense_account_id });
  db = second.db;
  db = create(db, 'account.bank.statement.line', { journal_id: second.id, payment_ref: 'Payment', date: '2026-01-01', amount: 42, state: 'to_check' }).db;
  const cards = journalCards(db);
  const card = cards.find((c) => c.journal.id === second.id);
  assert.equal(card.toReconcile, 1);
  assert.equal(card.toReconcileAmount, 42);
  assert.equal(cards.find((c) => c.journal.id === banks[0].id).toReconcile, search(db, 'account.bank.statement.line').filter((l) => l.journal_id === banks[0].id && l.state === 'to_check').length);
});
