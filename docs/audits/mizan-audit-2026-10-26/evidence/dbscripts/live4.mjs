// "Send by Email" awaits SMTP with a db snapshot, then commits the whole stale record: concurrent edits to it are lost.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { rmSync } from 'node:fs';
const W = process.argv[2];
const DELAY = 1500;
const smtp = net.createServer((s) => {
  s.write('220 fake\r\n'); let buf = '', inData = false;
  s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2);
    if (inData) { if (line === '.') { inData = false; setTimeout(() => s.write('250 queued\r\n'), DELAY); } continue; }
    if (line.startsWith('EHLO')) s.write('250 fake\r\n'); else if (line.startsWith('MAIL') || line.startsWith('RCPT')) s.write('250 ok\r\n');
    else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); } } });
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const DBFILE = `${W}/../live4-${PORT}.sqlite`;
const env = { ...process.env, PORT: String(PORT), MIZAN_DB: DBFILE, MIZAN_ADMIN_PASSWORD: 'audit-pass-123', MIZAN_SECURE_COOKIE: '0', MIZAN_SMTP_HOST: '127.0.0.1', MIZAN_SMTP_PORT: String(smtp.address().port), MIZAN_SMTP_FROM: 'erp@example.test' };
const srv = await new Promise((ok) => { const p = spawn('node', ['server/index.js'], { cwd: W, env }); p.stdout.on('data', (d) => { if (/listening/.test(d)) ok(p); }); });
const req = (method, path, body, cookie) => new Promise((ok, fail) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { 'x-requested-with': 'mizan', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: s ? JSON.parse(s) : null })); });
  r.on('error', fail); if (data) r.write(data); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = (await req('POST', '/api/login', { login: 'admin', password: 'audit-pass-123' })).headers['set-cookie'][0].split(';')[0];
let snap = (await req('GET', '/api/db', undefined, cookie)).body;
const order = snap.records['sale.order'].find((o) => o.id === 1);
console.log('S00001 before: state', order.state, 'note', JSON.stringify(order.note ?? null));
const mail = req('POST', '/api/mail/document', { model: 'sale.order', id: 1 }, cookie);
await sleep(300);
const edit = await req('POST', '/api/diff', { upserts: { 'sale.order': [{ ...order, note: 'Customer asked for delivery on Friday' }] }, deletes: {}, messages: [], removedMessages: [], seq: {} }, cookie);
console.log('colleague edits note while the email is in flight ->', edit.status, 'note now', JSON.stringify(edit.body.records['sale.order'].find((o) => o.id === 1).note));
const m = await mail;
snap = (await req('GET', '/api/db', undefined, cookie)).body;
const after = snap.records['sale.order'].find((o) => o.id === 1);
console.log('send by email ->', m.status, JSON.stringify(m.body), '| S00001 after: state', after.state, 'note', JSON.stringify(after.note ?? null));
srv.kill(); smtp.close();
for (const f of [DBFILE, DBFILE + '-wal', DBFILE + '-shm']) rmSync(f, { force: true });
