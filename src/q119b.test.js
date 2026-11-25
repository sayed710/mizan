import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { models, writableModelsForApps } from './models/index.js';
import { accountId, journalItems, postEntry, reconciledJournalItems } from './models/ledger.js';
import { reconcileLedgerItems } from './models/glReconcile.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

const LINK_MODEL = 'account.online.link';
const ACCOUNT_MODEL = 'account.online.account';

function makeBankOrCreditJournal(db, { name = 'Test Bank', code = 'TBNK', type = 'bank', company_id = 1, bank_statements_source } = {}) {
  let nextDb = db;
  let cashAcc = accountId(nextDb, type === 'credit' ? '211401' : '101401', company_id);
  if (!cashAcc) {
    const acc = create(nextDb, 'account.account', {
      code: `1099${code}`,
      name: `${name} Account`,
      account_type: type === 'credit' ? 'liability_credit_card' : 'asset_cash',
      company_id,
    });
    nextDb = acc.db;
    cashAcc = acc.id;
  }
  let suspAcc = accountId(nextDb, '101404', company_id);
  if (!suspAcc) {
    const acc = create(nextDb, 'account.account', {
      code: `1049${code}`,
      name: `${name} Suspense`,
      account_type: 'asset_current',
      company_id,
    });
    nextDb = acc.db;
    suspAcc = acc.id;
  }
  const vals = {
    name,
    code,
    type,
    company_id,
    default_account_id: cashAcc,
    suspense_account_id: suspAcc,
  };
  if (bank_statements_source !== undefined) vals.bank_statements_source = bank_statements_source;
  return create(nextDb, 'account.journal', vals);
}

function itemSelection(db, moveId, account) {
  const rows = journalItems(db).filter((l) => l.move_id === moveId && l.account_id === account);
  assert.equal(rows.length, 1, `Expected 1 journal item on move ${moveId} account ${account}, got ${rows.length}`);
  return { move_id: moveId, line_identity: rows[0].line_identity };
}

function setupCompanyWithCurrency(rounding, name) {
  const base = seed();
  const curr = create(base, 'res.currency', {
    name,
    rounding,
    rate_ids: [{ date: '2026-01-01', rate: 1 }],
  });
  const company = createCompanyWithDefaultInvoiceJournals(curr.db, { name: `${name} Co`, currency_id: curr.id });
  let db = company.db;
  const ar = read(db, 'res.company', company.id).account_default_receivable_id
    ?? create(db, 'account.account', { code: `1210${name}`, name: `${name} AR`, account_type: 'asset_receivable', reconcile: true, company_id: company.id });
  const arId = typeof ar === 'number' ? ar : ar.id;
  if (typeof ar !== 'number') db = ar.db;
  const rev = accountId(db, '400000', company.id)
    ?? create(db, 'account.account', { code: `4000${name}`, name: `${name} Rev`, account_type: 'income', company_id: company.id });
  const revId = typeof rev === 'number' ? rev : rev.id;
  if (typeof rev !== 'number') db = rev.db;
  const misc = search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === company.id))
    ?? create(db, 'account.journal', { name: `${name} Misc`, code: `M${name.slice(0, 3)}`, type: 'general', company_id: company.id });
  const miscRec = misc.db ? read(misc.db, 'account.journal', misc.id) : misc;
  if (misc.db) db = misc.db;
  const partner = create(db, 'res.partner', { name: `${name} Partner`, company_id: company.id });
  db = partner.db;
  return { db, companyId: company.id, currencyId: curr.id, arId, revId, misc: miscRec, partnerId: partner.id };
}

test('inline account edits reject foreign, unknown, and duplicate IDs without changing either connection on direct ORM and sync API', () => {
  const first = create(seed(), LINK_MODEL, { name: 'First', provider: 'demo', account_ids: [{ name: 'First account', last_sync_cursor: 'c1' }] });
  const second = create(first.db, LINK_MODEL, { name: 'Second', provider: 'demo', account_ids: [{ name: 'Second account', last_sync_cursor: 'c2' }] });
  const db = second.db;
  const firstAcc = db.records[ACCOUNT_MODEL].find((a) => a.link_id === first.id);
  const foreign = db.records[ACCOUNT_MODEL].find((a) => a.link_id === second.id);
  const snapshot = structuredClone(db);
  const accountingAllowed = writableModelsForApps(['accounting']);

  for (const id of [foreign.id, 999999, 0, -1]) {
    const vals = { account_ids: [{ id, name: 'Changed', last_sync_cursor: 'changed' }] };
    assert.throws(() => write(db, LINK_MODEL, first.id, vals), /account.*connection/i);
    assert.deepEqual(db, snapshot);

    // Mixing a valid owned account with a foreign/unknown id must not remove or alter any child.
    const mixed = { account_ids: [{ id: firstAcc.id, name: 'Keep' }, { id, name: 'Changed', last_sync_cursor: 'changed' }] };
    assert.throws(() => write(db, LINK_MODEL, first.id, mixed), /account.*connection/i);
    assert.deepEqual(db, snapshot);

    // Creating a new connection with an existing account id must also fail.
    assert.throws(() => create(db, LINK_MODEL, { name: 'Third', provider: 'demo', account_ids: [{ id, name: 'Stolen' }] }), /account.*connection/i);
    assert.deepEqual(db, snapshot);

    // Sync API path (applyDiff) with and without bases must reject foreign/unknown ids.
    const firstLink = db.records[LINK_MODEL].find((r) => r.id === first.id);
    assert.throws(() => applyDiff(db, { upserts: { [LINK_MODEL]: [{ ...firstLink, ...vals }] } }, {
      isAdmin: false, allowed: accountingAllowed,
    }), /account.*connection/i);
    assert.deepEqual(db, snapshot);

    assert.throws(() => applyDiff(db, {
      upserts: { [LINK_MODEL]: [{ ...firstLink, name: 'First Renamed', ...vals }] },
      bases: { [LINK_MODEL]: { [first.id]: { name: 'First' } } },
    }, {
      isAdmin: false, allowed: accountingAllowed,
    }), /account.*connection/i);
    assert.deepEqual(db, snapshot);
  }

  // Moving an existing account directly to another connection via applyDiff is also rejected.
  assert.throws(() => applyDiff(db, {
    upserts: { [ACCOUNT_MODEL]: [{ ...foreign, link_id: first.id }] },
  }, {
    isAdmin: false, allowed: accountingAllowed,
  }), /account.*connection/i);
  assert.deepEqual(db, snapshot);

  // Duplicate id inside the same account_ids payload is rejected with no change.
  assert.throws(() => write(db, LINK_MODEL, first.id, {
    account_ids: [{ id: firstAcc.id, name: 'A' }, { id: firstAcc.id, name: 'B' }],
  }), /duplicate|account/i);
  assert.deepEqual(db, snapshot);

  // Non-accounting apps remain blocked on account.online.link and account.online.account.
  const todoAllowed = writableModelsForApps(['todo']);
  assert.throws(() => applyDiff(db, {
    upserts: { [LINK_MODEL]: [{ ...db.records[LINK_MODEL].find((r) => r.id === first.id), name: 'Nope' }] },
  }, { isAdmin: false, allowed: todoAllowed }), /No access/);
});

test('linking and unlinking or moving online accounts preserves and restores each journal previous bank_statements_source', () => {
  let db = seed();
  const j1 = makeBankOrCreditJournal(db, { name: 'File Import Bank', code: 'FIBK', bank_statements_source: 'file_import' });
  db = j1.db;
  const j2 = makeBankOrCreditJournal(db, { name: 'Undefined Bank', code: 'UDBK', bank_statements_source: 'undefined' });
  db = j2.db;
  const j3 = makeBankOrCreditJournal(db, { name: 'Credit No Source', code: 'CNSC', type: 'credit' });
  db = j3.db;

  assert.equal(read(db, 'account.journal', j1.id).bank_statements_source, 'file_import');
  assert.equal(read(db, 'account.journal', j2.id).bank_statements_source, 'undefined');
  assert.equal(read(db, 'account.journal', j3.id).bank_statements_source, undefined);

  const linkRes = create(db, LINK_MODEL, { name: 'Bank Link', provider: 'demo' });
  db = linkRes.db;

  // 1. Journal starting in file_import: link -> online_sync, then unlink -> file_import again.
  const acc1 = create(db, ACCOUNT_MODEL, { link_id: linkRes.id, name: 'Acc 1', journal_id: j1.id });
  db = acc1.db;
  assert.equal(read(db, 'account.journal', j1.id).bank_statements_source, 'online_sync');
  db = write(db, ACCOUNT_MODEL, acc1.id, { name: 'Acc 1 Renamed' });
  assert.equal(read(db, 'account.journal', j1.id).bank_statements_source, 'online_sync');
  db = unlink(db, ACCOUNT_MODEL, [acc1.id]);
  assert.equal(read(db, 'account.journal', j1.id).bank_statements_source, 'file_import');

  // 2. Link j1 (file_import), move account to j2 (undefined), then unlink -> each journal restores its own previous value.
  const acc2 = create(db, ACCOUNT_MODEL, { link_id: linkRes.id, name: 'Acc 2', journal_id: j1.id });
  db = acc2.db;
  assert.equal(read(db, 'account.journal', j1.id).bank_statements_source, 'online_sync');
  db = write(db, ACCOUNT_MODEL, acc2.id, { journal_id: j2.id });
  assert.equal(read(db, 'account.journal', j1.id).bank_statements_source, 'file_import');
  assert.equal(read(db, 'account.journal', j2.id).bank_statements_source, 'online_sync');

  // Move from j2 (undefined) to j3 (no value).
  db = write(db, ACCOUNT_MODEL, acc2.id, { journal_id: j3.id });
  assert.equal(read(db, 'account.journal', j2.id).bank_statements_source, 'undefined');
  assert.equal(read(db, 'account.journal', j3.id).bank_statements_source, 'online_sync');

  // 3. Unlink from j3 (which started with no value) -> j3 stays without one.
  db = unlink(db, ACCOUNT_MODEL, [acc2.id]);
  assert.equal(read(db, 'account.journal', j3.id).bank_statements_source, undefined);

  // Journal guard prevents manually changing bank_statements_source while linked to an active online account.
  const acc3 = create(db, ACCOUNT_MODEL, { link_id: linkRes.id, name: 'Acc 3', journal_id: j1.id });
  db = acc3.db;
  assert.throws(() => write(db, 'account.journal', j1.id, { bank_statements_source: 'file_import' }), /online account/i);
  db = write(db, ACCOUNT_MODEL, acc3.id, { active: false });
  assert.equal(read(db, 'account.journal', j1.id).bank_statements_source, 'file_import');
});

test('schema migration 54 backfills previous_bank_statements_source for existing online-synced journals idempotently', () => {
  let db = seed();
  const jBank = makeBankOrCreditJournal(db, { name: 'Legacy Bank', code: 'LGBK', bank_statements_source: 'online_sync' });
  db = jBank.db;
  const jCredit = makeBankOrCreditJournal(db, { name: 'Legacy Credit', code: 'LGCR', type: 'credit', bank_statements_source: 'online_sync' });
  db = jCredit.db;
  const linkRes = create(db, LINK_MODEL, { name: 'Legacy Link', provider: 'demo' });
  db = linkRes.db;
  // Simulate pre-v54 stored state where accounts were linked without previous_bank_statements_source.
  const legacyDb = {
    ...db,
    schema_version: 53,
    records: {
      ...db.records,
      [ACCOUNT_MODEL]: [
        { id: 1, link_id: linkRes.id, company_id: 1, name: 'Legacy Bank Acc', journal_id: jBank.id, active: true },
        { id: 2, link_id: linkRes.id, company_id: 1, name: 'Legacy Credit Acc', journal_id: jCredit.id, active: true },
      ],
    },
    seq: { ...db.seq, [ACCOUNT_MODEL]: 2 },
  };

  const migrated = migrate(legacyDb);
  assert.equal(SCHEMA_VERSION, 73);
  assert.equal(migrated.schema_version, 73);
  assert.equal(read(migrated, 'account.journal', jBank.id).previous_bank_statements_source, 'undefined');
  assert.equal(read(migrated, 'account.journal', jCredit.id).previous_bank_statements_source, 'none');

  const twice = migrate(migrated);
  assert.equal(twice, migrated);

  const afterUnlink = unlink(migrated, ACCOUNT_MODEL, [1, 2]);
  assert.equal(read(afterUnlink, 'account.journal', jBank.id).bank_statements_source, 'undefined');
  assert.equal(read(afterUnlink, 'account.journal', jCredit.id).bank_statements_source, undefined);
});

test('GL reconciliation handles one-rounding-unit (0.01) balances, explicit 0.01 amount, and 100.00 vs 99.99 + 0.01 closure', async () => {
  const { isCurrencyZero } = await import('./money.js');
  assert.equal(isCurrencyZero(0, { rounding: 0.01 }), true);
  assert.equal(isCurrencyZero(0.004, { rounding: 0.01 }), true);
  assert.equal(isCurrencyZero(0.01, { rounding: 0.01 }), false);
  assert.equal(isCurrencyZero(-0.01, { rounding: 0.01 }), false);

  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Penny Customer' });
  db = partner.db;
  const ar = read(db, 'res.company', 1).account_default_receivable_id ?? accountId(db, '121000', 1);
  const rev = accountId(db, '400000', 1);
  const misc = search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === 1));

  // 1) 0.01 debit against 0.01 credit reconciles fully.
  const d01 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-01', ref: 'D 0.01',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 0.01 }, { account_id: rev, credit: 0.01 }],
  });
  const c01 = postEntry(d01.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-02', ref: 'C 0.01',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 0.01 }, { account_id: rev, debit: 0.01 }],
  });
  db = c01.db;
  const fullPenny = reconcileLedgerItems(db, [itemSelection(db, d01.id, ar), itemSelection(db, c01.id, ar)], { date: '2026-04-02' });
  const d01Line = reconciledJournalItems(fullPenny, read(fullPenny, 'account.move', d01.id)).find((l) => l.account_id === ar);
  const c01Line = reconciledJournalItems(fullPenny, read(fullPenny, 'account.move', c01.id)).find((l) => l.account_id === ar);
  assert.equal(d01Line.reconciled, true);
  assert.equal(c01Line.reconciled, true);
  assert.equal(d01Line.amount_residual, 0);
  assert.equal(c01Line.amount_residual, 0);
  assert.ok(d01Line.matching_number);
  assert.equal(d01Line.matching_number, c01Line.matching_number);

  // 2) Explicit amount 0.01 creates a 0.01 link.
  const d10 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-03', ref: 'D 10',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 10 }, { account_id: rev, credit: 10 }],
  });
  const c10 = postEntry(d10.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-04', ref: 'C 10',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 10 }, { account_id: rev, debit: 10 }],
  });
  const explicitPenny = reconcileLedgerItems(c10.db, [itemSelection(c10.db, d10.id, ar), itemSelection(c10.db, c10.id, ar)], { date: '2026-04-04', amount: 0.01 });
  const createdLinks = (explicitPenny.records['account.partial.reconcile'] ?? []).filter((g) => g.debit_move_id === d10.id && g.credit_move_id === c10.id);
  assert.equal(createdLinks.length, 1);
  assert.equal(createdLinks[0].amount, 0.01);
  assert.equal(reconciledJournalItems(explicitPenny, read(explicitPenny, 'account.move', d10.id)).find((l) => l.account_id === ar).amount_residual, 9.99);

  // 3) 100.00 debit against 99.99 credit leaves exactly 0.01 open, and a following 0.01 credit closes it.
  const d100 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-05', ref: 'D 100',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 100 }, { account_id: rev, credit: 100 }],
  });
  const c9999 = postEntry(d100.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-06', ref: 'C 99.99',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 99.99 }, { account_id: rev, debit: 99.99 }],
  });
  const c001Follow = postEntry(c9999.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-07', ref: 'C 0.01 follow',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 0.01 }, { account_id: rev, debit: 0.01 }],
  });
  const partial = reconcileLedgerItems(c001Follow.db, [itemSelection(c001Follow.db, d100.id, ar), itemSelection(c001Follow.db, c9999.id, ar)], { date: '2026-04-06' });
  const d100Open = reconciledJournalItems(partial, read(partial, 'account.move', d100.id)).find((l) => l.account_id === ar);
  const c9999Line = reconciledJournalItems(partial, read(partial, 'account.move', c9999.id)).find((l) => l.account_id === ar);
  assert.equal(d100Open.reconciled, false);
  assert.equal(d100Open.amount_residual, 0.01);
  assert.equal(c9999Line.reconciled, true);
  assert.equal(d100Open.matching_number ?? null, null);

  const closed = reconcileLedgerItems(partial, [itemSelection(partial, d100.id, ar), itemSelection(partial, c001Follow.id, ar)], { date: '2026-04-07' });
  const d100Closed = reconciledJournalItems(closed, read(closed, 'account.move', d100.id)).find((l) => l.account_id === ar);
  const c9999Closed = reconciledJournalItems(closed, read(closed, 'account.move', c9999.id)).find((l) => l.account_id === ar);
  const c001Closed = reconciledJournalItems(closed, read(closed, 'account.move', c001Follow.id)).find((l) => l.account_id === ar);
  assert.equal(d100Closed.reconciled, true);
  assert.equal(d100Closed.amount_residual, 0);
  assert.ok(d100Closed.matching_number);
  assert.equal(d100Closed.matching_number, c9999Closed.matching_number);
  assert.equal(d100Closed.matching_number, c001Closed.matching_number);

  // Also allow closing a 0.01 open balance with a write-off (exercises validateWriteoffOptions).
  const writeoffClosed = reconcileLedgerItems(partial, [itemSelection(partial, d100.id, ar)], {
    date: '2026-04-07',
    writeoff: { journalId: misc.id, accountId: rev, label: 'Penny Write-Off' },
  });
  const d100Wo = reconciledJournalItems(writeoffClosed, read(writeoffClosed, 'account.move', d100.id)).find((l) => l.account_id === ar);
  assert.equal(d100Wo.reconciled, true);
  assert.equal(d100Wo.amount_residual, 0);
});

test('GL reconciliation handles one-rounding-unit balances for integer (rounding 1) and three-decimal (rounding 0.001) currencies', async () => {
  const { isCurrencyZero } = await import('./money.js');
  assert.equal(isCurrencyZero(0.4, { rounding: 1 }), true);
  assert.equal(isCurrencyZero(1, { rounding: 1 }), false);
  assert.equal(isCurrencyZero(0.0004, { rounding: 0.001 }), true);
  assert.equal(isCurrencyZero(0.001, { rounding: 0.001 }), false);

  for (const { name, rounding, unit, big, almost } of [
    { name: 'JPYT', rounding: 1, unit: 1, big: 100, almost: 99 },
    { name: 'KWDT', rounding: 0.001, unit: 0.001, big: 1, almost: 0.999 },
  ]) {
    const ctx = setupCompanyWithCurrency(rounding, name);
    let db = ctx.db;
    const dUnit = postEntry(db, {
      journal: ctx.misc.code, journal_id: ctx.misc.id, company: ctx.companyId, date: '2026-04-01', ref: `${name} unit D`,
      lines: [{ account_id: ctx.arId, partner_id: ctx.partnerId, debit: unit }, { account_id: ctx.revId, credit: unit }],
    });
    const cUnit = postEntry(dUnit.db, {
      journal: ctx.misc.code, journal_id: ctx.misc.id, company: ctx.companyId, date: '2026-04-02', ref: `${name} unit C`,
      lines: [{ account_id: ctx.arId, partner_id: ctx.partnerId, credit: unit }, { account_id: ctx.revId, debit: unit }],
    });
    const full = reconcileLedgerItems(cUnit.db, [itemSelection(cUnit.db, dUnit.id, ctx.arId), itemSelection(cUnit.db, cUnit.id, ctx.arId)], { date: '2026-04-02' });
    assert.equal(reconciledJournalItems(full, read(full, 'account.move', dUnit.id)).find((l) => l.account_id === ctx.arId).reconciled, true);

    const dBig = postEntry(cUnit.db, {
      journal: ctx.misc.code, journal_id: ctx.misc.id, company: ctx.companyId, date: '2026-04-03', ref: `${name} big D`,
      lines: [{ account_id: ctx.arId, partner_id: ctx.partnerId, debit: big }, { account_id: ctx.revId, credit: big }],
    });
    const cAlmost = postEntry(dBig.db, {
      journal: ctx.misc.code, journal_id: ctx.misc.id, company: ctx.companyId, date: '2026-04-04', ref: `${name} almost C`,
      lines: [{ account_id: ctx.arId, partner_id: ctx.partnerId, credit: almost }, { account_id: ctx.revId, debit: almost }],
    });
    const cClose = postEntry(cAlmost.db, {
      journal: ctx.misc.code, journal_id: ctx.misc.id, company: ctx.companyId, date: '2026-04-05', ref: `${name} close C`,
      lines: [{ account_id: ctx.arId, partner_id: ctx.partnerId, credit: unit }, { account_id: ctx.revId, debit: unit }],
    });
    const partial = reconcileLedgerItems(cClose.db, [itemSelection(cClose.db, dBig.id, ctx.arId), itemSelection(cClose.db, cAlmost.id, ctx.arId)], { date: '2026-04-04' });
    const dBigOpen = reconciledJournalItems(partial, read(partial, 'account.move', dBig.id)).find((l) => l.account_id === ctx.arId);
    assert.equal(dBigOpen.reconciled, false);
    assert.equal(dBigOpen.amount_residual, unit);

    const closed = reconcileLedgerItems(partial, [itemSelection(partial, dBig.id, ctx.arId), itemSelection(partial, cClose.id, ctx.arId)], { date: '2026-04-05' });
    const dBigClosed = reconciledJournalItems(closed, read(closed, 'account.move', dBig.id)).find((l) => l.account_id === ctx.arId);
    assert.equal(dBigClosed.reconciled, true);
    assert.equal(dBigClosed.amount_residual, 0);

    // Explicit one-unit amount on big pair creates a one-unit link.
    const exp = reconcileLedgerItems(cAlmost.db, [itemSelection(cAlmost.db, dBig.id, ctx.arId), itemSelection(cAlmost.db, cAlmost.id, ctx.arId)], { date: '2026-04-04', amount: unit });
    const link = (exp.records['account.partial.reconcile'] ?? []).find((g) => g.debit_move_id === dBig.id && g.credit_move_id === cAlmost.id);
    assert.equal(link?.amount, unit);
  }
});

test('new labels, options, and error messages added in q119b have Arabic translations', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import('./i18n.js?q119b-ar-test');
    const prevField = models['account.journal'].fields.previous_bank_statements_source;
    assert.ok(prevField, 'account.journal declares previous_bank_statements_source');
    const strings = [
      prevField.label,
      ...(prevField.options ?? []).map((o) => o[1]),
      'Online account does not belong to this connection',
      'Duplicate online account in connection',
      'Invalid online account row',
      'Invalid online accounts payload',
      'Online account cannot be moved to another connection',
      'Cannot change the bank feeds source of a journal linked to an online account',
      'Previous bank feeds source can only be stored while online synchronization is active',
    ];
    for (const s of strings) {
      assert.notEqual(t(s), s, `missing Arabic translation for: ${s}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
