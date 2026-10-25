import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { postAccounts, postProblems, publishDue, publishPost, recordEngagement, schedulePost } from './models/social.js';
import { seed } from './seed.js';

const withAccounts = () => {
  const db = seed();
  return { db, ids: Object.fromEntries(search(db, 'social.account').map((a) => [a.media, a.id])) };
};

test('posts target their account lines, or the accounts of their legacy network tags', () => {
  const { db, ids } = withAccounts();
  assert.deepEqual(postAccounts(db, { account_ids: [{ account_id: ids.x }] }).map((a) => a.id), [ids.x]);
  assert.deepEqual(postAccounts(db, { accounts: ['LinkedIn'] }).map((a) => a.id), [ids.linkedin]);
});

test('publishing checks message, accounts and per-network length, then creates one live post per account', () => {
  const { db, ids } = withAccounts();
  const long = create(db, 'social.post', { name: 'Long', message: 'x'.repeat(300), account_ids: [{ account_id: ids.x }, { account_id: ids.facebook }], stage_id: 'draft' });
  assert.deepEqual(postProblems(long.db, read(long.db, 'social.post', long.id)), ['The message is too long for X (280 characters)']);
  assert.throws(() => publishPost(long.db, read(long.db, 'social.post', long.id)), /too long for X/);
  const ok = create(db, 'social.post', { name: 'Hi', message: 'Hello!', account_ids: [{ account_id: ids.x }, { account_id: ids.facebook }], stage_id: 'draft' });
  const posted = read(publishPost(ok.db, read(ok.db, 'social.post', ok.id), '2026-07-01'), 'social.post', ok.id);
  assert.equal(posted.stage_id, 'posted');
  assert.deepEqual(posted.live_post_ids.map((l) => l.media), ['facebook', 'x']);
  assert.throws(() => publishPost(ok.db, posted), /already published/);
});

test('scheduled posts go out when due; engagement only grows and sums over live posts', () => {
  const { db, ids } = withAccounts();
  const p = create(db, 'social.post', { name: 'Promo', message: 'Sale', account_ids: [{ account_id: ids.facebook }, { account_id: ids.linkedin }], stage_id: 'draft' });
  const scheduled = schedulePost(p.db, read(p.db, 'social.post', p.id), '2999-01-01');
  assert.equal(read(publishDue(scheduled, '2998-12-31'), 'social.post', p.id).stage_id, 'scheduled');
  const out = publishDue(scheduled, '2999-01-01');
  const counted = recordEngagement(recordEngagement(out, p.id, ids.facebook, { likes: 10, shares: 2 }), p.id, ids.linkedin, { likes: 5 });
  const lower = recordEngagement(counted, p.id, ids.facebook, { likes: 3 });
  const post = read(lower, 'social.post', p.id);
  assert.equal(post.likes, 15);
  assert.equal(post.shares, 2);
  assert.throws(() => schedulePost(p.db, read(p.db, 'social.post', p.id), '2000-01-01'), /today onwards/);
});

test('seeded posts keep their stored likes', () => {
  const posted = search(seed(), 'social.post').find((x) => x.name === 'New desk launch');
  assert.equal(posted.likes, 128);
});
