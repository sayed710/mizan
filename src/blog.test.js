import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search, write } from './orm.js';
import { acceptAnswer, askQuestion, forumThreads, postAnswer, publishedPosts, renderMarkdown, vote } from './models/blog.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const visitor = { author_name: 'Sara', author_email: 'sara@example.com', content: 'Does the desk fit a 2 m room?' };
const validate = (db, id) => write(db, 'forum.post', id, { state: 'active' });

test('renderMarkdown escapes raw HTML and XSS payloads', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> "quoted" & \'single\'');
  assert.ok(!html.includes('<script') && !html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;quoted&quot; &amp; &#39;single&#39;'));
  assert.ok(!/<a /.test(renderMarkdown('[x](javascript:alert(1)) [y](data:text/html,hi) [z](//evil.example)')));
  assert.equal(renderMarkdown('[a](https://x.example/?q="><b>)'), '<p><a href="https://x.example/?q=&quot;&gt;&lt;b&gt;" rel="noopener noreferrer">a</a></p>');
  assert.ok(!renderMarkdown('**<b onclick=x>**').includes('<b '));
});

test('renderMarkdown renders headings, emphasis, lists and safe links', () => {
  assert.equal(renderMarkdown('# Title'), '<h2>Title</h2>');
  assert.equal(renderMarkdown('**bold** and *it*'), '<p><strong>bold</strong> and <em>it</em></p>');
  assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(renderMarkdown('[site](https://a.example/*x*) [mail](mailto:a@b.example)'),
    '<p><a href="https://a.example/*x*" rel="noopener noreferrer">site</a> <a href="mailto:a@b.example" rel="noopener noreferrer">mail</a></p>');
  assert.equal(renderMarkdown('[bad](javascript:void0)'), '<p>bad</p>');
  assert.equal(renderMarkdown('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
});

test('publishedPosts hides unpublished posts and filters by blog, tag and search', () => {
  const db = seed();
  assert.equal(publishedPosts(db).length, 2);
  assert.equal(publishedPosts(db)[0].name, 'Standing desks: our new collection', 'newest first');
  assert.deepEqual(publishedPosts(db, { tag: 'Ergonomics' }).map((p) => p.name), ['Setting up an ergonomic office']);
  assert.deepEqual(publishedPosts(db, { search: 'ALUMINIUM' }).map((p) => p.name), ['Standing desks: our new collection']);
  assert.equal(publishedPosts(db, { blogId: 99 }).length, 0);
  const hidden = write(db, 'blog.post', 1, { is_published: false });
  assert.deepEqual(publishedPosts(hidden).map((p) => p.id), [2]);
  const archived = write(db, 'blog.blog', 1, { active: false });
  assert.equal(publishedPosts(archived).length, 0);
});

test('Publish stamps the date; Unpublish hides the post', () => {
  const db = write(seed(), 'blog.post', 1, { is_published: false, published_date: null });
  const publish = models['blog.post'].form.buttons.find((b) => b.label === 'Publish');
  const post = read(publish.run(db, read(db, 'blog.post', 1)).db, 'blog.post', 1);
  assert.equal(post.is_published, true);
  assert.match(post.published_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('visitor questions and answers stay pending until validated', () => {
  const db = seed();
  const asked = askQuestion(db, { ...visitor, forumId: 1, name: 'Room size?' });
  assert.equal(read(asked.db, 'forum.post', asked.id).state, 'pending');
  assert.ok(!forumThreads(asked.db, 1).some((t) => t.id === asked.id));
  assert.throws(() => postAnswer(asked.db, asked.id, visitor), /not open/);
  const live = validate(asked.db, asked.id);
  assert.ok(forumThreads(live, 1).some((t) => t.id === asked.id));
  const answered = postAnswer(live, asked.id, visitor);
  assert.equal(read(answered.db, 'forum.post', answered.id).state, 'pending');
  assert.equal(forumThreads(answered.db, 1, { sort: 'unanswered' })[0].id, asked.id, 'a pending answer does not count');
  const done = validate(answered.db, answered.id);
  assert.ok(!forumThreads(done, 1, { sort: 'unanswered' }).some((t) => t.id === asked.id));
});

test('forumThreads sorts by votes', () => {
  const asked = askQuestion(seed(), { ...visitor, forumId: 1, name: 'Second' });
  const db = validate(asked.db, asked.id);
  assert.deepEqual(forumThreads(db, 1).map((t) => t.id), [asked.id, 1]);
  assert.deepEqual(forumThreads(db, 1, { sort: 'votes' }).map((t) => t.id), [1, asked.id]);
  assert.equal(forumThreads(db, 1)[1].has_accepted, true);
});

test('only one answer per question is accepted', () => {
  const db = seed();
  const other = postAnswer(db, 1, visitor);
  const live = validate(other.db, other.id);
  const next = acceptAnswer(live, other.id);
  const accepted = search(next, 'forum.post').filter((p) => p.parent_id === 1 && p.accepted).map((p) => p.id);
  assert.deepEqual(accepted, [other.id]);
  assert.throws(() => acceptAnswer(next, 1), /Only answers/);
  assert.throws(() => acceptAnswer(other.db, other.id), /Validate/);
  const button = models['forum.post'].form.buttons.find((b) => b.label === 'Accept Answer');
  assert.equal(read(button.run(next, read(next, 'forum.post', 2)).db, 'forum.post', 2).accepted, true);
});

test('vote counts once per voter key', () => {
  const db = vote(seed(), 1, 1, 'key-a');
  assert.equal(read(db, 'forum.post', 1).votes, 3);
  assert.throws(() => vote(db, 1, -1, 'key-a'), /already voted/);
  assert.equal(read(vote(db, 1, -1, 'key-b'), 'forum.post', 1).votes, 2);
  assert.throws(() => vote(db, 1, 5, 'key-c'), /\+1 or -1/);
  let many = db;
  for (let i = 0; i < 60; i += 1) many = vote(many, 1, 1, `k${i}`);
  assert.equal(read(many, 'forum.post', 1).voter_keys.length, 50, 'the stored list is capped');
});
