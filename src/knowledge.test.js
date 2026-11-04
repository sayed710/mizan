import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read, search, write } from './orm.js';
import { seed } from './seed.js';
import {
  articleTree, breadcrumbs, canWrite, createChild, deleteForever, duplicateArticle, moveArticle,
  restoreArticle, restoreVersion, saveBody, toggleFavorite, trashArticle,
} from './models/knowledge.js';

const M = 'knowledge.article';
const add = (db, vals) => create(db, M, vals);
const names = (nodes) => nodes.map((n) => [n.article.name, names(n.children)]);

/** root(A) > child(B) > grandchild(C), plus a second root Z; all in the workspace. */
function tree() {
  let r = add(emptyDb(), { name: 'A', body: 'alpha' });
  const a = r.id;
  r = createChild(r.db, a, { name: 'B', body: 'bravo' });
  const b = r.id;
  r = createChild(r.db, b, { name: 'C', body: 'needle inside' });
  const c = r.id;
  r = add(r.db, { name: 'Z', sequence: 1 });
  return { db: r.db, a, b, c, z: r.id };
}

test('articleTree nests children and sorts by sequence then name', () => {
  const { db } = tree();
  assert.deepEqual(names(articleTree(db)), [['Z', []], ['A', [['B', [['C', []]]]]]]);
});

test('search matches name or body case-insensitively and keeps ancestors', () => {
  const { db } = tree();
  assert.deepEqual(names(articleTree(db, { search: 'NEEDLE' })), [['A', [['B', [['C', []]]]]]]);
  assert.deepEqual(names(articleTree(db, { search: 'bravo' })), [['A', [['B', []]]]]);
  assert.deepEqual(articleTree(db, { search: 'nothing' }), []);
});

test('a child inherits the parent category', () => {
  let r = add(emptyDb(), { name: 'Mine', category: 'private' });
  r = createChild(r.db, r.id, { name: 'Sub', category: 'workspace' });
  assert.equal(read(r.db, M, r.id).category, 'private');
});

test('moving under itself or a descendant is refused; descendants follow the category', () => {
  const { db, a, b, c, z } = tree();
  assert.throws(() => moveArticle(db, a, { parentId: a }), /cannot be moved/);
  assert.throws(() => moveArticle(db, a, { parentId: c }), /cannot be moved/);
  assert.throws(() => write(db, M, a, { parent_id: c }), /sub-article/);
  const shared = moveArticle(db, b, { category: 'shared' });
  assert.equal(read(shared, M, b).parent_id, null);
  assert.equal(read(shared, M, c).category, 'shared');
  const under = moveArticle(shared, b, { parentId: z });
  assert.equal(read(under, M, c).category, 'workspace');
  assert.deepEqual(breadcrumbs(under, c).map((x) => x.name), ['Z', 'B', 'C']);
});

test('trash takes descendants; restore brings back those trashed at the same time', () => {
  const { db, a, b, c } = tree();
  const early = trashArticle(db, c, '2026-01-01');
  const both = trashArticle(early, a, '2026-02-01');
  assert.deepEqual(search(both, M).map((x) => x.name), ['Z']);
  assert.equal(read(both, M, b).trash_date, '2026-02-01');
  const back = restoreArticle(both, a);
  assert.equal(read(back, M, b).active, true);
  assert.equal(read(back, M, c).active, false, 'C was trashed earlier, on its own');
  assert.deepEqual(names(articleTree(restoreArticle(back, c))), [['Z', []], ['A', [['B', [['C', []]]]]]]);
});

test('deleteForever works only from the trash and removes descendants', () => {
  const { db, a } = tree();
  assert.throws(() => deleteForever(db, a), /trash/);
  const gone = deleteForever(trashArticle(db, a), a);
  assert.deepEqual(search(gone, M, { includeArchived: true }).map((x) => x.name), ['Z']);
});

test('a locked article refuses saveBody', () => {
  const { db, a } = tree();
  const locked = write(db, M, a, { is_locked: true });
  assert.throws(() => saveBody(locked, a, { body: 'new' }), /locked/);
});

test('history keeps the previous body, capped at 20, and restoreVersion brings it back', () => {
  let { db, a } = tree();
  for (let i = 1; i <= 25; i++) db = saveBody(db, a, { body: `v${i}`, author: 'Sara', date: '2026-03-01' });
  const art = read(db, M, a);
  assert.equal(art.history.length, 20);
  assert.equal(art.history.at(-1).body, 'v24');
  assert.equal(art.history[0].body, 'v5');
  assert.equal(art.last_edited_by, 'Sara');
  assert.equal(saveBody(db, a, { body: 'v25' }), db, 'no change, no new version');
  const restored = restoreVersion(db, a, 0, { author: 'Omar' });
  assert.equal(read(restored, M, a).body, 'v5');
  assert.equal(read(restored, M, a).history.at(-1).body, 'v25');
});

test('member permission wins over the internal permission', () => {
  const art = { internal_permission: 'read', member_ids: [{ partner_id: 7, permission: 'write' }, { partner_id: 8, permission: 'none' }] };
  assert.equal(canWrite(art, 7), true);
  assert.equal(canWrite(art, 8), false);
  assert.equal(canWrite(art, 9), false);
  assert.equal(canWrite({ ...art, internal_permission: 'write' }, 9), true);
});

test('favorite toggles and duplicate copies the body with a (copy) suffix', () => {
  const { db, a } = tree();
  assert.equal(read(toggleFavorite(db, a), M, a).is_favorite, true);
  const dup = duplicateArticle(db, a);
  assert.equal(read(dup.db, M, dup.id).name, 'A (copy)');
  assert.equal(read(dup.db, M, dup.id).body, 'alpha');
});

test('seed articles load into the section trees', () => {
  const db = seed();
  assert.deepEqual(names(articleTree(db, { category: 'workspace' })), [['Company Handbook', [['Sales Playbook', []]]]]);
  assert.deepEqual(names(articleTree(db, { category: 'shared' })), [['Support Escalation Process', []]]);
  assert.equal(search(db, M)[0].icon, '📄');
});
