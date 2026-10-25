// Knowledge: nested articles in Workspace / Shared / Private sections, with trash, lock, members and version history.
import { create, read, unlink, write } from '../orm.js';
import { today } from './common.js';

const MODEL = 'knowledge.article';
const HISTORY_MAX = 20;
const PERMISSIONS = [['write', 'Can edit'], ['read', 'Can read'], ['none', 'No access']];

const all = (db) => db.records[MODEL] ?? [];
const byId = (db, id) => all(db).find((r) => r.id === id);
const childrenOf = (db, id) => all(db).filter((r) => r.parent_id === id);
const order = (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || String(a.name).localeCompare(String(b.name));

/** Ids of every descendant of `id` (trashed ones included). */
export function descendantIds(db, id) {
  return childrenOf(db, id).flatMap((c) => [c.id, ...descendantIds(db, c.id)]);
}

/** Parent chain of `id`, root first, without the article itself. */
function ancestors(db, id) {
  const out = [];
  const seen = new Set([id]);
  let p = byId(db, id)?.parent_id;
  while (p && !seen.has(p)) {
    const rec = byId(db, p);
    if (!rec) break;
    out.unshift(rec);
    seen.add(p);
    p = rec.parent_id;
  }
  return out;
}

/** Rejects a parent that is the article itself or one of its descendants. */
export function articleGuard(db, before, after) {
  if (!after.parent_id) return null;
  if (after.parent_id === after.id) return 'An article cannot be its own parent';
  let p = after.parent_id;
  const seen = new Set();
  while (p && !seen.has(p)) {
    if (p === after.id) return 'An article cannot be moved under its own sub-article';
    seen.add(p);
    p = byId(db, p)?.parent_id;
  }
  return null;
}

/**
 * Nested tree of active articles, sorted by sequence then name.
 * @param {{ category?: string, search?: string }} opts search matches name or body and keeps ancestors of matches
 * @returns {{ article: object, children: object[] }[]}
 */
export function articleTree(db, { category, search } = {}) {
  const pool = all(db).filter((r) => r.active !== false && (!category || r.category === category));
  const inPool = new Map(pool.map((r) => [r.id, r]));
  let keep = new Set(pool.map((r) => r.id));
  const term = search?.trim().toLowerCase();
  if (term) {
    keep = new Set();
    for (const r of pool) {
      if (!`${r.name ?? ''}\n${r.body ?? ''}`.toLowerCase().includes(term)) continue;
      for (let cur = r; cur && !keep.has(cur.id); cur = inPool.get(cur.parent_id)) keep.add(cur.id);
    }
  }
  const kept = pool.filter((r) => keep.has(r.id));
  const build = (r) => ({ article: r, children: kept.filter((c) => c.parent_id === r.id).sort(order).map(build) });
  return kept.filter((r) => !keep.has(r.parent_id)).sort(order).map(build);
}

/** Create a sub-article; it inherits the parent's section. @returns {{ db: object, id: number }} */
export function createChild(db, parentId, vals = {}) {
  const parent = byId(db, parentId);
  if (!parent) throw new Error('Parent article not found');
  return create(db, MODEL, { ...vals, parent_id: parentId, category: parent.category });
}

/** Move under `parentId` (null = root of `category`); descendants follow the section. */
export function moveArticle(db, id, { parentId = null, category } = {}) {
  const art = byId(db, id);
  if (!art) throw new Error('Article not found');
  if (parentId && (parentId === id || descendantIds(db, id).includes(parentId))) throw new Error('An article cannot be moved under itself or its sub-articles');
  const target = parentId ? byId(db, parentId) : null;
  if (parentId && !target) throw new Error('Parent article not found');
  const cat = target?.category ?? category ?? art.category;
  const moved = write(db, MODEL, id, { parent_id: parentId, category: cat });
  return descendantIds(moved, id).reduce((acc, d) => write(acc, MODEL, d, { category: cat }), moved);
}

/** Send an article and all its descendants to the trash. */
export function trashArticle(db, id, date = today()) {
  if (!byId(db, id)) throw new Error('Article not found');
  return [id, ...descendantIds(db, id)].reduce((acc, d) => (byId(acc, d).active === false ? acc : write(acc, MODEL, d, { active: false, trash_date: date })), db);
}

/** Restore a trashed article plus the descendants trashed together with it; detached if its parent is still trashed. */
export function restoreArticle(db, id) {
  const art = byId(db, id);
  if (!art) throw new Error('Article not found');
  const parentTrashed = art.parent_id && byId(db, art.parent_id)?.active === false;
  const same = descendantIds(db, id).filter((d) => { const r = byId(db, d); return r.active === false && r.trash_date === art.trash_date; });
  const restored = write(db, MODEL, id, { active: true, trash_date: null, ...(parentTrashed ? { parent_id: null } : {}) });
  return same.reduce((acc, d) => write(acc, MODEL, d, { active: true, trash_date: null }), restored);
}

/** Permanently delete a trashed article and its descendants. */
export function deleteForever(db, id) {
  const art = byId(db, id);
  if (!art) throw new Error('Article not found');
  if (art.active !== false) throw new Error('Only articles in the trash can be deleted');
  return unlink(db, MODEL, [id, ...descendantIds(db, id)]);
}

/** Flip the favorite star. */
export const toggleFavorite = (db, id) => write(db, MODEL, id, { is_favorite: !byId(db, id)?.is_favorite });

/** Copy an article (title gets a "(copy)" suffix; history and members are not copied). @returns {{ db: object, id: number }} */
export function duplicateArticle(db, id) {
  const art = byId(db, id);
  if (!art) throw new Error('Article not found');
  const { name, body, icon, category, parent_id, internal_permission, sequence } = art;
  return create(db, MODEL, { name: `${name} (copy)`, body, icon, category, parent_id, internal_permission, sequence });
}

/** Save title/body; refuses locked articles and keeps the previous body in history (last 20). */
export function saveBody(db, id, { name, body, author = 'Admin', date = today() } = {}) {
  const art = byId(db, id);
  if (!art) throw new Error('Article not found');
  if (art.is_locked) throw new Error('This article is locked');
  const nextName = name ?? art.name;
  const nextBody = body ?? art.body ?? '';
  const bodyChanged = nextBody !== (art.body ?? '');
  if (!bodyChanged && nextName === art.name) return db;
  const history = bodyChanged
    ? [...(art.history ?? []), { date: art.write_date ?? date, author: art.last_edited_by ?? author, name: art.name, body: art.body ?? '' }].slice(-HISTORY_MAX)
    : art.history ?? [];
  return write(db, MODEL, id, { name: nextName, body: nextBody, history, write_date: date, last_edited_by: author });
}

/** Bring back version `index` of the history (the current text is itself kept as a version). */
export function restoreVersion(db, id, index, { author, date } = {}) {
  const version = byId(db, id)?.history?.[index];
  if (!version) throw new Error('Version not found');
  return saveBody(db, id, { name: version.name, body: version.body, author, date });
}

/** Ancestors first, then the article itself. */
export function breadcrumbs(db, id) {
  const art = read(db, MODEL, id);
  return art ? [...ancestors(db, id), art] : [];
}

/** Whether `partnerId` may edit: its member permission wins, else the internal permission. */
export function canWrite(article, partnerId) {
  const member = (article.member_ids ?? []).find((m) => m.partner_id === partnerId);
  return (member?.permission ?? article.internal_permission ?? 'write') === 'write';
}

export const knowledgeModels = {
  [MODEL]: {
    label: 'Articles',
    fields: {
      name: { type: 'char', label: 'Title', required: true },
      icon: { type: 'char', label: 'Icon' },
      parent_id: { type: 'many2one', relation: MODEL, label: 'Parent Article' },
      category: { type: 'selection', label: 'Section', options: [['workspace', 'Workspace'], ['shared', 'Shared'], ['private', 'Private']] },
      sequence: { type: 'integer', label: 'Sequence' },
      is_favorite: { type: 'boolean', label: 'Favorite' },
      is_locked: { type: 'boolean', label: 'Locked' },
      is_published: { type: 'boolean', label: 'Published' },
      internal_permission: { type: 'selection', label: 'Internal Permission', options: PERMISSIONS },
      active: { type: 'boolean', label: 'Active' },
      trash_date: { type: 'date', label: 'Trashed On', readonly: true },
      body: { type: 'text', label: 'Content' },
      member_ids: {
        type: 'one2many', label: 'Members',
        fields: {
          partner_id: { type: 'many2one', relation: 'res.partner', label: 'Member' },
          permission: { type: 'selection', label: 'Permission', options: PERMISSIONS },
        },
        newLine: () => ({ partner_id: null, permission: 'write' }),
      },
      history: {
        type: 'one2many', label: 'History', readonly: true,
        fields: {
          date: { type: 'date', label: 'Date' },
          author: { type: 'char', label: 'Author' },
          name: { type: 'char', label: 'Title' },
          body: { type: 'text', label: 'Content' },
        },
        newLine: () => ({ date: today(), author: '', name: '', body: '' }),
      },
      write_date: { type: 'date', label: 'Last Edited', readonly: true },
      last_edited_by: { type: 'char', label: 'Last Edited By', readonly: true },
    },
    defaults: () => ({ icon: '📄', sequence: 10, category: 'workspace', active: true, internal_permission: 'write', member_ids: [], history: [], write_date: today() }),
    guard: articleGuard,
    filters: [[{ id: 'fav', label: 'Favorites', fn: (r) => r.is_favorite }], [{ id: 'published', label: 'Published', fn: (r) => r.is_published }]],
    groupBys: ['category', 'parent_id'],
    kanban: { groupBy: 'category', title: 'name', lines: ['parent_id', 'write_date'] },
    list: ['icon', 'name', 'parent_id', 'category', 'write_date', 'last_edited_by'],
    form: {
      title: 'name',
      groups: [['icon', 'parent_id', 'category', 'sequence'], ['is_favorite', 'is_locked', 'is_published', 'internal_permission', 'write_date', 'last_edited_by']],
      tabs: [{ label: 'Content', fields: ['body'] }, { label: 'Members', fields: ['member_ids'] }, { label: 'History', fields: ['history'] }],
      chatter: true,
    },
  },
};
