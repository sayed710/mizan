// Public Blog and Forum endpoints: published posts, moderated visitor questions/answers and per-client votes.
import { createHash } from 'node:crypto';
import { read, search, write } from '../src/orm.js';
import { askQuestion, excerpt, forumThreads, postAnswer, publishedPosts, renderMarkdown, vote } from '../src/models/blog.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { EMAIL, safeImage } from './api.js';

const MAX_TEXT = 5000;
const MAX_TITLE = 200;
const MAX_NAME = 120;
const MODERATION = 'Your post awaits moderation';

const bodyOf = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
const commit = (db, next) => applyDiff(db, diffDb(db, next), { author: 'Website', isAdmin: false });
const authorName = (db, id) => read(db, 'hr.employee', id)?.name ?? '';

const postSummary = (db, p) => ({
  id: p.id, blog_id: p.blog_id, name: p.name, subtitle: p.subtitle ?? '', author: authorName(db, p.author_id),
  published_date: p.published_date ?? '', tag_ids: p.tag_ids ?? [], cover: safeImage(p.cover), excerpt: excerpt(p.content),
});

const threadSummary = (t) => ({
  id: t.id, name: t.name, author_name: t.author_name ?? '', tag_ids: t.tag_ids ?? [], votes: t.votes, views: t.views ?? 0,
  answers: t.answers, has_accepted: t.has_accepted, state: t.state,
});

/** Blog and forum data for GET /api/public/site: published posts only, active threads only, no emails or voter keys. */
export const publicBlogSite = (db) => ({
  blogs: search(db, 'blog.blog').map((b) => ({ id: b.id, name: b.name, subtitle: b.subtitle ?? '' })),
  posts: publishedPosts(db).map((p) => postSummary(db, p)),
  forums: search(db, 'forum.forum').map((f) => ({
    id: f.id, name: f.name, description: f.description ?? '', mode: f.mode, threads: forumThreads(db, f.id).map(threadSummary),
  })),
});

const idOf = (raw) => (/^\d{1,9}$/.test(String(raw)) ? Number(raw) : null);

/** GET /api/public/blog/<id>: a published post with rendered content; counts the visit. */
export function publicBlogPost(db, rawId) {
  const id = idOf(rawId);
  const post = id && publishedPosts(db).find((p) => p.id === id);
  if (!post) return { status: 404, body: { error: 'Post not found' } };
  const saved = commit(db, write(db, 'blog.post', id, { visits: (post.visits ?? 0) + 1 }));
  return {
    status: 200,
    body: { ...postSummary(db, post), html: renderMarkdown(post.content), meta_description: post.website_meta_description ?? '', visits: (post.visits ?? 0) + 1 },
    db: saved,
  };
}

const publicForumPost = (p) => ({
  id: p.id, name: p.name, html: renderMarkdown(p.content), author_name: p.author_name ?? '', tag_ids: p.tag_ids ?? [],
  votes: p.votes ?? 0, accepted: !!p.accepted,
});

/** GET /api/public/forum/<id>: a validated question with its active answers; counts the view. */
export function publicForumThread(db, rawId) {
  const id = idOf(rawId);
  const question = id && read(db, 'forum.post', id);
  if (!question || question.parent_id || question.state === 'pending') return { status: 404, body: { error: 'Post not found' } };
  const forum = read(db, 'forum.forum', question.forum_id);
  const answers = search(db, 'forum.post').filter((p) => p.parent_id === id && p.state === 'active')
    .sort((a, b) => Number(!!b.accepted) - Number(!!a.accepted) || (b.votes ?? 0) - (a.votes ?? 0) || a.id - b.id);
  const saved = commit(db, write(db, 'forum.post', id, { views: (question.views ?? 0) + 1 }));
  return {
    status: 200,
    body: { ...publicForumPost(question), forum: { id: forum?.id, name: forum?.name ?? '', mode: forum?.mode }, closed: question.state === 'closed', answers: answers.map(publicForumPost) },
    db: saved,
  };
}

/** Visitor fields shared by questions and answers; returns { error } when a limit or the email check fails. */
function visitorFields(db, b) {
  const author_name = String(b.name ?? '').trim();
  const author_email = String(b.email ?? '').trim();
  const content = String(b.content ?? '').trim();
  if (!author_name || author_name.length > MAX_NAME) return { error: 'Enter your name' };
  if (author_email.length > 254 || !EMAIL.test(author_email)) return { error: 'Enter a valid email address' };
  if (!content) return { error: 'Write your message' };
  if (content.length > MAX_TEXT) return { error: 'Your message is too long (5000 characters at most)' };
  const partner = search(db, 'res.partner').find((p) => p.email?.toLowerCase() === author_email.toLowerCase());
  return { vals: { author_name, author_email, content, partner_id: partner?.id ?? null } };
}

/** Run a visitor create; refused input becomes a 400 with its message. */
function moderated(db, build) {
  try {
    return { status: 201, body: { ok: true, message: MODERATION }, db: commit(db, build().db) };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}

/** POST /api/public/forum/ask: a new question, pending until a backend user validates it. */
export function publicAsk(db, body) {
  const b = bodyOf(body);
  const name = String(b.title ?? '').trim();
  if (!name) return { status: 400, body: { error: 'Enter a title' } };
  if (name.length > MAX_TITLE) return { status: 400, body: { error: 'The title is too long (200 characters at most)' } };
  const forum = search(db, 'forum.forum').find((f) => f.id === b.forum_id);
  if (!forum) return { status: 400, body: { error: 'Unknown forum' } };
  const { vals, error } = visitorFields(db, b);
  if (error) return { status: 400, body: { error } };
  const tags = Array.isArray(b.tags) ? b.tags.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 50)).filter(Boolean).slice(0, 5) : [];
  return moderated(db, () => askQuestion(db, { ...vals, forumId: forum.id, name, tag_ids: tags }));
}

/** POST /api/public/forum/answer: an answer to an active question, pending until validated. */
export function publicAnswer(db, body) {
  const b = bodyOf(body);
  const { vals, error } = visitorFields(db, b);
  if (error) return { status: 400, body: { error } };
  return moderated(db, () => postAnswer(db, b.question_id, vals));
}

/** One key per client and post (SHA-256 of IP + post), so the stored list never holds an IP. */
export const voterKey = (ip, postId) => createHash('sha256').update(`${ip}|${postId}`).digest('hex').slice(0, 32);

/** POST /api/public/forum/vote: { post_id, delta: 1 | -1 }, once per client. */
export function publicVote(db, body, ip) {
  const b = bodyOf(body);
  try {
    const next = vote(db, b.post_id, b.delta, voterKey(ip, b.post_id));
    const saved = commit(db, next);
    return { status: 200, body: { votes: read(saved, 'forum.post', b.post_id).votes }, db: saved };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}
