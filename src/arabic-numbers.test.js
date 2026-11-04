import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search } from './orm.js';
import { models } from './models/index.js';
import { parseAmount, promptedAmount, today } from './models/common.js';
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
  const companyId = inv.company_id ?? 1;
  const paymentJournals = search(db, 'account.journal').filter((journal) => journal.default_for_payments && (!journal.company_id || journal.company_id === companyId));
  assert.equal(paymentJournals.length, 1);
  const journal_id = paymentJournals[0].id;
  const paid = button.run(db, read(db, 'account.move', inv.id), { amount: '١٠٠', date: today(), journal_id }).db;
  assert.equal(Math.round((read(paid, 'account.move', inv.id).amount_residual - (inv.amount_residual - 100)) * 100), 0);
  assert.throws(() => button.run(db, read(db, 'account.move', inv.id), { amount: '1,5', date: today(), journal_id }), /not a valid amount/);
});

test('CSV export removes directional isolation marks from cells', async () => {
  const { toCsv } = await import('./csv.js');
  const csv = toCsv([['Price'], ['\u2066-100.00\u2069']]);
  assert.equal(csv, '"Price"\r\n"-100.00"');
  assert.doesNotMatch(csv, /[\u2066\u2069\u200E\u200F\u061C]/);
});
