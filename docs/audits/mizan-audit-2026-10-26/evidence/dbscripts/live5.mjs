// Two server processes on one SQLite file (e.g. 2 replicas / rolling deploy overlap).
import { spawn } from 'node:child_process';
import http from 'node:http';
import { rmSync } from 'node:fs';
const W = process.argv[2];
const base = 20000 + Math.floor(Math.random() * 20000);
const DBFILE = `${W}/../live5-${base}.sqlite`;
const start = (port) => new Promise((ok) => { const p = spawn('node', ['server/index.js'], { cwd: W, env: { ...process.env, PORT: String(port), MIZAN_DB: DBFILE, MIZAN_ADMIN_PASSWORD: 'audit-pass-123', MIZAN_SECURE_COOKIE: '0' } }); p.stdout.on('data', (d) => { if (/listening/.test(d)) ok(p); }); p.stderr.on('data', (d) => { if (!/Experimental|trace-warn/.test(d)) process.stderr.write('[srv] ' + d); }); });
const req = (port, method, path, body, cookie) => new Promise((ok, fail) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'x-requested-with': 'mizan', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: s ? JSON.parse(s) : null })); });
  r.on('error', fail); if (data) r.write(data); r.end();
});
const login = async (port) => (await req(port, 'POST', '/api/login', { login: 'admin', password: 'audit-pass-123' })).headers['set-cookie'][0].split(';')[0];
const A = await start(base); const ca = await login(base);
const B = await start(base + 1); const cb = await login(base + 1);
const mk = (name, id) => ({ upserts: { 'res.partner': [{ id, name }] }, deletes: {}, messages: [], removedMessages: [], seq: { 'res.partner': id } });
const sa = (await req(base, 'GET', '/api/db', undefined, ca)).body.seq['res.partner'];
const ra = await req(base, 'POST', '/api/diff', mk('Created on replica A', sa + 1), ca);
const sb = (await req(base + 1, 'GET', '/api/db', undefined, cb)).body;
console.log('A saved partner', sa + 1, '->', ra.status, '| replica B sees it?', sb.records['res.partner'].some((p) => p.id === sa + 1), 'B seq', sb.seq['res.partner']);
const rb = await req(base + 1, 'POST', '/api/diff', mk('Created on replica B', sb.seq['res.partner'] + 1), cb);
console.log('B saved partner', sb.seq['res.partner'] + 1, '->', rb.status);
A.kill(); B.kill(); await new Promise((r) => setTimeout(r, 300));
const C = await start(base + 2); const cc = await login(base + 2);
const sc = (await req(base + 2, 'GET', '/api/db', undefined, cc)).body;
console.log('after restart, partners with id', sa + 1, ':', sc.records['res.partner'].filter((p) => p.id === sa + 1).map((p) => p.name));
C.kill();
for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) rmSync(f, { force: true });
