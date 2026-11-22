import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { confirmAsset, postDepreciation, modifyAsset, disposeAsset, depreciationBoard, depreciationReport, activateDepreciation, setAssetRunning } from './models/assets.js';
import { models } from './registry.js';
import { diffDb, applyDiff } from './sync.js';

function running() {
  const base = seed();
  const made = create(base, 'account.asset', { name: 'Equipment', acquisition_date: '2026-01-01', original_value: 1000, salvage_value: 0, method: 'linear', method_number: 5, method_period: '12', state: 'draft', depreciation_ids: [], account_asset_id: accountId(base, '151000'), account_depreciation_id: accountId(base, '152000'), account_depreciation_expense_id: accountId(base, '680000') });
  return { db: confirmAsset(made.db, read(made.db, 'account.asset', made.id)), id: made.id };
}
const forged = (db, id, vals) => ({ ...db, records: { ...db.records, 'account.asset': db.records['account.asset'].map((a) => a.id === id ? { ...a, ...vals } : a) } });
const sync = (db, next) => applyDiff(db, diffDb(db, next), { isAdmin: true });

test('AST-4 permits resetting only an unposted running asset through sync', () => {
  const { db, id } = running();
  assert.equal(read(sync(db, forged(db, id, { state: 'draft' })), 'account.asset', id).state, 'draft');
  const posted = postDepreciation(db, read(db, 'account.asset', id), '2026-12-31');
  assert.throws(() => sync(posted, forged(posted, id, { state: 'draft' })), /Cannot reset/);
});

test('AST-6 increase creates a linked asset without changing parent value', () => {
  const { db, id } = running();
  const next = modifyAsset(db, read(db, 'account.asset', id), { date: '2026-02-01', valueChange: 200, accountId: accountId(db, '680000') });
  const children = search(next, 'account.asset').filter((a) => a.parent_id === id);
  assert.equal(children.length, 1);
  assert.equal(children[0].original_value, 200);
  assert.equal(search(sync(db, next), 'account.asset').filter((a) => a.parent_id === id).length, 1);
  assert.equal(read(next, 'account.asset', id).original_value, 1000);
  assert.ok(models['account.asset'].form.smart.some((s) => s.label === 'Gross Increases' && s.field === 'parent_id'));
});

test('AST-9 wizard uses selected loss account and saves notes for disposal and pause/resume', () => {
  const { db, id } = running();
  const buttons = models['account.asset'].form.buttons;
  const dispose = buttons.find((b) => b.label === 'Sell or Dispose');
  const fields = dispose.wizard(db, read(db, 'account.asset', id)).fields;
  assert.ok(fields.some((f) => f.name === 'loss_account_id'));
  assert.ok(fields.some((f) => f.name === 'gain_account_id'));
  const loss = accountId(db, '680000');
  const done = disposeAsset(db, read(db, 'account.asset', id), { date: '2026-02-01', lossAccountId: loss, note: 'Scrapped' });
  assert.ok(read(done, 'account.move', read(done, 'account.asset', id).disposal_move_id).line_ids.some((l) => l.account_id === loss && l.debit === 1000));
  assert.ok(done.messages.some((m) => m.res_id === id && m.body === 'Scrapped'));
  const pause = buttons.find((b) => b.label === 'Pause');
  const resume = buttons.find((b) => b.label === 'Resume');
  assert.ok(pause.wizard && resume.wizard);
  const paused = pause.run(db, read(db, 'account.asset', id), { date: '2026-02-01', note: 'Paused note' }).db;
  const resumed = resume.run(paused, read(paused, 'account.asset', id), { date: '2026-03-01', note: 'Resumed note' }).db;
  assert.ok(resumed.messages.some((m) => m.res_id === id && m.body === 'Paused note'));
  assert.ok(resumed.messages.some((m) => m.res_id === id && m.body === 'Resumed note'));
});


test('cancelled assets without posted depreciation can return to draft through sync', () => {
  const { db, id } = running();
  const cancelled = sync(db, forged(db, id, { state: 'cancel' }));
  assert.equal(read(sync(cancelled, forged(cancelled, id, { state: 'draft' })), 'account.asset', id).state, 'draft');
  assert.ok(models['account.asset'].form.buttons.find((b) => b.label === 'Set to Draft').when(read(cancelled, 'account.asset', id)));
});

test('modify wizard exposes actions, accounts and activation creates a linked asset at book value', () => {
  const { db, id } = running();
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const spec = button.wizard(db, read(db, 'account.asset', id));
  const action = spec.fields.find((f) => f.name === 'modify_action');
  assert.deepEqual(action.options.map(([v]) => v), ['dispose', 'sell', 'modify', 'pause', 'activate_depreciation']);
  for (const name of ['name', 'date', 'gain_account_id', 'loss_account_id', 'account_asset_id', 'account_asset_counterpart_id', 'new_account_asset_id', 'invoice_line_ids']) assert.ok(spec.fields.some((f) => f.name === name), name);
  const result = button.run(db, read(db, 'account.asset', id), { modify_action: 'activate_depreciation', date: '2026-02-01', new_account_asset_id: accountId(db, '151000'), name: 'Activated' }).db;
  assert.equal(read(result, 'account.asset', id).state, 'close');
  const derived = search(result, 'account.asset').find((a) => a.origin_asset_id === id);
  assert.equal(derived.original_value, 1000);
  assert.equal(derived.account_asset_id, accountId(db, '151000'));
  assert.ok(result.messages.some((m) => m.res_id === id && m.body === 'Activated'));
  assert.ok(models['account.asset'].form.smart.some((s) => s.label === 'Original Asset'));
  assert.ok(models['account.asset'].form.smart.some((s) => s.label === 'Active Asset'));
});


test('activation transfers the remaining value after posted depreciation and syncs links', () => {
  const initial = running();
  const db = postDepreciation(initial.db, read(initial.db, 'account.asset', initial.id), '2026-12-31');
  const target = accountId(db, '152000');
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const next = button.run(db, read(db, 'account.asset', initial.id), { modify_action: 'activate_depreciation', date: '2027-01-01', new_account_asset_id: target }).db;
  const derived = search(next, 'account.asset').find((a) => a.origin_asset_id === initial.id);
  assert.equal(derived.original_value, 800);
  assert.equal(derived.account_asset_id, target);
  assert.equal(read(next, 'account.asset', initial.id).book_value, 0);
  const transfer = search(next, 'account.move').find((m) => m.ref === 'Equipment transfer');
  assert.ok(transfer.line_ids.some((l) => l.account_id === target && l.debit === 800));
  assert.ok(transfer.line_ids.some((l) => l.account_id === accountId(db, '151000') && l.credit === 800));
  assert.equal(search(sync(db, next), 'account.asset').filter((a) => a.origin_asset_id === initial.id).length, 1);
});

test('re-evaluation uses separate gross increase and counterpart accounts', () => {
  const { db, id } = running();
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const target = accountId(db, '152000');
  const next = button.run(db, read(db, 'account.asset', id), { modify_action: 'modify', date: '2026-02-01', value_residual: 1200, account_asset_id: target, account_asset_counterpart_id: accountId(db, '680000') }).db;
  const child = search(next, 'account.asset').find((a) => a.parent_id === id);
  assert.equal(child.account_asset_id, target);
  assert.equal(read(next, 'account.asset', id).gross_increase_value, 200);
  assert.deepEqual(read(next, 'account.asset', id).children_ids, [child.id]);
});


test('modify wizard keeps the entered rate and applies the selected period', () => {
  const { db, id } = running();
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const spec = button.wizard(db, read(db, 'account.asset', id));
  assert.notEqual(spec.fields.find((f) => f.name === 'method_period').readonly, true);
  const next = button.run(db, read(db, 'account.asset', id), { modify_action: 'modify', date: '2026-02-01', method_mode: 'rate', method_rate: 0.3, method_period: '1', value_residual: 1000 }).db;
  const asset = read(next, 'account.asset', id);
  assert.equal(asset.method_period, '1');
  assert.equal(asset.method_rate, 0.3);
  assert.ok(Math.abs(asset.method_number - 1 / 0.3) < 1e-10);
  assert.equal(read(sync(db, next), 'account.asset', id).method_rate, 0.3);
});


test('sale books every selected invoice line and rejects reuse through sync', () => {
  const initial = running();
  const made = create(initial.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-15', invoice_line_ids: [
    { name: 'First', qty: 1, price_unit: 200, tax: 0, account_id: accountId(initial.db, '101401') },
    { name: 'Second', qty: 1, price_unit: 300, tax: 0, account_id: accountId(initial.db, '101401') },
  ] });
  const db = postMove(made.db, made.id);
  const lines = [{ invoice_id: made.id, line_index: 0 }, { invoice_id: made.id, line_index: 1 }];
  const next = disposeAsset(db, read(db, 'account.asset', initial.id), { date: '2026-02-01', invoiceLines: lines, lossAccountId: accountId(db, '680000') });
  const asset = read(next, 'account.asset', initial.id);
  assert.equal(asset.sale_value, 500);
  assert.deepEqual(asset.sale_invoice_line_ids, lines);
  const entry = read(next, 'account.move', asset.disposal_move_id);
  assert.equal(entry.line_ids.filter((l) => l.account_id === accountId(db, '101401')).reduce((sum, l) => sum + l.debit, 0), 500);
  assert.equal(read(sync(db, next), 'account.asset', initial.id).sale_value, 500);
  assert.throws(() => sync(next, forged(next, initial.id, { sale_invoice_line_ids: [lines[0]] })), /Disposal fields cannot be modified/);
});


test('asset sale picker lists eligible lines and submits multiple selections', () => {
  const initial = running();
  const made = create(initial.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-15', invoice_line_ids: [
    { name: 'First line', qty: 1, price_unit: 200, tax: 0, account_id: accountId(initial.db, '101401') },
    { name: 'Second line', qty: 1, price_unit: 300, tax: 0, account_id: accountId(initial.db, '101401') },
  ] });
  const db = postMove(made.db, made.id);
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const spec = button.wizard(db, read(db, 'account.asset', initial.id));
  const field = spec.fields.find((f) => f.name === 'invoice_line_ids');
  assert.equal(field.type, 'many2many');
  assert.equal(field.picker, 'asset_invoice_lines');
  const options = field.options(db, { date: '2026-02-01' });
  const chosen = options.filter((o) => o.invoice_id === made.id);
  assert.deepEqual(chosen.map((o) => o.line_index), [0, 1]);
  assert.match(chosen[0].label, /First line/);
  assert.match(chosen[0].label, /200[.]00/);
  assert.ok(chosen[0].label.includes(read(db, 'account.move', made.id).name));
  const invoice = read(db, 'account.move', made.id);
  const candidates = { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'],
    { ...invoice, id: 900001, state: 'draft' },
    { ...invoice, id: 900002, company_id: 999 },
    { ...invoice, id: 900003, invoice_date: '2027-01-01' },
  ] } };
  assert.ok(field.options(candidates, { date: '2026-02-01' }).every((option) => ![900001, 900002, 900003].includes(option.invoice_id)));
  assert.throws(() => button.run(db, read(db, 'account.asset', initial.id), { modify_action: 'sell', date: '2026-02-01', invoice_line_ids: ['900002:0'] }), /Sale invoice line not found/);
  const result = button.run(db, read(db, 'account.asset', initial.id), { modify_action: 'sell', date: '2026-02-01', invoice_line_ids: chosen.map((o) => o.key), loss_account_id: accountId(db, '680000') }).db;
  assert.equal(read(result, 'account.asset', initial.id).sale_value, 500);
  assert.deepEqual(read(result, 'account.asset', initial.id).sale_invoice_line_ids, [{ invoice_id: made.id, line_index: 0 }, { invoice_id: made.id, line_index: 1 }]);
  assert.equal(read(sync(db, result), 'account.asset', initial.id).sale_value, 500);
});


test('unchanged wizard residual posts due depreciation without an increase', () => {
  const { db, id } = running();
  const asset = read(db, 'account.asset', id);
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const spec = button.wizard(db, asset);
  const residual = spec.fields.find((f) => f.name === 'value_residual').default;
  assert.equal(spec.fields.find((f) => f.name === 'method_number').type, 'float');
  const next = button.run(db, asset, { modify_action: 'modify', date: '2026-12-31', value_residual: residual }).db;
  assert.equal(read(next, 'account.asset', id).depreciation_ids.filter((l) => l.posted).length, 1);
  assert.equal(search(next, 'account.asset').filter((a) => a.parent_id === id).length, 0);
});

test('fractional duration preserves full and partial periods on confirmation and modification', () => {
  const asset = { acquisition_date: '2026-01-01', original_value: 1000, salvage_value: 0, method: 'linear', method_number: 2.5, method_period: '12' };
  assert.deepEqual(depreciationBoard(asset).map((l) => l.amount), [400, 400, 200]);
  const prorata = depreciationBoard({ ...asset, acquisition_date: '2026-07-01', prorata: true });
  assert.equal(prorata.length, 3);
  assert.equal(prorata.reduce((n, l) => n + Math.round(l.amount * 100), 0), 100000);
  const { db, id } = running();
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const next = button.run(db, read(db, 'account.asset', id), { modify_action: 'modify', date: '2026-02-01', method_number: 2.5 }).db;
  assert.deepEqual(read(next, 'account.asset', id).depreciation_ids.map((l) => [l.date, l.amount]), [['2026-12-31', 400], ['2027-12-31', 400], ['2028-12-31', 200]]);
  assert.equal(read(sync(db, next), 'account.asset', id).method_number, 2.5);
});

test('cancellation reverses posted depreciation and adjustments through sync', () => {
  const initial = running();
  const posted = postDepreciation(initial.db, read(initial.db, 'account.asset', initial.id), '2026-12-31');
  const adjusted = modifyAsset(posted, read(posted, 'account.asset', initial.id), { date: '2027-01-01', valueChange: -100 });
  const asset = read(adjusted, 'account.asset', initial.id);
  const ids = [...asset.depreciation_ids.filter((line) => line.posted).map((line) => line.move_id), ...asset.revaluation_ids.map((entry) => entry.move_id)];
  assert.throws(() => sync(adjusted, forged(adjusted, initial.id, { state: 'cancel', depreciation_ids: asset.depreciation_ids.filter((line) => line.posted) })), /Cannot cancel/);
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Cancel Asset');
  const next = button.run(adjusted, asset).db;
  const synced = sync(adjusted, next);
  assert.equal(read(synced, 'account.asset', initial.id).state, 'cancel');
  assert.ok(read(synced, 'account.asset', initial.id).depreciation_ids.every((line) => line.posted));
  for (const id of ids) {
    const original = read(synced, 'account.move', id);
    const reversal = search(synced, 'account.move').find((move) => move.reversed_entry_id === id && move.state === 'posted');
    assert.ok(reversal);
    assert.deepEqual(reversal.line_ids.map((line) => [line.account_id, line.debit, line.credit]), original.line_ids.map((line) => [line.account_id, line.credit, line.debit]));
  }
  const increased = modifyAsset(initial.db, read(initial.db, 'account.asset', initial.id), { date: '2026-02-01', valueChange: 200, accountId: accountId(initial.db, '680000') });
  assert.throws(() => sync(increased, forged(increased, initial.id, { state: 'draft' })), /Cannot reset/);
});

test('cancellation reverses unallocated depreciation under a mandatory analytic plan', () => {
  const initial = running();
  const db = create(initial.db, 'account.analytic.plan', { name: 'Mandatory', default_applicability: 'mandatory' }).db;
  const posted = postDepreciation(db, read(db, 'account.asset', initial.id), '2026-12-31');
  const asset = read(posted, 'account.asset', initial.id);
  assert.equal(asset.state, 'open');
  const original = read(posted, 'account.move', asset.depreciation_ids[0].move_id);
  assert.equal(original.line_ids.find((line) => line.account_id === asset.account_depreciation_expense_id).analytic_distribution, undefined);
  const next = models['account.asset'].form.buttons.find((button) => button.label === 'Cancel Asset').run(posted, asset).db;
  const reversal = search(next, 'account.move').find((move) => move.reversed_entry_id === original.id);
  assert.equal(read(next, 'account.asset', initial.id).state, 'cancel');
  assert.deepEqual(reversal.line_ids.map((line) => [line.account_id, line.debit, line.credit]), original.line_ids.map((line) => [line.account_id, line.credit, line.debit]));
  assert.equal(read(sync(posted, next), 'account.asset', initial.id).state, 'cancel');
});

test('period edits require a regenerated board and explicit remaining duration', () => {
  const { db, id } = running();
  assert.throws(() => sync(db, forged(db, id, { method_period: '1' })), /Cannot modify core/);
  assert.throws(() => modifyAsset(db, read(db, 'account.asset', id), { date: '2026-02-01', methodPeriod: '1' }), /Enter a remaining duration/);
  assert.throws(() => modifyAsset(db, read(db, 'account.asset', id), { date: '2026-02-01', valueChange: 200, salvageValue: 50, accountId: accountId(db, '680000') }), /separately from a gross increase/);
});

test('activation preserves salvage and transfers report value at the activation date', () => {
  for (const date of ['2026-02-01', '2027-01-01']) {
    const initial = running();
    const draft = { ...initial.db, records: { ...initial.db.records, 'account.asset': initial.db.records['account.asset'].map((a) => a.id === initial.id ? { ...a, state: 'draft', salvage_value: 100 } : a) } };
    const db = confirmAsset(draft, read(draft, 'account.asset', initial.id));
    const next = activateDepreciation(db, read(db, 'account.asset', initial.id), { date, newAccountAssetId: accountId(db, '151000') });
    const child = search(next, 'account.asset').find((a) => a.origin_asset_id === initial.id);
    assert.equal(child.salvage_value, 100);
    assert.equal(child.depreciation_ids.reduce((n, l) => n + Math.round(l.amount * 100), 0), Math.round((child.original_value - 100) * 100));
    const report = depreciationReport(next, { to: date });
    assert.equal(report.rows.find((row) => row.a.id === initial.id).book, 0);
    assert.equal(report.rows.find((row) => row.a.id === child.id).book, child.original_value);
    assert.ok(depreciationReport(next, { to: '2026-01-01' }).rows.find((row) => row.a.id === initial.id).book > 0);
  }
});

test('sale with mixed-sign invoice lines produces a balanced disposal', () => {
  const initial = running();
  const made = create(initial.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-15', invoice_line_ids: [
    { name: 'Sale', qty: 1, price_unit: 300, tax: 0, account_id: accountId(initial.db, '101401') },
    { name: 'Discount', qty: 1, price_unit: -100, tax: 0, account_id: accountId(initial.db, '101401') },
  ] });
  const db = postMove(made.db, made.id);
  const next = disposeAsset(db, read(db, 'account.asset', initial.id), { date: '2026-02-01', invoiceLines: [{ invoice_id: made.id, line_index: 0 }, { invoice_id: made.id, line_index: 1 }], lossAccountId: accountId(db, '680000') });
  assert.equal(read(next, 'account.asset', initial.id).sale_value, 200);
  assert.equal(read(sync(db, next), 'account.asset', initial.id).sale_value, 200);
});

test('sync rejects disposal that omits a selected negative invoice account', () => {
  const initial = running();
  const negativeAccount = accountId(initial.db, '101402');
  const made = create(initial.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-15', invoice_line_ids: [
    { name: 'Sale', qty: 1, price_unit: 300, tax: 0, account_id: accountId(initial.db, '101401') },
    { name: 'Discount', qty: 1, price_unit: -100, tax: 0, account_id: negativeAccount },
  ] });
  const db = postMove(made.db, made.id);
  const next = disposeAsset(db, read(db, 'account.asset', initial.id), { date: '2026-02-01', invoiceLines: [{ invoice_id: made.id, line_index: 0 }, { invoice_id: made.id, line_index: 1 }], lossAccountId: accountId(db, '680000') });
  const asset = read(next, 'account.asset', initial.id);
  assert.equal(read(sync(db, next), 'account.asset', initial.id).sale_value, 200);
  const tampered = { ...next, records: { ...next.records, 'account.move': next.records['account.move'].map((move) => move.id !== asset.disposal_move_id ? move : { ...move, line_ids: move.line_ids.filter((line) => line.account_id !== negativeAccount).map((line) => line.account_id === accountId(db, '680000') ? { ...line, debit: line.debit - 100 } : line) }) } };
  assert.throws(() => sync(db, tampered), /Disposal move must book the sale/);
});

test('Set to Running rejects fully depreciated, disposed and transferred assets, and rebuilds missing pending lines when value remains', () => {
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Set to Running');
  const user = { author: 'Test User', isAdmin: false };
  const userSync = (db, next) => applyDiff(db, diffDb(db, next), user);

  // 1. Fully depreciated closed asset: button hidden and reopen rejected via write and applyDiff
  const full = running();
  const completedDb = postDepreciation(full.db, read(full.db, 'account.asset', full.id), '2035-12-31');
  const completed = read(completedDb, 'account.asset', full.id);
  assert.equal(completed.state, 'close');
  assert.equal(button.when(completed, completedDb), false);
  assert.throws(() => button.run(completedDb, completed), /not available/i);
  assert.throws(() => setAssetRunning(completedDb, completed), /no remaining depreciation/i);
  assert.throws(() => write(completedDb, 'account.asset', full.id, { state: 'open' }), /no remaining depreciation/i);
  assert.throws(() => userSync(completedDb, forged(completedDb, full.id, { state: 'open' })), /no remaining depreciation/i);
  assert.throws(() => userSync(completedDb, forged(completedDb, full.id, {
    state: 'open',
    depreciation_ids: [...completed.depreciation_ids, { date: '2031-12-31', amount: 100, cumulated: 1100, remaining: 0, posted: false, move_id: null }],
  })), /no remaining depreciation/i);

  // 2. Disposed and activated closed assets: button hidden and reopen rejected via write and applyDiff
  const disp = running();
  const disposedDb = disposeAsset(disp.db, read(disp.db, 'account.asset', disp.id), { date: '2026-06-01' });
  const disposed = read(disposedDb, 'account.asset', disp.id);
  assert.equal(button.when(disposed, disposedDb), false);
  assert.throws(() => write(disposedDb, 'account.asset', disp.id, { state: 'open' }), /disposed or transferred/i);
  assert.throws(() => userSync(disposedDb, forged(disposedDb, disp.id, { state: 'open' })), /disposed or transferred/i);

  const act = running();
  const activatedDb = activateDepreciation(act.db, read(act.db, 'account.asset', act.id), { date: '2026-06-01', newAccountAssetId: accountId(act.db, '151000') });
  const activated = read(activatedDb, 'account.asset', act.id);
  assert.equal(button.when(activated, activatedDb), false);
  assert.throws(() => write(activatedDb, 'account.asset', act.id, { state: 'open' }), /disposed or transferred/i);
  assert.throws(() => userSync(activatedDb, forged(activatedDb, act.id, { state: 'open' })), /disposed or transferred/i);

  // 3. Closed asset with existing unposted lines reopens cleanly and stays open until due
  const partial = running();
  const onePostedDb = postDepreciation(partial.db, read(partial.db, 'account.asset', partial.id), '2026-12-31');
  const closedWithPendingDb = forged(onePostedDb, partial.id, { state: 'close' });
  const closedWithPending = read(closedWithPendingDb, 'account.asset', partial.id);
  assert.equal(button.when(closedWithPending, closedWithPendingDb), true);
  const reopenedPendingDb = button.run(closedWithPendingDb, closedWithPending).db;
  const syncedPendingDb = userSync(closedWithPendingDb, reopenedPendingDb);
  const reopenedPending = read(syncedPendingDb, 'account.asset', partial.id);
  assert.equal(reopenedPending.state, 'open');
  assert.equal(reopenedPending.depreciation_ids.filter((l) => !l.posted).length, 4);
  assert.equal(read(postDepreciation(syncedPendingDb, reopenedPending, '2027-06-01'), 'account.asset', partial.id).state, 'open');

  // 4. Closed asset with remaining depreciable value and dropped unposted lines rebuilds its board on Set to Running
  const missingBoardDb = forged(onePostedDb, partial.id, {
    state: 'close',
    depreciation_ids: read(onePostedDb, 'account.asset', partial.id).depreciation_ids.filter((l) => l.posted),
  });
  const missingBoard = read(missingBoardDb, 'account.asset', partial.id);
  assert.equal(button.when(missingBoard, missingBoardDb), true);
  const rebuiltDb = button.run(missingBoardDb, missingBoard).db;
  const syncedRebuiltDb = userSync(missingBoardDb, rebuiltDb);
  const rebuilt = read(syncedRebuiltDb, 'account.asset', partial.id);
  assert.equal(rebuilt.state, 'open');
  const rebuiltUnposted = rebuilt.depreciation_ids.filter((l) => !l.posted);
  assert.equal(rebuiltUnposted.length, 4);
  assert.equal(rebuiltUnposted.reduce((s, l) => s + Math.round(l.amount * 100), 0), 80000);
  assert.deepEqual(rebuiltUnposted.map((l) => l.date), ['2027-12-31', '2028-12-31', '2029-12-31', '2030-12-31']);
  assert.equal(read(postDepreciation(syncedRebuiltDb, rebuilt, '2027-06-01'), 'account.asset', partial.id).state, 'open');
});

test('Qodo finding 1: non-admin synchronization cannot alter locked depreciation board on reopening', () => {
  const user = { author: 'Staff User', isAdmin: false };
  const userSync = (db, next) => applyDiff(db, diffDb(db, next), user);

  // 1. Existing valid pending board: non-admin cannot alter dates or amounts while reopening
  const partial = running();
  const onePostedDb = postDepreciation(partial.db, read(partial.db, 'account.asset', partial.id), '2026-12-31');
  const closedWithPendingDb = forged(onePostedDb, partial.id, { state: 'close' });
  const asset = read(closedWithPendingDb, 'account.asset', partial.id);
  const pending = asset.depreciation_ids.filter((l) => !l.posted);
  assert.equal(pending.length, 4);

  // Tamper allocations (total 800 remains the same, but line amounts changed)
  const tamperedAmounts = asset.depreciation_ids.map((l) => l.posted ? l : { ...l, amount: l.date === '2027-12-31' ? 100 : l.date === '2028-12-31' ? 300 : l.amount });
  assert.throws(() => userSync(closedWithPendingDb, forged(closedWithPendingDb, partial.id, { state: 'open', depreciation_ids: tamperedAmounts })), /cannot alter the depreciation board|locked/i);

  // Tamper dates (e.g. shift first pending date)
  const tamperedDates = asset.depreciation_ids.map((l) => l.posted ? l : { ...l, date: l.date === '2027-12-31' ? '2027-12-30' : l.date });
  assert.throws(() => userSync(closedWithPendingDb, forged(closedWithPendingDb, partial.id, { state: 'open', depreciation_ids: tamperedDates })), /cannot alter the depreciation board|locked/i);

  // 2. Missing pending board: non-admin cannot supply arbitrary board matching residual
  const missingBoardDb = forged(onePostedDb, partial.id, {
    state: 'close',
    depreciation_ids: asset.depreciation_ids.filter((l) => l.posted),
  });
  const arbitraryBoard = [...asset.depreciation_ids.filter((l) => l.posted), { date: '2027-06-30', amount: 800, cumulated: 1000, remaining: 0, posted: false, move_id: null }];
  assert.throws(() => userSync(missingBoardDb, forged(missingBoardDb, partial.id, { state: 'open', depreciation_ids: arbitraryBoard })), /cannot alter the depreciation board|locked/i);
});

test('Qodo finding 2: rebuilding a closed asset missing pending board preserves mid-period prorata and fractional durations', () => {
  const base = seed();

  // 1. Five-year asset acquired midyear with prorata: full schedule has 6 lines
  const madeProrata = create(base, 'account.asset', {
    name: 'Midyear Truck',
    acquisition_date: '2026-07-01',
    original_value: 12000,
    salvage_value: 0,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    prorata: true,
    state: 'draft',
    depreciation_ids: [],
    account_asset_id: accountId(base, '151000'),
    account_depreciation_id: accountId(base, '152000'),
    account_depreciation_expense_id: accountId(base, '680000'),
  });
  const prorataDb = confirmAsset(madeProrata.db, read(madeProrata.db, 'account.asset', madeProrata.id));
  const prorataAsset = read(prorataDb, 'account.asset', madeProrata.id);
  assert.equal(prorataAsset.depreciation_ids.length, 6);

  // First line posts (2026-12-31)
  const postedProrataDb = postDepreciation(prorataDb, prorataAsset, '2026-12-31');
  const closedProrataDb = forged(postedProrataDb, madeProrata.id, {
    state: 'close',
    depreciation_ids: read(postedProrataDb, 'account.asset', madeProrata.id).depreciation_ids.filter((l) => l.posted),
  });
  const reopenedProrataDb = setAssetRunning(closedProrataDb, read(closedProrataDb, 'account.asset', madeProrata.id));
  const reopenedProrata = read(reopenedProrataDb, 'account.asset', madeProrata.id);
  const remainingProrata = reopenedProrata.depreciation_ids.filter((l) => !l.posted);

  // Must have 5 remaining lines (ending on 2031-12-31), NOT 4 lines ending on 2030-12-31
  assert.equal(remainingProrata.length, 5);
  assert.equal(remainingProrata.at(-1).date, '2031-12-31');
  assert.equal(remainingProrata.reduce((sum, l) => sum + Math.round(l.amount * 100), 0), 1200000 - Math.round(prorataAsset.depreciation_ids[0].amount * 100));

  // 2. Fractional duration 3.5 periods: full schedule has 4 lines (3 full + 1 half)
  const madeFrac = create(base, 'account.asset', {
    name: 'Frac Asset',
    acquisition_date: '2026-01-01',
    original_value: 7000,
    salvage_value: 0,
    method: 'linear',
    method_number: 3.5,
    method_period: '12',
    prorata: false,
    state: 'draft',
    depreciation_ids: [],
    account_asset_id: accountId(base, '151000'),
    account_depreciation_id: accountId(base, '152000'),
    account_depreciation_expense_id: accountId(base, '680000'),
  });
  const fracDb = confirmAsset(madeFrac.db, read(madeFrac.db, 'account.asset', madeFrac.id));
  const fracAsset = read(fracDb, 'account.asset', madeFrac.id);
  assert.equal(fracAsset.depreciation_ids.length, 4);

  const postedFracDb = postDepreciation(fracDb, fracAsset, '2026-12-31');
  const closedFracDb = forged(postedFracDb, madeFrac.id, {
    state: 'close',
    depreciation_ids: read(postedFracDb, 'account.asset', madeFrac.id).depreciation_ids.filter((l) => l.posted),
  });
  const reopenedFracDb = setAssetRunning(closedFracDb, read(closedFracDb, 'account.asset', madeFrac.id));
  const reopenedFrac = read(reopenedFracDb, 'account.asset', madeFrac.id);
  const remainingFrac = reopenedFrac.depreciation_ids.filter((l) => !l.posted);

  // Must have 3 remaining lines (2 full periods + 1 half period)
  assert.equal(remainingFrac.length, 3);
  assert.equal(remainingFrac[0].amount, 2000);
  assert.equal(remainingFrac[1].amount, 2000);
  assert.equal(remainingFrac[2].amount, 1000);
  assert.equal(remainingFrac.at(-1).date, '2029-12-31');
});

test('Qodo finding 3: reopening rejects or rebuilds pending depreciation lines with invalid dates predating acquisition or posted lines', () => {
  const { db, id } = running();
  const postedDb = postDepreciation(db, read(db, 'account.asset', id), '2026-12-31');
  const postedAsset = read(postedDb, 'account.asset', id);
  const postedLine = postedAsset.depreciation_ids.find((l) => l.posted);

  // 1. Pending line date predates last posted depreciation line (e.g. 2026-06-30 precedes 2026-12-31)
  const earlyDatedBoard = [
    postedLine,
    { date: '2026-06-30', amount: 800, cumulated: 1000, remaining: 0, posted: false, move_id: null },
  ];
  const closedEarlyDb = forged(postedDb, id, { state: 'close', depreciation_ids: earlyDatedBoard });

  // Direct reopen with early dates must be rejected
  assert.throws(() => write(closedEarlyDb, 'account.asset', id, { state: 'open' }), /no remaining depreciation|cannot alter/i);

  // setAssetRunning must rebuild the board instead of preserving the early date
  const fixedDb = setAssetRunning(closedEarlyDb, read(closedEarlyDb, 'account.asset', id));
  const fixedAsset = read(fixedDb, 'account.asset', id);
  assert.equal(fixedAsset.state, 'open');
  const unposted = fixedAsset.depreciation_ids.filter((l) => !l.posted);
  assert.ok(unposted.length > 0);
  assert.ok(unposted.every((l) => l.date > postedLine.date));

  // 2. Pending line date predates asset acquisition date
  const base = seed();
  const madeMid = create(base, 'account.asset', {
    name: 'Mid Asset',
    acquisition_date: '2026-06-01',
    original_value: 1000,
    salvage_value: 0,
    method: 'linear',
    method_number: 2,
    method_period: '12',
    state: 'draft',
    depreciation_ids: [],
    account_asset_id: accountId(base, '151000'),
    account_depreciation_id: accountId(base, '152000'),
    account_depreciation_expense_id: accountId(base, '680000'),
  });
  const midDb = confirmAsset(madeMid.db, read(madeMid.db, 'account.asset', madeMid.id));
  const predatedBoard = [
    { date: '2026-01-01', amount: 500, cumulated: 500, remaining: 500, posted: false, move_id: null },
    { date: '2027-12-31', amount: 500, cumulated: 1000, remaining: 0, posted: false, move_id: null },
  ];
  const closedPredatedDb = forged(midDb, madeMid.id, { state: 'close', depreciation_ids: predatedBoard });
  assert.throws(() => write(closedPredatedDb, 'account.asset', madeMid.id, { state: 'open' }), /no remaining depreciation|cannot alter/i);
  const fixedPredatedDb = setAssetRunning(closedPredatedDb, read(closedPredatedDb, 'account.asset', madeMid.id));
  assert.ok(read(fixedPredatedDb, 'account.asset', madeMid.id).depreciation_ids.filter((l) => !l.posted).every((l) => l.date >= '2026-06-01'));
});

test('confirmed asset method-setting changes succeed through normal write path', () => {
  const { db, id } = running();
  const asset = read(db, 'account.asset', id);

  const rateBoard = depreciationBoard({ ...asset, method_mode: 'rate', method_rate: 0.25, method_number: 4 })
    .map((l) => ({ ...l, posted: false, move_id: null }));
  const rateDb = write(db, 'account.asset', id, {
    method_mode: 'rate',
    method_rate: 0.25,
    method_number: 4,
    depreciation_ids: rateBoard,
  });
  const rateAsset = read(rateDb, 'account.asset', id);
  assert.equal(rateAsset.method_mode, 'rate');
  assert.equal(rateAsset.method_rate, 0.25);
  assert.equal(rateAsset.depreciation_ids.length, 4);

  const monthlyBoard = depreciationBoard({ ...rateAsset, method_mode: 'duration', method_period: '1', method_number: 12, method_rate: 1 / 12 })
    .map((l) => ({ ...l, posted: false, move_id: null }));
  const monthlyDb = write(rateDb, 'account.asset', id, {
    method_mode: 'duration',
    method_period: '1',
    method_number: 12,
    method_rate: 1 / 12,
    depreciation_ids: monthlyBoard,
  });
  const monthlyAsset = read(monthlyDb, 'account.asset', id);
  assert.equal(monthlyAsset.method_period, '1');
  assert.equal(monthlyAsset.method_number, 12);
  assert.equal(monthlyAsset.depreciation_ids.length, 12);
});

test('rate-based asset allows gross increase from Modify wizard without editing depreciation settings', () => {
  const base = seed();
  const made = create(base, 'account.asset', {
    name: 'Rate Machine',
    acquisition_date: '2026-01-01',
    original_value: 1000,
    salvage_value: 0,
    method: 'linear',
    method_mode: 'rate',
    method_rate: 0.25,
    method_number: 4,
    method_period: '12',
    state: 'draft',
    depreciation_ids: [],
    account_asset_id: accountId(base, '151000'),
    account_depreciation_id: accountId(base, '152000'),
    account_depreciation_expense_id: accountId(base, '680000'),
  });
  const db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const asset = read(db, 'account.asset', made.id);
  const button = models['account.asset'].form.buttons.find((b) => b.label === 'Modify Depreciation');
  const spec = button.wizard(db, asset);
  assert.equal(spec.fields.find((f) => f.name === 'method_mode').default, 'rate');
  assert.equal(spec.fields.find((f) => f.name === 'method_rate').default, 0.25);

  const defaults = Object.fromEntries(spec.fields.map((f) => [f.name, f.default ?? (f.type === 'many2many' ? [] : null)]));
  const next = button.run(db, asset, {
    ...defaults,
    date: '2026-02-01',
    value_residual: 1200,
    account_asset_id: accountId(db, '151000'),
    account_asset_counterpart_id: accountId(db, '680000'),
  }).db;

  const children = search(next, 'account.asset').filter((a) => a.parent_id === made.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].original_value, 200);
  assert.equal(children[0].method_mode, 'rate');
  assert.equal(children[0].method_rate, 0.25);
  assert.equal(search(sync(db, next), 'account.asset').filter((a) => a.parent_id === made.id).length, 1);

  assert.throws(() => button.run(db, asset, {
    ...defaults,
    date: '2026-02-01',
    value_residual: 1200,
    method_rate: 0.5,
    account_asset_id: accountId(db, '151000'),
    account_asset_counterpart_id: accountId(db, '680000'),
  }), /separately from a gross increase/i);
});

test('reopening a closed daily-computation asset preserves elapsed-day depreciation across leap years', () => {
  const base = seed();
  const made = create(base, 'account.asset', {
    name: 'Daily Leap Asset',
    acquisition_date: '2026-03-15',
    prorata_date: '2026-03-15',
    original_value: 12000,
    salvage_value: 0,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    prorata_computation_type: 'daily_computation',
    state: 'draft',
    depreciation_ids: [],
    account_asset_id: accountId(base, '151000'),
    account_depreciation_id: accountId(base, '152000'),
    account_depreciation_expense_id: accountId(base, '680000'),
  });
  const db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const initialAsset = read(db, 'account.asset', made.id);
  const expectedPending = initialAsset.depreciation_ids.slice(1).map((l) => [l.date, l.amount]);

  const postedDb = postDepreciation(db, initialAsset, '2026-12-31');
  const postedOnly = read(postedDb, 'account.asset', made.id).depreciation_ids.filter((l) => l.posted);
  const closedDb = forged(postedDb, made.id, { state: 'close', depreciation_ids: postedOnly });
  const reopenedDb = setAssetRunning(closedDb, read(closedDb, 'account.asset', made.id));
  const reopened = read(reopenedDb, 'account.asset', made.id);

  assert.equal(reopened.state, 'open');
  const pending = reopened.depreciation_ids.filter((l) => !l.posted);
  assert.deepEqual(pending.map((l) => [l.date, l.amount]), expectedPending);
  assert.equal(pending.find((l) => l.date === '2028-12-31').amount, 2405.26);
  assert.equal(pending.reduce((s, l) => s + Math.round(l.amount * 100), 0), 1200000 - Math.round(postedOnly[0].amount * 100));
});

test('reopening a closed degressive_then_linear asset preserves original-base straight-line floor after transition', () => {
  const base = seed();
  const made = create(base, 'account.asset', {
    name: 'Degressive Then Linear Asset',
    acquisition_date: '2026-03-15',
    prorata_date: '2026-03-15',
    original_value: 12000,
    salvage_value: 0,
    method: 'degressive_then_linear',
    method_number: 5,
    method_period: '12',
    method_progress_factor: 0.3,
    prorata_computation_type: 'constant_periods',
    state: 'draft',
    depreciation_ids: [],
    account_asset_id: accountId(base, '151000'),
    account_depreciation_id: accountId(base, '152000'),
    account_depreciation_expense_id: accountId(base, '680000'),
  });
  const db = confirmAsset(made.db, read(made.db, 'account.asset', made.id));
  const initialAsset = read(db, 'account.asset', made.id);

  const atTransitionDb = postDepreciation(db, initialAsset, '2027-12-31');
  const postedAtTransition = read(atTransitionDb, 'account.asset', made.id).depreciation_ids.filter((l) => l.posted);
  assert.equal(postedAtTransition.length, 2);
  const closedAtTransitionDb = forged(atTransitionDb, made.id, { state: 'close', depreciation_ids: postedAtTransition });
  const reopenedAtTransition = read(setAssetRunning(closedAtTransitionDb, read(closedAtTransitionDb, 'account.asset', made.id)), 'account.asset', made.id);
  assert.deepEqual(
    reopenedAtTransition.depreciation_ids.filter((l) => !l.posted).map((l) => [l.date, l.amount]),
    [['2028-12-31', 2400], ['2029-12-31', 2400], ['2030-12-31', 1594.84]],
  );

  const afterTransitionDb = postDepreciation(atTransitionDb, read(atTransitionDb, 'account.asset', made.id), '2028-12-31');
  const postedAfterTransition = read(afterTransitionDb, 'account.asset', made.id).depreciation_ids.filter((l) => l.posted);
  assert.equal(postedAfterTransition.length, 3);
  const closedAfterTransitionDb = forged(afterTransitionDb, made.id, { state: 'close', depreciation_ids: postedAfterTransition });
  const reopenedAfterTransition = read(setAssetRunning(closedAfterTransitionDb, read(closedAfterTransitionDb, 'account.asset', made.id)), 'account.asset', made.id);
  assert.deepEqual(
    reopenedAfterTransition.depreciation_ids.filter((l) => !l.posted).map((l) => [l.date, l.amount]),
    [['2029-12-31', 2400], ['2030-12-31', 1594.84]],
  );
});
