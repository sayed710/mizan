import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { processDue, recordEvent, startCampaign, stepStats, syncParticipants } from './models/automation.js';
import { seed } from './seed.js';

const steps = [
  { action: 'email', detail: 'Welcome', trigger: 'begin', delay_days: 0 },
  { action: 'email', detail: 'Tips', parent: 1, trigger: 'act', delay_days: 3 },
  { action: 'sms', detail: 'Did you see it?', parent: 1, trigger: 'mail_not_open', delay_days: 2 },
  { action: 'tag', detail: 'Engaged', parent: 1, trigger: 'mail_click', delay_days: 0 },
];
const launch = (s = steps) => {
  const { db, id } = create(seed(), 'marketing.campaign', { name: 'Onboarding', list_id: 1, steps: s, stage_id: 'draft' });
  return { db: startCampaign(db, read(db, 'marketing.campaign', id), '2026-01-01'), id };
};
const participants = (db, id) => search(db, 'marketing.participant').filter((p) => p.campaign_id === id);

test('starting enrols subscribed contacts with the beginning activity scheduled', () => {
  const { db, id } = launch();
  const ps = participants(db, id);
  assert.equal(ps.length, 2);
  assert.equal(read(db, 'marketing.campaign', id).participants, 2);
  assert.deepEqual(ps[0].traces, [{ step: 0, state: 'scheduled', scheduled_date: '2026-01-01' }]);
});

test('workflow validation: a beginning activity, parents, email parents for email triggers', () => {
  const run = (s) => () => launch(s);
  assert.throws(run([{ action: 'email', trigger: 'act', parent: 2 }, { action: 'email', trigger: 'act', parent: 1 }]), /beginning/);
  assert.throws(run([{ action: 'wait', trigger: 'begin' }, { action: 'email', trigger: 'mail_open', parent: 1 }]), /must send one/);
});

test('processing follows delays; not-opened fires only without an open; a click schedules its branch', () => {
  const { db, id } = launch();
  const day0 = processDue(db, '2026-01-01');
  const [a, b] = participants(day0, id);
  assert.deepEqual(a.traces.map((t) => [t.step, t.state, t.scheduled_date]), [[0, 'processed', '2026-01-01'], [1, 'scheduled', '2026-01-04'], [2, 'scheduled', '2026-01-03']]);
  const clicked = recordEvent(day0, a.id, 0, 'click', '2026-01-02');
  const day4 = processDue(clicked, '2026-01-04');
  const pa = read(day4, 'marketing.participant', a.id);
  assert.equal(pa.traces.find((t) => t.step === 2).state, 'rejected');
  assert.equal(pa.traces.find((t) => t.step === 3).state, 'processed');
  assert.equal(pa.state, 'completed');
  const pb = read(day4, 'marketing.participant', b.id);
  assert.equal(pb.traces.find((t) => t.step === 2).state, 'processed');
  assert.equal(pb.traces.some((t) => t.step === 3), false);
  assert.deepEqual(stepStats(day4, read(day4, 'marketing.campaign', id)).map((s) => [s.processed, s.rejected]), [[2, 0], [2, 0], [1, 1], [1, 0]]);
  assert.equal(recordEvent(day4, a.id, 0, 'click'), day4);
});

test('legacy linear campaigns and new contacts joining later', () => {
  const legacy = search(seed(), 'marketing.campaign').find((c) => c.name === 'Welcome series');
  const started = startCampaign(seed(), legacy, '2026-02-01');
  const done = processDue(started, '2026-02-10');
  assert.ok(participants(done, legacy.id).every((p) => p.state === 'completed'));
  const joined = create(done, 'mailing.contact', { name: 'New', email: 'new@x.example', list_id: 1 }).db;
  const synced = syncParticipants(joined, read(joined, 'marketing.campaign', legacy.id), '2026-02-11');
  assert.equal(participants(synced, legacy.id).length, 3);
});
