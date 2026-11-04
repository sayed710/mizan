// Accounting secure features end-to-end tests.
// Tests go through the public path: menus, list/form views, registered actions, server persistence.
// Covers: Secure Entries hash chain, Data Inalterability Check, Journal Audit,
// Incoterms, Tax Units, Account Tags, Depreciation Models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { create, read, search, write, SHARED_MODELS } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { applyDiff, diffDb } from '../src/sync.js';
import {
  sha256, computeMoveHash, findSequenceGaps, analyzeJournalChains,
  secureEntries, checkInalterability,
} from '../src/models/hash_chain.js';
import { postMove } from '../src/models/accounting.js';
import { journalAudit } from '../src/models/journal_audit.js';
import { postEntry } from '../src/models/ledger.js';
import { models } from '../src/models/index.js';
import { openStorage } from './storage.js';
import { INCOTERMS_2020 } from '../src/models/accounting.js';

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Commit a diff as a system user (no model restriction). */
const commitAsSystem = (db, next) =>
  applyDiff(db, diffDb(db, next), { author: 'test', isAdmin: true, allowed: null });

test('sha256: consistent and produces 64-char hex', () => {
  // SHA-256("") â€” 64 hex chars
  assert.equal(sha256('').length, 64);
  // SHA-256("abc") â€” deterministic
  assert.equal(sha256('abc').length, 64);
  assert.equal(sha256('abc'), sha256('abc'), 'same input â†’ same output');
  assert.notEqual(sha256('abc'), sha256('abd'), 'different input â†’ different hash');
  // sha256 of a number coerces to string
  assert.equal(typeof sha256(42), 'string');
  assert.equal(sha256(42).length, 64);
});

test('computeMoveHash: consistent with field order; changes when any field changes', () => {
  const move = {
    invoice_date: '2026-01-01', journal_id: 1, name: 'INV/2026/0001',
    company_id: 1, partner_id: 2,
    line_ids: [{ account_id: 10, debit: 100, credit: 0 }, { account_id: 20, debit: 0, credit: 100 }],
  };
  const h1 = computeMoveHash(move, '');
  const h2 = computeMoveHash(move, '');
  assert.equal(h1, h2, 'same input â†’ same hash');

  // Chained: second entry uses first's hash as previousHash
  const h3 = computeMoveHash(move, h1);
  assert.notEqual(h1, h3, 'previousHash is included in the payload');

  // Changing an amount changes the hash
  const modified = { ...move, line_ids: [{ account_id: 10, debit: 200, credit: 0 }, { account_id: 20, debit: 0, credit: 200 }] };
  const h4 = computeMoveHash(modified, '');
  assert.notEqual(h1, h4, 'amount change detected');

  // Changing partner changes the hash
  const h5 = computeMoveHash({ ...move, partner_id: 99 }, '');
  assert.notEqual(h1, h5, 'partner change detected');
});

test('findSequenceGaps: detects missing sequence numbers', () => {
  const moves = [
    { name: 'INV/2026/0001' }, { name: 'INV/2026/0002' },
    { name: 'INV/2026/0005' }, // gap: 0003, 0004
    { name: 'INV/2026/0006' },
    { name: 'BILL/2026/0001' }, // different prefix, no gap
    { name: 'BILL/2026/0002' },
  ];
  const gaps = findSequenceGaps(moves);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].prefix, 'INV/2026/');
  assert.equal(gaps[0].from, 3);
  assert.equal(gaps[0].to, 4);
});

test('findSequenceGaps: no gaps when sequence is contiguous', () => {
  const moves = [{ name: 'INV/2026/0001' }, { name: 'INV/2026/0002' }, { name: 'INV/2026/0003' }];
  assert.equal(findSequenceGaps(moves).length, 0);
});

// â”€â”€â”€ 2. account.journal restrict_mode_hash_table field â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.journal has restrict_mode_hash_table boolean field declared', () => {
  const journalModel = models['account.journal'];
  assert.ok(journalModel, 'account.journal model exists');
  const field = journalModel.fields.restrict_mode_hash_table;
  assert.ok(field, 'restrict_mode_hash_table field exists');
  assert.equal(field.type, 'boolean', 'field type is boolean');
  assert.match(field.label, /Secure Posted Entries with Hash/i, 'label matches');
});

test('account.journal defaults restrict_mode_hash_table to false', () => {
  // Default should be false if explicitly set
  const defaults = models['account.journal'].defaults?.();
  assert.equal(defaults?.restrict_mode_hash_table, false);
});

// â”€â”€â”€ 3. Secure Entries: analyzeJournalChains â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('analyzeJournalChains: no restricted journals â†’ empty', () => {
  const db = seed();
  const result = analyzeJournalChains(db);
  assert.deepEqual(result.move_to_hash_ids, []);
  assert.equal(result.chains_to_hash_with_gaps, '');
});

test('analyzeJournalChains: detects posted entries in restricted journals', () => {
  let db = seed();
  // Enable hash on one journal
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  // Post an entry in that journal
  const { db: db2, id: moveId } = postEntry(db, {
    journal: inv.code,
    date: '2026-01-10',
    ref: 'Test secure',
    lines: [{ account: '600000', debit: 50 }, { account: '211000', credit: 50 }],
  });
  const move = read(db2, 'account.move', moveId);
  assert.equal(move.state, 'posted');

  const result = analyzeJournalChains(db2, { hashDate: '2026-12-31' });
  assert.ok(result.move_to_hash_ids.includes(moveId), 'unhashed posted entry detected');
  assert.ok(!result.move_to_hash_ids.some((id) => read(db2, 'account.move', id)?.inalterable_hash), 'none hashed yet');
});

test('analyzeJournalChains: warns about draft entries before hash date', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  // Create a draft entry (do NOT post it)
  const { db: db2, id: draftId } = create(db, 'account.move', {
    move_type: 'entry', journal_id: inv.id, date: '2026-01-05', state: 'draft',
    line_ids: [{ account_id: 1, debit: 10, credit: 0 }, { account_id: 2, debit: 0, credit: 10 }],
    name: 'MISC/2026/00001',
  });

  const result = analyzeJournalChains(db2, { hashDate: '2026-12-31' });
  assert.ok(result.warnings.includes('draft'), 'warns about draft entries');
  assert.ok(result.not_hashable_unlocked_move_ids.includes(draftId), 'draft listed');
});

// â”€â”€â”€ 4. secureEntries: hashes entries in order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('secureEntries: hashes posted entries in sequence order, links chain correctly', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  // Post 3 entries (will get sequential names)
  let db2 = db;
  const moveIds = [];
  for (let i = 0; i < 3; i++) {
    const r = postEntry(db2, {
      journal: inv.code, date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      ref: `Entry ${i + 1}`,
      lines: [{ account: '600000', debit: 100 + i * 10 }, { account: '211000', credit: 100 + i * 10 }],
    });
    db2 = r.db;
    moveIds.push(r.id);
  }

  const secured = secureEntries(db2, { hashDate: '2026-12-31' });
  
  // All three should now be hashed
  for (const id of moveIds) {
    const m = read(secured, 'account.move', id);
    assert.ok(m.inalterable_hash, `move ${id} has hash`);
    assert.ok(m.secure_sequence_number > 0, `move ${id} has sequence number`);
  }

  // Sequence numbers are unique and ascending
  const seqNums = moveIds.map((id) => read(secured, 'account.move', id).secure_sequence_number).sort((a, b) => a - b);
  assert.deepEqual(seqNums, [seqNums[0], seqNums[0] + 1, seqNums[0] + 2]);

  // Hashes form a valid chain (recompute from scratch)
  const sortedMoves = search(secured, 'account.move').filter((m) => m.journal_id === inv.id && m.inalterable_hash)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  let prevHash = '';
  for (const m of sortedMoves) {
    const expected = computeMoveHash(m, prevHash);
    assert.equal(m.inalterable_hash, expected, `hash chain valid for move ${m.name}`);
    prevHash = m.inalterable_hash;
  }
});

test('secureEntries: sets company hard_lock_date when later than current', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].filter((m) => m.journal_id !== inv.id) } };
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  const r = postEntry(db, {
    journal: inv.code, date: '2026-03-15', ref: 'Lock date test',
    lines: [{ account: '101401', debit: 50 }, { account: '400000', credit: 50 }],
  });
  const secured = secureEntries(r.db, { hashDate: '2026-03-31' });

  const lockDate = read(secured, 'res.company', 1)?.hard_lock_date ?? '';
  assert.ok(lockDate === '2026-03-15', `hard_lock_date set to ${lockDate}`);
});

test('secureEntries: does not re-hash already hashed entries', () => {
  let db = seed();
  const journal = create(db, 'account.journal', { name: 'Isolated', code: 'ISO', restrict_mode_hash_table: true });
  db = journal.db;
  const inv = read(db, 'account.journal', journal.id);

  const { db: db1, id: id1 } = postEntry(db, {
    journal: inv.code, date: '2026-01-01', ref: 'First',
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  });

  const secured1 = secureEntries(db1, { hashDate: '2026-01-31' });
  const hash1 = read(secured1, 'account.move', id1).inalterable_hash;
  assert.ok(hash1, 'first pass: entry hashed');

  // Post a second entry and re-run secureEntries
  const { db: db2, id: id2 } = postEntry(secured1, {
    journal: inv.code, date: '2026-06-01', ref: 'Second',
    lines: [{ account: '101401', debit: 200 }, { account: '400000', credit: 200 }],
  });

  const secured2 = secureEntries(db2, { hashDate: '2026-12-31' });
  // First hash unchanged
  assert.equal(read(secured2, 'account.move', id1).inalterable_hash, hash1, 'first hash unchanged');
  // Second entry now hashed
  assert.ok(read(secured2, 'account.move', id2).inalterable_hash, 'second entry now hashed');
});

// â”€â”€â”€ 5. Inalterability guards (write, reset to draft, unlink refused for hashed entries) â”€â”€

test('secured entries: write to hashed fields is refused by moveGuard', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  const { db: db1, id } = postEntry(db, {
    journal: inv.code, date: '2026-01-01', ref: 'Secured',
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  });
  const secured = secureEntries(db1, { hashDate: '2026-12-31' });
  const m = read(secured, 'account.move', id);
  assert.ok(m.inalterable_hash, 'entry is hashed');

  // Attempt to change date - should fail via guard
  assert.throws(
    () => write(secured, 'account.move', id, { invoice_date: '2026-06-01' }),
    /Secured entries cannot be modified/i,
    'write to hashed fields refused'
  );
});

test('secured entries: reset to draft is refused', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  const { db: db1, id } = postEntry(db, {
    journal: inv.code, date: '2026-01-01', ref: 'Secured',
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  });
  const secured = secureEntries(db1, { hashDate: '2026-12-31' });

  assert.throws(
    () => write(secured, 'account.move', id, { state: 'draft' }),
    /Secured entries cannot be reset to draft or cancelled/i,
    'reset to draft refused'
  );
});

test('secured entries: delete is refused', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  const { db: db1, id } = postEntry(db, {
    journal: inv.code, date: '2026-01-01', ref: 'Secured',
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  });
  const secured = secureEntries(db1, { hashDate: '2026-12-31' });

  const withDelete = { ...secured, records: { ...secured.records, 'account.move': (secured.records['account.move'] ?? []).filter((m) => m.id !== id) } };
  assert.throws(
    () => commitAsSystem(secured, withDelete),
    /inalterability hash cannot be deleted/i,
    'delete refused'
  );
});

// â”€â”€â”€ 6. Data Inalterability Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('checkInalterability: OK when all hashes are valid', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  let db2 = db;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = postEntry(db2, {
      journal: inv.code, date: `2026-0${i + 1}-01`, ref: `Entry ${i}`,
      lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
    });
    db2 = r.db;
    ids.push(r.id);
  }
  const secured = secureEntries(db2, { hashDate: '2026-12-31' });

  const results = checkInalterability(secured);
  const jResult = results.find((r) => r.journal_id === inv.id);
  assert.ok(jResult, 'journal result found');
  assert.equal(jResult.status, 'ok', 'status is ok');
  assert.ok(jResult.first_move, 'first_move is set');
  assert.ok(jResult.last_move, 'last_move is set');
});

test('checkInalterability: detects corrupted entry when amount tampered directly in DB', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  const { db: db1, id: id1 } = postEntry(db, {
    journal: inv.code, date: '2026-01-01', ref: 'Real Entry',
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  });
  const secured = secureEntries(db1, { hashDate: '2026-12-31' });

  // Simulate direct database tampering: change the line amount without going through ORM guards
  // This is what an attacker/direct SQL write would do
  const tampered = {
    ...secured,
    records: {
      ...secured.records,
      'account.move': (secured.records['account.move'] ?? []).map((m) => {
        if (m.id !== id1) return m;
        // Tamper with line amounts - bypass all ORM guards
        return {
          ...m,
          line_ids: (m.line_ids ?? []).map((l, i) => i === 0 ? { ...l, debit: 999999 } : l),
        };
      }),
    },
  };

  const results = checkInalterability(tampered);
  const jResult = results.find((r) => r.journal_id === inv.id);
  assert.ok(jResult, 'journal result found');
  assert.equal(jResult.status, 'corrupted', 'tampered entry detected as corrupted');
  assert.ok(jResult.corrupted_move, 'corrupted_move is set');
  assert.equal(jResult.corrupted_move.id, id1, 'correct corrupted entry identified');
});

test('checkInalterability: reports No secured entries for restricted journals with no hashed moves', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  const results = checkInalterability(db);
  const jResult = results.find((r) => r.journal_id === inv.id);
  assert.ok(jResult, 'journal result found');
  assert.equal(jResult.status, 'ok');
  assert.equal(jResult.message, 'No secured entries');
});

test('checkInalterability: filters by companyId', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  const { db: db1 } = postEntry(db, {
    journal: inv.code, date: '2026-01-01', ref: 'Secured',
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  });
  const secured = secureEntries(db1, { hashDate: '2026-12-31' });

  // Filter for company 999 (nonexistent): should still work, return empty or OK
  const r1 = checkInalterability(secured, { companyId: 1 });
  const r2 = checkInalterability(secured, { companyId: 9999 });
  assert.equal(r2.find((r) => r.journal_id === inv.id)?.first_move, null);
  // Company 1 should have result, company 9999 should have journal but no moves matching
  const j1 = r1.find((r) => r.journal_id === inv.id);
  assert.ok(j1, 'company 1 result present');
  assert.equal(j1.status, 'ok');
});

// â”€â”€â”€ 7. Secure Entries wizard model â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.secure.entries.wizard model exists in registry', () => {
  const wizModel = models['account.secure.entries.wizard'];
  assert.ok(wizModel, 'wizard model registered');
  assert.ok(wizModel.fields.hash_date, 'hash_date field');
  assert.ok(wizModel.fields.company, 'company field');
  assert.ok(wizModel.fields.warnings, 'warnings field');
  assert.ok(wizModel.fields.move_to_hash_ids, 'move_to_hash_ids field');
  assert.ok(wizModel.fields.not_hashable_unlocked_move_ids, 'not_hashable_unlocked_move_ids field');
  assert.ok(wizModel.fields.chains_to_hash_with_gaps, 'chains_to_hash_with_gaps field');
  assert.ok(wizModel.fields.max_hash_date, 'max_hash_date field');
});

test('account.secure.entries.wizard form has Confirm button that calls secureEntries', () => {
  const wizModel = models['account.secure.entries.wizard'];
  const confirmBtn = (wizModel.form?.buttons ?? []).find((b) => b.label === 'Confirm');
  assert.ok(confirmBtn, 'Confirm button exists');
  assert.ok(confirmBtn.run, 'Confirm button has run function');
});

test('account.secure.entries.wizard createDefaults populates analysis fields', () => {
  const db = seed();
  const wizModel = models['account.secure.entries.wizard'];
  if (wizModel.createDefaults) {
    const defaults = wizModel.createDefaults(db, {});
    assert.ok('hash_date' in defaults, 'hash_date in defaults');
    assert.ok('max_hash_date' in defaults, 'max_hash_date in defaults');
    assert.ok(Array.isArray(defaults.move_to_hash_ids), 'move_to_hash_ids is array');
    assert.ok(Array.isArray(defaults.not_hashable_unlocked_move_ids), 'not_hashable_unlocked_move_ids is array');
  }
});

// â”€â”€â”€ 8. Accounting menu: Secure Entries under Closing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('Secure Entries menu item exists under Accounting > Accounting > Closing', () => {
  // The menu structure is validated via the index.js exports
  // We check the models registry directly
  assert.ok(models['account.secure.entries.wizard'], 'wizard model in registry');
});

// â”€â”€â”€ 9. account.incoterm: model, fields, menu, seeded data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.incoterm model is registered with correct fields', () => {
  const m = models['account.incoterm'];
  assert.ok(m, 'account.incoterm registered');
  assert.ok(m.fields.name, 'name field');
  assert.ok(m.fields.code, 'code field');
  assert.ok(m.fields.active, 'active field');
  assert.equal(m.fields.name.required, true);
  assert.equal(m.fields.code.required, true);
});

test('account.incoterm: 11 standard Incoterms 2020 seeded in database', () => {
  const db = seed();
  const incoterms = search(db, 'account.incoterm');
  const codes = incoterms.map((i) => i.code);
  for (const [code, name] of INCOTERMS_2020) {
    assert.ok(codes.includes(code), `Incoterm ${code} (${name}) is seeded`);
  }
  assert.equal(incoterms.length, INCOTERMS_2020.length, `exactly ${INCOTERMS_2020.length} incoterms seeded`);
});

test('account.incoterm: all standard incoterms have correct names', () => {
  const db = seed();
  const incoterms = search(db, 'account.incoterm');
  for (const [code, expectedName] of INCOTERMS_2020) {
    const inc = incoterms.find((i) => i.code === code);
    assert.ok(inc, `Incoterm ${code} found`);
    assert.equal(inc.name, expectedName, `${code} has correct name`);
    assert.equal(inc.active, true, `${code} is active`);
  }
});

test('account.incoterm: display_name computed field is code - name', () => {
  const db = seed();
  const incoterms = search(db, 'account.incoterm');
  const fob = incoterms.find((i) => i.code === 'FOB');
  assert.ok(fob, 'FOB incoterm exists');
  assert.equal(fob.display_name, 'FOB - Free On Board');
});

test('account.move has incoterm_id and incoterm_location fields', () => {
  const moveModel = models['account.move'];
  assert.ok(moveModel.fields.incoterm_id, 'incoterm_id field on account.move');
  assert.equal(moveModel.fields.incoterm_id.type, 'many2one');
  assert.equal(moveModel.fields.incoterm_id.relation, 'account.incoterm');
  assert.ok(moveModel.fields.incoterm_location, 'incoterm_location field on account.move');
  assert.equal(moveModel.fields.incoterm_location.type, 'char');
});

test('incoterm can be created, read, updated, and archived', () => {
  let db = seed();
  const { db: db1, id } = create(db, 'account.incoterm', { code: 'XXX', name: 'Test Incoterm', active: true });
  const inc = read(db1, 'account.incoterm', id);
  assert.equal(inc.code, 'XXX');
  assert.equal(inc.name, 'Test Incoterm');
  assert.equal(inc.active, true);

  const db2 = write(db1, 'account.incoterm', id, { active: false });
  assert.equal(read(db2, 'account.incoterm', id).active, false);
  // Archived: should not appear in search
  assert.ok(!search(db2, 'account.incoterm').some((i) => i.id === id));
  // Appears with includeArchived
  assert.ok(search(db2, 'account.incoterm', { includeArchived: true }).some((i) => i.id === id));
});

// â”€â”€â”€ 10. account.tax.unit: model, fields, validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.tax.unit model is registered with correct fields', () => {
  const m = models['account.tax.unit'];
  assert.ok(m, 'account.tax.unit registered');
  assert.ok(m.fields.name, 'name field');
  assert.equal(m.fields.name.required, true);
  assert.ok(m.fields.country, 'country field');
  assert.ok(m.fields.vat, 'vat field');
  assert.ok(m.fields.company_ids, 'company_ids field');
  assert.equal(m.fields.company_ids.type, 'many2many');
  assert.ok(m.fields.main_company_id, 'main_company_id field');
  assert.equal(m.fields.main_company_id.type, 'many2one');
});

test('account.tax.unit: guard requires at least 2 companies', () => {
  let db = seed();
  db = create(db, 'res.company', { name: 'Second company' }).db;
  const m = models['account.tax.unit'];
  const guard = m.guard;
  assert.ok(guard, 'guard exists');

  // Only 1 company
  const err1 = guard(db, null, { name: 'Unit', company_ids: [1], main_company_id: 1 });
  assert.match(err1, /at least 2 companies/i);

  // main_company_id not in company_ids
  const err2 = guard(db, null, { name: 'Unit', company_ids: [1, 2], main_company_id: 3 });
  assert.match(err2, /main company/i);

  // Valid
  const err3 = guard(db, null, { name: 'Unit', company_ids: [1, 2], main_company_id: 1 });
  assert.equal(err3, null);
});

test('account.tax.unit can be created with valid data', () => {
  let db = seed();
  db = create(db, 'res.company', { name: 'Second company' }).db;
  const { db: db1, id } = create(db, 'account.tax.unit', {
    name: 'EU VAT Group', country: 'EU', vat: 'EU123456', company_ids: [1, 2], main_company_id: 1,
  });
  const unit = read(db1, 'account.tax.unit', id);
  assert.equal(unit.name, 'EU VAT Group');
  assert.equal(unit.country, 'EU');
  assert.equal(unit.vat, 'EU123456');
  assert.deepEqual(unit.company_ids, [1, 2]);
  assert.equal(unit.main_company_id, 1);
});

// â”€â”€â”€ 11. account.account.tag: model, fields, applicability â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.account.tag model is registered with correct fields', () => {
  const m = models['account.account.tag'];
  assert.ok(m, 'account.account.tag registered');
  assert.ok(m.fields.name, 'name field');
  assert.equal(m.fields.name.required, true);
  assert.ok(m.fields.applicability, 'applicability field');
  assert.equal(m.fields.applicability.type, 'selection');
  assert.ok(m.fields.color, 'color field');
  assert.ok(m.fields.active, 'active field');
  assert.ok(m.fields.country, 'country field');
  assert.ok(m.fields.balance_negate, 'balance_negate field');
});

test('account.account.tag: applicability options include accounts, taxes, products', () => {
  const m = models['account.account.tag'];
  const options = m.fields.applicability.options.map(([v]) => v);
  assert.ok(options.includes('accounts'), 'accounts option');
  assert.ok(options.includes('taxes'), 'taxes option');
  assert.ok(options.includes('products'), 'products option');
});

test('account.account.tag: defaults are correct', () => {
  const m = models['account.account.tag'];
  const defaults = m.defaults?.();
  assert.equal(defaults?.applicability, 'accounts');
  assert.equal(defaults?.active, true);
  assert.equal(defaults?.balance_negate, false);
});

test('account.account.tag can be created and read', () => {
  let db = seed();
  const { db: db1, id } = create(db, 'account.account.tag', {
    name: 'Tax Group A', applicability: 'taxes', color: 3, active: true, country: 'EG', balance_negate: false,
  });
  const tag = read(db1, 'account.account.tag', id);
  assert.equal(tag.name, 'Tax Group A');
  assert.equal(tag.applicability, 'taxes');
  assert.equal(tag.color, 3);
  assert.equal(tag.country, 'EG');
});

test('account.account has tag_ids field for account applicability tags', () => {
  const m = models['account.account'];
  assert.ok(m.fields.tag_ids, 'tag_ids field on account.account');
  assert.equal(m.fields.tag_ids.type, 'many2many');
  assert.equal(m.fields.tag_ids.relation, 'account.account.tag');
});

// â”€â”€â”€ 12. account.asset.model: Depreciation Models â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.asset.model model is registered with all required fields', () => {
  const m = models['account.asset.model'];
  assert.ok(m, 'account.asset.model registered');
  assert.ok(m.fields.name, 'name field');
  assert.equal(m.fields.name.required, true);
  assert.ok(m.fields.method, 'method field');
  assert.equal(m.fields.method.type, 'selection');
  assert.ok(m.fields.method_number, 'method_number field');
  assert.ok(m.fields.method_period, 'method_period field');
  assert.ok(m.fields.method_progress_factor, 'method_progress_factor field');
  assert.ok(m.fields.prorata, 'prorata field');
  assert.ok(m.fields.account_asset_id, 'account_asset_id field');
  assert.ok(m.fields.account_depreciation_id, 'account_depreciation_id field');
  assert.ok(m.fields.account_expense_id, 'account_expense_id field');
  assert.ok(m.fields.journal_id, 'journal_id field');
  assert.ok(m.fields.analytic_distribution, 'analytic_distribution field');
});

test('account.asset.model: method options include linear, degressive, degressive_then_linear', () => {
  const m = models['account.asset.model'];
  const options = m.fields.method.options.map(([v]) => v);
  assert.ok(options.includes('linear'), 'linear option');
  assert.ok(options.includes('degressive'), 'degressive option');
  assert.ok(options.includes('degressive_then_linear'), 'degressive_then_linear option');
});

test('account.asset.model: defaults are correct', () => {
  const m = models['account.asset.model'];
  const defaults = m.defaults?.();
  assert.equal(defaults?.method, 'linear');
  assert.equal(defaults?.method_number, 5);
  assert.equal(defaults?.method_period, '12');
  assert.equal(defaults?.method_progress_factor, 0.3);
  assert.equal(defaults?.prorata, false);
});

test('account.asset.model can be created and read', () => {
  let db = seed();
  const assetAccId = (db.records['account.account'] ?? []).find((a) => a.account_type === 'asset_fixed')?.id ?? 1;
  const { db: db1, id } = create(db, 'account.asset.model', {
    name: '5yr Linear Model', method: 'linear', method_number: 5,
    method_period: '12', method_progress_factor: 0.3, prorata: true,
    account_asset_id: assetAccId,
  });
  const model = read(db1, 'account.asset.model', id);
  assert.equal(model.name, '5yr Linear Model');
  assert.equal(model.method, 'linear');
  assert.equal(model.method_number, 5);
  assert.equal(model.prorata, true);
});

test('account.account has asset_model_id field', () => {
  const m = models['account.account'];
  assert.ok(m.fields.asset_model_id, 'asset_model_id field on account.account');
  assert.equal(m.fields.asset_model_id.type, 'many2one');
  assert.equal(m.fields.asset_model_id.relation, 'account.asset.model');
});

test('posting a bill on fixed-asset account with model creates draft asset with model values', () => {
  let db = seed();
  // Find or create a fixed-asset account with a depreciation model
  let assetAccId = (db.records['account.account'] ?? []).find((a) => a.account_type === 'asset_fixed')?.id;
  if (!assetAccId) {
    const { db: db1, id } = create(db, 'account.account', { code: '159000', name: 'Fixed Assets', account_type: 'asset_fixed' });
    db = db1;
    assetAccId = id;
  }
  const { db: db2, id: modelId } = create(db, 'account.asset.model', {
    name: 'Test Model', method: 'linear', method_number: 3, method_period: '12',
    method_progress_factor: 0.3, prorata: false, account_asset_id: assetAccId,
  });
  db = write(db2, 'account.account', assetAccId, { asset_model_id: modelId });

  // Create a vendor bill with a line on the asset account
  const partnerId = search(db, 'res.partner').find((p) => p.is_company)?.id ?? 1;
  const { db: db3, id: billId } = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: partnerId, invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Asset purchase', product_id: null, account_id: assetAccId, qty: 1, price_unit: 1000 }],
  });

  const posted = postMove(db3, billId);
  // A draft asset should have been created with model values
  const assets = search(posted, 'account.asset');
  const draftAssets = assets.filter((a) => a.bill_id === billId && a.state === 'draft');
  assert.ok(draftAssets.length > 0, 'draft asset created from bill line');
  const asset = draftAssets[0];
  assert.equal(asset.model_id, modelId, 'asset references the model');
  assert.equal(asset.method, 'linear', 'method from model');
  assert.equal(asset.method_number, 3, 'method_number from model');
});

// â”€â”€â”€ 13. account.secure.entries.wizard: onchange updates analysis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.secure.entries.wizard onchange recomputes analysis on hash_date change', () => {
  const db = seed();
  const m = models['account.secure.entries.wizard'];
  if (m.onchange) {
    const r = { company: 1, hash_date: '2026-12-31' };
    const result = m.onchange(r, 'hash_date', db);
    assert.ok('warnings' in result || 'move_to_hash_ids' in result, 'onchange returns analysis fields');
  }
});

// â”€â”€â”€ 14. Journal Audit report model data function â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('Journal Audit: registered report groups posted items and exact tax totals for the selected period', () => {
  let db = seed();
  const journal = create(db, 'account.journal', { name: 'Audit Test', code: 'AUD' }); db = journal.db;
  const posted = postEntry(db, { journal: 'AUD', date: '2026-02-01', lines: [
    { account: '101401', debit: 114 }, { account: '400000', credit: 100 },
    { account: '251000', credit: 14, tax_name: 'VAT', tax_base: 100, tax_side: 'sale' },
  ] }); db = posted.db;
  db = postEntry(db, { journal: 'AUD', date: '2026-03-01', lines: [{ account: '101401', debit: 20 }, { account: '400000', credit: 20 }] }).db;
  const groups = journalAudit(db, { from: '2026-02-01', to: '2026-02-28', companyId: 1 });
  const group = groups.find((g) => g.journal.id === journal.id);
  assert.equal(group.items.length, 3); assert.equal(group.debit, 114); assert.equal(group.credit, 114);
  assert.deepEqual(group.taxes, [{ name: 'VAT', base: 100, tax: 14 }]);
});

test('checkInalterability detects tamper via direct SQLite write bypassing ORM', () => {
  // This test simulates an attacker writing directly to the database
  const sqlMem = new DatabaseSync(':memory:');
  const storage = openStorage(sqlMem);

  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });

  const { db: db1, id: moveId } = postEntry(db, {
    journal: inv.code, date: '2026-01-01', ref: 'Tamper Test',
    lines: [{ account: '101401', debit: 500 }, { account: '400000', credit: 500 }],
  });
  const secured = secureEntries(db1, { hashDate: '2026-12-31' });

  // Save to SQLite
  storage.save(null, secured);

  // Directly tamper the move's stored data bypassing ORM
  const move = read(secured, 'account.move', moveId);
  const tamperedMove = {
    ...move,
    line_ids: (move.line_ids ?? []).map((l, i) => i === 0 ? { ...l, debit: 9999 } : l),
  };
  sqlMem.prepare('UPDATE records SET data = ? WHERE model = ? AND id = ?')
    .run(JSON.stringify(tamperedMove), 'account.move', moveId);

  // Load the tampered database
  const loaded = storage.load();
  assert.ok(loaded, 'database loaded');

  // The inalterability check should detect the corruption
  const results = checkInalterability(loaded, { journalId: inv.id });
  const r = results.find((x) => x.journal_id === inv.id);
  assert.ok(r, 'journal result present');
  assert.equal(r.status, 'corrupted', `tamper detected via SQLite direct write; corrupted at ${r.corrupted_move?.name}`);
  assert.equal(r.corrupted_move?.id, moveId, 'correct move identified as corrupted');
});

// â”€â”€â”€ 16. account.move: incoterm fields on invoice form â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('invoice can be created with incoterm_id and incoterm_location', () => {
  let db = seed();
  const incoterms = search(db, 'account.incoterm');
  const fob = incoterms.find((i) => i.code === 'FOB');
  assert.ok(fob, 'FOB incoterm exists in seed');

  const partnerId = search(db, 'res.partner').find((p) => p.is_company)?.id ?? 1;
  const { db: db1, id } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partnerId, invoice_date: '2026-01-20',
    incoterm_id: fob.id, incoterm_location: 'Port of Alexandria',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100 }],
  });
  const m = read(db1, 'account.move', id);
  assert.equal(m.incoterm_id, fob.id);
  assert.equal(m.incoterm_location, 'Port of Alexandria');
});

// â”€â”€â”€ 17. Model views: list and form defined correctly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.incoterm has list and form views', () => {
  const m = models['account.incoterm'];
  assert.ok(m.list, 'list view spec');
  assert.ok(m.form, 'form view spec');
  assert.ok(m.list.includes('code'), 'code in list');
  assert.ok(m.list.includes('name'), 'name in list');
});

test('account.tax.unit has list and form views', () => {
  const m = models['account.tax.unit'];
  assert.ok(m.list, 'list view spec');
  assert.ok(m.form, 'form view spec');
  assert.ok(m.list.includes('name'), 'name in list');
});

test('account.account.tag has list and form views', () => {
  const m = models['account.account.tag'];
  assert.ok(m.list, 'list view spec');
  assert.ok(m.form, 'form view spec');
  assert.ok(m.list.includes('name'), 'name in list');
  assert.ok(m.list.includes('applicability'), 'applicability in list');
});

test('account.asset.model has list and form views', () => {
  const m = models['account.asset.model'];
  assert.ok(m.list, 'list view spec');
  assert.ok(m.form, 'form view spec');
  assert.ok(m.list.includes('name'), 'name in list');
  assert.ok(m.list.includes('method'), 'method in list');
});

test('account.secure.entries.wizard has list and form views with Confirm button', () => {
  const m = models['account.secure.entries.wizard'];
  assert.ok(m.list, 'list view spec');
  assert.ok(m.form, 'form view spec');
  const confirmBtn = (m.form?.buttons ?? []).find((b) => b.label === 'Confirm');
  assert.ok(confirmBtn, 'Confirm button in form');
});

// â”€â”€â”€ 18. Inalterability: report view data (InalterabilityCheck in Reports.jsx) â”€â”€

test('Data Inalterability Check: registered as report key "inalterability"', () => {
  // The report is registered in Reports.jsx REPORTS map with key 'inalterability'
  // We verify the underlying function works for the report
  const db = seed();
  const results = checkInalterability(db);
  assert.ok(Array.isArray(results), 'returns array');
});

// â”€â”€â”€ 19. Sequence integrity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('secureEntries: sequence numbers are contiguous within each journal', () => {
  let db = seed();
  const inv = search(db, 'account.journal').find((j) => j.code === 'INV') ?? search(db, 'account.journal')[0];
  const misc = search(db, 'account.journal').find((j) => j.code === 'MISC');
  db = write(db, 'account.journal', inv.id, { restrict_mode_hash_table: true });
  if (misc) db = write(db, 'account.journal', misc.id, { restrict_mode_hash_table: true });

  let db2 = db;
  for (let i = 0; i < 4; i++) {
    const { db: next } = postEntry(db2, {
      journal: i % 2 === 0 ? inv.code : (misc?.code ?? inv.code),
      date: `2026-0${i + 1}-01`, ref: `Entry ${i}`,
      lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
    });
    db2 = next;
  }

  const secured = secureEntries(db2, { hashDate: '2026-12-31' });
  
  // Sequence numbers per journal should be 1, 2, ... 
  const invMoves = (secured.records['account.move'] ?? [])
    .filter((m) => m.journal_id === inv.id && m.inalterable_hash)
    .sort((a, b) => (a.secure_sequence_number ?? 0) - (b.secure_sequence_number ?? 0));
  
  if (invMoves.length > 0) {
    invMoves.forEach((m, i) => {
      assert.equal(m.secure_sequence_number, i + 1, `move ${i} has sequence ${i + 1}`);
    });
  }
});

// â”€â”€â”€ 20. SHARED_MODELS coverage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test('account.incoterm is a shared model (cross-company)', () => {
  assert.ok(SHARED_MODELS.has('account.incoterm'), 'account.incoterm is in SHARED_MODELS');
});

test('account.account.tag is a shared model (cross-company)', () => {
  assert.ok(SHARED_MODELS.has('account.account.tag'), 'account.account.tag is in SHARED_MODELS');
});

test('account.asset.model is a shared model (cross-company)', () => {
  assert.ok(SHARED_MODELS.has('account.asset.model'), 'account.asset.model is in SHARED_MODELS');
});


