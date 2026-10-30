import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { postMove } from './models/accounting.js';
import { accountId, isBalanced } from './models/ledger.js';
import { confirmAsset, depreciationBoard, disposeAsset, postDepreciation } from './models/assets.js';
import { seed } from './seed.js';

const BASE = { name: 'Delivery Van', acquisition_date: '2026-03-15', original_value: 10000, salvage_value: 0, method: 'linear', method_number: 5, method_period: '12', method_progress_factor: 0.3 };
const total = (board) => Math.round(board.reduce((s, l) => s + l.amount * 100, 0)) / 100;

const running = (vals = {}) => {
  const { db, id } = create(seed(), 'account.asset', { ...BASE, state: 'draft', depreciation_ids: [], ...vals });
  return { db: confirmAsset(db, read(db, 'account.asset', id)), id };
};
const lineAmount = (db, move, code) => {
  const l = move.line_ids.find((x) => x.account_id === accountId(db, code));
  return l ? l.debit || -l.credit : 0;
};

test('a linear yearly board sums exactly to the base and ends on Dec 31', () => {
  const board = depreciationBoard({ ...BASE, original_value: 1000, salvage_value: 100, method_number: 3 });
  assert.deepEqual(board.map((l) => l.amount), [300, 300, 300]);
  assert.deepEqual(board.map((l) => l.date), ['2026-12-31', '2027-12-31', '2028-12-31']);
  assert.equal(board.at(-1).remaining, 100);
  const odd = depreciationBoard({ ...BASE, original_value: 1000, already_depreciated: 0, method_number: 3 });
  assert.deepEqual(odd.map((l) => l.amount), [333.33, 333.33, 333.34]);
  const imported = depreciationBoard({ ...BASE, already_depreciated: 2000, method_number: 4 });
  assert.equal(total(imported), 8000);
  assert.equal(imported[0].cumulated, 4000);
});

test('prorata shortens the first year and adds a final period for the remainder', () => {
  const board = depreciationBoard({ ...BASE, original_value: 12000, method_number: 4, acquisition_date: '2026-07-01', prorata: true });
  assert.equal(board.length, 5);
  assert.equal(board[0].amount, 1512.33); // 3000 * 184 / 365
  assert.deepEqual(board.slice(1, 4).map((l) => l.amount), [3000, 3000, 3000]);
  assert.equal(board[4].amount, 1487.67);
  assert.equal(board[4].date, '2030-12-31');
  assert.equal(total(board), 12000);
});

test('declining amounts decrease and total the base; monthly periods use factor / 12', () => {
  const board = depreciationBoard({ ...BASE, method: 'degressive' });
  assert.deepEqual(board.map((l) => l.amount), [3000, 2100, 1470, 1029, 2401]);
  assert.ok(board.slice(0, -1).every((l, i, a) => i === 0 || l.amount < a[i - 1].amount));
  assert.equal(total(board), 10000);
  const monthly = depreciationBoard({ ...BASE, method: 'degressive', method_period: '1', method_number: 12, original_value: 1200 });
  assert.equal(monthly[0].amount, 30);
  assert.equal(monthly[0].date, '2026-03-31');
  assert.equal(total(monthly), 1200);
});

test('declining then straight line switches to linear once it is larger', () => {
  const board = depreciationBoard({ ...BASE, method: 'degressive_then_linear' });
  assert.deepEqual(board.map((l) => l.amount), [3000, 2100, 1633.33, 1633.34, 1633.33]);
  assert.equal(total(board), 10000);
});

test('only due lines are posted, each balanced on expense and accumulated depreciation', () => {
  const { db, id } = running();
  const partly = postDepreciation(db, read(db, 'account.asset', id), '2027-12-31');
  const a = read(partly, 'account.asset', id);
  assert.deepEqual(a.depreciation_ids.map((l) => l.posted), [true, true, false, false, false]);
  assert.equal(a.state, 'open');
  assert.equal(a.book_value, 6000);
  const moves = a.depreciation_ids.filter((l) => l.posted).map((l) => read(partly, 'account.move', l.move_id));
  assert.ok(moves.every((m) => isBalanced(m.line_ids)));
  assert.equal(lineAmount(partly, moves[0], '680000'), 2000);
  assert.equal(lineAmount(partly, moves[0], '152000'), -2000);
});

test('a paused asset posts nothing and the asset closes when every line is posted', () => {
  const { db, id } = running();
  const paused = postDepreciation(db, { ...read(db, 'account.asset', id), state: 'paused' }, '2099-12-31');
  assert.equal(paused, db);
  const done = postDepreciation(db, read(db, 'account.asset', id), '2099-12-31');
  const a = read(done, 'account.asset', id);
  assert.equal(a.state, 'close');
  assert.equal(a.book_value, 0);
});

test('selling above book value books a gain with a balanced entry', () => {
  const { db, id } = running();
  const sold = disposeAsset(db, read(db, 'account.asset', id), { date: '2027-12-31', saleValue: 7000 });
  const a = read(sold, 'account.asset', id);
  assert.equal(a.state, 'close');
  assert.equal(a.depreciation_ids.length, 2);
  assert.equal(a.disposal_date, '2027-12-31');
  assert.equal(a.sale_value, 7000);
  const move = sold.records['account.move'].find((m) => m.ref === 'Delivery Van disposal');
  assert.ok(isBalanced(move.line_ids));
  assert.equal(lineAmount(sold, move, '151000'), -10000);
  assert.equal(lineAmount(sold, move, '152000'), 4000);
  assert.equal(lineAmount(sold, move, '101401'), 7000);
  assert.equal(lineAmount(sold, move, '450300'), -1000);
});

test('scrapping an asset books the remaining book value as a loss', () => {
  const { db, id } = running({ already_depreciated: 1000 });
  const scrapped = disposeAsset(db, read(db, 'account.asset', id), { date: '2026-12-31' });
  const move = scrapped.records['account.move'].find((m) => m.ref === 'Delivery Van disposal');
  assert.ok(isBalanced(move.line_ids));
  assert.equal(lineAmount(scrapped, move, '152000'), 2800); // 1800 posted + 1000 imported
  assert.equal(lineAmount(scrapped, move, '101401'), 0);
  assert.equal(lineAmount(scrapped, move, '690300'), 7200);
});

test('invalid assets are refused on confirm', () => {
  assert.throws(() => running({ original_value: 0 }), /original value must be positive/);
  assert.throws(() => running({ method_number: 0 }), /at least 1/);
  assert.throws(() => running({ method_number: 2.5 }), /at least 1/);
  assert.throws(() => running({ salvage_value: 10000 }), /lower than the original value/);
});

test('posting a bill line on a fixed-asset account creates one draft asset', () => {
  const base = seed();
  const { db, id } = create(base, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-06-01',
    invoice_line_ids: [{ name: 'Forklift', product_id: 1, qty: 1, price_unit: 30000, tax: 14, account_id: accountId(base, '151000') }, { product_id: 1, qty: 1, price_unit: 100, tax: 14 }],
  });
  const posted = postMove(db, id);
  const assets = search(posted, 'account.asset').filter((a) => a.bill_id === id);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].name, 'Forklift');
  assert.equal(assets[0].original_value, 30000);
  assert.equal(assets[0].state, 'draft');
});

test('foreign-currency bill asset depreciates and disposes its company-currency cost', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'FXA', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
  db = currency.db;
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-06-01', currency_id: currency.id,
    invoice_line_ids: [{ name: 'Foreign forklift', product_id: 1, qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, '151000') }],
  });
  db = postMove(bill.db, bill.id);
  const asset = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.equal(lineAmount(db, read(db, 'account.move', bill.id), '151000'), 50);
  assert.equal(asset.original_value, 50);
  db = confirmAsset(db, asset);
  db = postDepreciation(db, read(db, 'account.asset', asset.id), '2026-12-31');
  const depreciation = read(db, 'account.asset', asset.id).depreciation_ids[0];
  assert.equal(depreciation.amount, 10);
  assert.equal(lineAmount(db, read(db, 'account.move', depreciation.move_id), '680000'), 10);
  db = disposeAsset(db, read(db, 'account.asset', asset.id), { date: '2026-12-31' });
  const disposal = search(db, 'account.move').find((m) => m.ref === 'Foreign forklift disposal');
  assert.equal(lineAmount(db, disposal, '151000'), -50);
  assert.equal(lineAmount(db, disposal, '152000'), 10);
  assert.equal(lineAmount(db, disposal, '690300'), 40);
});

test('grouped foreign bill assets use the booked cents through depreciation and disposal', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'FXG', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
  db = currency.db;
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-06-01', currency_id: currency.id,
    invoice_line_ids: ['First machine', 'Second machine'].map((name) => ({ name, product_id: 1, qty: 1, price_unit: 0.03, tax: 0, account_id: accountId(db, '151000') })),
  });
  db = postMove(bill.db, bill.id);
  const assets = search(db, 'account.asset').filter((a) => a.bill_id === bill.id);
  assert.equal(assets.length, 2);
  assert.equal(lineAmount(db, read(db, 'account.move', bill.id), '151000'), 0.03);
  assert.equal(Math.round(assets.reduce((sum, a) => sum + a.original_value, 0) * 100), 3);
  for (const asset of assets) {
    db = confirmAsset(db, asset);
    db = postDepreciation(db, read(db, 'account.asset', asset.id), '2026-12-31');
    db = disposeAsset(db, read(db, 'account.asset', asset.id), { date: '2026-12-31' });
  }
  const disposals = search(db, 'account.move').filter((m) => m.ref?.endsWith('machine disposal'));
  assert.equal(disposals.length, 2);
  assert.equal(Math.round(disposals.reduce((sum, m) => sum + lineAmount(db, m, '151000'), 0) * 100), -3);
});

test('one-cent grouped bill drafts only usable assets and disposes the booked value', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'FXC', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
  db = currency.db;
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-06-01', currency_id: currency.id,
    invoice_line_ids: [1, 2].map((n) => ({ name: `Small asset ${n}`, product_id: 1, qty: 1, price_unit: 0.01, tax: 0, account_id: accountId(db, '151000') })),
  });
  db = postMove(bill.db, bill.id);
  const assets = search(db, 'account.asset').filter((a) => a.bill_id === bill.id);
  const booked = lineAmount(db, read(db, 'account.move', bill.id), '151000');
  assert.equal(booked, 0.01);
  assert.equal(assets.length, 1);
  assert.ok(assets.every((asset) => asset.original_value > 0));
  assert.equal(Math.round(assets.reduce((sum, a) => sum + a.original_value, 0) * 100), Math.round(booked * 100));
  for (const asset of assets) {
    db = confirmAsset(db, asset);
    db = postDepreciation(db, read(db, 'account.asset', asset.id), '2026-12-31');
    db = disposeAsset(db, read(db, 'account.asset', asset.id), { date: '2026-12-31' });
  }
  const disposals = search(db, 'account.move').filter((m) => m.ref?.startsWith('Small asset ') && m.ref.endsWith(' disposal'));
  assert.equal(disposals.length, assets.length);
  assert.equal(Math.round(disposals.reduce((sum, m) => sum + lineAmount(db, m, '151000'), 0) * 100), -Math.round(booked * 100));
});

test('fiscal position mapped asset account is used for bill posting and disposal', () => {
  let db = seed();
  const source = accountId(db, '151000');
  const mapped = create(db, 'account.account', { code: '151100', name: 'Mapped fixed assets', account_type: 'asset_fixed' });
  db = mapped.db;
  const position = create(db, 'account.fiscal.position', {
    name: 'Asset mapping', account_ids: [{ account_src_id: source, account_dest_id: mapped.id }],
  });
  db = position.db;
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-06-01', fiscal_position_id: position.id,
    invoice_line_ids: [{ name: 'Mapped machine', product_id: 1, qty: 1, price_unit: 100, tax: 0, account_id: source }],
  });
  db = postMove(bill.db, bill.id);
  const posted = read(db, 'account.move', bill.id);
  const asset = search(db, 'account.asset').find((a) => a.bill_id === bill.id);
  assert.equal(lineAmount(db, posted, '151100'), 100);
  assert.equal(lineAmount(db, posted, '151000'), 0);
  assert.equal(asset.account_asset_id, mapped.id);
  db = confirmAsset(db, asset);
  db = disposeAsset(db, read(db, 'account.asset', asset.id), { date: '2026-12-31' });
  const disposal = search(db, 'account.move').find((m) => m.ref === 'Mapped machine disposal');
  assert.equal(lineAmount(db, disposal, '151100'), -100);
  assert.equal(lineAmount(db, disposal, '151000'), 0);
});
