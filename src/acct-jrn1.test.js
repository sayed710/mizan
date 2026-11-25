import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, unlink, write } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { migrate, MIGRATIONS, SCHEMA_VERSION } from './migrations.js';

// Databases saved just before the journal-ledger-direction migration, whatever migrations come later.
const BEFORE_JOURNAL_DIRECTION = MIGRATIONS.find((m) => m.name === 'journal-ledger-direction').version - 1;
import { journalSequenceName } from './models/journal-sequence.js';
import { postEntry } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { today } from './models/common.js';
import './models/index.js';

test('JRN-1 journal currency and sequence behavior survive synchronization', () => {
  let db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const journal = create(db, 'account.journal', { name: 'Euro Bank', code: 'EURB', type: 'general', company_id: 1, currency_id: currency.id });
  db = journal.db;
  const payment = create(db, 'account.payment', { state: 'draft', company_id: 1, journal_id: journal.id, currency_id: currency.id, amount: 10 });
  db = payment.db;
  const bad = { ...db, records: { ...db.records, 'account.payment': db.records['account.payment'].map((p) => p.id === payment.id ? { ...p, currency_id: read(db, 'res.company', 1).currency_id } : p) } };
  assert.equal(read(applyDiff(db, diffDb(db, bad), { isAdmin: true }), 'account.payment', payment.id).currency_id, read(db, 'res.company', 1).currency_id);
  const account = create(db, 'account.account', { name: 'Foreign bank', code: '199998', account_type: 'asset_cash', company_id: 1 });
  db = account.db;
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const fixed = create(db, 'account.journal', { name: 'Fixed bank', code: 'FIX', type: 'bank', company_id: 1, default_account_id: account.id, suspense_account_id: bank.suspense_account_id, currency_id: currency.id });
  const fixedSynced = applyDiff(db, diffDb(db, fixed.db), { isAdmin: true });
  assert.equal(read(fixedSynced, 'account.account', account.id).currency_id, currency.id);
  const forged = { ...fixed.db, records: { ...fixed.db.records, 'account.account': fixed.db.records['account.account'].map((a) => a.id === account.id ? { ...a, currency_id: null } : a) } };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /same currency/);
  const regex = String.raw`^(?P<prefix1>.*?)(?P<year>\d{4})/(?P<seq>\d+)(?P<suffix>\D*)$`;
  const configured = write(db, 'account.journal', journal.id, { sequence_override_regex: regex });
  const synced = applyDiff(db, diffDb(db, configured), { isAdmin: true });
  const previous = { ...synced, records: { ...synced.records, 'account.move': [...synced.records['account.move'], { id: 9999, journal_id: journal.id, move_type: 'entry', state: 'posted', name: 'TEST/2026/0042' }] } };
  assert.equal(journalSequenceName(previous, read(previous, 'account.journal', journal.id), '2026-03-01', 'TEST/2026/00001'), 'TEST/2026/0043');
  assert.equal(journalSequenceName(previous, read(previous, 'account.journal', journal.id), '2027-03-01', 'TEST/2027/00001'), 'TEST/2027/0001');
  const accounts = search(previous, 'account.account').filter((account) => account.active !== false && (!account.company_id || account.company_id === 1));
  const posted = postEntry(previous, { journal_id: journal.id, company: 1, date: '2026-03-01', lines: [{ account_id: accounts[0].id, debit: 1 }, { account_id: accounts[1].id, credit: 1 }] });
  assert.equal(read(posted.db, 'account.move', posted.id).name, 'TEST/2026/0043');
  assert.equal(read(posted.db, 'account.move', posted.id).currency_id ?? null, null);
  const foreignPosted = postEntry(previous, { journal_id: journal.id, company: 1, date: '2026-03-01', lines: [{ account_id: accounts[0].id, debit: 1, currency_id: currency.id, amount_currency: 1 }, { account_id: accounts[1].id, credit: 1, currency_id: currency.id, amount_currency: -1 }] });
  assert.equal(read(foreignPosted.db, 'account.move', foreignPosted.id).currency_id, currency.id);
  const invalidRegex = { ...synced, records: { ...synced.records, 'account.journal': synced.records['account.journal'].map((j) => j.id === journal.id ? { ...j, sequence_override_regex: 'broken' } : j) } };
  assert.throws(() => applyDiff(synced, diffDb(synced, invalidRegex), { isAdmin: true }), /seq group/);
});

test('JRN-2 migrates ledger membership to the journal', () => {
  const db = seed();
  const journal = search(db, 'account.journal')[0];
  const old = { ...db, schema_version: BEFORE_JOURNAL_DIRECTION, records: { ...db.records, 'account.journal.group': [{ id: 1, name: 'IFRS', company_id: 1, journal_ids: [journal.id] }] } };
  const migrated = migrate(old);
  assert.equal(read(migrated, 'account.journal', journal.id).journal_group_id, 1);
  assert.deepEqual(read(migrated, 'account.journal.group', 1).included_journal_ids, [journal.id]);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  const unrelated = search(migrated, 'account.journal').find((j) => j.id !== journal.id);
  const changed = write(migrated, 'account.journal', unrelated.id, { journal_group_id: 1 });
  const applied = applyDiff(migrated, diffDb(migrated, changed), { isAdmin: true });
  assert.ok(read(applied, 'account.journal.group', 1).included_journal_ids.includes(unrelated.id));
  const invalid = { ...applied, records: { ...applied.records, 'account.journal': applied.records['account.journal'].map((j) => j.id === unrelated.id ? { ...j, journal_group_id: 999999 } : j) } };
  assert.throws(() => applyDiff(applied, diffDb(applied, invalid), { isAdmin: true }));
});

test('Finding 1: ordinary write call updates ledger journal membership', () => {
  let db = seed();
  const j1 = search(db, 'account.journal')[0];
  const j2 = search(db, 'account.journal')[1];
  const group = create(db, 'account.journal.group', { name: 'Tax Ledger', company_id: 1 });
  db = group.db;

  // Add journals via ordinary write
  db = write(db, 'account.journal.group', group.id, { journal_ids: [j1.id, j2.id] });
  assert.equal(read(db, 'account.journal', j1.id).journal_group_id, group.id);
  assert.equal(read(db, 'account.journal', j2.id).journal_group_id, group.id);
  assert.deepEqual(read(db, 'account.journal.group', group.id).journal_ids.sort(), [j1.id, j2.id].sort());

  // Remove one journal via ordinary write
  db = write(db, 'account.journal.group', group.id, { journal_ids: [j1.id] });
  assert.equal(read(db, 'account.journal', j1.id).journal_group_id, group.id);
  assert.equal(read(db, 'account.journal', j2.id).journal_group_id ?? null, null);
  assert.deepEqual(read(db, 'account.journal.group', group.id).journal_ids, [j1.id]);
});

test('Finding 2: assigning a shared journal to company 2 ledger succeeds', () => {
  let db = seed();
  const comp2 = create(db, 'res.company', { name: 'Company 2' });
  db = comp2.db;
  const ledger2 = create(db, 'account.journal.group', { name: 'IFRS C2', company_id: comp2.id });
  db = ledger2.db;
  const sharedJournal = create(db, 'account.journal', { name: 'Shared General', code: 'SGEN', type: 'general', company_id: null });
  db = sharedJournal.db;

  // Assign shared journal to company 2 ledger
  assert.doesNotThrow(() => {
    db = write(db, 'account.journal', sharedJournal.id, { journal_group_id: ledger2.id });
  });
  assert.equal(read(db, 'account.journal', sharedJournal.id).journal_group_id, ledger2.id);
  assert.ok(read(db, 'account.journal.group', ledger2.id).journal_ids.includes(sharedJournal.id));
});

test('Finding 3: sequence override handles out-of-order, back-dated, and duplicate sequence numbers', () => {
  let db = seed();
  const journal = create(db, 'account.journal', {
    name: 'Sequence Journal',
    code: 'SEQJ',
    type: 'general',
    company_id: 1,
    sequence_override_regex: String.raw`^(?P<prefix>.*?)(?P<year>\d{4})/(?P<seq>\d+)$`,
  });
  db = journal.db;
  const accounts = search(db, 'account.account').filter((a) => !a.company_id || a.company_id === 1);

  // 1. Out of order postings:
  const m1 = create(db, 'account.move', { move_type: 'entry', journal_id: journal.id, state: 'draft', line_ids: [{ account_id: accounts[0].id, debit: 10 }, { account_id: accounts[1].id, credit: 10 }] });
  db = m1.db;
  const m2 = create(db, 'account.move', { move_type: 'entry', journal_id: journal.id, state: 'draft', line_ids: [{ account_id: accounts[0].id, debit: 10 }, { account_id: accounts[1].id, credit: 10 }] });
  db = m2.db;

  // Post m2 first
  const name2 = journalSequenceName(db, read(db, 'account.journal', journal.id), '2026-03-01', 'SEQJ/2026/00001');
  assert.equal(name2, 'SEQJ/2026/00001');
  db = write(db, 'account.move', m2.id, { name: name2, state: 'posted' });

  // Post m1 second (lower ID)
  const name1 = journalSequenceName(db, read(db, 'account.journal', journal.id), '2026-03-02', 'SEQJ/2026/00001');
  assert.equal(name1, 'SEQJ/2026/00002');
  db = write(db, 'account.move', m1.id, { name: name1, state: 'posted' });

  // 2. Back-dated posting across period boundary:
  const m2025 = create(db, 'account.move', { move_type: 'entry', journal_id: journal.id, state: 'draft', line_ids: [{ account_id: accounts[0].id, debit: 10 }, { account_id: accounts[1].id, credit: 10 }] });
  db = m2025.db;
  const name2025 = journalSequenceName(db, read(db, 'account.journal', journal.id), '2025-12-31', 'SEQJ/2025/00001');
  assert.equal(name2025, 'SEQJ/2025/00001');
  db = write(db, 'account.move', m2025.id, { name: name2025, state: 'posted' });

  // Now post another entry in 2026: should continue from 00002 -> 00003, NOT restart at 00001!
  const name2026 = journalSequenceName(db, read(db, 'account.journal', journal.id), '2026-04-01', 'SEQJ/2026/00001');
  assert.equal(name2026, 'SEQJ/2026/00003');

  // 3. Collision avoidance if generated name is already used by an existing move:
  db = { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'], { id: 88888, journal_id: journal.id, state: 'draft', name: 'SEQJ/2026/00003' }] } };
  const avoidedName = journalSequenceName(db, read(db, 'account.journal', journal.id), '2026-04-01', 'SEQJ/2026/00001');
  assert.equal(avoidedName, 'SEQJ/2026/00004');
});

test('Finding 4: migration 68 skips missing journals and deterministically resolves overlapping groups', () => {
  const db = seed();
  const j1 = search(db, 'account.journal')[0];
  const old = {
    ...db,
    schema_version: BEFORE_JOURNAL_DIRECTION,
    records: {
      ...db.records,
      'account.journal.group': [
        { id: 10, sequence: 5, name: 'Primary Group', company_id: 1, journal_ids: [j1.id, 999999] },
        { id: 20, sequence: 10, name: 'Secondary Group', company_id: 1, journal_ids: [j1.id] },
      ],
    },
  };
  assert.doesNotThrow(() => {
    const migrated = migrate(old);
    assert.equal(migrated.schema_version, SCHEMA_VERSION);
    assert.equal(read(migrated, 'account.journal', j1.id).journal_group_id, 10);
    const rawGroup10 = migrated.records['account.journal.group'].find((g) => g.id === 10);
    assert.equal('journal_ids' in rawGroup10, false);
    assert.deepEqual(read(migrated, 'account.journal.group', 10).journal_ids, [j1.id]);
  });
});

test('Finding 5: account with company-currency postings cannot adopt foreign currency', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const account = create(db, 'account.account', { name: 'Test Acct', code: '998877', account_type: 'expense', company_id: 1 });
  db = account.db;
  const generalJrn = search(db, 'account.journal').find((j) => j.type === 'general');
  const otherAcc = search(db, 'account.account').find((a) => a.id !== account.id && (!a.company_id || a.company_id === 1));

  const posted = postEntry(db, {
    journal_id: generalJrn.id,
    company: 1,
    date: '2026-01-15',
    lines: [
      { account_id: account.id, debit: 100 },
      { account_id: otherAcc.id, credit: 100 },
    ],
  });
  db = posted.db;

  // Direct currency change on account must fail
  assert.throws(
    () => write(db, 'account.account', account.id, { currency_id: eur.id }),
    /The account has journal items in another currency/
  );

  // Creating a foreign bank journal on an account with existing company-currency items keeps the account multi-currency
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const createdJrn = create(db, 'account.journal', { name: 'EUR Bank', code: 'EB99', type: 'bank', company_id: 1, default_account_id: account.id, suspense_account_id: bank.suspense_account_id, currency_id: eur.id });
  assert.equal(read(createdJrn.db, 'account.account', account.id).currency_id ?? null, null);
  assert.equal(read(createdJrn.db, 'account.journal', createdJrn.id).currency_id, eur.id);
});

test('Finding 6: unanchored sequence override regex preserves prefix', () => {
  const db = seed();
  const journal = {
    id: 991,
    sequence_override_regex: '(?<year>\\d{4})/(?<seq>\\d+)',
  };
  const testDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': [
        { id: 1, journal_id: 991, state: 'posted', name: 'INV/2026/00012' },
      ],
    },
  };
  const result = journalSequenceName(testDb, journal, '2026-05-01', 'INV/2026/00001');
  assert.equal(result, 'INV/2026/00013');
});

test('Finding 7: deleting ledger with assigned journals clears pointers and succeeds', () => {
  let db = seed();
  const j1 = search(db, 'account.journal')[0];
  const group = create(db, 'account.journal.group', { name: 'Deletable Ledger', company_id: 1 });
  db = group.db;
  db = write(db, 'account.journal', j1.id, { journal_group_id: group.id });
  assert.equal(read(db, 'account.journal', j1.id).journal_group_id, group.id);

  // Deletion must succeed and clear journal_group_id
  db = unlink(db, 'account.journal.group', [group.id]);
  assert.equal(read(db, 'account.journal.group', group.id), undefined);
  assert.equal(read(db, 'account.journal', j1.id).journal_group_id ?? null, null);
});

test('Finding 8: moving a ledger to another company checks its computed journals', () => {
  let db = seed();
  const comp2 = create(db, 'res.company', { name: 'Company 2' });
  db = comp2.db;
  const j1 = search(db, 'account.journal').find((j) => j.company_id === 1);
  const group = create(db, 'account.journal.group', { name: 'Company 1 Ledger', company_id: 1 });
  db = group.db;
  db = write(db, 'account.journal', j1.id, { journal_group_id: group.id });

  // Changing only company_id of group must be rejected by guard because j1 belongs to company 1
  assert.throws(
    () => write(db, 'account.journal.group', group.id, { company_id: comp2.id }),
    /Select journals belonging to this company or shared journals/
  );
});

test('Finding 9: creating invoice or entry without journal_id inherits default journal currency', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const saleJrn = search(db, 'account.journal').find((j) => j.type === 'sale');
  db = write(db, 'account.journal', saleJrn.id, { currency_id: eur.id });

  // Create invoice without specifying journal_id
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: 1 });
  assert.equal(read(inv.db, 'account.move', inv.id).journal_id, saleJrn.id);
  assert.equal(read(inv.db, 'account.move', inv.id).currency_id, eur.id);

  // Create entry without specifying journal_id
  const genJrn = search(db, 'account.journal').find((j) => j.type === 'general');
  db = write(inv.db, 'account.journal', genJrn.id, { currency_id: eur.id });
  const entry = create(db, 'account.move', { move_type: 'entry', company_id: 1 });
  assert.equal(read(entry.db, 'account.move', entry.id).journal_id, genJrn.id);
  assert.equal(read(entry.db, 'account.move', entry.id).currency_id, eur.id);
});

test('Finding 10: editing journal with archived currency succeeds when currency is not changed', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const journal = create(db, 'account.journal', { name: 'EUR Bank', code: 'EBK', type: 'general', company_id: 1, currency_id: eur.id });
  db = journal.db;

  // Archive EUR
  db = write(db, 'res.currency', eur.id, { active: false });

  // Editing journal without changing currency_id must succeed
  assert.doesNotThrow(() => {
    db = write(db, 'account.journal', journal.id, { name: 'Renamed EUR Bank' });
  });
  assert.equal(read(db, 'account.journal', journal.id).name, 'Renamed EUR Bank');

  // Changing currency to an archived currency must throw
  const anotherJournal = create(db, 'account.journal', { name: 'Another Bank', code: 'ABK', type: 'general', company_id: 1 });
  db = anotherJournal.db;
  assert.throws(
    () => write(db, 'account.journal', anotherJournal.id, { currency_id: eur.id }),
    /The journal currency must be active/
  );
});

test('Finding 11: bank journal default_account_id change validates and syncs currency', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const usdAcc = create(db, 'account.account', { name: 'USD Cash', code: '111222', account_type: 'asset_cash', company_id: 1, currency_id: null });
  db = usdAcc.db;
  const eurAcc = create(db, 'account.account', { name: 'EUR Cash', code: '111223', account_type: 'asset_cash', company_id: 1, currency_id: eur.id });
  db = eurAcc.db;

  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const bnkJrn = create(db, 'account.journal', { name: 'USD Bank', code: 'UBK', type: 'bank', company_id: 1, default_account_id: usdAcc.id, suspense_account_id: bank.suspense_account_id });
  db = bnkJrn.db;

  // Switching default_account_id to EUR account on USD journal without matching currency fails guard
  const forged = { ...db, records: { ...db.records, 'account.journal': db.records['account.journal'].map((j) => j.id === bnkJrn.id ? { ...j, default_account_id: eurAcc.id } : j) } };
  assert.throws(
    () => applyDiff(db, diffDb(db, forged), { isAdmin: true }),
    /The journal and its default account must use the same currency/
  );

  // When changing default_account_id on EUR journal, prepareWrite syncs fresh account
  const eurBnk = create(db, 'account.journal', { name: 'EUR Bank', code: 'EB2', type: 'bank', company_id: 1, default_account_id: eurAcc.id, suspense_account_id: bank.suspense_account_id, currency_id: eur.id });
  db = eurBnk.db;
  const freshAcc = create(db, 'account.account', { name: 'Fresh Acc', code: '111224', account_type: 'asset_cash', company_id: 1 });
  db = freshAcc.db;
  db = write(db, 'account.journal', eurBnk.id, { default_account_id: freshAcc.id });
  assert.equal(read(db, 'account.account', freshAcc.id).currency_id, eur.id);
});

test('Finding 12: company-currency postings in foreign bank journal do not lock currency rounding', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const eurAcc = create(db, 'account.account', { name: 'EUR Bank Acc', code: '199881', account_type: 'asset_cash', company_id: 1, currency_id: eur.id });
  db = eurAcc.db;
  const bnk = create(db, 'account.journal', { name: 'EUR Bank J', code: 'EB3', type: 'bank', company_id: 1, default_account_id: eurAcc.id, suspense_account_id: bank.suspense_account_id, currency_id: eur.id });
  db = bnk.db;

  const accounts = search(db, 'account.account').filter((a) => !a.company_id || a.company_id === 1);
  const posted = postEntry(db, {
    journal_id: bnk.id,
    company: 1,
    date: '2026-06-01',
    lines: [
      { account_id: accounts[0].id, debit: 50 },
      { account_id: accounts[1].id, credit: 50 },
    ],
  });
  db = posted.db;

  // The move header does not have currency_id: eur.id
  assert.equal(read(db, 'account.move', posted.id).currency_id ?? null, null);

  // Changing EUR rounding must succeed (not blocked by this company-currency entry)
  assert.doesNotThrow(() => {
    db = write(db, 'res.currency', eur.id, { rounding: 0.05 });
  });
  assert.equal(read(db, 'res.currency', eur.id).rounding, 0.05);
});

test('Finding 13: posting with large sequence numbers above MAX_SAFE_INTEGER produces the next name', () => {
  let db = seed();
  const regex = String.raw`^(?P<prefix>.*?)(?P<year>\d{4})/(?P<seq>\d+)$`;
  const journal = create(db, 'account.journal', {
    name: 'Large Seq Bank',
    code: 'LSEQ',
    type: 'general',
    company_id: 1,
    sequence_override_regex: regex,
  });
  db = journal.db;
  const accounts = search(db, 'account.account').filter((a) => !a.company_id || a.company_id === 1);
  const largeSeq = '9007199254740992';
  const existingName = `LSEQ/2026/${largeSeq}`;

  const existingMove = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: journal.id,
    name: existingName,
    state: 'posted',
    date: '2026-03-01',
    invoice_date: '2026-03-01',
    line_ids: [
      { account_id: accounts[0].id, debit: 10 },
      { account_id: accounts[1].id, credit: 10 },
    ],
  });
  db = existingMove.db;

  const nextName = journalSequenceName(db, read(db, 'account.journal', journal.id), '2026-03-02', 'LSEQ/2026/0000000000000001');
  assert.equal(nextName, 'LSEQ/2026/9007199254740993');

  const posted = postEntry(db, {
    journal_id: journal.id,
    company: 1,
    date: '2026-03-02',
    lines: [
      { account_id: accounts[0].id, debit: 1 },
      { account_id: accounts[1].id, credit: 1 },
    ],
  });
  assert.equal(read(posted.db, 'account.move', posted.id).name, 'LSEQ/2026/9007199254740993');

  // Collision loop and zero-padding preservation above MAX_SAFE_INTEGER
  const padded = {
    ...posted.db,
    records: {
      ...posted.db.records,
      'account.move': [
        ...posted.db.records['account.move'],
        { id: 99991, journal_id: journal.id, state: 'draft', name: 'LSEQ/2026/9007199254740994' },
        { id: 99992, journal_id: journal.id, state: 'posted', name: 'LSEQ/2025/009007199254740992' },
      ],
    },
  };
  assert.equal(
    journalSequenceName(padded, read(padded, 'account.journal', journal.id), '2026-03-03', 'LSEQ/2026/0000000000000001'),
    'LSEQ/2026/9007199254740995',
  );
  assert.equal(
    journalSequenceName(padded, read(padded, 'account.journal', journal.id), '2025-03-03', 'LSEQ/2025/000000000000000001'),
    'LSEQ/2025/009007199254740993',
  );
});

test('Shared liquidity default account rejects currency change that conflicts with another journal', () => {
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');

  // 1. Two bank journals share an unused USD-forced account; changing one to EUR must fail
  const sharedUsdAcc = create(db, 'account.account', { name: 'Shared USD Bank', code: '111330', account_type: 'asset_cash', company_id: 1, currency_id: usd.id });
  db = sharedUsdAcc.db;
  const j1 = create(db, 'account.journal', { name: 'Bank USD 1', code: 'BU1', type: 'bank', company_id: 1, default_account_id: sharedUsdAcc.id, suspense_account_id: bank.suspense_account_id, currency_id: usd.id });
  db = j1.db;
  const j2 = create(db, 'account.journal', { name: 'Bank USD 2', code: 'BU2', type: 'bank', company_id: 1, default_account_id: sharedUsdAcc.id, suspense_account_id: bank.suspense_account_id, currency_id: usd.id });
  db = j2.db;

  assert.throws(
    () => write(db, 'account.journal', j1.id, { currency_id: eur.id }),
    /Another journal uses this default account with a different currency/,
  );
  assert.equal(read(db, 'account.account', sharedUsdAcc.id).currency_id, usd.id);
  assert.equal(read(db, 'account.journal', j1.id).currency_id, usd.id);

  // Forged diff updating both journal and shared account together must also be rejected
  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === j1.id ? { ...j, currency_id: eur.id } : j)),
      'account.account': db.records['account.account'].map((a) => (a.id === sharedUsdAcc.id ? { ...a, currency_id: eur.id } : a)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forged), { isAdmin: true }),
    /Another journal uses this default account with a different currency/,
  );

  // Subsequent USD payment through j2 still succeeds
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  assert.doesNotThrow(() => {
    db = payMove(db, inv.id, 50, today(), { journalId: j2.id, directBank: true });
  });

});

test('Direct foreign-currency edit on company-currency bank default account is rejected and payments still succeed', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const gbp = search(db, 'res.currency').find((c) => c.name === 'GBP');
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const unusedBankAcc = create(db, 'account.account', {
    name: 'Unused Company Bank Acc',
    code: '111440',
    account_type: 'asset_cash',
    company_id: 1,
    currency_id: null,
  });
  db = unusedBankAcc.db;

  const companyBankJrn = create(db, 'account.journal', {
    name: 'Company Currency Bank',
    code: 'CCBK',
    type: 'bank',
    company_id: 1,
    default_account_id: unusedBankAcc.id,
    suspense_account_id: bank.suspense_account_id,
    currency_id: null,
  });
  db = companyBankJrn.db;

  // Directly assigning a foreign currency to the unused default account must be blocked
  assert.throws(
    () => write(db, 'account.account', unusedBankAcc.id, { currency_id: eur.id }),
    /Another journal uses this default account with a different currency/,
  );
  assert.equal(read(db, 'account.account', unusedBankAcc.id).currency_id ?? null, null);

  // Forged diff doing the same over sync must also be rejected
  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.account': db.records['account.account'].map((a) => (a.id === unusedBankAcc.id ? { ...a, currency_id: eur.id } : a)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forged), { isAdmin: true }),
    /Another journal uses this default account with a different currency/,
  );

  // Subsequent payment using this company-currency bank journal succeeds (including foreign payment currency)
  const paymentCurrency = gbp ?? eur;
  const partner = search(db, 'res.partner').find((p) => p.is_company);
  const pay = create(db, 'account.payment', {
    company_id: 1,
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: 75,
    currency_id: paymentCurrency.id,
    date: today(),
    journal_id: companyBankJrn.id,
  });
  assert.doesNotThrow(() => {
    db = postPayment(pay.db, read(pay.db, 'account.payment', pay.id));
  });
  assert.equal(read(db, 'account.payment', pay.id).state, 'posted');

  // Editing the journal itself preserves syncFromJournalId context for an exclusive journal
  const soloAcc = create(db, 'account.account', {
    name: 'Solo Company Bank Acc',
    code: '111441',
    account_type: 'asset_cash',
    company_id: 1,
    currency_id: null,
  });
  db = soloAcc.db;
  const soloJrn = create(db, 'account.journal', {
    name: 'Solo Bank',
    code: 'SLBK',
    type: 'bank',
    company_id: 1,
    default_account_id: soloAcc.id,
    suspense_account_id: bank.suspense_account_id,
    currency_id: null,
  });
  db = write(soloJrn.db, 'account.journal', soloJrn.id, { currency_id: eur.id });
  assert.equal(read(db, 'account.journal', soloJrn.id).currency_id, eur.id);
  assert.equal(read(db, 'account.account', soloAcc.id).currency_id, eur.id);
});

test('Archiving and unarchiving a foreign-currency bank journal with an unrestricted default account synchronizes the account', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const gbp = search(db, 'res.currency').find((c) => c.name === 'GBP');
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');

  // 1. Existing foreign-currency bank journal whose unused default account has no currency
  const acc = create(db, 'account.account', {
    name: 'Legacy EUR Bank Acc',
    code: '111450',
    account_type: 'asset_cash',
    company_id: 1,
    currency_id: null,
  });
  db = acc.db;
  const jrn = create(db, 'account.journal', {
    name: 'Legacy EUR Bank',
    code: 'LEBK',
    type: 'bank',
    company_id: 1,
    default_account_id: acc.id,
    suspense_account_id: bank.suspense_account_id,
    currency_id: eur.id,
  });
  // Simulate a pre-sync existing journal whose default_account_id has no currency_id
  db = {
    ...jrn.db,
    records: {
      ...jrn.db.records,
      'account.account': jrn.db.records['account.account'].map((a) => (a.id === acc.id ? { ...a, currency_id: null } : a)),
    },
  };

  db = write(db, 'account.journal', jrn.id, { active: false });
  assert.equal(read(db, 'account.journal', jrn.id).active, false);

  assert.doesNotThrow(() => {
    db = write(db, 'account.journal', jrn.id, { active: true });
  });
  assert.equal(read(db, 'account.journal', jrn.id).active, true);
  assert.equal(read(db, 'account.account', acc.id).currency_id, eur.id);

  // 2. Unarchiving retains item-conflict check (account with company-currency items stays unrestricted)
  const usedAcc = create(db, 'account.account', {
    name: 'Used Multi-Currency Acc',
    code: '111451',
    account_type: 'asset_cash',
    company_id: 1,
    currency_id: null,
  });
  db = usedAcc.db;
  const otherAcc = search(db, 'account.account').find((a) => a.code === '301000' && (!a.company_id || a.company_id === 1));
  const miscJrn = search(db, 'account.journal').find((j) => j.type === 'general');
  db = postEntry(db, {
    journal_id: miscJrn.id,
    company: 1,
    date: '2026-01-15',
    lines: [
      { account_id: usedAcc.id, debit: 25 },
      { account_id: otherAcc.id, credit: 25 },
    ],
  }).db;
  const usedJrn = create(db, 'account.journal', {
    name: 'Used EUR Bank',
    code: 'UEBK',
    type: 'bank',
    company_id: 1,
    default_account_id: usedAcc.id,
    suspense_account_id: bank.suspense_account_id,
    currency_id: eur.id,
    active: false,
  });
  db = write(usedJrn.db, 'account.journal', usedJrn.id, { active: true });
  assert.equal(read(db, 'account.journal', usedJrn.id).active, true);
  assert.equal(read(db, 'account.account', usedAcc.id).currency_id ?? null, null);

  // 3. Unarchiving retains conflict check against other active linked liquidity journals
  const sharedAcc = create(db, 'account.account', {
    name: 'Shared Company Bank Acc',
    code: '111452',
    account_type: 'asset_cash',
    company_id: 1,
    currency_id: null,
  });
  db = sharedAcc.db;
  const activeCompanyJrn = create(db, 'account.journal', {
    name: 'Active Company Bank',
    code: 'ACBK',
    type: 'bank',
    company_id: 1,
    default_account_id: sharedAcc.id,
    suspense_account_id: bank.suspense_account_id,
    currency_id: null,
  });
  db = activeCompanyJrn.db;
  const archivedEurJrn = create(db, 'account.journal', {
    name: 'Archived EUR Bank',
    code: 'AEBK',
    type: 'bank',
    company_id: 1,
    default_account_id: sharedAcc.id,
    suspense_account_id: bank.suspense_account_id,
    currency_id: null,
    active: false,
  });
  db = {
    ...archivedEurJrn.db,
    records: {
      ...archivedEurJrn.db.records,
      'account.journal': archivedEurJrn.db.records['account.journal'].map((j) => (j.id === archivedEurJrn.id ? { ...j, currency_id: eur.id } : j)),
    },
  };
  assert.throws(
    () => write(db, 'account.journal', archivedEurJrn.id, { active: true }),
    /Another journal uses this default account with a different currency/,
  );

  // 4. Unarchiving must not overwrite an existing conflicting forced currency on the account
  const conflictAcc = create(db, 'account.account', {
    name: 'Conflict Currency Acc',
    code: '111453',
    account_type: 'asset_cash',
    company_id: 1,
    currency_id: (gbp ?? eur).id,
  });
  db = conflictAcc.db;
  const archivedConflictJrn = create(db, 'account.journal', {
    name: 'Archived Conflict Bank',
    code: 'ACFB',
    type: 'bank',
    company_id: 1,
    default_account_id: conflictAcc.id,
    suspense_account_id: bank.suspense_account_id,
    currency_id: (gbp ?? eur).id,
    active: false,
  });
  const otherForeignId = gbp ? eur.id : search(db, 'res.currency').find((c) => c.id !== eur.id).id;
  db = {
    ...archivedConflictJrn.db,
    records: {
      ...archivedConflictJrn.db.records,
      'account.journal': archivedConflictJrn.db.records['account.journal'].map((j) => (j.id === archivedConflictJrn.id ? { ...j, currency_id: otherForeignId } : j)),
    },
  };
  assert.throws(
    () => write(db, 'account.journal', archivedConflictJrn.id, { active: true }),
    /The journal and its default account must use the same currency/,
  );
  assert.equal(read(db, 'account.account', conflictAcc.id).currency_id, (gbp ?? eur).id);
});



test('JRN-3: a foreign-currency bank journal created without company_id uses the active company currency', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const usd = read(db, 'res.company', 1).currency_id;
  const company2 = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  db = { ...company2.db, settings: { ...company2.db.settings, current_company_id: company2.id } };
  const account = create(db, 'account.account', { name: 'USD bank', code: '199997', account_type: 'asset_cash', company_id: company2.id });
  db = account.db;
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank');
  const journal = create(db, 'account.journal', { name: 'USD Bank', code: 'USDB', type: 'bank', default_account_id: account.id, suspense_account_id: bank.suspense_account_id, currency_id: usd });
  assert.equal(read(journal.db, 'account.journal', journal.id).company_id, company2.id);
  assert.equal(read(journal.db, 'account.account', account.id).currency_id, usd);
});
