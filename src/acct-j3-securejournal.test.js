import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { postEntry } from './models/ledger.js';
import { secureEntries } from './models/hash_chain.js';
import { applyDiff, diffDb } from './sync.js';

const syncServer = (oldDb, nextDb, ctx = {}) => applyDiff(oldDb, diffDb(oldDb, nextDb), ctx);

test('restrict_mode_hash_table can be toggled on for any journal', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => !j.restrict_mode_hash_table);
  assert.ok(journal, 'unrestricted journal found');

  const updated = write(db, 'account.journal', journal.id, { restrict_mode_hash_table: true });
  const serverDb = syncServer(db, updated);
  assert.equal(read(serverDb, 'account.journal', journal.id).restrict_mode_hash_table, true);
});

test('restrict_mode_hash_table can be toggled off if journal has no secured entries (even with unhashed posted moves)', () => {
  let db = seed();
  const res = create(db, 'account.journal', { name: 'Fresh Secure', code: 'FS', restrict_mode_hash_table: true });
  db = res.db;
  const journalId = res.id;

  // Post an unhashed entry in this journal
  const entryRes = postEntry(db, {
    journal: 'FS',
    date: '2026-01-10',
    company: 1,
    lines: [
      { account: '600000', debit: 100 },
      { account: '211000', credit: 100 },
    ],
  });
  db = entryRes.db;

  // Toggle off when no entries are secured
  const updated = write(db, 'account.journal', journalId, { restrict_mode_hash_table: false });
  const serverDb = syncServer(db, updated);
  assert.equal(read(serverDb, 'account.journal', journalId).restrict_mode_hash_table, false);
});

test('restrict_mode_hash_table cannot be toggled off once entries are secured (via secureEntries)', () => {
  let db = seed();
  const res = create(db, 'account.journal', { name: 'Secured Journal', code: 'SJ', restrict_mode_hash_table: true });
  db = res.db;
  const journalId = res.id;

  // Post entry in this journal
  const entryRes = postEntry(db, {
    journal: 'SJ',
    date: '2026-01-10',
    company: 1,
    lines: [
      { account: '600000', debit: 150 },
      { account: '211000', credit: 150 },
    ],
  });
  db = entryRes.db;

  // Secure entries up to 2026-01-31
  db = secureEntries(db, { companyId: 1, hashDate: '2026-01-31' });

  const securedJournal = read(db, 'account.journal', journalId);
  assert.ok((securedJournal.secure_chain_heads ?? []).length > 0, 'secure_chain_heads is non-empty');
  const securedMove = read(db, 'account.move', entryRes.id);
  assert.ok(securedMove.inalterable_hash, 'move has inalterable_hash');

  // Attempt to switch restrict_mode_hash_table from true to false via write
  assert.throws(
    () => write(db, 'account.journal', journalId, { restrict_mode_hash_table: false }),
    /Cannot turn off Secure Posted Entries with Hash on a journal with secured entries/
  );

  // Attempt to switch restrict_mode_hash_table from true to false via diffDb + applyDiff
  const attemptedClientState = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === journalId ? { ...j, restrict_mode_hash_table: false } : j)),
    },
  };
  assert.throws(
    () => syncServer(db, attemptedClientState),
    /Cannot turn off Secure Posted Entries with Hash on a journal with secured entries/
  );
  // Also verify with isAdmin: true
  assert.throws(
    () => syncServer(db, attemptedClientState, { isAdmin: true }),
    /Cannot turn off Secure Posted Entries with Hash on a journal with secured entries/
  );
});

test('restrict_mode_hash_table cannot be toggled off if journal has a move with inalterable_hash even if secure_chain_heads is empty', () => {
  let db = seed();
  const res = create(db, 'account.journal', { name: 'Direct Hashed Move Journal', code: 'DHM', restrict_mode_hash_table: true });
  db = res.db;
  const journalId = res.id;

  // Post a valid balanced entry
  const entryRes = postEntry(db, {
    journal: 'DHM',
    date: '2026-01-10',
    company: 1,
    lines: [
      { account: '600000', debit: 100 },
      { account: '211000', credit: 100 },
    ],
  });
  db = entryRes.db;

  // Mark move with an inalterable hash (simulating move hash present without heads)
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (m.id === entryRes.id ? { ...m, inalterable_hash: 'hash-abc-123' } : m)),
    },
  };

  const attemptedClientState = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === journalId ? { ...j, restrict_mode_hash_table: false } : j)),
    },
  };

  assert.throws(
    () => syncServer(db, attemptedClientState),
    /Cannot turn off Secure Posted Entries with Hash on a journal with secured entries/
  );
});

test('restrict_mode_hash_table cannot be toggled off if journal has non-empty secure_chain_heads even without hashed moves', () => {
  let db = seed();
  const res = create(db, 'account.journal', { name: 'Head Journal', code: 'HJ', restrict_mode_hash_table: true });
  db = res.db;
  const journalId = res.id;

  // Simulate server state where secure_chain_heads is non-empty without hashed moves in the table
  db = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === journalId ? {
        ...j,
        secure_chain_heads: [{ company_id: 1, count: 1, last_sequence: 1, last_hash: 'head-hash', last_move_id: 999, last_move_name: 'HJ/2026/0001' }],
      } : j)),
    },
  };

  const attemptedClientState = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === journalId ? { ...j, restrict_mode_hash_table: false } : j)),
    },
  };

  assert.throws(
    () => syncServer(db, attemptedClientState),
    /Cannot turn off Secure Posted Entries with Hash on a journal with secured entries/
  );

  // Also reject if client tries to clear secure_chain_heads simultaneously
  const attemptedClearAndDisable = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === journalId ? { ...j, restrict_mode_hash_table: false, secure_chain_heads: [] } : j)),
    },
  };

  assert.throws(
    () => syncServer(db, attemptedClearAndDisable),
    /Cannot turn off Secure Posted Entries with Hash on a journal with secured entries/
  );
});

test('journal with secured entries allows updating other fields without error', () => {
  let db = seed();
  const res = create(db, 'account.journal', { name: 'Original Name', code: 'ON', restrict_mode_hash_table: true });
  db = res.db;
  const journalId = res.id;

  const entryRes = postEntry(db, {
    journal: 'ON',
    date: '2026-01-10',
    company: 1,
    lines: [
      { account: '600000', debit: 50 },
      { account: '211000', credit: 50 },
    ],
  });
  db = entryRes.db;
  db = secureEntries(db, { companyId: 1, hashDate: '2026-01-31' });

  // Updating name
  const updated = write(db, 'account.journal', journalId, { name: 'Updated Name' });
  const serverDb = syncServer(db, updated);
  assert.equal(read(serverDb, 'account.journal', journalId).name, 'Updated Name');
  assert.equal(read(serverDb, 'account.journal', journalId).restrict_mode_hash_table, true);
});

test('Arabic translation exists for the guard rejection error message', async () => {
  const msg = 'Cannot turn off Secure Posted Entries with Hash on a journal with secured entries';
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?ar-test=${Date.now()}`);
    const translated = t(msg);
    assert.ok(translated, 'translation exists');
    assert.notEqual(translated, msg, 'translation is translated to Arabic');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('a diff cannot move a hashed entry out of a journal while turning its hash securing off', () => {
  let db = seed();
  const res = create(db, 'account.journal', { name: 'Headless Hashed', code: 'HH', restrict_mode_hash_table: true });
  db = res.db;
  const other = create(db, 'account.journal', { name: 'Other General', code: 'OG' });
  db = other.db;
  const entry = postEntry(db, { journal: 'HH', date: '2026-01-10', company: 1, lines: [{ account: '600000', debit: 100 }, { account: '211000', credit: 100 }] });
  db = { ...entry.db, records: { ...entry.db.records, 'account.move': entry.db.records['account.move'].map((m) => (m.id === entry.id ? { ...m, inalterable_hash: 'hash-abc-123', secure_sequence_number: 1 } : m)) } };

  const attempt = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (m.id === entry.id ? { ...m, journal_id: other.id } : m)),
      'account.journal': db.records['account.journal'].map((j) => (j.id === res.id ? { ...j, restrict_mode_hash_table: false } : j)),
    },
  };
  assert.throws(() => syncServer(db, attempt), /Secured entries cannot be modified/);
});
