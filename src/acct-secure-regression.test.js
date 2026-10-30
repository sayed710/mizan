import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { apps, leavesOf, models } from './models/index.js';
import { postEntry } from './models/ledger.js';
import { sha256, checkInalterability, computeMoveHash, secureEntries } from './models/hash_chain.js';
import { journalAudit } from './models/journal_audit.js';
import { applyDiff, assignIds, diffDb } from './sync.js';
import { parseDistributionInput } from './analytic_distribution.js';
import { saveFormRecord } from './views/formSave.js';
import { openStorage } from '../server/storage.js';

const server = (old, next) => applyDiff(old, diffDb(old, next), { isAdmin: true });
const entry = (db, company, date = '2026-01-01') => postEntry(db, { journal: 'SEC', date, company, lines: [{ account: '600000', debit: 100 }, { account: '211000', credit: 100 }] });
const setup = () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Second company' }); db = company.db;
  const journal = create(db, 'account.journal', { name: 'Secure journal', code: 'SEC', restrict_mode_hash_table: true }); db = journal.db;
  return { db, company: company.id, journal: journal.id };
};

test('wizard action persists isolated company chains and lock dates through server diffs and SQLite', () => {
  let { db, company, journal } = setup();
  let result = entry(db, 1); db = result.db; const first = result.id;
  result = entry(db, company); db = result.db; const second = result.id;
  const leaf = leavesOf(apps.find((a) => a.id === 'accounting')).find((l) => l.key === 'secure-entries');
  const wizardModel = models[leaf.model];
  for (const id of [1, company]) {
    const wizard = create(db, leaf.model, { company: id, hash_date: '2026-01-31' }); db = wizard.db;
    assert.equal(read(db, leaf.model, wizard.id).move_to_hash_ids.length, 1);
    const next = wizardModel.form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, leaf.model, wizard.id)).db;
    db = server(db, next);
    if (id === 1) assert.doesNotThrow(() => entry(db, company, '2026-01-15'));
  }
  assert.equal(read(db, 'res.company', company).hard_lock_date, '2026-01-01');
  const storage = openStorage(new DatabaseSync(':memory:')); storage.save(null, db); db = storage.load();
  assert.equal(read(db, 'account.move', first).secure_sequence_number, 1);
  assert.equal(read(db, 'account.move', second).secure_sequence_number, 1);
  const checks = checkInalterability(db, { journalId: journal });
  assert.equal(checks.length, 2); assert.ok(checks.every((r) => r.status === 'ok'));
  assert.throws(() => write(db, 'res.company', company, { hard_lock_date: null }), /cannot be moved back/);
  assert.throws(() => entry(db, company, '2026-01-01'), /locked/);
});

test('server rejects forged secure hashes and noncontiguous sequence numbers', () => {
  let { db } = setup(); const move = entry(db, 1); db = move.db;
  for (const vals of [{ inalterable_hash: 'fake', secure_sequence_number: 1 }, { secure_sequence_number: 1 }]) {
    const forged = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === move.id ? { ...m, ...vals } : m) } };
    assert.throws(() => server(db, forged), /Invalid secure entry hash chain/);
  }
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('configuration forms enforce tag applicability and real distinct tax unit companies', () => {
  let { db, company } = setup();
  const accountTag = create(db, 'account.account.tag', { name: 'Account', applicability: 'accounts' }); db = accountTag.db;
  const taxTag = create(db, 'account.account.tag', { name: 'Tax', applicability: 'taxes' }); db = taxTag.db;
  const account = db.records['account.account'][0], tax = db.records['account.tax'][0];
  assert.throws(() => write(db, 'account.account', account.id, { tag_ids: [taxTag.id] }), /account tags/);
  assert.throws(() => write(db, 'account.tax', tax.id, { tag_ids: [accountTag.id] }), /tax tags/);
  assert.throws(() => create(db, 'account.tax.unit', { name: 'Invalid', company_ids: [1, 1], main_company_id: 1 }), /at least 2/);
  assert.throws(() => create(db, 'account.tax.unit', { name: 'Invalid', company_ids: [1, 999], main_company_id: 1 }), /existing companies/);
  const unit = create(db, 'account.tax.unit', { name: 'Valid', company_ids: [1, company], main_company_id: company });
  assert.equal(server(db, unit.db).records['account.tax.unit'].at(-1).main_company_id, company);
});

test('journal audit calculates filtered journal totals and signed refund taxes', () => {
  let { db, company, journal } = setup();
  let result = entry(db, 1); db = result.db;
  result = entry(db, company); db = result.db;
  const move = read(db, 'account.move', result.id);
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === move.id ? { ...m, line_ids: [{ ...m.line_ids[0], tax_name: 'VAT', tax_base: 100, tax_side: 'sale' }, m.line_ids[1]] } : m) } };
  const rows = journalAudit(db, { from: '2026-01-01', to: '2026-01-31', companyId: company });
  const group = rows.find((r) => r.journal.id === journal);
  assert.equal(group.debit, 100); assert.equal(group.credit, 100); assert.deepEqual(group.taxes, [{ name: 'VAT', base: -100, tax: -100 }]);
  assert.equal(journalAudit(db, { from: '2027-01-01', companyId: company }).length, 0);
});
import { postMove } from './models/accounting.js';

test('depreciation model creates assets directly and on a bill account with server persistence', () => {
  let { db, company } = setup();
  const account = db.records['account.account'].find((a) => a.account_type === 'expense');
  const analytic = create(db, 'account.analytic.account', { name: 'Equipment project', code: 'EQUIP' }); db = analytic.db;
  const model = create(db, 'account.asset.model', { name: 'Equipment', method: 'degressive_then_linear', method_number: 4, method_period: '12', prorata: true, account_asset_id: account.id, analytic_distribution: { [analytic.id]: 100 } }); db = model.db;
  db = write(db, 'account.account', account.id, { asset_model_id: model.id });
  const asset = create(db, 'account.asset', { name: 'Direct', model_id: model.id, original_value: 500, company_id: company }); db = asset.db;
  assert.equal(read(db, 'account.asset', asset.id).method, 'degressive_then_linear');
  assert.deepEqual(read(db, 'account.asset', asset.id).analytic_distribution, { [analytic.id]: 100 });
  const bill = create(db, 'account.move', { move_type: 'in_invoice', company_id: company, partner_id: db.records['res.partner'][0].id, invoice_date: '2026-03-01', invoice_line_ids: [{ name: 'Equipment', account_id: account.id, qty: 1, price_unit: 500 }] });
  const posted = postMove(bill.db, bill.id);
  const generated = posted.records['account.asset'].find((a) => a.bill_id === bill.id);
  assert.equal(generated.company_id, company); assert.equal(generated.model_id, model.id); assert.equal(generated.state, 'draft');
  const persisted = server(db, posted);
  const storage = openStorage(new DatabaseSync(':memory:')); storage.save(null, persisted);
  assert.equal(read(storage.load(), 'account.asset', generated.id).method, 'degressive_then_linear');
});

test('incoterm order action copies both fields to a server-persisted invoice', () => {
  let db = seed();
  const fob = db.records['account.incoterm'].find((i) => i.code === 'FOB');
  const order = create(db, 'sale.order', { partner_id: db.records['res.partner'][0].id, incoterm_id: fob.id, incoterm_location: 'Alexandria', order_line: [{ product_id: db.records.product[0].id, qty: 1, price_unit: 100 }] }); db = order.db;
  const buttons = models['sale.order'].form.buttons;
  db = buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'sale.order', order.id)).db;
  const action = buttons.find((b) => b.label === 'Create Invoice').run(db, read(db, 'sale.order', order.id));
  const invoiceId = Number(action.go.split('/').at(-1));
  const persisted = server(db, action.db);
  const storage = openStorage(new DatabaseSync(':memory:')); storage.save(null, persisted);
  const invoice = read(storage.load(), 'account.move', invoiceId);
  assert.equal(invoice.incoterm_id, fob.id); assert.equal(invoice.incoterm_location, 'Alexandria');
});


test('wizard warns of draft entries and sequence gaps and displays the posted entry count', () => {
  let { db, journal } = setup();
  const accounts = db.records['account.account'];
  const lines = [{ account_id: accounts.find((a) => a.code === '600000').id, debit: 100, credit: 0 }, { account_id: accounts.find((a) => a.code === '211000').id, debit: 0, credit: 100 }];
  for (const number of [1, 3]) db = create(db, 'account.move', { move_type: 'entry', state: 'posted', journal_id: journal, invoice_date: '2026-01-01', name: `SEC/2026/${String(number).padStart(4, '0')}`, line_ids: lines }).db;
  db = create(db, 'account.move', { move_type: 'entry', state: 'draft', journal_id: journal, invoice_date: '2026-01-02', name: '/', line_ids: [] }).db;
  const wizard = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-31' });
  const record = read(wizard.db, 'account.secure.entries.wizard', wizard.id);
  assert.equal(record.entries_count, 2);
  assert.equal(record.not_hashable_unlocked_move_ids.length, 1);
  assert.match(record.warnings, /draft entries/); assert.match(record.warnings, /Sequence gaps/);
});


function securedFixture(count = 3) {
  let { db, journal } = setup();
  const ids = [];
  for (let i = 0; i < count; i++) { const result = entry(db, 1, `2026-01-0${i + 1}`); db = result.db; ids.push(result.id); }
  const wizard = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-31' }); db = wizard.db;
  const action = models['account.secure.entries.wizard'].form.buttons.find((b) => b.label === 'Confirm');
  db = server(db, action.run(db, read(db, 'account.secure.entries.wizard', wizard.id)).db);
  return { db, journal, ids };
}

test('SQLite tampering with a chain tail, middle, or one-entry chain is detected using the independent journal head', () => {
  for (const scenario of ['clear-tail', 'delete-tail', 'delete-middle', 'clear-only', 'delete-only']) {
    const { db, journal, ids } = securedFixture(scenario.endsWith('only') ? 1 : 3);
    const sql = new DatabaseSync(':memory:'); const storage = openStorage(sql); storage.save(null, db);
    const id = scenario === 'delete-middle' ? ids[1] : ids.at(-1);
    if (scenario.startsWith('clear')) {
      const move = read(db, 'account.move', id);
      sql.prepare('UPDATE records SET data = ? WHERE model = ? AND id = ?').run(JSON.stringify({ ...move, inalterable_hash: null }), 'account.move', id);
    } else sql.prepare('DELETE FROM records WHERE model = ? AND id = ?').run('account.move', id);
    const result = checkInalterability(storage.load(), { journalId: journal, companyId: 1 })[0];
    assert.equal(result.status, 'corrupted', scenario);
    assert.notEqual(result.message, 'No secured entries', scenario);
    sql.close();
  }
});

test('SQLite tax, currency, partner, tags, analytic and reversal tampering invalidates version 2 hashes', () => {
  const { db, journal, ids } = securedFixture(1);
  const move = read(db, 'account.move', ids[0]);
  const cases = [
    ['tax_name', 'VAT'], ['tax_base', 99], ['tax_side', 'sale'], ['tax_zero', true], ['tax_id', 1], ['tax_ids', [1]], ['tax_tag_ids', [1]], ['tag_ids', [1]],
    ['currency_id', 1], ['amount_currency', 17], ['partner_id', 1], ['analytic_distribution', { 1: 100 }], ['name', 'changed']
  ];
  for (const [field, value] of cases) {
    const sql = new DatabaseSync(':memory:'); const storage = openStorage(sql); storage.save(null, db);
    const changed = { ...move, line_ids: move.line_ids.map((line, index) => index ? line : { ...line, [field]: value }) };
    sql.prepare('UPDATE records SET data = ? WHERE model = ? AND id = ?').run(JSON.stringify(changed), 'account.move', move.id);
    assert.equal(checkInalterability(storage.load(), { journalId: journal, companyId: 1 })[0].status, 'corrupted', field);
    sql.close();
  }
  for (const [field, value] of [['move_type', 'out_invoice'], ['reversed_entry_id', 1], ['reversal_move_id', 1], ['correction_of_id', 1], ['currency_id', 1], ['is_closing', true]]) {
    const sql = new DatabaseSync(':memory:'); const storage = openStorage(sql); storage.save(null, db);
    sql.prepare('UPDATE records SET data = ? WHERE model = ? AND id = ?').run(JSON.stringify({ ...move, [field]: value }), 'account.move', move.id);
    assert.equal(checkInalterability(storage.load(), { journalId: journal, companyId: 1 })[0].status, 'corrupted', field);
    sql.close();
  }
});

test('legacy version 1 chain verifies and is anchored before version 2 entries extend it', () => {
  let { db, journal } = setup(); const first = entry(db, 1); db = first.db;
  const old = read(db, 'account.move', first.id);
  const legacy = { ...old, inalterable_hash: computeMoveHash(old, '', 1), secure_sequence_number: 1 };
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === first.id ? legacy : m) } };
  assert.equal(checkInalterability(db, { journalId: journal })[0].status, 'unanchored');
  const anchored = secureEntries(db, { companyId: 1, hashDate: '2026-01-31' });
  db = server(db, anchored);
  assert.equal(checkInalterability(db, { journalId: journal })[0].status, 'ok');
  const second = entry(db, 1, '2026-02-01'); db = second.db;
  db = server(db, secureEntries(db, { companyId: 1, hashDate: '2026-02-28' }));
  assert.equal(read(db, 'account.move', first.id).inalterable_hash, legacy.inalterable_hash);
  assert.equal(read(db, 'account.move', second.id).inalterable_hash_version, 2);
  assert.equal(checkInalterability(db, { journalId: journal })[0].status, 'ok');
});

test('server and ORM refuse removal or rewrite of journal chain heads', () => {
  const { db, journal } = securedFixture();
  assert.throws(() => write(db, 'account.journal', journal, { secure_chain_heads: [] }), /cannot be removed/);
  const bad = { ...db, records: { ...db.records, 'account.journal': db.records['account.journal'].map((j) => j.id === journal ? { ...j, secure_chain_heads: [] } : j) } };
  assert.throws(() => server(db, bad), /cannot be removed/);
});


test('invoice secured through the wizard survives server field cleaning and SQLite', () => {
  let db = seed();
  const journal = db.records['account.journal'].find((j) => j.code === 'INV');
  db = write(db, 'account.journal', journal.id, { restrict_mode_hash_table: true });
  db = postMove(db, 6);
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: db.records['res.partner'][0].id, invoice_date: '2027-01-01', invoice_line_ids: [{ name: 'Taxed service', qty: 1, price_unit: 100, tax: 14 }] });
  db = server(db, postMove(invoice.db, invoice.id));
  const wizard = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2027-12-31' }); db = wizard.db;
  const action = models['account.secure.entries.wizard'].form.buttons.find((b) => b.label === 'Confirm');
  db = server(db, action.run(db, read(db, 'account.secure.entries.wizard', wizard.id)).db);
  const sql = new DatabaseSync(':memory:'); const storage = openStorage(sql); storage.save(null, db);
  assert.equal(checkInalterability(storage.load(), { journalId: journal.id, companyId: 1 })[0].status, 'ok');
  sql.close();
});


test('empty secure wizard leaves the hard lock unchanged and explains why', () => {
  const action = models['account.secure.entries.wizard'].form.buttons.find((b) => b.label === 'Confirm');
  for (const scenario of ['no restricted journal', 'no entries', 'before first entry']) {
    let { db, journal } = setup();
    if (scenario === 'no restricted journal') db = write(db, 'account.journal', journal, { restrict_mode_hash_table: false });
    if (scenario === 'before first entry') db = entry(db, 1, '2026-02-01').db;
    const wizard = create(db, 'account.secure.entries.wizard', { company: 1, hash_date: '2026-01-01' }); db = wizard.db;
    const before = read(db, 'res.company', 1).hard_lock_date;
    const result = action.run(db, read(db, 'account.secure.entries.wizard', wizard.id));
    assert.match(result.message, /No entries were secured/);
    assert.equal(read(result.db, 'res.company', 1).hard_lock_date, before, scenario);
    assert.equal(read(server(db, result.db), 'res.company', 1).hard_lock_date, before, scenario);
  }
});

test('depreciation model action posts allocated expense and analytic lines with server persistence', () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Equipment project', code: 'EQUIP' }); db = analytic.db;
  const distribution = { [analytic.id]: 100 };
  const model = create(db, 'account.asset.model', { name: 'Annual equipment', method: 'linear', method_number: 2, method_period: '12', analytic_distribution: distribution }); db = model.db;
  const asset = create(db, 'account.asset', { name: 'Equipment', model_id: model.id, original_value: 1200, acquisition_date: '2020-01-01' }); db = asset.db;
  const buttons = models['account.asset'].form.buttons;
  db = buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.asset', asset.id)).db;
  const posted = buttons.find((b) => b.label === 'Post Depreciation').run(db, read(db, 'account.asset', asset.id)).db;
  const persisted = server(db, posted);
  const moveId = read(persisted, 'account.asset', asset.id).depreciation_ids[0].move_id;
  const move = read(persisted, 'account.move', moveId);
  const expense = move.line_ids.find((line) => line.debit > 0);
  assert.deepEqual(expense.analytic_distribution, distribution);
  const allocated = persisted.records['account.analytic.line'].filter((line) => line.move_id === moveId);
  assert.equal(allocated.length, 1); assert.equal(allocated[0].account_id, analytic.id); assert.equal(allocated[0].amount, -600);
});

test('asset disposal and deferred expense and revenue actions allocate profit and loss lines', () => {
  let db = seed(); const analytic = create(db, 'account.analytic.account', { name: 'Project', code: 'PROJ' }); db = analytic.db;
  const distribution = { [analytic.id]: 100 };
  const asset = create(db, 'account.asset', { name: 'Disposal', original_value: 1200, acquisition_date: '2026-01-01', method_number: 3, method_period: '12', analytic_distribution: distribution }); db = asset.db;
  const buttons = models['account.asset'].form.buttons;
  db = buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.asset', asset.id)).db;
  const previousPrompt = globalThis.prompt; globalThis.prompt = () => '0';
  try { db = buttons.find((b) => b.label === 'Sell or Dispose').run(db, read(db, 'account.asset', asset.id)).db; } finally { globalThis.prompt = previousPrompt; }
  const disposal = db.records['account.move'].find((m) => m.ref === 'Disposal disposal');
  const loss = disposal.line_ids.find((l) => l.analytic_distribution);
  assert.deepEqual(loss.analytic_distribution, distribution);
  assert.equal(db.records['account.analytic.line'].find((l) => l.move_id === disposal.id).amount, -1200);
  for (const kind of ['expense', 'revenue']) {
    const deferral = create(db, 'account.deferral', { name: kind, kind, amount: 300, months: 1, start_date: '2020-01-01', analytic_distribution: distribution }); db = deferral.db;
    const actions = models['account.deferral'].form.buttons;
    db = actions.find((b) => b.label === 'Compute').run(db, read(db, 'account.deferral', deferral.id)).db;
    const next = actions.find((b) => b.label === 'Post Due Entries').run(db, read(db, 'account.deferral', deferral.id)).db;
    db = server(db, next);
    const moveId = read(db, 'account.deferral', deferral.id).board[0].move_id;
    assert.deepEqual(read(db, 'account.move', moveId).line_ids.find((l) => l.analytic_distribution).analytic_distribution, distribution);
    assert.equal(db.records['account.analytic.line'].find((l) => l.move_id === moveId).amount, kind === 'expense' ? -300 : 300);
  }
});


test('depreciation model form save and server sync reject invalid analytic distributions', () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Project', code: 'VALID' }); db = analytic.db;
  const second = create(db, 'account.analytic.account', { name: 'Second', code: 'VALID2' }); db = second.db;
  const leaf = leavesOf(apps.find((app) => app.id === 'accounting')).find((item) => item.key === 'depreciation-models');
  assert.ok(models[leaf.model].form.groups.flat().includes('analytic_distribution'));
  const bad = [parseDistributionInput('{'), parseDistributionInput('null'), parseDistributionInput('[]'), [], '', 'not JSON', { 999999: 100 }, { [analytic.id]: '50' }, { [analytic.id]: -1 }, { [analytic.id]: 60, [second.id]: 50 }];
  for (const value of bad) {
    assert.throws(() => saveFormRecord(db, leaf.model, null, { name: 'Invalid', analytic_distribution: value }), /Analytic|analytic/);
    if (Number.isNaN(value)) continue; // JSON cannot transport NaN; malformed text is stopped by the form save.
    const raw = { ...models[leaf.model].defaults(), id: (db.seq[leaf.model] ?? 0) + 1, name: 'Invalid', analytic_distribution: value };
    assert.throws(() => applyDiff(db, { upserts: { [leaf.model]: [raw] }, deletes: {} }, { isAdmin: true }), /Analytic|analytic|Invalid value/);
  }
  const good = saveFormRecord(db, leaf.model, null, { name: 'Valid', analytic_distribution: parseDistributionInput(`{"${analytic.id}":100}`) });
  const persisted = server(db, good.db);
  assert.deepEqual(read(persisted, leaf.model, good.id).analytic_distribution, { [analytic.id]: 100 });
  assert.throws(() => saveFormRecord(persisted, leaf.model, good.id, { analytic_distribution: parseDistributionInput('{') }), /Analytic/);
  const forged = { ...persisted, records: { ...persisted.records, [leaf.model]: persisted.records[leaf.model].map((r) => r.id === good.id ? { ...r, analytic_distribution: { [analytic.id]: 60, [second.id]: 50 } } : r) } };
  assert.throws(() => server(persisted, forged), /cannot exceed 100%/);
});

test('shared validation rejects invalid distributions on assets, deferrals, invoice and journal lines', () => {
  let db = seed(); const analytic = create(db, 'account.analytic.account', { name: 'Project', code: 'PLAN' }); db = analytic.db;
  const invalid = { [analytic.id]: 101 };
  for (const [model, vals] of [
    ['account.asset', { name: 'Asset', analytic_distribution: invalid }],
    ['account.deferral', { name: 'Deferral', analytic_distribution: invalid }],
    ['account.move', { move_type: 'out_invoice', invoice_line_ids: [{ name: 'Line', qty: 1, price_unit: 1, analytic_distribution: invalid }] }],
    ['account.move', { move_type: 'entry', line_ids: [{ analytic_distribution: invalid }] }],
  ]) {
    assert.throws(() => create(db, model, vals), /cannot exceed 100%/);
    const id = (db.seq[model] ?? 0) + 1;
    assert.throws(() => applyDiff(db, { upserts: { [model]: [{ ...vals, id }] }, deletes: {} }, { isAdmin: true }), /cannot exceed 100%|Invalid value/);
  }
});

test('server remaps analytic accounts in top-level and line distributions for queued creates', () => {
  const db = seed();
  const accountId = (db.seq['account.analytic.account'] ?? 0) + 1;
  const modelId = (db.seq['account.asset.model'] ?? 0) + 1;
  const account = create(db, 'account.analytic.account', { name: 'Queued', code: 'QUEUED' });
  const model = create(account.db, 'account.asset.model', { name: 'Queued model', analytic_distribution: { [accountId]: 100 } });
  const invoice = create(model.db, 'account.move', { move_type: 'out_invoice', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 10, analytic_distribution: { [accountId]: 100 } }] });
  const collision = create(db, 'account.analytic.account', { name: 'Other', code: 'OTHER' }).db;
  const assigned = assignIds(collision, diffDb(db, invoice.db));
  const saved = applyDiff(collision, assigned.diff, { isAdmin: true });
  const remappedId = assigned.remapped['account.analytic.account'][accountId];
  const actualModelId = assigned.remapped['account.asset.model']?.[modelId] ?? modelId;
  assert.deepEqual(read(saved, 'account.asset.model', actualModelId).analytic_distribution, { [remappedId]: 100 });
  const invoiceId = assigned.remapped['account.move']?.[invoice.id] ?? invoice.id;
  assert.deepEqual(read(saved, 'account.move', invoiceId).invoice_line_ids[0].analytic_distribution, { [remappedId]: 100 });
});


test('server ID assignment rejects malformed analytic keys and remapping collisions on models and journal lines', () => {
  const client = seed();
  const queued = create(client, 'account.analytic.account', { name: 'Queued', code: 'QUEUED' });
  const model = create(queued.db, 'account.asset.model', { name: 'Model' });
  const invoice = create(model.db, 'account.move', { move_type: 'out_invoice', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 10 }] });
  const competing = create(client, 'account.analytic.account', { name: 'Other', code: 'OTHER' }).db;
  const oldId = queued.id, newId = oldId + 1;
  for (const place of ['model', 'line']) {
    for (const [label, distribution, error] of [
      ['noncanonical', { '01': 25, '1': 25 }, /valid analytic account/],
      ['exponent', { '1e0': 50 }, /valid analytic account/],
      ['collision', { [oldId]: 50, [newId]: 50 }, /remapping collision/],
    ]) {
      const diff = diffDb(client, invoice.db);
      if (place === 'model') diff.upserts['account.asset.model'][0] = { ...diff.upserts['account.asset.model'][0], analytic_distribution: distribution };
      else diff.upserts['account.move'][0] = { ...diff.upserts['account.move'][0], invoice_line_ids: [{ ...diff.upserts['account.move'][0].invoice_line_ids[0], analytic_distribution: distribution }] };
      assert.throws(() => { const assigned = assignIds(competing, diff); applyDiff(competing, assigned.diff, { isAdmin: true }); }, error, `${place}: ${label}`);
    }
  }
});
