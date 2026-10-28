import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupSummary, checkBackup } from './backup.js';
import { seed } from './seed.js';

const valid = () => JSON.parse(JSON.stringify(seed()));

test('a backup with a wrongly typed field, special model name or malformed settings is refused', () => {
  const move = (extra) => ({ ...valid(), records: { 'account.move': [{ id: 1, ...extra }] } });
  assert.throws(() => checkBackup(move({ invoice_line_ids: {} })), /Invalid account.move #1.*invoice_line_ids/);
  for (const model of ['constructor', 'toString', '__proto__']) assert.throws(() => checkBackup({ ...valid(), records: JSON.parse(`{"${model}":[]}`) }), /Unknown model/);
  assert.throws(() => checkBackup({ ...valid(), settings: { customFields: {} } }), /settings.customFields/);
  assert.throws(() => checkBackup({ ...valid(), settings: { companies: 'x' } }), /settings.companies/);
});

test('a very large model and a saved counter of an emptied model both restore', () => {
  const lines = Array.from({ length: 200_000 }, (_, i) => ({ id: i + 1, name: `L${i}` }));
  const big = checkBackup({ ...valid(), records: { 'crm.lead': lines }, seq: { 'crm.lead': 5, 'hr.employee': 42, nope: 9 } });
  assert.equal(big.seq['crm.lead'], 200_000);
  assert.equal(big.seq['hr.employee'], 42, 'counter kept although no employee is left');
  assert.equal('nope' in big.seq, false);
});

test('the summary counts rewritten records, messages and settings', () => {
  const now = seed();
  const next = checkBackup(JSON.parse(JSON.stringify({ ...now, settings: { ...now.settings, company: 'Other Co' }, messages: [] })));
  next.records['crm.lead'][0] = { ...next.records['crm.lead'][0], name: 'Rewritten' };
  const plan = backupSummary(now, next);
  assert.equal(plan.changed, 1);
  assert.equal(plan.removed + plan.added, 0);
  assert.equal(plan.settingsChanged, true);
  assert.deepEqual(plan.messages, { current: now.messages.length, restored: 0 });
});
