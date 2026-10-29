import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../src/seed.js';
import { handleApi } from './api.js';

test('company-scoped single-record REST reads do not traverse unrelated model tables', () => {
  const db = seed();
  const events = db.records['calendar.event'];
  let scans = 0;
  Object.defineProperty(db.records, 'calendar.event', { enumerable: true, get() { scans++; return events; } });
  const result = handleApi({ db, method: 'GET', path: '/api/v1/product/1', query: new URLSearchParams(), allowed: new Set(['product']), companies: new Set([1]) });
  assert.equal(result.status, 200);
  assert.equal(result.body.id, 1);
  assert.equal(scans, 0);
});
