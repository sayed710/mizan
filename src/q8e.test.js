import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { debitNote, postMove, reverseDepreciation } from './models/accounting.js';
import { accountId, balanceSheet } from './models/ledger.js';
import { confirmAsset, modifyAsset, postDepreciation, resumeAsset } from './models/assets.js';
import { logManualFollowUp } from './models/finance.js';
import { runScheduledJobs } from './models/scheduler.js';
import { postDueEntries } from './models/deferred.js';
import { companyViewDb } from './companyView.js';
import { createCompany } from './models/company.js';
import { migrate } from './migrations.js';
import { assetAccounts } from './test-support/asset-accounts.js';

const button = (model, label, db, id) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const force = (db, model, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => (r.id === id ? { ...r, ...vals } : r)) } });
const invoice = (db, values = {}) => create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2031-01-10', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }], ...values });

test('Qodo 6: the next recurring occurrence does not inherit the previous counterpart bill', () => {
  const made = invoice(seed(), { auto_post: 'monthly' });
  const posted = postMove(force(made.db, 'account.move', made.id, { intercompany_move_id: 999 }), made.id);
  const next = search(posted, 'account.move').find((m) => m.auto_post_origin_id === made.id);
  assert.ok(next);
  assert.equal(next.intercompany_move_id ?? null, null);
});

test('Qodo 10: the balance sheet renders when the earnings account is not configured', () => {
  const db = write(seed(), 'res.company', 1, { current_year_earnings_account_id: null });
  const sheet = balanceSheet(db);
  assert.equal(sheet.earningsAccount, null);
  assert.equal(typeof sheet.earnings, 'number');
});

test('Qodo 25: an asset paused before pause dates were recorded can resume', () => {
  const base = seed();
  const made = create(base, 'account.asset', { ...assetAccounts(base), name: 'Legacy pause', acquisition_date: '2026-01-01', original_value: 1200, salvage_value: 0, method_number: 3, method_period: '1' });
  let db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const board = read(db, 'account.asset', made.id).depreciation_ids;
  db = force(db, 'account.asset', made.id, { state: 'paused', pause_date: null });
  db = resumeAsset(db, read(db, 'account.asset', made.id), '2026-03-15');
  assert.equal(read(db, 'account.asset', made.id).state, 'open');
  assert.deepEqual(read(db, 'account.asset', made.id).depreciation_ids, board);
});

test('Qodo 27: a branch view keeps the payment term its invoice was issued with', () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Q8E branch', parent_id: 1, currency_id: read(db, 'res.company', 1).currency_id });
  db = branch.db;
  const term = search(db, 'account.payment.term').find((t) => (t.company_id ?? 1) === 1 && t.company_id);
  const termId = term?.id ?? create(db, 'account.payment.term', { name: 'Company 1 term', company_id: 1, line_ids: [{ value: 'balance', days: 30 }] }).id;
  if (!term) db = create(db, 'account.payment.term', { name: 'Company 1 term', company_id: 1, line_ids: [{ value: 'balance', days: 30 }] }).db;
  const legacy = invoice(db, { company_id: branch.id });
  db = force(legacy.db, 'account.move', legacy.id, { invoice_payment_term_id: termId });
  const view = companyViewDb({ ...db, settings: { ...db.settings, current_company_id: branch.id, allowed_company_ids: [branch.id] } });
  assert.ok(read(view, 'account.payment.term', termId));
});

test('Qodo 39: an archived counterpart account cannot be used for an asset adjustment', () => {
  const base = seed();
  const made = create(base, 'account.asset', { ...assetAccounts(base), name: 'Adjusted', acquisition_date: '2026-01-01', original_value: 1000, salvage_value: 0, method_number: 5, method_period: '12', account_asset_id: accountId(base, '151000') });
  let db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const archived = create(db, 'account.account', { name: 'Archived revaluation', code: 'Q8EARCH', account_type: 'equity', company_id: 1, active: false });
  assert.throws(() => modifyAsset(archived.db, read(archived.db, 'account.asset', made.id), { date: '2027-01-01', valueChange: 500, accountId: archived.id }), /Configure the counterpart account/);
});

test('Qodo 40: migration 30 keeps an unresolved bank counterpart code', () => {
  const db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const line = create(db, 'account.bank.statement.line', { journal_id: journal.id, payment_ref: 'Legacy', date: '2026-01-01', amount: 5 });
  const legacy = force({ ...line.db, schema_version: 29 }, 'account.bank.statement.line', line.id, { counterpart: 'NO-SUCH-CODE', counterpart_account_id: null });
  assert.equal(read(migrate(legacy), 'account.bank.statement.line', line.id).counterpart, 'NO-SUCH-CODE');
});

test('Qodo 48: a recognition entry reversed through the journal-entry action no longer blocks cancelling', () => {
  const base = seed();
  const made = create(base, 'account.deferral', { name: 'Contract', kind: 'revenue', amount: 120, start_date: '2026-01-01', months: 12, company_id: 1, deferred_account_id: accountId(base, '212000'), recognition_account_id: accountId(base, '400000') });
  let db = button('account.deferral', 'Compute', made.db, made.id);
  db = postDueEntries(db, read(db, 'account.deferral', made.id), '2026-01-31');
  const moveId = read(db, 'account.deferral', made.id).board.find((l) => l.move_id).move_id;
  const source = read(db, 'account.move', moveId);
  db = create(db, 'account.move', { move_type: 'entry', state: 'posted', name: 'MISC/2026/Q8E1', journal_id: source.journal_id, invoice_date: '2026-02-01', reversed_entry_id: moveId, line_ids: source.line_ids.map((l) => ({ ...l, debit: l.credit, credit: l.debit })) }).db;
  assert.equal(read(button('account.deferral', 'Cancel', db, made.id), 'account.deferral', made.id).state, 'cancel');
});

test('Qodo 52: a depreciation entry cannot be reversed before its own date', () => {
  const base = seed();
  const made = create(base, 'account.asset', { ...assetAccounts(base), name: 'Reversed early', acquisition_date: '2026-01-01', original_value: 1200, salvage_value: 0, method_number: 3, method_period: '1' });
  let db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  db = postDepreciation(db, read(db, 'account.asset', made.id), '2026-02-28');
  const move = read(db, 'account.move', read(db, 'account.asset', made.id).depreciation_ids.find((l) => l.posted).move_id);
  assert.throws(() => reverseDepreciation(db, move, { date: addDays(move.date ?? move.invoice_date, -1) }), /cannot be before the depreciation entry date/);
});

test('Qodo 62: a debit note does not keep the rental charge link of its invoice', () => {
  const made = invoice(seed(), { invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, rental_id: 7, rental_charge: 'late' }] });
  const db = postMove(made.db, made.id);
  const note = debitNote(db, read(db, 'account.move', made.id));
  const line = read(note.db, 'account.move', note.id).invoice_line_ids[0];
  assert.equal(line.rental_id, undefined);
  assert.equal(line.rental_charge, undefined);
});

test('Qodo 11: delivered follow-ups are handed to commitFollowUps before later jobs run', async () => {
  const partner = create(seed(), 'res.partner', { name: 'Reminder recipient', email: 'recipient@example.test' });
  const made = create(partner.db, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, invoice_date: addDays(today(), -60), invoice_date_due: addDays(today(), -20), invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const db = postMove(made.db, made.id);
  const commits = [];
  await runScheduledJobs(runScheduledJobs(db, today()), today(), { deliverFollowUp: async () => {}, commitFollowUps: (before, after) => { commits.push(after); return after; } });
  assert.equal(commits.length, 1);
  assert.ok(commits[0].messages.some((m) => m.res_id === partner.id && m.body.includes('Payment reminder sent')));
});

test('Qodo 42: a mixed-currency reminder note does not claim 0 overdue', () => {
  const currency = create(seed(), 'res.currency', { name: 'Q8EFX', rate_ids: [{ date: '2020-01-01', rate: 2 }] });
  let db = currency.db;
  for (const currency_id of [null, currency.id]) {
    const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id, invoice_date: addDays(today(), -60), invoice_date_due: addDays(today(), -20), invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(made.db, made.id);
  }
  const logged = logManualFollowUp(db, 1);
  const notes = logged.messages.slice(db.messages.length).map((m) => m.body).join('\n');
  assert.ok(notes.includes('overdue'));
  assert.ok(!/: 0 overdue/.test(notes));
});

