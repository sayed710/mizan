// Live server: a slow public request captures `db` before `await readJson(req)` and commits a whole stale db afterwards.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { rmSync } from 'node:fs';
const W = process.argv[2];
const ROUTE = process.argv[3] ?? '/api/public/livechat/start';
const BODY = process.argv[4] ?? JSON.stringify({ name: 'Visitor', email: 'visitor@example.test' });
const PORT = 20000 + Math.floor(Math.random() * 20000);
const DBFILE = `${W}/../live-${PORT}.sqlite`;
const env = { ...process.env, PORT: String(PORT), MIZAN_DB: DBFILE, MIZAN_ADMIN_PASSWORD: 'audit-pass-123', MIZAN_SECURE_COOKIE: '0' };
const start = () => new Promise((ok) => { const p = spawn('node', ['server/index.js'], { cwd: W, env }); p.stdout.on('data', (d) => { if (/listening/.test(d)) ok(p); }); p.stderr.on('data', (d) => process.stderr.write('[srv] ' + d)); });
const req = (method, path, body, cookie) => new Promise((ok, fail) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { 'x-requested-with': 'mizan', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: s ? JSON.parse(s) : null }));
  });
  r.on('error', fail); if (data) r.write(data); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv = await start();
const login = await req('POST', '/api/login', { login: 'admin', password: 'audit-pass-123' });
const cookie = login.headers['set-cookie'][0].split(';')[0];
let snap = (await req('GET', '/api/db', undefined, cookie)).body;
console.log('route', ROUTE, '| start: partners', snap.records['res.partner'].length, 'seq', snap.seq['res.partner'], 'crm.lead#1 priority', snap.records['crm.lead'].find((l) => l.id === 1).priority);
// 1) slow public request: headers + half the body
const slow = new Promise((ok) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: ROUTE, headers: { 'x-requested-with': 'mizan', 'content-type': 'application/json', 'content-length': Buffer.byteLength(BODY) } }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => ok({ status: res.statusCode, body: s })); });
  r.write(BODY.slice(0, 5)); globalThis.finishSlow = () => r.end(BODY.slice(5));
});
await sleep(300);
// 2) meanwhile an employee saves a new partner and edits a lead
const id = snap.seq['res.partner'] + 1;
const lead = snap.records['crm.lead'].find((l) => l.id === 1);
const d = await req('POST', '/api/diff', { upserts: { 'res.partner': [{ id, name: 'Concurrent Partner' }], 'crm.lead': [{ ...lead, priority: 3 }] }, deletes: {}, messages: [], removedMessages: [], seq: { 'res.partner': id } }, cookie);
console.log('employee save status', d.status, '| partner', id, 'present:', d.body.records['res.partner'].some((p) => p.id === id), '| lead priority', d.body.records['crm.lead'].find((l) => l.id === 1).priority);
// 3) the slow request completes
finishSlow();
const out = await slow;
console.log('slow public request ->', out.status, out.body.slice(0, 80));
snap = (await req('GET', '/api/db', undefined, cookie)).body;
console.log('after: partner', id, 'present in memory:', snap.records['res.partner'].some((p) => p.id === id), '| seq res.partner', snap.seq['res.partner'], '| lead priority', snap.records['crm.lead'].find((l) => l.id === 1).priority);
srv.kill(); await sleep(300);
srv = await start();
const c2 = (await req('POST', '/api/login', { login: 'admin', password: 'audit-pass-123' })).headers['set-cookie'][0].split(';')[0];
snap = (await req('GET', '/api/db', undefined, c2)).body;
console.log('after restart (SQLite): partner', id, 'present:', snap.records['res.partner'].some((p) => p.id === id), '| lead priority', snap.records['crm.lead'].find((l) => l.id === 1).priority);
srv.kill();
for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) rmSync(f, { force: true });
