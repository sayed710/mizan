import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search } from './orm.js';
import { models } from './models/index.js';
import { parseAmount, promptedAmount } from './models/common.js';
import { seed } from './seed.js';

test('typed amounts accept Arabic-Indic digits and separators, and refuse ambiguous text', () => {
  assert.equal(parseAmount('١٠٠'), 100);
  assert.equal(parseAmount('۱۲'), 12);
  assert.equal(parseAmount('١٬٢٣٤٫٥'), 1234.5);
  assert.equal(parseAmount('1,000'), 1000);
  assert.equal(parseAmount(' 12.50 '), 12.5);
  // Amounts copied from the Arabic UI carry invisible direction marks.
  assert.equal(parseAmount('\u2066-3\u2069'), -3);
  for (const bad of ['1,5', 'abc', '', '1.2.3', '$5']) assert.ok(Number.isNaN(parseAmount(bad)), bad);
  assert.equal(promptedAmount(null), null);
  assert.equal(promptedAmount('  '), null);
  assert.throws(() => promptedAmount('abc'), /not a valid amount/);
  assert.throws(() => promptedAmount('0'), /not a valid amount/);
});

test('oversized decimal text cannot become an infinite amount', () => {
  const input = '9'.repeat(400);
  assert.ok(Number.isNaN(parseAmount(input)));
  assert.throws(() => promptedAmount(input), /not a valid amount/);
});

test('Register Payment takes an amount typed with Arabic digits instead of silently ignoring it', () => {
  const db = seed();
  const inv = search(db, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual >= 100);
  const button = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const saved = globalThis.prompt;
  try {
    globalThis.prompt = () => '١٠٠';
    const paid = button.run(db, read(db, 'account.move', inv.id)).db;
    assert.equal(Math.round((read(paid, 'account.move', inv.id).amount_residual - (inv.amount_residual - 100)) * 100), 0);
    globalThis.prompt = () => '1,5';
    assert.throws(() => button.run(db, read(db, 'account.move', inv.id)), /not a valid amount/);
  } finally {
    if (saved === undefined) delete globalThis.prompt;
    else globalThis.prompt = saved;
  }
});
