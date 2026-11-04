import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { confirmAsset, disposeAsset } from './models/assets.js';
import { postEntry } from './models/ledger.js';
import { closeFiscalYear, reopenFiscalYear } from './models/closing.js';
import { applyDiff, diffDb } from './sync.js';

test('imported depreciation cannot exceed the depreciable value', () => {
  const asset = create(seed(), 'account.asset', { name: 'Imported asset', original_value: 1000, salvage_value: 200, already_depreciated: 900, acquisition_date: '2025-01-01' });
  assert.throws(() => confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id)), /depreciat.*(base|value)/i);
});

test('a manual entry resembling a closing cannot be linked to a fiscal year', () => {
  const year = create(seed(), 'account.fiscal.year', { name: '2025', date_from: '2025-01-01', date_to: '2025-12-31' });
  const equity = create(year.db, 'account.account', { code: '302000', name: 'Retained earnings', account_type: 'equity' });
  const manual = postEntry(equity.db, { journal: 'MISC', date: '2025-12-31', ref: 'Fiscal closing: 2025', lines: [{ account: '400000', debit: 100 }, { account: '302000', credit: 100 }] });
  assert.throws(() => write(manual.db, 'account.fiscal.year', year.id, { state: 'closed', closing_move_id: manual.id }), /closing/i);
});

test('asset disposal rejects a sale price without a customer invoice', () => {
  const asset = create(seed(), 'account.asset', { name: 'Sale asset', original_value: 1000, acquisition_date: '2025-01-01' });
  const db = confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id));
  assert.throws(() => disposeAsset(db, read(db, 'account.asset', asset.id), { date: '2025-02-01', saleValue: 1000 }), /Select the customer invoice for this sale/);
});

test('closing provenance survives sync and legacy entries without it cannot be reopened', () => {
  const year = create(seed(), 'account.fiscal.year', { name: '2035', date_from: '2035-01-01', date_to: '2035-12-31' });
  const closed = applyDiff(year.db, diffDb(year.db, closeFiscalYear(year.db, year.id)));
  const closingId = read(closed, 'account.fiscal.year', year.id).closing_move_id;
  assert.equal(read(closed, 'account.move', closingId).closing_fiscal_year_id, year.id);
  assert.equal(read(reopenFiscalYear(closed, year.id), 'account.fiscal.year', year.id).state, 'open');
  const legacy = { ...closed, records: { ...closed.records, 'account.move': closed.records['account.move'].map((m) => m.id === closingId ? { ...m, closing_fiscal_year_id: null } : m) } };
  assert.throws(() => reopenFiscalYear(legacy, year.id), /closing.*provenance/i);
});
