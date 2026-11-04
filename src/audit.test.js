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

test('credentials are redacted in create, update and delete entries, including inside lines', () => {
  const share = { id: 1, name: 'Share', token: 'live-token-1', signers: [{ role: 'signer', token: 'live-token-2' }] };
  const created = auditEntries(db([]), db([share]))[0];
  const deleted = auditEntries(db([share]), db([]))[0];
  const updated = auditEntries(db([share]), db([{ ...share, token: 'live-token-3' }]))[0];
  for (const e of [created, deleted, updated]) assert.ok(!JSON.stringify(e).includes('live-token'), JSON.stringify(e));
  assert.deepEqual(updated.changes, { token: ['[redacted]', '[redacted]'] });
  assert.equal(created.changes.signers[1][0].token, '[redacted]');
});

test('settings changes and chatter notes are logged', () => {
  const base = { records: {}, settings: { lock_date: null, company: 'A' }, messages: [{ id: 'n1', model: 'res.partner', res_id: 1, kind: 'note', body: 'old' }, { id: 't1', model: 'res.partner', res_id: 1, kind: 'tracking', body: 'x' }] };
  const next = { records: {}, settings: { lock_date: '2026-12-31', company: 'A' }, messages: [{ ...base.messages[0], body: 'new' }, { id: 'n2', model: 'res.partner', res_id: 2, kind: 'note', body: 'hello' }] };
  assert.deepEqual(auditEntries(base, next), [
    { model: 'settings', res_id: 0, action: 'write', changes: { lock_date: [null, '2026-12-31'] } },
    { model: 'mail.message', res_id: 1, action: 'write', changes: { thread: ['res.partner', 'res.partner'], body: ['old', 'new'] } },
    { model: 'mail.message', res_id: 2, action: 'create', changes: { thread: ['res.partner', 'res.partner'], body: [null, 'hello'] } },
  ]);
  assert.deepEqual(auditEntries(next, { ...next, messages: [] }).map((e) => e.action), ['delete', 'delete']);
});

test('audit summaries read as one line per entry', async () => {
  const { auditSummary } = await import('./audit.js');
  assert.equal(auditSummary({ action: 'create', changes: {} }), 'Created');
  assert.equal(auditSummary({ action: 'delete', changes: {} }), 'Deleted');
  assert.equal(auditSummary({ action: 'write', changes: { state: ['draft', 'posted'], ref: [null, 'PO-123'] } }), 'state: draft → posted, ref: — → PO-123');
});
