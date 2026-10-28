import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { create, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { hashPagePassword, websitePlusModels } from '../src/models/websiteplus.js';
import { openStorage } from './storage.js';

let child, directory, origin;
const get = (path, options = {}) => fetch(`${origin}${path}`, { redirect: 'manual', ...options });
const unlock = (password, headers = {}) => get('/secret', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ password }) });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizan-website-'));
  const sql = new DatabaseSync(join(directory, 'test.sqlite'));
  let db = seed();
  for (const [slug, values] of [
    ['secret', { visibility: 'password', visibility_password: hashPagePassword('correct horse'), content: 'Protected content' }],
    ['members', { visibility: 'connected', content: 'Members content' }],
    ['hidden', { indexed: false }],
  ]) db = create(db, 'website.page', { ...websitePlusModels['website.page'].defaults(), name: slug, slug, is_published: true, ...values }).db;
  db = write(db, 'website.page', 1, { website_meta_title: 'Home SEO', translations: [{ lang: 'ar', name: 'الرئيسية' }] });
  for (const [from, to] of [['/old', '/home'], ['/loop-a', '/loop-b'], ['/loop-b', '/loop-a']]) {
    db = create(db, 'website.redirect', { url_from: from, url_to: to }).db;
  }
  openStorage(sql).save(null, db);
  sql.close();
  // A minimal built client, so these tests never depend on (or test a stale) `vite build` output.
  await mkdir(join(directory, 'dist', 'assets'), { recursive: true });
  await writeFile(join(directory, 'dist', 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>');
  await writeFile(join(directory, 'dist', 'assets', 'app.js'), 'export {};');
  child = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '0', MIZAN_DB: join(directory, 'test.sqlite'), MIZAN_DIST: join(directory, 'dist'), MIZAN_ADMIN_PASSWORD: 'test-admin-password', MIZAN_SECURE_COOKIE: '0', MIZAN_PUBLIC_URL: 'https://website.example', MIZAN_TRUST_PROXY: '1', MIZAN_SMTP_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  origin = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /Mizan listening on (http:\/\/localhost:\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(output)); });
  });
});

after(async () => {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('permanent redirects preserve Location and redirect loops return the 404 SPA', async () => {
  const redirect = await get('/old');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/home');
  const loop = await get('/loop-a');
  assert.equal(loop.status, 404);
  assert.match(await loop.text(), /id="root"/);
});

test('password form refuses a wrong password, grants an HttpOnly page cookie and protects API content', async () => {
  const form = await get('/secret');
  assert.equal(form.status, 200);
  assert.match(await form.text(), /method="post"[^>]*action="\/secret"/);
  assert.equal((await unlock('wrong')).status, 403);
  const ok = await unlock('correct horse');
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/secret');
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Lax; Path=\/secret;/);
  assert.ok(!cookie.includes('correct') && !cookie.includes(hashPagePassword('correct horse')));
  const granted = await get('/secret', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(granted.status, 200);
  assert.match(await granted.text(), /id="root"/);
  const anonymous = await (await get('/api/public/site')).json();
  assert.ok(!JSON.stringify(anonymous).includes('Protected content'));
  const denied = await get('/api/public/site?page=secret');
  assert.ok(!JSON.stringify(await denied.json()).includes('Protected content'));
  const page = await (await get('/api/public/site?page=secret', { headers: { Cookie: cookie.split(';')[0] } })).json();
  assert.equal(page.pages.find((p) => p.slug === 'secret').content, 'Protected content');
  assert.ok(!JSON.stringify(page).includes('visibility_password'));
  const forged = await get('/secret', { headers: { Cookie: `${cookie.split('=')[0]}=forged` } });
  assert.match(await forged.text(), /name="password"/);
  const scoped = await (await get('/secret?website_data=1', { headers: { Cookie: cookie.split(';')[0] } })).json();
  assert.equal(scoped.pages.find((p) => p.slug === 'secret').content, 'Protected content');
  assert.match(await (await get('/secret//')).text(), /name="password"/);
});

test('signed-in pages redirect to the existing login with a local return path', async () => {
  const response = await get('/members');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?return=%2Fmembers#/');
  const login = await get('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify({ login: 'admin', password: 'test-admin-password' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal((await get('/?return=%2Fmembers', { headers })).headers.get('location'), '/members');
  assert.equal((await get('/members', { headers })).status, 200);
  for (const back of ['//attacker.example', '/\t/attacker.example', '/\\attacker.example']) {
    assert.equal((await get(`/?return=${encodeURIComponent(back)}`, { headers })).status, 200);
  }
});

test('crawler endpoints use configured origin, content types, exclusions and five-minute caching', async () => {
  const xml = await get('/sitemap.xml', { headers: { Host: 'attacker.example' } });
  assert.match(xml.headers.get('content-type'), /^application\/xml/);
  assert.equal(xml.headers.get('cache-control'), 'public, max-age=300');
  const body = await xml.text();
  assert.match(body, /https:\/\/website.example\/home/);
  assert.ok(!body.includes('/secret</loc>') && !body.includes('attacker.example'));
  const robots = await get('/robots.txt');
  assert.match(robots.headers.get('content-type'), /^text\/plain/);
  assert.equal(robots.headers.get('cache-control'), 'public, max-age=300');
  assert.match(await robots.text(), /Disallow: \/hidden\nSitemap: https:\/\/website.example\/sitemap.xml/);
});

test('unknown slugs return the actual SPA body with HTTP 404; known pages and assets stay available', async () => {
  const html = await readFile(join(directory, 'dist', 'index.html'), 'utf8');
  const missing = await get('/not-a-page');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /id="root"/);
  assert.equal((await get('/home')).status, 200);
  const asset = /src="([^"]+\.js)"/.exec(html)[1];
  assert.equal((await get(asset)).status, 200);
  const site = await (await get('/api/public/site')).json();
  assert.equal(site.pages.find((p) => p.slug === 'home').website_meta_title, 'Home SEO');
  assert.equal(site.pages.find((p) => p.slug === 'home').translations[0].name, 'الرئيسية');
});

test('password posts share the public POST limiter, counting every attempt', async () => {
  const headers = { 'X-Forwarded-For': '192.0.2.10' };
  for (let n = 0; n < 10; n++) assert.equal((await unlock('wrong', headers)).status, 403);
  assert.equal((await unlock('correct horse', headers)).status, 429);
});
