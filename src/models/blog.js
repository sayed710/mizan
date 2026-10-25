// Website Blog and Forum: blog posts with a small safe markdown, and a moderated Q&A forum with votes.
import { create, read, search, write } from '../orm.js';
import { today } from './common.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Bold, italic and links inside one (already escaped) line; link URLs are kept out of the emphasis pass. */
function inline(text) {
  const links = [];
  const held = text.replace(LINK, (_, label, url) => {
    links.push(SAFE_URL.test(url) ? `<a href="${url}" rel="noopener noreferrer">${label}</a>` : label);
    return `\u0000${links.length - 1}\u0000`;
  });
  return held
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
}

/**
 * Markdown subset to HTML: # headings, **bold**, *italic*, [link](url), - lists and paragraphs.
 * Everything is escaped first, so no raw HTML gets through; links are http(s)/mailto only.
 */
export function renderMarkdown(text) {
  const blocks = escapeHtml(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const heading = /^(#{1,3}) (.+)$/.exec(block);
    if (heading && !block.includes('\n')) return `<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`;
    const lines = block.split('\n');
    if (lines.every((l) => /^- /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

/** Plain-text start of a markdown post (for listings). */
export const excerpt = (text, max = 200) => String(text ?? '').replace(/[#*[\]]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Posts (records or public summaries) of one blog, with a tag, matching a search; newest first. */
export function filterPosts(posts, { blogId = null, tag = '', search: q = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return posts
    .filter((p) => (!blogId || p.blog_id === blogId) && (!tag || (p.tag_ids ?? []).includes(tag)))
    .filter((p) => !needle || [p.name, p.subtitle, p.content ?? p.excerpt].some((v) => String(v ?? '').toLowerCase().includes(needle)))
    .sort((a, b) => String(b.published_date ?? '').localeCompare(String(a.published_date ?? '')) || b.id - a.id);
}

/** Published posts of active blogs, filtered by blog, tag and search. */
export function publishedPosts(db, options = {}) {
  const blogs = new Set(search(db, 'blog.blog').map((b) => b.id));
  return filterPosts(search(db, 'blog.post').filter((p) => p.is_published && blogs.has(p.blog_id)), options);
}

const activeAnswers = (db, questionId) => search(db, 'forum.post').filter((p) => p.parent_id === questionId && p.state === 'active');

/** Thread summaries sorted 'newest' | 'votes' | 'unanswered' (the last keeps only questions without answers). */
export function sortThreads(threads, sort = 'newest') {
  const list = sort === 'unanswered' ? threads.filter((t) => !t.answers) : [...threads];
  return list.sort((a, b) => (sort === 'votes' ? b.votes - a.votes : 0) || b.id - a.id);
}

/** Active questions of a forum with their answer count and accepted flag. */
export function forumThreads(db, forumId, { sort = 'newest' } = {}) {
  const threads = search(db, 'forum.post').filter((p) => p.forum_id === forumId && !p.parent_id && p.state !== 'pending').map((p) => {
    const answers = activeAnswers(db, p.id);
    return { ...p, votes: p.votes ?? 0, answers: answers.length, has_accepted: answers.some((a) => a.accepted) };
  });
  return sortThreads(threads, sort);
}

const visitorPost = (vals) => ({ ...vals, state: 'pending', votes: 0, accepted: false, views: 0, voter_keys: [] });

/** A visitor question: waits as 'pending' until validated in the backend. @returns {{ db: object, id: number }} */
export function askQuestion(db, { forumId, name, content, author_name, author_email, partner_id = null, tag_ids = [] }) {
  if (!read(db, 'forum.forum', forumId)) throw new Error('Unknown forum');
  return create(db, 'forum.post', visitorPost({ forum_id: forumId, name, content, author_name, author_email, partner_id, tag_ids }));
}

/** A visitor answer to an active question: waits as 'pending' until validated. @returns {{ db: object, id: number }} */
export function postAnswer(db, questionId, { content, author_name, author_email, partner_id = null }) {
  const question = read(db, 'forum.post', questionId);
  if (!question || question.parent_id || question.state !== 'active') throw new Error('This question is not open for answers');
  return create(db, 'forum.post', visitorPost({ forum_id: question.forum_id, parent_id: question.id, name: `Re: ${question.name}`, content, author_name, author_email, partner_id }));
}

// ponytail: keeps the last 50 voter keys per post (tags field cap); a counter table if posts get more voters than that.
const MAX_VOTER_KEYS = 50;

/** Up- or down-vote (delta ±1) once per voter key; a second vote from the same key is refused. */
export function vote(db, postId, delta, voterKey) {
  const post = read(db, 'forum.post', postId);
  if (!post || post.state !== 'active') throw new Error('This post cannot be voted on');
  if (delta !== 1 && delta !== -1) throw new Error('A vote is +1 or -1');
  const keys = post.voter_keys ?? [];
  if (keys.includes(voterKey)) throw new Error('You already voted on this post');
  return write(db, 'forum.post', postId, { votes: (post.votes ?? 0) + delta, voter_keys: [...keys, voterKey].slice(-MAX_VOTER_KEYS) });
}

/** Mark an answer as the accepted one; any other accepted answer of the same question is un-accepted. */
export function acceptAnswer(db, answerId) {
  const answer = read(db, 'forum.post', answerId);
  if (!answer?.parent_id) throw new Error('Only answers can be accepted');
  if (answer.state !== 'active') throw new Error('Validate the answer first');
  if (read(db, 'forum.forum', answer.forum_id)?.mode === 'discussions') throw new Error('Discussions have no accepted answer');
  const others = search(db, 'forum.post').filter((p) => p.parent_id === answer.parent_id && p.accepted && p.id !== answerId);
  return write(others.reduce((acc, p) => write(acc, 'forum.post', p.id, { accepted: false }), db), 'forum.post', answerId, { accepted: true });
}

const STATES = [['pending', 'Waiting validation'], ['active', 'Active'], ['closed', 'Closed']];

export const blogModels = {
  'blog.blog': {
    label: 'Blogs',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      subtitle: { type: 'char', label: 'Subtitle' },
    },
    defaults: () => ({ active: true }),
    kanban: { title: 'name', lines: ['subtitle'] },
    list: ['name', 'subtitle'],
    form: { title: 'name', groups: [['subtitle'], []] },
  },

  'blog.post': {
    label: 'Blog Posts',
    fields: {
      blog_id: { type: 'many2one', relation: 'blog.blog', label: 'Blog', required: true },
      name: { type: 'char', label: 'Title', required: true },
      subtitle: { type: 'char', label: 'Subtitle' },
      author_id: { type: 'many2one', relation: 'hr.employee', label: 'Author' },
      content: { type: 'text', label: 'Content' },
      cover: { type: 'binary', label: 'Cover Image' },
      tag_ids: { type: 'tags', label: 'Tags' },
      is_published: { type: 'boolean', label: 'Published', readonly: true },
      published_date: { type: 'date', label: 'Published On' },
      visits: { type: 'integer', label: 'Visits', readonly: true },
      website_meta_description: { type: 'char', label: 'Meta Description' },
    },
    defaults: () => ({ is_published: false, visits: 0, tag_ids: [] }),
    filters: [[{ id: 'published', label: 'Published', fn: (r) => r.is_published }, { id: 'draft', label: 'Not Published', fn: (r) => !r.is_published }]],
    kanban: { title: 'name', lines: ['blog_id', 'author_id', 'published_date'] },
    list: ['name', 'blog_id', 'author_id', 'published_date', 'is_published', 'visits'],
    form: {
      title: 'name',
      buttons: [
        { label: 'Publish', primary: true, when: (r) => !r.is_published, run: (db, r) => ({ db: write(db, 'blog.post', r.id, { is_published: true, published_date: r.published_date || today() }) }) },
        { label: 'Unpublish', vals: { is_published: false }, when: (r) => r.is_published },
      ],
      groups: [['blog_id', 'subtitle', 'author_id', 'tag_ids'], ['is_published', 'published_date', 'visits', 'cover']],
      tabs: [{ label: 'Content', fields: ['content'] }, { label: 'SEO', fields: ['website_meta_description'] }],
    },
  },

  'forum.forum': {
    label: 'Forums',
    fields: {
      name: { type: 'char', label: 'Name', required: true },
      description: { type: 'text', label: 'Description' },
      mode: { type: 'selection', label: 'Mode', options: [['questions', 'Questions (one answer accepted)'], ['discussions', 'Discussions']] },
    },
    defaults: () => ({ mode: 'questions' }),
    kanban: { title: 'name', lines: ['mode'] },
    list: ['name', 'mode'],
    form: { title: 'name', groups: [['mode'], []], tabs: [{ label: 'Description', fields: ['description'] }] },
  },

  'forum.post': {
    label: 'Forum Posts',
    fields: {
      forum_id: { type: 'many2one', relation: 'forum.forum', label: 'Forum', required: true },
      name: { type: 'char', label: 'Title', required: true },
      content: { type: 'text', label: 'Content' },
      author_name: { type: 'char', label: 'Author Name' },
      author_email: { type: 'char', label: 'Author Email' },
      partner_id: { type: 'many2one', relation: 'res.partner', label: 'Contact' },
      tag_ids: { type: 'tags', label: 'Tags' },
      state: { type: 'selection', label: 'Status', tracking: true, options: STATES },
      parent_id: { type: 'many2one', relation: 'forum.post', label: 'Question' },
      votes: { type: 'integer', label: 'Votes', readonly: true },
      accepted: { type: 'boolean', label: 'Accepted Answer', readonly: true },
      views: { type: 'integer', label: 'Views', readonly: true },
      voter_keys: { type: 'tags', label: 'Voter Keys', readonly: true, hidden: true },
    },
    defaults: () => ({ state: 'pending', votes: 0, accepted: false, views: 0, tag_ids: [], voter_keys: [] }),
    filters: [[
      { id: 'pending', label: 'Waiting validation', fn: (r) => r.state === 'pending' },
      { id: 'questions', label: 'Questions', fn: (r) => !r.parent_id },
      { id: 'answers', label: 'Answers', fn: (r) => !!r.parent_id },
    ]],
    kanban: { title: 'name', lines: ['forum_id', 'author_name', 'votes'], badge: 'state' },
    list: ['name', 'forum_id', 'parent_id', 'author_name', 'votes', 'accepted', 'state'],
    form: {
      title: 'name',
      buttons: [
        { label: 'Validate', primary: true, vals: { state: 'active' }, when: (r) => r.state === 'pending' },
        { label: 'Close', vals: { state: 'closed' }, when: (r) => r.state === 'active' && !r.parent_id },
        { label: 'Accept Answer', when: (r) => !!r.parent_id && r.state === 'active' && !r.accepted, run: (db, r) => ({ db: acceptAnswer(db, r.id) }) },
      ],
      statusbar: 'state',
      groups: [['forum_id', 'parent_id', 'tag_ids'], ['author_name', 'author_email', 'partner_id', 'votes', 'accepted', 'views']],
      tabs: [{ label: 'Content', fields: ['content'] }],
    },
  },
};
