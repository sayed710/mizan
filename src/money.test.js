import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashRound, cents, round } from './money.js';

test('cash rounding uses the configured increment and direction, including refunds', () => {
  assert.equal(cashRound(10.02, 0.05, 'UP'), 10.05);
  assert.equal(cashRound(-10.02, 0.05, 'UP'), -10.05);
  assert.equal(cashRound(10.04, 0.05, 'DOWN'), 10);
  assert.equal(cashRound(-10.04, 0.05, 'DOWN'), -10);
  assert.equal(cashRound(10.025, 0.05, 'HALF-UP'), 10.05);
  assert.equal(cashRound(-10.025, 0.05, 'HALF-UP'), -10.05);
  assert.equal(cashRound(10.05, 0.05, 'UP'), 10.05);
  assert.throws(() => cashRound(10, 0, 'UP'));
  assert.throws(() => cashRound(10, 0.05, 'INVALID'));
});

test('round goes half away from zero, through binary floating point error', () => {
  assert.equal(round(1.005), 1.01);
  assert.equal(round(0.125), 0.13);
  assert.equal(round(-0.125), -0.13);
  assert.equal(round(2.675), 2.68);
  assert.equal(round(1.004), 1);
  assert.equal(round(0.1 + 0.2), 0.3);
  assert.equal(round(12.3456, 3), 12.346);
  assert.equal(round(5, 0), 5);
});

test('round and cents treat non-numbers as 0 and never return -0', () => {
  for (const bad of [NaN, undefined, null, 'x', Infinity]) assert.equal(round(bad), 0);
  assert.ok(Object.is(round(-0.001), 0));
  assert.equal(round('7.255'), 7.26);
  assert.equal(cents(1.005), 101);
  assert.equal(cents(-19.995), -2000);
  assert.equal(cents(undefined), 0);
});

test('no module keeps its own copy of the money helpers', async () => {
  const { execSync } = await import('node:child_process');
  const copies = execSync('grep -rlE "^const (round|round2|cents) = \\(n" src server --include=*.js --exclude=*.test.js || true', { encoding: 'utf8' }).trim();
  assert.equal(copies, '');
});
