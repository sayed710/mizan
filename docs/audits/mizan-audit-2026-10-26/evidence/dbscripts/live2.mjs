import { spawn } from 'node:child_process';
import http from 'node:http';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const W = process.argv[2];
const N = Number(process.argv[3] ?? 50000);
const { seed } = await import(W + '/src/seed.js');
const { openStorage } = await import(W + '/server/storage.js');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const DBFILE = `${W}/../live2-${PORT}.sqlite`;
// inflated db written with the app's own storage layer
const db0 = seed();
const inv = db0.records['account.move'].find((m) => m.name === 'INV/2026/00002');
const lead = db0.records['crm.lead'][0];
const moves = [...db0.records['account.move']], leads = [...db0.records['crm.lead']], msgs = [...db0.messages];
let mid = db0.seq['account.move'], lid = db0.seq['crm.lead'];
for (let i = 0; i < N; i++) {
  if (i % 10 < 6) { moves.push({ ...inv, id: ++mid, name: `INV/2025/${mid}`, state: 'draft' }); msgs.push({ id: `m${i}`, model: 'account.move', res_id: mid, body: 'created', kind: 'tracking', author: 'Admin', date: '2025-01-01' }); }
  else { leads.push({ ...lead, id: ++lid, name: `Lead ${lid}` }); msgs.push({ id: `m${i}`, model: 'crm.lead', res_id: lid, body: 'created', kind: 'tracking', author: 'Admin', date: '2025-01-01' }); }
}
const db = { ...db0, records: { ...db0.records, 'account.move': moves, 'crm.lead': leads }, messages: msgs, seq: { ...db0.seq, 'account.move': mid, 'crm.lead': lid } };
{ const sql = new DatabaseSync(DBFILE); sql.exec('PRAGMA journal_mode = WAL'); openStorage(sql).save(null, db); sql.close(); }
const env = { ...process.env, PORT: String(PORT), MIZAN_DB: DBFILE, MIZAN_ADMIN_PASSWORD: 'audit-pass-123', MIZAN_SECURE_COOKIE: '0' };
const t0 = performance.now();
const srv = spawn('node', ['server/index.js'], { cwd: W, env });
let listenAt = null; srv.stdout.on('data', (d) => { if (/listening/.test(d)) listenAt = performance.now(); });
const req = (method, path, body, cookie) => new Promise((ok, fail) => {
  const data = body === undefined ? null : JSON.stringify(body); const a = performance.now();
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { 'x-requested-with': 'mizan', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const s = Buffer.concat(chunks).toString(); ok({ status: res.statusCode, headers: res.headers, bytes: s.length, ms: performance.now() - a, body: s }); });
  });
  r.on('error', fail); if (data) r.write(data); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let first;
for (;;) { try { first = await req('GET', '/api/session'); break; } catch { await sleep(50); } }
console.log(`N=${N}: spawn->'listening' log ${(listenAt - t0).toFixed(0)} ms; spawn->first HTTP answer ${(performance.now() - t0).toFixed(0)} ms`);
const login = await req('POST', '/api/login', { login: 'admin', password: 'audit-pass-123' });
const cookie = login.headers['set-cookie'][0].split(';')[0];
const g = await req('GET', '/api/db', undefined, cookie);
console.log(`GET /api/db: ${g.status} ${(g.bytes / 1e6).toFixed(1)} MB in ${g.ms.toFixed(0)} ms`);
const leadRec = JSON.parse(g.body).records['crm.lead'].at(-1);
const diff = { upserts: { 'crm.lead': [{ ...leadRec, priority: 2 }] }, deletes: {}, messages: [], removedMessages: [], seq: {} };
const p1 = req('POST', '/api/diff', diff, cookie);
await sleep(5);
const p2 = req('GET', '/api/session', undefined, cookie);
const [d1, s1] = await Promise.all([p1, p2]);
console.log(`POST /api/diff (1 field on 1 lead): ${d1.status}, response ${(d1.bytes / 1e6).toFixed(1)} MB, ${d1.ms.toFixed(0)} ms | a GET /api/session sent 5 ms later waited ${s1.ms.toFixed(0)} ms`);
const a = performance.now();
const polls = await Promise.all(Array.from({ length: 5 }, () => req('GET', '/api/db', undefined, cookie)));
console.log(`5 concurrent GET /api/db (5 users' 15 s poll): all done in ${(performance.now() - a).toFixed(0)} ms, ${(polls.reduce((s, p) => s + p.bytes, 0) / 1e6).toFixed(0)} MB sent`);
const rss = Number((await new Promise((ok) => { const p = spawn('ps', ['-o', 'rss=', '-p', String(srv.pid)]); let s = ''; p.stdout.on('data', (d) => (s += d)); p.on('close', () => ok(s)); })).trim());
console.log(`server RSS ${(rss / 1024).toFixed(0)} MB`);
srv.kill();
for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) rmSync(f, { force: true });
