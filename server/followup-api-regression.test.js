import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/models/index.js';
import { seed } from '../src/seed.js';
import { handleApi } from './api.js';

test('partner GET responses serialize lazy follow-up status', () => {
  const db = seed();
  const id = db.records['res.partner'][0].id;
  const get = (path) => JSON.parse(JSON.stringify(handleApi({ method: 'GET', path, query: new URLSearchParams(), db, user: { name: 'Admin', isAdmin: true } }).body));
  assert.equal(typeof get(`/api/v1/res.partner/${id}`).followup_status, 'string');
  assert.equal(typeof get('/api/v1/res.partner').records[0].followup_status, 'string');
});
