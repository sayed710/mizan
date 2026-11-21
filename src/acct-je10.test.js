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

test('automatic immediate reversal secures both source and reversal in restricted journal and preserves bidirectional links', () => {
  let db = seed();
  const journal = create(db, 'account.journal', { name: 'Secure JE10 Auto', code: 'JE10A', restrict_mode_hash_table: true });
  db = journal.db;
  const draft = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    name: '/',
    date: '2026-11-01',
    journal_id: journal.id,
    company_id: 1,
    ref: 'original',
    auto_reverse: true,
    reverse_date: '2026-11-02',
    line_ids: [
      { account_id: accountId(db, '600000'), debit: 100, credit: 0 },
      { account_id: accountId(db, '211000'), debit: 0, credit: 100 },
    ],
  });
  db = server(draft.db, postMove(draft.db, draft.id));

  const source = read(db, 'account.move', draft.id);
  assert.equal(source.state, 'posted');
  assert.ok(source.inalterable_hash, 'source must have an inalterability hash');
  assert.equal(source.secure_sequence_number, 1);
  assert.ok(source.reversal_move_id, 'source must record reversal_move_id');

  const reversal = read(db, 'account.move', source.reversal_move_id);
  assert.ok(reversal, 'reversal entry must exist');
  assert.equal(reversal.state, 'posted');
  assert.equal(reversal.reversed_entry_id, source.id, 'reversal must link to reversed_entry_id');
  assert.ok(reversal.inalterable_hash, 'reversal must be secured when in restricted journal');
  assert.equal(reversal.secure_sequence_number, 2, 'reversal sequence number must follow source');
  assert.equal(reversal.journal_id, journal.id);

  // Check inalterability across the whole journal
  const report = checkInalterability(db, { journalId: journal.id });
  assert.equal(report[0].status, 'ok');
  assert.equal(report[0].last_move, reversal.name);
});

test('automatic reversal into a different restricted journal secures both in their respective journals', () => {
  let db = seed();
  const j1 = create(db, 'account.journal', { name: 'Secure J1', code: 'SJ1', restrict_mode_hash_table: true }); db = j1.db;
  const j2 = create(db, 'account.journal', { name: 'Secure J2', code: 'SJ2', restrict_mode_hash_table: true }); db = j2.db;
  const draft = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    name: '/',
    date: '2026-11-01',
    journal_id: j1.id,
    reverse_journal_id: j2.id,
    company_id: 1,
    ref: 'cross-journal',
    auto_reverse: true,
    reverse_date: '2026-11-02',
    line_ids: [
      { account_id: accountId(db, '600000'), debit: 50, credit: 0 },
      { account_id: accountId(db, '211000'), debit: 0, credit: 50 },
    ],
  });
  db = server(draft.db, postMove(draft.db, draft.id));

  const source = read(db, 'account.move', draft.id);
  assert.ok(source.inalterable_hash);
  assert.equal(source.secure_sequence_number, 1);
  assert.equal(source.journal_id, j1.id);
  assert.ok(source.reversal_move_id);

  const reversal = read(db, 'account.move', source.reversal_move_id);
  assert.equal(reversal.state, 'posted');
  assert.equal(reversal.journal_id, j2.id);
  assert.ok(reversal.inalterable_hash);
  assert.equal(reversal.secure_sequence_number, 1);
  assert.equal(reversal.reversed_entry_id, source.id);

  assert.equal(checkInalterability(db, { journalId: j1.id })[0].status, 'ok');
  assert.equal(checkInalterability(db, { journalId: j2.id })[0].status, 'ok');
});

test('scheduled auto-reversal records reversal link on source and leaves draft reversal unhashed', () => {
  let db = seed();
  const journal = create(db, 'account.journal', { name: 'Secure JE10 Sched', code: 'SCHED', restrict_mode_hash_table: true }); db = journal.db;
  const draft = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    name: '/',
    date: '2026-11-01',
    journal_id: journal.id,
    company_id: 1,
    ref: 'scheduled-orig',
    auto_reverse: true,
    reverse_date: '2099-12-31',
    line_ids: [
      { account_id: accountId(db, '600000'), debit: 120, credit: 0 },
      { account_id: accountId(db, '211000'), debit: 0, credit: 120 },
    ],
  });
  db = server(draft.db, postMove(draft.db, draft.id));

  const source = read(db, 'account.move', draft.id);
  assert.ok(source.inalterable_hash);
  assert.equal(source.secure_sequence_number, 1);
  assert.ok(source.reversal_move_id, 'source must retain reversal_move_id for scheduled reversal');

  const reversal = read(db, 'account.move', source.reversal_move_id);
  assert.equal(reversal.state, 'draft');
  assert.equal(reversal.inalterable_hash, undefined, 'scheduled reversal draft must not be hashed');
  assert.equal(reversal.reversed_entry_id, source.id);

  assert.equal(checkInalterability(db, { journalId: journal.id })[0].status, 'ok');
});

test('large-journal posting extends chain using chain head and detects trust boundary corruption', () => {
  let db = seed();
  const journal = create(db, 'account.journal', { name: 'Secure HighVol', code: 'HVOL', restrict_mode_hash_table: true }); db = journal.db;

  const count = 30;
  for (let i = 0; i < count; i++) {
    const draft = create(db, 'account.move', {
      move_type: 'entry',
      state: 'draft',
      name: '/',
      date: '2026-11-01',
      journal_id: journal.id,
      company_id: 1,
      ref: `bulk-${i}`,
      line_ids: [
        { account_id: accountId(db, '600000'), debit: 10 + i, credit: 0 },
        { account_id: accountId(db, '211000'), debit: 0, credit: 10 + i },
      ],
    });
    db = postMove(draft.db, draft.id);
  }

  const jRec = read(db, 'account.journal', journal.id);
  const head = (jRec.secure_chain_heads ?? []).find((h) => h.company_id === 1);
  assert.ok(head);
  assert.equal(head.count, count);
  assert.equal(head.last_sequence, count);

  // Full-chain audit passes
  const audit = checkInalterability(db, { journalId: journal.id });
  assert.equal(audit[0].status, 'ok');

  // Verify corruption detection at trust boundary:
  // Tampering with the last secured entry prevents extending the chain
  const nextDraft = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    name: '/',
    date: '2026-11-02',
    journal_id: journal.id,
    company_id: 1,
    ref: 'corrupt-test',
    line_ids: [
      { account_id: accountId(db, '600000'), debit: 99, credit: 0 },
      { account_id: accountId(db, '211000'), debit: 0, credit: 99 },
    ],
  });

  const corruptedDb = {
    ...nextDraft.db,
    records: {
      ...nextDraft.db.records,
      'account.move': nextDraft.db.records['account.move'].map((m) =>
        m.id === head.last_move_id ? { ...m, inalterable_hash: 'forged_hash' } : m
      ),
    },
  };
  assert.throws(() => postMove(corruptedDb, nextDraft.id), /Cannot extend a corrupted secure entry chain/);
});
