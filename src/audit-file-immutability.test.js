import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

test('completed working files reject evidence edits and reopen separately', () => {
  const made = create(seed(), 'account.return', {
    name: 'Audit', audit_status: 'ongoing', company_id: 1,
    date_from: '2026-01-01', date_to: '2026-12-31',
    checks: [{ name: 'Evidence', status: 'passed', message: 'Original' }],
  });
  const markDone = models['account.return'].form.buttons.find((button) => button.label === 'Mark as Done');
  const done = markDone.run(made.db, read(made.db, 'account.return', made.id)).db;
  const original = read(done, 'account.return', made.id);
  const edits = [
    { checks: [{ name: 'Evidence', status: 'failed', message: 'Changed' }] },
    { attachment_ids: [1] },
    { date_deadline: '2027-01-01' },
    { audit_status: 'ongoing', checks: [] },
    { audit_status: 'paused' },
  ];
  for (const edit of edits) {
    assert.throws(() => write(done, 'account.return', made.id, edit), /Done audit files cannot be modified/);
  }
  const forged = { ...done, records: { ...done.records, 'account.return': done.records['account.return'].map((record) => (
    record.id === made.id ? { ...record, checks: [] } : record
  )) } };
  assert.throws(() => applyDiff(done, diffDb(done, forged), { isAdmin: true }), /Done audit files cannot be modified/);
  assert.deepEqual(read(done, 'account.return', made.id), original);
  const reset = models['account.return'].form.buttons.find((button) => button.label === 'Reset to Draft');
  assert.equal(reset.when(original, done), true);
  const reopened = reset.run(done, original).db;
  assert.equal(read(reopened, 'account.return', made.id).audit_status, 'ongoing');
  const synced = applyDiff(done, diffDb(done, reopened), { isAdmin: true });
  assert.equal(read(synced, 'account.return', made.id).audit_status, 'ongoing');
  const edited = write(reopened, 'account.return', made.id, { checks: [] });
  assert.deepEqual(read(edited, 'account.return', made.id).checks, []);
});
