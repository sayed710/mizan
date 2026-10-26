// Website builder depth: SEO, visibility, translations, menus, redirects, snippets, sitemap.
import { create, read, search, write, postNote } from '../orm.js';
import { extraModels } from './extra.js';
import { today } from './common.js';
import { publishedPosts } from './blog.js';
import { isSellable } from './shop.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pathOf = (value) => `/${String(value ?? '').replace(/^\/+|\/+$/g, '')}`;
const published = (page) => page.is_published && (!page.date_publish || page.date_publish <= today());
const publicPage = (page) => published(page) && (!page.visibility || page.visibility === 'public');
const HASH = /^[a-f0-9]{64}$/;
const nodeCrypto = typeof process !== 'undefined' && process.versions?.node ? process.getBuiltinModule?.('node:crypto') : null;
const relation = (model, label) => ({ type: 'many2one', relation: model, label });

/** Lowercase ASCII URL component; accents fold, other non-ASCII characters are removed. */
export function slugify(text) {
  return String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe').replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** An unused page slug, including archived pages; suffixes start at -2. */
export function uniqueSlug(db, base, excludeId) {
  const root = slugify(base) || 'page';
  const used = new Set(search(db, 'website.page', { includeArchived: true }).filter((p) => p.id !== excludeId).map((p) => pathOf(p.slug)));
  let slug = root;
  for (let n = 2; used.has(pathOf(slug)); n++) slug = `${root}-${n}`;
  return slug;
}

/** Synchronous UTF-8 SHA-256 for both browser forms and Node callers (Web Crypto is async).
 * Pass this hash to ORM create/write; plaintext is rejected by the page guard.
 */
export function hashPagePassword(password) {
  const bytes = new TextEncoder().encode(String(password ?? ''));
  const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  data.set(bytes);
  data[bytes.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(data.length - 4, bytes.length * 8);
  const primes = [];
  for (let n = 2; primes.length < 64; n++) if (!primes.some((p) => n % p === 0)) primes.push(n);
  const h = primes.slice(0, 8).map((p) => (Math.sqrt(p) % 1 * 2 ** 32) | 0);
  const k = primes.map((p) => (Math.cbrt(p) % 1 * 2 ** 32) | 0);
  const rotate = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = Array.from({ length: 64 }, (_, i) => i < 16 ? view.getInt32(offset + i * 4) : 0);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, z] = h;
    for (let i = 0; i < 64; i++) {
      const t = (z + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
      const u = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [a, b, c, d, e, f, g, z] = [(t + u) | 0, a, b, c, (d + t) | 0, e, f, g];
    }
    [a, b, c, d, e, f, g, z].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Native constant-time comparison on Node 24; fixed-work browser fallback has no JS timing guarantee. */
export function checkPagePassword(page, password) {
  const actual = hashPagePassword(password);
  const stored = HASH.test(page?.visibility_password ?? '') ? page.visibility_password : '0'.repeat(64);
  if (nodeCrypto) return nodeCrypto.timingSafeEqual(new TextEncoder().encode(actual), new TextEncoder().encode(stored)) && HASH.test(page?.visibility_password ?? '');
  let different = 0;
  for (let i = 0; i < 64; i++) different |= actual.charCodeAt(i) ^ stored.charCodeAt(i);
  return different === 0 && HASH.test(page?.visibility_password ?? '');
}

/** Resolve anonymous page access or a redirect chain (five hops maximum); never expose gated content. */
export function resolveUrl(db, path) {
  let current = pathOf(path), status;
  const visited = new Set();
  for (let hops = 0; hops <= 5; hops++) {
    if (visited.has(current)) return null;
    visited.add(current);
    const redirect = search(db, 'website.redirect').find((r) => pathOf(r.url_from) === current);
    if (redirect) {
      if (hops === 5) return null;
      status ??= Number(redirect.type) === 302 ? 302 : 301;
      if (/^https?:\/\//i.test(redirect.url_to)) return { redirect: { to: redirect.url_to, status } };
      current = pathOf(redirect.url_to);
      continue;
    }
    const page = search(db, 'website.page').find((p) => pathOf(p.slug) === current);
    if (!page || !published(page)) return null;
    if (status) return { redirect: { to: current, status } };
    if (page.visibility === 'password') return { needsPassword: true };
    if (page.visibility === 'connected' || page.visibility === 'restricted_group') return { needsLogin: true };
    if (page.visibility && page.visibility !== 'public') return null;
    return { page };
  }
  return null;
}

/** Public navigation, nested and ordered by sequence; invalid/cyclic branches are omitted. */
export function menuTree(db) {
  const menus = search(db, 'website.menu').sort((a, b) => (a.sequence ?? 10) - (b.sequence ?? 10) || a.id - b.id);
  const branch = (parent, visited) => menus.filter((m) => (m.parent_id || null) === parent && !visited.has(m.id)).flatMap((m) => {
    const page = m.page_id && read(db, 'website.page', m.page_id);
    if (m.page_id && (!page || page.active === false || !publicPage(page))) return [];
    return [{ ...m, href: page ? pathOf(page.slug) : m.url || '#', children: branch(m.id, new Set([...visited, m.id])) }];
  });
  return branch(null, new Set());
}

/** Overlay only translated name/content; missing or empty values fall back to the original. */
export function pageFor(db, page, lang) {
  const translation = (page.translations ?? []).find((t) => t.lang === lang);
  return { ...page, name: translation?.name || page.name, content: translation?.content || page.content };
}

/** Lightweight HTML SEO checks (not an HTML parser or a content sanitizer). */
export function seoAudit(page) {
  const warnings = [];
  for (const [field, label, max] of [['website_meta_title', 'Meta title', 60], ['website_meta_description', 'Meta description', 160]]) {
    if (!String(page[field] ?? '').trim()) warnings.push(`${label} is missing`);
    else if (page[field].length > max) warnings.push(`${label} is too long (maximum ${max} characters)`);
  }
  if (!page.og_image) warnings.push('Open Graph image is missing');
  const html = String(page.content ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const headings = html.match(/<h1\b[^>]*>/gi) ?? [];
  if (!headings.length) warnings.push('Content has no h1 heading');
  if (headings.length > 1) warnings.push('Content has duplicate h1 headings');
  if ((html.match(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi) ?? []).some((img) => !/\salt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(img))) warnings.push('Images are missing alt attributes');
  if (page.indexed === false) warnings.push('Page is not indexed');
  return warnings;
}

/** XML sitemap using canonical path URLs (the server must serve the SPA at these paths). */
export function sitemap(db, baseUrl) {
  const entries = [
    ...search(db, 'website.page').filter((p) => publicPage(p) && p.indexed !== false).map((p) => [pathOf(p.slug), p]),
    ...publishedPosts(db).map((p) => [`/blog/${p.id}`, p]),
    ...search(db, 'product').filter((p) => isSellable(p) && !p.variant_of).map((p) => [`/shop/product/${p.id}`, p]),
  ];
  const base = String(baseUrl).replace(/\/+$/, '');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(([path, r]) => `<url><loc>${escape(base + path)}</loc>${r.write_date ? `<lastmod>${escape(r.write_date)}</lastmod>` : ''}</url>`).join('')}</urlset>`;
}

/** Robots exclusions are crawler hints, never access control. */
export function robots(db, baseUrl) {
  const paths = search(db, 'website.page').filter((p) => p.indexed === false).map((p) => `Disallow: ${pathOf(p.slug).replace(/[\r\n]/g, '')}`);
  return ['User-agent: *', ...paths, `Sitemap: ${String(baseUrl).replace(/[\r\n]/g, '').replace(/\/+$/, '')}/sitemap.xml`, ''].join('\n');
}

/** Escape placeholder values as text; trusted templates must not interpolate into script or URL contexts. */
export function renderSnippet(snippet, values = {}) {
  return String(snippet.html ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => escape(Object.hasOwn(values, key) ? values[key] : ''));
}

/** Copy a page and its translations into an unpublished draft. Returns { db, id }. */
export function duplicatePage(db, pageId) {
  const page = read(db, 'website.page', pageId);
  if (!page) throw new Error('Page not found');
  const { id, write_date, create_date, ...values } = page;
  return create(db, 'website.page', { ...values, name: `${page.name} (copy)`, slug: uniqueSlug(db, page.slug), is_published: false, translations: (page.translations ?? []).map((t) => ({ ...t })) });
}

function hierarchyGuard(db, model, record) {
  const seen = new Set([record.id]);
  let parent = record.parent_id;
  while (parent) {
    if (seen.has(parent)) return 'A parent hierarchy cannot contain a loop';
    seen.add(parent);
    const found = read(db, model, parent);
    if (!found) return 'Parent not found';
    parent = found.parent_id;
  }
  return null;
}

const page = extraModels['website.page'];
export const websitePlusModels = {
  'website.page': {
    ...page,
    fields: {
      ...page.fields,
      website_meta_title: { type: 'char', label: 'Meta Title' },
      website_meta_description: { type: 'text', label: 'Meta Description' },
      website_meta_keywords: { type: 'char', label: 'Meta Keywords' },
      og_image: { type: 'char', label: 'Open Graph Image URL' },
      indexed: { type: 'boolean', label: 'Indexed' },
      visibility: { type: 'selection', label: 'Visibility', options: [['public', 'Public'], ['connected', 'Signed-in Users'], ['restricted_group', 'Restricted Group'], ['password', 'Password']] },
      visibility_password: { type: 'char', label: 'Password Hash', readonly: true },
      date_publish: { type: 'date', label: 'Publish On' },
      parent_id: relation('website.page', 'Parent Page'),
      header_visible: { type: 'boolean', label: 'Show Header' },
      footer_visible: { type: 'boolean', label: 'Show Footer' },
      translations: { type: 'one2many', label: 'Translations', fields: { lang: { type: 'char', label: 'Language Code', required: true }, name: { type: 'char', label: 'Page Title' }, content: { type: 'text', label: 'Content' } }, newLine: () => ({ lang: '', name: '', content: '' }) },
    },
    defaults: () => ({ ...page.defaults(), indexed: true, visibility: 'public', header_visible: true, footer_visible: true, translations: [] }),
    guard: (db, before, r) => {
      if (r.visibility_password && !HASH.test(r.visibility_password)) return 'Hash the page password with hashPagePassword before saving';
      if (r.visibility === 'password' && !r.visibility_password) return 'Set a page password with Set Password before restricting access';
      if (search(db, 'website.page', { includeArchived: true }).some((p) => p.id !== r.id && pathOf(p.slug) === pathOf(r.slug))) return 'This page URL is already in use';
      if (r.date_publish && (!/^\d{4}-\d{2}-\d{2}$/.test(r.date_publish) || !Number.isFinite(Date.parse(r.date_publish)) || new Date(r.date_publish).toISOString().slice(0, 10) !== r.date_publish)) return 'Enter a valid publication date';
      return hierarchyGuard(db, 'website.page', r);
    },
    form: {
      ...page.form,
      buttons: [...page.form.buttons,
        { label: 'Set Password', run: (db, r) => {
          const password = globalThis.prompt('Enter the page password');
          if (password === null) return { db };
          if (!password) throw new Error('Enter a non-empty page password');
          return { db: write(db, 'website.page', r.id, { visibility_password: hashPagePassword(password), visibility: 'password' }) };
        } },
        { label: 'Duplicate', run: (db, r) => { const copy = duplicatePage(db, r.id); return { db: copy.db, go: `#/website/pages/${copy.id}` }; } },
        { label: 'SEO Check', run: (db, r) => ({ db: postNote(db, 'website.page', r.id, seoAudit(r).join('\n') || 'No SEO warnings') }) },
      ],
      groups: [['slug', 'sequence', 'parent_id'], ['is_published', 'header_visible', 'footer_visible']],
      tabs: [...page.form.tabs, { label: 'SEO', fields: ['website_meta_title', 'website_meta_description', 'website_meta_keywords', 'og_image', 'indexed'] }, { label: 'Visibility', fields: ['visibility', 'visibility_password', 'date_publish'] }, { label: 'Translations', fields: ['translations'] }],
    },
  },
  'website.menu': {
    label: 'Menus',
    fields: { name: { type: 'char', label: 'Name', required: true }, url: { type: 'char', label: 'URL' }, page_id: relation('website.page', 'Page'), parent_id: relation('website.menu', 'Parent Menu'), sequence: { type: 'integer', label: 'Sequence' }, new_window: { type: 'boolean', label: 'New Window' }, is_mega_menu: { type: 'boolean', label: 'Mega Menu' } },
    defaults: () => ({ sequence: 10, new_window: false, is_mega_menu: false }),
    guard: (db, before, r) => hierarchyGuard(db, 'website.menu', r) || (r.page_id && !read(db, 'website.page', r.page_id) ? 'Page not found' : null),
    list: ['sequence', 'name', 'parent_id', 'page_id', 'url', 'new_window', 'is_mega_menu'],
    form: { title: 'name', groups: [['url', 'page_id', 'parent_id'], ['sequence', 'new_window', 'is_mega_menu']] },
  },
  'website.redirect': {
    label: 'Redirects',
    fields: { url_from: { type: 'char', label: 'From URL', required: true }, url_to: { type: 'char', label: 'To URL', required: true }, type: { type: 'selection', label: 'Type', options: [['301', 'Permanent (301)'], ['302', 'Temporary (302)']] }, active: { type: 'boolean', label: 'Active' } },
    defaults: () => ({ type: '301', active: true }),
    guard: (db, before, r) => !['301', '302'].includes(r.type) ? 'Choose a 301 or 302 redirect' : !r.url_from.startsWith('/') || !/^(\/(?!\/)|https?:\/\/)/i.test(r.url_to) || /[\r\n]/.test(r.url_from + r.url_to) ? 'Use a local source path and a local path or HTTP destination' : null,
    list: ['url_from', 'url_to', 'type', 'active'],
    form: { title: 'url_from', groups: [['url_from', 'url_to'], ['type', 'active']] },
  },
  'website.snippet': {
    label: 'Building Blocks',
    fields: { name: { type: 'char', label: 'Name', required: true }, category: { type: 'selection', label: 'Category', options: [['structure', 'Structure'], ['features', 'Features'], ['dynamic', 'Dynamic'], ['inner', 'Inner Content']] }, html: { type: 'text', label: 'HTML Template' }, thumbnail: { type: 'char', label: 'Thumbnail URL' } },
    defaults: () => ({ category: 'structure' }),
    list: ['name', 'category', 'thumbnail'],
    form: { title: 'name', groups: [['category', 'thumbnail']], tabs: [{ label: 'Template', fields: ['html'] }] },
  },
};
