import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { today, addDays } from './models/common.js';
import { websitePlusModels, slugify, uniqueSlug, hashPagePassword, checkPagePassword, resolveUrl, menuTree, pageFor, seoAudit, sitemap, robots, renderSnippet, duplicatePage } from './models/websiteplus.js';

const addPage = (db, slug, vals = {}) => create(db, 'website.page', { name: slug, slug, is_published: true, ...vals });
const button = (label) => websitePlusModels['website.page'].form.buttons.find((b) => b.label === label);

test('website seed keeps the existing fields, pages, defaults and publishing buttons', () => {
  const db = seed();
  assert.equal(search(db, 'website.page').length, 3);
  const home = search(db, 'website.page').find((p) => p.slug === 'home');
  assert.equal(resolveUrl(db, '/home/').page.id, home.id);
  assert.match(home.content, /Workspaces/);
  assert.equal(home.indexed, true);
  assert.equal(home.header_visible, true);
  assert.equal(home.footer_visible, true);
  assert.equal(button('Publish').vals.is_published, true);
  assert.equal(button('Unpublish').vals.is_published, false);
  assert.equal(button('View Website').run(db).go, '#/website/site');
  assert.deepEqual(websitePlusModels['website.page'].form.tabs.map((t) => t.label), ['Content', 'SEO', 'Visibility', 'Translations']);
});

test('slugify folds ASCII accents and uniqueSlug reserves archived and normalized slugs', () => {
  assert.equal(slugify('  HéLLo, Crème & Straße! '), 'hello-creme-strasse');
  assert.equal(slugify('Æther / Øresund'), 'aether-oresund');
  assert.equal(slugify('!!!'), '');
  const first = addPage(seed(), 'creme');
  const second = addPage(first.db, '/creme-2/', { active: false });
  assert.equal(uniqueSlug(second.db, 'Crème'), 'creme-3');
  assert.equal(uniqueSlug(second.db, 'Crème', first.id), 'creme');
  assert.equal(uniqueSlug(second.db, ''), 'page');
  assert.throws(() => addPage(first.db, '/creme/'), /already in use/);
});

test('URL resolution follows active redirects with the original status, refuses loops and limits hops', () => {
  let db = addPage(seed(), 'destination').db;
  db = create(db, 'website.redirect', { url_from: '/old', url_to: '/middle', type: '302' }).db;
  db = create(db, 'website.redirect', { url_from: '/middle', url_to: '/destination' }).db;
  assert.deepEqual(resolveUrl(db, '/old'), { redirect: { to: '/destination', status: 302 } });
  assert.deepEqual(resolveUrl(db, '/middle'), { redirect: { to: '/destination', status: 301 } });
  db = create(db, 'website.redirect', { url_from: '/off', url_to: '/destination', active: false }).db;
  assert.equal(resolveUrl(db, '/off'), null);
  db = create(db, 'website.redirect', { url_from: '/a', url_to: '/b' }).db;
  db = create(db, 'website.redirect', { url_from: '/b', url_to: '/a' }).db;
  assert.equal(resolveUrl(db, '/a'), null);
  for (let n = 0; n < 6; n++) db = create(db, 'website.redirect', { url_from: `/hop${n}`, url_to: n === 5 ? '/destination' : `/hop${n + 1}` }).db;
  assert.equal(resolveUrl(db, '/hop0'), null);
  assert.equal(resolveUrl(db, '/hop1').redirect.to, '/destination');
  db = create(db, 'website.redirect', { url_from: '/external', url_to: 'https://example.org/new' }).db;
  assert.equal(resolveUrl(db, '/external').redirect.to, 'https://example.org/new');
  db = create(db, 'website.redirect', { url_from: '/broken', url_to: '/missing' }).db;
  assert.equal(resolveUrl(db, '/broken'), null);
  assert.throws(() => create(db, 'website.redirect', { url_from: '/unsafe', url_to: '//evil.example' }), /destination/);
});

test('unpublished and scheduled pages are hidden; private pages return content-free access markers', () => {
  let db = seed();
  for (const [slug, vals, expected] of [
    ['draft', { is_published: false }, null],
    ['future', { date_publish: addDays(today(), 1) }, null],
    ['now', { date_publish: today() }, 'page'],
    ['past', { date_publish: addDays(today(), -1) }, 'page'],
    ['members', { visibility: 'connected' }, 'needsLogin'],
    ['group', { visibility: 'restricted_group' }, 'needsLogin'],
    ['secret', { visibility: 'password', visibility_password: hashPagePassword('secret') }, 'needsPassword'],
  ]) {
    db = addPage(db, slug, vals).db;
    const resolved = resolveUrl(db, `/${slug}`);
    if (!expected) assert.equal(resolved, null);
    else if (expected === 'page') assert.equal(resolved.page.slug, slug);
    else assert.deepEqual(resolved, { [expected]: true });
  }
  assert.equal(resolveUrl(db, '/unknown'), null);
  assert.throws(() => addPage(db, 'bad-date', { date_publish: '2026-02-30' }), /valid publication date/);
});

test('passwords match SHA-256 vectors; ORM rejects plaintext on create and write', () => {
  for (const value of ['', 'abc', 'كلمة مرور 🔒', 'a'.repeat(1000)]) {
    assert.equal(hashPagePassword(value), createHash('sha256').update(value).digest('hex'));
  }
  const before = seed();
  const { db, id } = addPage(before, 'password-test', { visibility: 'password', visibility_password: hashPagePassword('secret') });
  const page = read(db, 'website.page', id);
  assert.equal(page.visibility_password, hashPagePassword('secret'));
  assert.ok(!JSON.stringify(db).includes('"visibility_password":"secret"'));
  assert.equal(checkPagePassword(page, 'secret'), true);
  assert.equal(checkPagePassword(page, 'wrong'), false);
  assert.equal(checkPagePassword({}, ''), false);
  assert.equal(checkPagePassword({ visibility_password: 'secret' }, 'secret'), false);
  const browserCheck = (password) => runInNewContext(`(${checkPagePassword.toString()})(page, password)`, { page, password, hashPagePassword, HASH: /^[a-f0-9]{64}$/, nodeCrypto: null });
  assert.equal(browserCheck('secret'), true);
  assert.equal(browserCheck('wrong'), false);
  assert.throws(() => addPage(before, 'plain', { visibility_password: 'secret' }), /Hash the page password/);
  assert.throws(() => write(db, 'website.page', id, { visibility_password: 'raw' }), /Hash the page password/);
  assert.throws(() => addPage(before, 'empty-password', { visibility: 'password' }), /Set a page password/);
  assert.equal(search(before, 'website.page').length, 3);
});

test('Set Password hashes complete prompt input, never logs plaintext, and cancellation changes nothing', () => {
  const db = seed();
  const page = read(db, 'website.page', 1);
  const prompt = globalThis.prompt;
  try {
    globalThis.prompt = () => 'complete secret';
    const next = button('Set Password').run(db, page).db;
    assert.equal(checkPagePassword(read(next, 'website.page', 1), 'complete secret'), true);
    assert.equal(read(next, 'website.page', 1).visibility, 'password');
    assert.ok(!JSON.stringify(next).includes('complete secret'));
    globalThis.prompt = () => null;
    assert.equal(button('Set Password').run(db, page).db, db);
    globalThis.prompt = () => '';
    assert.throws(() => button('Set Password').run(db, page), /non-empty/);
  } finally {
    if (prompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = prompt;
  }
});

test('menus nest in sequence order with page hrefs, omitting unpublished and private branches', () => {
  const root = create(seed(), 'website.menu', { name: 'Root', url: '/root', sequence: 20 });
  let db = create(root.db, 'website.menu', { name: 'First', page_id: 1, sequence: 1 }).db;
  db = create(db, 'website.menu', { name: 'Child B', parent_id: root.id, page_id: 2, sequence: 2 }).db;
  db = create(db, 'website.menu', { name: 'Child A', parent_id: root.id, url: '/a', sequence: 1, new_window: true }).db;
  const hidden = addPage(db, 'hidden-menu', { is_published: false });
  db = create(hidden.db, 'website.menu', { name: 'Hidden', page_id: hidden.id }).db;
  const privatePage = addPage(db, 'private-menu', { visibility: 'connected' });
  db = create(privatePage.db, 'website.menu', { name: 'Private', page_id: privatePage.id }).db;
  const tree = menuTree(db);
  assert.deepEqual(tree.map((m) => m.name), ['First', 'Root']);
  assert.equal(tree[0].href, '/home');
  assert.deepEqual(tree[1].children.map((m) => [m.name, m.href]), [['Child A', '/a'], ['Child B', '/about']]);
  assert.equal(tree[1].children[0].new_window, true);
  assert.throws(() => write(db, 'website.menu', root.id, { parent_id: root.id }), /loop/);
});

test('translations overlay only name and content, fall back per field and never mutate the page', () => {
  const db = seed();
  const page = { ...read(db, 'website.page', 1), translations: [{ lang: 'ar', name: 'الرئيسية', content: '' }] };
  assert.equal(pageFor(db, page, 'ar').name, 'الرئيسية');
  assert.equal(pageFor(db, page, 'ar').content, page.content);
  assert.deepEqual(pageFor(db, page, 'fr'), page);
  assert.equal(page.name, 'Home');
  assert.equal(pageFor(db, { ...page, translations: [{ lang: 'ar', content: 'محتوى' }] }, 'ar').content, 'محتوى');
});

test('SEO audit detects missing, excessive and duplicate metadata and HTML accessibility hints', () => {
  const good = { website_meta_title: 'A'.repeat(60), website_meta_description: 'B'.repeat(160), og_image: '/image.png', content: '<h1>Title</h1><img alt="" src="x">', indexed: true };
  assert.deepEqual(seoAudit(good), []);
  assert.equal(seoAudit({}).length, 4);
  const warnings = seoAudit({ ...good, website_meta_title: 'a'.repeat(61), website_meta_description: 'a'.repeat(161), content: '<H1>A</H1><h1>B</h1><img src="x">', indexed: false });
  assert.equal(warnings.length, 5);
  assert.ok(warnings.some((w) => /duplicate h1/.test(w)));
  assert.ok(warnings.some((w) => /alt/.test(w)));
  assert.ok(warnings.some((w) => /not indexed/.test(w)));
  const db = seed();
  const noted = button('SEO Check').run(db, read(db, 'website.page', 1)).db;
  assert.equal(noted.messages.length, db.messages.length + 1);
  assert.match(noted.messages.at(-1).body, /Meta title/);
});

test('sitemap includes public pages, active-blog posts and sellable products with escaped XML dates and URLs', () => {
  let db = addPage(seed(), 'xml&<test>', { write_date: '2026-10-01T12:00:00Z' }).db;
  for (const [slug, vals] of [['noindex', { indexed: false }], ['draft-map', { is_published: false }], ['private-map', { visibility: 'connected' }], ['scheduled-map', { date_publish: addDays(today(), 1) }]]) db = addPage(db, slug, vals).db;
  const blog = create(db, 'blog.blog', { name: 'XML Blog' });
  const post = create(blog.db, 'blog.post', { blog_id: blog.id, name: 'Post', is_published: true, write_date: '2026-10-02' });
  db = post.db;
  const xml = sitemap(db, 'https://example.org/?a=1&b=2');
  assert.match(xml, /^<\?xml/);
  assert.ok(xml.includes('https://example.org/?a=1&amp;b=2/xml&amp;&lt;test&gt;'));
  assert.ok(xml.includes('<lastmod>2026-10-01T12:00:00Z</lastmod>'));
  assert.ok(xml.includes(`/blog/${post.id}</loc><lastmod>2026-10-02</lastmod>`));
  assert.ok(xml.includes('/shop/product/1</loc>'));
  assert.ok(!xml.includes('/shop/product/13</loc>'));
  for (const slug of ['noindex', 'draft-map', 'private-map', 'scheduled-map']) assert.ok(!xml.includes(`/${slug}</loc>`));
  const inactiveBlog = write(db, 'blog.blog', blog.id, { active: false });
  assert.ok(!sitemap(inactiveBlog, 'https://example.org').includes(`/blog/${post.id}</loc>`));
  const text = robots(db, 'https://example.org/');
  assert.ok(text.includes('Disallow: /noindex\n'));
  assert.ok(!text.includes('Disallow: /home'));
  assert.ok(text.endsWith('Sitemap: https://example.org/sitemap.xml\n'));
});

test('snippet rendering escapes values, treats missing keys as empty and never expands injected placeholders', () => {
  assert.equal(renderSnippet({ html: '<p>{{ title }} {{missing}} {{constructor}}</p>' }, { title: '<script>"&\'</script>' }), '<p>&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;  </p>');
  assert.equal(renderSnippet({ html: '{{a}} {{b}} {{a}}' }, { a: '{{b}}', b: 0 }), '{{b}} 0 {{b}}');
});

test('duplicatePage returns an independent unpublished copy with a unique slug and preserved metadata', () => {
  const original = addPage(seed(), 'copy-me', { website_meta_title: 'Title', translations: [{ lang: 'ar', name: 'نسخة', content: 'محتوى' }], write_date: '2026-10-01' });
  const copy = duplicatePage(original.db, original.id);
  const record = read(copy.db, 'website.page', copy.id);
  assert.equal(record.slug, 'copy-me-2');
  assert.equal(record.name, 'copy-me (copy)');
  assert.equal(record.is_published, false);
  assert.equal(record.website_meta_title, 'Title');
  assert.equal(record.write_date, undefined);
  assert.deepEqual(record.translations, read(original.db, 'website.page', original.id).translations);
  assert.notEqual(record.translations[0], read(original.db, 'website.page', original.id).translations[0]);
  assert.equal(search(original.db, 'website.page').length, 4);
  assert.equal(read(original.db, 'website.page', original.id).is_published, true);
  assert.equal(read(duplicatePage(copy.db, original.id).db, 'website.page', copy.id + 1).slug, 'copy-me-3');
  assert.match(button('Duplicate').run(original.db, read(original.db, 'website.page', original.id)).go, /^#\/website\/pages\/\d+$/);
  assert.throws(() => duplicatePage(original.db, -1), /Page not found/);
});
