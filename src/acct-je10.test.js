import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { postMove } from './models/accounting.js';
import { accountId } from './models/ledger.js';
import { checkInalterability, computeMoveHash, secureEntries } from './models/hash_chain.js';
import { applyDiff, diffDb } from './sync.js';

const server = (db, next) => applyDiff(db, diffDb(db, next), { isAdmin: true });
const mutate = (db, id, vals) => ({ ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === id ? { ...m, ...vals } : m) } });
function setup() {
  let db = seed();
  const journal = create(db, 'account.journal', { name: 'Secure JE10', code: 'JE10', restrict_mode_hash_table: true }); db = journal.db;
  const draft = create(db, 'account.move', { move_type: 'entry', state: 'draft', name: '/', date: '2026-11-01', journal_id: journal.id, company_id: 1, ref: 'original', line_ids: [{ account_id: accountId(db, '600000'), debit: 100, credit: 0 }, { account_id: accountId(db, '211000'), debit: 0, credit: 100 }] });
  return { db: draft.db, id: draft.id, journal: journal.id };
}

test('JE-5 restricted posting secures the move and sync rejects tampering', () => {
  const { db, id, journal } = setup();
  let posted = server(db, postMove(db, id));
  const first = read(posted, 'account.move', id);
  assert.ok(first.inalterable_hash);
  assert.equal(first.secure_sequence_number, 1);
  for (const vals of [{ inalterable_hash: null }, { inalterable_hash: 'forged' }, { state: 'draft' }]) {
    assert.throws(() => server(posted, mutate(posted, id, vals)), /Secured entries cannot be (modified|reset)/);
  }
  const draft = create(posted, 'account.move', { ...first, id: undefined, state: 'draft', name: '/', inalterable_hash: null, secure_sequence_number: null, inalterable_hash_version: null });
  posted = server(draft.db, postMove(draft.db, draft.id));
  assert.equal(read(posted, 'account.move', draft.id).secure_sequence_number, 2);
  assert.ok(checkInalterability(posted, { journalId: journal }).every((row) => row.status === 'ok'));
});

test('JE-7 version 3 includes and protects ref while version 2 remains valid', () => {
  const { db, id } = setup();
  const posted = postMove(db, id);
  const secured = secureEntries(posted, { throughMoveId: id });
  const move = read(secured, 'account.move', id);
  assert.equal(move.inalterable_hash_version, 3);
  assert.notEqual(computeMoveHash(move, '', 3), computeMoveHash({ ...move, ref: 'changed' }, '', 3));
  assert.equal(computeMoveHash(move, '', 2), computeMoveHash({ ...move, ref: 'changed' }, '', 2));
  assert.throws(() => server(secured, mutate(secured, id, { ref: 'changed' })), /Secured entries cannot be modified/);
});



test('mixed legacy v1 and v2 chains extend with v3 on posting', () => {
  let { db, id, journal } = setup();
  db = write(db, 'account.journal', journal, { restrict_mode_hash_table: false });
  db = postMove(db, id);
  const first = read(db, 'account.move', id);
  const secondDraft = create(db, 'account.move', { ...first, id: undefined, name: '/', state: 'draft' });
  db = postMove(secondDraft.db, secondDraft.id);
  const second = read(db, 'account.move', secondDraft.id);
  const hash1 = computeMoveHash(first, '', 1);
  const hash2 = computeMoveHash(second, hash1, 2);
  db = mutate(db, id, { inalterable_hash: hash1, secure_sequence_number: 1, inalterable_hash_version: 1 });
  db = mutate(db, second.id, { inalterable_hash: hash2, secure_sequence_number: 2, inalterable_hash_version: 2 });
  db = write(db, 'account.journal', journal, { restrict_mode_hash_table: true });
  db = { ...db, records: { ...db.records, 'account.journal': db.records['account.journal'].map((j) => j.id === journal ? { ...j, secure_chain_heads: [{ company_id: 1, count: 2, last_sequence: 2, last_hash: hash2, last_move_id: second.id, last_move_name: second.name }] } : j) } };
  assert.equal(checkInalterability(db, { journalId: journal })[0].status, 'ok');
  const third = create(db, 'account.move', { ...first, id: undefined, name: '/', state: 'draft' });
  const result = server(third.db, postMove(third.db, third.id));
  assert.equal(read(result, 'account.move', third.id).inalterable_hash_version, 3);
  assert.equal(checkInalterability(result, { journalId: journal })[0].status, 'ok');
});
