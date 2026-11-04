import { test } from 'node:test';
import './models/index.js';
import assert from 'node:assert/strict';
import { installments } from './models/terms.js';
import { checkMandatoryPlans } from './models/analyticplus.js';
import { disposeAsset } from './models/assets.js';

test('payment terms reject an incomplete percentage split', () => {
  assert.throws(() => installments({ line_ids: [{ value_type: 'percent', value: 10 }, { value_type: 'percent', value: 10 }] }, 1000, '2026-01-01'), /100%/);
});

test('mandatory analytic plan requires full allocation', () => {
  const db = { records: { 'account.analytic.plan': [{ id: 1, name: 'Project', default_applicability: 'mandatory' }], 'account.analytic.account': [{ id: 1, plan_id: 1 }] } };
  assert.throws(() => checkMandatoryPlans(db, { move_type: 'entry', line_ids: [{ analytic_distribution: { 1: 1 } }] }), /mandatory/i);
});

test('paused asset disposal refuses unresolved due depreciation', () => {
  const asset = { id: 1, state: 'paused', depreciation_ids: [{ date: '2026-03-31', amount: 100, posted: false }] };
  const db = { records: { 'account.asset': [asset] } };
  assert.throws(() => disposeAsset(db, asset, { date: '2026-04-15', saleValue: 0 }), /post.*depreciation/i);
});

