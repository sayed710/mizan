import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { confirmAsset } from './models/assets.js';

test('imported depreciation cannot exceed the depreciable value', () => {
  const asset = create(seed(), 'account.asset', { name: 'Imported asset', original_value: 1000, salvage_value: 200, already_depreciated: 900, acquisition_date: '2025-01-01' });
  assert.throws(() => confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id)), /depreciat.*(base|value)/i);
});
