import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { create, search } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { createShare } from '../src/models/signplus.js';
import { referralLink } from '../src/models/skillsplus.js';
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
  assert.equal(search(out.db, 'hr.applicant').find((a) => a.id === referral.applicant_id).phone, '0100');
  assert.equal(publicApply(db, { job_id: open.id, name: 'Nour', email: 'nour@example.com', ref: 'bad-token' }).status, 400);
});
