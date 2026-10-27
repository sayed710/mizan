import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageWindow, PAGE_SIZE } from './views/paging.js';

test('pages through records 80 at a time', () => {
  assert.deepEqual(pageWindow(5000, 0), { start: 0, end: 80, total: 5000, prev: null, next: 80, label: '1-80' });
  const mid = pageWindow(5000, 80);
  assert.equal(mid.label, '81-160');
  assert.equal(mid.prev, 0);
  const last = pageWindow(5000, 4960);
  assert.equal(last.label, '4961-5000');
  assert.equal(last.next, null);
});

test('clamps to the last page when records disappear and handles empty lists', () => {
  assert.equal(pageWindow(100, 800).label, '81-100');
  assert.equal(pageWindow(80, 80).label, '1-80');
  assert.deepEqual(pageWindow(0, 160), { start: 0, end: 0, total: 0, prev: null, next: null, label: '0' });
  assert.equal(pageWindow(10, -5).start, 0);
  assert.equal(PAGE_SIZE, 80);
});
