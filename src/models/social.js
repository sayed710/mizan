// Social Marketing: connected accounts per network, posts published per account (now or scheduled), engagement per live post.
import { search, write } from '../orm.js';
import { addDays, today } from './common.js';

/** Networks and the longest message each accepts. */
export const MEDIA = { facebook: ['Facebook', 63206], instagram: ['Instagram', 2200], linkedin: ['LinkedIn', 3000], x: ['X', 280], youtube: ['YouTube', 5000] };
const MEDIA_OPTIONS = Object.entries(MEDIA).map(([k, [label]]) => [k, label]);
// Older posts name their accounts by network label in a tags field.
const mediaOfLabel = (label) => Object.entries(MEDIA).find(([, [l]]) => l.toLowerCase() === String(label).toLowerCase())?.[0];

/** The accounts a post targets: its account lines, else accounts matching its legacy network tags. */
export function postAccounts(db, post) {
  const accounts = search(db, 'social.account').filter((a) => a.active !== false);
  const ids = (post.account_ids ?? []).map((l) => l.account_id).filter(Boolean);
  if (ids.length) return accounts.filter((a) => ids.includes(a.id));
  const media = (post.accounts ?? []).map(mediaOfLabel).filter(Boolean);
  return accounts.filter((a) => media.includes(a.media));
}

/** Problems that block publishing: no message, no account, or a message too long for one of the networks. */
export function postProblems(db, post) {
  const message = String(post.message ?? '').trim();
  const accounts = postAccounts(db, post);
  return [
    ...(!message ? ['Write a message'] : []),
    ...(!accounts.length ? ['Choose at least one account'] : []),
    ...accounts.filter((a) => [...message].length > MEDIA[a.media][1]).map((a) => `The message is too long for ${MEDIA[a.media][0]} (${MEDIA[a.media][1]} characters)`),
  ];
}

/** Publish to every target account: one live post per account; the post is 'posted' once all are out. */
export function publishPost(db, post, at = today()) {
  if (post.stage_id === 'posted') throw new Error('This post is already published');
  const problems = postProblems(db, post);
  if (problems.length) throw new Error(problems.join('. '));
  const live = postAccounts(db, post).map((a) => ({ account_id: a.id, media: a.media, state: 'posted', published_date: at, likes: 0, comments: 0, shares: 0, clicks: 0 }));
  return write(db, 'social.post', post.id, { stage_id: 'posted', published_date: at, live_post_ids: live });
}

/** Schedule for a date (today or later). */
export function schedulePost(db, post, date) {
  if (!date || date < today()) throw new Error('Pick a date from today onwards');
  const problems = postProblems(db, post);
  if (problems.length) throw new Error(problems.join('. '));
  return write(db, 'social.post', post.id, { stage_id: 'scheduled', scheduled_date: date });
}

/** Publish scheduled posts that are due; a post that cannot be published is left scheduled. */
export function publishDue(db, at = today()) {
  return search(db, 'social.post').filter((p) => p.stage_id === 'scheduled' && p.scheduled_date && p.scheduled_date <= at).reduce((acc, p) => {
    try {
      return publishPost(acc, p, at);
    } catch {
      return acc;
    }
  }, db);
}

/** Record engagement reported by a network for one live post (absolute counters, never lower than before). */
export function recordEngagement(db, postId, accountId, counts) {
  const post = search(db, 'social.post').find((p) => p.id === postId);
  if (!post) return db;
  const live = (post.live_post_ids ?? []).map((l) => (l.account_id !== accountId ? l : Object.fromEntries(Object.entries(l).map(([k, v]) => (
    ['likes', 'comments', 'shares', 'clicks'].includes(k) && counts[k] != null ? [k, Math.max(Number(v) || 0, Number(counts[k]) || 0)] : [k, v]
  )))));
  return write(db, 'social.post', postId, { live_post_ids: live });
}

const total = (r, k) => (r.live_post_ids?.length ? r.live_post_ids.reduce((s, l) => s + (Number(l[k]) || 0), 0) : Number(r[k]) || 0);

export const socialModels = {
  'social.account': {
    label: 'Social Accounts',
    fields: {
      name: { type: 'char', label: 'Account Name', required: true },
      media: { type: 'selection', label: 'Social Media', options: MEDIA_OPTIONS, required: true },
      handle: { type: 'char', label: 'Handle' },
      followers: { type: 'integer', label: 'Followers' },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ media: 'facebook', active: true, followers: 0 }),
    groupBys: ['media'],
    kanban: { title: 'name', lines: ['media', 'handle', 'followers'] },
    list: ['name', 'media', 'handle', 'followers', 'active'],
    form: { title: 'name', groups: [['media', 'handle'], ['followers', 'active']] },
  },

  'social.post': {
    label: 'Posts',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      message: { type: 'text', label: 'Message' },
      image: { type: 'binary', label: 'Image' },
      account_ids: {
        type: 'one2many', label: 'Post on',
        fields: { account_id: { type: 'many2one', relation: 'social.account', label: 'Account' } },
        newLine: () => ({ account_id: null }),
      },
      accounts: { type: 'tags', label: 'Networks' },
      stage_id: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'Draft'], ['scheduled', 'Scheduled'], ['posted', 'Posted']] },
      scheduled_date: { type: 'date', label: 'Scheduled Date' },
      published_date: { type: 'date', label: 'Published on', readonly: true },
      characters: { type: 'integer', label: 'Characters', compute: (r) => [...String(r.message ?? '')].length },
      live_post_ids: {
        type: 'one2many', label: 'Live Posts', readonly: true,
        fields: {
          account_id: { type: 'many2one', relation: 'social.account', label: 'Account' },
          media: { type: 'selection', label: 'Social Media', options: MEDIA_OPTIONS },
          state: { type: 'selection', label: 'Status', options: [['posted', 'Posted'], ['failed', 'Failed']] },
          published_date: { type: 'date', label: 'Published on' },
          likes: { type: 'integer', label: 'Likes' },
          comments: { type: 'integer', label: 'Comments' },
          shares: { type: 'integer', label: 'Shares' },
          clicks: { type: 'integer', label: 'Clicks' },
        },
        newLine: () => ({ state: 'posted' }),
      },
      likes: { type: 'integer', label: 'Likes', compute: (r) => total(r, 'likes') },
      shares: { type: 'integer', label: 'Shares', compute: (r) => total(r, 'shares') },
      comments: { type: 'integer', label: 'Comments', compute: (r) => total(r, 'comments') },
      clicks: { type: 'integer', label: 'Clicks', compute: (r) => total(r, 'clicks') },
    },
    defaults: () => ({ stage_id: 'draft', account_ids: [], accounts: [], live_post_ids: [], scheduled_date: addDays(today(), 1) }),
    groupBys: ['stage_id', 'scheduled_date'],
    views: ['kanban', 'list', 'calendar', 'graph'],
    calendar: { date: 'scheduled_date' },
    graph: { groupBy: 'stage_id', measure: 'likes' },
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['scheduled_date', 'likes', 'shares'], tags: 'accounts', quickCreate: true },
    list: ['scheduled_date', 'name', 'characters', 'likes', 'comments', 'shares', 'clicks', 'stage_id'],
    form: {
      statusbar: 'stage_id',
      lockedWhen: (r) => r.stage_id === 'posted',
      buttons: [
        { label: 'Post', primary: true, when: (r) => r.stage_id !== 'posted', run: (db, r) => ({ db: publishPost(db, r) }) },
        { label: 'Schedule', when: (r) => r.stage_id === 'draft', run: (db, r) => ({ db: schedulePost(db, r, r.scheduled_date) }) },
        { label: 'Back to Draft', when: (r) => r.stage_id === 'scheduled', vals: { stage_id: 'draft' } },
        {
          // Networks are not connected (simulated), so reported counts are entered by hand.
          label: 'Record Engagement', when: (r) => r.stage_id === 'posted' && r.live_post_ids?.length,
          ask: [{ label: 'Account name', default: (r) => r.live_post_ids.length === 1 ? String(r.live_post_ids[0].account_id ?? '') : '' }, { label: 'Likes', type: 'number' }, { label: 'Comments', type: 'number' }, { label: 'Shares', type: 'number' }, { label: 'Clicks', type: 'number' }],
          run: (db, r, [account, likes, comments, shares, clicks]) => {
            const found = search(db, 'social.account').find((a) => String(a.id) === account || a.name.toLowerCase() === account.toLowerCase());
            if (!found || !r.live_post_ids.some((l) => l.account_id === found.id)) throw new Error('This post is not live on that account');
            return { db: recordEngagement(db, r.id, found.id, { likes, comments, shares, clicks }) };
          },
        },
      ],
      title: 'name',
      groups: [['scheduled_date', 'characters'], ['published_date', 'likes', 'comments', 'shares', 'clicks']],
      tabs: [{ label: 'Message', fields: ['message', 'image'] }, { label: 'Post on', fields: ['account_ids', 'accounts'] }, { label: 'Live Posts', fields: ['live_post_ids'] }],
      chatter: true,
    },
  },
};
