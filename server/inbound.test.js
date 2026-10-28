import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { create, read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { createShare } from '../src/models/signplus.js';
import { referralLink, points, syncFromApplicant } from '../src/models/skillsplus.js';
import { DatabaseSync } from 'node:sqlite';
import { openBlobs } from './blobs.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffDb } from '../src/sync.js';
import { publicApply } from './api.js';
import { sharePage, smsInbound, SMS_PATH, twilioSignature } from './inbound.js';

const ENV = { MIZAN_TWILIO_TOKEN: 'secret-token', MIZAN_PUBLIC_URL: 'https://erp.example.com/' };
const form = (o) => Buffer.from(new URLSearchParams(o).toString());
const signed = (o) => twilioSignature(ENV.MIZAN_TWILIO_TOKEN, `https://erp.example.com${SMS_PATH}`, new URLSearchParams(o));

test('Twilio signatures sign the URL followed by the POST pairs sorted by name', () => {
  const params = new URLSearchParams({ To: '+18005551212', CallSid: 'CA1234567890ABCDE', Digits: '1234', From: '+12349013030' });
  const expected = createHmac('sha1', '12345').update('https://mycompany.com/myapp.php?foo=1&bar=2CallSidCA1234567890ABCDEDigits1234From+12349013030To+18005551212').digest('base64');
  assert.equal(twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', params), expected);
});

test('a signed STOP reply blacklists the sender once; bad signatures and missing setup are refused', () => {
  const db = seed();
  const msg = { From: '+201001234567', Body: 'Stop please' };
  const out = smsInbound(ENV, db, form(msg), signed(msg));
  assert.equal(out.status, 200);
  assert.match(out.body, /<Response><\/Response>/);
  const before = search(db, 'phone.blacklist').length;
  assert.equal(search(out.db, 'phone.blacklist').length, before + 1);
  assert.equal(smsInbound(ENV, out.db, form(msg), signed(msg)).db, out.db);
  assert.equal(smsInbound(ENV, db, form(msg), 'forged').status, 403);
  assert.equal(smsInbound(ENV, db, form(msg), undefined).status, 403);
  assert.equal(smsInbound({ MIZAN_TWILIO_TOKEN: 'x' }, db, form(msg), signed(msg)).status, 503);
  const hello = { From: '+201001234567', Body: 'hello' };
  assert.equal(smsInbound(ENV, db, form(hello), signed(hello)).db, db);
});

test('share links list documents, download only shared files as attachments, and expire', () => {
  let db = seed();
  const file = { name: 'report.html', type: 'text/html', size: 5, data: `data:text/html;base64,${Buffer.from('<b>x</b>').toString('base64')}` };
  const shared = create(db, 'documents.document', { name: 'Report', file });
  const other = create(shared.db, 'documents.document', { name: 'Private', file });
  const share = createShare(other.db, { documentIds: [shared.id], expiration: '2030-12-31' });
  db = share.db;
  const list = sharePage(db, `/share/${share.token}`, '2030-01-01');
  assert.equal(list.status, 200);
  assert.match(list.body, new RegExp(`/share/${share.token}/${shared.id}`));
  assert.doesNotMatch(list.body, /Private/);
  const download = sharePage(db, `/share/${share.token}/${shared.id}`, '2030-01-01');
  assert.equal(download.headers['Content-Type'], 'application/octet-stream');
  assert.match(download.headers['Content-Disposition'], /^attachment; filename="report.html"$/);
  assert.equal(download.body.toString(), '<b>x</b>');
  assert.equal(sharePage(db, `/share/${share.token}/${other.id}`, '2030-01-01').status, 404);
  assert.equal(sharePage(db, `/share/${share.token}`, '2031-01-01').status, 404);
  assert.equal(sharePage(db, '/share/unknown-token-1', '2030-01-01').status, 404);
  assert.equal(sharePage(db, '/shop', '2030-01-01'), null);
});

test('public applications with a referral token are attributed to the employee', () => {
  let db = seed();
  if (!search(db, 'hr.job').some((j) => j.is_published)) db = create(db, 'hr.job', { name: 'Driver', is_published: true }).db;
  const open = search(db, 'hr.job').find((j) => j.is_published);
  const employee = search(db, 'hr.employee')[0];
  const ref = new URLSearchParams(referralLink(db, employee.id, open.id).split('?')[1]).get('ref');
  const out = publicApply(db, { job_id: open.id, name: 'Nour', email: 'nour@example.com', phone: '0100', ref });
  assert.equal(out.status, 201);
  const referral = search(out.db, 'hr.referral').find((r) => r.email === 'nour@example.com');
  assert.equal(referral.referrer_id, employee.id);
  assert.equal(referral.points, 0, 'anonymous submissions cannot mint reward points');
  assert.deepEqual(points(out.db, employee.id), points(db, employee.id));
  const reviewed = syncFromApplicant(write(out.db, 'hr.applicant', referral.applicant_id, { stage_id: 'interview' }), referral.applicant_id);
  assert.equal(read(reviewed, 'hr.referral', referral.id).points, 30, 'recruitment progression earns points');
  assert.equal(search(out.db, 'hr.applicant').find((a) => a.id === referral.applicant_id).phone, '0100');
  assert.equal(publicApply(db, { job_id: open.id, name: 'Nour', email: 'nour@example.com', ref: 'bad-token' }).status, 400);
});

test('share downloads resolve stored blobs only after token, expiry and document access checks', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    const blobs = openBlobs(sql);
    const doc = create(seed(), 'documents.document', { name: 'Stored report', file: { name: 'report.txt', type: 'text/plain', data: 'data:text/plain;base64,aGVsbG8=' } });
    const privateDoc = create(doc.db, 'documents.document', { name: 'Private report', file: { name: 'private.txt', data: 'data:text/plain;base64,cHJpdmF0ZQ==' } });
    const shared = createShare(privateDoc.db, { documentIds: [doc.id], expiration: '2030-12-31' });
    const db = blobs.externalize(shared.db);
    const path = `/share/${shared.token}`;
    assert.match(sharePage(db, path, '2030-01-01', blobs.get).body, new RegExp(`${path}/${doc.id}`));
    const out = sharePage(db, `${path}/${doc.id}`, '2030-01-01', blobs.get);
    assert.equal(out.status, 200);
    assert.equal(out.body.toString(), 'hello');
    assert.equal(out.headers['Content-Type'], 'application/octet-stream');
    const noRead = () => assert.fail('must not read a blob without share access');
    assert.equal(sharePage(db, `${path}/${privateDoc.id}`, '2030-01-01', noRead).status, 404);
    assert.equal(sharePage(db, `${path}/${doc.id}`, '2031-01-01', noRead).status, 404);
    assert.equal(sharePage(db, `/share/unknown-token/${doc.id}`, '2030-01-01', noRead).status, 404);
    assert.equal(sharePage(db, `${path}/${doc.id}`, '2030-01-01').status, 404, 'missing blobs are refused');
  } finally {
    sql.close();
  }
});

test('HTTP public routes serve stored share files and persist only signed SMS opt-outs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mizan-inbound-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...ENV, PORT: '0', MIZAN_DB: join(dir, 'db.sqlite'), MIZAN_ADMIN_PASSWORD: 'inbound-admin-password', MIZAN_SECURE_COOKIE: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (b) => { output += b; const m = /Mizan listening on (http:\/\/localhost:\d+)/.exec(output); if (m) resolve(m[1]); });
      child.stderr.on('data', (b) => { output += b; });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
    });
    const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'mizan' }, body: JSON.stringify({ login: 'admin', password: 'inbound-admin-password' }) });
    assert.equal(login.status, 200);
    const headers = { 'content-type': 'application/json', 'x-requested-with': 'mizan', cookie: login.headers.get('set-cookie').split(';')[0] };
    const db = await (await fetch(url + '/api/db', { headers })).json();
    const doc = create(db, 'documents.document', { name: 'HTTP shared report', file: { name: 'report.txt', type: 'text/plain', data: 'data:text/plain;base64,aGVsbG8=' } });
    const share = createShare(doc.db, { documentIds: [doc.id] });
    const saved = await fetch(url + '/api/diff', { method: 'POST', headers, body: JSON.stringify(diffDb(db, share.db)) });
    assert.equal(saved.status, 200);
    const stored = await saved.json();
    const storedDoc = search(stored, 'documents.document').find((d) => d.name === 'HTTP shared report');
    assert.ok(storedDoc.file.blob, 'files are externalized before public downloads');
    const path = `/share/${share.token}`;
    const list = await fetch(url + path);
    assert.equal(list.status, 200);
    assert.match(await list.text(), new RegExp(`${path}/${storedDoc.id}`));
    const download = await fetch(`${url}${path}/${storedDoc.id}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'hello');
    assert.equal((await fetch(`${url}/share/unknown-token/${storedDoc.id}`)).status, 404);
    const msg = { From: '+201009876543', Body: 'STOP' };
    const post = (signature) => fetch(url + SMS_PATH, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: form(msg) });
    assert.equal((await post('forged')).status, 403);
    assert.equal((await post(signed(msg))).status, 200);
    assert.equal((await post(signed(msg))).status, 200);
    const after = await (await fetch(url + '/api/db', { headers })).json();
    assert.equal(search(after, 'phone.blacklist').filter((r) => r.number === msg.From).length, 1);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.send('shutdown'); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
