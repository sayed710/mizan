// Public Blog (#/shop/blog, #/shop/blog/<id>) and Forum (#/shop/forum, #/shop/forum/<id>, #/shop/forum/ask).
import { useEffect, useState } from 'react';
import { t } from '../i18n.js';
import { filterPosts, sortThreads } from '../models/blog.js';

const post = (path, body) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify(body),
}).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

/** GET a public JSON resource; { data, error } once loaded. */
function useJson(url) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null });
    fetch(url).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (live) setState(r.ok ? { data, error: null } : { data: null, error: t(data.error ?? 'Page not found') });
    }).catch(() => live && setState({ data: null, error: t('The website is not available right now.') }));
    return () => { live = false; };
  }, [url]);
  return state;
}

/** Server-rendered markdown: renderMarkdown escapes all input first and only emits a fixed set of tags. */
const Markdown = ({ html }) => <div className="blog-content" dangerouslySetInnerHTML={{ __html: html }} />;

const blogHash = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return `#/shop/blog${q.toString() ? `?${q}` : ''}`;
};

const Tags = ({ tags, href }) => (tags.length ? (
  <ul className="blog-tags">{tags.map((tag) => <li key={tag}>{href ? <a href={href(tag)}>{tag}</a> : tag}</li>)}</ul>
) : null);

function PostCard({ p }) {
  return (
    <article className="blog-card">
      {p.cover && <img src={p.cover} alt="" loading="lazy" />}
      <div>
        <h3><a href={`#/shop/blog/${p.id}`}>{p.name}</a></h3>
        {p.subtitle && <p className="blog-subtitle">{p.subtitle}</p>}
        <p className="muted">{p.published_date}{p.author ? ` · ${p.author}` : ''}</p>
        <p>{p.excerpt}</p>
        <Tags tags={p.tag_ids} href={(tag) => blogHash({ tag })} />
      </div>
    </article>
  );
}

function BlogList({ site, params }) {
  const tag = params.get('tag') ?? '';
  const search = params.get('search') ?? '';
  const posts = filterPosts(site.posts, { tag, search });
  const tags = [...new Set(site.posts.flatMap((p) => p.tag_ids))].sort();
  return (
    <section className="blog">
      <h1>{site.blogs[0]?.name ?? t('Blog')}</h1>
      {site.blogs[0]?.subtitle && <p className="blog-subtitle">{site.blogs[0].subtitle}</p>}
      <div className="blog-tools">
        <form role="search" onSubmit={(e) => { e.preventDefault(); location.hash = blogHash({ tag, search: new FormData(e.currentTarget).get('search') }); }}>
          <input name="search" type="search" defaultValue={search} placeholder={t('Search…')} aria-label={t('Search posts')} />
        </form>
        <nav aria-label={t('Tags')} className="blog-tags">
          <a href={blogHash({ search })} aria-current={!tag ? 'page' : undefined}>{t('All')}</a>
          {tags.map((x) => <a key={x} href={blogHash({ tag: x, search })} aria-current={x === tag ? 'page' : undefined}>{x}</a>)}
        </nav>
      </div>
      {posts.length ? posts.map((p) => <PostCard key={p.id} p={p} />) : <p className="muted">{t('Nothing here yet.')}</p>}
    </section>
  );
}

function BlogPost({ site, id }) {
  const { data, error } = useJson(`/api/public/blog/${encodeURIComponent(id)}`);
  useEffect(() => {
    if (!data) return undefined;
    const before = document.title;
    document.title = data.name;
    const meta = document.querySelector('meta[name="description"]') ?? document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'description' }));
    meta.content = data.meta_description || data.subtitle || data.excerpt;
    return () => { document.title = before; };
  }, [data]);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted">…</p>;
  const more = site.posts.filter((p) => p.id !== data.id).slice(0, 3);
  return (
    <article className="blog blog-post">
      <p><a href="#/shop/blog">← {t('All posts')}</a></p>
      {data.cover && <img className="blog-cover" src={data.cover} alt="" />}
      <h1>{data.name}</h1>
      {data.subtitle && <p className="blog-subtitle">{data.subtitle}</p>}
      <p className="muted">{data.published_date}{data.author ? ` · ${data.author}` : ''} · {t('{count} views', { count: data.visits })}</p>
      <Tags tags={data.tag_ids} href={(tag) => blogHash({ tag })} />
      <Markdown html={data.html} />
      {more.length > 0 && (
        <aside aria-label={t('More posts')}>
          <h2>{t('More posts')}</h2>
          {more.map((p) => <PostCard key={p.id} p={p} />)}
        </aside>
      )}
    </article>
  );
}

/** #/shop/blog and #/shop/blog/<id>. */
export function Blog({ site, route }) {
  return route.arg ? <BlogPost site={site} id={route.arg} /> : <BlogList site={site} params={route.params} />;
}

/** Name, email and message fields; posts to `path` and shows the moderation notice to the author. */
function VisitorPost({ path, extra, title, action }) {
  const [state, setState] = useState({ done: null, error: null });
  if (state.done) return <p className="forum-notice" role="status">{t(state.done)}</p>;
  return (
    <form className="checkout" onSubmit={async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      const tags = String(f.tags ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const r = await post(path, { ...extra, ...f, tags });
      setState(r.ok ? { done: r.data.message, error: null } : { done: null, error: t(r.data.error ?? 'Could not send the message') });
    }}>
      {title && <label>{t('Title')}<input name="title" required maxLength={200} /></label>}
      <label>{t('Your question or answer')}<textarea name="content" required maxLength={5000} rows={6} /></label>
      {title && <label>{t('Tags (comma separated)')}<input name="tags" maxLength={200} /></label>}
      <label>{t('Name')}<input name="name" required maxLength={120} /></label>
      <label>{t('Email')}<input name="email" type="email" required maxLength={254} /></label>
      {state.error && <div className="alert" role="alert">{state.error}</div>}
      <button type="submit" className="btn primary">{action}</button>
    </form>
  );
}

function Votes({ id, votes }) {
  const [count, setCount] = useState(votes);
  const [error, setError] = useState(null);
  const cast = async (delta) => {
    const r = await post('/api/public/forum/vote', { post_id: id, delta });
    if (r.ok) setCount(r.data.votes);
    setError(r.ok ? null : t(r.data.error));
  };
  return (
    <div className="forum-votes">
      <button type="button" className="btn sm" aria-label={t('Vote up')} onClick={() => cast(1)}>▲</button>
      <b aria-label={t('{count} votes', { count })}>{count}</b>
      <button type="button" className="btn sm" aria-label={t('Vote down')} onClick={() => cast(-1)}>▼</button>
      {error && <small className="alert" role="alert">{error}</small>}
    </div>
  );
}

const SORTS = [['newest', 'Newest'], ['votes', 'Most voted'], ['unanswered', 'Unanswered']];

function ForumList({ site, params }) {
  const forum = site.forums.find((f) => f.id === Number(params.get('forum'))) ?? site.forums[0];
  const sort = SORTS.some(([k]) => k === params.get('sort')) ? params.get('sort') : 'newest';
  if (!forum) return <p className="muted">{t('Nothing here yet.')}</p>;
  const hash = (vals) => `#/shop/forum?${new URLSearchParams({ forum: forum.id, sort, ...vals })}`;
  const threads = sortThreads(forum.threads, sort);
  return (
    <section className="forum">
      <div className="forum-head">
        <div>
          <h1>{forum.name}</h1>
          {forum.description && <p className="muted">{forum.description}</p>}
        </div>
        <a className="btn primary" href={`#/shop/forum/ask?forum=${forum.id}`}>{t('Ask a question')}</a>
      </div>
      {site.forums.length > 1 && (
        <nav className="blog-tags" aria-label={t('Forums')}>
          {site.forums.map((f) => <a key={f.id} href={`#/shop/forum?forum=${f.id}`} aria-current={f.id === forum.id ? 'page' : undefined}>{f.name}</a>)}
        </nav>
      )}
      <nav className="forum-tabs" aria-label={t('Sort')}>
        {SORTS.map(([k, label]) => <a key={k} href={hash({ sort: k })} aria-current={k === sort ? 'page' : undefined}>{t(label)}</a>)}
      </nav>
      {threads.length ? threads.map((th) => (
        <article key={th.id} className="forum-thread">
          <div className="forum-stats"><b>{th.votes}</b><small>{t('votes')}</small></div>
          <div className={`forum-stats${th.has_accepted ? ' accepted' : ''}`}><b>{th.answers}</b><small>{t('answers')}</small></div>
          <div>
            <h3><a href={`#/shop/forum/${th.id}`}>{th.name}</a>{th.state === 'closed' && <small className="muted"> [{t('Closed')}]</small>}</h3>
            <p className="muted">{th.author_name} · {t('{count} views', { count: th.views })}</p>
            <Tags tags={th.tag_ids} />
          </div>
        </article>
      )) : <p className="muted">{t('Nothing here yet.')}</p>}
    </section>
  );
}

function ForumThread({ id }) {
  const { data, error } = useJson(`/api/public/forum/${encodeURIComponent(id)}`);
  if (error) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted">…</p>;
  return (
    <article className="forum">
      <p><a href={`#/shop/forum?forum=${data.forum.id}`}>← {data.forum.name}</a></p>
      <div className="forum-post">
        <Votes id={data.id} votes={data.votes} />
        <div>
          <h1>{data.name}</h1>
          <p className="muted">{data.author_name}</p>
          <Tags tags={data.tag_ids} />
          <Markdown html={data.html} />
        </div>
      </div>
      <h2>{t('{count} answers', { count: data.answers.length })}</h2>
      {data.answers.map((a) => (
        <div key={a.id} className={`forum-post${a.accepted ? ' accepted' : ''}`}>
          <Votes id={a.id} votes={a.votes} />
          <div>
            {a.accepted && <p className="forum-accepted">✔ {t('Accepted answer')}</p>}
            <p className="muted">{a.author_name}</p>
            <Markdown html={a.html} />
          </div>
        </div>
      ))}
      {data.closed ? <p className="muted">{t('This question is closed.')}</p> : (
        <>
          <h2>{t('Your answer')}</h2>
          <VisitorPost path="/api/public/forum/answer" extra={{ question_id: data.id }} action={t('Post your answer')} />
        </>
      )}
    </article>
  );
}

/** #/shop/forum, #/shop/forum/<id> and the #/shop/forum/ask form. */
export function Forum({ site, route }) {
  if (route.arg === 'ask') {
    const forum = site.forums.find((f) => f.id === Number(route.params.get('forum'))) ?? site.forums[0];
    if (!forum) return <p className="muted">{t('Nothing here yet.')}</p>;
    return (
      <section className="forum">
        <p><a href={`#/shop/forum?forum=${forum.id}`}>← {forum.name}</a></p>
        <h1>{t('Ask a question')}</h1>
        <VisitorPost path="/api/public/forum/ask" extra={{ forum_id: forum.id }} title action={t('Post your question')} />
      </section>
    );
  }
  return route.arg ? <ForumThread id={route.arg} /> : <ForumList site={site} params={route.params} />;
}
