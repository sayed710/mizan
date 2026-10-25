import { useState } from 'react';
import { create, read, search, write } from '../orm.js';
import { commit, getDb, getUser, useDb } from '../store.js';
import { t } from '../i18n.js';
import {
  articleTree, breadcrumbs, canWrite, createChild, deleteForever, duplicateArticle, moveArticle,
  restoreArticle, restoreVersion, saveBody, toggleFavorite, trashArticle,
} from '../models/knowledge.js';

const MODEL = 'knowledge.article';
const BASE = '#/knowledge/articles';
const ICONS = ['📄', '📘', '📝', '💡', '📌', '🚀', '⭐', '📊'];
const SECTIONS = [['workspace', 'Workspace'], ['shared', 'Shared'], ['private', 'Private']];

const currentId = () => Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('id')) || null;
const go = (id) => { location.hash = `${BASE}?id=${id}`; };
const author = () => getUser()?.name ?? 'Admin';
const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children)]);

/** Apply a knowledge transition to the live db; errors (locked, cycle…) are shown instead of thrown. */
function run(fn) {
  try {
    const res = fn(getDb());
    commit(res.db ?? res);
    return res.id;
  } catch (e) {
    alert(t(e instanceof Error ? e.message : String(e)));
    return null;
  }
}

// Lock/publish/icon bypass saveBody on purpose: unlocking must work on a locked article.
const setFlag = (db, id, field, value) => write(db, MODEL, id, { [field]: value });
const saveIcon = (db, id, icon) => write(db, MODEL, id, { icon });

function TreeNode({ node, activeId, collapsed, toggle }) {
  const { article, children } = node;
  const closed = collapsed.has(article.id);
  const addChild = () => {
    const id = run((db) => createChild(db, article.id, { name: t('Untitled') }));
    if (id) go(id);
  };
  return (
    <li>
      <div className="knowledge-node" aria-current={article.id === activeId ? 'true' : undefined}>
        {children.length
          ? <button type="button" className="knowledge-caret" aria-expanded={!closed} aria-label={t(closed ? 'Expand' : 'Collapse')} onClick={() => toggle(article.id)}>{closed ? '▸' : '▾'}</button>
          : <span className="knowledge-caret" aria-hidden="true" />}
        <a href={`${BASE}?id=${article.id}`}><span aria-hidden="true">{article.icon || '📄'}</span> {article.name}</a>
        <button type="button" className="knowledge-add" aria-label={t('Add a sub-article')} title={t('Add a sub-article')} onClick={addChild}>+</button>
      </div>
      {children.length > 0 && !closed && (
        <ul>{children.map((c) => <TreeNode key={c.article.id} node={c} activeId={activeId} collapsed={collapsed} toggle={toggle} />)}</ul>
      )}
    </li>
  );
}

function Section({ id, label, nodes, onAdd, activeId, collapsed, toggle }) {
  const closed = collapsed.has(id);
  return (
    <section className="knowledge-section">
      <div className="knowledge-section-head">
        <button type="button" aria-expanded={!closed} onClick={() => toggle(id)}>{closed ? '▸' : '▾'} {t(label)}</button>
        {onAdd && <button type="button" className="knowledge-add" aria-label={t('Add an article')} title={t('Add an article')} onClick={onAdd}>+</button>}
      </div>
      {!closed && (nodes.length
        ? <ul>{nodes.map((n) => <TreeNode key={n.article.id} node={n} activeId={activeId} collapsed={collapsed} toggle={toggle} />)}</ul>
        : <p className="muted knowledge-empty">{t('No articles')}</p>)}
    </section>
  );
}

function Trash({ db }) {
  const trashed = search(db, MODEL, { includeArchived: true }).filter((r) => r.active === false);
  const remove = (r) => { if (confirm(t('Delete "{name}" forever?', { name: r.name }))) run((d) => deleteForever(d, r.id)); };
  return trashed.length ? (
    <ul className="knowledge-trash">
      {trashed.map((r) => (
        <li key={r.id}>
          <span>{r.icon || '📄'} {r.name}</span>
          <span className="knowledge-trash-actions">
            <button type="button" className="btn sm" onClick={() => run((d) => restoreArticle(d, r.id))}>{t('Restore')}</button>
            <button type="button" className="btn sm danger" onClick={() => remove(r)}>{t('Delete Forever')}</button>
          </span>
        </li>
      ))}
    </ul>
  ) : <p className="muted knowledge-empty">{t('The trash is empty')}</p>;
}

function History({ article }) {
  const versions = [...(article.history ?? [])].map((v, i) => ({ ...v, i })).reverse();
  const restore = (i) => run((db) => restoreVersion(db, article.id, i, { author: author() }));
  return (
    <section className="knowledge-history" aria-label={t('History')}>
      <h2>{t('History')}</h2>
      {versions.length ? (
        <ol>
          {versions.map((v) => (
            <li key={v.i}>
              <div><b>{v.name}</b> <span className="muted">{v.date} · {v.author}</span></div>
              <p className="muted">{(v.body ?? '').slice(0, 140)}</p>
              <button type="button" className="btn sm" disabled={article.is_locked} onClick={() => restore(v.i)}>{t('Restore')}</button>
            </li>
          ))}
        </ol>
      ) : <p className="muted">{t('No previous versions')}</p>}
    </section>
  );
}

function Editor({ db, article }) {
  const [name, setName] = useState(article.name);
  const [body, setBody] = useState(article.body ?? '');
  const [showHistory, setShowHistory] = useState(false);
  const readOnly = article.is_locked || !canWrite(article, getUser()?.partner_id);
  const save = () => {
    if (readOnly || (name === article.name && body === (article.body ?? ''))) return;
    if (run((d) => saveBody(d, article.id, { name, body, author: author() })) === null && !name.trim()) setName(article.name);
  };
  const cycleIcon = () => {
    const next = ICONS[(ICONS.indexOf(article.icon) + 1) % ICONS.length];
    run((d) => saveIcon(d, article.id, next));
  };
  const pickIcon = (e) => {
    e.preventDefault();
    const icon = prompt(t('Icon'), article.icon ?? '');
    if (icon?.trim()) run((d) => saveIcon(d, article.id, icon.trim().slice(0, 8)));
  };
  const moveTo = () => {
    const target = prompt(t('Move under which article? (empty = top level)'));
    if (target == null) return;
    const parent = target.trim() && search(getDb(), MODEL).find((r) => r.name.toLowerCase() === target.trim().toLowerCase());
    if (target.trim() && !parent) { alert(t('No article named "{name}"', { name: target.trim() })); return; }
    run((d) => moveArticle(d, article.id, { parentId: parent ? parent.id : null }));
  };
  const toTrash = () => {
    if (!confirm(t('Move "{name}" and its sub-articles to the trash?', { name: article.name }))) return;
    if (run((d) => trashArticle(d, article.id)) !== null) location.hash = BASE;
  };
  const duplicate = () => { const id = run((d) => duplicateArticle(d, article.id)); if (id) go(id); };
  const children = search(db, MODEL).filter((r) => r.parent_id === article.id);

  return (
    <article className="knowledge-article">
      <header className="knowledge-top">
        <nav className="knowledge-crumbs" aria-label={t('Breadcrumbs')}>
          {breadcrumbs(db, article.id).map((a, i, list) => (
            <span key={a.id}>{i < list.length - 1 ? <><a href={`${BASE}?id=${a.id}`}>{a.name}</a> / </> : a.name}</span>
          ))}
        </nav>
        <div className="knowledge-actions">
          <button type="button" className="btn sm" aria-pressed={!!article.is_favorite} onClick={() => run((d) => toggleFavorite(d, article.id))}>{article.is_favorite ? '★' : '☆'} {t('Favorite')}</button>
          <button type="button" className="btn sm" onClick={() => run((d) => setFlag(d, article.id, 'is_locked', !article.is_locked))}>{t(article.is_locked ? 'Unlock' : 'Lock')}</button>
          <button type="button" className="btn sm" onClick={() => run((d) => setFlag(d, article.id, 'is_published', !article.is_published))}>{t(article.is_published ? 'Unpublish' : 'Publish')}</button>
          <button type="button" className="btn sm" onClick={duplicate}>{t('Duplicate')}</button>
          <button type="button" className="btn sm" onClick={moveTo}>{t('Move to')}</button>
          <button type="button" className="btn sm" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>{t('History')}</button>
          <button type="button" className="btn sm danger" onClick={toTrash}>{t('Move to Trash')}</button>
        </div>
      </header>
      <div className="knowledge-page">
        <button type="button" className="knowledge-icon" title={t('Change icon (right-click to choose)')} aria-label={t('Change icon')} onClick={cycleIcon} onContextMenu={pickIcon}>{article.icon || '📄'}</button>
        {article.is_locked && <p className="muted knowledge-lock">🔒 {t('This article is locked')}</p>}
        <input className="knowledge-title" aria-label={t('Title')} value={name} readOnly={readOnly} onChange={(e) => setName(e.target.value)} onBlur={save} />
        <textarea className="knowledge-body" aria-label={t('Content')} value={body} readOnly={readOnly} placeholder={t('Write something...')} onChange={(e) => setBody(e.target.value)} onBlur={save} />
        {children.length > 0 && (
          <section className="knowledge-children">
            <h2>{t('Sub-articles')}</h2>
            <ul>{children.map((c) => <li key={c.id}><a href={`${BASE}?id=${c.id}`}>{c.icon || '📄'} {c.name}</a></li>)}</ul>
          </section>
        )}
        {article.last_edited_by && <p className="muted">{t('Last edited by {name} on {date}', { name: article.last_edited_by, date: article.write_date })}</p>}
      </div>
      {showHistory && <History article={article} />}
    </article>
  );
}


/** Knowledge app: section trees on the side, the selected article (from `?id=`) in the main area. */
export function Knowledge() {
  const db = useDb();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set(['trash']));
  const toggle = (key) => setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const trees = Object.fromEntries(SECTIONS.map(([k]) => [k, articleTree(db, { category: k, search: query })]));
  const favorites = flatten(articleTree(db, { search: query })).filter((n) => n.article.is_favorite);
  const id = currentId();
  const article = (id && read(db, MODEL, id)) || null;
  const fallback = !id && flatten(articleTree(db))[0]?.article;
  const shown = article?.active !== false ? article ?? fallback : null;
  const addRoot = (category) => {
    const newId = run((d) => create(d, MODEL, { name: t('Untitled'), category }));
    if (newId) go(newId);
  };

  return (
    <main className="knowledge">
      <aside className="knowledge-side">
        <input type="search" className="knowledge-search" placeholder={t('Search articles...')} aria-label={t('Search articles...')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Section id="favorites" label="Favorites" nodes={favorites} activeId={shown?.id} collapsed={collapsed} toggle={toggle} />
        {SECTIONS.map(([k, label]) => (
          <Section key={k} id={k} label={label} nodes={trees[k]} onAdd={() => addRoot(k)} activeId={shown?.id} collapsed={collapsed} toggle={toggle} />
        ))}
        <section className="knowledge-section">
          <div className="knowledge-section-head">
            <button type="button" aria-expanded={!collapsed.has('trash')} onClick={() => toggle('trash')}>🗑 {t('Trash')}</button>
          </div>
          {!collapsed.has('trash') && <Trash db={db} />}
        </section>
      </aside>
      <section className="knowledge-main">
        {shown
          ? <Editor key={shown.id} db={db} article={shown} />
          : <p className="muted knowledge-empty">{t(article ? 'This article is in the trash' : 'Select or create an article')}</p>}
      </section>
    </main>
  );
}
