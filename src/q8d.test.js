import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { seed } from './seed.js';
import { postDueEntries } from './models/deferred.js';
import { accountId, postEntry } from './models/ledger.js';
import { postAutoPostMoves } from './models/accounting.js';
import { reverseEntry } from './models/pay.js';
import { closeFiscalYear } from './models/closing.js';
import { applyDiff, diffDb } from './sync.js';

const button = (model, label, db, id) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const force = (db, model, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => (r.id === id ? { ...r, ...vals } : r)) } });
const sale = (db, date, amount = 100) => postEntry(db, { journal: 'MISC', date, lines: [{ account: '101401', debit: amount }, { account: '400000', credit: amount }] });

test('Qodo 5: a client-sent number change does not become an audit tracking message', () => {
  const entry = sale(write(seed(), 'res.company', 1, { audit_trail: true }), '2031-01-05');
  const db = entry.db;
  const forged = { upserts: {}, deletes: {}, messages: [], removedMessages: [], sequenceRenamed: [['account.move', entry.id, 'FAKE/1', read(db, 'account.move', entry.id).name]] };
  const result = applyDiff(db, forged, { isAdmin: true });
  assert.equal(result.messages.length, db.messages.length);
});

test('Qodo 13: an ordinary entry cannot be submitted as a fiscal year closing entry', () => {
  let db = sale(seed(), '2031-06-01').db;
  const year = create(db, 'account.fiscal.year', { name: 'FY2031', company_id: 1, date_from: '2031-01-01', date_to: '2031-12-31' });
  db = year.db;
  const closed = closeFiscalYear(db, year.id);
  // The genuine close round-trips through sync.
  assert.equal(read(applyDiff(db, diffDb(db, closed), { isAdmin: true }), 'account.fiscal.year', year.id).state, 'closed');
  const ordinary = sale(db, '2031-12-31', 7);
  const forgedMove = force(ordinary.db, 'account.move', ordinary.id, { closing_fiscal_year_id: year.id, is_closing: true });
  const forged = force(forgedMove, 'account.fiscal.year', year.id, { state: 'closed', closing_move_id: ordinary.id });
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /closing entry must be the one made by closing/);
});

test('Qodo 26: only administrators can change company lock dates over sync', () => {
  const db = seed();
  const next = force(db, 'res.company', 1, { lock_date: '2020-01-31' });
  assert.throws(() => applyDiff(db, diffDb(db, next)), /Only administrators can change lock dates/);
  assert.equal(read(applyDiff(db, diffDb(db, next), { isAdmin: true }), 'res.company', 1).lock_date, '2020-01-31');
});

test('Qodo 41: enabling the audit trail in the same change set still protects a numbered draft from deletion', () => {
  const entry = create(seed(), 'account.move', { move_type: 'entry', name: 'MISC/2031/0099', state: 'draft', invoice_date: '2031-01-05', line_ids: [] });
  const db = entry.db;
  const company = { ...read(db, 'res.company', 1), audit_trail: true };
  assert.throws(() => applyDiff(db, { upserts: { 'res.company': [company] }, deletes: { 'account.move': [entry.id] } }, { isAdmin: true }), /Numbered entries cannot be deleted/);
});

test('Qodo 75: a settings-level audit trail flag from an old client is not stored', () => {
  const db = seed();
  const result = applyDiff(db, { upserts: {}, deletes: {}, settings: { ...db.settings, audit_trail: true } }, { isAdmin: true });
  assert.equal(result.settings.audit_trail, undefined);
});

test('Qodo 12: a direct write cannot cancel a deferral with posted recognition', () => {
  const made = create(seed(), 'account.deferral', { name: 'Contract', kind: 'revenue', amount: 120, start_date: '2026-01-01', months: 12, company_id: 1, deferred_account_id: accountId(seed(), '212000'), recognition_account_id: accountId(seed(), '400000') });
  let db = button('account.deferral', 'Compute', made.db, made.id);
  db = postDueEntries(db, read(db, 'account.deferral', made.id), '2026-01-31');
  assert.throws(() => write(db, 'account.deferral', made.id, { state: 'cancel' }), /Reverse the recognition entries/);
});

test('Qodo 24: a scheduled reversal does not post once its source is cancelled', () => {
  const entry = sale(seed(), '2031-01-05');
  let db = reverseEntry(entry.db, read(entry.db, 'account.move', entry.id), { date: '2031-03-01', scheduled: true }).db;
  const reversal = search(db, 'account.move').find((m) => m.reversed_entry_id === entry.id);
  assert.equal(reversal.state, 'draft');
  db = button('account.move', 'Cancel', button('account.move', 'Reset to Draft', db, entry.id), entry.id);
  db = postAutoPostMoves(db, '2031-03-02');
  assert.equal(read(db, 'account.move', reversal.id).state, 'draft');
});
