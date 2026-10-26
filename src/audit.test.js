import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditEntries } from './audit.js';

const db = (partners) => ({ records: { 'res.partner': partners } });

test('creates, writes and deletes are logged with old and new values per field', () => {
  const a = { id: 1, name: 'Acme', email: 'a@x' };
  const b = { id: 2, name: 'Beta' };
  const entries = auditEntries(db([a, b]), db([{ ...a, email: 'new@x' }, { id: 3, name: 'Gamma' }]));
  assert.deepEqual(entries, [
    { model: 'res.partner', res_id: 1, action: 'write', changes: { email: ['a@x', 'new@x'] } },
    { model: 'res.partner', res_id: 3, action: 'create', changes: { name: [null, 'Gamma'] } },
    { model: 'res.partner', res_id: 2, action: 'delete', changes: { name: ['Beta', null] } },
  ]);
});

test('a copied record with the same values is not logged', () => {
  const a = { id: 1, name: 'Acme', tags: [1, 2] };
  assert.deepEqual(auditEntries(db([a]), db([{ ...a, tags: [1, 2] }])), []);
  const same = db([a]);
  assert.deepEqual(auditEntries(same, { records: { ...same.records } }), []);
});
