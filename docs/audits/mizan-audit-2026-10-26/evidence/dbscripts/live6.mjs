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
const backup = JSON.parse((await req('GET', '/api/db', undefined, cookie)).body);   // Settings > Download backup = getDb()
console.log(`backup JSON ${(JSON.stringify(backup).length / 1e6).toFixed(1)} MB, ${Object.values(backup.records).reduce((s, r) => s + r.length, 0)} records`);
const reset = await req('POST', '/api/reset', {}, cookie);
const fresh = JSON.parse(reset.body);
const { diffDb } = await import(W + '/src/sync.js');
const diff = diffDb(fresh, backup);                                                // Settings > Restore backup = commit(data)
console.log(`reset -> ${reset.status}; restore diff ${(JSON.stringify(diff).length / 1e6).toFixed(1)} MB`);
const r = await req('POST', '/api/diff', diff, cookie).catch((e) => ({ status: 'socket error', body: e.message }));
console.log(`restore POST /api/diff -> ${r.status} ${String(r.body).slice(0, 80)}`);
const after = JSON.parse((await req('GET', '/api/db', undefined, cookie)).body);
console.log(`records on the server after restore attempt: ${Object.values(after.records).reduce((s, x) => s + x.length, 0)}`);
srv.kill();
for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) rmSync(f, { force: true });
