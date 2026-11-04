import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { publicAnswer, publicAsk, publicBlogPost, publicBlogSite, publicForumThread, publicVote, voterKey, createVisitTracker, visitKey } from './blog.js';

const visitor = { name: 'Sara', email: 'sara@example.com', content: 'Which desk fits a small room?' };

test('unpublished posts are hidden from the site and the post page', () => {
  const db = write(seed(), 'blog.post', 1, { is_published: false });
  const site = publicBlogSite(db);
  assert.deepEqual(site.posts.map((p) => p.id), [2]);
  assert.ok(!('visits' in site.posts[0]) && !('content' in site.posts[0]));
  assert.equal(publicBlogPost(db, '1').status, 404);
  assert.equal(publicBlogPost(db, 'abc').status, 404);
  assert.ok(!JSON.stringify(site).includes('hala@example.com'), 'no visitor emails');
});

test('reading a post increments its visits and renders markdown', () => {
  const first = publicBlogPost(seed(), '1');
  assert.equal(first.status, 200);
  assert.ok(first.body.html.includes('<ul><li>'));
  assert.ok(first.body.html.includes('rel="noopener noreferrer"'));
  const second = publicBlogPost(first.db, '1');
  assert.equal(read(second.db, 'blog.post', 1).visits, 2);
});

test('a pending question is hidden until validated, the author gets a moderation message', () => {
  const out = publicAsk(seed(), { ...visitor, forum_id: 1, title: 'Small room desk?' });
  assert.equal(out.status, 201);
  assert.match(out.body.message, /awaits moderation/);
  const id = 3;
  assert.equal(read(out.db, 'forum.post', id).state, 'pending');
  assert.equal(publicForumThread(out.db, String(id)).status, 404);
  assert.ok(!publicBlogSite(out.db).forums[0].threads.some((t) => t.id === id));
  const live = write(out.db, 'forum.post', id, { state: 'active' });
  assert.equal(publicForumThread(live, String(id)).status, 200);
  const answered = publicAnswer(live, { ...visitor, question_id: id });
  assert.equal(answered.status, 201);
  assert.deepEqual(publicForumThread(answered.db, String(id)).body.answers, [], 'pending answers are hidden');
});

test('titles, texts and emails are checked', () => {
  const db = seed();
  assert.equal(publicAsk(db, { ...visitor, forum_id: 1, title: 'x'.repeat(201) }).status, 400);
  assert.equal(publicAsk(db, { ...visitor, forum_id: 1, title: 'x'.repeat(200) }).status, 201);
  assert.equal(publicAsk(db, { ...visitor, forum_id: 1, title: 'Ok', content: 'x'.repeat(5001) }).status, 400);
  assert.equal(publicAnswer(db, { ...visitor, question_id: 1, content: 'x'.repeat(5001) }).status, 400);
  assert.equal(publicAsk(db, { ...visitor, forum_id: 1, title: 'Ok', email: 'not-an-email' }).status, 400);
  assert.equal(publicAsk(db, { ...visitor, forum_id: 99, title: 'Ok' }).status, 400);
});

test('votes count once per voter key (IP + post)', () => {
  const once = publicVote(seed(), { post_id: 1, delta: 1 }, '10.0.0.1');
  assert.equal(once.status, 200);
  assert.equal(once.body.votes, 3);
  assert.equal(publicVote(once.db, { post_id: 1, delta: -1 }, '10.0.0.1').status, 400);
  assert.equal(publicVote(once.db, { post_id: 1, delta: 1 }, '10.0.0.2').body.votes, 4);
  assert.equal(publicVote(once.db, { post_id: 2, delta: 1 }, '10.0.0.1').status, 200, 'another post is another key');
  assert.notEqual(voterKey('10.0.0.1', 1), voterKey('10.0.0.1', 2));
  assert.ok(!read(once.db, 'forum.post', 1).voter_keys.includes('10.0.0.1'), 'no raw IP stored');
});

test('a repeated read within the hour reports the stored visit count and saves nothing', () => {
  const first = publicBlogPost(seed(), '1');
  const again = publicBlogPost(first.db, '1', { count: false });
  assert.equal(again.db, undefined);
  assert.equal(again.body.visits, first.body.visits);
  assert.equal(publicForumThread(seed(), '1', { count: false }).db, undefined);
});

test('visitor keys use the numeric id and are remembered only after mark()', () => {
  assert.equal(visitKey('1.2.3.4', 'blog', '01'), visitKey('1.2.3.4', 'blog', '1'));
  assert.notEqual(visitKey('1.2.3.4', 'blog', '1'), visitKey('1.2.3.4', 'forum', '1'));
  const t = createVisitTracker();
  assert.equal(t.seen('k'), false);
  assert.equal(t.seen('k'), false, 'checking does not remember (a failed save can be retried)');
  t.mark('k');
  assert.equal(t.seen('k'), true);
});

test('the visitor map stays bounded and expires old entries', () => {
  const t = createVisitTracker({ max: 5, window: 1000 });
  for (let i = 0; i < 50; i++) t.mark(`k${i}`, 100 + i);
  assert.ok(t.size() <= 5);
  assert.equal(t.seen('k49', 150), true);
  assert.equal(t.seen('k0', 150), false);
  assert.equal(t.seen('k49', 2000), false);
});
