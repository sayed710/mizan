import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openStorage } from '../server/storage.js';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { migrate } from './migrations.js';
import { applyDiff, diffDb } from './sync.js';
import { postMove } from './models/accounting.js';
import { revalueForeignBalances } from './models/closing.js';

test('Qodo 2: migration 34 sets default_general_journal_id for legacy companies with exactly one general journal', () => {
  let db = seed();
  // Create a legacy company with no default general journal and exactly one general journal
  const company = create(db, 'res.company', { name: 'Legacy Single General Co', currency_id: 1 });
  const journal = create(company.db, 'account.journal', {
    name: 'General Ops',
    code: 'GEN1',
    type: 'general',
    company_id: company.id,
  });
  const legacyDb = {
    ...journal.db,
    schema_version: 33,
    records: {
      ...journal.db.records,
      'res.company': (journal.db.records['res.company'] ?? []).map((c) => (
        c.id === company.id ? { ...c, default_general_journal_id: null } : c
      )),
    },
  };

  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 47);
  const updatedCompany = read(migrated, 'res.company', company.id);
  assert.equal(updatedCompany.default_general_journal_id, journal.id);
  // A company with one general journal gets no upgrade note
  assert.equal(upgradeNotes(migrated, company.id).length, 0);
});

test('Qodo 2: migration 34 leaves companies with zero or several general journals unset and notes them in each company chatter', () => {
  let db = seed();
  // Company A has 0 general journals
  const compA = create(db, 'res.company', { name: 'Zero General Co', currency_id: 1 });
  // Company B has 2 general journals
  const compB = create(compA.db, 'res.company', { name: 'Multi General Co', currency_id: 1 });
  const journalB1 = create(compB.db, 'account.journal', {
    name: 'B General 1',
    code: 'BG1',
    type: 'general',
    company_id: compB.id,
  });
  const journalB2 = create(journalB1.db, 'account.journal', {
    name: 'B General 2',
    code: 'BG2',
    type: 'general',
    company_id: compB.id,
  });

  const legacyDb = {
    ...journalB2.db,
    schema_version: 33,
    records: {
      ...journalB2.db.records,
      'res.company': (journalB2.db.records['res.company'] ?? []).map((c) => {
        if (c.id === compA.id || c.id === compB.id) {
          return { ...c, default_general_journal_id: null };
        }
        return c;
      }),
    },
  };

  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 47);

  // Both should remain unset
  assert.equal(read(migrated, 'res.company', compA.id).default_general_journal_id ?? null, null);
  assert.equal(read(migrated, 'res.company', compB.id).default_general_journal_id ?? null, null);

  // Both get a persisted chatter note naming the count, and the note survives a save and reload
  const sql = new DatabaseSync(':memory:');
  const storage = openStorage(sql);
  storage.save(null, migrated);
  const reloaded = openStorage(sql).load();
  for (const [id, count] of [[compA.id, 0], [compB.id, 2]]) {
    const notes = upgradeNotes(reloaded, id);
    assert.equal(notes.length, 1);
    assert.match(notes[0].body, new RegExp(`has ${count} general journals`));
  }
});

test('Qodo 2: revalueForeignBalances runtime error informs user to set default general journal in company settings', () => {
  let db = seed();
  const currency = create(db, 'res.currency', {
    name: 'Q15-ERR',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  const invoice = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Receivable line', qty: 1, price_unit: 100, tax: 0 }],
  });
  const posted = postMove(invoice.db, invoice.id);
  const unconfigured = write(posted, 'res.company', 1, { default_general_journal_id: null });

  // Company has foreign exposure needing adjustment, but no default general journal
  assert.throws(
    () => revalueForeignBalances(unconfigured, '2026-02-28', { companyId: 1 }),
    (err) => {
      assert.match(err.message, /default general journal/i);
      assert.match(err.message, /company settings/i);
      assert.match(err.message, /1/);
      return true;
    },
  );
});

test('Qodo 3: foreign invoice edit plus its revaluation saved in one sync diff succeeds', () => {
  let db = seed();
  const currency = create(db, 'res.currency', {
    name: 'Q15-DIFF-FX',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  // Server state has an initial invoice
  const inv = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 100, tax: 0 }],
  });
  const serverDb = postMove(inv.db, inv.id);

  // Client creates a second foreign invoice, posts it, and runs revaluation in the same session
  const inv2 = create(serverDb, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-20',
    invoice_line_ids: [{ name: 'Additional consulting', qty: 1, price_unit: 150, tax: 0 }],
  });
  const posted2 = postMove(inv2.db, inv2.id);

  // Now client triggers revaluation on top of both invoices
  const clientDb = revalueForeignBalances(posted2, '2026-02-28', { companyId: 1 });

  // Generate the diff between serverDb and clientDb
  const diff = diffDb(serverDb, clientDb);

  // The diff contains both the new invoice and the revaluation moves
  assert.ok(diff.created['account.move'].includes(inv2.id), 'Diff contains new invoice');
  const moves = diff.created['account.move'].map((id) => read(clientDb, 'account.move', id));
  const adjustment = moves.find((m) => m.revaluation_date === '2026-02-28');
  const reversal = moves.find((m) => m.reversed_entry_id === adjustment?.id);
  assert.ok(adjustment, 'Adjustment move exists in diff');
  assert.ok(reversal, 'Reversal move exists in diff');

  // Applying the diff to serverDb should succeed
  const saved = applyDiff(serverDb, diff);
  const savedAdj = read(saved, 'account.move', adjustment.id);
  const savedRev = read(saved, 'account.move', reversal.id);
  assert.equal(savedAdj.system_generated, true);
  assert.equal(savedRev.system_generated, true);
  assert.equal(savedAdj.reversal_move_id, reversal.id);
  assert.equal(savedRev.reversed_entry_id, adjustment.id);
});

test('Qodo 3: forged revaluation pair submitted with source edits in one diff is still rejected', () => {
  let db = seed();
  const currency = create(db, 'res.currency', {
    name: 'Q15-FORGE-FX',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  const inv = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 100, tax: 0 }],
  });
  const serverDb = postMove(inv.db, inv.id);

  // Client creates a second invoice, posts it, and runs revaluation
  const inv2 = create(serverDb, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-20',
    invoice_line_ids: [{ name: 'Additional consulting', qty: 1, price_unit: 150, tax: 0 }],
  });
  const posted2 = postMove(inv2.db, inv2.id);
  const clientDb = revalueForeignBalances(posted2, '2026-02-28', { companyId: 1 });
  const diff = diffDb(serverDb, clientDb);

  const moves = diff.created['account.move'].map((id) => read(clientDb, 'account.move', id));
  const adjustment = moves.find((m) => m.revaluation_date === '2026-02-28');

  // Forge the adjustment by tampering with amounts
  const forged = structuredClone(diff);
  forged.upserts['account.move'] = forged.upserts['account.move'].map((m) => {
    if (m.id === adjustment.id) {
      return {
        ...m,
        line_ids: m.line_ids.map((l) => ({ ...l, debit: (l.debit || 0) + 999 })),
      };
    }
    return m;
  });

  assert.throws(
    () => applyDiff(serverDb, forged),
    /System-generated status can only come from a generated accounting workflow/,
  );
});

function upgradeNotes(db, companyId) {
  return (db.messages ?? []).filter((m) => m.model === 'res.company' && m.res_id === companyId && m.body.startsWith('Upgrade:'));
}
