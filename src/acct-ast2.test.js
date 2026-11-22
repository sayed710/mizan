import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { confirmAsset, postDepreciation, modifyAsset, disposeAsset, depreciationBoard, depreciationReport, activateDepreciation } from './models/assets.js';
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
