import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { create, read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { postEntry } from '../src/models/ledger.js';
import { readRaw } from './whatsapp.js';
import { createPortal, portalUrl } from './portal.js';

async function fixture(t, env = {}, access = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const order = create(seed(), 'sale.order', { partner_id: 1, require_signature: true, option_ids: [{ product_id: 2, qty: 1, price_unit: 10, tax: 0 }], order_line: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  let db = order.db;
  const attempts = new Map();
  const services = { sql, getDb: () => db, commitDb: (next) => { db = next; },
    sessionUser: (req) => req.headers.cookie === 'staff=1' ? { name: 'Staff', apps: null } : null,
    allowedFor: () => null, clientIp: () => 'test', tooMany: (key) => (attempts.get(key) ?? 0) >= 10,
    recordFailure: (key) => attempts.set(key, (attempts.get(key) ?? 0) + 1), readRaw, env,
    securityHeaders: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" }, ...access,
  };
  const portal = createPortal(services);
  const server = createServer(async (req, res) => {
    try { if (!await portal.handle(req, res)) { res.writeHead(404); res.end(); } }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); sql.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = portal.portalUrl('sale.order', read(db, 'sale.order', order.id));
  // Windows can assign a browser-blocked ephemeral port (e.g. 6000); Node HTTP has no browser port blacklist.
  const get = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const text = body?.toString();
    const req = request(base + path, { method, headers: { ...headers, ...(text == null ? {} : { 'Content-Length': Buffer.byteLength(text) }) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(text);
  });
  const post = (action, vals = {}, headers = {}) => get(`/my/orders/${order.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ access_token: new URL(url, base).searchParams.get('access_token'), ...vals }) });
  return { sql, services, portal, id: order.id, url, get, post, db: () => db, set: (next) => { db = next; } };
}

test('HMAC links persist across handler creation and reject missing, tampered and other-record tokens', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get(f.url)).status, 200);
  assert.equal((await f.get(`/my/orders/${f.id}`)).status, 404);
  assert.equal((await f.get(f.url + '0')).status, 404);
  const other = create(f.db(), 'sale.order', { partner_id: 1 });
  f.set(other.db);
  assert.equal((await f.get(f.url.replace(`/orders/${f.id}?`, `/orders/${other.id}?`))).status, 404);
  const secret = f.sql.prepare("SELECT value FROM kv WHERE key = 'portal_secret'").get().value;
  assert.equal(portalUrl(secret, 'sale.order', read(f.db(), 'sale.order', f.id)), f.url);
  assert.equal(createPortal(f.services).portalUrl('sale.order', read(f.db(), 'sale.order', f.id)), f.url);
  assert.ok(!JSON.stringify(f.db()).includes(secret));
  f.set(write(f.db(), 'sale.order', f.id, { partner_id: 2 }));
  assert.equal((await f.get(f.url)).status, 404, 'changing the customer revokes the previous link');
});

test('signing confirms a quote without altering the original db and repeat signing is refused', async (t) => {
  const f = await fixture(t);
  const before = f.db();
  assert.equal((await f.post('sign', { name: 'Sara', signature: 'Sara' })).status, 303);
  assert.equal(read(before, 'sale.order', f.id).state, 'draft');
  assert.equal(read(f.db(), 'sale.order', f.id).state, 'sale');
  assert.equal(read(f.db(), 'sale.order', f.id).signed_by, 'Sara');
  assert.equal((await f.post('sign', { name: 'Other', signature: 'Other' })).status, 303);
  assert.equal(read(f.db(), 'sale.order', f.id).signed_by, 'Sara');
});

test('options use only server-stored products and prices, and cannot be added twice', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('option', { option: '0', price_unit: '0' })).status, 303);
  assert.equal(read(f.db(), 'sale.order', f.id).order_line.at(-1).price_unit, 10);
  assert.equal(read(f.db(), 'sale.order', f.id).amount_total, 110);
  await f.post('option', { option: '0' });
  assert.equal(read(f.db(), 'sale.order', f.id).order_line.length, 2);
});

test('demo payment requires the environment gate, payment requirement and prior signature', async (t) => {
  for (const env of [{}, { MIZAN_DEMO_PAYMENTS: '1', NODE_ENV: 'production' }, { MIZAN_DEMO_PAYMENTS: '1', NODE_ENV: 'test' }]) {
    const f = await fixture(t, env);
    f.set(write(f.db(), 'sale.order', f.id, { require_payment: true, prepayment_percent: 50 }));
    await f.post('pay');
    assert.notEqual(read(f.db(), 'sale.order', f.id).payment_state, 'paid');
    await f.post('sign', { name: 'Sara', signature: 'Sara' });
    assert.equal(read(f.db(), 'sale.order', f.id).state, 'draft');
    const page = await (await f.get(f.url)).text();
    const allowed = env.MIZAN_DEMO_PAYMENTS === '1' && env.NODE_ENV !== 'production';
    assert.equal(page.includes('Pay with demo provider'), allowed);
    if (!allowed) assert.ok(page.includes(search(f.db(), 'payment.provider').find((p) => p.code === 'wire').pending_msg));
    await f.post('pay', { amount: '0', provider: 'other' });
    assert.equal(read(f.db(), 'sale.order', f.id).payment_state === 'paid', allowed);
    assert.equal(read(f.db(), 'sale.order', f.id).state, allowed ? 'sale' : 'draft');
    if (allowed) {
      assert.equal(read(f.db(), 'sale.order', f.id).amount_paid, 50);
      const payments = search(f.db(), 'account.payment').filter((p) => p.sale_id === f.id);
      assert.equal(payments.length, 1);
      assert.equal(payments[0].amount, 50);
      assert.equal(read(f.db(), 'account.move', payments[0].move_id).state, 'posted');
      const next = f.db();
      await f.post('pay');
      assert.equal(f.db(), next, 'replayed payment is not booked twice');
    }
  }
});

test('staff link endpoint refuses anonymous users and respects model access', async (t) => {
  const f = await fixture(t);
  const path = `/api/portal-link/sale.order/${f.id}`;
  assert.equal((await f.get(path)).status, 401);
  const response = await f.get(path, { headers: { Cookie: 'staff=1' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: f.url });
  for (const model of ['res.partner', 'constructor', '__proto__']) assert.equal((await f.get(`/api/portal-link/${model}/1`, { headers: { Cookie: 'staff=1' } })).status, 404);
  const restricted = await fixture(t, {}, { allowedFor: () => new Set(['res.partner']) });
  assert.equal((await restricted.get(`/api/portal-link/sale.order/${restricted.id}`, { headers: { Cookie: 'staff=1' } })).status, 403);
});

test('portal HTML escapes partner names, offers token-protected print/download and hides invoice internals', async (t) => {
  const f = await fixture(t);
  f.set(write(f.db(), 'res.partner', 1, { name: '<script>alert(1)</script>' }));
  const response = await f.get(f.url);
  const html = await response.text();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert'));
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const settled = postEntry(f.db(), { journal: 'BNK1', ref: 'pay', lines: [{ account: '101401', debit: 20 }, { account: '121000', credit: 20 }] });
  const invoice = create(settled.db, 'account.move', { partner_id: 1, move_type: 'out_invoice', state: 'posted', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }], amount_paid: 20, payments: [{ date: '2026-01-01', amount: 20, move_id: settled.id }] });
  f.set(invoice.db);
  const url = f.portal.portalUrl('account.move', read(f.db(), 'account.move', invoice.id));
  assert.match(await (await f.get(url)).text(), /Amount due[\s\S]*80\.00/);
  assert.equal((await f.get(url + '&print=1')).status, 200);
  const download = await f.get(url + '&download=1');
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.equal((await f.get(`/my/invoices/${invoice.id}?print=1`)).status, 404);
  f.set(write(f.db(), 'account.move', invoice.id, { move_type: 'in_invoice' }));
  assert.equal((await f.get(url)).status, 404);
});

test('cross-site posts, wrong origins, missing form tokens and oversized bodies cannot change records', async (t) => {
  const f = await fixture(t);
  const before = f.db();
  assert.equal((await f.post('sign', { name: 'Sara', signature: 'Sara' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.post('sign', { name: 'Sara', signature: 'Sara' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.post('sign', { access_token: '', name: 'Sara', signature: 'Sara' })).status, 404);
  assert.equal((await f.post('sign', {}, { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await f.post('sign', { signature: 's'.repeat(9000) })).status, 413);
  assert.equal(f.db(), before);
});

test('all portal POST attempts count toward the per-client rate limit', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.post('sign', { access_token: 'wrong' })).status, 404);
  assert.equal((await f.post('sign', { name: 'Sara', signature: 'Sara' })).status, 429);
  assert.equal(read(f.db(), 'sale.order', f.id).state, 'draft');
});

test('home exposes no customer lists without an explicitly linked portal identity', async (t) => {
  const f = await fixture(t);
  const anonymous = await (await f.get('/my')).text();
  const staff = await (await f.get('/my', { headers: { Cookie: 'staff=1' } })).text();
  assert.match(anonymous, /secure link/);
  assert.ok(!staff.includes(read(f.db(), 'sale.order', f.id).name));
});

test('linked portal identities list only their customer documents and cannot mint staff links', async (t) => {
  const f = await fixture(t, {}, { sessionUser: () => ({ isPortal: true, partnerId: 1 }) });
  const other = create(f.db(), 'sale.order', { partner_id: 2, name: 'OTHER-CUSTOMER-SECRET' });
  f.set(other.db);
  const html = await (await f.get('/my')).text();
  assert.ok(html.includes(read(f.db(), 'sale.order', f.id).name));
  assert.ok(!html.includes('OTHER-CUSTOMER-SECRET'));
  assert.equal((await f.get(`/api/portal-link/sale.order/${f.id}`)).status, 403);
});

test('expired quotes and malformed signatures redirect without any mutation', async (t) => {
  const f = await fixture(t);
  for (const vals of [{ name: '', signature: 'Sara' }, { name: 'Sara', signature: '' }, { name: 'x'.repeat(121), signature: 'Sara' }]) {
    const before = f.db();
    const response = await f.post('sign', vals);
    assert.equal(response.status, 303);
    assert.match(response.headers.get('location'), /message=/);
    assert.equal(f.db(), before);
  }
  f.set(write(f.db(), 'sale.order', f.id, { validity_date: '2000-01-01' }));
  const before = f.db();
  await f.post('sign', { name: 'Sara', signature: 'Sara' });
  await f.post('option', { option: '0' });
  assert.equal(f.db(), before);
  assert.ok(!(await (await f.get(f.url)).text()).includes('Sign and accept'));
});
